'use strict'

// Also shipped in quickEntryApi; scripts/sync-quick-parser.mjs checks both copies.
function todayKey(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
}

function number(value) {
  if (/^\d+$/.test(value)) return Number(value)
  const digits = '零一二三四五六七八九'
  if (value === '两') return 2
  if (value.includes('十')) {
    const [tens, ones] = value.split('十')
    return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0)
  }
  return digits.indexOf(value)
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return year >= 1900 && year <= 2200 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10) : null
}

function roleAt(text, start, end) {
  const before = text.slice(0, start).split(/[，,；;\n]/).pop()
  const after = text.slice(end).split(/[，,；;\n]/)[0]
  // A label immediately before or after belongs to this date, never the next one.
  const prefix = /(生产日期|生产|制造日期|出厂日期|MFG|到期日|到期|有效期至|有效期|失效日期|EXP)\s*[:：]?\s*$/i.exec(before)
  const suffix = /^\s*(到期|过期|失效|生产|出厂)/.exec(after)
  const label = prefix?.[1] || suffix?.[1] || ''
  return /生产|制造|出厂|MFG/i.test(label) ? 'production' : /到期|过期|有效期|失效|EXP/i.test(label) ? 'expiry' : 'unknown'
}

function extractDates(text, today = todayKey(), source = 'text') {
  // Longest alternatives first: incomplete year/month is consumed as a whole.
  const pattern = /(?:\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*(?:日|号)?|(?:今年|明年|去年)\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*(?:日|号))?|\d{4}\s*年\s*\d{1,2}\s*月|\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)?|(?:还有\s*)?[\d一二两三四五六七八九十]+\s*天(?:后)?(?=\s*(?:到期|过期|失效))|今天|明天|后天)/g
  return [...text.matchAll(pattern)].map((match) => {
    const rawText = match[0].trim()
    const role = roleAt(text, match.index, match.index + match[0].length)
    let date = null
    const full = /^(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})/.exec(rawText)
    const named = /^(今年|明年|去年)\s*(\d{1,2})\s*月\s*(\d{1,2})/.exec(rawText)
    const md = /^(\d{1,2})\s*月\s*(\d{1,2})/.exec(rawText)
    if (full) date = validDate(+full[1], +full[2], +full[3])
    else if (named) date = validDate(+today.slice(0, 4) + ({ 今年: 0, 明年: 1, 去年: -1 })[named[1]], +named[2], +named[3])
    else if (md && source === 'text' && role === 'expiry') {
      for (let year = +today.slice(0, 4); year <= +today.slice(0, 4) + 8; year++) {
        const candidate = validDate(year, +md[1], +md[2])
        if (candidate && candidate >= today) { date = candidate; break }
      }
    } else if (md && source === 'text' && role === 'unknown') {
      // A candidate only; assigning its meaning remains mandatory.
      for (let year = +today.slice(0, 4); year <= +today.slice(0, 4) + 8; year++) {
        const candidate = validDate(year, +md[1], +md[2])
        if (candidate && candidate >= today) { date = candidate; break }
      }
    } else if (source === 'text' && role !== 'unknown' && !/年|月/.test(rawText)) {
      const offset = ({ 今天: 0, 明天: 1, 后天: 2 })[rawText] ?? number(rawText.replace(/还有|天后?|\s/g, ''))
      if (offset >= 0 && offset <= 3650) date = new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10)
    }
    return { date, role, rawText, complete: Boolean(date), source }
  }).filter(candidate => candidate.date || /年|月|\d{4}/.test(candidate.rawText))
}

function shelfLife(text) {
  const match = /保质期\s*[:：]?\s*([\d一二两三四五六七八九十]+)\s*(天|日|个月|月|年)/.exec(text)
  return match ? { shelfLifeValue: number(match[1]), shelfLifeUnit: /年/.test(match[2]) ? 'year' : /月/.test(match[2]) ? 'month' : 'day' } : {}
}

function parseText(text, today = todayKey()) {
  const normalized = text.trim()
  if (!normalized) throw new Error('请输入要识别的内容')
  if (normalized.length > 500) throw new Error('一次最多识别 500 个字符')
  const entries = normalized.split(/[\n；;]+|(?:然后|还有|以及|和)(?=\s*[^，,；;\d]{1,20}\s*[\d一二两三四五六七八九十]+\s*(?:盒|杯|瓶|袋|包|个|件))|[，,、](?=\s*[^，,；;\d]{1,20}\s*\d+\s*(?:盒|杯|瓶|袋|包|个|件))/).map(s => s.trim()).filter(Boolean)
  if (entries.length > 5) throw new Error('一次最多生成 5 条草稿，请分次录入')
  const items = entries.map(entry => {
    const dateCandidates = extractDates(entry, today)
    const quantity = /([\d一二两三四五六七八九十]+)\s*(公斤|千克|毫升|盒|杯|瓶|袋|包|罐|个|件|支|箱|片|粒|份|桶|克|斤|升)/.exec(entry)
    const storage = /(?:存放|放)(?:在|到)?\s*([^，,；;。]+)/.exec(entry)
    const category = /(?:分类|类别)\s*[:：为]?\s*(食品|药品|日化|其他)/.exec(entry)
    let name = entry
    for (const candidate of dateCandidates) name = name.replace(candidate.rawText, ' ')
    name = name.replace(/保质期\s*[:：]?\s*[\d一二两三四五六七八九十]+\s*(天|日|个月|月|年)/g, ' ')
      .replace(quantity?.[0] || /$^/, ' ').replace(storage?.[0] || /$^/, ' ').replace(category?.[0] || /$^/, ' ')
      .replace(/(?:提前\s*[\d一二两三四五六七八九十]+\s*天提醒|提醒我.*$)/g, ' ')
      .replace(/(?:生产日期|制造日期|出厂日期|有效期至?|到期日?|过期|失效|生产|EXP|MFG)\s*[:：]?/gi, ' ')
      .replace(/^(?:新增|添加|录入|买了?|这盒)\s*/, '').replace(/能放\s*[\d一二两三四五六七八九十]+\s*天/g, '')
      .replace(/[，,。.!！?？、：:]/g, ' ').replace(/\s+/g, ' ').trim()
    // Conversational/unrelated input is not a product name.
    if (/请问|天气|你好|为什么|怎么办|帮我|谢谢/.test(name) || name.length > 40 || /^\d+$/.test(name)) name = ''
    const shelf = shelfLife(entry)
    return { name, quantity: quantity ? number(quantity[1]) : undefined, unit: quantity?.[2],
      ...(category ? { category: ({ 食品: 'food', 药品: 'medicine', 日化: 'household', 其他: 'other' })[category[1]] } : {}),
      storageLocation: storage?.[1]?.trim(), expiryInputMode: shelf.shelfLifeValue ? 'shelf_life' : undefined,
      shelfLifeValue: shelf.shelfLifeValue, shelfLifeUnit: shelf.shelfLifeUnit, dateCandidates }
  }).filter(item => item.name || item.dateCandidates.length || item.shelfLifeValue)
  if (!items.length) throw new Error('没有识别出物品和日期')
  return { items, serverToday: today, parserVersion: 'rules-v2' }
}

module.exports = { parseText, extractDates, shelfLife, todayKey }
