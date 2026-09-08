import { CLOUD_ENV_ID } from './config/runtime'

App<IAppOption>({
  globalData: {
    pendingQuickFormDraft: null,
    pendingInventoryIntent: null,
    pendingBatchIntent: null,
  },
  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请升级微信后重新打开保质期助手。',
        showCancel: false,
      })
      return
    }

    wx.cloud.init({
      env: CLOUD_ENV_ID || undefined,
      traceUser: true,
    })
  },
  onShow() {
    try {
      wx.reportAnalytics('app_open', {})
    } catch (_error) {
      // 埋点失败不能阻塞核心流程。
    }
  },
})
