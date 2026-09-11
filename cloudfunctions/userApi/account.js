'use strict'

const { AppError, assert } = require('./error')
const { currentDateKey, shanghaiDateKey, shouldTouchToday } = require('./date')
const { validateDeleteConfirm, validateProfileUpdate } = require('./validation')

const USERS = 'users'
const ITEMS = 'inventory_items'
const REMINDERS = 'reminder_jobs'
const SETTINGS = 'user_settings'

const SCHEMA_VERSION = 1
/** 平台限制：单次 deleteFile 最多 50 个 fileID。 */
const FILE_BATCH_SIZE = 50
const ITEM_PAGE_SIZE = 100
/** 分批删除的最大轮次；超限直接报错让用户重试（重试天然幂等）。 */
const MAX_ROUNDS = 20

function chunk(list, size) {
  const step = Math.max(1, Math.floor(size) || 1)
  const result = []
  for (let index = 0; index < list.length; index += step) {
    result.push(list.slice(index, index + step))
  }
  return result
}

function removedCount(result) {
  return result?.stats?.removed ?? 0
}

function createAccountService({ db, deleteFile }) {
  assert(db, 'INTERNAL_ERROR', '数据库未初始化')

  async function findUser(ownerId) {
    const result = await db.collection(USERS).where({ _id: ownerId, ownerId }).limit(1).get()
    return result.data[0] || null
  }

  // 对外一律吐日期串（Asia/Shanghai），Date / 时间戳都不出云函数。
  function publicProfile(doc) {
    if (!doc) return { nickname: null, avatarFileId: null, createdAt: null, lastSeenAt: null }
    return {
      nickname: doc.nickname ?? null,
      avatarFileId: doc.avatarFileId ?? null,
      createdAt: shanghaiDateKey(doc.createdAt) || null,
      lastSeenAt: shanghaiDateKey(doc.lastSeenAt) || null,
    }
  }

  async function touch(ownerId, now = new Date()) {
    const today = currentDateKey(now)
    const current = await findUser(ownerId)

    if (!current) {
      await db.collection(USERS).doc(ownerId).set({
        data: {
          ownerId,
          nickname: null,
          avatarFileId: null,
          createdAt: db.serverDate(),
          lastSeenAt: db.serverDate(),
          schemaVersion: SCHEMA_VERSION,
        },
      })
      return { created: true, lastSeenAt: today }
    }

    // 今天已经记过了：直接返回，不写库（客户端还有一层同日节流，这是服务端兜底）。
    if (!shouldTouchToday(current.lastSeenAt, today)) {
      return { created: false, lastSeenAt: shanghaiDateKey(current.lastSeenAt) || today }
    }

    await db
      .collection(USERS)
      .where({ _id: ownerId, ownerId })
      .update({ data: { lastSeenAt: db.serverDate() } })
    return { created: false, lastSeenAt: today }
  }

  async function getProfile(ownerId) {
    return publicProfile(await findUser(ownerId))
  }

  async function updateProfile(ownerId, input) {
    const normalized = validateProfileUpdate(input, ownerId)
    const current = await findUser(ownerId)
    if (current) {
      await db.collection(USERS).where({ _id: ownerId, ownerId }).update({ data: normalized })
    } else {
      await db.collection(USERS).doc(ownerId).set({
        data: {
          ownerId,
          nickname: null,
          avatarFileId: null,
          createdAt: db.serverDate(),
          lastSeenAt: db.serverDate(),
          schemaVersion: SCHEMA_VERSION,
          ...normalized,
        },
      })
    }
    return getProfile(ownerId)
  }

  /** 先把封面 fileID 收集完，删了库就再也读不到了。 */
  async function collectCoverFileIds(ownerId) {
    const fileIds = []
    let offset = 0
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const page = await db
        .collection(ITEMS)
        .where({ ownerId })
        .skip(offset)
        .limit(ITEM_PAGE_SIZE)
        .get()
      for (const item of page.data) {
        if (typeof item.coverFileId === 'string' && item.coverFileId) {
          fileIds.push(item.coverFileId)
        }
      }
      offset += page.data.length
      if (page.data.length < ITEM_PAGE_SIZE) return fileIds
    }
    throw new AppError('DELETE_INCOMPLETE', '数据较多，请重新再试一次')
  }

  async function deleteCoverFiles(fileIds) {
    let deleted = 0
    for (const batch of chunk(fileIds, FILE_BATCH_SIZE)) {
      const result = await deleteFile({ fileList: batch })
      const list = result?.fileList
      if (Array.isArray(list)) {
        deleted += list.filter((entry) => entry && entry.status !== -1).length
      } else {
        deleted += batch.length
      }
    }
    return deleted
  }

  async function removeAll(collectionName, where) {
    let total = 0
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const removed = removedCount(await db.collection(collectionName).where(where).remove())
      total += removed
      if (removed === 0) return total
    }
    throw new AppError('DELETE_INCOMPLETE', '数据较多，请重新再试一次')
  }

  /**
   * 顺序不能改：收集 fileID → 删云存储 → 删数据库。
   * 删干净后再调一次是空删，天然幂等，不留墓碑（墓碑本身就是残留个人信息）。
   */
  async function deleteAccount(ownerId, input) {
    validateDeleteConfirm(input)
    const fileIds = await collectCoverFileIds(ownerId)
    const files = await deleteCoverFiles(fileIds)
    const items = await removeAll(ITEMS, { ownerId })
    const reminders = await removeAll(REMINDERS, { ownerId })
    const settings = await removeAll(SETTINGS, { ownerId })
    // _id 就是 openid，按主键删；删掉后重新进入会重新 touch 出一条空档案。
    await removeAll(USERS, { _id: ownerId })
    return { deleted: { items, reminders, settings, files } }
  }

  return { deleteAccount, getProfile, touch, updateProfile }
}

module.exports = { chunk, createAccountService }
