import { CLOUD_ENV_ID } from './config/runtime'
import { touchUserOnceToday } from './services/user-service'

App<IAppOption>({
  globalData: {
    pendingInventoryIntent: null,
    pendingBatchIntent: null,
    pendingHomeSortIntent: null,
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

    // 用户活跃埋点：同一天只调一次，失败静默。只放 onLaunch——
    // onShow 会因为频繁前后台切换被反复触发。
    touchUserOnceToday()
  },
  onShow() {
    try {
      wx.reportAnalytics('app_open', {})
    } catch (_error) {
      // 埋点失败不能阻塞核心流程。
    }
  },
})
