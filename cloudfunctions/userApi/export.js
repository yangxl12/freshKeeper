'use strict'

const { shanghaiDateKey } = require('./date')

const EXPORT_SCHEMA_VERSION = 1

/** 内部字段：主键、归属、模板 ID 都不属于用户的个人信息，导出时必须剔掉。 */
const STRIPPED_KEYS = ['_id', 'ownerId', '_openid', 'templateId']

function strip(doc) {
  const output = {}
  for (const [key, value] of Object.entries(doc || {})) {
    if (STRIPPED_KEYS.includes(key)) continue
    output[key] = value instanceof Date ? value.toISOString() : value
  }
  return output
}

function reminderEntry(doc) {
  const entry = strip(doc)
  return {
    remindAt: entry.remindAt ?? null,
    status: entry.status ?? null,
    createdAt: entry.createdAt ?? null,
    inventoryItemId: entry.inventoryItemId ?? null,
  }
}

/**
 * 导出快照的装配，纯函数（不碰 db / 云存储），便于单测。
 * 只出「属于用户的数据」：标识字段一律不带，见 STRIPPED_KEYS。
 */
function buildExportPayload({ items = [], settings = null, user = null, reminders = [], exportedAt = '' } = {}) {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt,
    profile: {
      nickname: user?.nickname ?? null,
      createdAt: shanghaiDateKey(user?.createdAt) || null,
      lastSeenAt: shanghaiDateKey(user?.lastSeenAt) || null,
    },
    settings: {
      defaultReminderLeadDays: settings?.defaultReminderLeadDays ?? null,
    },
    items: (items || []).map(strip),
    reminders: (reminders || []).map(reminderEntry),
  }
}

module.exports = { EXPORT_SCHEMA_VERSION, buildExportPayload }
