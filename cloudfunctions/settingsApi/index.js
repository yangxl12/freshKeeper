'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const SETTINGS = 'user_settings'
const REMINDERS = 'reminder_jobs'

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

async function findSettings(ownerId) {
  const result = await db.collection(SETTINGS).where({ _id: ownerId, ownerId }).limit(1).get()
  return result.data[0] || null
}

async function getSettings(ownerId) {
  const [settings, reminderCount] = await Promise.all([
    findSettings(ownerId),
    db
      .collection(REMINDERS)
      .where({ ownerId, status: db.command.in(['scheduled', 'sent']) })
      .count(),
  ])
  return {
    defaultReminderLeadDays: settings?.defaultReminderLeadDays ?? 1,
    hasReminderJobs: reminderCount.total > 0,
  }
}

function validateSettings(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', '设置内容不正确')
  const allowed = new Set(['defaultReminderLeadDays'])
  for (const key of Object.keys(input)) {
    assert(allowed.has(key), 'FORBIDDEN_FIELD', `设置字段 ${key} 不允许修改`)
  }
  assert(
    Number.isInteger(input.defaultReminderLeadDays) &&
      input.defaultReminderLeadDays >= 0 &&
      input.defaultReminderLeadDays <= 30,
    'INVALID_ARGUMENT',
    '默认提醒天数需为 0～30 的整数',
  )
  return {
    defaultReminderLeadDays: input.defaultReminderLeadDays,
  }
}

async function updateSettings(ownerId, event) {
  const normalized = validateSettings(event.data)
  const current = await findSettings(ownerId)
  if (current) {
    await db.collection(SETTINGS).where({ _id: ownerId, ownerId }).update({
      data: {
        ...normalized,
        defaultStorageLocation: db.command.remove(),
        updatedAt: db.serverDate(),
      },
    })
  } else {
    await db.collection(SETTINGS).doc(ownerId).set({
      data: {
        ownerId,
        ...normalized,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    })
  }
  return normalized
}

const handlers = {
  get: (ownerId) => getSettings(ownerId),
  update: updateSettings,
}

exports.main = async (event = {}) => {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  const action = event && typeof event.action === 'string' ? event.action : ''
  try {
    assertSafeEvent(event)
    const ownerId = cloud.getWXContext().OPENID
    assert(ownerId, 'UNAUTHENTICATED', '请在微信中重新打开小程序')
    const handler = handlers[action]
    assert(handler, 'INVALID_ACTION', '不支持的设置操作')
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
