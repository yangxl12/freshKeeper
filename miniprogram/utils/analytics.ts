export function track(eventName: string, data: Record<string, string | number> = {}): void {
  try {
    wx.reportAnalytics(eventName, data)
  } catch (_error) {
    // 分析能力不可用时静默降级。
  }
}
