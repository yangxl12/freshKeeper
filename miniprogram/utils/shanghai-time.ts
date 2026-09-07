const MILLIS_PER_DAY = 86_400_000
const SHANGHAI_OFFSET_MILLIS = 8 * 60 * 60 * 1000

export function millisecondsUntilShanghaiTomorrow(): number {
  const shanghaiNow = Date.now() + SHANGHAI_OFFSET_MILLIS
  const nextDay = (Math.floor(shanghaiNow / MILLIS_PER_DAY) + 1) * MILLIS_PER_DAY
  return nextDay - shanghaiNow + 1000
}
