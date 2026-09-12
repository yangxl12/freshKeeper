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

// 设置读写已经并进 userApi（原来独立的 settingsApi 只是多一次冷启动）。
export function getSettings(): Promise<UserSettings> {
  return callCloud('userApi', { action: 'getSettings' })
}

export async function updateSettings(input: {
  defaultReminderLeadDays: number
}): Promise<UserSettings> {
  try {
    return await callCloud('userApi', { action: 'updateSettings', data: input })
  } catch (error) {
    if (!isLegacySettingsContractError(error)) throw error

    // 兼容尚未完成部署的旧版云函数；新接口不会常态提交或保存该废弃字段。
    return callCloud('userApi', {
      action: 'updateSettings',
      data: { ...input, defaultStorageLocation: null },
    })
  }
}
