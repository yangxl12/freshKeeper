import { describe, expect, it } from 'vitest'
import {
  formatReminderText,
  isReminderMissed,
  resolveReminderTime,
} from '../../miniprogram/domain/reminder-time'

/**
 * 提醒时间 = 到期日期 - 提前天数，当天 09:30。
 * 这是「物品详情 / 录入表单」与云端 dispatchReminders 共用的同一套口径，
 * 改这里等于同时改三处展示，必须锁死。
 */
describe('提醒时间换算', () => {
  it('到期日往前推提前天数，落在当天 09:30', () => {
    expect(resolveReminderTime({ expiryDate: '2026-09-10', reminderLeadDays: 1 })).toMatchObject({
      date: '2026-09-09',
      text: '2026年9月9日 09:30',
    })
  })

  it('提前 0 天即到期当天 09:30', () => {
    expect(resolveReminderTime({ expiryDate: '2026-09-10', reminderLeadDays: 0 })?.text).toBe(
      '2026年9月10日 09:30',
    )
  })

  it('跨月跨年都要按自然日回退', () => {
    expect(resolveReminderTime({ expiryDate: '2026-03-01', reminderLeadDays: 1 })?.date).toBe('2026-02-28')
    expect(resolveReminderTime({ expiryDate: '2026-01-01', reminderLeadDays: 1 })?.date).toBe('2025-12-31')
  })

  it('闰年 3 月 1 日往前一天是 2 月 29 日', () => {
    expect(resolveReminderTime({ expiryDate: '2028-03-01', reminderLeadDays: 1 })?.date).toBe('2028-02-29')
  })

  it('入参不完整或非法时返回 null，不编造时间', () => {
    expect(resolveReminderTime({ expiryDate: null, reminderLeadDays: 1 })).toBeNull()
    expect(resolveReminderTime({ expiryDate: '2026-09-10', reminderLeadDays: null })).toBeNull()
    expect(resolveReminderTime({ expiryDate: 'bad', reminderLeadDays: 1 })).toBeNull()
    expect(resolveReminderTime({ expiryDate: '2026-09-10', reminderLeadDays: -1 })).toBeNull()
    expect(resolveReminderTime({ expiryDate: '2026-09-10', reminderLeadDays: 31 })).toBeNull()
  })

  it('提前天数写到最后一天也不算错过', () => {
    const now = new Date(2026, 8, 30, 9, 29, 59)
    expect(isReminderMissed('2026-09-30', now)).toBe(false)
    expect(isReminderMissed('2026-09-30', new Date(2026, 8, 30, 9, 30, 0))).toBe(true)
    expect(isReminderMissed('2026-09-30', new Date(2026, 8, 30, 12, 0, 0))).toBe(true)
    expect(isReminderMissed('2026-09-29', now)).toBe(true)
    expect(isReminderMissed('2026-10-01', now)).toBe(false)
  })

  it('非法日期不算错过，交给上层按空值处理', () => {
    expect(isReminderMissed('bad', new Date(2030, 0, 1))).toBe(false)
  })

  it('格式化对非法输入返回空串', () => {
    expect(formatReminderText('2026-09-09')).toBe('2026年9月9日 09:30')
    expect(formatReminderText('bad')).toBe('')
  })
})
