'use strict'

const crypto = require('node:crypto')
const { AppError, assert } = require('./error')

const FORBIDDEN_KEYS = ['ownerId', 'openid', 'openId', '_openid', 'templateId']
const PROFILE_FIELDS = new Set(['nickname', 'avatarFileId'])
const NICKNAME_MAX_LENGTH = 20
const DELETE_CONFIRM_WORD = 'DELETE'

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
// 防止 A 用户拿 B 用户的 fileID 存进自己的档案。
function avatarOwnerPrefix(ownerId) {
  return `avatars/${crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 32)}/`
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
    if (value === null) {
      normalized.nickname = null
    } else {
      const nickname = value.trim()
      assert(
        nickname.length <= NICKNAME_MAX_LENGTH,
        'INVALID_ARGUMENT',
        `昵称不能超过 ${NICKNAME_MAX_LENGTH} 个字符`,
      )
      normalized.nickname = nickname || null
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'avatarFileId')) {
    const value = input.avatarFileId
    assert(typeof value === 'string' || value === null, 'INVALID_ARGUMENT', '头像不正确')
    if (value === null) {
      normalized.avatarFileId = null
    } else {
      assert(value.startsWith('cloud://'), 'INVALID_ARGUMENT', '头像需先上传到云存储')
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
  avatarOwnerPrefix,
  validateDeleteConfirm,
  validateProfileUpdate,
}
