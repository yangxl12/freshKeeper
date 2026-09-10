'use strict'

// Also shipped in quickEntryApi; scripts/sync-quick-parser.mjs checks both copies.
const MAX_RELATIVE_DAYS = 7300
const MAX_RELATIVE_MONTHS = 240
const QUANTITY_PATTERN = '公斤|千克|毫升|盒|杯|瓶|袋|包|罐|箱|桶|片|粒|份|支|个|件|克|斤|升'
const QUANTITY_UNIT = new RegExp(`(${QUANTITY_PATTERN})$`)
const QUANTITY_HEAD = new RegExp(`[\\d一二两三四五六七八九十]+\\s*(?:${QUANTITY_PATTERN})`)
function todayKey(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
}

function number(value) {
  const text = String(value || '').replace(/\s/g, '').replace(/[兩俩]/g, '二').replace(/〇/g, '零')
  if (/^\d+$/.test(text)) return Number(text)
  const digits = '零一二三四五六七八九'
  const [tens, ones] = text.split('十')
  if (text.includes('十')) {
    const high = tens ? digits.indexOf(tens) : 1
    const low = ones ? digits.indexOf(ones) : 0
    return tens && high < 0 ? -1 : (ones && low < 0 ? -1 : high * 10 + low)
  }
  if (text === '两') return 2
  if (text === '半') return 0.5
  return text.length === 1 ? digits.indexOf(text) : -1
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return year >= 1900 && year <= 2200 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10) : null
}

function shiftDays(today, amount) {
  return new Date(Date.parse(today + 'T00:00:00Z') + amount * 86400000).toISOString().slice(0, 10)
}

function shiftMonths(today, amount) {
  const [year, month, day] = today.split('-').map(Number)
  const index = year * 12 + (month - 1) + amount
  const nextYear = Math.floor(index / 12)
  const nextMonth = ((index % 12) + 12) % 12 + 1
  return validDate(nextYear, nextMonth, Math.min(day, new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate()))
}

function roleAt(text, start, end) {
  const before = text.slice(0, start).split(/[，,；;\n]/).pop()
  const after = text.slice(end).split(/[，,；;\n]/)[0]
  // A label immediately before or after belongs to this date, never the next one.
  // “日/号”先跳过，因为候选可能只匹配到“9月12”，而“日”紧跟在后面。
  const prefix = /((?:距|距离)?(?:到期|过期|失效)(?:日期|日|时间)?|生产日期|生产|制造日期|出厂日期|MFG|有效期至|有效期|EXP)\s*(?:是|为|在)?\s*[:：]?\s*$/i.exec(before)
  const suffix = /^\s*(?:[日号號]\s*)?(?:就|会|要|将)?\s*(到期|过期|失效|生产|出厂)/.exec(after)
  const label = prefix?.[1] || suffix?.[1] || ''
  return /生产|制造|出厂|MFG/i.test(label) ? 'production' : /到期|过期|有效期|失效|EXP/i.test(label) ? 'expiry' : 'unknown'
}

// Both copies of this parser ship to two runtimes, so keep every unit in one place.
// 所有日期/数量规则都以「source 字符串 + 每次新建 RegExp」的形式使用：
// 带 g 标志的正则在多轮 exec/test 之间会保留 lastIndex，复用同一个对象必然出错。
const NUMBER_SOURCE = '\\d+|[零〇一二两兩俩三四五六七八九十]+'
// 裸数字（无“个”）只在后面不是“月…日/号”时才算相对天数，否则会把“9月12日”切成“9月”+“12日”。
const BARE_NUMBER_GUARD = `(?![\\s\\d]{0,2}(?:月份?)?[\\s\\d]{1,2}(?:日|号|號)?\\s*(?:到期|过期|失效|前|以前|之前|生产))`
// 相对时间事实：4天后 / 还有3天 / 半个月后 / 半年后 / 2周后 / 2个月后。
// 只有“个/個”或“半”允许作为年份、月份的裸数字前缀。
const RELATIVE_PREFIX = `(?<!保质期\\s{0,2})(?:还有|還有|还剩|還剩|再过|再過|剩下)?\\s*`
const RELATIVE_TAIL = `\\s*(?:天|日|周|週|星期|礼拜|個月|个月|月|年)\\s*(?:之后|之後|以后|以後|后|後)?`
// 命名组只用于取整段相对时间，避免 RELATIVE_TAIL 里的括号改变捕获组编号。
const RELATIVE_PHRASE = `${RELATIVE_PREFIX}(?<relative>(?:(${NUMBER_SOURCE})\\s*(?:个|個)|(${NUMBER_SOURCE}|半)${BARE_NUMBER_GUARD}\\s*)${RELATIVE_TAIL})`
const MONTH_DAY = `(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*(?:日|号|號)?`
const MONTH_NAME = `(?<!今年|明年|去年)\\s*(${NUMBER_SOURCE})\\s*月(?!\\s*份)`
// 年月日中，年月必须是两位数字，避免把“9月12日”这类只有月日的写法算成完整日期。
const FULL_DATE = '\\s*(\\d{4})\\s*(?:年|[-/.])\\s*(\\d{1,2})\\s*(?:月|[-/.])\\s*(\\d{1,2})\\s*(?:日|号)?'
const NAMED_DATE = '\\s*(今年|明年|去年)\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*(?:日|号)?'

function matchOf(source, text) {
  return new RegExp(source).exec(text)
}

const WEEKDAY_HEAD = '\\s*(?:(下|这|這|本|上)(?:个|個)?\\s*)?(?:周|週|星期|礼拜)\\s*([一二三四五六日天])'
// getUTCDay(): 0 = 周日，1 = 周一，因此周日按 7 计算。
const WEEKDAY_OFFSET = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
const WEEKDAY_NEXT = /下/
const WEEKDAY_LAST = /上/

function weekdayDate(prefix, weekday, today) {
  const parts = today.split('-').map(Number)
  const current = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay() || 7
  const target = WEEKDAY_OFFSET[weekday]
  if (WEEKDAY_NEXT.test(prefix || '')) return shiftDays(today, 7 - current + target)
  if (WEEKDAY_LAST.test(prefix || '')) return shiftDays(today, -7 - current + target)
  let days = target - current
  // 无前缀的“周三”按最近一次尚未发生的周三处理；“这周/本周”严格落在本周。
  if (!/[这這本]/.test(prefix || '') && days < 0) days += 7
  return shiftDays(today, days)
}

const RELATIVE_AMOUNT_HEAD = `^\\s*(${NUMBER_SOURCE}|半)`

function relativePhrase(rawText, today) {
  const weekday = matchOf(`^${WEEKDAY_HEAD}`, rawText)
  if (weekday) return weekdayDate(weekday[1], weekday[2], today)
  const parsed = matchOf(`^${RELATIVE_PHRASE}`, rawText)
  if (!parsed) return null
  const relative = parsed.groups.relative
  const amount = number(matchOf(RELATIVE_AMOUNT_HEAD, relative)?.[1])
  if (!(amount > 0)) return null
  // 先看“半”再看单位：“半个月”是 15 天，“半年”是 6 个月。
  const half = /^半/.test(relative)
  const hasMonth = /月/.test(relative)
  const hasYear = /年/.test(relative)
  const hasWeek = /周|週|星期|礼拜/.test(relative)
  if (hasYear && !hasMonth) {
    const months = half ? 6 : amount * 12
    return months > MAX_RELATIVE_MONTHS ? null : shiftMonths(today, months)
  }
  if (hasMonth) {
    if (half) {
      const parts = today.split('-').map(Number)
      return shiftDays(today, Math.floor(new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate() / 2))
    }
    if (!Number.isInteger(amount) || amount > MAX_RELATIVE_MONTHS) return null
    return shiftMonths(today, amount)
  }
  const days = hasWeek ? amount * 7 : amount
  if (days > MAX_RELATIVE_DAYS || !Number.isInteger(days)) return null
  return shiftDays(today, days)
}

function extractDates(text, today = todayKey(), source = 'text') {
  // Order matters: 年月日 first, then 月日/裸月份, and only then the relative phrase.
  // 否则“9月12日”会被裸数字相对天数规则切成“9月”+“12日”。
  const pattern = new RegExp(
    `\\s*(?:${FULL_DATE}|${NAMED_DATE}|\\d{4}\\s*年\\s*\\d{1,2}\\s*月|${WEEKDAY_HEAD}|${MONTH_DAY}|${MONTH_NAME}|${RELATIVE_PHRASE}|今天|明天|后天)`,
    'g',
  )
  return [...text.matchAll(pattern)].map((match) => {
    const rawText = match[0].trim()
    const role = roleAt(text, match.index, match.index + match[0].length)
    let date = null
    const full = matchOf(`^${FULL_DATE}`, rawText)
    const named = matchOf(`^${NAMED_DATE}`, rawText)
    const md = matchOf(`^${MONTH_DAY}`, rawText) || matchOf(`^${MONTH_NAME}`, rawText)
    if (full) date = validDate(+full[1], +full[2], +full[3])
    else if (named) date = validDate(+today.slice(0, 4) + ({ 今年: 0, 明年: 1, 去年: -1 })[named[1]], +named[2], +named[3])
    else if (md && (role === 'expiry' || role === 'unknown')) {
      // A candidate only; assigning its meaning remains mandatory for `unknown`.
      date = nearestMonthDay(today, +md[1], +md[2])
    } else if (rawText === '今天' || rawText === '明天' || rawText === '后天') {
      if (role !== 'unknown') date = shiftDays(today, ({ 今天: 0, 明天: 1, 后天: 2 })[rawText])
    } else if (role !== 'unknown' && !md) {
      date = relativePhrase(rawText, today)
    }
    return { date, role, rawText, complete: Boolean(date), source }
  }).filter(candidate => candidate.date || /年|月|周|週|星期|礼拜|\d{4}/.test(candidate.rawText))
}

function nearestMonthDay(today, month, day) {
  for (let year = +today.slice(0, 4); year <= +today.slice(0, 4) + 8; year++) {
    const candidate = validDate(year, month, day)
    if (candidate && candidate >= today) return candidate
  }
  return null
}

const SHELF_LIFE_PATTERN = /保质期\s*[:：]?\s*(\d+|[零〇一二两兩俩三四五六七八九十]+|半)\s*(天|日|周|週|星期|礼拜|个月|個月|月|年)/

function shelfLifePattern() {
  return new RegExp(SHELF_LIFE_PATTERN.source, 'g')
}

function shelfLife(text) {
  const match = SHELF_LIFE_PATTERN.exec(text)
  if (!match) return {}
  const value = number(match[1])
  if (!(value > 0)) return {}
  if (match[1] === '半') {
    if (/年/.test(match[2])) return { shelfLifeValue: 6, shelfLifeUnit: 'month' }
    if (/月/.test(match[2])) return { shelfLifeValue: 15, shelfLifeUnit: 'day' }
    return {}
  }
  if (/年/.test(match[2])) return { shelfLifeValue: value, shelfLifeUnit: 'year' }
  if (/月/.test(match[2])) return { shelfLifeValue: value, shelfLifeUnit: 'month' }
  if (/天|日/.test(match[2])) return { shelfLifeValue: value, shelfLifeUnit: 'day' }
  return Number.isInteger(value) ? { shelfLifeValue: value * 7, shelfLifeUnit: 'day' } : {}
}

// 物品名不包含数字，也不包含保质期/生产日期/到期/存放等字段关键词——否则“保质期6个月”会被当成物品名。
const ITEM_NAME = '[^，,；;\\d保质期生产日期到期过期失效存放位置分类类别放到放在]{1,12}'
// 数量单位在名称前（“2盒牛奶”）或名称后（“牛奶2盒”）都要认，否则“牛奶2盒…和酸奶4杯…”拆不开。
const ITEM_START = `\\s*${ITEM_NAME}\\s*(?:[\\d一二两三四五六七八九十]+\\s*(?:${QUANTITY_PATTERN}))?`
const ITEM_START_REVERSED = `\\s*[\\d一二两三四五六七八九十]+\\s*(?:${QUANTITY_PATTERN})\\s*${ITEM_NAME}`
const ITEM_WITH_QUANTITY = `(?:\\s*${ITEM_NAME}\\s*[\\d一二两三四五六七八九十]+\\s*(?:${QUANTITY_PATTERN})|${ITEM_START_REVERSED})`

function splitEntries(normalized) {
  const item = `(?:${ITEM_START}|${ITEM_START_REVERSED})`
  // “还有两周”是日期，不是下一件物品；连接词后必须明确出现数量单位才拆分。
  const connector = `(?:然后|然後|还有|還有|以及|加上|和)(?=${ITEM_WITH_QUANTITY})`
  // 只有“后面确实是下一件物品”时才分句，避免把一句话拆成多条草稿。
  const softSplitter = new RegExp(`${connector}|[，,、](?=${item})`)
  const entries = []
  // 换行和分号是用户明确的分隔，先按它们切分并校验上限，只在同一段内做合并。
  for (const part of normalized.split(/[\n；;]+/).map(value => value.trim()).filter(Boolean)) {
    const segments = part.split(softSplitter).map(value => value.trim()).filter(Boolean)
    const merged = []
    for (const segment of segments) {
      // 只有“补充同一件物品的信息”才并回上一条：
      // "瓜子一包，2周后过期，放客厅柜子" 是一条，而 "牛奶2盒…，酸奶4杯…" 里第二段自带数量单位，属于新物品。
      const hasOwnQuantity = QUANTITY_HEAD.test(segment)
      if (merged.length && !hasOwnQuantity) merged[merged.length - 1] += `，${segment}`
      else merged.push(segment)
    }
    entries.push(...merged)
  }
  return entries
}

// 识别出的非名称片段统一替换成占位符，最后再折叠空白：
// 直接替换成空格会把相邻字符一起吃掉（例如“9月1日保质期7天”）。
const NAME_GAP = '\u2063'
const NAME_GAP_PATTERN = /\u2063/g
const NAME_SEPARATOR = /[，,。.!！?？、：:]/g

// 时间表达式：4天后 / 还有3天 / 半个月后 / 半年后 / 2周后 / 2个月后 / 下周三。
// 年份和月份要求带“个/半”或只有 1-3 位数字，避免把“2026年9月14号”拆成“2026年”+“9月”。
const NAME_TIME = new RegExp(
  `(?:还有|還剩|再过|再過|剩下)?\\s*(?:\\d{1,3}(?:\\.\\d+)?|[一二两三四五六七八九十]+|半)\\s*(?:个|個)?\\s*(?:天|日|周|週|星期|礼拜|个月|個月|月|年)\\s*(?:之后|之後|以后|以後|后|後)?`
  // “下周三”可能整体成为一个候选，也可能被拆成“周三”候选 + 前缀字，这里只清理孤立的前缀字。
  + `|(?:下周|下週|下个|下個|这周|這週|本周|本週|这个|這個|上周|上週|上个|上個)\\s*(?![\\d一二两三四五六七八九十])`,
  'g',
)
// “下周三”被替换后只剩“下”这种单字前缀，且必须跟在被替换掉的位置前后。
const NAME_WEEKDAY = /(?:(?:下|这|這|本|上)(?:个|個)?\s*)?(?:周|週|星期|礼拜)\s*[一二三四五六日天]/g
const NAME_LABEL = /(?:(?:距|距离)?(?:到期|过期|失效)(?:日期|日|时间)?|生产日期|制造日期|出厂日期|有效期至|有效期|生产|EXP|MFG)\s*(?:是|为|在)?/gi
const NAME_OPENED_PERIOD = /(?:能|可|可以)(?:放|保存)\s*[\d一二两三四五六七八九十]+\s*(?:个|個)?\s*(?:天|日|周|週|星期|礼拜|个月|個月|月|年)(?:后|後|以后|以後)?(?:就|会|要|将)?(?:到期|过期|失效)?/g
const NAME_REMINDER = /提前\s*[\d一二两三四五六七八九十]+\s*天提醒|提醒[^，,；;。]*/g
const NAME_PREFIX = /^(?:新增|添加|录入|买了?|这[个個盒包袋瓶罐箱])/
const NAME_NOISE = /请问|天气|你好|为什么|怎么办|帮我|谢谢/
// 数量单位残片（“瓜子一包”漏掉数字后剩下的“包”）不能留在名称里。
const NAME_UNIT_TAIL = new RegExp(`^[\\d一二两三四五六七八九十]*\\s*(?:${QUANTITY_PATTERN})$`)

function cleanName(entry, dateCandidates, quantity, storage, category) {
  // 顺序很重要：先把完整候选/字段短语整段替换掉，再用通用时间规则兜底。
  // 反过来会把“2026年9月14号”拆成“2026年”+“9月”，留下“14号”残片。
  let name = entry
    .replace(shelfLifePattern(), NAME_GAP)
    .replace(NAME_OPENED_PERIOD, NAME_GAP)
    .replace(NAME_REMINDER, NAME_GAP)
  for (const candidate of dateCandidates) name = name.replace(candidate.rawText, NAME_GAP)
  name = name
    .replace(NAME_WEEKDAY, NAME_GAP)
  if (quantity) name = name.replace(quantity[0], NAME_GAP)
  if (storage) name = name.replace(storage[0], NAME_GAP)
  if (category) name = name.replace(category[0], NAME_GAP)
  name = name
    .replace(NAME_TIME, NAME_GAP)
    .replace(NAME_LABEL, NAME_GAP)
    .replace(NAME_PREFIX, '')
    .replace(NAME_GAP_PATTERN, ' ')
    .replace(NAME_SEPARATOR, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (NAME_UNIT_TAIL.test(name.replace(/\s/g, ''))) name = ''
  // Conversational/unrelated input is not a product name.
  if (NAME_NOISE.test(name) || name.length > 40 || /^\d+$/.test(name)) name = ''
  return name
}

function parseText(text, today = todayKey()) {
  const normalized = text.trim()
  if (!normalized) throw new Error('请输入要识别的内容')
  if (normalized.length > 500) throw new Error('一次最多识别 500 个字符')
  const entries = splitEntries(normalized)
  if (entries.length > 5) throw new Error('一次最多生成 5 条草稿，请分次录入')
  const items = entries.map(entry => {
    const dateCandidates = extractDates(entry, today)
    const quantity = new RegExp(`([\\d一二两三四五六七八九十]+)\\s*(?:${QUANTITY_PATTERN})`).exec(entry)
    const storage = new RegExp(
      `(?<!能)(?:存放位置|存储位置|位置|存放|放)(?:在|到|为)?\\s*[:：]?\\s*(?!(?:${NUMBER_SOURCE}|半)\\s*(?:个|個)?\\s*(?:天|日|周|週|星期|礼拜|个月|個月|月|年))([^，,；;。]+)`,
    ).exec(entry)
    const category = /(?:分类|类别)\s*[:：为]?\s*(食品|药品|日化|其他)/.exec(entry)
    const shelf = shelfLife(entry)
    return { name: cleanName(entry, dateCandidates, quantity, storage, category),
      quantity: quantity ? number(quantity[1]) : undefined,
      unit: quantity ? QUANTITY_UNIT.exec(quantity[0])?.[1] : undefined,
      ...(category ? { category: ({ 食品: 'food', 药品: 'medicine', 日化: 'household', 其他: 'other' })[category[1]] } : {}),
      storageLocation: storage?.[1]?.trim(), expiryInputMode: shelf.shelfLifeValue ? 'shelf_life' : undefined,
      shelfLifeValue: shelf.shelfLifeValue, shelfLifeUnit: shelf.shelfLifeUnit, dateCandidates }
  }).filter(item => item.name || item.dateCandidates.length || item.shelfLifeValue)
  if (!items.length) throw new Error('没有识别出物品和日期')
  return { items, serverToday: today, parserVersion: 'rules-v3' }
}

module.exports = { parseText, extractDates, shelfLife, todayKey }
