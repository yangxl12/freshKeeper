'use strict'

/**
 * 订阅消息模板「物品保质期到期提醒」的字段映射。
 *
 * 模板要在微信公众平台 → 功能 → 订阅消息 里创建/选用，字段依次是：
 * 物品名称 / 到期日期 / 剩余天数 / 当前数量 / 备注。
 *
 * 以下序号已按当前 AppID 下的正式模板核对，修改模板时必须同步客户端、预约函数和发布检查。
 * 刻意写死在代码里而不是读环境变量：云函数的 envVariables 只在首次创建时写入云端，
 * 之后改 config.json 或重新部署都不会更新，留着旧环境变量反而会盖掉新配置。
 */
const TEMPLATE_FIELDS = {
  name: 'thing7',
  expiryDate: 'time2',
  remainingDays: 'number5',
  quantity: 'number4',
  note: 'thing3',
}

/** thing 类字段上限 20 个字符，超了微信会直接拒发。 */
const THING_MAX_LENGTH = 20

const CATEGORY_LABELS = {
  food: '食品',
  medicine: '药品',
  household: '日化',
  other: '其他',
}

const STORAGE_LABELS = {
  refrigerated: '冷藏',
  frozen: '冷冻',
  cabinet: '橱柜',
  medicine_box: '药箱',
  other: '其他',
}

function truncate(value, maxLength) {
  return Array.from(String(value)).slice(0, maxLength).join('')
}

function formatTemplateDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value))
  if (!match) return String(value)
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`
}

function categoryLabel(value) {
  return CATEGORY_LABELS[value] || '其他'
}

/** 位置可能是库里存的历史英文枚举，也可能是用户手填的自由文本，两种都要能显示。 */
function locationLabel(item) {
  const raw = item.storageLocation
  if (!raw) return '未填写'
  return STORAGE_LABELS[raw] || raw
}

function currentShanghaiDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function dateOrdinal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value))
  if (!match) return null
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000)
}

function remainingDays(item, today = currentShanghaiDateKey()) {
  const expiry = dateOrdinal(item.expiryDate)
  const current = dateOrdinal(today)
  return Math.max(0, expiry === null || current === null ? 0 : expiry - current)
}

function reminderNote(item) {
  return truncate(`${categoryLabel(item.category)} · ${locationLabel(item)}`, THING_MAX_LENGTH)
}

function buildReminderTemplateData(item) {
  return {
    [TEMPLATE_FIELDS.name]: { value: truncate(item.name, THING_MAX_LENGTH) },
    [TEMPLATE_FIELDS.expiryDate]: { value: formatTemplateDate(item.expiryDate) },
    [TEMPLATE_FIELDS.remainingDays]: { value: String(remainingDays(item)) },
    [TEMPLATE_FIELDS.quantity]: { value: String(item.quantity) },
    [TEMPLATE_FIELDS.note]: { value: reminderNote(item) },
  }
}

module.exports = {
  TEMPLATE_FIELDS,
  buildReminderTemplateData,
  categoryLabel,
  formatTemplateDate,
  locationLabel,
  remainingDays,
  reminderNote,
  truncate,
}
