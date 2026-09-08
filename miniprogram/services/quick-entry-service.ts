import type {
  DateCandidate,
  QuickEntryParseResult,
  RecentItemProfile,
} from '../types/quick-entry'
import { callCloud } from './cloud-client'

export function listRecentProfiles(): Promise<{ items: RecentItemProfile[] }> {
  return callCloud('inventoryApi', { action: 'listRecentProfiles' })
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
  return callCloud<{ candidates: DateCandidate[]; serverToday: string }>('quickEntryApi', {
    action: 'recognizeDatePhoto',
    fileID,
    mediaType,
  })
}
