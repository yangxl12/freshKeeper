import type {
  DatePhotoResult,
  QuickEntryCapabilities,
  QuickEntryParseResult,
  RecentItemProfile,
} from '../types/quick-entry'
import { callCloud } from './cloud-client'

export function listRecentProfiles(): Promise<{ items: RecentItemProfile[] }> {
  return callCloud('inventoryApi', { action: 'listRecentProfiles' })
}

export function getQuickEntryCapabilities(): Promise<QuickEntryCapabilities> {
  return callCloud('quickEntryApi', { action: 'getCapabilities' })
}

export function parseQuickText(text: string): Promise<QuickEntryParseResult> {
  return callCloud('quickEntryApi', { action: 'parseText', text })
}

export function transcribeVoice(fileID: string, mediaType: string) {
  return callCloud<{ text: string; serverToday: string }>('quickEntryApi', {
    action: 'transcribeVoice',
    fileID,
    mediaType,
  })
}

export function recognizeDatePhoto(fileID: string, mediaType: string) {
  return callCloud<DatePhotoResult>('quickEntryApi', {
    action: 'recognizeDatePhoto',
    fileID,
    mediaType,
  })
}


export function uploadQuickEntryMedia(localPath: string, kind: 'audio' | 'image'): Promise<string> {
  const extension = localPath.match(/\.([A-Za-z0-9]+)(?:\?|$)/)?.[1]?.toLowerCase() || (kind === 'audio' ? 'mp3' : 'jpg')
  const random = Math.random().toString(16).slice(2)
  const cloudPath = `quick-entry/${kind}/${Date.now()}-${random}.${extension}`
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath: localPath,
      success: (result) => resolve(result.fileID),
      fail: reject,
    })
  })
}
