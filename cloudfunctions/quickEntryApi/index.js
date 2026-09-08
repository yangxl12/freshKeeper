'use strict'

const cloud = require('wx-server-sdk')
const { assertNoClientIdentity } = require('../inventoryApi/validation')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

class QuickEntryError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function assert(condition, code, message) {
  if (!condition) throw new QuickEntryError(code, message)
}

function validateText(value) {
  assert(typeof value === 'string', 'INVALID_ARGUMENT', '录入文字不正确')
  const text = value.trim()
  assert(text.length >= 1, 'INVALID_ARGUMENT', '请输入要识别的内容')
  assert(text.length <= 500, 'INVALID_ARGUMENT', '一次最多识别 500 个字符')
  return text
}

function validateMedia(event) {
  assert(typeof event.fileID === 'string' && event.fileID.length >= 1 && event.fileID.length <= 512, 'MEDIA_INVALID', '临时媒体无效')
  assert(['audio', 'image'].includes(event.mediaType), 'MEDIA_INVALID', '媒体类型不正确')
}

function providerConfigured(kind) {
  return Boolean(process.env[`QUICK_ENTRY_${kind}_ENDPOINT`] && process.env[`QUICK_ENTRY_${kind}_API_KEY`])
}

async function removeTemporaryFile(fileID) {
  try {
    await cloud.deleteFile({ fileList: [fileID] })
  } catch (_error) {
    console.warn(JSON.stringify({ resultCode: 'MEDIA_CLEANUP_FAILED' }))
  }
}

async function parseText(event) {
  validateText(event.text)
  assert(providerConfigured('TEXT'), 'AI_UNAVAILABLE', '文字识别服务暂未配置，请使用完整填写')
  throw new QuickEntryError('AI_UNAVAILABLE', '文字识别服务暂未配置，请使用完整填写')
}

async function transcribeVoice(event) {
  validateMedia(event)
  assert(event.mediaType === 'audio', 'MEDIA_INVALID', '录音媒体类型不正确')
  try {
    assert(providerConfigured('STT'), 'AI_UNAVAILABLE', '语音识别服务暂未配置，请使用文字填写')
    throw new QuickEntryError('AI_UNAVAILABLE', '语音识别服务暂未配置，请使用文字填写')
  } finally {
    await removeTemporaryFile(event.fileID)
  }
}

async function recognizeDatePhoto(event) {
  validateMedia(event)
  assert(event.mediaType === 'image', 'MEDIA_INVALID', '图片媒体类型不正确')
  try {
    assert(providerConfigured('OCR'), 'AI_UNAVAILABLE', '日期识别服务暂未配置，请手动选择日期')
    throw new QuickEntryError('AI_UNAVAILABLE', '日期识别服务暂未配置，请手动选择日期')
  } finally {
    await removeTemporaryFile(event.fileID)
  }
}

const handlers = { parseText, transcribeVoice, recognizeDatePhoto }

exports.main = async (event = {}) => {
  const requestId = require('node:crypto').randomUUID()
  const startedAt = Date.now()
  const action = typeof event.action === 'string' ? event.action : ''
  try {
    assertNoClientIdentity(event)
    assert(cloud.getWXContext().OPENID, 'UNAUTHENTICATED', '请在微信中重新打开小程序')
    assert(handlers[action], 'INVALID_ACTION', '不支持的快速录入操作')
    const data = await handlers[action](event)
    console.info(JSON.stringify({ requestId, action, resultCode: 'OK', durationMs: Date.now() - startedAt }))
    return { ok: true, data, requestId }
  } catch (error) {
    const code = error?.code || 'QUICK_ENTRY_FAILED'
    const message = error?.message || '快速录入服务暂时不可用，请使用完整填写'
    console.warn(JSON.stringify({ requestId, action, resultCode: code, durationMs: Date.now() - startedAt }))
    return { ok: false, error: { code, message }, requestId }
  }
}
