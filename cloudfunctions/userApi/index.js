'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')
const { AppError, assert, normalizeError } = require('./error')
const { assertNoClientIdentity } = require('./validation')
const { createAccountService } = require('./account')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const service = createAccountService({
  db,
  deleteFile: (input) => cloud.deleteFile(input),
  uploadFile: (input) => cloud.uploadFile(input),
})

const handlers = {
  touch: (ownerId) => service.touch(ownerId),
  get: (ownerId) => service.getProfile(ownerId),
  createAvatarUpload: (ownerId, event) => service.createAvatarUpload(ownerId, event.data),
  updateProfile: (ownerId, event) => service.updateProfile(ownerId, event.data),
  exportData: (ownerId) => service.exportData(ownerId),
  confirmExport: (ownerId) => service.confirmExport(ownerId),
  deleteAccount: (ownerId, event) => service.deleteAccount(ownerId, event.data),
}

exports.main = async (event = {}) => {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  const action = event && typeof event.action === 'string' ? event.action : ''
  try {
    assertNoClientIdentity(event)
    const ownerId = cloud.getWXContext().OPENID
    assert(ownerId, 'UNAUTHENTICATED', '请在微信中重新打开小程序')
    const handler = handlers[action]
    assert(handler, 'INVALID_ACTION', '不支持的账号操作')
    const data = await handler(ownerId, event)
    console.info(JSON.stringify({ requestId, action, resultCode: 'OK', durationMs: Date.now() - startedAt }))
    return { ok: true, data, requestId }
  } catch (error) {
    const safeError = normalizeError(error)
    console.warn(JSON.stringify({ requestId, action, resultCode: safeError.code, durationMs: Date.now() - startedAt }))
    return {
      ok: false,
      error: { code: safeError.code, message: safeError.message },
      requestId,
    }
  }
}
