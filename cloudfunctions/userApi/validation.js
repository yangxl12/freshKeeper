'use strict'

const crypto = require('node:crypto')
const { AppError, assert } = require('./error')

const FORBIDDEN_KEYS = ['ownerId', 'openid', 'openId', '_openid', 'templateId']
const PROFILE_FIELDS = new Set(['nickname', 'avatarFileId'])
/** 按码点计数，不是 UTF-16 单元：emoji 昵称不能被切成半个字符。 */
const NICKNAME_MAX_CODE_POINTS = 20
const AVATAR_FILE_ID_MAX_LENGTH = 512
const AVATAR_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const DELETE_CONFIRM_WORD = 'DELETE'

const SHANGHAI_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function assertPlainObject(value, message) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_ARGUMENT',
    message,
  )
}

function assertNoClientIdentity(event) {
  assertPlainObject(event, '请求参数不正确')
  for (const container of [event, event.data].filter(Boolean)) {
    if (typeof container !== 'object' || Array.isArray(container)) continue
    for (const key of Object.keys(container)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new AppError('FORBIDDEN_FIELD', '请求包含不允许提交的字段')
      }
    }
  }
}

// 与快录临时媒体同款思路：路径里带 openid 哈希前缀，
// 防止 A 用户拿 B 用户的 fileID 存进自己的档案，也避免明文 openid 落进云存储路径。
function avatarOwnerHash(ownerId) {
  return crypto.createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 32)
}

function avatarOwnerPrefix(ownerId) {
  return `avatars/${avatarOwnerHash(ownerId)}/`
}

/**
 * 昵称归一：trim → 按码点截断 → 空白返回 null（null 对外表示「回默认态」）。
 * 用 Array.from 而不是 slice：slice 按 UTF-16 单元切，会把 emoji 切成半个。
 */
function normalizeNickname(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return Array.from(trimmed).slice(0, NICKNAME_MAX_CODE_POINTS).join('')
}

/** 头像落云存储的路径；扩展名走白名单，认不出来的统一按 png。 */
function avatarCloudPath(hash, ext, now = Date.now(), id = crypto.randomUUID()) {
  const raw = String(ext || '').toLowerCase().replace(/^\./, '')
  const safe = AVATAR_EXTENSIONS.has(raw) ? raw : 'png'
  return `avatars/${hash}/${now}-${id}.${safe}`
}

function exportCloudPath(hash, now = new Date(), id = crypto.randomUUID()) {
  return `exports/${hash}/${exportStamp(now)}-${id}.txt`
}

/** 文件名要让用户看得懂、按时间可区分：保质记-数据导出-20260911-1314.txt */
function exportStamp(now = new Date()) {
  const parts = SHANGHAI_PARTS.formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}`
}

function exportFileName(now = new Date()) {
  return `保质记-数据导出-${exportStamp(now)}.txt`
}

function validateProfileUpdate(input, ownerId) {
  assertPlainObject(input, '资料内容不正确')
  const keys = Object.keys(input)
  assert(keys.length >= 1, 'INVALID_ARGUMENT', '没有需要更新的资料')
  for (const key of keys) {
    assert(PROFILE_FIELDS.has(key), 'FORBIDDEN_FIELD', `资料字段 ${key} 不允许修改`)
  }

  const normalized = {}
  if (Object.prototype.hasOwnProperty.call(input, 'nickname')) {
    const value = input.nickname
    assert(typeof value === 'string' || value === null, 'INVALID_ARGUMENT', '昵称不正确')
    // 超长不报错，按码点截断：用户的输入不该被整条拒掉，更不能截出半个 emoji。
    normalized.nickname = value === null ? null : normalizeNickname(value)
  }

  if (Object.prototype.hasOwnProperty.call(input, 'avatarFileId')) {
    const value = input.avatarFileId
    assert(typeof value === 'string' || value === null, 'INVALID_ARGUMENT', '头像不正确')
    if (value === null) {
      normalized.avatarFileId = null
    } else {
      assert(value.startsWith('cloud://'), 'INVALID_ARGUMENT', '头像需先上传到云存储')
      assert(
        value.length <= AVATAR_FILE_ID_MAX_LENGTH,
        'INVALID_ARGUMENT',
        '头像路径不正确',
      )
      assert(!value.includes('..') && !value.includes('%'), 'INVALID_ARGUMENT', '头像路径不正确')
      assert(
        value.includes(`/${avatarOwnerPrefix(ownerId)}`),
        'INVALID_ARGUMENT',
        '头像不属于当前用户',
      )
      normalized.avatarFileId = value
    }
  }

  return normalized
}

// 服务端二次把关，防止前端一步确认被误触。
function validateDeleteConfirm(input) {
  assertPlainObject(input, '注销请求不正确')
  assert(input.confirm === DELETE_CONFIRM_WORD, 'INVALID_ARGUMENT', '注销确认词不正确')
}

module.exports = {
  assertNoClientIdentity,
  avatarCloudPath,
  avatarOwnerHash,
  avatarOwnerPrefix,
  exportCloudPath,
  exportFileName,
  normalizeNickname,
  validateDeleteConfirm,
  validateProfileUpdate,
}
