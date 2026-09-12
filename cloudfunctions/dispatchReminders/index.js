'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')
const { buildReminderTemplateData, truncate } = require('./template')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const command = db.command
const ITEMS = 'inventory_items'
const REMINDERS = 'reminder_jobs'
const BATCH_SIZE = 50
const MAX_BATCHES = 20
// 单条 processJob ≈ 6-8 次数据库操作 + 1 次开放接口调用，串行时 50 条/批要 12.5s、
// 20 批 ≈ 250s，必然撞 60s 云函数超时，后半批用户的提醒会静默丢失。
// 受控 8 路并发后约 1.6s/批、20 批 ≈ 32s。
//
// 并发安全性：processJob 的 claim 用的是条件更新
// （where status='scheduled'，updatedCount 必须为 1），重复/并发处理只会返回 skipped，
// 不会有两条路径同时给同一 job 发消息。
const JOB_CONCURRENCY = 8
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
  if (!parts) return null
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MILLIS_PER_DAY)
}

function fromOrdinal(ordinal) {
  const date = new Date(ordinal * MILLIS_PER_DAY)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(
    date.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function addDays(value, amount) {
  const ordinal = toOrdinal(value)
  return ordinal === null ? null : fromOrdinal(ordinal + amount)
}

/** 提前天数缺失或非法时回落到 1 天，与录入表单、reminderApi 保持同一归一化口径。 */
function normalizedLeadDays(value) {
  return Number.isInteger(value) && value >= 0 && value <= 30 ? value : 1
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

function loadConfig() {
  const config = {
    miniprogramState: process.env.MINIPROGRAM_STATE || 'developer',
  }
  assert(
    ['developer', 'trial', 'formal'].includes(config.miniprogramState),
    'CONFIG_INVALID',
    '小程序发布状态配置不正确',
  )
  return config
}

function updatedCount(result) {
  return result?.stats?.updated ?? result?.updated ?? 0
}

async function findOwnedItem(ownerId, itemId) {
  const result = await db
    .collection(ITEMS)
    .where({ _id: itemId, ownerId })
    .limit(1)
    .get()
  return result.data[0] || null
}

async function updateJob(job, status, data = {}) {
  await db
    .collection(REMINDERS)
    .where({ _id: job._id, ownerId: job.ownerId, status: 'sending' })
    .update({
      data: {
        status,
        ...data,
        updatedAt: db.serverDate(),
      },
    })
}

async function cancelJob(job, code, reason) {
  await db
    .collection(REMINDERS)
    .where({ _id: job._id, ownerId: job.ownerId, status: 'scheduled' })
    .update({
      data: {
        status: 'cancelled',
        failureCode: code,
        failureReason: reason,
        updatedAt: db.serverDate(),
      },
    })
}

function isUncertainError(error) {
  const text = `${error?.errMsg || ''} ${error?.message || ''}`.toLowerCase()
  return /timeout|timed out|network|econnreset|socket hang up/.test(text)
}

async function processJob(job, today, config) {
  // 提醒只认当天 09:30 那一刻：过了就是「已错过」，不补发，否则用户会在几天后
  // 突然收到一串「还有 -3 天到期」的骚扰消息。
  if (job.remindDate !== today) {
    await cancelJob(job, 'REMINDER_MISSED', '提醒时间已过，不再补发')
    return 'cancelled'
  }

  const item = await findOwnedItem(job.ownerId, job.itemId)
  const expectedRemindDate = item
    ? addDays(item.expiryDate, -normalizedLeadDays(item.reminderLeadDays))
    : null
  const expiryOrdinal = item ? toOrdinal(item.expiryDate) : null
  const todayOrdinal = toOrdinal(today)
  if (
    !item ||
    item.inventoryStatus !== 'active' ||
    expectedRemindDate !== job.remindDate ||
    expiryOrdinal === null ||
    expiryOrdinal < todayOrdinal
  ) {
    await cancelJob(job, 'ITEM_NOT_ELIGIBLE', '物品状态或提醒日期已变化')
    return 'cancelled'
  }

  const claimResult = await db
    .collection(REMINDERS)
    .where({
      _id: job._id,
      ownerId: job.ownerId,
      status: 'scheduled',
      remindDate: job.remindDate,
    })
    .update({
      data: {
        status: 'sending',
        updatedAt: db.serverDate(),
      },
    })
  if (updatedCount(claimResult) !== 1) return 'skipped'

  const sendItem = await findOwnedItem(job.ownerId, job.itemId)
  const sendExpiryOrdinal = sendItem ? toOrdinal(sendItem.expiryDate) : null
  const sendRemindDate = sendItem
    ? addDays(sendItem.expiryDate, -normalizedLeadDays(sendItem.reminderLeadDays))
    : null
  if (
    !sendItem ||
    sendItem.inventoryStatus !== 'active' ||
    sendRemindDate !== job.remindDate ||
    sendExpiryOrdinal === null ||
    sendExpiryOrdinal < todayOrdinal
  ) {
    await updateJob(job, 'cancelled', {
      failureCode: 'ITEM_CHANGED_BEFORE_SEND',
      failureReason: '发送前物品状态或提醒日期已变化',
    })
    return 'cancelled'
  }

  await db
    .collection(REMINDERS)
    .where({ _id: job._id, ownerId: job.ownerId, status: 'sending' })
    .update({
      data: {
        sendAttemptedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    })

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: job.ownerId,
      templateId: job.templateId,
      page: `pages/item-detail/index?id=${encodeURIComponent(job.itemId)}&source=subscribe`,
      miniprogramState: config.miniprogramState,
      lang: 'zh_CN',
      data: buildReminderTemplateData(sendItem),
    })
    await updateJob(job, 'sent', {
      sentAt: db.serverDate(),
      failureCode: null,
      failureReason: null,
    })
    return 'sent'
  } catch (error) {
    const uncertain = isUncertainError(error)
    const status = uncertain ? 'unknown' : 'failed'
    const failureCode = truncate(error?.errCode || (uncertain ? 'RESULT_UNKNOWN' : 'OPENAPI_REJECTED'), 40)
    await updateJob(job, status, {
      failureCode,
      failureReason: uncertain ? '发送结果不确定，不自动重试' : '微信平台明确返回发送失败',
    })
    return status
  }
}

exports.main = async () => {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  try {
    const context = cloud.getWXContext()
    assert(!context.OPENID, 'FORBIDDEN', '提醒派发函数只允许定时触发')
    const config = loadConfig()
    const today = todayKey()
    const summary = { processed: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0, skipped: 0 }

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const result = await db
        .collection(REMINDERS)
        .where({ status: 'scheduled', remindDate: command.lte(today) })
        .orderBy('remindDate', 'asc')
        .limit(BATCH_SIZE)
        .get()
      if (!result.data.length) break

      // 内层并发（见 JOB_CONCURRENCY 说明）；受控分批，避免一次打太多开放接口。
      for (let index = 0; index < result.data.length; index += JOB_CONCURRENCY) {
        const slice = result.data.slice(index, index + JOB_CONCURRENCY)
        const outcomes = await Promise.all(
          slice.map(async (job) => {
            try {
              return await processJob(job, today, config)
            } catch (_error) {
              // 单条异常不能掀翻整批：留成 failed，剩下的继续发。
              return 'failed'
            }
          }),
        )
        for (const outcome of outcomes) {
          summary.processed += 1
          summary[outcome] += 1
        }
      }
      if (result.data.length < BATCH_SIZE) break
    }

    // 超时被截断时运维要能看出漏了多少，只打 summary 是看不出来的。
    let remaining = 0
    try {
      const remainingResult = await db
        .collection(REMINDERS)
        .where({ status: 'scheduled', remindDate: command.lte(today) })
        .count()
      remaining = remainingResult.total || 0
    } catch (_error) {
      remaining = -1
    }

    console.info(
      JSON.stringify({
        requestId,
        action: 'dispatch',
        resultCode: 'OK',
        durationMs: Date.now() - startedAt,
        ...summary,
        remaining,
      }),
    )
    return { ok: true, data: { ...summary, remaining }, requestId }
  } catch (error) {
    const safeError =
      error instanceof AppError
        ? error
        : new AppError('INTERNAL_ERROR', '提醒派发暂时不可用')
    console.warn(
      JSON.stringify({
        requestId,
        action: 'dispatch',
        resultCode: safeError.code,
        durationMs: Date.now() - startedAt,
      }),
    )
    return {
      ok: false,
      error: { code: safeError.code, message: safeError.message },
      requestId,
    }
  }
}
