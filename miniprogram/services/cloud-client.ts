import type { ApiResult } from '../types/inventory'

const FALLBACK_ERROR_MESSAGE = '服务暂时不可用，请稍后重试'
const CLOUD_NOT_ENABLED_MESSAGE = '云开发尚未开通或当前账号无权限，请联系管理员处理'

interface CloudCallFailure {
  code: string
  message: string
}

export function classifyCloudCallFailure(error: unknown): CloudCallFailure {
  const errMsg =
    error && typeof error === 'object' && 'errMsg' in error
      ? String((error as { errMsg?: unknown }).errMsg || '')
      : ''

  if (errMsg.includes('network')) {
    return { code: 'NETWORK_ERROR', message: '网络连接失败，请检查网络后重试' }
  }

  if (
    errMsg.includes('-601034') ||
    errMsg.includes('没有权限，请先开通云开发') ||
    errMsg.includes('没有权限，请先开通云开发或者云托管')
  ) {
    return { code: 'CLOUD_NOT_ENABLED', message: CLOUD_NOT_ENABLED_MESSAGE }
  }

  return { code: 'CLOUD_CALL_FAILED', message: FALLBACK_ERROR_MESSAGE }
}

export class CloudServiceError extends Error {
  readonly code: string
  readonly requestId?: string

  constructor(code: string, message: string, requestId?: string) {
    super(message)
    this.name = 'CloudServiceError'
    this.code = code
    this.requestId = requestId
  }
}

export function callCloud<T>(name: string, data: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success(response) {
        const result = response.result as ApiResult<T> | undefined
        if (!result || typeof result !== 'object' || !('ok' in result)) {
          reject(new CloudServiceError('INVALID_RESPONSE', FALLBACK_ERROR_MESSAGE))
          return
        }
        if (!result.ok) {
          reject(
            new CloudServiceError(
              result.error.code,
              result.error.message || FALLBACK_ERROR_MESSAGE,
              result.requestId,
            ),
          )
          return
        }
        resolve(result.data)
      },
      fail(error) {
        const failure = classifyCloudCallFailure(error)
        reject(new CloudServiceError(failure.code, failure.message))
      },
    })
  })
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : FALLBACK_ERROR_MESSAGE
}
