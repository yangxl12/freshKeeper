'use strict'

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function assert(condition, code, message) {
  if (!condition) fail(code, message)
}

function assertNoClientIdentity(event) {
  assert(event && typeof event === 'object' && !Array.isArray(event), 'INVALID_ARGUMENT', '请求参数不正确')
  for (const key of Object.keys(event)) {
    if (['ownerId', 'openid', 'openId', '_openid', 'templateId'].includes(key)) {
      fail('FORBIDDEN_FIELD', '请求包含不允许提交的字段')
    }
  }
}

function validateText(value) {
  assert(typeof value === 'string', 'INVALID_ARGUMENT', '录入文字不正确')
  const text = value.trim()
  assert(text.length >= 1, 'INVALID_ARGUMENT', '请输入要识别的内容')
  assert(text.length <= 500, 'INVALID_ARGUMENT', '一次最多识别 500 个字符')
  return text
}

function mediaOwnerPrefix(ownerId) {
  return `quick-entry/${require('node:crypto').createHash('sha256').update(ownerId).digest('hex').slice(0, 32)}/`
}

function validateMedia(event, expectedType, ownerId) {
  assert(typeof event.fileID === 'string' && event.fileID.length >= 1 && event.fileID.length <= 512, 'MEDIA_INVALID', '临时媒体无效')
  assert(event.mediaType === expectedType, 'MEDIA_INVALID', '媒体类型不正确')
  assert(typeof ownerId === 'string' && ownerId.length > 0, 'UNAUTHENTICATED', '请重新打开小程序')
  const marker = `/${mediaOwnerPrefix(ownerId)}${expectedType}/`
  assert(event.fileID.startsWith('cloud://') && event.fileID.includes(marker), 'MEDIA_INVALID', '临时媒体不属于当前用户')
  assert(!event.fileID.includes('..') && !event.fileID.includes('%'), 'MEDIA_INVALID', '临时媒体路径不正确')
  return event.fileID
}

module.exports = { assert, assertNoClientIdentity, fail, validateMedia, validateText, mediaOwnerPrefix }
