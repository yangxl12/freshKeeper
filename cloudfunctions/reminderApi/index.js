'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')
const { isTerminalReminderStatus } = require('./rules')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ITEMS = 'inventory_items'
const REMINDERS = 'reminder_jobs'

/**
 * 订阅消息模板 ID。刻意写在代码里而不是读环境变量：
 * 云函数的 envVariables 只在**首次创建**时写入云端，之后改 config.json 或重新部署都不会更新，
 * 留着旧环境变量反而会把代码里的新配置盖掉。模板建好后只改这一行 + 重新部署。
 */
const REMINDER_TEMPLATE_ID = 'TODO_REPLACE_WITH_REAL_TEMPLATE_ID'

/** 提醒统一在提前 N 天的 09:30（Asia/Shanghai）推送，与 dispatchReminders 的定时触发器一致。 */
const REMIND_HOUR = 9
const REMIND_MINUTE = 30

const MILLIS_PER_DAY = 86_400_000

class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function assert(condition, code, message) {
  if (!condition) throw new AppError(code, message)
}

function assertSafeEvent(event) {
  const containers = [event, event.data].filter(Boolean)
  for (const container of containers) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue
    for (const key of Object.keys(container)) {
      if (['ownerId', 'openid', 'openId', '_openid', 'templateId'].includes(key)) {
        throw new AppError('FORBIDDEN_FIELD', '请求包含不允许提交的字段')
      }
    }
  }
}

function validateItemId(value) {
  assert(typeof value === 'string' && value.length >= 1 && value.length <= 128, 'INVALID_ARGUMENT', '物品编号不正确')
  return value
}

function parseDateKey(value) {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > maxDay) {
    return null
  }
  return { year, month, day }
}

function toOrdinal(value) {
  const parts = parseDateKey(value)
  assert(parts, 'INVALID_STATE', '物品到期日期无效')
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MILLIS_PER_DAY)
}

function fromOrdinal(ordinal) {
  const date = new Date(ordinal * MILLIS_PER_DAY)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(
    date.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function addDays(value, amount) {
  return fromOrdinal(toOrdinal(value) + amount)
}

function shanghaiParts(options) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    ...options,
  }).formatToParts(new Date())
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function todayKey() {
  const values = shanghaiParts({ year: 'numeric', month: '2-digit', day: '2-digit' })
  return `${values.year}-${values.month}-${values.day}`
}

function shanghaiHourMinute() {
  const values = shanghaiParts({ hour: '2-digit', minute: '2-digit', hour12: false })
  return { hour: Number(values.hour), minute: Number(values.minute) }
}

/** 提前天数缺失或非法时回落到 1 天，与录入表单的产品默认值一致。 */
function normalizedLeadDays(value) {
  return Number.isInteger(value) && value >= 0 && value <= 30 ? value : 1
}

function reminderDateOf(item) {
  return addDays(item.expiryDate, -normalizedLeadDays(item.reminderLeadDays))
}

/**
 * 提醒时刻（提醒日 09:30）是否已经过去。
 * 派发侧只认当天，所以错过的提醒不会补发，这里也就没必要落任何任务。
 */
function isReminderMissed(remindDate) {
  const today = todayKey()
  if (remindDate < today) return true
  if (remindDate > today) return false
  const { hour, minute } = shanghaiHourMinute()
  return hour > REMIND_HOUR || (hour === REMIND_HOUR && minute >= REMIND_MINUTE)
}

async function findOwned(collectionName, ownerId, id) {
  const result = await db
    .collection(collectionName)
    .where({ _id: id, ownerId })
    .limit(1)
    .get()
  return result.data[0] || null
}

/**
 * 预约这件物品的到期提醒。
 *
 * 幂等：已预约 → 原样返回；已发送/发送中/结果未确定 → 原样返回（终态不重开，避免重复推送）；
 * 其余情况（无任务、失败、已取消）→ 重新写入 scheduled。
 * 提醒时刻已过 → 返回 `missed` 且不落任何任务。
 */
async function arm(ownerId, event) {
  const itemId = validateItemId(event.itemId)
  assert(
    REMINDER_TEMPLATE_ID && !REMINDER_TEMPLATE_ID.startsWith('TODO_'),
    'REMINDER_NOT_CONFIGURED',
    '提醒模板尚未配置，请先填写订阅消息模板 ID',
  )

  const item = await findOwned(ITEMS, ownerId, itemId)
  assert(item, 'NOT_FOUND', '物品不存在或已被删除')
  assert(item.inventoryStatus === 'active', 'INVALID_STATE', '已处理物品不能开启提醒')

  const remindDate = reminderDateOf(item)
  if (isReminderMissed(remindDate)) return { status: 'missed', remindDate }

  const current = await findOwned(REMINDERS, ownerId, itemId)
  if (current?.status === 'scheduled' || isTerminalReminderStatus(current?.status)) {
    return { status: current.status, remindDate: current.remindDate || remindDate }
  }

  const data = {
    itemId,
    ownerId,
    templateId: REMINDER_TEMPLATE_ID,
    remindDate,
    status: 'scheduled',
    acceptedAt: db.serverDate(),
    sendAttemptedAt: null,
    sentAt: null,
    failureCode: null,
    failureReason: null,
    updatedAt: db.serverDate(),
  }
  if (current) {
    await db.collection(REMINDERS).where({ _id: itemId, ownerId }).update({ data })
  } else {
    await db.collection(REMINDERS).doc(itemId).set({ data })
  }
  return { status: 'scheduled', remindDate }
}

const handlers = { arm }

exports.main = async (event = {}) => {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  const action = event && typeof event.action === 'string' ? event.action : ''
  try {
    assertSafeEvent(event)
    const ownerId = cloud.getWXContext().OPENID
    assert(ownerId, 'UNAUTHENTICATED', '请在微信中重新打开小程序')
    const handler = handlers[action]
    assert(handler, 'INVALID_ACTION', '不支持的提醒操作')
    const data = await handler(ownerId, event)
    console.info(JSON.stringify({ requestId, action, resultCode: 'OK', durationMs: Date.now() - startedAt }))
    return { ok: true, data, requestId }
  } catch (error) {
    const safeError =
      error instanceof AppError
        ? error
        : new AppError('INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
    console.warn(JSON.stringify({ requestId, action, resultCode: safeError.code, durationMs: Date.now() - startedAt }))
    return {
      ok: false,
      error: { code: safeError.code, message: safeError.message },
      requestId,
    }
  }
}
