'use strict'

const crypto = require('node:crypto')
const { AppError } = require('./error')

function decodeKeyCursor(value, expectedSignature = '') {
  if (!value) return null
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (payload.v !== 3 || typeof payload.expiryDate !== 'string'
      || typeof payload.createdAt !== 'string' || typeof payload.id !== 'string' || !payload.id) {
      throw new Error('invalid')
    }
    if (expectedSignature && payload.signature !== expectedSignature) throw new Error('invalid')
    return { expiryDate: payload.expiryDate, createdAt: payload.createdAt, id: payload.id }
  } catch (_error) {
    throw new AppError('INVALID_CURSOR', '分页位置已失效，请刷新后重试')
  }
}

function encodeKeyCursor(after, sort, signature = '') {
  return Buffer.from(JSON.stringify({ v: 3, ...after, sort, signature })).toString('base64url')
}

function decodeCompletedCursor(value, expectedSignature) {
  if (!value) return null
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (payload.v !== 1 || payload.signature !== expectedSignature
      || typeof payload.completedAt !== 'string' || typeof payload.id !== 'string' || !payload.id) {
      throw new Error('invalid')
    }
    return { completedAt: payload.completedAt, id: payload.id }
  } catch (_error) {
    throw new AppError('INVALID_CURSOR', '分页位置已失效，请刷新后重试')
  }
}

function toIsoKey(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function encodeCompletedCursor(item, signature) {
  return Buffer.from(JSON.stringify({
    v: 1,
    completedAt: toIsoKey(item.completedAt),
    id: item._id,
    signature,
  })).toString('base64url')
}

function querySignature(values) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(values))
    .digest('base64url')
    .slice(0, 16)
}

module.exports = {
  decodeCompletedCursor,
  decodeKeyCursor,
  encodeCompletedCursor,
  encodeKeyCursor,
  querySignature,
  toIsoKey,
}
