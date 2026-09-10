'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')
const { currentDateKey, normalizePhotoResult, normalizeTextResult } = require('./date-facts')
const { providerConfigured, requestProvider } = require('./provider')
const { assert, assertNoClientIdentity, validateMedia, validateText, mediaOwnerPrefix } = require('./validation')
const { parseText: parseLocally } = require('./quick-text')
const { aiEnabled } = require('./ai-client')
const { aiParseText } = require('./ai-parse')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 60000 })

async function removeTemporaryFile(fileID) {
  try {
    await cloud.deleteFile({ fileList: [fileID] })
  } catch (_error) {
    console.warn(JSON.stringify({ resultCode: 'MEDIA_CLEANUP_FAILED' }))
  }
}

async function downloadMedia(fileID, maxBytes) {
  const result = await cloud.downloadFile({ fileID })
  const buffer = result.fileContent
  assert(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= maxBytes, 'MEDIA_INVALID', '临时媒体大小不正确')
  return buffer
}

async function getCapabilities() {
  return {
    text: true,
    voice: providerConfigured('STT'),
    datePhoto: providerConfigured('OCR'),
    aiText: aiEnabled(),
  }
}

/**
 * 三级降级：AI → 自定义 provider → 本地 rules-v3。
 * AI 只是加速路径，任何失败都必须静默降级——错误码不暴露给用户（前端 toast 会被截断，且这里没有可执行的补救动作）。
 */
async function parseText(event) {
  const text = validateText(event.text)
  const serverToday = currentDateKey()
  if (aiEnabled()) {
    const startedAt = Date.now()
    try {
      const result = await aiParseText({ text, serverToday })
      console.info(JSON.stringify({ resultCode: 'AI_PARSE_OK', durationMs: Date.now() - startedAt, itemCount: result.items.length }))
      return result
    } catch (error) {
      console.warn(JSON.stringify({ resultCode: 'AI_PARSE_DEGRADED', reason: error?.code || 'AI_FAILED', durationMs: Date.now() - startedAt }))
    }
  }
  if (!providerConfigured('TEXT')) return parseLocally(text, serverToday)
  return normalizeTextResult(await requestProvider('TEXT', { text, serverToday }), serverToday)
}

async function transcribeVoice(event) {
  const fileID = validateMedia(event, 'audio', cloud.getWXContext().OPENID)
  try {
    const buffer = await downloadMedia(fileID, 4 * 1024 * 1024)
    const result = await requestProvider('STT', { mediaType: 'audio', mediaBase64: buffer.toString('base64') })
    const body = result?.data && typeof result.data === 'object' ? result.data : result
    return { text: validateText(body?.text), serverToday: currentDateKey() }
  } finally {
    await removeTemporaryFile(fileID)
  }
}

async function recognizeDatePhoto(event) {
  const fileID = validateMedia(event, 'image', cloud.getWXContext().OPENID)
  try {
    const buffer = await downloadMedia(fileID, 10 * 1024 * 1024)
    const serverToday = currentDateKey()
    return normalizePhotoResult(await requestProvider('OCR', { mediaType: 'image', mediaBase64: buffer.toString('base64'), serverToday }), serverToday)
  } finally {
    await removeTemporaryFile(fileID)
  }
}

async function createMediaUpload(event) {
  assert(['audio', 'image'].includes(event.mediaType), 'MEDIA_INVALID', '媒体类型不正确')
  const extension = event.mediaType === 'audio' ? 'mp3' : 'jpg'
  return { cloudPath: `${mediaOwnerPrefix(cloud.getWXContext().OPENID)}${event.mediaType}/${Date.now()}-${crypto.randomUUID()}.${extension}` }
}

const handlers = { getCapabilities, parseText, transcribeVoice, recognizeDatePhoto, createMediaUpload }

exports.main = async (event = {}) => {
  const requestId = crypto.randomUUID()
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
