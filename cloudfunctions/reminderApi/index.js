'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')
const {
  canArmReminder,
  canCancelReminder,
  isTerminalReminderStatus,
} = require('./rules')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ITEMS = 'inventory_items'
const REMINDERS = 'reminder_jobs'
const DEFAULT_REMINDER_TEMPLATE_ID = 'jXD8Fb4_ZudDL8FWO3dP4VXcYMWTXjqOaSaM1XBLwh8'
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

function todayKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

async function findOwned(collectionName, ownerId, id) {
  const result = await db
    .collection(collectionName)
    .where({ _id: id, ownerId })
    .limit(1)
    .get()
  return result.data[0] || null
}

async function arm(ownerId, event) {
  const itemId = validateItemId(event.itemId)
  const templateId = process.env.REMINDER_TEMPLATE_ID || DEFAULT_REMINDER_TEMPLATE_ID
  assert(templateId, 'REMINDER_NOT_CONFIGURED', '提醒功能尚未完成配置')

  const item = await findOwned(ITEMS, ownerId, itemId)
  assert(item, 'NOT_FOUND', '物品不存在或已被删除')
  assert(item.inventoryStatus === 'active', 'INVALID_STATE', '已处理物品不能开启提醒')
  assert(toOrdinal(item.expiryDate) >= toOrdinal(todayKey()), 'EXPIRED_ITEM', '已过期物品不能开启提醒')

  const remindDate = addDays(item.expiryDate, -item.reminderLeadDays)
  const current = await findOwned(REMINDERS, ownerId, itemId)
  if (current?.status === 'scheduled') {
    return { status: current.status, remindDate: current.remindDate }
  }
  if (isTerminalReminderStatus(current?.status)) {
    throw new AppError('REMINDER_TERMINAL', '本次提醒已经处理，不能重复开启')
  }
  assert(canArmReminder(current?.status), 'INVALID_STATE', '当前提醒状态不能重新开启')

  const data = {
    itemId,
    ownerId,
    templateId,
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

async function cancel(ownerId, event) {
  const itemId = validateItemId(event.itemId)
  const current = await findOwned(REMINDERS, ownerId, itemId)
  if (!current) return { status: 'cancelled' }
  if (!canCancelReminder(current.status)) return { status: current.status }
  await db.collection(REMINDERS).where({ _id: itemId, ownerId }).update({
    data: {
      status: 'cancelled',
      updatedAt: db.serverDate(),
    },
  })
  return { status: 'cancelled' }
}

const handlers = { arm, cancel }

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
