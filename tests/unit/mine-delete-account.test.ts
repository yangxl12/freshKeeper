import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteAccountMock, getSettingsMock, readReminderAuthorizationMock } = vi.hoisted(() => ({
  deleteAccountMock: vi.fn(),
  getSettingsMock: vi.fn(),
  readReminderAuthorizationMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/user-service', () => ({
  deleteAccount: deleteAccountMock,
}))
vi.mock('../../miniprogram/services/settings-service', () => ({
  getSettings: getSettingsMock,
  updateSettings: vi.fn(),
}))
vi.mock('../../miniprogram/services/reminder-service', () => ({
  readReminderAuthorization: readReminderAuthorizationMock,
}))
vi.mock('../../miniprogram/services/inventory-service', () => ({
  listTrash: vi.fn(),
  permanentlyDeleteItem: vi.fn(),
}))

const originalPage = globalThis.Page
const originalWx = globalThis.wx
let minePage: Record<string, unknown>
let showModalCalls: Array<Record<string, unknown>>

beforeAll(async () => {
  globalThis.Page = ((definition: Record<string, unknown>) => {
    minePage = definition
  }) as never
  await import('../../miniprogram/pages/mine/index')
})

afterAll(() => {
  globalThis.Page = originalPage
  globalThis.wx = originalWx
})

function instance() {
  const page: any = { ...minePage, data: structuredClone(minePage.data) }
  page.setData = (patch: object, callback?: () => void) => {
    Object.assign(page.data, patch)
    callback?.()
  }
  return page
}

function stubWx(modal: (options: Record<string, unknown>) => Promise<{ confirm: boolean }>) {
  showModalCalls = []
  globalThis.wx = {
    showModal: vi.fn((options: Record<string, unknown>) => {
      showModalCalls.push(options)
      return modal(options)
    }),
    showLoading: vi.fn(),
    hideLoading: vi.fn(),
    clearStorageSync: vi.fn(),
    reLaunch: vi.fn(),
    getStorageSync: vi.fn(() => ''),
    setStorageSync: vi.fn(),
    reportAnalytics: vi.fn(),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  getSettingsMock.mockResolvedValue({ defaultReminderLeadDays: 1, hasReminderJobs: false })
  readReminderAuthorizationMock.mockResolvedValue({ authorized: false, summary: '未授权' })
  deleteAccountMock.mockResolvedValue({ deleted: { items: 3, reminders: 1, settings: 1, files: 2 } })
  stubWx(async () => ({ confirm: true }))
})

describe('我的 → 账号与数据 → 注销', () => {
  it('第一次确认就取消则什么都不做', async () => {
    stubWx(async () => ({ confirm: false }))
    const page = instance()
    await page.startDeleteAccount()
    expect(deleteAccountMock).not.toHaveBeenCalled()
    expect(showModalCalls).toHaveLength(1)
    expect(page.data.deletingAccount).toBe(false)
  })

  it('两步确认后才真正注销：清缓存并回首页', async () => {
    const page = instance()
    await page.startDeleteAccount()

    // 两次确认 + 一条结果说明；不用 toast，微信 toast 超过 7 个汉字会被截断。
    expect(showModalCalls).toHaveLength(3)
    expect(showModalCalls[1]).toMatchObject({ confirmText: '确认注销', confirmColor: '#A33F32' })
    expect(showModalCalls[2]).toMatchObject({ title: '账号已注销', showCancel: false })
    expect(deleteAccountMock).toHaveBeenCalledTimes(1)
    expect(globalThis.wx.showLoading).toHaveBeenCalled()
    expect(globalThis.wx.hideLoading).toHaveBeenCalled()
    expect(globalThis.wx.clearStorageSync).toHaveBeenCalled()
    expect(globalThis.wx.reLaunch).toHaveBeenCalledWith({ url: '/pages/home/index' })
  })

  it('注销过程中不允许关闭弹窗', () => {
    const page = instance()
    page.data.activeModal = 'account'
    page.data.deletingAccount = true
    page.closeModal()
    expect(page.data.activeModal).toBe('account')
  })

  it('失败时保留现场并提示可重试', async () => {
    deleteAccountMock.mockRejectedValue(new Error('服务暂时不可用，请稍后重试'))
    const page = instance()
    await page.startDeleteAccount()

    expect(deleteAccountMock).toHaveBeenCalledTimes(1)
    expect(globalThis.wx.hideLoading).toHaveBeenCalled()
    expect(globalThis.wx.clearStorageSync).not.toHaveBeenCalled()
    expect(globalThis.wx.reLaunch).not.toHaveBeenCalled()
    expect(page.data.deletingAccount).toBe(false)
    // 用弹窗而不是 toast：微信 toast 超过 7 个汉字会被截断。
    const last = showModalCalls[showModalCalls.length - 1]
    expect(last.title).toBe('注销未完成')
    expect(String(last.content)).toContain('重试')
  })

  it('重复点击不会并发删两次', async () => {
    const page = instance()
    page.data.deletingAccount = true
    await page.startDeleteAccount()
    expect(deleteAccountMock).not.toHaveBeenCalled()
  })
})
