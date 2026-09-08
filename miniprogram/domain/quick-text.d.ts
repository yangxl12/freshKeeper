import type { DateCandidate, QuickEntryParseResult } from '../types/quick-entry'
export function parseText(text: string, today?: string): QuickEntryParseResult
export function todayKey(now?: Date): string
export function extractDates(text: string, today?: string, source?: 'text' | 'photo'): DateCandidate[]
