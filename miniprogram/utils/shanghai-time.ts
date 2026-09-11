import { formatDateKey } from './date-key'

const MILLIS_PER_DAY = 86_400_000
const SHANGHAI_OFFSET_MILLIS = 8 * 60 * 60 * 1000

/** 服务端判定一律按上海日期；客户端拿它做同日节流，别用本地时区。 */
export function shanghaiTodayKey(now = new Date()): string {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MILLIS)
  return formatDateKey({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  })
}

export function millisecondsUntilShanghaiTomorrow(): number {
  const shanghaiNow = Date.now() + SHANGHAI_OFFSET_MILLIS
  const nextDay = (Math.floor(shanghaiNow / MILLIS_PER_DAY) + 1) * MILLIS_PER_DAY
  return nextDay - shanghaiNow + 1000
}
