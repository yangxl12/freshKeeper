'use strict'

// SDK 适配层：全项目只有这里知道 cloud.ai()、provider 名和模型返回结构。
// 免费额度耗尽、切到资源点套餐时，只把 PROVIDER 改成 'cloudbase'（或用环境变量覆盖）。
// 模型名同理（hy3-preview 已公告下线），只允许出现在这个文件里。
const { assert, fail } = require('./validation')

const PROVIDER = 'hunyuan-v3'
const MODEL = 'hy3'
// 默认预算必须小于前端 8s 的 Promise.race，否则用户已经降级本地了服务端才返回。
const DEFAULT_TIMEOUT_MS = 6000

let sdkCache = null

function loadSdk() {
  if (!sdkCache) sdkCache = require('wx-server-sdk')
  return sdkCache
}

function envFlag(name) {
  const value = String(process.env[name] || '').trim().toLowerCase()
  return value === '1' || value === 'true'
}

function envText(name, fallback) {
  const value = String(process.env[name] || '').trim()
  return value || fallback
}

function aiEnabled() {
  return envFlag('QUICK_ENTRY_AI_ENABLED')
}

function providerName() {
  return envText('QUICK_ENTRY_AI_PROVIDER', PROVIDER)
}

function modelName() {
  return envText('QUICK_ENTRY_AI_MODEL', MODEL)
}

function aiTimeoutMs() {
  const configured = Number(process.env.QUICK_ENTRY_AI_TIMEOUT_MS)
  const budget = Number.isFinite(configured) && configured >= 1000 ? configured : DEFAULT_TIMEOUT_MS
  const ceiling = Number(process.env.QUICK_ENTRY_TIMEOUT_MS)
  return Number.isFinite(ceiling) && ceiling >= 1000 ? Math.min(budget, ceiling) : budget
}

// SDK 返回结构只在这里收敛：优先 result.text，退化到 result.messages。
function extractText(result) {
  if (typeof result === 'string') return result
  if (result && typeof result.text === 'string') return result.text
  if (result && Array.isArray(result.messages)) {
    for (let index = result.messages.length - 1; index >= 0; index -= 1) {
      const content = result.messages[index] && result.messages[index].content
      if (typeof content === 'string' && content.trim()) return content
      if (Array.isArray(content)) {
        const joined = content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
        if (joined.trim()) return joined
      }
    }
  }
  return ''
}

async function generateViaSdk(deps, messages) {
  const sdk = deps.sdk || loadSdk()
  assert(typeof sdk.ai === 'function', 'AI_UNAVAILABLE', 'AI 识别暂不可用')
  const ai = sdk.ai()
  assert(ai && typeof ai.createModel === 'function', 'AI_UNAVAILABLE', 'AI 识别暂不可用')
  const model = ai.createModel(deps.provider)
  assert(model && typeof model.generateText === 'function', 'AI_UNAVAILABLE', 'AI 识别暂不可用')
  const result = await model.generateText({ model: deps.model, messages })
  return { text: extractText(result), usage: (result && result.usage) || null }
}

/**
 * 造一个 generateText(messages) -> { text, usage }。
 * 单测里直接传 { sdk: fakeSdk } 即可，不会真的加载 wx-server-sdk。
 */
function createTextGenerator(options = {}) {
  const deps = {
    sdk: options.sdk || null,
    provider: options.provider || providerName(),
    model: options.model || modelName(),
  }
  return async function generateText(messages) {
    assert(Array.isArray(messages) && messages.length > 0, 'INVALID_ARGUMENT', '请求参数不正确')
    try {
      return await generateViaSdk(deps, messages)
    } catch (error) {
      // 保留 SDK 自带错误码（如 EXCEED_CONCURRENT_REQUEST_LIMIT，P1 要按它退避重试）。
      if (error && error.code) throw error
      fail('AI_UNAVAILABLE', '识别服务暂时不可用，请稍后重试')
    }
  }
}

module.exports = { aiEnabled, aiTimeoutMs, createTextGenerator, extractText, modelName, providerName }
