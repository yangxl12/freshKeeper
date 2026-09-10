'use strict'

// AI 结果缓存 + 按 openid 的每日限次。
//
// 为什么用实例内存而不是云数据库：集合不存在时云函数会直接报错，而本项目已经因为
// 「config.json / 集合等配置不随部署生效」踩过坑（见 docs/cloud-deployment.md 3.3）。
// 单次解析成本约 1 Token 点（0.001 元），内存限次足够挡住误触和脚本刷量；
// 真要精确计量再换云数据库集合，接口不变。
const crypto = require('node:crypto')

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 200
const DEFAULT_DAILY_LIMIT = 50
const WARN_RATIO = 0.8

const resultCache = new Map()
const quotaUsage = new Map()
let quotaDateKey = null

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

/** 跨天就清空，避免 Map 长期驻留旧日期计数。 */
function rollDate(dateKey) {
  if (quotaDateKey === dateKey) return
  quotaDateKey = dateKey
  quotaUsage.clear()
}

/**
 * 记账一次 AI 调用；只有 allowed 为 true 才真正调模型。
 * @returns {{ allowed: boolean, used: number, limit: number, remaining: number, nearLimit: boolean }}
 */
function consumeAiQuota(openid, dateKey, now = Date.now()) {
  void now
  rollDate(dateKey)
  const limit = dailyLimit()
  const key = String(openid || 'anonymous')
  const used = quotaUsage.get(key) || 0
  if (used >= limit) return { allowed: false, used, limit, remaining: 0, nearLimit: false }
  const next = used + 1
  quotaUsage.set(key, next)
  return { allowed: true, used: next, limit, remaining: limit - next, nearLimit: next / limit >= WARN_RATIO }
}

/** 只读快照，用于日志与单测。 */
function peekAiQuota(openid, dateKey) {
  rollDate(dateKey)
  return { used: quotaUsage.get(String(openid || 'anonymous')) || 0, limit: dailyLimit(), cacheSize: resultCache.size }
}

/** 单测专用：清空实例内存状态。 */
function resetAiState() {
  resultCache.clear()
  quotaUsage.clear()
  quotaDateKey = null
}

module.exports = {
  cacheKey,
  consumeAiQuota,
  dailyLimit,
  peekAiQuota,
  readCachedResult,
  resetAiState,
  writeCachedResult,
}
