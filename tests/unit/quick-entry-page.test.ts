import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  globalThis.wx = {
    setNavigationBarTitle: vi.fn(),
    pageScrollTo: vi.fn(),
    enableAlertBeforeUnload: vi.fn(),
    disableAlertBeforeUnload: vi.fn(),
    showToast: vi.fn(),
    showLoading: vi.fn(),
    hideLoading: vi.fn(),
    showModal: vi.fn(),
    navigateBack: vi.fn(),
    navigateTo: vi.fn(),
    hideKeyboard: vi.fn(),
    reportAnalytics: vi.fn(),
  } as never
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
  it('focuses the quick text input as soon as the add page is rendered', () => {
    const page = pageInstance()
    expect(page.data.quickInputFocused).toBe(true)
  })

  it('opens and closes the recent list without losing the current text session', () => {
    const page = pageInstance()
    const draft = completeDraft('牛奶')
    page.data.inputText = '牛奶明天到期'
    page.commitDrafts([draft])

    page.openRecentList()
    expect(page.data.quickTab).toBe('recent')
    expect(page.data.quickInputFocused).toBe(false)
    expect(wx.hideKeyboard).toHaveBeenCalled()

    page.closeRecentList()
    expect(page.data.quickTab).toBe('text')
    expect(page.data.inputText).toBe('牛奶明天到期')
    expect(page.data.drafts).toEqual([draft])
  })

  it('replaces the quick-entry subtabs with a recent-entry button and close control', () => {
    const template = readFileSync(resolve(process.cwd(), 'miniprogram/pages/quick-entry/index.wxml'), 'utf8')
    const blockOpenCount = template.match(/<block\b/g)?.length || 0
    const blockCloseCount = template.match(/<\/block>/g)?.length || 0
    expect(blockOpenCount).toBe(blockCloseCount)
    expect(template).not.toContain('class="quick-tabs"')
    expect(template).toContain('class="recent-entry-button"')
    expect(template).toContain('bindtap="openRecentList"')
    expect(template).toContain('class="recent-page__close"')
    expect(template).toContain('bindtap="closeRecentList"')
    expect(template.indexOf('recent-entry-button')).toBeLessThan(template.indexOf('<form'))
    expect(template.indexOf('recent-entry-button')).toBeLessThan(template.indexOf('class="quick-input"'))
  })

  it('generates from the native form value even before the textarea input event arrives', async () => {
    const page = pageInstance()
    const text = '香蕉，2026年9月14号过期，位置 厨房柜子'
    parseMock.mockResolvedValueOnce(parseQuickTextLocally(text, '2026-09-09'))
    await page.handleGenerateSubmit({ detail: { value: { quickText: text } } })
    expect(parseMock).toHaveBeenCalledWith(text)
    // 生成成功后输入框清空，并立即收起输入法，草稿卡片才不会被键盘挡住
    expect(page.data.inputText).toBe('')
    expect(wx.hideKeyboard).toHaveBeenCalled()
    expect(page.data.quickInputFocused).toBe(false)
    expect(page.data.quickKeyboardHeight).toBe(0)
    expect(page.data.drafts[0].fields).toMatchObject({ name: '香蕉', expiryDate: '2026-09-14', storageLocation: '厨房柜子' })
    expect(page.data.selectableCount).toBe(1)
  })

  it('drops the keyboard as soon as generation starts', async () => {
    const page = pageInstance()
    page.data.inputText = '牛奶明天到期'
    parseMock.mockImplementationOnce(() => new Promise(() => {}))
    void page.handleGenerateTap()
    expect(wx.hideKeyboard).toHaveBeenCalled()
    expect(page.data.quickInputFocused).toBe(false)
    page.cancelRecognition()
  })

  it('never auto focuses the name field so the keyboard stays closed', async () => {
    const page = pageInstance()
    page.data.inputText = '请问今天天气怎么样'
    parseMock.mockResolvedValueOnce({ items: [] })
    await page.generateDrafts()
    expect(page.data.drafts).toHaveLength(1)
    expect(page.data.drafts[0].fields.name).toBe('请问今天天气怎么样')
    expect(page.data.nameMissingFlags).toEqual([false])
    expect(page.data.quickInputFocused).toBe(false)
    expect(wx.hideKeyboard).toHaveBeenCalled()
  })

  it('renders a freshness badge and status label on the confirmation card', () => {
    const page = pageInstance()
    page.data.today = '2026-09-08'
    const draft = completeDraft('牛奶')
    draft.fields.expiryDate = '2026-09-18'
    page.commitDrafts([draft])
    expect(page.data.expiryTones[0]).toBe('fresh')
    expect(page.data.expiryBadges[0]).toBe('还剩 10 天')
    expect(page.data.statusLabels[0]).toBe('可入库')
    expect(page.data.sourceLabels[0]).toBe('文字识别')

    draft.fields.expiryDate = '2026-09-05'
    page.commitDrafts([draft])
    expect(page.data.expiryTones[0]).toBe('expired')
    expect(page.data.expiryBadges[0]).toBe('已过期 3 天')
    expect(page.data.expiredFlags[0]).toBe(true)
  })

  it('does not submit stale page text after the native textarea was cleared', async () => {
    const page = pageInstance()
    page.data.inputText = '香蕉明天过期'
    await page.handleGenerateSubmit({ detail: { value: { quickText: '' } } })
    expect(parseMock).not.toHaveBeenCalled()
    expect(page.data.inputError).toBe('请输入物品和日期')
  })

  it('keeps generation alive when the textarea repeats its unchanged value', async () => {
    const page = pageInstance()
    const text = '香蕉，2026年9月14号过期，位置 厨房柜子'
    page.handleQuickTextInput({ detail: { value: text } })
    let resolve!: (value: unknown) => void
    parseMock.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = page.handleGenerateTap()
    page.handleQuickTextInput({ detail: { value: text } })
    resolve(parseQuickTextLocally(text, '2026-09-09'))
    await pending
    expect(page.data.drafts).toHaveLength(1)
    expect(page.data.drafts[0].fields).toMatchObject({ name: '香蕉', expiryDate: '2026-09-14', storageLocation: '厨房柜子' })
    expect(page.data.recognitionState).toBe('idle')
    expect(page.pendingRecognition).toBe(false)
  })

  it('cancels on an actual edit and immediately removes the loading mask', async () => {
    const page = pageInstance()
    page.data.inputText = '香蕉明天过期'
    let resolve!: (value: unknown) => void
    parseMock.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = page.handleGenerateTap()
    page.handleQuickTextInput({ detail: { value: '香蕉后天过期' } })
    expect(page.pendingRecognition).toBe(false)
    expect(wx.hideLoading).toHaveBeenCalled()
    resolve(parseQuickTextLocally('香蕉明天过期', '2026-09-09'))
    await pending
    expect(page.data.drafts).toHaveLength(0)
    expect(page.data.inputText).toBe('香蕉后天过期')
  })

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
  it('switches to the full form tab instead of leaving the page during manual handoff', () => {
    const page = pageInstance()
    const applied: unknown[][] = []
    page.selectComponent = () => ({ applyPrefill: (...args: unknown[]) => applied.push(args) })
    page.data.popup = 'recent'
    page.commitDrafts([completeDraft('牛奶')])
    page.continueManual()
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(page.data.activeTab).toBe('full')
    expect(page.data.fullMounted).toBe(true)
    expect(page.data.popup).toBe('none')
    expect(page.data.drafts).toHaveLength(0)
    expect(applied[0][0]).toMatchObject({ name: '牛奶' })
    vi.mocked(wx.enableAlertBeforeUnload).mockClear()
    page.syncUnloadPrompt()
    expect(wx.enableAlertBeforeUnload).not.toHaveBeenCalled()
  })

  it('always produces a draft so a tapping generate never looks dead', async () => {
    const page = pageInstance()
    page.data.inputText = '请问今天天气怎么样'
    parseMock.mockRejectedValueOnce(new CloudServiceError('CLOUD_CALL_FAILED', '服务暂时不可用'))
    await page.generateDrafts()
    expect(page.data.drafts).toHaveLength(1)
    expect(page.data.drafts[0].fields.name).toBe('请问今天天气怎么样')
    expect(page.data.inputError).toContain('没识别出明确信息')
    expect(page.data.recognitionState).toBe('idle')
  })

  it('recovers when a previous recognition left the page busy', async () => {
    const page = pageInstance()
    page.data.inputText = '牛奶明天到期'
    page.data.recognitionState = 'parsing'
    page.data.voiceState = 'recording'
    parseMock.mockResolvedValueOnce(parseQuickTextLocally(page.data.inputText, '2026-09-08'))
    await page.generateDrafts()
    expect(page.data.drafts).toHaveLength(1)
    expect(page.data.drafts[0].fields.expiryDate).toBe('2026-09-09')
    expect(page.data.recognitionState).toBe('idle')
  })

  it('preserves the text session when opening and closing a recent item', () => {
    const page = pageInstance()
    page.data.inputText = '牛奶明天到期'
    const draft = completeDraft('牛奶')
    page.commitDrafts([draft])
    page.openRecentList()
    page.data.recentProfiles = [{ name: '面包', quantity: 1, unit: '袋', category: 'food' }]
    page.selectRecent({ currentTarget: { dataset: { index: 0 } } })
    expect(page.data.popup).toBe('recent')
    expect(page.data.drafts).toHaveLength(1)
    expect(page.data.drafts[0].fields.name).toBe('面包')
    page.closePopup()
    page.closeRecentList()
    expect(page.data.popup).toBe('none')
    expect(page.data.inputText).toBe('牛奶明天到期')
    expect(page.data.drafts).toEqual([draft])
  })

  it('generates through the tap handler and recovers from a cloud request that never completes', async () => {
    vi.useFakeTimers()
    try {
      const page = pageInstance()
      page.handleQuickTextInput({ detail: { value: '牛奶明天到期' } })
      parseMock.mockImplementationOnce(() => new Promise(() => {}))
      const pending = page.handleGenerateTap()
      expect(page.data.recognitionState).toBe('parsing')
      await vi.advanceTimersByTimeAsync(8000)
      await pending
      expect(page.data.drafts[0].fields.name).toBe('牛奶')
      expect(page.data.selectableCount).toBe(1)
      expect(page.data.recognitionState).toBe('idle')
      expect(page.pendingRecognition).toBe(false)
      expect(wx.hideLoading).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows feedback when generate is tapped with only whitespace', async () => {
    const page = pageInstance()
    page.data.inputText = '  '
    await page.handleGenerateTap()
    expect(page.data.inputError).toBe('请输入物品和日期')
    expect(parseMock).not.toHaveBeenCalled()
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
      features: { recent: true, text: true, voice: false, datePhoto: false, aiParse: true },
      capabilities: { text: true, voice: false, datePhoto: false, aiText: false },
      defaultReminderLeadDays: 2,
    }))
  })

  it('hides the voice and photo entries so no unavailable hints are shown', async () => {
    listRecentProfilesMock.mockResolvedValueOnce({ items: [] })
    getQuickEntryCapabilitiesMock.mockResolvedValueOnce({ text: true, voice: false, datePhoto: false, aiText: true })
    getSettingsMock.mockResolvedValueOnce({ defaultReminderLeadDays: 1 })
    const setData = vi.fn()

    await (quickEntryPage.preparePage as () => Promise<void>).call({ setData })

    expect(setData).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: { text: true, voice: false, datePhoto: false, aiText: true },
      unavailableHints: [],
    }))
  })

  it('keeps the unavailable hints silent when the capability probe fails and the entries are hidden', async () => {
    listRecentProfilesMock.mockResolvedValueOnce({ items: [] })
    getQuickEntryCapabilitiesMock.mockRejectedValueOnce(new CloudServiceError('CLOUD_CALL_FAILED', '网络异常'))
    getSettingsMock.mockResolvedValueOnce({ defaultReminderLeadDays: 1 })
    const setData = vi.fn()

    await (quickEntryPage.preparePage as () => Promise<void>).call({ setData })

    expect(setData).toHaveBeenCalledWith(expect.objectContaining({
      unavailableHints: [],
    }))
  })

  it('keeps the voice and photo controls visibly disabled while the capability is missing', () => {
    const template = readFileSync(resolve(process.cwd(), 'miniprogram/pages/quick-entry/index.wxml'), 'utf8')
    // 按钮不能「看着能点、点了没反应」：置灰必须绑到云端能力，说明文字必须有一处渲染。
    expect(template).toContain(`disabled="{{saving || recognitionState !== 'idle' || !capabilities.voice}}"`)
    expect(template).toContain(`disabled="{{saving || recognitionState !== 'idle' || !capabilities.datePhoto}}"`)
    expect(template).toContain("features.datePhoto && capabilities.datePhoto && draft.status !== 'saving'")
    expect(template).toContain('wx:for="{{unavailableHints}}"')
  })

  it('keeps the voice entry mounted but silent when the service is not configured', async () => {
    const page = pageInstance()
    page.data.capabilities.voice = false
    await page.startVoice()
    expect(globalThis.wx.showToast).not.toHaveBeenCalled()
    expect(page.data.voiceState).toBe('idle')
    expect(page.data.voicePressing).toBe(false)
    expect(globalThis.wx.reportAnalytics).not.toHaveBeenCalled()
  })

  it('keeps the date photo entry mounted but silent when the service is not configured', () => {
    const page = pageInstance()
    page.data.capabilities.datePhoto = false
    page.chooseDatePhoto()
    expect(globalThis.wx.showToast).not.toHaveBeenCalled()
    expect(page.data.photoStage).toBe('idle')
    expect(page.data.inputError).toBe('')
  })

  it('turns a recent item into a savable draft after picking the expiry date', async () => {
    const page = pageInstance()
    listRecentProfilesMock.mockResolvedValue({ items: [{
      name: '鲜牛奶', quantity: 2, unit: '盒', category: 'food', storageLocation: '冰箱',
      reminderLeadDays: 1, expiryInputMode: 'direct', shelfLifeValue: null, shelfLifeUnit: null, invalidFields: [],
    }] })
    getQuickEntryCapabilitiesMock.mockResolvedValue({ text: true, voice: false, datePhoto: false })
    getSettingsMock.mockResolvedValue({ defaultReminderLeadDays: 1 })

    await page.preparePage()
    expect(page.data.loading).toBe(false)
    expect(page.data.recentProfiles).toHaveLength(1)

    page.selectRecent({ currentTarget: { dataset: { index: 0 } } })
    expect(page.data.popup).toBe('recent')
    expect(page.data.drafts).toHaveLength(1)
    expect(page.data.drafts[0].status).toBe('needs_input')

    page.handleDateChange({ currentTarget: { dataset: { index: 0, field: 'expiryDate' } }, detail: { value: '2026-09-20' } })
    expect(page.data.drafts[0].status).toBe('savable')
    expect(page.data.drafts[0].selected).toBe(true)
    expect(page.data.selectableCount).toBe(1)

    saveMock.mockResolvedValue({ itemId: 'milk' })
    await page.saveDrafts()
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ name: '鲜牛奶', expiryDate: '2026-09-20' }), expect.objectContaining({ idempotencyKey: expect.any(String) }))
    // 全部入库后弹窗关闭、草稿清空，同时刷新最近录入
    expect(page.data.popup).toBe('none')
    expect(page.data.drafts).toHaveLength(0)
    expect(listRecentProfilesMock).toHaveBeenCalledTimes(2)
    // 全部保存成功后自动回首页，让用户看到刚录入的物品
    expect(wx.navigateBack).toHaveBeenCalledTimes(1)
  })

  it('keeps the chosen expiry date when toggling between expiry modes', () => {
    const page = pageInstance()
    const draft = completeDraft('牛奶')
    page.commitDrafts([draft])
    page.handleModeChange({ currentTarget: { dataset: { index: 0, mode: 'shelf_life' } } })
    page.handleModeChange({ currentTarget: { dataset: { index: 0, mode: 'direct' } } })
    expect(page.data.drafts[0].fields.expiryDate).toBe(draft.fields.expiryDate)
    expect(page.data.drafts[0].status).toBe('savable')
  })

  it('keeps the recent list usable and appends drafts instead of replacing them', () => {
    const page = pageInstance()
    const milk = {
      name: '鲜牛奶', quantity: 2, unit: '盒', category: 'food', storageLocation: '冰箱',
      reminderLeadDays: 1, expiryInputMode: 'direct', shelfLifeValue: null, shelfLifeUnit: null, invalidFields: [],
    }
    const yogurt = { ...milk, name: '酸奶', quantity: 1, unit: '瓶', storageLocation: '' }
    page.data.recentProfiles = [milk, yogurt]
    page.selectRecent({ currentTarget: { dataset: { index: 0 } } })
    page.selectRecent({ currentTarget: { dataset: { index: 1 } } })
    expect(page.data.drafts.map((draft: any) => draft.fields.name)).toEqual(['鲜牛奶', '酸奶'])
  })

  it('flags a past expiry date instead of comparing the placeholder text', () => {
    const page = pageInstance()
    const draft = completeDraft('牛奶')
    page.data.today = '2026-09-09'
    page.commitDrafts([draft])
    expect(page.data.expiredFlags).toEqual([false])
    page.handleDateChange({ currentTarget: { dataset: { index: 0, field: 'expiryDate' } }, detail: { value: '2026-09-01' } })
    expect(page.data.expiredFlags).toEqual([true])
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

describe('quick entry AI presentation', () => {
  it('does not arm the patient wording when the cloud reports no aiText', () => {
    const page = pageInstance()
    page.data.capabilities = { ...page.data.capabilities, aiText: false }
    page.startRecognitionTip()
    expect(page.recognitionTipTimer).toBeNull()
  })

  it('switches to a patient wording after three seconds of waiting', () => {
    vi.useFakeTimers()
    try {
      const page = pageInstance()
      page.data.capabilities = { ...page.data.capabilities, aiText: true }
      page.data.recognitionState = 'parsing'
      page.startRecognitionTip()
      expect(page.recognitionTipTimer).not.toBeNull()
      vi.advanceTimersByTime(3000)
      expect(page.data.recognitionTip).toBe('正在仔细识别…')
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks drafts parsed by the model and leaves the local parser unmarked', () => {
    const page = pageInstance()
    const ai = createDraftFromParsed({ name: '牛奶', dateCandidates: [] }, 'text', 1, undefined, undefined, 'ai-v1')
    const local = createDraftFromParsed(parseQuickTextLocally('牛奶明天到期', '2026-09-08').items[0], 'text', 1, undefined, undefined, 'rules-v3')
    page.commitDrafts([ai, local])
    expect(page.data.aiFlags).toEqual([true, false])
  })

  it('hints about the fields the model could not trace back to the source text', () => {
    const page = pageInstance()
    page.commitDrafts([
      createDraftFromParsed({ name: '牛奶', dateCandidates: [] }, 'text', 1, undefined, undefined, 'ai-v1'),
      createDraftFromParsed({ name: '牛奶', quantity: 2, unit: '盒', dateCandidates: [] }, 'text', 1, undefined, undefined, 'ai-v1'),
      createDraftFromParsed({ name: '牛奶', dateCandidates: [] }, 'text', 1, undefined, undefined, 'rules-v3'),
    ])
    expect(page.data.aiMissingHints).toEqual([
      'AI 没在原文里找到数量和单位，已按默认值填上，请核对',
      '',
      '',
    ])
  })

  it('clears the hint once the user edits the field', () => {
    const page = pageInstance()
    const patches: Record<string, unknown>[] = []
    page.setData = (patch: Record<string, unknown>, callback?: () => void) => { patches.push(patch); callback?.() }
    page.data.drafts = [createDraftFromParsed({ name: '牛奶', dateCandidates: [] }, 'text', 1, undefined, undefined, 'ai-v1')]
    page.data.aiMissingHints = ['AI 没在原文里找到数量和单位，已按默认值填上，请核对']

    page.handleTextInput({ currentTarget: { dataset: { index: 0, field: 'quantity' } }, detail: { value: '2' } })

    expect(patches).toContainEqual(expect.objectContaining({
      'drafts[0]': expect.objectContaining({ aiMissingFields: ['unit'] }),
      'aiMissingHints[0]': 'AI 没在原文里找到单位，已按默认值填上，请核对',
    }))
  })
})
