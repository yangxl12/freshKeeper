'use strict'

const SHANGHAI_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * 统一按 Asia/Shanghai 取日期串。
 * serverDate 落库后可能是 Date / 时间戳 / ISO 串，前端只做展示，
 * 比较一律在服务端用这个函数归一化后再做。
 */
function shanghaiDateKey(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = SHANGHAI_DATE_FORMAT.formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function currentDateKey(now = new Date()) {
  return shanghaiDateKey(now)
}

/**
 * 今天是否值得再写一次 lastSeenAt。
 * 无记录或值异常都按「需要写入」处理——宁可多写一次，也不要把活跃度记丢。
 */
function shouldTouchToday(lastSeenAt, today) {
  if (!today) return true
  return shanghaiDateKey(lastSeenAt) !== today
}

module.exports = { currentDateKey, shanghaiDateKey, shouldTouchToday }
