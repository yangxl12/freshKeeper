import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDraftFromParsed, parseQuickTextLocally } from '../../miniprogram/domain/quick-entry'

import { CloudServiceError } from '../../miniprogram/services/cloud-client'

const { getQuickEntryCapabilitiesMock, getSettingsMock, listRecentProfilesMock, parseMock, photoMock, uploadMock, saveMock } = vi.hoisted(() => ({
  getQuickEntryCapabilitiesMock: vi.fn(),
  getSettingsMock: vi.fn(),
  listRecentProfilesMock: vi.fn(),
  parseMock: vi.fn(), photoMock: vi.fn(), uploadMock: vi.fn(), saveMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/quick-entry-service', () => ({
  getQuickEntryCapabilities: getQuickEntryCapabilitiesMock,
  listRecentProfiles: listRecentProfilesMock,
  parseQuickText: parseMock, recognizeDatePhoto: photoMock, uploadQuickEntryMedia: uploadMock,
  removeMedia: vi.fn(),
}))
vi.mock('../../miniprogram/services/inventory-service', () => ({ saveItem: saveMock }))

vi.mock('../../miniprogram/services/settings-service', () => ({
  getSettings: getSettingsMock,
}))

const originalPage = globalThis.Page
let quickEntryPage: Record<string, unknown>
const originalWx = globalThis.wx
beforeEach(() => {
  vi.clearAllMocks()
  globalThis.wx = { setNavigationBarTitle: vi.fn(), pageScrollTo: vi.fn(), enableAlertBeforeUnload: vi.fn(), disableAlertBeforeUnload: vi.fn(), showToast: vi.fn(), navigateBack: vi.fn(), navigateTo: vi.fn(), reportAnalytics: vi.fn() } as never
})

beforeAll(async () => {
  globalThis.Page = ((definition: Record<string, unknown>) => {
    quickEntryPage = definition
  }) as never
  await import('../../miniprogram/pages/quick-entry/index')
})

afterAll(() => {
  globalThis.Page = originalPage
  globalThis.wx = originalWx
})

function pageInstance() {
  const page: any = { ...quickEntryPage, data: structuredClone(quickEntryPage.data) }
  page.setData = (patch: object, callback?: () => void) => { Object.assign(page.data, patch); callback?.() }
  return page
}
function completeDraft(name: string) {
  return createDraftFromParsed(parseQuickTextLocally(`${name}明天到期`, '2026-09-08').items[0], 'text')
}

describe('quick entry page compatibility', () => {
  it('ignores a late parse response after recognition cancellation', async () => {
    const page = pageInstance()
    page.data.inputText = '牛奶明天到期'
    let resolve!: (value: unknown) => void
    parseMock.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = page.generateDrafts()
    page.cancelRecognition()
    resolve(parseQuickTextLocally(page.data.inputText, '2026-09-08'))
    await pending
    expect(page.data.drafts).toHaveLength(0)
    expect(page.data.inputText).toBe('牛奶明天到期')
  })
  it('applies photo results to the chosen draft without replacing neighbours', async () => {
    const page = pageInstance()
    const first = completeDraft('牛奶')
    const second = completeDraft('酸奶')
    page.data.drafts = [first, second]
    page.data.photoTargetId = second.draftId
    page.data.photoPreview = '/tmp/date.jpg'
    uploadMock.mockResolvedValueOnce('cloud://temporary')
    photoMock.mockResolvedValueOnce({ candidates: [{ date: '2027-01-01', role: 'expiry', complete: true, rawText: 'EXP 2027-01-01', source: 'photo' }] })
    await page.recognizePhoto()
    expect(page.data.drafts[0]).toEqual(first)
    expect(page.data.drafts[1].draftId).toBe(second.draftId)
    expect(page.data.drafts[1].fields.expiryDate).toBe('2027-01-01')
  })
  it('keeps the same photo preview when recognition fails', async () => {
    const page = pageInstance()
    page.data.photoPreview = '/tmp/date.jpg'
    page.data.photoStage = 'preview'
    uploadMock.mockResolvedValueOnce('cloud://temporary')
    photoMock.mockRejectedValueOnce(new Error('识别超时'))
    await page.recognizePhoto()
    expect(page.data.photoPreview).toBe('/tmp/date.jpg')
    expect(page.data.photoStage).toBe('preview')
    expect(page.data.inputError).toBe('识别超时')
  })
  it('retries only a failed record with its original payload and key', async () => {
    const page = pageInstance()
    page.commitDrafts([completeDraft('牛奶'), completeDraft('酸奶')])
    const key = page.data.drafts[1].saveKey
    saveMock.mockResolvedValueOnce({ itemId: 'first' }).mockRejectedValueOnce(new Error('network'))
    await page.saveDrafts()
    expect(page.data.drafts.map((draft: any) => draft.status)).toEqual(['saved', 'failed'])
    expect(page.data.selectableCount).toBe(0)
    const submitted = page.data.drafts[1].submittedInput
    page.updateDraft(1, (draft: any) => ({ ...draft, fields: { ...draft.fields, name: 'changed' } }))
    expect(page.data.drafts[1].fields.name).toBe('酸奶')
    saveMock.mockResolvedValueOnce({ itemId: 'second' })
    await page.persistDrafts([{ draft: page.data.drafts[1], index: 1 }])
    expect(saveMock).toHaveBeenCalledTimes(3)
    expect(saveMock).toHaveBeenLastCalledWith(submitted, { idempotencyKey: key })
  })
  it('does not include incomplete or deselected drafts in a batch', async () => {
    const page = pageInstance()
    const incomplete = completeDraft('牛奶')
    incomplete.fields.expiryDate = null
    incomplete.issues = [{ code: 'MISSING_EXPIRY', message: '补日期' }]
    incomplete.selected = false
    const skipped = completeDraft('酸奶'); skipped.selected = false
    page.commitDrafts([incomplete, skipped, completeDraft('面包')])
    saveMock.mockResolvedValueOnce({ itemId: 'bread' })
    await page.saveDrafts()
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(page.data.drafts).toHaveLength(3)
    expect(page.data.drafts[2].status).toBe('saved')
    expect(wx.navigateBack).not.toHaveBeenCalled()
  })
  it('manual date correction resolves ambiguity without keeping old production date', () => {
    const page = pageInstance()
    const item = completeDraft('牛奶')
    item.confirmationFields = ['date:0']
    item.dateConflict = '日期有冲突'
    page.commitDrafts([item])
    page.handleDateChange({ currentTarget: { dataset: { index: 0, field: 'expiryDate' } }, detail: { value: '2027-01-01' } })
    expect(page.data.drafts[0].status).toBe('savable')
    expect(page.data.drafts[0].confirmationFields).toEqual([])
  })
  it('pauses the unload prompt during manual handoff and restores it on return', () => {
    const originalApp = globalThis.getApp
    const app = { globalData: { pendingQuickFormDraft: null } }
    globalThis.getApp = (() => app) as never
    try {
      const page = pageInstance()
      page.data.inputText = '原文仍保留'
      page.commitDrafts([completeDraft('牛奶')])
      page.continueManual()
      vi.mocked(wx.enableAlertBeforeUnload).mockClear()
      page.syncUnloadPrompt()
      expect(wx.enableAlertBeforeUnload).not.toHaveBeenCalled()
      expect(wx.disableAlertBeforeUnload).toHaveBeenCalled()
      expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: '/pages/item-form/index?source=quick-entry' }))
      expect(app.globalData.pendingQuickFormDraft).toMatchObject({ name: '牛奶' })
      page.onShow()
      expect(wx.enableAlertBeforeUnload).toHaveBeenLastCalledWith({ message: '放弃本次录入？' })
      expect(page.data.inputText).toBe('原文仍保留')
    } finally { globalThis.getApp = originalApp }
  })
  it('keeps local text entry visible when remote recognition is not configured', async () => {
    listRecentProfilesMock.mockResolvedValueOnce({ items: [] })
    getQuickEntryCapabilitiesMock.mockResolvedValueOnce({ text: false, voice: false, datePhoto: false })
    getSettingsMock.mockResolvedValueOnce({ defaultReminderLeadDays: 2 })
    const setData = vi.fn()
    const openManual = vi.fn()

    await (quickEntryPage.preparePage as () => Promise<void>).call({
      setData,
      openManual,
    })

    expect(openManual).not.toHaveBeenCalled()
    expect(setData).toHaveBeenCalledWith(expect.objectContaining({
      loading: false,
      features: { recent: true, text: true, voice: true, datePhoto: true },
      capabilities: { text: true, voice: false, datePhoto: false },
      defaultReminderLeadDays: 2,
    }))
  })

  it('stays on quick entry and explains when the cloud function is outdated', async () => {
    listRecentProfilesMock.mockRejectedValueOnce(
      new CloudServiceError('INVALID_ACTION', '不支持的库存操作'),
    )
    const setData = vi.fn()
    const openManual = vi.fn()

    await (quickEntryPage.loadRecentProfiles as () => Promise<void>).call({
      setData,
      openManual,
    })

    expect(openManual).not.toHaveBeenCalled()
    expect(setData).toHaveBeenCalledWith({
      loading: false,
      loadingError: '快速录入服务尚未更新，请先使用完整填写',
    })
  })
})
