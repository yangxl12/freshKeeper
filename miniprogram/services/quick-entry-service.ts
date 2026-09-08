import type {
  DatePhotoResult,
  QuickEntryCapabilities,
  QuickEntryParseResult,
  RecentItemProfile,
} from '../types/quick-entry'
import { parseQuickTextLocally } from '../domain/quick-entry'
import { callCloud, CloudServiceError } from './cloud-client'

const LOCAL_TEXT_FALLBACK_CODES = new Set([
  'AI_UNAVAILABLE',
  'CLOUD_CALL_FAILED',
  'CLOUD_NOT_ENABLED',
  'INVALID_ACTION',
  'INVALID_RESPONSE',
  'QUICK_ENTRY_FAILED',
  'QUICK_ENTRY_TIMEOUT',
])

export function listRecentProfiles(): Promise<{ items: RecentItemProfile[] }> {
  return callCloud('inventoryApi', { action: 'listRecentProfiles' })
}

export function getQuickEntryCapabilities(): Promise<QuickEntryCapabilities> {
  return callCloud('quickEntryApi', { action: 'getCapabilities' })
}

export async function parseQuickText(text: string): Promise<QuickEntryParseResult> {
  try {
    return await callCloud('quickEntryApi', { action: 'parseText', text })
  } catch (error) {
    if (!(error instanceof CloudServiceError) || !LOCAL_TEXT_FALLBACK_CODES.has(error.code)) throw error
    return parseQuickTextLocally(text)
  }
}

export async function transcribeVoice(fileID: string, mediaType: string) {
  try { return await callCloud<{ text: string; serverToday: string }>('quickEntryApi', {
    action: 'transcribeVoice',
    fileID,
    mediaType,
  }) } finally { await removeMedia(fileID) }
}

export async function recognizeDatePhoto(fileID: string, mediaType: string) {
  try { return await callCloud<DatePhotoResult>('quickEntryApi', {
    action: 'recognizeDatePhoto',
    fileID,
    mediaType,
  }) } finally { await removeMedia(fileID) }
}


export async function uploadQuickEntryMedia(localPath: string, kind: 'audio' | 'image'): Promise<string> {
  const { cloudPath } = await callCloud<{ cloudPath: string }>('quickEntryApi', { action: 'createMediaUpload', mediaType: kind })
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath: localPath,
      success: (result) => resolve(result.fileID),
      fail: reject,
    })
  })
}

export async function removeMedia(fileID: string): Promise<void> {
  try { await wx.cloud.deleteFile({ fileList: [fileID] }) } catch (_error) { /* Server also deletes in finally; storage lifecycle is the final fallback. */ }
}
