import { REMINDER_TEMPLATE_ID } from '../config/runtime'
import type { ReminderStatus } from '../types/inventory'
import { track } from '../utils/analytics'
import { callCloud } from './cloud-client'

/** 临期提醒模板在微信侧的授权状态，对应 subscriptionsSetting.itemSettings[模板 ID]。 */
export type ReminderTemplateSetting = 'accept' | 'reject' | 'ban' | null

/** 「提醒授权」状态；开关只看 authorized，文案看 summary。 */
export type ReminderAuthorizationState =
  | 'authorized'
  | 'main-switch-off'
  | 'template-rejected'
  | 'unrequested'

export interface ReminderAuthorization {
  /** 是否可用于发送提醒。 */
  authorized: boolean
  state: ReminderAuthorizationState
  /** 订阅消息总开关；null 表示微信没下发该字段（用户从未授权过）。 */
  mainSwitch: boolean | null
  /** 临期提醒模板的授权；null 表示微信没记录该模板（用户没勾过「总是保持以上选择」）。 */
  templateSetting: ReminderTemplateSetting
  /** 可直接展示给用户的一句话说明。 */
  summary: string
}

const AUTHORIZATION_SUMMARY: Record<ReminderAuthorizationState, string> = {
  authorized: '已开启，到期前会自动推送',
  'main-switch-off': '微信通知总开关已关闭，收不到提醒',
  'template-rejected': '本小程序的订阅消息已关闭，收不到提醒',
  unrequested: '首次保存物品时会申请一次授权',
}

/**
 * 把微信下发的订阅设置折算成「提醒授权」状态。
 *
 * **只看 mainSwitch 是不够的**：用户在设置里单独关掉「临期提醒」这个模板时，
 * mainSwitch（订阅消息总开关）仍然是 true，只有 itemSettings 里会变成 reject。
 * 反过来，用户没勾过「总是保持以上选择」时 itemSettings 不含该模板，
 * 此时只能依赖 mainSwitch，所以 mainSwitch 必须明确为 true 才算已授权。
 */
export function resolveReminderAuthorization(
  subscriptions?: WechatMiniprogram.SubscriptionsSetting,
): ReminderAuthorization {
  const mainSwitch = subscriptions?.mainSwitch ?? null
  const raw: unknown = REMINDER_TEMPLATE_ID ? subscriptions?.itemSettings?.[REMINDER_TEMPLATE_ID] : undefined
  const templateSetting: ReminderTemplateSetting =
    raw === 'accept' || raw === 'reject' || raw === 'ban' ? raw : null

  let state: ReminderAuthorizationState
  if (mainSwitch === false) state = 'main-switch-off'
  else if (templateSetting === 'reject' || templateSetting === 'ban') state = 'template-rejected'
  else if (mainSwitch === true) state = 'authorized'
  else state = 'unrequested'

  return {
    authorized: state === 'authorized',
    state,
    mainSwitch,
    templateSetting,
    summary: AUTHORIZATION_SUMMARY[state],
  }
}

/** 读取微信订阅消息设置并折算成「提醒授权」；「我的—提醒设置」用它解释「为什么没收到提醒」。 */
export function readReminderAuthorization(): Promise<ReminderAuthorization> {
  return new Promise((resolve) => {
    wx.getSetting({
      withSubscriptions: true,
      success: (result) => resolve(resolveReminderAuthorization(result.subscriptionsSetting)),
      fail: () => resolve(resolveReminderAuthorization(undefined)),
    })
  })
}

/** 模板 ID 还是占位串时视为「未配置」，避免拿着假 ID 去申请授权、只换来一个看不懂的失败提示。 */
export function isReminderTemplateConfigured(): boolean {
  return Boolean(REMINDER_TEMPLATE_ID) && !REMINDER_TEMPLATE_ID.startsWith('TODO_')
}

/** 未配置提示每次启动只弹一次，免得每次保存都糊用户一脸。 */
let configurationPromptShown = false

/**
 * 向用户申请一次性订阅消息授权，返回是否已同意。
 *
 * 微信一次性订阅「一次同意换一条发送额度」，所以这件物品每保存一次就申请一次；
 * 用户勾过「总是保持以上选择」之后微信不再弹窗，直接返回 accept。
 */
export function requestReminderAuthorization(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isReminderTemplateConfigured()) {
      if (!configurationPromptShown) {
        configurationPromptShown = true
        wx.showModal({
          title: '提醒功能尚未配置',
          content: '请先在运行配置中填写微信一次性订阅消息模板 ID。',
          showCancel: false,
        })
      }
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

/**
 * 预约到期提醒。云端返回 `missed` 表示提醒时刻已过、不会再推——
 * 那时不会留下任何提醒任务，详情页据「提醒时间」自行展示「已错过」。
 */
export function armReminder(itemId: string): Promise<{
  status: ReminderStatus | 'missed'
  remindDate: string
}> {
  return callCloud('reminderApi', { action: 'arm', itemId })
}
