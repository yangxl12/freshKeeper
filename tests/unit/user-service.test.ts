import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  confirmExport,
  createAvatarUpload,
  deleteAccount,
  discardLocalExport,
  exportData,
  getUserProfile,
  prepareExport,
  sharePreparedExport,
  touchUser,
  touchUserOnceToday,
  updateProfile,
  uploadAvatarFile,
} from '../../miniprogram/services/user-service'
import { shanghaiTodayKey } from '../../miniprogram/utils/shanghai-time'

const originalWx = globalThis.wx
const TOUCH_STORAGE_KEY = 'user_touch_date'

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

function stubWx(respond: (request: { data: Record<string, unknown> }) => void) {
  const storage: Record<string, unknown> = {}
  globalThis.wx = {
    cloud: {
      callFunction: vi.fn((request: { data: Record<string, unknown> }) => respond(request)),
    },
    getStorageSync: (key: string) => (key in storage ? storage[key] : ''),
    setStorageSync: (key: string, value: unknown) => {
      storage[key] = value
    },
  } as never
  return storage
}

afterEach(() => {
  globalThis.wx = originalWx
  vi.restoreAllMocks()
})

describe('user service contract', () => {
  it('touch 只上报一次活跃度，不携带任何身份字段', async () => {
    let requestData: Record<string, unknown> | undefined
    stubWx((request) => {
      requestData = request.data
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({ result: { ok: true, data: { created: true, lastSeenAt: '2026-09-11' }, requestId: 'r1' } })
    })

    await expect(touchUser()).resolves.toEqual({ created: true, lastSeenAt: '2026-09-11' })
    expect(requestData).toEqual({ action: 'touch' })
    expect(Object.keys(requestData as Record<string, unknown>)).not.toContain('ownerId')
  })

  it('get 读取档案', async () => {
    let requestData: Record<string, unknown> | undefined
    stubWx((request) => {
      requestData = request.data
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({
        result: {
          ok: true,
          data: { nickname: null, avatarFileId: null, createdAt: null, lastSeenAt: null },
          requestId: 'r2',
        },
      })
    })

    await expect(getUserProfile()).resolves.toMatchObject({ nickname: null })
    expect(requestData).toEqual({ action: 'get' })
  })

  it('deleteAccount 必须带确认词 DELETE', async () => {
    let requestData: Record<string, unknown> | undefined
    stubWx((request) => {
      requestData = request.data
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({
        result: {
          ok: true,
          data: { deleted: { items: 3, reminders: 1, settings: 1, files: 2 } },
          requestId: 'r3',
        },
      })
    })

    await expect(deleteAccount()).resolves.toMatchObject({ deleted: { items: 3 } })
    expect(requestData).toEqual({ action: 'deleteAccount', data: { confirm: 'DELETE' } })
  })
})

describe('客户端同日节流', () => {
  it('同一天只调一次，成功后写入本地标记', async () => {
    const requests: Array<Record<string, unknown>> = []
    const storage = stubWx((request) => {
      requests.push(request.data)
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({
        result: { ok: true, data: { created: true, lastSeenAt: shanghaiTodayKey() }, requestId: 'r' },
      })
    })

    touchUserOnceToday()
    await flush()
    touchUserOnceToday()
    await flush()

    expect(requests).toEqual([{ action: 'touch' }])
    expect(storage[TOUCH_STORAGE_KEY]).toBe(shanghaiTodayKey())
  })

  it('调用失败不写本地标记，下次启动会重试', async () => {
    const requests: Array<Record<string, unknown>> = []
    const storage = stubWx((request) => {
      requests.push(request.data)
      ;(request as unknown as {
        success: (response: unknown) => void
      }).success({
        result: { ok: false, error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' }, requestId: 'r' },
      })
    })

    touchUserOnceToday()
    await flush()
    touchUserOnceToday()
    await flush()

    expect(requests).toHaveLength(2)
    expect(storage[TOUCH_STORAGE_KEY]).toBeUndefined()
  })

  it('存储读写抛异常也不能冒泡到启动流程', () => {
    globalThis.wx = {
      cloud: { callFunction: vi.fn() },
      getStorageSync: () => {
        throw new Error('storage broken')
      },
      setStorageSync: vi.fn(),
    } as never
    expect(() => touchUserOnceToday()).not.toThrow()
  })
})

/** 云调用 + 上传/下载/分享的 wx 假实现；调用顺序记在 calls 里。 */
function stubMediaWx(options: {
  callFunction: (request: any) => void
  uploadFile?: (request: any) => void
  downloadFile?: (request: any) => void
  compressImage?: (request: any) => void
  shareFileMessage?: (request: any) => void
}) {
  const calls: string[] = []
  const unlink = vi.fn()
  const deleteFile = vi.fn()
  globalThis.wx = {
    cloud: {
      callFunction: vi.fn((request: any) => {
        calls.push('callFunction')
        options.callFunction(request)
      }),
      uploadFile: vi.fn((request: any) => {
        calls.push('uploadFile')
        if (options.uploadFile) options.uploadFile(request)
        else request.success({ fileID: 'cloud://env.1/avatars/x.png' })
      }),
      downloadFile: vi.fn((request: any) => {
        calls.push('downloadFile')
        if (options.downloadFile) options.downloadFile(request)
        else request.success({ tempFilePath: '/tmp/export.txt' })
      }),
      deleteFile,
    },
    compressImage: vi.fn((request: any) => {
      calls.push('compressImage')
      if (options.compressImage) options.compressImage(request)
      else request.success({ tempFilePath: `${request.src}-compressed` })
    }),
    shareFileMessage: vi.fn((request: any) => {
      calls.push('shareFileMessage')
      // 真实 API 是回调式：成功/失败都靠 request.success / request.fail 回来。
      if (options.shareFileMessage) options.shareFileMessage(request)
      else request.success({})
    }),
    getFileSystemManager: () => ({ unlink }),
    getStorageSync: vi.fn(() => ''),
    setStorageSync: vi.fn(),
  } as never
  return { calls, unlink, deleteFile }
}

function replyCloud(payload: unknown) {
  return (request: any) => {
    request.success({ result: { ok: true, data: payload, requestId: 'r' } })
  }
}

describe('updateProfile / createAvatarUpload / exportData 契约', () => {
  it('updateProfile 只发被改的字段，null 表示清空', async () => {
    let requestData: Record<string, unknown> | undefined
    stubMediaWx({ callFunction: (request) => {
      requestData = request.data
      replyCloud({ nickname: '龙哥', avatarFileId: null, createdAt: null, lastSeenAt: null })(request)
    } })

    await expect(updateProfile({ nickname: '龙哥' })).resolves.toMatchObject({ nickname: '龙哥' })
    expect(requestData).toEqual({ action: 'updateProfile', data: { nickname: '龙哥' } })
  })

  it('createAvatarUpload 带扩展名', async () => {
    let requestData: Record<string, unknown> | undefined
    stubMediaWx({ callFunction: (request) => {
      requestData = request.data
      replyCloud({ cloudPath: 'avatars/hash/1.png' })(request)
    } })

    await expect(createAvatarUpload('jpg')).resolves.toEqual({ cloudPath: 'avatars/hash/1.png' })
    expect(requestData).toEqual({ action: 'createAvatarUpload', data: { ext: 'jpg' } })
  })

  it('exportData 不携带任何身份字段', async () => {
    let requestData: Record<string, unknown> | undefined
    stubMediaWx({ callFunction: (request) => {
      requestData = request.data
      replyCloud({ fileID: 'cloud://env.1/exports/x.txt', fileName: 'a.txt' })(request)
    } })

    await expect(exportData()).resolves.toMatchObject({ fileName: 'a.txt' })
    expect(requestData).toEqual({ action: 'exportData' })
  })
})

describe('头像上传链路', () => {
  it('顺序是 compressImage → createAvatarUpload → uploadFile', async () => {
    const requested: Array<Record<string, unknown>> = []
    const { calls } = stubMediaWx({
      callFunction: (request) => {
        requested.push(request.data)
        if (request.data.action === 'createAvatarUpload') {
          request.success({
            result: { ok: true, data: { cloudPath: 'avatars/hash/1.png' }, requestId: 'r' },
          })
        }
      },
    })

    await expect(uploadAvatarFile('/tmp/a.PNG')).resolves.toBe('cloud://env.1/avatars/x.png')
    expect(calls).toEqual(['compressImage', 'callFunction', 'uploadFile'])
    // 扩展名从小写后的路径取。
    expect(requested[0]).toEqual({ action: 'createAvatarUpload', data: { ext: 'png' } })
  })

  it('压缩失败就传原图，不中断', async () => {
    const { calls } = stubMediaWx({
      callFunction: replyCloud({ cloudPath: 'avatars/hash/1.png' }),
      compressImage: (request) => request.fail({ errMsg: 'compressImage:fail' }),
      uploadFile: (request) => request.success({ fileID: `cloud://f/${request.filePath}` }),
    })

    await expect(uploadAvatarFile('/tmp/a.png')).resolves.toBe('cloud://f//tmp/a.png')
    expect(calls).toEqual(['compressImage', 'callFunction', 'uploadFile'])
  })

  it('没有后缀的路径按 png 处理', async () => {
    const requested: Array<Record<string, unknown>> = []
    stubMediaWx({
      callFunction: (request) => {
        requested.push(request.data)
        replyCloud({ cloudPath: 'avatars/hash/1.png' })(request)
      },
    })
    await uploadAvatarFile('/tmp/avatar')
    expect(requested[0]).toEqual({ action: 'createAvatarUpload', data: { ext: 'png' } })
  })
})

describe('导出文件准备与转发', () => {
  it('prepareExport 下载到本地并给出转发所需的信息', async () => {
    const { calls } = stubMediaWx({
      callFunction: replyCloud({ fileID: 'cloud://env.1/exports/x.txt', fileName: 'a.txt' }),
      downloadFile: (request) => request.success({ tempFilePath: '/tmp/export.txt' }),
    })

    await expect(prepareExport()).resolves.toEqual({
      fileID: 'cloud://env.1/exports/x.txt',
      fileName: 'a.txt',
      tempFilePath: '/tmp/export.txt',
    })
    expect(calls).toEqual(['callFunction', 'downloadFile'])
  })

  it('sharePreparedExport 只碰本地文件，不再调云端', async () => {
    const { calls } = stubMediaWx({ callFunction: replyCloud({}) })

    await expect(sharePreparedExport('/tmp/export.txt', 'a.txt')).resolves.toBe(true)
    // 只能有 shareFileMessage：它要求调用栈里没有 await 过，多一步异步就报
    // "can only be invoked by user TAP gesture"。
    expect(calls).toEqual(['shareFileMessage'])
  })

  it('用户取消转发不算错误，本地文件留着可以再点', async () => {
    const { calls, unlink } = stubMediaWx({
      callFunction: replyCloud({}),
      shareFileMessage: (request) => request.fail({ errMsg: 'shareFileMessage:fail cancel' }),
    })

    await expect(sharePreparedExport('/tmp/export.txt', 'a.txt')).resolves.toBe(false)
    expect(calls).toEqual(['shareFileMessage'])
    expect(unlink).not.toHaveBeenCalled()
  })

  it('转发真失败时抛出可重试的提示', async () => {
    stubMediaWx({
      callFunction: replyCloud({}),
      shareFileMessage: (request) => request.fail({ errMsg: 'shareFileMessage:fail unknown' }),
    })

    await expect(sharePreparedExport('/tmp/export.txt', 'a.txt')).rejects.toThrow('再点一次')
  })

  it('开发者工具的环境限制单独给提示，别说成「重试」', async () => {
    stubMediaWx({
      callFunction: replyCloud({}),
      shareFileMessage: (request) =>
        request.fail({ errMsg: 'shareFileMessage:fail 开发者工具暂时不支持此 API 调试，请使用真机进行开发' }),
    })

    await expect(sharePreparedExport('/tmp/export.txt', 'a.txt')).rejects.toThrow('真机')
  })

  it('confirmExport 只在转发成功后回报云端', async () => {
    const requested: Array<Record<string, unknown>> = []
    stubMediaWx({
      callFunction: (request) => {
        requested.push(request.data)
        replyCloud({ delivered: true })(request)
      },
    })

    confirmExport()
    await flush()
    expect(requested).toEqual([{ action: 'confirmExport' }])
  })

  it('回报失败静默：文件已经在用户手里了', async () => {
    stubMediaWx({ callFunction: (request) => request.fail({ errMsg: 'request:fail network' }) })

    expect(() => confirmExport()).not.toThrow()
    await flush()
  })

  it('discardLocalExport 删掉本地临时文件', () => {
    const { unlink } = stubMediaWx({ callFunction: replyCloud({}) })

    discardLocalExport('/tmp/export.txt')
    expect(unlink).toHaveBeenCalledWith({ filePath: '/tmp/export.txt', fail: expect.any(Function) })
  })
})

describe('shanghaiTodayKey', () => {
  it('按上海时区跨日，而不是本地时区', () => {
    expect(shanghaiTodayKey(new Date('2026-09-10T15:59:00Z'))).toBe('2026-09-10')
    expect(shanghaiTodayKey(new Date('2026-09-10T16:00:00Z'))).toBe('2026-09-11')
  })
})
