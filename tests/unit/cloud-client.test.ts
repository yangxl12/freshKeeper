import { describe, expect, it } from 'vitest'

import { classifyCloudCallFailure } from '../../miniprogram/services/cloud-client'

describe('cloud call failures', () => {
  it('explains when cloud development is unavailable for the current app', () => {
    expect(
      classifyCloudCallFailure({
        errMsg:
          'cloud.callFunction:fail Error: errCode: -601034 | errMsg: 没有权限，请先开通云开发或者云托管',
      }),
    ).toEqual({
      code: 'CLOUD_NOT_ENABLED',
      message: '云开发尚未开通或当前账号无权限，请联系管理员处理',
    })
  })

  it('keeps network and unknown failures distinct', () => {
    expect(classifyCloudCallFailure({ errMsg: 'cloud.callFunction:fail network error' })).toEqual({
      code: 'NETWORK_ERROR',
      message: '网络连接失败，请检查网络后重试',
    })
    expect(classifyCloudCallFailure({ errMsg: 'cloud.callFunction:fail system error' })).toEqual({
      code: 'CLOUD_CALL_FAILED',
      message: '服务暂时不可用，请稍后重试',
    })
  })
})
