type EventData = Record<string, string | number>

/**
 * 事件上报，只走 `wx.reportEvent`（We 分析）。
 *
 * 老接口 `wx.reportAnalytics` 自基础库 2.31.1 起已被官方废弃，而且两套系统的事件互不通用、
 * 得各建一遍后台配置，维护两遍不划算 —— 已砍掉，别再加回来。
 *
 * 微信自定义分析是「先登记后上报」：事件名和字段必须先在 We 分析后台建好，
 * 没登记的事件会被平台静默丢弃（不报错、控制台无输出、日志无痕）。
 * 完整清单见 `docs/analytics-events.md`。
 */
export function track(eventName: string, data: EventData = {}): void {
  if (typeof wx.reportEvent !== 'function') return
  try {
    wx.reportEvent(eventName, data)
  } catch (_error) {
    // 分析能力不可用时静默降级。
  }
}

/**
 * 耗时埋点。
 *
 * 云函数侧早就打了 `durationMs`，前端一直没有，所以「优化前后谁变快了」只能靠体感。
 * 传进起始时间戳，这里统一补 `durationMs` 再上报。
 */
export function trackDuration(
  eventName: string,
  startedAt: number,
  data: EventData = {},
): number {
  // 上报字段一律 snake_case —— We 分析属性 ID 只允许小写字母、数字和下划线。
  const durationMs = Math.max(0, Date.now() - startedAt)
  track(eventName, { ...data, duration_ms: durationMs })
  return durationMs
}
