import type { ReminderStatus } from '../types/inventory'
import { callCloud } from './cloud-client'

export function armReminder(itemId: string): Promise<{
  status: ReminderStatus
  remindDate: string
}> {
  return callCloud('reminderApi', { action: 'arm', itemId })
}

export function cancelReminder(itemId: string): Promise<{ status: ReminderStatus }> {
  return callCloud('reminderApi', { action: 'cancel', itemId })
}
