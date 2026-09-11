import { shanghaiTodayKey } from '../utils/shanghai-time'
import type {
  AvatarUploadTicket,
  DeleteAccountResult,
  ExportDataResult,
  UserProfile,
  UserProfileUpdateInput,
  UserTouchResult,
} from '../types/inventory'
import { callCloud } from './cloud-client'

/**
 * 本地节流标记：值与「上海日期串」相同则跳过上报。
 * 服务端还有一层同日判定，这里只为省掉一次云调用。
 */
const TOUCH_STORAGE_KEY = 'user_touch_date'

export function touchUser(): Promise<UserTouchResult> {
  return callCloud('userApi', { action: 'touch' })
}

export function getUserProfile(): Promise<UserProfile> {
  return callCloud('userApi', { action: 'get' })
}

export function deleteAccount(): Promise<DeleteAccountResult> {
  return callCloud('userApi', { action: 'deleteAccount', data: { confirm: 'DELETE' } })
}

/** 局部更新：只改传入的字段，null 表示清空回默认态。 */
export function updateProfile(input: UserProfileUpdateInput): Promise<UserProfile> {
  return callCloud('userApi', { action: 'updateProfile', data: input })
}

export function createAvatarUpload(ext: string): Promise<AvatarUploadTicket> {
  return callCloud('userApi', { action: 'createAvatarUpload', data: { ext } })
}

export function exportData(): Promise<ExportDataResult> {
  return callCloud('userApi', { action: 'exportData' })
}

function extensionOf(path: string): string {
  const matched = /\.([a-zA-Z0-9]+)$/.exec(path)
  return matched ? matched[1].toLowerCase() : 'png'
}

/** 原图可能几 MB，先压再传；压缩失败退回原图继续，不要中断流程。 */
function compressAvatar(src: string): Promise<string> {
  return new Promise((resolve) => {
    wx.compressImage({
      src,
      quality: 80,
      success: (result) => resolve(result.tempFilePath || src),
      fail: () => resolve(src),
    })
  })
}

function uploadToCloud(cloudPath: string, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (result) => resolve(result.fileID),
      fail: reject,
    })
  })
}

/** 选完头像的完整链路：压缩 → 取 cloudPath → 上传 → 拿 fileID。 */
export async function uploadAvatarFile(localPath: string): Promise<string> {
  const compressed = await compressAvatar(localPath)
  const { cloudPath } = await createAvatarUpload(extensionOf(localPath))
  return uploadToCloud(cloudPath, compressed)
}

function downloadExportFile(fileID: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID,
      success: (result) => resolve(result.tempFilePath),
      fail: reject,
    })
  })
}

/** 导出文件是一次性的：转发完就把云端和本地的副本都清掉。 */
function cleanupExport(fileID: string, tempFilePath: string): void {
  try {
    void wx.cloud.deleteFile({ fileList: [fileID] })
  } catch (error) {
    // 清不掉也不影响用户，留着下次注销时按前缀统一清。
  }
  try {
    wx.getFileSystemManager().unlink({ filePath: tempFilePath, fail: () => undefined })
  } catch (error) {
    // 临时文件清不掉无所谓，系统会回收。
  }
}

/**
 * 下载导出文件并转发到微信会话（一般选「文件传输助手」，在电脑端打开）。
 * 返回是否真的转发出去了：用户取消不算错误。
 */
export async function shareExportedFile(fileID: string, fileName: string): Promise<boolean> {
  const tempFilePath = await downloadExportFile(fileID)
  try {
    await wx.shareFileMessage({ filePath: tempFilePath, fileName })
    return true
  } catch (error) {
    if (String((error as { errMsg?: string }).errMsg || '').includes('cancel')) return false
    throw new Error('转发未完成，可以重新导出再试一次')
  } finally {
    cleanupExport(fileID, tempFilePath)
  }
}

/**
 * 启动时上报一次活跃度：同一天只调一次，失败静默且不写本地标记（下次启动会重试）。
 * 这是埋点，不是核心链路，任何异常都不能阻塞启动。
 */
export function touchUserOnceToday(): void {
  try {
    const today = shanghaiTodayKey()
    if (wx.getStorageSync(TOUCH_STORAGE_KEY) === today) return
    void touchUser()
      .then(() => {
        wx.setStorageSync(TOUCH_STORAGE_KEY, today)
      })
      .catch(() => {})
  } catch (_error) {
    // 忽略：埋点失败不影响使用。
  }
}
