import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyFormValuesToDraft, createDraftFromParsed, createDraftFromRecent, parseQuickTextLocally, refreshDraftValidation } from '../../miniprogram/domain/quick-entry'

import { CloudServiceError } from '../../miniprogram/services/cloud-client'

const { getQuickEntryCapabilitiesMock, getSettingsMock, listRecentProfilesMock, parseMock, photoMock, uploadMock, saveMock, requestReminderAuthorizationMock, armReminderMock } = vi.hoisted(() => ({
  getQuickEntryCapabilitiesMock: vi.fn(),
  getSettingsMock: vi.fn(),
  listRecentProfilesMock: vi.fn(),
  parseMock: vi.fn(), photoMock: vi.fn(), uploadMock: vi.fn(), saveMock: vi.fn(),
  requestReminderAuthorizationMock: vi.fn(), armReminderMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/quick-entry-service', () => ({
  getQuickEntryCapabilities: getQuickEntryCapabilitiesMock,
  listRecentProfiles: listRecentProfilesMock,
  parseQuickText: parseMock, recognizeDatePhoto: photoMock, uploadQuickEntryMedia: uploadMock,
  removeMedia: vi.fn(),
}))
vi.mock('../../miniprogram/services/inventory-service', () => ({ saveItem: saveMock }))
vi.mock('../../miniprogram/services/reminder-service', () => ({
  requestReminderAuthorization: () => requestReminderAuthorizationMock(),
  armReminder: (...args: unknown[]) => armReminderMock(...(args as [])),
}))

vi.mock('../../miniprogram/services/settings-service', () => ({
  getSettings: getSettingsMock,
}))

const originalPage = globalThis.Page
let quickEntryPage: Record<string, unknown>
const originalWx = globalThis.wx
beforeEach(() => {
  vi.clearAllMocks()
  requestReminderAuthorizationMock.mockResolvedValue(true)
  armReminderMock.mockResolvedValue({ status: 'scheduled', remindDate: '2026-09-09' })
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
/** 把共用的完整录入表单替换成一个记录调用的替身，用来断言「灌进去什么」和「退出要不要拦」。 */
function stubDraftForm(page: any, dirty = false, onSubmit?: () => void) {
  const applied: unknown[][] = []
  page.selectComponent = (selector: string) => selector === '#draftForm'
    ? {
        applyPrefill: (...args: unknown[]) => applied.push(args),
        isDirty: () => dirty,
        save: () => { onSubmit?.() },
      }
    : null
  return applied
}

describe('quick entry page compatibility', () => {
  it('focuses the quick text input as soon as the add page is rendered', () => {
    const page = pageInstance()
    expect(page.data.quickInputFocused).toBe(true)
  })

  it('hands the recent list off to its own page with the remaining draft slots', () => {
    const page = pageInstance()
    const draft = completeDraft('牛奶')
    page.data.inputText = '牛奶明天到期'
    page.commitDrafts([draft])

    page.openRecentEntry()

    // 不再整块换视图：只是跳页，本页的文字会话原样留着
    expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({
      url: '/pages/recent-entry/index?slots=19',
      events: expect.objectContaining({ pickedDrafts: expect.any(Function) }),
    }))
    expect(page.data.quickInputFocused).toBe(false)
    expect(wx.hideKeyboard).toHaveBeenCalled()
    expect(page.data.inputText).toBe('牛奶明天到期')
    expect(page.data.drafts).toEqual([draft])
  })

  it('refuses to open the recent page when the draft slots are used up', () => {
    const page = pageInstance()
    page.commitDrafts(Array.from({ length: 20 }, (_, index) => completeDraft(`物品${index}`)))
    page.openRecentEntry()
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(page.data.inputError).toContain('20')
  })

  it('appends the drafts handed back by the recent page and caps them at the limit', () => {
    const page = pageInstance()
    const existing = completeDraft('牛奶')
    page.commitDrafts([existing])
    page.appendRecentDrafts([completeDraft('面包'), completeDraft('酸奶')])
    expect(page.data.drafts.map((draft: any) => draft.fields.name)).toEqual(['面包', '酸奶', '牛奶'])
    expect(page.data.selectableCount).toBe(3)

    // 带回来的条数超过剩余名额时只收下装得下的，不越界
    const full = pageInstance()
    full.commitDrafts(Array.from({ length: 19 }, (_, index) => completeDraft(`物品${index}`)))
    full.appendRecentDrafts([completeDraft('面包'), completeDraft('酸奶')])
    expect(full.data.drafts).toHaveLength(20)
    expect(full.data.drafts[0].fields.name).toBe('面包')
  })

  it('keeps the recent entry as a page jump instead of an in-page view swap', () => {
    const template = readFileSync(resolve(process.cwd(), 'miniprogram/pages/quick-entry/index.wxml'), 'utf8')
    const blockOpenCount = template.match(/<block\b/g)?.length || 0
    const blockCloseCount = template.match(/<\/block>/g)?.length || 0
    expect(blockOpenCount).toBe(blockCloseCount)
    expect(template).not.toContain('class="quick-tabs"')
    expect(template).toContain('class="recent-entry-button"')
    expect(template).toContain('bindtap="openRecentEntry"')
    // 列表和关闭按钮都搬进独立页面了，本页不该再有伪页面残留
    expect(template).not.toContain('recent-page__close')
    expect(template).not.toContain('bindtap="closeRecentList"')
    expect(template).not.toContain('bindtap="selectRecent"')
    // 「从最近录入添加」收进输入卡片左下角，和确认按钮同一行
    expect(template.indexOf('recent-entry-button')).toBeGreaterThan(template.indexOf('<form'))
    expect(template.indexOf('recent-entry-button')).toBeLessThan(template.indexOf('class="quick-generate"'))
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

  it('re-arms the input focus when the footer continue button is tapped', () => {
    vi.useFakeTimers()
    try {
      const page = pageInstance()
      page.focusQuickInput()
      expect(page.data.quickInputFocused).toBe(false)
      vi.advanceTimersByTime(60)
      expect(page.data.quickInputFocused).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the shared full-entry form from anywhere on the card and applies edits only on 完成', () => {
    const page = pageInstance()
    const applied = stubDraftForm(page)
    const draft = completeDraft('牛奶')
    page.commitDrafts([draft])

    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })
    expect(page.data.editingIndex).toBe(0)
    expect(page.data.quickInputFocused).toBe(false)
    // 草稿值直接灌进完整录入表单，且带上当前日期冲突值而不是清空
    expect(applied[0][0]).toMatchObject({ name: '牛奶', expiryDate: draft.fields.expiryDate })

    // 表单里的改动不回写草稿：只有点「完成」才生效
    expect(page.data.drafts[0].fields.name).toBe('牛奶')
    page.handleDraftFormSubmit({ detail: { ...draft.fields, name: '鲜牛奶', quantity: 2 } })
    expect(page.data.editingIndex).toBe(-1)
    expect(page.data.drafts[0].fields).toMatchObject({ name: '鲜牛奶', quantity: 2 })
  })

  it('asks again before leaving an edited form and keeps the draft untouched on 放弃', () => {
    const page = pageInstance()
    stubDraftForm(page, true)
    page.commitDrafts([completeDraft('牛奶')])
    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })

    page.requestCloseDraftEditor()
    expect(wx.showModal).toHaveBeenCalledTimes(1)
    expect(page.data.editingIndex).toBe(0)

    const modal = vi.mocked(wx.showModal).mock.calls[0][0] as unknown as { success: (result: { confirm: boolean }) => void }
    modal.success({ confirm: true })
    expect(page.data.editingIndex).toBe(-1)
    expect(page.data.drafts).toHaveLength(1)
  })

  it('leaves the form without asking when nothing was touched', () => {
    const page = pageInstance()
    stubDraftForm(page, false)
    page.commitDrafts([completeDraft('牛奶')])
    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })
    page.requestCloseDraftEditor()
    expect(wx.showModal).not.toHaveBeenCalled()
    expect(page.data.editingIndex).toBe(-1)
  })

  it('refuses to open the editor for saved or failed drafts', () => {
    const page = pageInstance()
    const saved = completeDraft('牛奶')
    saved.status = 'saved'
    page.commitDrafts([saved])
    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })
    expect(page.data.editingIndex).toBe(-1)
  })

  it('puts the input on top, preview cards below, and the save button in a fixed footer', () => {
    const template = readFileSync(resolve(process.cwd(), 'miniprogram/pages/quick-entry/index.wxml'), 'utf8')
    expect(template.indexOf('class="quick-input-card"')).toBeGreaterThan(-1)
    expect(template.indexOf('class="quick-input-card"')).toBeLessThan(template.indexOf('class="draft-area"'))
    expect(template).toContain('bindtap="openDraftEditor"')
    expect(template).toContain('class="quick-footer"')
    expect(template).toContain('bindtap="focusQuickInput"')
    expect(template).toContain('bindtap="saveDrafts"')
    expect(template).toContain('wx:if="{{editingIndex >= 0}}"')
    // 预览卡不再内嵌日期表单：picker 只允许出现在编辑弹窗里
    const previewArea = template.slice(template.indexOf('class="draft-area"'), template.indexOf('class="quick-footer"'))
    expect(previewArea).not.toContain('<picker')
    expect(previewArea).not.toContain('mode-switch')
  })

  it('keeps the bottom-sheet chrome and reuses only the full-entry form inside it', () => {
    const template = readFileSync(resolve(process.cwd(), 'miniprogram/pages/quick-entry/index.wxml'), 'utf8')
    const editor = template.slice(template.indexOf('class="draft-editor"'))
    // 弹窗外壳：遮罩 + 底部面板 + 弹窗自己的取消/完成
    expect(editor).toContain('class="draft-editor__mask"')
    expect(editor).toContain('class="draft-editor__panel"')
    expect(editor).toContain('class="draft-editor__cancel"')
    expect(editor).toContain('bindtap="confirmDraftEditor"')
    // 弹窗里只放共用的完整录入表单，且按钮由弹窗持有（表单自己的 save-bar 关掉）
    expect(editor).toContain('<item-form-sheet id="draftForm" purpose="draft"')
    expect(editor).toContain('bind:draftsubmit="handleDraftFormSubmit"')
    const formTemplate = readFileSync(resolve(process.cwd(), 'miniprogram/components/item-form-sheet/index.wxml'), 'utf8')
    // purpose="draft" 时表单不渲染自己的 save-bar，避免和弹窗的取消/完成叠成两排按钮
    expect(formTemplate).toContain(`<view wx:if="{{purpose !== 'draft'}}" class="save-bar">`)
    // 编辑弹窗自己不再重写一份表单：整页里没有草稿专用的 picker/输入行
    expect(template).not.toContain('class="qe-row')
    expect(template).not.toContain('class="mode-switch"')
    // 卡片任意位置都能进编辑，卡内的删除/重试不能把点击带成「进编辑」
    expect(template).toContain('bindtap="openDraftEditor"')
    expect(template).toContain('catchtap="removeDraft"')
  })

  it('submits the shared form when the sheet 完成 is tapped', () => {
    const page = pageInstance()
    let submits = 0
    stubDraftForm(page, true, () => { submits += 1 })
    page.commitDrafts([completeDraft('牛奶')])
    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })
    page.confirmDraftEditor()
    expect(submits).toBe(1)
    // 弹窗没关：真正的回写由表单的 draftsubmit 事件触发
    expect(page.data.editingIndex).toBe(0)
    // 弹窗已关时点「完成」不再触发表单
    page.dismissDraftEditor(false)
    page.confirmDraftEditor()
    expect(submits).toBe(1)
  })

  it('caps the preview cards at 20 and greys out the recent-add button at the limit', () => {
    const page = pageInstance()
    const drafts = Array.from({ length: 20 }, (_, index) => completeDraft(`物品${index}`))
    page.commitDrafts(drafts)
    expect(page.data.draftLimitReached).toBe(true)
    // 已入库的卡片不占名额
    drafts[0].status = 'saved'
    page.commitDrafts([...drafts])
    expect(page.data.draftLimitReached).toBe(false)

    const template = readFileSync(resolve(process.cwd(), 'miniprogram/pages/quick-entry/index.wxml'), 'utf8')
    expect(template).toContain(`disabled="{{saving || recognitionState !== 'idle' || draftLimitReached}}"`)
    expect(template).toContain('{{maxDrafts}}')
  })

  it('puts the newest draft first and leaves room for the fixed footer', async () => {
    const page = pageInstance()
    stubDraftForm(page)
    const first = '牛奶2盒明天到期，酸奶4杯后天到期'
    parseMock.mockResolvedValueOnce(parseQuickTextLocally(first, '2026-09-08'))
    page.data.inputText = first
    await page.generateDrafts()
    // 同一批内保持原文顺序
    expect(page.data.drafts.map((draft: any) => draft.fields.name)).toEqual(['牛奶', '酸奶'])

    parseMock.mockResolvedValueOnce(parseQuickTextLocally('面包后天到期', '2026-09-08'))
    page.data.inputText = '面包后天到期'
    await page.generateDrafts()
    // 后添加的整批插到最前
    expect(page.data.drafts.map((draft: any) => draft.fields.name)).toEqual(['面包', '牛奶', '酸奶'])

    const template = readFileSync(resolve(process.cwd(), 'miniprogram/pages/quick-entry/index.wxml'), 'utf8')
    const styles = readFileSync(resolve(process.cwd(), 'miniprogram/pages/quick-entry/index.wxss'), 'utf8')
    // 最后一张卡片不能被固定底部条压住
    expect(template).toContain("quick-body {{drafts.length ? 'quick-body--with-footer' : ''}}")
    expect(styles).toContain('.quick-body--with-footer')
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

  /**
   * 微信一次性订阅「一次授权换一条额度」，所以批量保存只能一件一件申请。
   * 这几条守住：谁该申请、谁该跳过、拒绝之后不再连弹。
   */
  describe('quick entry 保存后预约到期提醒', () => {
    it('对每条保存成功的草稿依次申请授权并挂提醒', async () => {
      const page = pageInstance()
      page.setData({ today: '2026-09-08' })
      page.commitDrafts([completeDraft('牛奶'), completeDraft('酸奶')])
      saveMock.mockResolvedValueOnce({ itemId: 'milk' }).mockResolvedValueOnce({ itemId: 'yogurt' })

      await page.saveDrafts()

      expect(requestReminderAuthorizationMock).toHaveBeenCalledTimes(2)
      expect(armReminderMock.mock.calls.map((call) => call[0])).toEqual(['milk', 'yogurt'])
    })

    it('用户拒绝授权后停止，不再对后面几条连弹', async () => {
      const page = pageInstance()
      page.setData({ today: '2026-09-08' })
      page.commitDrafts([completeDraft('牛奶'), completeDraft('酸奶')])
      saveMock.mockResolvedValueOnce({ itemId: 'milk' }).mockResolvedValueOnce({ itemId: 'yogurt' })
      requestReminderAuthorizationMock.mockResolvedValueOnce(false)

      await page.saveDrafts()

      expect(requestReminderAuthorizationMock).toHaveBeenCalledTimes(1)
      expect(armReminderMock).not.toHaveBeenCalled()
    })

    it('提醒日已经过去的草稿不申请授权，与完整录入保持一致', async () => {
      const page = pageInstance()
      // 草稿到期 2026-09-09、提前 1 天 → 提醒日 2026-09-08，已经过去。
      page.setData({ today: '2026-09-10' })
      page.commitDrafts([completeDraft('牛奶')])
      saveMock.mockResolvedValueOnce({ itemId: 'milk' })

      await page.saveDrafts()

      expect(requestReminderAuthorizationMock).not.toHaveBeenCalled()
      expect(armReminderMock).not.toHaveBeenCalled()
    })

    it('挂提醒失败不影响保存结果', async () => {
      const page = pageInstance()
      page.setData({ today: '2026-09-08' })
      page.commitDrafts([completeDraft('牛奶')])
      saveMock.mockResolvedValueOnce({ itemId: 'milk' })
      armReminderMock.mockRejectedValueOnce(new Error('REMINDER_NOT_CONFIGURED'))

      await page.saveDrafts()

      expect(page.data.drafts).toHaveLength(0)
      expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '已加入库存' }))
    })
  })
  it('resolves an ambiguous date conflict only when the form actually changed the dates', () => {
    const item = completeDraft('牛奶')
    item.confirmationFields = ['date:0']
    item.dateConflict = '日期有冲突'

    // 日期没动就点「完成」：冲突提示必须留着，不能被静默吃掉
    const untouched = applyFormValuesToDraft(item, { ...item.fields })
    expect(untouched.confirmationFields).toEqual(['date:0'])
    expect(untouched.dateConflict).toBe('日期有冲突')

    // 手动改成新到期日：歧义与冲突一并结清，也不留旧的生产日期
    const fixed = applyFormValuesToDraft(item, { ...item.fields, expiryInputMode: 'direct', expiryDate: '2027-01-01', productionDate: null })
    expect(fixed.status).toBe('savable')
    expect(fixed.confirmationFields).toEqual([])
    expect(fixed.dateConflict).toBeUndefined()
    expect(fixed.fields.productionDate).toBeNull()
  })
  it('switches to the full form tab instead of leaving the page during manual handoff', () => {
    const page = pageInstance()
    const applied: unknown[][] = []
    page.selectComponent = () => ({ applyPrefill: (...args: unknown[]) => applied.push(args) })
    page.commitDrafts([completeDraft('牛奶')])
    page.continueManual()
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(page.data.activeTab).toBe('full')
    expect(page.data.fullMounted).toBe(true)
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
    expect(template).toContain('{{features.datePhoto && capabilities.datePhoto}}')
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

  it('turns a draft handed back by the recent page into a savable item', async () => {
    const page = pageInstance()
    listRecentProfilesMock.mockResolvedValue({ items: [{
      name: '鲜牛奶', quantity: 2, unit: '盒', category: 'food', storageLocation: '冰箱',
      reminderLeadDays: 1, expiryInputMode: 'direct', shelfLifeValue: null, shelfLifeUnit: null, invalidFields: [],
    }] })
    getQuickEntryCapabilitiesMock.mockResolvedValue({ text: true, voice: false, datePhoto: false })
    getSettingsMock.mockResolvedValue({ defaultReminderLeadDays: 1 })

    await page.preparePage()
    expect(page.data.recentProfiles).toHaveLength(1)

    // 最近录入页带回来的草稿没有到期日 → 待补全，回来后走本页同一套编辑表单
    const picked = createDraftFromRecent(page.data.recentProfiles[0] as never, 1)
    expect(picked.status).toBe('needs_input')
    page.appendRecentDrafts([picked])
    expect(page.data.drafts).toHaveLength(1)

    stubDraftForm(page)
    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })
    // 完整表单里选好到期日再点「完成」，草稿此刻才变成可入库
    page.handleDraftFormSubmit({ detail: { ...page.data.drafts[0].fields, expiryInputMode: 'direct', expiryDate: '2026-09-20' } })
    expect(page.data.editingIndex).toBe(-1)
    expect(page.data.drafts[0].status).toBe('savable')
    expect(page.data.drafts[0].selected).toBe(true)
    expect(page.data.selectableCount).toBe(1)

    saveMock.mockResolvedValue({ itemId: 'milk' })
    await page.saveDrafts()
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ name: '鲜牛奶', expiryDate: '2026-09-20' }), expect.objectContaining({ idempotencyKey: expect.any(String) }))
    // 全部入库后草稿清空，同时刷新最近录入
    expect(page.data.drafts).toHaveLength(0)
    expect(listRecentProfilesMock).toHaveBeenCalledTimes(2)
    // 全部保存成功后自动回首页，让用户看到刚录入的物品
    expect(wx.navigateBack).toHaveBeenCalledTimes(1)
  })

  it('does not touch the draft when the form switches expiry modes before 完成', () => {
    const page = pageInstance()
    stubDraftForm(page)
    const draft = completeDraft('牛奶')
    page.commitDrafts([draft])
    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })
    // 表单里怎么切模式都只改表单，草稿保持原样，直到点「完成」
    expect(page.data.drafts[0]).toEqual(draft)
    expect(page.data.drafts[0].status).toBe('savable')
  })

  it('flags a past expiry date instead of comparing the placeholder text', () => {
    const page = pageInstance()
    stubDraftForm(page)
    const draft = completeDraft('牛奶')
    page.data.today = '2026-09-09'
    page.commitDrafts([draft])
    expect(page.data.expiredFlags).toEqual([false])
    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })
    page.handleDraftFormSubmit({ detail: { ...draft.fields, expiryDate: '2026-09-01' } })
    expect(page.data.expiredFlags).toEqual([true])
  })

  it('silently degrades when the recent records cannot be read on the entry page', async () => {
    // 最近记录在本页只用来给识别结果补分类；拉不到也不该在正在录入的人面前弹提示。
    listRecentProfilesMock.mockRejectedValueOnce(
      new CloudServiceError('INVALID_ACTION', '不支持的库存操作'),
    )
    const setData = vi.fn()

    await (quickEntryPage.refreshRecentProfiles as () => Promise<void>).call({ setData })

    expect(setData).not.toHaveBeenCalled()
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

  it('clears the AI hints once the whole form is confirmed', () => {
    const page = pageInstance()
    stubDraftForm(page)
    const draft = createDraftFromParsed({ name: '牛奶', dateCandidates: [] }, 'text', 1, undefined, undefined, 'ai-v1')
    draft.fields.expiryDate = '2026-09-20'
    page.commitDrafts([refreshDraftValidation(draft)])
    expect(page.data.aiMissingHints[0]).toBe('AI 没在原文里找到数量和单位，已按默认值填上，请核对')

    page.openDraftEditor({ currentTarget: { dataset: { index: 0 } } })
    page.handleDraftFormSubmit({ detail: { ...page.data.drafts[0].fields, quantity: 2, unit: '盒' } })

    expect(page.data.aiMissingHints).toEqual([''])
  })
})
