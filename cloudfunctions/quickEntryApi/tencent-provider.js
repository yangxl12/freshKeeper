'use strict'

const crypto = require('node:crypto')
const { assert } = require('./validation')
const { extractDates, shelfLife } = require('./quick-text')

function configured() {
  return Boolean(process.env.QUICK_ENTRY_TENCENT_SECRET_ID && process.env.QUICK_ENTRY_TENCENT_SECRET_KEY)
}

function config() {
  return {
    credential: { secretId: process.env.QUICK_ENTRY_TENCENT_SECRET_ID, secretKey: process.env.QUICK_ENTRY_TENCENT_SECRET_KEY },
    region: process.env.QUICK_ENTRY_TENCENT_REGION || 'ap-guangzhou',
    profile: { httpProfile: { reqTimeout: 20 } },
  }
}

function normalizeOcrLines(lines, today) {
  assert(Array.isArray(lines), 'INVALID_PROVIDER_RESPONSE', '日期识别结果不正确')
  const text = lines.map(line => line.DetectedText || '').join(' ').slice(0, 2000)
  const candidates = extractDates(text, today, 'photo')
  // Low-confidence date lines remain visible evidence but never become a definite value.
  for (const candidate of candidates) {
    if (lines.some(line => Number(line.Confidence) < 80 && /\d/.test(line.DetectedText || ''))) {
      candidate.complete = false
      candidate.date = null
    }
  }
  return {
    candidates, ...shelfLife(text), sourceText: text,
    unsupported: /开封后|开启后|\b\d+\s*M\b/i.test(text) ? 'opened_period' : undefined,
  }
}

async function request(kind, payload) {
  assert(configured(), 'AI_UNAVAILABLE', '识别服务暂未开通')
  if (kind === 'STT') {
    const { asr } = require('tencentcloud-sdk-nodejs-asr')
    const client = new asr.v20190614.Client(config())
    const result = await client.SentenceRecognition({
      EngSerViceType: '16k_zh', SourceType: 1, VoiceFormat: 'mp3',
      UsrAudioKey: crypto.randomUUID(), Data: payload.mediaBase64,
      DataLen: Buffer.from(payload.mediaBase64, 'base64').length,
    })
    assert(typeof result.Result === 'string' && result.Result.trim(), 'NO_SPEECH', '没有听清有效语音，请重录或改用文字')
    return { text: result.Result.trim() }
  }
  const { ocr } = require('tencentcloud-sdk-nodejs-ocr')
  const result = await new ocr.v20181119.Client(config()).GeneralAccurateOCR({ ImageBase64: payload.mediaBase64 })
  return normalizeOcrLines(result.TextDetections, payload.serverToday)
}

module.exports = { configured, request, normalizeOcrLines }
