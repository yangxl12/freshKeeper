import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  deleteAccountMock,
  exportDataMock,
  getUserProfileMock,
  getSettingsMock,
  readReminderAuthorizationMock,
  shareExportedFileMock,
  updateProfileMock,
  uploadAvatarFileMock,
} = vi.hoisted(() => ({
  deleteAccountMock: vi.fn(),
  exportDataMock: vi.fn(),
  getUserProfileMock: vi.fn(),
  getSettingsMock: vi.fn(),
  readReminderAuthorizationMock: vi.fn(),
  shareExportedFileMock: vi.fn(),
  updateProfileMock: vi.fn(),
  uploadAvatarFileMock: vi.fn(),
}))

vi.mock('../../miniprogram/services/user-service', () => ({
  deleteAccount: deleteAccountMock,
  exportData: exportDataMock,
  getUserProfile: getUserProfileMock,
  shareExportedFile: shareExportedFileMock,
  updateProfile: updateProfileMock,
  uploadAvatarFile: uploadAvatarFileMock,
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

const PROFILE_STORAGE_KEY = 'mine_profile'
const PROFILE_MIGRATED_KEY = 'profile_migrated'
const DEFAULT_NICKNAME = '保质记用户'

const originalPage = globalThis.Page
const originalWx = globalThis.wx
let minePage: Record<string, unknown>
let storage: Record<string, unknown>
let toastCalls: Array<Record<string, unknown>>
let modalCalls: Array<Record<string, unknown>>
let loadingCalls: string[]

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

function stubWx() {
  storage = {}
  toastCalls = []
  modalCalls = []
  loadingCalls = []
  globalThis.wx = {
    showToast: vi.fn((options: Record<string, unknown>) => {
      toastCalls.push(options)
    }),
    showModal: vi.fn((options: Record<string, unknown>) => {
      modalCalls.push(options)
      return Promise.resolve({ confirm: true })
    }),
    showLoading: vi.fn((options: { title: string }) => {
      loadingCalls.push(options.title)
    }),
    hideLoading: vi.fn(),
    clearStorageSync: vi.fn(),
    reLaunch: vi.fn(),
    getStorageSync: (key: string) => (key in storage ? storage[key] : ''),
    setStorageSync: (key: string, value: unknown) => {
      storage[key] = value
    },
  } as never
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

const REMOTE = { nickname: '龙哥', avatarFileId: 'cloud://env.1/avatars/x.png', createdAt: null, lastSeenAt: null }

beforeEach(() => {
  vi.clearAllMocks()
  stubWx()
  getSettingsMock.mockResolvedValue({ defaultReminderLeadDays: 1, hasReminderJobs: false })
  readReminderAuthorizationMock.mockResolvedValue({ authorized: false, summary: '未授权' })
  getUserProfileMock.mockResolvedValue(REMOTE)
  updateProfileMock.mockResolvedValue(REMOTE)
  uploadAvatarFileMock.mockResolvedValue('cloud://env.1/avatars/new.png')
  exportDataMock.mockResolvedValue({ fileID: 'cloud://env.1/exports/x.txt', fileName: 'a.txt' })
  shareExportedFileMock.mockResolvedValue(true)
})

describe('我的 → 资料读取', () => {
  it('onShow 同时拉设置和资料（不是串行等待）', async () => {
    const page = instance()
    const loadProfileSpy = vi.spyOn(page, 'loadProfile')
    page.onShow()
    await flush()
    // 用 spy 而不是数请求次数：资料读取有 60s 节流，次数会受前序用例影响。
    expect(getSettingsMock).toHaveBeenCalled()
    expect(loadProfileSpy).toHaveBeenCalled()
  })

  it('云端成功就覆盖本地缓存', async () => {
    const page = instance()
    await page.loadProfile(true)

    expect(page.data.profile).toEqual({ nickname: '龙哥', avatar: 'cloud://env.1/avatars/x.png' })
    expect(storage[PROFILE_STORAGE_KEY]).toEqual({
      nickname: '龙哥',
      avatar: 'cloud://env.1/avatars/x.png',
    })
  })

  it('云端失败回退本地缓存，且页面不进错误态', async () => {
    storage[PROFILE_STORAGE_KEY] = { nickname: '本地昵称', avatar: '' }
    getUserProfileMock.mockRejectedValue(new Error('服务暂时不可用'))

    const page = instance()
    page.setData({ profile: { nickname: '本地昵称', avatar: '' } })
    await page.loadProfile(true)

    expect(page.data.profile.nickname).toBe('本地昵称')
    expect(page.data.settingsError).toBe('')
    expect(modalCalls).toEqual([])
  })

  it('60s 内不重复请求，force 可以打破节流', async () => {
    const page = instance()
    await page.loadProfile(true)
    getUserProfileMock.mockClear()

    await page.loadProfile()
    expect(getUserProfileMock).not.toHaveBeenCalled()

    await page.loadProfile(true)
    expect(getUserProfileMock).toHaveBeenCalledTimes(1)
  })
})

describe('我的 → 保存资料', () => {
  it('保存走 updateProfile，不再只写本地', async () => {
    const page = instance()
    page.setData({ profileNickname: '  龙哥  ' })
    await page.saveProfile()

    expect(updateProfileMock).toHaveBeenCalledWith({ nickname: '龙哥' })
    expect(page.data.profile.nickname).toBe('龙哥')
    expect(page.data.profileVisible).toBe(false)
    expect(toastCalls[0]).toMatchObject({ title: '资料已保存' })
  })

  it('昵称按码点截断，emoji 不会被切坏', async () => {
    const page = instance()
    page.setData({ profileNickname: 'a'.repeat(19) + '😀😀' })
    await page.saveProfile()

    const nickname = String(updateProfileMock.mock.calls[0][0].nickname)
    expect(Array.from(nickname)).toHaveLength(20)
    expect(nickname).not.toContain('�')
  })

  it('保存中重复点击不会提交两次', async () => {
    let release = () => undefined
    updateProfileMock.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve(REMOTE)
      }),
    )

    const page = instance()
    const first = page.saveProfile()
    await page.saveProfile()
    expect(updateProfileMock).toHaveBeenCalledTimes(1)

    release()
    await first
  })

  it('保存失败用 modal 提示，不用 toast', async () => {
    updateProfileMock.mockRejectedValue(new Error('昵称不能超过 20 个字符'))
    const page = instance()
    page.setData({ profileVisible: true })
    await page.saveProfile()

    expect(modalCalls).toHaveLength(1)
    expect(modalCalls[0].title).toBe('资料没有保存成功')
    expect(page.data.profileSaving).toBe(false)
    // 保存失败要留在弹窗里，别把用户填的昵称丢掉。
    expect(page.data.profileVisible).toBe(true)
  })
})

describe('我的 → 换头像', () => {
  it('上传后立刻写档案：uploadAvatarFile → updateProfile', async () => {
    const page = instance()
    await page.chooseAvatar({ detail: { avatarUrl: 'wxfile://tmp.png' } })

    expect(uploadAvatarFileMock).toHaveBeenCalledWith('wxfile://tmp.png')
    expect(updateProfileMock).toHaveBeenCalledWith({ avatarFileId: 'cloud://env.1/avatars/new.png' })
    expect(page.data.profile.avatar).toBe('cloud://env.1/avatars/x.png')
    expect(page.data.avatarUploading).toBe(false)
  })

  it('上传失败给 modal，不吞掉错误', async () => {
    uploadAvatarFileMock.mockRejectedValue(new Error('上传失败'))
    const page = instance()
    await page.chooseAvatar({ detail: { avatarUrl: 'wxfile://tmp.png' } })

    expect(updateProfileMock).not.toHaveBeenCalled()
    expect(modalCalls[0].title).toBe('头像没有保存成功')
    expect(page.data.avatarUploading).toBe(false)
  })

  it('没有头像地址时什么都不做', async () => {
    const page = instance()
    await page.chooseAvatar({ detail: {} })
    expect(uploadAvatarFileMock).not.toHaveBeenCalled()
  })
})

describe('我的 → 存量迁移', () => {
  it('非默认昵称会被推上云', async () => {
    storage[PROFILE_STORAGE_KEY] = { nickname: '老用户', avatar: '' }
    getUserProfileMock.mockResolvedValue({
      nickname: null,
      avatarFileId: null,
      createdAt: null,
      lastSeenAt: null,
    })

    const page = instance()
    await page.loadProfile(true)
    await flush()

    expect(updateProfileMock).toHaveBeenCalledWith({ nickname: '老用户' })
    expect(storage[PROFILE_MIGRATED_KEY]).toBe(true)
  })

  it('默认昵称不迁，避免污染云端', async () => {
    storage[PROFILE_STORAGE_KEY] = { nickname: DEFAULT_NICKNAME, avatar: '' }
    getUserProfileMock.mockResolvedValue({
      nickname: null,
      avatarFileId: null,
      createdAt: null,
      lastSeenAt: null,
    })

    const page = instance()
    await page.loadProfile(true)
    await flush()

    expect(updateProfileMock).not.toHaveBeenCalled()
  })

  it('本地头像失效时只迁昵称，并清掉死路径', async () => {
    storage[PROFILE_STORAGE_KEY] = { nickname: '老用户', avatar: 'wxfile://gone.png' }
    getUserProfileMock.mockResolvedValue({
      nickname: null,
      avatarFileId: null,
      createdAt: null,
      lastSeenAt: null,
    })
    uploadAvatarFileMock.mockRejectedValue(new Error('文件不存在'))

    const page = instance()
    await page.loadProfile(true)
    await flush()

    expect(updateProfileMock).toHaveBeenCalledWith({ nickname: '老用户' })
    expect(storage[PROFILE_STORAGE_KEY]).toEqual({ nickname: '老用户', avatar: '' })
  })

  it('本地头像已在云端时，只迁昵称不带空头像', async () => {
    storage[PROFILE_STORAGE_KEY] = { nickname: '老用户', avatar: 'cloud://env.1/avatars/old.png' }
    getUserProfileMock.mockResolvedValue({
      nickname: null,
      avatarFileId: 'cloud://env.1/avatars/old.png',
      createdAt: null,
      lastSeenAt: null,
    })

    const page = instance()
    await page.loadProfile(true)
    await flush()

    expect(updateProfileMock).toHaveBeenCalledWith({ nickname: '老用户' })
    expect(uploadAvatarFileMock).not.toHaveBeenCalled()
  })

  it('已经迁过就不再迁', async () => {
    storage[PROFILE_STORAGE_KEY] = { nickname: '老用户', avatar: '' }
    storage[PROFILE_MIGRATED_KEY] = true
    getUserProfileMock.mockResolvedValue({
      nickname: null,
      avatarFileId: null,
      createdAt: null,
      lastSeenAt: null,
    })

    const page = instance()
    await page.loadProfile(true)
    await flush()

    expect(updateProfileMock).not.toHaveBeenCalled()
  })
})

describe('我的 → 数据导出', () => {
  it('导出后转发，全程有 loading', async () => {
    const page = instance()
    await page.startExport()

    expect(exportDataMock).toHaveBeenCalled()
    expect(shareExportedFileMock).toHaveBeenCalledWith('cloud://env.1/exports/x.txt', 'a.txt')
    expect(loadingCalls).toContain('正在导出…')
    expect(page.data.exporting).toBe(false)
    expect(toastCalls[0]).toMatchObject({ title: '已转发' })
  })

  it('导出中重复点击不会跑两次', async () => {
    let release = () => undefined
    exportDataMock.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ fileID: 'cloud://x', fileName: 'a.txt' })
      }),
    )

    const page = instance()
    const first = page.startExport()
    await page.startExport()
    expect(exportDataMock).toHaveBeenCalledTimes(1)

    release()
    await first
  })

  it('失败用 modal 提示，用户取消转发不报错', async () => {
    exportDataMock.mockRejectedValue(new Error('今天导出次数已用完，明天再试'))
    const page = instance()
    await page.startExport()
    expect(modalCalls[0].title).toBe('导出没有完成')

    modalCalls = []
    toastCalls = []
    exportDataMock.mockResolvedValue({ fileID: 'cloud://env.1/exports/x.txt', fileName: 'a.txt' })
    shareExportedFileMock.mockResolvedValue(false)
    await page.startExport()
    expect(modalCalls).toEqual([])
    expect(toastCalls).toEqual([])
  })
})
