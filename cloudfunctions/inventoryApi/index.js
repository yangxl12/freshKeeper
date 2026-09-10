'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')
const { addDays, currentDateKey, getExpiryPresentation } = require('./date')
const { AppError, assert, normalizeError } = require('./error')
const {
  canMoveInventoryToTrash,
  canTransitionInventory,
  getDecrementDecision,
} = require('./rules')
const {
  assertNoClientIdentity,
  validateBatchItems,
  validateDecrementAmount,
  validateHistoryStatus,
  validateInventoryViewStatus,
  validateItemId,
  validateIdempotencyKey,
  validateInventorySort,
  validateOptionalCategory,
  validateOptionalStorage,
  validatePageSize,
  validateSaveInput,
  validateSearch,
  validateVersion,
} = require('./validation')
const { readRecentProfiles } = require('./recent')
const { fingerprint, stableItemId } = require('./idempotency')
const { coverEnabled, createCoverService } = require('./image-cover')

// 懒加载 wx-server-sdk 的 ai/上传能力；单测注入假依赖时不会加载真 SDK。
const generateCoverImage = createCoverService({})

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const command = db.command
const ITEMS = 'inventory_items'
const REMINDERS = 'reminder_jobs'

const CATEGORY_LABELS = {
  food: '食品',
  medicine: '药品',
  household: '日化',
  other: '其他',
}
const STORAGE_LABELS = {
  refrigerated: '冷藏',
  frozen: '冷冻',
  cabinet: '橱柜',
  medicine_box: '药箱',
  other: '其他',
}
const STATUS_LABELS = {
  active: '使用中',
  used_up: '已用完',
  deleted: '已删除',
  discarded: '已删除',
}

const TRASH_RETENTION_DAYS = 30

function shanghaiDateKey(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function getPurgeDateText(item) {
  if (item.purgeAfter) return shanghaiDateKey(item.purgeAfter)
  return ''
}

function publicItem(item, today, extra = {}) {
  const {
    ownerId: _ownerId,
    searchName: _searchName,
    creationRequestId: _creationRequestId,
    creationFingerprint: _creationFingerprint,
    ...safeItem
  } = item
  return {
    ...safeItem,
    ...getExpiryPresentation(item.expiryDate, today),
    categoryLabel: CATEGORY_LABELS[item.category] || '其他',
    storageLabel: STORAGE_LABELS[item.storageLocation] || item.storageLocation || '未填写',
    inventoryStatusLabel: STATUS_LABELS[item.inventoryStatus] || '未知',
    purgeDateText: getPurgeDateText(item),
    ...extra,
  }
}

async function listRecentProfiles(ownerId) {
  return readRecentProfiles(async (inventoryStatus, offset, limit) => {
    const result = await db.collection(ITEMS).where({ ownerId, inventoryStatus })
      .orderBy('updatedAt', 'desc').skip(offset).limit(limit).get()
    return result.data
  })
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeCursor(value, expectedSignature = '') {
  if (!value) return 0
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Number.isInteger(payload.offset) || payload.offset < 0 || payload.offset > 10_000) {
      throw new Error('invalid')
    }
    if (expectedSignature && payload.signature !== expectedSignature) throw new Error('invalid')
    return payload.offset
  } catch (_error) {
    throw new AppError('INVALID_CURSOR', '分页位置已失效，请刷新后重试')
  }
}

function encodeCursor(offset, signature = '') {
  const payload = signature ? { offset, signature } : { offset }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function querySignature(values) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(values))
    .digest('base64url')
    .slice(0, 16)
}

async function getOwnedItem(ownerId, itemId) {
  const result = await db.collection(ITEMS).where({ _id: itemId, ownerId }).limit(1).get()
  if (!result.data.length) throw new AppError('NOT_FOUND', '物品不存在或已被删除')
  return result.data[0]
}

function updatedCount(result) {
  return result?.stats?.updated ?? result?.updated ?? 0
}

async function getTransactionOwnedDoc(transaction, collectionName, ownerId, id) {
  const result = await transaction
    .collection(collectionName)
    .where({ _id: id, ownerId })
    .limit(1)
    .get()
  return result.data[0] || null
}

async function cancelPendingReminder(transaction, ownerId, itemId, remove = false) {
  const job = await getTransactionOwnedDoc(transaction, REMINDERS, ownerId, itemId)
  if (!job) return
  if (remove) {
    await transaction.collection(REMINDERS).doc(itemId).remove()
    return
  }
  if (!['scheduled', 'failed', 'cancelled'].includes(job.status)) return
  await transaction.collection(REMINDERS).doc(itemId).update({
    data: {
      status: 'cancelled',
      updatedAt: db.serverDate(),
    },
  })
}

async function listActive(ownerId, event) {
  const today = currentDateKey()
  const search = validateSearch(event.search)
  const category = validateOptionalCategory(event.category)
  const storageLocation = validateOptionalStorage(event.storageLocation)
  const pageSize = validatePageSize(event.pageSize)
  const offset = decodeCursor(event.cursor)
  const where = { ownerId, inventoryStatus: 'active' }
  if (category) where.category = category
  if (storageLocation) where.storageLocation = storageLocation
  if (search) {
    where.searchName = db.RegExp({ regexp: escapeRegExp(search), options: 'i' })
  }

  const [pageResult, totalResult, expiredResult, expiringResult] = await Promise.all([
    db
      .collection(ITEMS)
      .where(where)
      .orderBy('expiryDate', 'asc')
      .orderBy('createdAt', 'desc')
      .skip(offset)
      .limit(pageSize + 1)
      .get(),
    db.collection(ITEMS).where({ ownerId, inventoryStatus: 'active' }).count(),
    db
      .collection(ITEMS)
      .where({ ownerId, inventoryStatus: 'active', expiryDate: command.lt(today) })
      .count(),
    db
      .collection(ITEMS)
      .where({
        ownerId,
        inventoryStatus: 'active',
        expiryDate: command.gte(today).and(command.lte(addDays(today, 7))),
      })
      .count(),
  ])

  const hasMore = pageResult.data.length > pageSize
  const items = pageResult.data.slice(0, pageSize).map((item) => publicItem(item, today))
  return {
    items,
    overview: {
      expired: expiredResult.total,
      expiringWithin7Days: expiringResult.total,
      activeTotal: totalResult.total,
    },
    nextCursor: hasMore ? encodeCursor(offset + pageSize) : null,
    serverToday: today,
  }
}

async function getOverview(ownerId) {
  const today = currentDateKey()
  const expiringEnd = addDays(today, 7)
  const [activeResult, expiredResult, expiringResult, usedUpResult] = await Promise.all([
    db.collection(ITEMS).where({ ownerId, inventoryStatus: 'active' }).count(),
    db
      .collection(ITEMS)
      .where({ ownerId, inventoryStatus: 'active', expiryDate: command.lt(today) })
      .count(),
    db
      .collection(ITEMS)
      .where({
        ownerId,
        inventoryStatus: 'active',
        expiryDate: command.gte(today).and(command.lte(expiringEnd)),
      })
      .count(),
    db.collection(ITEMS).where({ ownerId, inventoryStatus: 'used_up' }).count(),
  ])

  return {
    activeTotal: activeResult.total,
    expired: expiredResult.total,
    expiringWithin7Days: expiringResult.total,
    usedUpTotal: usedUpResult.total,
    safe: Math.max(0, activeResult.total - expiredResult.total - expiringResult.total),
    serverToday: today,
  }
}

async function listInventory(ownerId, event) {
  const today = currentDateKey()
  const search = validateSearch(event.search)
  const category = validateOptionalCategory(event.category)
  const viewStatus = validateInventoryViewStatus(event.viewStatus)
  const sort = validateInventorySort(event.sort)
  const pageSize = validatePageSize(event.pageSize)
  const signature = querySignature({ search, category, viewStatus, sort, pageSize })
  const offset = decodeCursor(event.cursor, signature)
  const conditions = [
    { ownerId },
    { inventoryStatus: viewStatus === 'used_up' ? 'used_up' : 'active' },
  ]
  if (category) conditions.push({ category })
  if (viewStatus === 'expired') {
    conditions.push({ expiryDate: command.lt(today) })
  } else if (viewStatus === 'expiring') {
    conditions.push({ expiryDate: command.gte(today).and(command.lte(addDays(today, 7))) })
  } else if (viewStatus === 'safe') {
    conditions.push({ expiryDate: command.gt(addDays(today, 7)) })
  }

  let where = command.and(conditions)
  if (search) {
    // 名称与存放位置任一命中即可；同时覆盖历史记录和位置中文标签。
    const keyword = db.RegExp({ regexp: escapeRegExp(search), options: 'i' })
    where = command.and([
      where,
      command.or([
        { name: keyword },
        { searchName: keyword },
        { storageLocation: keyword },
        ...Object.entries(STORAGE_LABELS)
          .filter(([, label]) => label.toLocaleLowerCase('zh-CN').includes(search))
          .map(([value]) => ({ storageLocation: value })),
      ]),
    ])
  }

  let query = db.collection(ITEMS).where(where)
  if (sort === 'created_asc' || sort === 'created_desc') {
    query = query.orderBy('createdAt', sort === 'created_asc' ? 'asc' : 'desc')
  } else {
    query = query
      .orderBy('expiryDate', sort === 'expiry_desc' ? 'desc' : 'asc')
      .orderBy('createdAt', 'desc')
  }
  const result = await query.skip(offset).limit(pageSize + 1).get()
  const hasMore = result.data.length > pageSize
  return {
    items: result.data.slice(0, pageSize).map((item) => publicItem(item, today)),
    nextCursor: hasMore ? encodeCursor(offset + pageSize, signature) : null,
    serverToday: today,
  }
}

async function get(ownerId, event) {
  const itemId = validateItemId(event.itemId)
  const item = await getOwnedItem(ownerId, itemId)
  const reminderResult = await db
    .collection(REMINDERS)
    .where({ _id: itemId, ownerId })
    .limit(1)
    .get()
  return publicItem(item, currentDateKey(), {
    reminderStatus: reminderResult.data[0]?.status || null,
  })
}

async function save(ownerId, event) {
  const input = event.data
  const normalized = validateSaveInput(input)
  if (!input.itemId) {
    assert(input.version === undefined, 'INVALID_ARGUMENT', '新增物品不能包含记录版本')
    if (event.idempotencyKey !== undefined) {
      const idempotencyKey = validateIdempotencyKey(event.idempotencyKey)
      return saveIdempotent(ownerId, idempotencyKey, normalized)
    }
    const result = await db.collection(ITEMS).add({
      data: {
        ownerId,
        ...normalized,
        inventoryStatus: 'active',
        version: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        completedAt: null,
      },
    })
    return { itemId: result._id, version: 1, expiryDate: normalized.expiryDate }
  }

  assert(event.idempotencyKey === undefined, 'INVALID_ARGUMENT', '编辑物品不能包含快速录入请求编号')

  const itemId = validateItemId(input.itemId)
  const version = validateVersion(input.version)
  await getOwnedItem(ownerId, itemId)
  await db.runTransaction(async (transaction) => {
    const current = await getTransactionOwnedDoc(transaction, ITEMS, ownerId, itemId)
    assert(current, 'NOT_FOUND', '物品不存在或已被删除')
    assert(current.inventoryStatus === 'active', 'INVALID_STATE', '已处理物品不能再次编辑')
    assert(current.version === version, 'CONFLICT', '记录已更新，请刷新后重试')

    await transaction.collection(ITEMS).doc(itemId).update({
      data: {
        ...normalized,
        version: version + 1,
        updatedAt: db.serverDate(),
      },
    })

    const reminder = await getTransactionOwnedDoc(transaction, REMINDERS, ownerId, itemId)
    if (
      reminder &&
      ['scheduled', 'failed', 'cancelled'].includes(reminder.status)
    ) {
      await transaction.collection(REMINDERS).doc(itemId).update({
        data: {
          remindDate: addDays(normalized.expiryDate, -normalized.reminderLeadDays),
          updatedAt: db.serverDate(),
        },
      })
    }
  })
  return { itemId, version: version + 1, expiryDate: normalized.expiryDate }
}

async function saveIdempotent(ownerId, idempotencyKey, normalized) {
  const creationFingerprint = fingerprint(normalized)
  const creationRequestId = fingerprint(`${ownerId}:${idempotencyKey}`)
  const itemId = stableItemId(ownerId, idempotencyKey)
  const resolveExisting = (existing) => {
    assert(existing.ownerId === ownerId, 'IDEMPOTENCY_COLLISION', '快速录入请求编号发生冲突，请重新录入')
    assert(existing.creationRequestId === creationRequestId, 'IDEMPOTENCY_COLLISION', '快速录入请求编号发生冲突，请重新录入')
    assert(existing.creationFingerprint === creationFingerprint, 'IDEMPOTENCY_CONFLICT', '同一快速录入请求的数据已变化')
    return { itemId: existing._id, version: existing.version, expiryDate: existing.expiryDate }
  }
  try {
    return await db.runTransaction(async (transaction) => {
      const existingResult = await transaction.collection(ITEMS).where({ _id: itemId }).limit(1).get()
      const existing = existingResult.data[0]
      if (existing) return resolveExisting(existing)

      await transaction.collection(ITEMS).doc(itemId).set({
        data: {
          ownerId,
          ...normalized,
          inventoryStatus: 'active',
          version: 1,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate(),
          completedAt: null,
          creationRequestId,
          creationFingerprint,
        },
      })
      return { itemId, version: 1, expiryDate: normalized.expiryDate }
    })
  } catch (error) {
    const existingResult = await db.collection(ITEMS).where({ _id: itemId }).limit(1).get()
    if (existingResult.data[0]) return resolveExisting(existingResult.data[0])
    throw error
  }
}

async function decrement(ownerId, event) {
  const itemId = validateItemId(event.itemId)
  const version = validateVersion(event.version)
  const amount = validateDecrementAmount(event.amount)
  const item = await getOwnedItem(ownerId, itemId)
  const decision = getDecrementDecision(item.inventoryStatus, item.quantity, amount)
  assert(decision !== 'invalid_state', 'INVALID_ARGUMENT', '减少数量不能超过当前库存')
  assert(item.version === version, 'CONFLICT', '记录已更新，请刷新后重试')
  if (decision === 'requires_completion') {
    throw new AppError('REQUIRES_COMPLETION_CONFIRM', '这是最后一件，请确认是否标记为已用完')
  }

  const result = await db
    .collection(ITEMS)
    .where({
      _id: itemId,
      ownerId,
      inventoryStatus: 'active',
      version,
      quantity: item.quantity,
    })
    .update({
      data: {
        quantity: command.inc(-amount),
        version: command.inc(1),
        updatedAt: db.serverDate(),
      },
    })
  if (updatedCount(result) !== 1) {
    throw new AppError('CONFLICT', '记录已更新，请刷新后重试')
  }
  return { quantity: item.quantity - amount, version: version + 1 }
}

async function transition(ownerId, event, targetStatus) {
  const itemId = validateItemId(event.itemId)
  const version = validateVersion(event.version)
  await getOwnedItem(ownerId, itemId)
  await db.runTransaction(async (transaction) => {
    const current = await getTransactionOwnedDoc(transaction, ITEMS, ownerId, itemId)
    assert(current, 'NOT_FOUND', '物品不存在或已被删除')
    assert(
      canTransitionInventory(current.inventoryStatus, targetStatus),
      'INVALID_STATE',
      '该物品已经处理',
    )
    assert(current.version === version, 'CONFLICT', '记录已更新，请刷新后重试')
    const update = {
      inventoryStatus: targetStatus,
      version: version + 1,
      completedAt: db.serverDate(),
      updatedAt: db.serverDate(),
    }
    if (targetStatus === 'used_up') update.quantity = 0
    await transaction.collection(ITEMS).doc(itemId).update({ data: update })
    await cancelPendingReminder(transaction, ownerId, itemId)
  })
  return { version: version + 1 }
}

async function moveToTrash(ownerId, event) {
  const itemId = validateItemId(event.itemId)
  const version = validateVersion(event.version)
  await getOwnedItem(ownerId, itemId)
  await db.runTransaction(async (transaction) => {
    const current = await getTransactionOwnedDoc(transaction, ITEMS, ownerId, itemId)
    assert(current, 'NOT_FOUND', '物品不存在或已被删除')
    assert(canMoveInventoryToTrash(current.inventoryStatus), 'INVALID_STATE', '该物品已经删除')
    assert(current.version === version, 'CONFLICT', '记录已更新，请刷新后重试')
    await transaction.collection(ITEMS).doc(itemId).update({
      data: {
        inventoryStatus: 'deleted',
        version: version + 1,
        completedAt: db.serverDate(),
        deletedAt: db.serverDate(),
        purgeAfter: new Date(Date.now() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000),
        updatedAt: db.serverDate(),
      },
    })
    await cancelPendingReminder(transaction, ownerId, itemId, true)
  })
  return { version: version + 1 }
}

async function removePermanently(ownerId, event) {
  const itemId = validateItemId(event.itemId)
  const version = validateVersion(event.version)
  await getOwnedItem(ownerId, itemId)
  await db.runTransaction(async (transaction) => {
    const current = await getTransactionOwnedDoc(transaction, ITEMS, ownerId, itemId)
    assert(current, 'NOT_FOUND', '物品不存在或已被删除')
    assert(['deleted', 'discarded'].includes(current.inventoryStatus), 'INVALID_STATE', '只能彻底删除回收站中的物品')
    assert(current.version === version, 'CONFLICT', '记录已更新，请刷新后重试')
    await transaction.collection(ITEMS).doc(itemId).remove()
    await cancelPendingReminder(transaction, ownerId, itemId, true)
  })
  return { deleted: true }
}

async function restore(ownerId, event) {
  assert(event.idempotencyKey === undefined, 'INVALID_ARGUMENT', '重新入库不能包含快速录入请求编号')
  const input = event.data
  const normalized = validateSaveInput(input)
  const itemId = validateItemId(input.itemId)
  const version = validateVersion(input.version)
  await getOwnedItem(ownerId, itemId)
  await db.runTransaction(async (transaction) => {
    const current = await getTransactionOwnedDoc(transaction, ITEMS, ownerId, itemId)
    assert(current, 'NOT_FOUND', '物品不存在或已被删除')
    assert(['deleted', 'discarded'].includes(current.inventoryStatus), 'INVALID_STATE', '该物品不在回收站中')
    assert(current.version === version, 'CONFLICT', '记录已更新，请刷新后重试')
    await transaction.collection(ITEMS).doc(itemId).update({
      data: {
        ...normalized,
        inventoryStatus: 'active',
        version: version + 1,
        completedAt: null,
        deletedAt: null,
        purgeAfter: null,
        updatedAt: db.serverDate(),
      },
    })
    await cancelPendingReminder(transaction, ownerId, itemId, true)
  })
  return { itemId, version: version + 1, expiryDate: normalized.expiryDate }
}

async function processBatch(ownerId, event, mutation) {
  const items = validateBatchItems(event.items)
  const succeeded = []
  const failed = []
  await Promise.all(items.map(async (item) => {
    try {
      await mutation(ownerId, item)
      succeeded.push(item.itemId)
    } catch (error) {
      const safeError = normalizeError(error)
      failed.push({ itemId: item.itemId, code: safeError.code, message: safeError.message })
    }
  }))
  return { succeeded, failed }
}

async function listHistory(ownerId, event) {
  const today = currentDateKey()
  const search = validateSearch(event.search)
  const status = validateHistoryStatus(event.status)
  const pageSize = validatePageSize(event.pageSize)
  const offset = decodeCursor(event.cursor)
  const where = {
    ownerId,
    inventoryStatus: status === 'discarded'
      ? command.in(['deleted', 'discarded'])
      : status || command.in(['used_up', 'discarded']),
  }
  if (search) {
    where.searchName = db.RegExp({ regexp: escapeRegExp(search), options: 'i' })
  }

  const result = await db
    .collection(ITEMS)
    .where(where)
    .orderBy('completedAt', 'desc')
    .skip(offset)
    .limit(pageSize + 1)
    .get()
  const hasMore = result.data.length > pageSize
  return {
    items: result.data.slice(0, pageSize).map((item) => publicItem(item, today)),
    nextCursor: hasMore ? encodeCursor(offset + pageSize) : null,
    serverToday: today,
  }
}

async function listTrash(ownerId, event) {
  const today = currentDateKey()
  const search = validateSearch(event.search)
  const pageSize = validatePageSize(event.pageSize)
  const signature = querySignature({ search, pageSize, scope: 'trash' })
  const offset = decodeCursor(event.cursor, signature)
  const where = {
    ownerId,
    inventoryStatus: command.in(['deleted', 'discarded']),
  }
  if (search) where.searchName = db.RegExp({ regexp: escapeRegExp(search), options: 'i' })

  const result = await db
    .collection(ITEMS)
    .where(where)
    .orderBy('completedAt', 'desc')
    .skip(offset)
    .limit(pageSize + 1)
    .get()
  const hasMore = result.data.length > pageSize
  return {
    items: result.data.slice(0, pageSize).map((item) => publicItem(item, today)),
    nextCursor: hasMore ? encodeCursor(offset + pageSize, signature) : null,
    serverToday: today,
  }
}

// 封面是展示数据，故意不 bump version：避免和并发编辑互相打出 CONFLICT。
async function generateCover(ownerId, event) {
  const itemId = validateItemId(event.itemId)
  assert(coverEnabled(), 'COVER_IMAGE_DISABLED', '封面生成未开启')
  const item = await getOwnedItem(ownerId, itemId)
  if (item.coverFileId) return { coverFileId: item.coverFileId, reused: 'self' }

  // 同名物品已有封面直接复用，省生图额度也不产生重复图。
  const sameName = await db.collection(ITEMS)
    .where({ ownerId, name: item.name, inventoryStatus: 'active' })
    .limit(20)
    .get()
  const reusable = sameName.data.find((doc) => doc.coverFileId)
  if (reusable) {
    await db.collection(ITEMS).doc(itemId).update({
      data: { coverFileId: reusable.coverFileId, coverUpdatedAt: db.serverDate() },
    })
    return { coverFileId: reusable.coverFileId, reused: 'same-name' }
  }

  const { fileID } = await generateCoverImage({ ownerId, itemId, name: item.name })
  await db.collection(ITEMS).doc(itemId).update({
    data: { coverFileId: fileID, coverUpdatedAt: db.serverDate() },
  })
  return { coverFileId: fileID, reused: false }
}

const handlers = {
  listActive,
  getOverview,
  listInventory,
  listRecentProfiles,
  get,
  save,
  generateCover,
  decrement,
  complete: (ownerId, event) => transition(ownerId, event, 'used_up'),
  discard: moveToTrash,
  delete: moveToTrash,
  moveToTrash,
  permanentDelete: removePermanently,
  restore,
  batchComplete: (ownerId, event) => processBatch(ownerId, event, (id, item) => transition(id, item, 'used_up')),
  batchDelete: (ownerId, event) => processBatch(ownerId, event, moveToTrash),
  batchPermanentDelete: (ownerId, event) => processBatch(ownerId, event, removePermanently),
  listHistory,
  listTrash,
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
    assert(handler, 'INVALID_ACTION', '不支持的库存操作')
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
