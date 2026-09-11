import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { listRecentProfilesMock, getSettingsMock } = vi.hoisted(() => ({
  listRecentProfilesMock: vi.fn(),
  getSettingsMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/quick-entry-service', () => ({
  listRecentProfiles: listRecentProfilesMock,
}))
vi.mock('../../miniprogram/services/settings-service', () => ({
  getSettings: getSettingsMock,
}))

const originalPage = globalThis.Page
const originalWx = globalThis.wx
let recentPage: Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.wx = {
    showModal: vi.fn(),
    navigateBack: vi.fn(),
    reportAnalytics: vi.fn(),
  } as never
})

beforeAll(async () => {
  globalThis.Page = ((definition: Record<string, unknown>) => {
    recentPage = definition
  }) as never
  await import('../../miniprogram/pages/recent-entry/index')
})

afterAll(() => {
  globalThis.Page = originalPage
  globalThis.wx = originalWx
})

const MILK = {
  name: '鲜牛奶', quantity: 2, unit: '盒', category: 'food', storageLocation: '冰箱',
  reminderLeadDays: 1, expiryInputMode: 'direct' as const, shelfLifeValue: null, shelfLifeUnit: null, invalidFields: [],
}
const BREAD = { ...MILK, name: '全麦面包', quantity: 1, unit: '袋', storageLocation: '冷藏' }
/** 补好到期日的表单回传值：从最近录入拿到的草稿本来就没日期，得在弹窗里补上才能入库。 */
const DATED_FIELDS = { expiryInputMode: 'direct' as const, expiryDate: '2026-09-20', productionDate: null }

function pageInstance(channel?: { emit: ReturnType<typeof vi.fn> }) {
  const page: any = { ...recentPage, data: structuredClone(recentPage.data) }
  page.setData = (patch: object, callback?: () => void) => { Object.assign(page.data, patch); callback?.() }
  if (channel) page.getOpenerEventChannel = () => channel
  return page
}

/** 把共用的完整录入表单换成替身，用来断言「灌进去什么」和「退出要不要拦」。 */
function stubForm(page: any, dirty = false) {
  const applied: unknown[][] = []
  let saveCount = 0
  page.selectComponent = (selector: string) => selector === '#recentForm'
    ? {
        applyPrefill: (...args: unknown[]) => applied.push(args),
        isDirty: () => dirty,
        save: () => { saveCount += 1 },
      }
    : null
  return { applied, saveCount: () => saveCount }
}

async function loadedPage(channel?: { emit: ReturnType<typeof vi.fn> }, items: unknown[] = [MILK, BREAD]) {
  // onLoad 自己会拉一次列表，这里的桩要能应答多次，别用 Once。
  listRecentProfilesMock.mockResolvedValue({ items })
  getSettingsMock.mockResolvedValue({ defaultReminderLeadDays: 1 })
  const page = pageInstance(channel)
  page.onLoad({ slots: '5' })
  await page.loadProfiles()
  return page
}

/** 走一遍「点列表项 → 在表单里改好 → 点加入已选」，返回页面。 */
function pickAndConfirm(page: any, key: string, fields: Record<string, unknown> = DATED_FIELDS) {
  page.pickProfile({ currentTarget: { dataset: { key } } })
  page.handleFormSubmit({ detail: { ...page.pendingDraft.fields, ...fields } })
}

describe('recent entry page', () => {
  it('clamps the slots handed over by the entry page', () => {
    listRecentProfilesMock.mockResolvedValue({ items: [] })
    getSettingsMock.mockResolvedValue({ defaultReminderLeadDays: 1 })

    const page = pageInstance()
    page.onLoad({ slots: '3' })
    expect(page.data.slots).toBe(3)
    expect(page.data.remaining).toBe(3)
    expect(page.data.introText).toContain('3')
    expect(page.data.introText).toContain('还能加')

    const tampered = pageInstance()
    tampered.onLoad({ slots: '999' })
    expect(tampered.data.slots).toBe(20)

    const missing = pageInstance()
    missing.onLoad({})
    expect(missing.data.slots).toBe(20)
  })

  it('loads the recent records with a lookup key that matches the list dedupe rule', async () => {
    const page = await loadedPage()
    expect(page.data.loading).toBe(false)
    expect(page.data.filteredProfiles.map((profile: any) => profile.name)).toEqual(['鲜牛奶', '全麦面包'])
    expect(page.data.filteredProfiles[0].key).toBe('鲜牛奶')
    expect(page.data.filteredProfiles[0].picked).toBe(false)
  })

  it('filters by keyword and restores the full list when cleared', async () => {
    const page = await loadedPage()
    page.handleKeywordInput({ detail: { value: '牛奶' } })
    expect(page.data.filteredProfiles.map((profile: any) => profile.name)).toEqual(['鲜牛奶'])
    page.clearKeyword()
    expect(page.data.filteredProfiles).toHaveLength(2)
  })

  it('shows a retryable error and recovers on retry', async () => {
    const page = pageInstance()
    listRecentProfilesMock.mockRejectedValueOnce(new Error('最近记录读不出来'))
    getSettingsMock.mockResolvedValueOnce({ defaultReminderLeadDays: 1 })

    await page.loadProfiles()
    expect(page.data.loading).toBe(false)
    expect(page.data.loadingError).toBe('最近记录读不出来')
    expect(page.data.filteredProfiles).toEqual([])

    listRecentProfilesMock.mockResolvedValueOnce({ items: [MILK] })
    getSettingsMock.mockResolvedValueOnce({ defaultReminderLeadDays: 1 })
    await page.retryLoad()
    expect(page.data.loadingError).toBe('')
    expect(page.data.filteredProfiles).toHaveLength(1)
  })

  it('opens the shared form for a tapped record without adding it yet', async () => {
    const page = await loadedPage()
    const form = stubForm(page)

    page.pickProfile({ currentTarget: { dataset: { key: '鲜牛奶' } } })

    // 点开只是编辑：没点「加入已选」之前不该产生草稿
    expect(page.data.editorOpen).toBe(true)
    expect(page.data.editingPicked).toBe(false)
    expect(page.data.picked).toHaveLength(0)
    expect(form.applied[0][0]).toMatchObject({ name: '鲜牛奶', quantity: 2, unit: '盒' })
  })

  it('adds the picked draft on confirm and marks the row as picked', async () => {
    const page = await loadedPage()
    stubForm(page)

    pickAndConfirm(page, '鲜牛奶')

    expect(page.data.picked).toHaveLength(1)
    expect(page.data.pickedKeys).toEqual(['鲜牛奶'])
    expect(page.data.picked[0].status).toBe('savable')
    expect(page.data.pendingCount).toBe(0)
    expect(page.data.remaining).toBe(4)
    expect(page.data.editorOpen).toBe(false)
    expect(page.data.filteredProfiles.find((profile: any) => profile.key === '鲜牛奶').picked).toBe(true)
    // 待确认的临时草稿用完即弃，不会泄漏到下一条
    expect(page.pendingDraft).toBeNull()
  })

  it('keeps picking without leaving the page', async () => {
    const page = await loadedPage()
    stubForm(page)

    pickAndConfirm(page, '鲜牛奶')
    pickAndConfirm(page, '全麦面包')

    expect(page.data.picked.map((draft: any) => draft.fields.name)).toEqual(['鲜牛奶', '全麦面包'])
    expect(wx.navigateBack).not.toHaveBeenCalled()
  })

  it('reopens a picked row for editing instead of adding it twice', async () => {
    const page = await loadedPage()
    stubForm(page)

    pickAndConfirm(page, '鲜牛奶')
    const draftId = page.data.picked[0].draftId

    page.pickProfile({ currentTarget: { dataset: { key: '鲜牛奶' } } })
    expect(page.data.editingPicked).toBe(true)
    expect(page.data.editingIndex).toBe(0)
    page.handleFormSubmit({ detail: { ...page.data.picked[0].fields, quantity: 5, ...DATED_FIELDS } })

    expect(page.data.picked).toHaveLength(1)
    expect(page.data.picked[0].draftId).toBe(draftId)
    expect(page.data.picked[0].fields.quantity).toBe(5)
  })

  it('discards the pending draft when the form is cancelled untouched', async () => {
    const page = await loadedPage()
    stubForm(page)

    page.pickProfile({ currentTarget: { dataset: { key: '鲜牛奶' } } })
    page.closeEditor()

    expect(page.data.picked).toHaveLength(0)
    expect(page.data.editorOpen).toBe(false)
    expect(page.pendingDraft).toBeNull()
  })

  it('asks before dropping touched edits', async () => {
    const page = await loadedPage()
    stubForm(page, true)

    page.pickProfile({ currentTarget: { dataset: { key: '鲜牛奶' } } })
    page.requestCloseEditor()
    // 用户点了「继续编辑」：弹窗还开着，草稿没被丢
    expect(wx.showModal).toHaveBeenCalledTimes(1)
    expect(page.data.editorOpen).toBe(true)

    vi.mocked(wx.showModal).mockImplementation((options: any) => { options.success?.({ confirm: true }); return undefined as never })
    page.requestCloseEditor()
    expect(page.data.editorOpen).toBe(false)
  })

  it('removes a single picked draft and clears the rest on request', async () => {
    const page = await loadedPage()
    stubForm(page)

    pickAndConfirm(page, '鲜牛奶')
    pickAndConfirm(page, '全麦面包')

    page.pickProfile({ currentTarget: { dataset: { key: '全麦面包' } } })
    page.removePicked()
    expect(page.data.picked.map((draft: any) => draft.fields.name)).toEqual(['鲜牛奶'])
    expect(page.data.filteredProfiles.find((profile: any) => profile.key === '全麦面包').picked).toBe(false)

    vi.mocked(wx.showModal).mockImplementation((options: any) => { options.success?.({ confirm: true }); return undefined as never })
    page.clearPicked()
    expect(page.data.picked).toHaveLength(0)
    expect(page.data.remaining).toBe(5)
  })

  it('stops taking new records once the slots are full', async () => {
    const page = await loadedPage()
    stubForm(page)
    const [milk, bread] = page.data.profiles
    page.setData({ slots: 1, remaining: 1 })

    pickAndConfirm(page, milk.key)
    expect(page.data.picked).toHaveLength(1)
    expect(page.data.remaining).toBe(0)

    page.pickProfile({ currentTarget: { dataset: { key: bread.key } } })
    expect(page.data.limitNotice).toContain('1')
    expect(page.data.editorOpen).toBe(false)
    expect(page.data.picked).toHaveLength(1)
  })

  it('hands the picked drafts back through the opener channel and returns', async () => {
    const emit = vi.fn()
    const page = await loadedPage({ emit })
    stubForm(page)

    pickAndConfirm(page, '鲜牛奶')
    page.confirmPicked()

    expect(emit).toHaveBeenCalledWith('pickedDrafts', { drafts: [expect.objectContaining({ source: 'recent' })] })
    expect(wx.navigateBack).toHaveBeenCalledTimes(1)
  })

  it('does not emit anything when nothing was picked', async () => {
    const emit = vi.fn()
    const page = await loadedPage({ emit })
    page.confirmPicked()
    expect(emit).not.toHaveBeenCalled()
    expect(wx.navigateBack).not.toHaveBeenCalled()
  })

  it('flags the picked drafts that still miss an expiry date', async () => {
    const page = await loadedPage()
    stubForm(page)

    // 不补日期直接确认：草稿回来了但进不了库，得提前说清楚
    pickAndConfirm(page, '鲜牛奶', {})

    expect(page.data.picked).toHaveLength(1)
    expect(page.data.pendingCount).toBe(1)
  })

  it('submits the shared form when the sheet confirm button is tapped', async () => {
    const page = await loadedPage()
    const form = stubForm(page)
    page.pickProfile({ currentTarget: { dataset: { key: '鲜牛奶' } } })
    page.confirmEditor()
    expect(form.saveCount()).toBe(1)
  })

  it('is registered as a real page with a navigation bar and a fixed footer', () => {
    const appJson = JSON.parse(readFileSync(resolve(process.cwd(), 'miniprogram/app.json'), 'utf8'))
    expect(appJson.pages).toContain('pages/recent-entry/index')

    const pageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'miniprogram/pages/recent-entry/index.json'), 'utf8'))
    expect(pageJson.navigationBarTitleText).toBe('从最近录入添加')
    expect(pageJson.usingComponents['item-form-sheet']).toBe('/components/item-form-sheet/index')

    const template = readFileSync(resolve(process.cwd(), 'miniprogram/pages/recent-entry/index.wxml'), 'utf8')
    // 进得来也要出得去：靠原生导航栏返回，页面里不再自制关闭按钮
    expect(template).not.toContain('closeRecentList')
    expect(template).toContain('class="recent-search__input"')
    expect(template).toContain('bindtap="confirmPicked"')
    expect(template).toContain('bindtap="pickProfile"')
    expect(template).toContain('purpose="draft"')
  })
})
