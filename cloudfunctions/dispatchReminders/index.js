'use strict'

const crypto = require('node:crypto')
const cloud = require('wx-server-sdk')
const { buildReminderTemplateData, truncate } = require('./template')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const command = db.command
const ITEMS = 'inventory_items'
const REMINDERS = 'reminder_jobs'
const BATCH_SIZE = 50
const MAX_BATCHES = 20
// 单条 processJob ≈ 6-8 次数据库操作 + 1 次开放接口调用，串行时 50 条/批要 12.5s、
// 20 批 ≈ 250s，必然撞 60s 云函数超时，后半批用户的提醒会静默丢失。
// 受控 8 路并发后约 1.6s/批、20 批 ≈ 32s。
//
// 并发安全性：processJob 的 claim 用的是条件更新
// （where status='scheduled'，updatedCount 必须为 1），重复/并发处理只会返回 skipped，
// 不会有两条路径同时给同一 job 发消息。
const JOB_CONCURRENCY = 8
const STALE_SENDING_MS = 15 * 60 * 1000
const MILLIS_PER_DAY = 86_400_000

/**
 * 提醒统一在提醒日 16:00（Asia/Shanghai）推送，必须与 reminderApi 的 REMIND_HOUR/REMIND_MINUTE
 * 完全一致。改这里要同步 reminderApi/index.js、domain/reminder-time.ts 与相关测试。
 *
 * 注意：定时触发器配的是「每小时整点」，到没到点由本文件的 reachedRemindTime() 判断，
 * 所以改提醒时刻只需改代码并重新部署，**不用再去控制台改触发器**（触发器只在函数首次
 * 创建时写入云端，之后改 config.json 重新部署都不会同步）。
 */
const REMIND_HOUR = 16
const REMIND_MINUTE = 0
class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function assert(condition, code, message) {
  if (!condition) throw new AppError(code, message)
}

function parseDateKey(value) {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > maxDay) {
    return null
  }
  return { year, month, day }
}

function toOrdinal(value) {
  const parts = parseDateKey(value)
  if (!parts) return null
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MILLIS_PER_DAY)
}

function fromOrdinal(ordinal) {
  const date = new Date(ordinal * MILLIS_PER_DAY)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(
    date.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function addDays(value, amount) {
  const ordinal = toOrdinal(value)
  return ordinal === null ? null : fromOrdinal(ordinal + amount)
}

/** 提前天数缺失或非法时回落到 1 天，与录入表单、reminderApi 保持同一归一化口径。 */
function normalizedLeadDays(value) {
  return Number.isInteger(value) && value >= 0 && value <= 30 ? value : 1
}

function todayKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

/** hourCycle 用 h23，避免部分 Node 版本在午夜把 00 点格式化成 24。 */
function shanghaiHourMinute() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return { hour: Number(values.hour), minute: Number(values.minute) }
}

/** 当前时刻是否已过当天提醒时刻。未到点时当天任务保持 scheduled，不提前推、也不取消。 */
function reachedRemindTime() {
  const { hour, minute } = shanghaiHourMinute()
  return hour > REMIND_HOUR || (hour === REMIND_HOUR && minute >= REMIND_MINUTE)
}

function loadConfig(override) {
  const config = {
    // 环境变量只在函数首次创建时写入云端，之后改配置重新部署都不会同步；
    // 手工派发时可以用 options.miniprogramState 临时覆盖，避免为了测试去改云端环境变量。
    miniprogramState: override || process.env.MINIPROGRAM_STATE || 'formal',
  }
  assert(
    ['developer', 'trial', 'formal'].includes(config.miniprogramState),
    'CONFIG_INVALID',
    '小程序发布状态配置不正确',
  )
  return config
}

function updatedCount(result) {
  return result?.stats?.updated ?? result?.updated ?? 0
}

async function findOwnedItem(ownerId, itemId) {
  const result = await db
    .collection(ITEMS)
    .where({ _id: itemId, ownerId })
    .limit(1)
    .get()
  return result.data[0] || null
}

async function updateJob(job, status, data = {}) {
  await db
    .collection(REMINDERS)
    .where({ _id: job._id, ownerId: job.ownerId, status: 'sending' })
    .update({
      data: {
        status,
        ...data,
        updatedAt: db.serverDate(),
      },
    })
}

async function cancelJob(job, code, reason) {
  await db
    .collection(REMINDERS)
    .where({ _id: job._id, ownerId: job.ownerId, status: 'scheduled' })
    .update({
      data: {
        status: 'cancelled',
        failureCode: code,
        failureReason: reason,
        updatedAt: db.serverDate(),
      },
    })
}

async function failScheduledJob(job, code) {
  await db.collection(REMINDERS)
    .where({ _id: job._id, ownerId: job.ownerId, status: 'scheduled' })
    .update({
      data: {
        status: 'failed',
        failureCode: truncate(code, 40),
        failureReason: '派发前处理失败，可重新预约',
        updatedAt: db.serverDate(),
      },
    })
}

function jobIdHash(job) {
  return crypto.createHash('sha256').update(String(job?._id || '')).digest('hex').slice(0, 16)
}

function outcome(job, stage, result, claimed = false) {
  return { jobIdHash: jobIdHash(job), stage, result, claimed }
}

function isUncertainError(error) {
  const text = `${error?.errMsg || ''} ${error?.message || ''}`.toLowerCase()
  return /timeout|timed out|network|econnreset|socket hang up/.test(text)
}

function openApiFailureReason(error, uncertain) {
  const detail = error?.errMsg || error?.message || ''
  const fallback = uncertain ? '发送结果不确定，不自动重试' : '微信平台明确返回发送失败'
  return truncate(detail ? `${fallback}：${detail}` : fallback, 240)
}

async function processJob(job, today, config, options = {}) {
  let claimed = false
  let stage = 'validate'
  try {
    // 未来任务理论上不会被查询捞到，并发下万一捞到就原样放着，不动状态。
    // 唯一例外是用户自助验收自己的指定任务：它仍由小程序端触发，保留微信云调用票据，且一次只发一条。
    if (job.remindDate > today && !options.allowFuture) return outcome(job, stage, 'pending')
    // 提醒只认当天；错过后不补发。
    if (job.remindDate < today) {
      await cancelJob(job, 'REMINDER_MISSED', '提醒时间已过，不再补发')
      return outcome(job, stage, 'cancelled')
    }

    const item = await findOwnedItem(job.ownerId, job.itemId)
    const expectedRemindDate = item
      ? addDays(item.expiryDate, -normalizedLeadDays(item.reminderLeadDays))
      : null
    const expiryOrdinal = item ? toOrdinal(item.expiryDate) : null
    const todayOrdinal = toOrdinal(today)
    if (!item || item.inventoryStatus !== 'active' || expectedRemindDate !== job.remindDate
      || expiryOrdinal === null || expiryOrdinal < todayOrdinal) {
      await cancelJob(job, 'ITEM_NOT_ELIGIBLE', '物品状态或提醒日期已变化')
      return outcome(job, stage, 'cancelled')
    }

    stage = 'claim'
    const claimResult = await db.collection(REMINDERS)
      .where({ _id: job._id, ownerId: job.ownerId, status: 'scheduled', remindDate: job.remindDate })
      .update({ data: { status: 'sending', updatedAt: db.serverDate() } })
    if (updatedCount(claimResult) !== 1) return outcome(job, stage, 'skipped')
    claimed = true

    stage = 'revalidate'
    const sendItem = await findOwnedItem(job.ownerId, job.itemId)
    const sendExpiryOrdinal = sendItem ? toOrdinal(sendItem.expiryDate) : null
    const sendRemindDate = sendItem
      ? addDays(sendItem.expiryDate, -normalizedLeadDays(sendItem.reminderLeadDays))
      : null
    if (!sendItem || sendItem.inventoryStatus !== 'active' || sendRemindDate !== job.remindDate
      || sendExpiryOrdinal === null || sendExpiryOrdinal < todayOrdinal) {
      await updateJob(job, 'cancelled', {
        failureCode: 'ITEM_CHANGED_BEFORE_SEND',
        failureReason: '发送前物品状态或提醒日期已变化',
      })
      return outcome(job, stage, 'cancelled', true)
    }

    stage = 'attempt'
    await db.collection(REMINDERS)
      .where({ _id: job._id, ownerId: job.ownerId, status: 'sending' })
      .update({ data: { sendAttemptedAt: db.serverDate(), updatedAt: db.serverDate() } })

    stage = 'send'
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: job.ownerId,
        templateId: job.templateId,
        page: `pages/item-detail/index?id=${encodeURIComponent(job.itemId)}&source=subscribe`,
        miniprogramState: config.miniprogramState,
        lang: 'zh_CN',
        data: buildReminderTemplateData(sendItem),
      })
    } catch (error) {
      const uncertain = isUncertainError(error)
      const status = uncertain ? 'unknown' : 'failed'
      await updateJob(job, status, {
        failureCode: truncate(error?.errCode || (uncertain ? 'RESULT_UNKNOWN' : 'OPENAPI_REJECTED'), 40),
        failureReason: openApiFailureReason(error, uncertain),
      })
      return outcome(job, stage, status, true)
    }

    stage = 'finalize'
    await updateJob(job, 'sent', { sentAt: db.serverDate(), failureCode: null, failureReason: null })
    return outcome(job, stage, 'sent', true)
  } catch (error) {
    const failureCode = truncate(error?.code || 'DISPATCH_STAGE_FAILED', 40)
    try {
      if (claimed) {
        await updateJob(job, 'unknown', {
          failureCode,
          failureReason: '领取任务后处理异常，发送结果不确定，不自动重试',
        })
      } else {
        await failScheduledJob(job, failureCode)
      }
    } catch (_updateError) {
      // 状态修复也失败时仍返回明确阶段；僵尸 sending 会由下次对账收敛为 unknown。
    }
    return outcome(job, stage, claimed ? 'unknown' : 'failed', claimed)
  }
}

async function reconcileStaleSending() {
  const staleBefore = new Date(Date.now() - STALE_SENDING_MS)
  const result = await db.collection(REMINDERS)
    .where({ status: 'sending', updatedAt: command.lt(staleBefore) })
    .orderBy('updatedAt', 'asc')
    .limit(BATCH_SIZE)
    .get()
  let reconciled = 0
  for (const job of result.data) {
    const update = await db.collection(REMINDERS)
      .where({ _id: job._id, ownerId: job.ownerId, status: 'sending', updatedAt: command.lt(staleBefore) })
      .update({
        data: {
          status: 'unknown',
          failureCode: 'STALE_SENDING',
          failureReason: '发送过程超时，结果待确认，不自动重试',
          updatedAt: db.serverDate(),
        },
      })
    reconciled += updatedCount(update)
  }
  return reconciled
}

/**
 * 只读诊断：把 reminder_jobs 的全貌摊开，用来回答「到底有没有任务、任务卡在什么状态」。
 * 不修改任何数据，可随时手工调用。
 */
async function diagnose(today) {
  const snapshot = await db.collection(REMINDERS).limit(1000).get()
  const jobs = snapshot.data || []
  const byStatus = {}
  const byRemindDate = {}
  for (const job of jobs) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1
    byRemindDate[job.remindDate] = (byRemindDate[job.remindDate] || 0) + 1
  }
  const dueToday = jobs.filter((job) => job.status === 'scheduled' && job.remindDate === today)
  return {
    today,
    reachedRemindTime: reachedRemindTime(),
    total: jobs.length,
    byStatus,
    byRemindDate,
    dueTodayCount: dueToday.length,
    dueToday: dueToday.slice(0, 20).map((job) => ({
      itemId: job.itemId,
      owner: String(job.ownerId || '').slice(-6),
      remindDate: job.remindDate,
      templateId: job.templateId,
      acceptedAt: job.acceptedAt || null,
    })),
    recent: jobs
      .slice(-20)
      .reverse()
      .map((job) => ({
        itemId: job.itemId,
        owner: String(job.ownerId || '').slice(-6),
        remindDate: job.remindDate,
        status: job.status,
        failureCode: job.failureCode || null,
        failureReason: job.failureReason || null,
        sentAt: job.sentAt || null,
      })),
  }
}

exports.main = async (event = {}) => {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  const options = event && typeof event === 'object' && !Array.isArray(event) ? event : {}
  const manual = options.manual === true
  const force = options.force === true
  try {
    const context = cloud.getWXContext()
    const config = loadConfig(
      typeof options.miniprogramState === 'string' ? options.miniprogramState : undefined,
    )
    const today = todayKey()

    if (options.action === 'verify-self') {
      assert(context.OPENID, 'FORBIDDEN', '即时验收只允许从小程序端发起')
      const itemId = typeof options.itemId === 'string' ? options.itemId.trim() : ''
      assert(itemId && itemId.length <= 128, 'INVALID_ITEM_ID', '请提供有效的提醒任务 itemId')
      const target = await db.collection(REMINDERS)
        .where({ _id: itemId, ownerId: context.OPENID, status: 'scheduled' })
        .limit(1)
        .get()
      const job = target.data[0]
      assert(job, 'REMINDER_NOT_SCHEDULED', '没有找到可发送的提醒任务')
      const jobOutcome = await processJob(job, today, config, { allowFuture: true })
      const payload = {
        itemId,
        remindDate: job.remindDate,
        stage: jobOutcome.stage,
        result: jobOutcome.result,
        mode: 'self-verification',
      }
      console.info(
        JSON.stringify({
          requestId,
          action: 'verify-self',
          resultCode: 'OK',
          durationMs: Date.now() - startedAt,
          remindDate: job.remindDate,
          stage: jobOutcome.stage,
          result: jobOutcome.result,
        }),
      )
      return { ok: true, data: payload, requestId }
    }

    // 定时触发与控制台诊断都不带 OPENID；小程序端调用一定带 OPENID。
    // manual 只是区分运行模式，不能拿它当身份凭据，否则任意用户都能伪造 manual:true
    // 读取全局诊断数据或触发全量派发。
    assert(!context.OPENID, 'FORBIDDEN', '提醒派发函数只允许定时触发或云端测试')

    if (options.action === 'diag') {
      const diag = await diagnose(today)
      console.info(
        JSON.stringify({ requestId, action: 'diag', resultCode: 'OK', durationMs: Date.now() - startedAt, ...diag, dueToday: undefined }),
      )
      return { ok: true, data: diag, requestId }
    }

    // force 用于验收/补发，忽略时钟判断立刻派发当天任务。
    const reached = force || reachedRemindTime()
    // 未到提醒时刻时只清理过期任务（remindDate < 今天），当天任务保持 scheduled 不提前推。
    const dateFilter = reached ? command.lte(today) : command.lt(today)
    const summary = { due: 0, claimed: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0, skipped: 0, pending: 0, staleSending: 0 }
    const details = []
    summary.staleSending = await reconcileStaleSending()

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const result = await db
        .collection(REMINDERS)
        .where({ status: 'scheduled', remindDate: dateFilter })
        .orderBy('remindDate', 'asc')
        .limit(BATCH_SIZE)
        .get()
      if (!result.data.length) break

      // 内层并发（见 JOB_CONCURRENCY 说明）；受控分批，避免一次打太多开放接口。
      for (let index = 0; index < result.data.length; index += JOB_CONCURRENCY) {
        const slice = result.data.slice(index, index + JOB_CONCURRENCY)
        const outcomes = await Promise.all(slice.map((job) => processJob(job, today, config)))
        outcomes.forEach((jobOutcome, offset) => {
          const job = slice[offset]
          summary.due += 1
          if (jobOutcome.claimed) summary.claimed += 1
          summary[jobOutcome.result] = (summary[jobOutcome.result] || 0) + 1
          if (manual) {
            details.push({
              itemId: job.itemId,
              owner: String(job.ownerId || '').slice(-6),
              remindDate: job.remindDate,
              stage: jobOutcome.stage,
              result: jobOutcome.result,
            })
          }
        })
      }
      if (result.data.length < BATCH_SIZE) break
    }

    // 超时被截断时运维要能看出漏了多少，只打 summary 是看不出来的。
    let remaining = 0
    try {
      const remainingResult = await db
        .collection(REMINDERS)
        .where({ status: 'scheduled', remindDate: dateFilter })
        .count()
      remaining = remainingResult.total || 0
    } catch (_error) {
      remaining = -1
    }

    const payload = {
      ...summary,
      remaining,
      today,
      reached,
      mode: manual ? 'manual' : 'timer',
      details: manual ? details : undefined,
    }
    console.info(
      JSON.stringify({
        requestId,
        action: 'dispatch',
        resultCode: 'OK',
        durationMs: Date.now() - startedAt,
        ...summary,
        remaining,
        today,
        reached,
        mode: payload.mode,
      }),
    )
    return { ok: true, data: payload, requestId }
  } catch (error) {
    const safeError =
      error instanceof AppError
        ? error
        : new AppError('INTERNAL_ERROR', '提醒派发暂时不可用')
    console.warn(
      JSON.stringify({
        requestId,
        action: 'dispatch',
        resultCode: safeError.code,
        durationMs: Date.now() - startedAt,
      }),
    )
    return {
      ok: false,
      error: { code: safeError.code, message: safeError.message },
      requestId,
    }
  }
}
