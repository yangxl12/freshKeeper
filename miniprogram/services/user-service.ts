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

/** 转发成功后回报云端（清待交付文件 + 记额度）。失败静默：文件已经在用户手里了。 */
export function confirmExport(): void {
  void callCloud('userApi', { action: 'confirmExport' }).catch(() => {})
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

export interface PreparedExport {
  fileID: string
  fileName: string
  tempFilePath: string
}

/**
 * 生成导出文件并下载到本地。
 *
 * 只能做到这一步是有原因的：`wx.shareFileMessage` **只认 TAP 手势**，
 * 前面一旦 await 过任何东西就会报
 * `shareFileMessage:fail can only be invoked by user TAP gesture.`，
 * 所以转发必须由用户再点一次按钮触发，见 sharePreparedExport。
 */
export async function prepareExport(): Promise<PreparedExport> {
  const { fileID, fileName } = await exportData()
  const tempFilePath = await downloadExportFile(fileID)
  return { fileID, fileName, tempFilePath }
}

/**
 * 转发已经下载到本地的导出文件。
 *
 * **必须在点击事件的同步调用栈里直接调用，中间不能有任何 await**，否则手势上下文失效。
 * 返回 true 表示真的转发出去了；用户取消返回 false（不算失败，本地文件还在，可以再点一次）。
 */
export function sharePreparedExport(tempFilePath: string, fileName: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath: tempFilePath,
      fileName,
      success: () => resolve(true),
      fail: (error) => {
        const errMsg = String((error as { errMsg?: string }).errMsg || '')
        if (errMsg.includes('cancel')) {
          resolve(false)
          return
        }
        // 开发者工具压根不支持这个接口，别让在模拟器里调试的人以为功能坏了。
        if (errMsg.includes('开发者工具')) {
          reject(new Error('微信开发者工具不支持转发文件，请用真机预览试'))
          return
        }
        reject(new Error('转发没有完成，可以再点一次重试'))
      },
    })
  })
}

/** 清本地临时文件。云端那份由 confirmExport 负责删，客户端没有权限也没有必要碰。 */
export function discardLocalExport(tempFilePath: string): void {
  try {
    wx.getFileSystemManager().unlink({ filePath: tempFilePath, fail: () => undefined })
  } catch (error) {
    // 临时文件清不掉无所谓，系统会回收。
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
