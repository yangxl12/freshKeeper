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
/**
 * 导出是重操作，按上海日期限次，计数落库（实例内存会被冷启动清空，不能用）。
 * **计的是「交付成功」而不是「生成」**：生成完没转发出去不该占额度，
 * 否则一次转发失败就白扣一次，三次下来当天彻底用不了（转发本来就要用户再点一次）。
 */
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

  /** 今天已经交付成功的次数；跨天归零。旧字段 exportCount 语义不同，一律不读。 */
  function deliveredToday(user, today) {
    if (!user || user.exportDeliveredDate !== today) return 0
    return Number(user.exportDeliveredCount) || 0
  }

  /**
   * 挂着的待交付导出文件（不分日期）。
   * **故意用扁平字段**：云数据库的 update 会把对象值当成嵌套路径去写，
   * 字段当前是 null 时会直接报 `Cannot create field 'x' in element {y: null}` 写不进去。
   */
  function pendingFileOf(user) {
    const fileID = user && user.exportPendingFileId
    if (typeof fileID !== 'string' || !fileID) return null
    return { fileID, fileName: user.exportPendingFileName || '' }
  }

  /** 今天生成过但还没交付的文件：原样复用，不重新生成也不占额度。 */
  function pendingExportOf(user, today) {
    const pending = pendingFileOf(user)
    if (!pending) return null
    return user.exportPendingDate === today ? pending : null
  }

  /** 删导出文件失败只记日志：孤儿文件不影响用户，更不该把交付算成失败。 */
  async function removeExportFile(fileID) {
    if (typeof deleteFile !== 'function') return
    try {
      await deleteFile({ fileList: [fileID] })
    } catch (error) {
      console.warn(JSON.stringify({ action: 'exportFileCleanup', resultCode: 'FAILED' }))
    }
  }

  async function exportData(ownerId, now = new Date()) {
    assert(typeof uploadFile === 'function', 'INTERNAL_ERROR', '云存储未初始化')
    const user = await findUser(ownerId)
    const today = currentDateKey(now)

    // 还没交付的文件直接给回去。客户端重试因此不再扣额度，云存储里也不会堆副本。
    const pending = pendingExportOf(user, today)
    if (pending) return { fileID: pending.fileID, fileName: pending.fileName }

    assert(
      deliveredToday(user, today) < DAILY_EXPORT_LIMIT,
      'EXPORT_LIMIT_EXCEEDED',
      '今天导出次数已用完，明天再试',
    )

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

    // 先落库再删旧文件：反过来一旦写库失败，用户会拿到一个已经被删掉的 fileID。
    const stale = pendingFileOf(user)
    await db.collection(USERS).where({ _id: ownerId, ownerId }).update({
      data: {
        lastExportedAt: db.serverDate(),
        exportPendingFileId: fileID,
        exportPendingFileName: fileName,
        exportPendingDate: today,
      },
    })
    // 上一次生成、既没交付又已经过期的那份顺手清掉，别在云存储里留孤儿。
    if (stale && stale.fileID !== fileID) await removeExportFile(stale.fileID)
    return { fileID, fileName }
  }

  /**
   * 客户端转发成功后回报一次：清掉待交付文件 + 记一次额度。
   * 幂等——没有待交付文件时（重复回报、已被清理）直接返回，不重复计数。
   */
  async function confirmExport(ownerId, now = new Date()) {
    const user = await findUser(ownerId)
    const pending = pendingFileOf(user)
    if (!pending) return { delivered: false }
    const today = currentDateKey(now)
    // 先落库再删文件。反过来的话，删完文件却写库失败，用户下次会拿到一个已经不存在的 fileID。
    await db.collection(USERS).where({ _id: ownerId, ownerId }).update({
      data: {
        exportDeliveredDate: today,
        exportDeliveredCount: deliveredToday(user, today) + 1,
        exportPendingFileId: null,
        exportPendingFileName: null,
        exportPendingDate: null,
      },
    })
    await removeExportFile(pending.fileID)
    return { delivered: true }
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
    // 头像不在物品里，得单独带上；还没交付的导出文件也在这清，别给注销用户留云端副本。
    if (user && typeof user.avatarFileId === 'string' && user.avatarFileId) {
      fileIds.push(user.avatarFileId)
    }
    const pendingFileId = pendingFileOf(user)?.fileID
    if (pendingFileId) {
      fileIds.push(pendingFileId)
    }
    const files = await deleteCoverFiles(fileIds)
    const items = await removeAll(ITEMS, { ownerId })
    const reminders = await removeAll(REMINDERS, { ownerId })
    const settings = await removeAll(SETTINGS, { ownerId })
    // _id 就是 openid，按主键删；删掉后重新进入会重新 touch 出一条空档案。
    await removeAll(USERS, { _id: ownerId })
    return { deleted: { items, reminders, settings, files } }
  }

  return { confirmExport, createAvatarUpload, deleteAccount, exportData, getProfile, touch, updateProfile }
}

module.exports = { chunk, createAccountService }
