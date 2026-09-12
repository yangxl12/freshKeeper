'use strict'

const { assert } = require('./error')

const SETTINGS = 'user_settings'
/** 已废弃字段：新写入一律不带，旧文档上的残留值在更新时清掉。 */
const LEGACY_DEFAULT_STORAGE_FIELD = 'defaultStorageLocation'
const SETTINGS_FIELDS = new Set(['defaultReminderLeadDays', LEGACY_DEFAULT_STORAGE_FIELD])

function updatedCount(result) {
  return result?.stats?.updated ?? result?.updated ?? 0
}

function validateSettings(input) {
  assert(
    input && typeof input === 'object' && !Array.isArray(input),
    'INVALID_ARGUMENT',
    '设置内容不正确',
  )
  for (const key of Object.keys(input)) {
    assert(SETTINGS_FIELDS.has(key), 'FORBIDDEN_FIELD', `设置字段 ${key} 不允许修改`)
  }
  assert(
    Number.isInteger(input.defaultReminderLeadDays) &&
      input.defaultReminderLeadDays >= 0 &&
      input.defaultReminderLeadDays <= 30,
    'INVALID_ARGUMENT',
    '默认提醒天数需为 0～30 的整数',
  )
  if (Object.prototype.hasOwnProperty.call(input, LEGACY_DEFAULT_STORAGE_FIELD)) {
    const legacyValue = input[LEGACY_DEFAULT_STORAGE_FIELD]
    assert(
      legacyValue === null || (typeof legacyValue === 'string' && legacyValue.length <= 100),
      'INVALID_ARGUMENT',
      '设置内容不正确',
    )
  }
  return { defaultReminderLeadDays: input.defaultReminderLeadDays }
}

/**
 * 用户设置读写。原来是独立的 settingsApi 云函数，只有 100 多行、单集合读写，
 * 却要在「进快录页」这条冷启动路径上多起一个函数实例 —— 合进 userApi 少一次冷启动。
 */
function createSettingsService({ db }) {
  assert(db, 'INTERNAL_ERROR', '数据库未初始化')

  // 只读 defaultReminderLeadDays：原来的 hasReminderJobs 是一次 reminder_jobs 的 count，
  // 全项目没有任何地方渲染它，等于每次读设置都白扫一张表。
  async function getSettings(ownerId) {
    const result = await db.collection(SETTINGS).where({ _id: ownerId, ownerId }).limit(1).get()
    return { defaultReminderLeadDays: result.data[0]?.defaultReminderLeadDays ?? 1 }
  }

  async function updateSettings(ownerId, input) {
    const normalized = validateSettings(input)
    // 先按条件更新、没命中再 set：省掉更新前那次「文档在不在」的读。
    const updated = await db.collection(SETTINGS).where({ _id: ownerId, ownerId }).update({
      data: {
        ...normalized,
        [LEGACY_DEFAULT_STORAGE_FIELD]: db.command.remove(),
        updatedAt: db.serverDate(),
      },
    })
    if (updatedCount(updated) > 0) return normalized
    await db.collection(SETTINGS).doc(ownerId).set({
      data: {
        ownerId,
        ...normalized,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    })
    return normalized
  }

  return { getSettings, updateSettings }
}

module.exports = { createSettingsService, validateSettings }
