'use strict'

const crypto = require('node:crypto')

function validateIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    const error = new Error('快速录入请求编号不正确')
    error.code = 'INVALID_ARGUMENT'
    throw error
  }
  return value.toLowerCase()
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function stableItemId(ownerId, idempotencyKey) {
  return `qe_${fingerprint(`${ownerId}:${idempotencyKey}`).slice(0, 29)}`
}

module.exports = { fingerprint, stableItemId, validateIdempotencyKey }
