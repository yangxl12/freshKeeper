import type { StorageLocation, UserSettings } from '../types/inventory'
import { callCloud } from './cloud-client'

export function getSettings(): Promise<UserSettings> {
  return callCloud('settingsApi', { action: 'get' })
}

export function updateSettings(input: {
  defaultReminderLeadDays: number
  defaultStorageLocation: StorageLocation | null
}): Promise<UserSettings> {
  return callCloud('settingsApi', { action: 'update', data: input })
}
