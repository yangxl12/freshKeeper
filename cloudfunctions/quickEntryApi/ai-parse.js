'use strict'

// 编排：调模型 → 提取 JSON → 证据回链校验 → 宽容清洗 → 交给 date-facts 做严格兜底与日期换算。
// 分工（别搞混）：
//   - 本文件 = 宽容 sanitize + 证据回链，尽量保住能用的字段，追不回原文的一律丢成 null
//   - normalizeTextResult = 严格 validate，兜住一切漏网的脏值
const { assert, fail } = require('./validation')
const { currentDateKey, normalizeTextResult } = require('./date-facts')
const { buildMessages, buildRepairMessages } = require('./ai-prompt')
const { aiTimeoutMs, createTextGenerator } = require('./ai-client')

const MAX_ITEMS = 5
const MAX_DATE_FACTS = 12
const PARSER_VERSION = 'ai-v1'
const CONCURRENCY_RETRY_DELAY_MS = 300

const CATEGORIES = new Set(['food', 'medicine', 'household', 'other'])
const SHELF_UNITS = new Set(['day', 'month', 'year'])
const DATE_LABELS = new Set(['expiry', 'production'])
const MAX_OFFSET_DAYS = 3650

function cleanText(value, max) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= max ? text : null
}

function cleanInteger(value, min, max) {
  const number = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value
  return Number.isInteger(number) && number >= min && number <= max ? number : null
}

function cleanLabel(value) {
  return DATE_LABELS.has(value) ? value : 'unknown'
}

// ── 证据回链（L3）────────────────────────────────────────────────────────────
// 归一化掉空白、全半角和大小写差异：模型抄原文时经常顺手加空格或改标点。
function normalizeForTrace(value) {
  return String(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

function containsPhrase(traceText, candidate) {
  const phrase = normalizeForTrace(candidate)
  return Boolean(phrase) && traceText.includes(phrase)
}

// 数字必须作为独立数字出现，否则 "2" 会被 "2026年9月12日" 里的 2 蒙对。
function containsNumber(traceText, value) {
  return new RegExp(`(?<!\\d)${value}(?!\\d)`).test(traceText)
}

/** 字符串字段：evidence 优先，退化到拿字段值本身去原文里核对。对不上就是要丢弃的幻觉。 */
function traceableText(value, evidence, traceText) {
  if (typeof evidence === 'string' && evidence.trim() && containsPhrase(traceText, evidence)) return true
  return containsPhrase(traceText, value)
}

/** 数字字段：evidence 里通常写着「一包」「三个」，本身未必含阿拉伯数字。 */
function traceableNumber(value, evidence, traceText) {
  if (typeof evidence === 'string' && evidence.trim() && containsPhrase(traceText, evidence)) return true
  return containsNumber(traceText, value)
}

function cleanDateFact(fact, traceText) {
  if (!fact || typeof fact !== 'object') return null
  const rawText = cleanText(fact.rawText, 120) || ''
  // 日期是幻觉高发区：rawText 就是它的证据，追不回原文直接丢掉。
  if (!rawText || !containsPhrase(traceText, rawText)) return null
  if (fact.kind === 'shelf_life') {
    const value = cleanInteger(fact.value, 1, 9999)
    const unit = SHELF_UNITS.has(fact.unit) ? fact.unit : null
    if (!value || !unit) return null
    return { kind: 'shelf_life', value, unit, rawText }
  }
  const label = cleanLabel(fact.label)
  if (fact.kind === 'relative') {
    const offsetDays = cleanInteger(fact.offsetDays, -MAX_OFFSET_DAYS, MAX_OFFSET_DAYS)
    if (offsetDays === null) return null
    return { kind: 'relative', offsetDays, label, rawText }
  }
  const year = cleanInteger(fact.year, 1900, 2200)
  const month = cleanInteger(fact.month, 1, 12)
  const day = cleanInteger(fact.day, 1, 31)
  if (year !== null && month !== null && day !== null) return { kind: 'absolute', year, month, day, label, rawText }
  if (month !== null && day !== null) return { kind: 'absolute', month, day, label, rawText }
  return null
}

/**
 * 逐字段宽容清洗 + 证据回链。返回被丢弃的字段名，供日志统计证据覆盖率。
 * category 是例外：它本来就从名称推断，不要求证据，但必须落在枚举白名单内。
 */
function cleanItem(item, traceText) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { item: null, dropped: [] }
  const evidence = item.evidence && typeof item.evidence === 'object' && !Array.isArray(item.evidence) ? item.evidence : {}
  const dropped = []

  const name = cleanText(item.name, 40)
  const quantity = cleanInteger(item.quantity, 1, 9999)
  const unit = cleanText(item.unit, 8)
  const storageLocation = cleanText(item.storageLocation, 500)

  const clean = { name: null, quantity: null, unit: null, storageLocation: null }
  if (name) {
    if (traceableText(name, evidence.name, traceText)) clean.name = name
    else dropped.push('name')
  }
  if (quantity !== null) {
    if (traceableNumber(quantity, evidence.quantity, traceText)) clean.quantity = quantity
    else dropped.push('quantity')
  }
  if (unit) {
    if (traceableText(unit, evidence.unit, traceText)) clean.unit = unit
    else dropped.push('unit')
  }
  if (storageLocation) {
    if (traceableText(storageLocation, evidence.storageLocation, traceText)) clean.storageLocation = storageLocation
    else dropped.push('storageLocation')
  }
  clean.category = CATEGORIES.has(item.category) ? item.category : null

  const rawFacts = (Array.isArray(item.dateFacts) ? item.dateFacts : []).slice(0, MAX_DATE_FACTS)
  const dateFacts = rawFacts.map((fact) => cleanDateFact(fact, traceText)).filter(Boolean)
  if (rawFacts.length && !dateFacts.length) dropped.push('dateFacts')
  clean.dateFacts = dateFacts

  // 名称和日期都没有的候选是噪声，直接丢掉（宽容清洗，不整批失败）。
  if (!clean.name && !dateFacts.length) return { item: null, dropped }
  return { item: clean, dropped }
}

// ── JSON 提取与重试 ─────────────────────────────────────────────────────────
// 容忍 markdown 代码块和前后解释文字，只截取第一个 { 到最后一个 }。
function extractJson(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = (fenced ? fenced[1] : trimmed).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (_error) {
    return null
  }
}

// 体验模型单环境只有 5 并发，超出会报这个码——这是最容易撞的墙，必须退避重试。
const CONCURRENCY_PATTERN = /EXCEED_CONCURRENT|CONCURRENT_REQUEST_LIMIT/i

function isConcurrencyError(error) {
  return CONCURRENCY_PATTERN.test(`${(error && error.code) || ''} ${(error && error.message) || ''}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 撞并发限流时退避重试一次；其他错误原样抛出，由调用方决定降级。 */
async function generateWithRetry(generate, messages, retryDelayMs) {
  try {
    return await generate(messages)
  } catch (error) {
    if (!isConcurrencyError(error)) throw error
    console.warn(JSON.stringify({ resultCode: 'AI_CONCURRENCY_RETRY' }))
    await delay(retryDelayMs)
    return generate(messages)
  }
}

function withTimeout(task, ms) {
  let timer
  return Promise.race([
    task,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('识别超时，请重试或使用完整填写')
        error.code = 'QUICK_ENTRY_TIMEOUT'
        reject(error)
      }, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function requestBody(text, generate, retryDelayMs) {
  const first = await generateWithRetry(generate, buildMessages(text), retryDelayMs)
  if (first && first.usage) console.info(JSON.stringify({ resultCode: 'AI_TOKEN_USAGE', usage: first.usage }))
  const parsed = extractJson(first && first.text)
  if (parsed) return parsed
  console.warn(JSON.stringify({ resultCode: 'AI_OUTPUT_UNPARSEABLE', attempt: 1 }))
  const second = await generateWithRetry(generate, buildRepairMessages(text, first && first.text), retryDelayMs)
  const repaired = extractJson(second && second.text)
  if (repaired) return repaired
  console.warn(JSON.stringify({ resultCode: 'AI_OUTPUT_UNPARSEABLE', attempt: 2 }))
  fail('AI_UNAVAILABLE', '识别服务返回格式不正确，请重试或使用完整填写')
}

/**
 * AI 解析主路径。抛出的错误码统一由调用方决定是否静默降级。
 * @param {{ text: string, serverToday?: string, generate?: Function, timeoutMs?: number, retryDelayMs?: number }} options
 */
async function aiParseText(options = {}) {
  const text = typeof options.text === 'string' ? options.text.trim() : ''
  assert(text.length >= 1 && text.length <= 500, 'INVALID_ARGUMENT', '请输入要识别的内容')
  const serverToday = options.serverToday || currentDateKey()
  const generate = options.generate || createTextGenerator()
  const limit = Number.isFinite(options.timeoutMs) ? options.timeoutMs : aiTimeoutMs()
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : CONCURRENCY_RETRY_DELAY_MS

  const body = await withTimeout(requestBody(text, generate, retryDelayMs), limit)
  const rawItems = Array.isArray(body.items) ? body.items : []
  // 先按原始条数拦住超量，避免清洗把幻觉条目丢掉后又"合法"通过。
  if (rawItems.length > MAX_ITEMS) fail('TOO_MANY_DRAFTS', '一次最多生成 5 条草稿，请分次录入')

  const traceText = normalizeForTrace(text)
  const dropped = []
  const items = rawItems.map((raw) => {
    const result = cleanItem(raw, traceText)
    dropped.push(...result.dropped)
    return result.item
  }).filter(Boolean)

  if (dropped.length) {
    console.warn(JSON.stringify({ resultCode: 'AI_EVIDENCE_REJECTED', fields: [...new Set(dropped)] }))
  }
  // 闲聊或没抽到东西：当成「AI 这条路没结果」，让调用方降级到本地规则/兜底草稿。
  if (!items.length) fail('AI_UNAVAILABLE', '没有识别出物品和日期')
  if (items.length > MAX_ITEMS) fail('TOO_MANY_DRAFTS', '一次最多生成 5 条草稿，请分次录入')

  // 严格兜底：日期换算、日期角色、保质期都交给已有实现，零新增日期逻辑。
  return normalizeTextResult({ items, parserVersion: PARSER_VERSION }, serverToday)
}

module.exports = { aiParseText, extractJson, normalizeForTrace }
