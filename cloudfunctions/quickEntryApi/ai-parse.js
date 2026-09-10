'use strict'

// 编排：调模型 → 提取 JSON → 宽容清洗 → 交给 date-facts 做严格兜底与日期换算。
// 分工（别搞混）：本文件负责「救回能用的字段」，normalizeTextResult 负责「兜住漏网的脏值」。
const { assert, fail } = require('./validation')
const { currentDateKey, normalizeTextResult } = require('./date-facts')
const { buildMessages, buildRepairMessages } = require('./ai-prompt')
const { aiTimeoutMs, createTextGenerator } = require('./ai-client')

const MAX_ITEMS = 5
const MAX_DATE_FACTS = 12
const PARSER_VERSION = 'ai-v1'

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

function cleanDateFact(fact) {
  if (!fact || typeof fact !== 'object') return null
  const rawText = cleanText(fact.rawText, 120) || ''
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

function cleanItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const dateFacts = (Array.isArray(item.dateFacts) ? item.dateFacts : [])
    .slice(0, MAX_DATE_FACTS)
    .map(cleanDateFact)
    .filter(Boolean)
  const clean = {
    name: cleanText(item.name, 40),
    quantity: cleanInteger(item.quantity, 1, 9999),
    unit: cleanText(item.unit, 8),
    category: CATEGORIES.has(item.category) ? item.category : null,
    storageLocation: cleanText(item.storageLocation, 500),
    dateFacts,
  }
  // 名称和日期都没有的候选是噪声，直接丢掉（宽容清洗，不整批失败）。
  if (!clean.name && !dateFacts.length) return null
  return clean
}

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

async function requestBody(text, generate) {
  const first = await generate(buildMessages(text))
  const parsed = extractJson(first && first.text)
  if (parsed) return parsed
  console.warn(JSON.stringify({ resultCode: 'AI_OUTPUT_UNPARSEABLE', attempt: 1 }))
  const second = await generate(buildRepairMessages(text, first && first.text))
  const repaired = extractJson(second && second.text)
  if (repaired) return repaired
  console.warn(JSON.stringify({ resultCode: 'AI_OUTPUT_UNPARSEABLE', attempt: 2 }))
  fail('AI_UNAVAILABLE', '识别服务返回格式不正确，请重试或使用完整填写')
}

/**
 * AI 解析主路径。抛出的错误码统一由调用方决定是否静默降级。
 * @param {{ text: string, serverToday?: string, generate?: Function, timeoutMs?: number }} options
 */
async function aiParseText(options = {}) {
  const text = typeof options.text === 'string' ? options.text.trim() : ''
  assert(text.length >= 1 && text.length <= 500, 'INVALID_ARGUMENT', '请输入要识别的内容')
  const serverToday = options.serverToday || currentDateKey()
  const generate = options.generate || createTextGenerator()
  const limit = Number.isFinite(options.timeoutMs) ? options.timeoutMs : aiTimeoutMs()

  const body = await withTimeout(requestBody(text, generate), limit)
  const rawItems = Array.isArray(body.items) ? body.items : []
  const items = rawItems.map(cleanItem).filter(Boolean)
  // 闲聊或没抽到东西：当成「AI 这条路没结果」，让调用方降级到本地规则/兜底草稿。
  if (!items.length) fail('AI_UNAVAILABLE', '没有识别出物品和日期')
  if (items.length > MAX_ITEMS) fail('TOO_MANY_DRAFTS', '一次最多生成 5 条草稿，请分次录入')

  // 严格兜底：日期换算、日期角色、保质期都交给已有实现，零新增日期逻辑。
  return normalizeTextResult({ items, parserVersion: PARSER_VERSION }, serverToday)
}

module.exports = { aiParseText, extractJson }
