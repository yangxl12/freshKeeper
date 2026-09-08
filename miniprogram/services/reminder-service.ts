import { REMINDER_TEMPLATE_ID } from '../config/runtime'
import type { ReminderStatus } from '../types/inventory'
import { track } from '../utils/analytics'
import { callCloud } from './cloud-client'

/**
 * 向用户申请一次性订阅消息授权，返回是否已同意。
 * 未配置模板 ID 或用户拒绝时给出与详情页一致的提示。
 */
export function requestReminderAuthorization(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!REMINDER_TEMPLATE_ID) {
      wx.showModal({
        title: '提醒功能尚未配置',
        content: '请先在运行配置中填写微信一次性订阅消息模板 ID。',
        showCancel: false,
      })
      resolve(false)
      return
    }

    wx.requestSubscribeMessage({
      tmplIds: [REMINDER_TEMPLATE_ID],
      success: (result) => {
        const status = result[REMINDER_TEMPLATE_ID]
        track('reminder_request_result', { result: status || 'unknown' })
        if (status === 'accept') {
          resolve(true)
          return
        }
        wx.showToast({ title: '提醒未开启', icon: 'none' })
        resolve(false)
      },
      fail: () => {
        track('reminder_request_result', { result: 'failed' })
        wx.showToast({ title: '提醒未开启，可稍后再试', icon: 'none' })
        resolve(false)
      },
    })
  })
}

export function armReminder(itemId: string): Promise<{
  status: ReminderStatus
  remindDate: string
}> {
  return callCloud('reminderApi', { action: 'arm', itemId })
}

export function cancelReminder(itemId: string): Promise<{ status: ReminderStatus }> {
  return callCloud('reminderApi', { action: 'cancel', itemId })
}
