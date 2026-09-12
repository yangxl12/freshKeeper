import { addDays, parseDateKey } from '../utils/date-key'

/**
 * 到期提醒统一在北京时间 09:30 推送。
 *
 * 这里的时间必须与云函数 `dispatchReminders/config.json` 的定时触发器保持一致，
 * 否则前端写着「9 月 9 日 09:30」、云端却在别的时刻发，用户对不上账。
 */
export const REMINDER_HOUR = 9
export const REMINDER_MINUTE = 30
export const REMINDER_LEAD_DAYS_MIN = 0
export const REMINDER_LEAD_DAYS_MAX = 30

export interface ReminderTime {
  /** 提醒发生的日期：到期日往前推 reminderLeadDays 天。 */
  date: string
  /** 可直接展示的串，如「2026年9月9日 09:30」。 */
  text: string
  /**
   * 提醒时刻是否已经过去。**只用于展示**（表单/详情打出「已错过」）。
   *
   * 预约时的拦截一律按 `date < 今天` 的日期口径走，不看时钟：前端拿真实时钟判断会让
   * 行为随运行时刻漂移，而「当天 09:30 是否已过」云端 arm 会再判一次并返回 `missed`。
   */
  missed: boolean
}

export function formatReminderText(date: string): string {
  const parts = parseDateKey(date)
  if (!parts) return ''
  return `${parts.year}年${parts.month}月${parts.day}日 ${String(REMINDER_HOUR).padStart(2, '0')}:${String(
    REMINDER_MINUTE,
  ).padStart(2, '0')}`
}

/** 提醒时刻是否已经过去；按设备本地时区比较，与「今天」的口径一致。 */
export function isReminderMissed(date: string, now: Date = new Date()): boolean {
  const parts = parseDateKey(date)
  if (!parts) return false
  const at = new Date(parts.year, parts.month - 1, parts.day, REMINDER_HOUR, REMINDER_MINUTE, 0, 0)
  return at.getTime() <= now.getTime()
}

/**
 * 由「到期日期 + 提前天数」算出提醒时间。入参不完整或非法时返回 null，
 * 调用方据此回落到「填写到期日期后自动计算」这类占位文案。
 */
export function resolveReminderTime(input: {
  expiryDate: string | null | undefined
  reminderLeadDays: number | null | undefined
  now?: Date
}): ReminderTime | null {
  const { expiryDate } = input
  if (!expiryDate || !parseDateKey(expiryDate)) return null
  // 必须先排掉 null/undefined 再 Number()：Number(null) 是 0，会被当成「到期当天提醒」。
  const raw = input.reminderLeadDays
  if (raw === null || raw === undefined) return null
  const lead = Number(raw)
  if (!Number.isInteger(lead) || lead < REMINDER_LEAD_DAYS_MIN || lead > REMINDER_LEAD_DAYS_MAX) {
    return null
  }
  let date = ''
  try {
    date = addDays(expiryDate, -lead)
  } catch (_error) {
    return null
  }
  if (!date) return null
  return {
    date,
    text: formatReminderText(date),
    missed: isReminderMissed(date, input.now),
  }
}
