import type { UserSettings } from '../types/inventory'
import { callCloud } from './cloud-client'

const LEGACY_DEFAULT_STORAGE_ERROR = '默认存放位置不正确'

function isLegacySettingsContractError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const failure = error as { code?: unknown; message?: unknown }
  return (
    failure.code === 'INVALID_ARGUMENT' &&
    failure.message === LEGACY_DEFAULT_STORAGE_ERROR
  )
}

export function getSettings(): Promise<UserSettings> {
  return callCloud('settingsApi', { action: 'get' })
}

export async function updateSettings(input: {
  defaultReminderLeadDays: number
}): Promise<UserSettings> {
  try {
    return await callCloud('settingsApi', { action: 'update', data: input })
  } catch (error) {
    if (!isLegacySettingsContractError(error)) throw error

    // 兼容尚未完成部署的旧版云函数；新接口不会常态提交或保存该废弃字段。
    return callCloud('settingsApi', {
      action: 'update',
      data: { ...input, defaultStorageLocation: null },
    })
  }
}
