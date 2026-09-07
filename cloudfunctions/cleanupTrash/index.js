'use strict'

const cloud = require('wx-server-sdk')
const { RETENTION_MS, shouldPurgeTrash } = require('./rules')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const command = db.command
const ITEMS = 'inventory_items'
const REMINDERS = 'reminder_jobs'
const BATCH_SIZE = 100
const MAX_BATCHES = 10

async function queryExpiredTrash(now) {
  const result = await db
    .collection(ITEMS)
    .where({ inventoryStatus: 'deleted', purgeAfter: command.lte(now) })
    .limit(BATCH_SIZE)
    .get()
  return result.data
}

async function migrateLegacyTrash(now) {
  let migratedCount = 0
  const purgeAfter = new Date(now.getTime() + RETENTION_MS)
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await db
      .collection(ITEMS)
      .where({ inventoryStatus: 'discarded' })
      .limit(BATCH_SIZE)
      .get()
    if (!result.data.length) break
    await Promise.all(result.data.map((item) =>
      db.collection(ITEMS).where({ _id: item._id, inventoryStatus: 'discarded' }).update({
        data: {
          inventoryStatus: 'deleted',
          deletedAt: db.serverDate(),
          purgeAfter,
          version: command.inc(1),
          updatedAt: db.serverDate(),
        },
      }),
    ))
    migratedCount += result.data.length
    if (result.data.length < BATCH_SIZE) break
  }
  return migratedCount
}

async function removeTrashItem(item) {
  return db.runTransaction(async (transaction) => {
    const result = await transaction.collection(ITEMS).doc(item._id).get()
    const current = result.data
    if (!current || current.inventoryStatus !== 'deleted') return false

    if (!shouldPurgeTrash(current)) return false

    await transaction.collection(ITEMS).doc(item._id).remove()
    const reminder = await transaction
      .collection(REMINDERS)
      .where({ _id: item._id, ownerId: current.ownerId })
      .limit(1)
      .get()
    if (reminder.data.length) await transaction.collection(REMINDERS).doc(item._id).remove()
    return true
  })
}

exports.main = async () => {
  const context = cloud.getWXContext()
  if (context.OPENID) throw new Error('cleanupTrash only accepts timer triggers')
  const now = new Date()
  const migratedCount = await migrateLegacyTrash(now)
  let deletedCount = 0

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const items = await queryExpiredTrash(now)
    if (!items.length) break
    const results = await Promise.allSettled(items.map(removeTrashItem))
    const batchDeletedCount = results.filter(
      (result) => result.status === 'fulfilled' && result.value,
    ).length
    deletedCount += batchDeletedCount
    if (batchDeletedCount === 0) break
    if (items.length < BATCH_SIZE) break
  }

  console.info(JSON.stringify({ action: 'cleanupTrash', migratedCount, deletedCount }))
  return { migratedCount, deletedCount }
}
