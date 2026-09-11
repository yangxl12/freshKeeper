import { describe, expect, it } from 'vitest'

import { REMINDER_TEMPLATE_ID } from '../../miniprogram/config/runtime'
import { resolveReminderAuthorization } from '../../miniprogram/services/reminder-service'

type Subscriptions = NonNullable<Parameters<typeof resolveReminderAuthorization>[0]>

/** mainSwitch 传 unknown：微信在用户从未授权时不下发这个字段，类型上却声明为必填。 */
function makeSubscriptions(mainSwitch: unknown, templateSetting?: string): Subscriptions {
  return {
    mainSwitch,
    itemSettings: templateSetting ? { [REMINDER_TEMPLATE_ID]: templateSetting } : undefined,
  } as Subscriptions
}

describe('reminder authorization', () => {
  it('treats a rejected template as unauthorized even when the main switch stays on', () => {
    // 回归点：用户在设置里单独关掉「临期提醒」模板时，mainSwitch 仍是 true，
    // 只有 itemSettings 会变成 reject。只看 mainSwitch 会误报「通知已开启」。
    const authorization = resolveReminderAuthorization(makeSubscriptions(true, 'reject'))

    expect(authorization.authorized).toBe(false)
    expect(authorization.state).toBe('template-rejected')
    expect(authorization.templateSetting).toBe('reject')
  })

  it('treats a banned template as unauthorized', () => {
    expect(resolveReminderAuthorization(makeSubscriptions(true, 'ban')).authorized).toBe(false)
  })

  it('authorizes when the main switch is on and the template is accepted', () => {
    const authorization = resolveReminderAuthorization(makeSubscriptions(true, 'accept'))

    expect(authorization.authorized).toBe(true)
    expect(authorization.state).toBe('authorized')
  })

  it('authorizes when the template has no record but the main switch is on', () => {
    // 没勾过「总是保持以上选择」时 itemSettings 不含该模板，此时只能依赖 mainSwitch。
    expect(resolveReminderAuthorization(makeSubscriptions(true)).authorized).toBe(true)
  })

  it('reports the main switch first when it is off and the template was rejected too', () => {
    const authorization = resolveReminderAuthorization(makeSubscriptions(false, 'reject'))

    expect(authorization.authorized).toBe(false)
    expect(authorization.state).toBe('main-switch-off')
    expect(authorization.summary).toBe('微信通知总开关已关闭，收不到提醒')
  })

  it('stays unauthorized when wechat never returned the main switch', () => {
    const authorization = resolveReminderAuthorization(makeSubscriptions(undefined))

    expect(authorization.authorized).toBe(false)
    expect(authorization.state).toBe('unrequested')
  })

  it('stays unauthorized when the subscription settings are missing entirely', () => {
    const authorization = resolveReminderAuthorization(undefined)

    expect(authorization.authorized).toBe(false)
    expect(authorization.state).toBe('unrequested')
  })
})
