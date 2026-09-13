'use strict'

const crypto = require('node:crypto')

const USAGE = 'ai_usage_daily'
const DEFAULT_USER_LIMIT = 5
const DEFAULT_GLOBAL_LIMIT = 100

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function usageId(scope, ownerId, dateKey) {
  const subject = scope === 'global'
    ? 'global'
    : crypto.createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 32)
  return `cover-image-${dateKey}-${subject}`
}

async function consumeCoverQuota(db, ownerId, dateKey) {
  const userLimit = positiveIntegerEnv('COVER_IMAGE_DAILY_LIMIT', DEFAULT_USER_LIMIT)
  const globalLimit = positiveIntegerEnv('COVER_IMAGE_GLOBAL_DAILY_LIMIT', DEFAULT_GLOBAL_LIMIT)
  const userId = usageId('user', ownerId, dateKey)
  const globalId = usageId('global', ownerId, dateKey)
  return db.runTransaction(async (transaction) => {
    const result = await transaction.collection(USAGE)
      .where({ _id: db.command.in([userId, globalId]) })
      .get()
    const byId = new Map((result.data || []).map((entry) => [entry._id, entry]))
    const used = Number(byId.get(userId)?.count) || 0
    const globalUsed = Number(byId.get(globalId)?.count) || 0
    if (used >= userLimit || globalUsed >= globalLimit) {
      return { allowed: false, used, userLimit, globalUsed, globalLimit }
    }
    await transaction.collection(USAGE).doc(userId).set({
      data: { kind: 'cover_image', scope: 'user', ownerId, dateKey, count: used + 1, updatedAt: db.serverDate() },
    })
    await transaction.collection(USAGE).doc(globalId).set({
      data: { kind: 'cover_image', scope: 'global', dateKey, count: globalUsed + 1, updatedAt: db.serverDate() },
    })
    return { allowed: true, used: used + 1, userLimit, globalUsed: globalUsed + 1, globalLimit }
  })
}

module.exports = { consumeCoverQuota, positiveIntegerEnv, usageId }
