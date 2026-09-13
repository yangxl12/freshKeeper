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
// 受控并发：原来 BATCH_SIZE 条事务/更新一次性 Promise.all（100 路），
// 同集合上容易触发事务冲突重试甚至限流。按文档 4.3 降到 10 路。
const CONCURRENCY = 10

/** 把 jobs（返回 Promise 的 thunk）按 CONCURRENCY 分批执行，单条失败不中断整批。 */
async function runInBatches(jobs) {
  const results = []
  for (let index = 0; index < jobs.length; index += CONCURRENCY) {
    const slice = await Promise.allSettled(jobs.slice(index, index + CONCURRENCY).map((job) => job()))
    results.push(...slice)
  }
  return results
}

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
    await runInBatches(result.data.map((item) => () =>
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
  const removed = await db.runTransaction(async (transaction) => {
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
  return { removed, coverFileId: removed ? item.coverFileId || '' : '' }
}

async function removeUnreferencedCovers(fileIDs) {
  const unique = [...new Set(fileIDs.filter(Boolean))]
  let deleted = 0
  for (const fileID of unique) {
    try {
      const references = await db.collection(ITEMS).where({ coverFileId: fileID }).limit(1).get()
      if (references.data.length) continue
      await cloud.deleteFile({ fileList: [fileID] })
      deleted += 1
    } catch (_error) {
      console.warn(JSON.stringify({ action: 'cleanupTrashCover', resultCode: 'FAILED' }))
    }
  }
  return deleted
}

exports.main = async () => {
  const context = cloud.getWXContext()
  if (context.OPENID) throw new Error('cleanupTrash only accepts timer triggers')
  const now = new Date()
  const migratedCount = await migrateLegacyTrash(now)
  let deletedCount = 0
  let deletedCoverCount = 0

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const items = await queryExpiredTrash(now)
    if (!items.length) break
    const results = await runInBatches(items.map((item) => () => removeTrashItem(item)))
    const removed = results
      .filter((result) => result.status === 'fulfilled' && result.value?.removed)
      .map((result) => result.value)
    const batchDeletedCount = removed.length
    deletedCoverCount += await removeUnreferencedCovers(removed.map((entry) => entry.coverFileId))
    deletedCount += batchDeletedCount
    if (batchDeletedCount === 0) break
    if (items.length < BATCH_SIZE) break
  }

  console.info(JSON.stringify({ action: 'cleanupTrash', migratedCount, deletedCount, deletedCoverCount }))
  return { migratedCount, deletedCount, deletedCoverCount }
}
