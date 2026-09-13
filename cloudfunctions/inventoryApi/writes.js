'use strict'

const { AppError, assert } = require('./error')
const { canMoveInventoryToTrash, canTransitionInventory } = require('./rules')
const { validateItemId, validateSaveInput, validateVersion } = require('./validation')

const ITEMS = 'inventory_items'
const REMINDERS = 'reminder_jobs'
const TRASH_RETENTION_DAYS = 30
/** 取消（而不是删除）提醒任务时，只有这几个状态值得改；已发送的历史不该被抹掉。 */
const CANCELLABLE_REMINDER_STATUSES = ['scheduled', 'failed', 'cancelled']

function updatedCount(result) {
  return result?.stats?.updated ?? result?.updated ?? 0
}

function removedCount(result) {
  return result?.stats?.removed ?? result?.removed ?? 0
}

/**
 * 状态流转类写操作：用完 / 移入回收站 / 彻底删除 / 重新入库。
 *
 * 原来是「事务里读一次 + 事务里写」，现在是「读一次 + 带 version 的条件更新」：
 *
 * 1. **去掉事务**：云开发的事务对同一集合的并发写会冲突重试，批量 20 条最容易撞；
 *    version 写在 where 里就是乐观锁，`updatedCount !== 1` 即冲突，与事务等价。
 * 2. **读不能省**：NOT_FOUND / INVALID_STATE / CONFLICT 三个错误码靠它区分。
 *    全并成 CONFLICT 会让批量结果里的失败原因失真（用户会以为全是「刷新重试」）。
 * 3. **取消提醒挪出事务**：它容忍最终一致 —— `dispatchReminders` 发送前会重新校验
 *    物品状态，漏掉的任务会被判成 `ITEM_NOT_ELIGIBLE` 取消，不会误发。
 *
 * `save` / `saveIdempotent` 不在这里：它们要保护「物品 + 提醒改期」以及幂等键，
 * 仍是单条低频写入，留在原地的开销可以接受。
 */
function createWriteService({ db, deleteFile }) {
  assert(db, 'INTERNAL_ERROR', '数据库未初始化')

  async function readOwnedItem(ownerId, itemId) {
    const result = await db.collection(ITEMS).where({ _id: itemId, ownerId }).limit(1).get()
    if (!result.data.length) throw new AppError('NOT_FOUND', '物品不存在或已被删除')
    return result.data[0]
  }

  /** 乐观锁：状态和 version 在读写之间但凡变了一个，就一条都写不进去。 */
  function lockOf(item, version) {
    return { status: item.inventoryStatus, version }
  }

  async function writeOwnedItem(ownerId, itemId, lock, data) {
    const result = await db
      .collection(ITEMS)
      .where({ _id: itemId, ownerId, inventoryStatus: lock.status, version: lock.version })
      .update({ data })
    if (updatedCount(result) !== 1) {
      throw new AppError('CONFLICT', '记录已更新，请刷新后重试')
    }
  }

  async function removeOwnedItem(ownerId, itemId, lock) {
    const result = await db
      .collection(ITEMS)
      .where({ _id: itemId, ownerId, inventoryStatus: lock.status, version: lock.version })
      .remove()
    if (removedCount(result) !== 1) {
      throw new AppError('CONFLICT', '记录已更新，请刷新后重试')
    }
  }

  async function removeUnreferencedCover(fileID) {
    if (!fileID || typeof deleteFile !== 'function') return
    try {
      const references = await db.collection(ITEMS).where({ coverFileId: fileID }).limit(1).get()
      if (references.data.length) return
      await deleteFile({ fileList: [fileID] })
    } catch (_error) {
      console.warn(JSON.stringify({ action: 'coverCleanup', resultCode: 'FAILED' }))
    }
  }

  async function cancelPendingReminder(ownerId, itemId, remove = false) {
    const result = await db.collection(REMINDERS).where({ _id: itemId, ownerId }).limit(1).get()
    if (!result.data.length) return
    if (remove) {
      await db.collection(REMINDERS).where({ _id: itemId, ownerId }).remove()
      return
    }
    if (!CANCELLABLE_REMINDER_STATUSES.includes(result.data[0].status)) return
    await db.collection(REMINDERS).where({ _id: itemId, ownerId }).update({
      data: { status: 'cancelled', updatedAt: db.serverDate() },
    })
  }

  async function transition(ownerId, event, targetStatus) {
    const itemId = validateItemId(event.itemId)
    const version = validateVersion(event.version)
    const current = await readOwnedItem(ownerId, itemId)
    assert(
      canTransitionInventory(current.inventoryStatus, targetStatus),
      'INVALID_STATE',
      '该物品已经处理',
    )
    const update = {
      inventoryStatus: targetStatus,
      version: version + 1,
      completedAt: db.serverDate(),
      updatedAt: db.serverDate(),
    }
    if (targetStatus === 'used_up') update.quantity = 0
    await writeOwnedItem(ownerId, itemId, lockOf(current, version), update)
    await cancelPendingReminder(ownerId, itemId)
    return { version: version + 1 }
  }

  async function moveToTrash(ownerId, event) {
    const itemId = validateItemId(event.itemId)
    const version = validateVersion(event.version)
    const current = await readOwnedItem(ownerId, itemId)
    assert(canMoveInventoryToTrash(current.inventoryStatus), 'INVALID_STATE', '该物品已经删除')
    await writeOwnedItem(ownerId, itemId, lockOf(current, version), {
      inventoryStatus: 'deleted',
      version: version + 1,
      completedAt: db.serverDate(),
      deletedAt: db.serverDate(),
      purgeAfter: new Date(Date.now() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      updatedAt: db.serverDate(),
    })
    await cancelPendingReminder(ownerId, itemId, true)
    return { version: version + 1 }
  }

  async function removePermanently(ownerId, event) {
    const itemId = validateItemId(event.itemId)
    const version = validateVersion(event.version)
    const current = await readOwnedItem(ownerId, itemId)
    assert(
      ['deleted', 'discarded'].includes(current.inventoryStatus),
      'INVALID_STATE',
      '只能彻底删除回收站中的物品',
    )
    await removeOwnedItem(ownerId, itemId, lockOf(current, version))
    await cancelPendingReminder(ownerId, itemId, true)
    await removeUnreferencedCover(current.coverFileId)
    return { deleted: true }
  }

  async function restore(ownerId, event) {
    assert(
      event.idempotencyKey === undefined,
      'INVALID_ARGUMENT',
      '重新入库不能包含快速录入请求编号',
    )
    const input = event.data
    const normalized = validateSaveInput(input)
    const itemId = validateItemId(input.itemId)
    const version = validateVersion(input.version)
    const current = await readOwnedItem(ownerId, itemId)
    assert(
      ['deleted', 'discarded'].includes(current.inventoryStatus),
      'INVALID_STATE',
      '该物品不在回收站中',
    )
    await writeOwnedItem(ownerId, itemId, lockOf(current, version), {
      ...normalized,
      inventoryStatus: 'active',
      version: version + 1,
      completedAt: null,
      deletedAt: null,
      purgeAfter: null,
      updatedAt: db.serverDate(),
    })
    await cancelPendingReminder(ownerId, itemId, true)
    return { itemId, version: version + 1, expiryDate: normalized.expiryDate }
  }

  return { moveToTrash, removePermanently, restore, transition }
}

module.exports = { createWriteService }
