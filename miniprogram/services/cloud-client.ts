import type { ApiResult } from '../types/inventory'

const FALLBACK_ERROR_MESSAGE = '服务暂时不可用，请稍后重试'

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
        const message = error.errMsg?.includes('network')
          ? '网络连接失败，请检查网络后重试'
          : FALLBACK_ERROR_MESSAGE
        reject(new CloudServiceError('CLOUD_CALL_FAILED', message))
      },
    })
  })
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : FALLBACK_ERROR_MESSAGE
}
