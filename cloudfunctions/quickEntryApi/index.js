'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')
const { currentDateKey, normalizeTextResult } = require('./date-facts')
const { providerConfigured, requestProvider } = require('./provider')
const { assert, assertNoClientIdentity, validateText } = require('./validation')
const { parseText: parseLocally } = require('./quick-text')
const { aiEnabled } = require('./ai-client')
const { aiParseText } = require('./ai-parse')
const { cacheKey, consumeAiQuota, readCachedResult, writeCachedResult } = require('./ai-quota')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 60000 })
const db = cloud.database()

async function getCapabilities() {
  return {
    text: true,
    aiText: aiEnabled(),
  }
}

/**
 * AI 加速路径：缓存命中零成本直接复用；未命中先记账（按 openid 每日限次），再调模型。
 * 任何失败都返回 null，由调用方静默降级——错误码不暴露给用户（前端 toast 会被截断，且这里没有可执行的补救动作）。
 */
async function parseWithAi(text, serverToday) {
  const key = cacheKey(text, serverToday)
  const cached = readCachedResult(key)
  if (cached) {
    console.info(JSON.stringify({ resultCode: 'AI_PARSE_CACHE_HIT' }))
    return cached
  }
  let quota
  try {
    quota = await consumeAiQuota(db, cloud.getWXContext().OPENID, serverToday)
  } catch (_error) {
    console.warn(JSON.stringify({ resultCode: 'AI_QUOTA_UNAVAILABLE' }))
    return null
  }
  if (!quota.allowed) {
    console.warn(JSON.stringify({ resultCode: 'AI_QUOTA_EXCEEDED', used: quota.used, limit: quota.limit }))
    return null
  }
  if (quota.nearLimit) {
    console.warn(JSON.stringify({ resultCode: 'AI_QUOTA_NEAR_LIMIT', used: quota.used, limit: quota.limit }))
  }
  const startedAt = Date.now()
  try {
    const result = await aiParseText({ text, serverToday })
    writeCachedResult(key, result)
    console.info(JSON.stringify({ resultCode: 'AI_PARSE_OK', durationMs: Date.now() - startedAt, itemCount: result.items.length, used: quota.used, limit: quota.limit }))
    return result
  } catch (error) {
    console.warn(JSON.stringify({ resultCode: 'AI_PARSE_DEGRADED', reason: error?.code || 'AI_FAILED', durationMs: Date.now() - startedAt }))
    return null
  }
}

/**
 * 三级降级：AI → 自定义 provider → 本地 rules-v3。
 */
async function parseText(event) {
  const text = validateText(event.text)
  const serverToday = currentDateKey()
  if (aiEnabled()) {
    const result = await parseWithAi(text, serverToday)
    if (result) return result
  }
  if (!providerConfigured('TEXT')) return parseLocally(text, serverToday)
  return normalizeTextResult(await requestProvider('TEXT', { text, serverToday }), serverToday)
}

const handlers = { getCapabilities, parseText }

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
