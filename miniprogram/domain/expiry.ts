import type { ExpiryStatus } from '../types/inventory'
import { toDayOrdinal } from '../utils/date-key'

export interface ExpiryPresentation {
  status: ExpiryStatus
  daysLeft: number
  text: string
  groupLabel: string
  tone: 'danger' | 'urgent' | 'warning' | 'safe'
}

export function getExpiryPresentation(
  expiryDate: string,
  today: string,
): ExpiryPresentation {
  const daysLeft = toDayOrdinal(expiryDate) - toDayOrdinal(today)
  if (daysLeft < 0) {
    return {
      status: 'expired',
      daysLeft,
      text: `已过期 ${Math.abs(daysLeft)} 天`,
      groupLabel: '已过期',
      tone: 'danger',
    }
  }
  if (daysLeft === 0) {
    return {
      status: 'due_today',
      daysLeft,
      text: '今天到期',
      groupLabel: '今天到期',
      tone: 'urgent',
    }
  }
  if (daysLeft <= 3) {
    return {
      status: 'due_in_3_days',
      daysLeft,
      text: `还有 ${daysLeft} 天`,
      groupLabel: '3 天内到期',
      tone: 'urgent',
    }
  }
  if (daysLeft <= 7) {
    return {
      status: 'due_in_7_days',
      daysLeft,
      text: `还有 ${daysLeft} 天`,
      groupLabel: '7 天内到期',
      tone: 'warning',
    }
  }
  return {
    status: 'safe',
    daysLeft,
    text: '暂时安全',
    groupLabel: '暂时安全',
    tone: 'safe',
  }
}
