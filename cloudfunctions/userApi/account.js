'use strict'

const { AppError, assert } = require('./error')
const { currentDateKey, shanghaiDateKey, shouldTouchToday } = require('./date')
const { buildExportPayload } = require('./export')
const {
  avatarCloudPath,
  avatarOwnerHash,
  exportCloudPath,
  exportFileName,
  validateDeleteConfirm,
  validateProfileUpdate,
} = require('./validation')

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
/** 导出是重操作，按上海日期限次，计数落库（实例内存会被冷启动清空，不能用）。 */
const DAILY_EXPORT_LIMIT = 3

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

function createAccountService({ db, deleteFile, uploadFile }) {
  assert(db, 'INTERNAL_ERROR', '数据库未初始化')

  async function findUser(ownerId) {
    const result = await db.collection(USERS).where({ _id: ownerId, ownerId }).limit(1).get()
    return result.data[0] || null
  }

  /** 分批读全量，够用即可（单用户 <500 条假设）。超限报错，别静默截断。 */
  async function readAll(collectionName, where) {
    const rows = []
    let offset = 0
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const page = await db
        .collection(collectionName)
        .where(where)
        .skip(offset)
        .limit(ITEM_PAGE_SIZE)
        .get()
      rows.push(...page.data)
      offset += page.data.length
      if (page.data.length < ITEM_PAGE_SIZE) return rows
    }
    throw new AppError('DELETE_INCOMPLETE', '数据较多，请重新再试一次')
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

  /** 换头像后旧图就是孤儿文件；删失败只记日志，绝不回滚更新、不打扰用户（注销时按前缀统一清）。 */
  async function removeOldAvatar(oldFileId) {
    if (!oldFileId || typeof deleteFile !== 'function') return
    try {
      await deleteFile({ fileList: [oldFileId] })
    } catch (error) {
      console.warn(
        JSON.stringify({ action: 'updateProfile', resultCode: 'AVATAR_CLEANUP_FAILED' }),
      )
    }
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
    const next = await getProfile(ownerId)
    const oldAvatar = current?.avatarFileId
    if (typeof normalized.avatarFileId === 'string' && oldAvatar && oldAvatar !== normalized.avatarFileId) {
      await removeOldAvatar(oldAvatar)
    }
    return next
  }

  /** 客户端先拿 cloudPath 再 wx.cloud.uploadFile；路径里只放 openid 哈希。 */
  function createAvatarUpload(ownerId, input) {
    const ext = input && typeof input.ext === 'string' ? input.ext : 'png'
    return { cloudPath: avatarCloudPath(avatarOwnerHash(ownerId), ext) }
  }

  async function exportData(ownerId, now = new Date()) {
    assert(typeof uploadFile === 'function', 'INTERNAL_ERROR', '云存储未初始化')
    const user = await findUser(ownerId)
    const today = currentDateKey(now)
    const used = user && user.exportCountDate === today ? Number(user.exportCount) || 0 : 0
    assert(used < DAILY_EXPORT_LIMIT, 'EXPORT_LIMIT_EXCEEDED', '今天导出次数已用完，明天再试')

    const items = await readAll(ITEMS, { ownerId })
    const reminders = await readAll(REMINDERS, { ownerId })
    const settingsPage = await db.collection(SETTINGS).where({ ownerId }).limit(1).get()
    const payload = buildExportPayload({
      items,
      settings: settingsPage.data[0] || null,
      user,
      reminders,
      exportedAt: shanghaiDateKey(now),
    })

    const fileName = exportFileName(now)
    // 云函数响应体有大小上限，导出一律走云存储中转，客户端拿 fileID 自己下载。
    const uploaded = await uploadFile({
      cloudPath: exportCloudPath(avatarOwnerHash(ownerId), now),
      fileContent: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
    })
    const fileID = uploaded?.fileID
    assert(typeof fileID === 'string' && fileID, 'EXPORT_FAILED', '导出文件生成失败')

    await db.collection(USERS).where({ _id: ownerId, ownerId }).update({
      data: {
        lastExportedAt: db.serverDate(),
        exportCountDate: today,
        exportCount: used + 1,
      },
    })
    return { fileID, fileName }
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
    const user = await findUser(ownerId)
    const fileIds = await collectCoverFileIds(ownerId)
    // 头像不在物品里，得单独带上；exports/ 下的临时文件下载完即删，不在此列。
    if (user && typeof user.avatarFileId === 'string' && user.avatarFileId) {
      fileIds.push(user.avatarFileId)
    }
    const files = await deleteCoverFiles(fileIds)
    const items = await removeAll(ITEMS, { ownerId })
    const reminders = await removeAll(REMINDERS, { ownerId })
    const settings = await removeAll(SETTINGS, { ownerId })
    // _id 就是 openid，按主键删；删掉后重新进入会重新 touch 出一条空档案。
    await removeAll(USERS, { _id: ownerId })
    return { deleted: { items, reminders, settings, files } }
  }

  return { createAvatarUpload, deleteAccount, exportData, getProfile, touch, updateProfile }
}

module.exports = { chunk, createAccountService }
