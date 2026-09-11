import { shanghaiTodayKey } from '../utils/shanghai-time'
import type { DeleteAccountResult, UserProfile, UserTouchResult } from '../types/inventory'
import { callCloud } from './cloud-client'

/**
 * 本地节流标记：值与「上海日期串」相同则跳过上报。
 * 服务端还有一层同日判定，这里只为省掉一次云调用。
 */
const TOUCH_STORAGE_KEY = 'user_touch_date'

export function touchUser(): Promise<UserTouchResult> {
  return callCloud('userApi', { action: 'touch' })
}

export function getUserProfile(): Promise<UserProfile> {
  return callCloud('userApi', { action: 'get' })
}

export function deleteAccount(): Promise<DeleteAccountResult> {
  return callCloud('userApi', { action: 'deleteAccount', data: { confirm: 'DELETE' } })
}

/**
 * 启动时上报一次活跃度：同一天只调一次，失败静默且不写本地标记（下次启动会重试）。
 * 这是埋点，不是核心链路，任何异常都不能阻塞启动。
 */
export function touchUserOnceToday(): void {
  try {
    const today = shanghaiTodayKey()
    if (wx.getStorageSync(TOUCH_STORAGE_KEY) === today) return
    void touchUser()
      .then(() => {
        wx.setStorageSync(TOUCH_STORAGE_KEY, today)
      })
      .catch(() => {})
  } catch (_error) {
    // 忽略：埋点失败不影响使用。
  }
}
