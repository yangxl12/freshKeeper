'use strict'

// AI 结果使用短期实例缓存；调用额度使用 ai_usage_daily 持久化事务计数。
// 配额写入失败时调用方降级到本地解析（fail-closed），不会绕过额度继续调用模型。
const crypto = require('node:crypto')

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 200
const DEFAULT_DAILY_LIMIT = 50
const DEFAULT_GLOBAL_DAILY_LIMIT = 500
const WARN_RATIO = 0.8
const USAGE = 'ai_usage_daily'

const resultCache = new Map()

/** 归一化后做键：空白、全半角和大小写差异不该产生两次模型调用。 */
function cacheKey(text, serverToday) {
  const normalized = String(text).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  return crypto.createHash('sha256').update(`${normalized}|${serverToday}`).digest('hex')
}

function readCachedResult(key, now = Date.now()) {
  const entry = resultCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    resultCache.delete(key)
    return null
  }
  try {
    return JSON.parse(entry.payload)
  } catch (_error) {
    resultCache.delete(key)
    return null
  }
}

/**
 * 存 JSON 字符串而不是对象引用：云函数实例内多请求共享，字符串不会被下游意外改写。
 */
function writeCachedResult(key, result, now = Date.now()) {
  if (resultCache.size >= CACHE_MAX_ENTRIES) {
    for (const oldest of resultCache.keys()) {
      resultCache.delete(oldest)
      if (resultCache.size < CACHE_MAX_ENTRIES) break
    }
  }
  resultCache.set(key, { payload: JSON.stringify(result), expiresAt: now + CACHE_TTL_MS })
}

function dailyLimit() {
  const configured = Number(process.env.QUICK_ENTRY_AI_DAILY_LIMIT)
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_DAILY_LIMIT
}

function globalDailyLimit() {
  const configured = Number(process.env.QUICK_ENTRY_AI_GLOBAL_DAILY_LIMIT)
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_GLOBAL_DAILY_LIMIT
}

function usageId(scope, ownerId, dateKey) {
  const subject = scope === 'global'
    ? 'global'
    : crypto.createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 32)
  return `quick-text-${dateKey}-${subject}`
}

/**
 * 记账一次 AI 调用；只有 allowed 为 true 才真正调模型。
 * @returns {{ allowed: boolean, used: number, limit: number, remaining: number, nearLimit: boolean }}
 */
async function consumeAiQuota(db, openid, dateKey) {
  if (!db || !openid) throw new Error('AI_QUOTA_UNAVAILABLE')
  const userLimit = dailyLimit()
  const globalLimit = globalDailyLimit()
  const userId = usageId('user', openid, dateKey)
  const globalId = usageId('global', openid, dateKey)
  return db.runTransaction(async (transaction) => {
    const result = await transaction.collection(USAGE)
      .where({ _id: db.command.in([userId, globalId]) })
      .get()
    const byId = new Map((result.data || []).map((entry) => [entry._id, entry]))
    const used = Number(byId.get(userId)?.count) || 0
    const globalUsed = Number(byId.get(globalId)?.count) || 0
    if (used >= userLimit || globalUsed >= globalLimit) {
      return { allowed: false, used, limit: userLimit, globalUsed, globalLimit, remaining: Math.max(0, userLimit - used), nearLimit: false }
    }
    const next = used + 1
    const globalNext = globalUsed + 1
    await transaction.collection(USAGE).doc(userId).set({
      data: { kind: 'quick_text', scope: 'user', ownerId: openid, dateKey, count: next, updatedAt: db.serverDate() },
    })
    await transaction.collection(USAGE).doc(globalId).set({
      data: { kind: 'quick_text', scope: 'global', dateKey, count: globalNext, updatedAt: db.serverDate() },
    })
    return {
      allowed: true,
      used: next,
      limit: userLimit,
      globalUsed: globalNext,
      globalLimit,
      remaining: userLimit - next,
      nearLimit: next / userLimit >= WARN_RATIO || globalNext / globalLimit >= WARN_RATIO,
    }
  })
}

/** 单测专用：清空实例内存状态。 */
function resetAiState() {
  resultCache.clear()
}

module.exports = {
  cacheKey,
  consumeAiQuota,
  dailyLimit,
  globalDailyLimit,
  readCachedResult,
  resetAiState,
  writeCachedResult,
}
