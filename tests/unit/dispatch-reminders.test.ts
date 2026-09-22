import { describe, expect, it, vi } from 'vitest'

type Doc = Record<string, any>

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function createCloud(options: {
  items?: Doc[]
  reminders?: Doc[]
  failInventoryRead?: boolean
  failClaim?: boolean
  failFinalize?: boolean
  sendError?: Error & { errCode?: number }
  openid?: string
} = {}) {
  const store: Record<string, Doc[]> = {
    inventory_items: (options.items ?? []).map((doc) => ({ ...doc })),
    reminder_jobs: (options.reminders ?? []).map((doc) => ({ ...doc })),
  }
  const failed = { claim: false, finalize: false }
  const command = {
    lt: (value: unknown) => ({ $op: 'lt', value }),
    lte: (value: unknown) => ({ $op: 'lte', value }),
  }
  const comparable = (value: unknown) => value instanceof Date ? value.getTime() : value
  const matches = (doc: Doc, where: Doc) => Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$op' in expected) {
      const operation = expected as { $op: string; value: unknown }
      const actualValue = comparable(doc[key]) as any
      const expectedValue = comparable(operation.value) as any
      return operation.$op === 'lt' ? actualValue < expectedValue : actualValue <= expectedValue
    }
    return doc[key] === expected
  })

  function collection(name: string) {
    let where: Doc = {}
    let limit = 1000
    const api = {
      where(next: Doc) {
        where = next
        return api
      },
      orderBy() {
        return api
      },
      limit(next: number) {
        limit = next
        return api
      },
      async get() {
        if (name === 'inventory_items' && options.failInventoryRead) throw new Error('read failed')
        return { data: store[name].filter((doc) => matches(doc, where)).slice(0, limit) }
      },
      async count() {
        return { total: store[name].filter((doc) => matches(doc, where)).length }
      },
      async update({ data }: { data: Doc }) {
        if (options.failClaim && !failed.claim && where.status === 'scheduled' && where.remindDate && data.status === 'sending') {
          failed.claim = true
          throw new Error('claim failed')
        }
        if (options.failFinalize && !failed.finalize && data.status === 'sent') {
          failed.finalize = true
          throw new Error('finalize failed')
        }
        const selected = store[name].filter((doc) => matches(doc, where))
        selected.forEach((doc) => Object.assign(doc, data))
        return { stats: { updated: selected.length } }
      },
    }
    return api
  }

  const db = {
    command,
    collection,
    serverDate: () => new Date(),
  }
  const send = vi.fn(async () => {
    if (options.sendError) throw options.sendError
  })
  return {
    cloud: {
      DYNAMIC_CURRENT_ENV: 'dynamic',
      init: vi.fn(),
      database: () => db,
      getWXContext: () => (options.openid ? { OPENID: options.openid } : {}),
      openapi: { subscribeMessage: { send } },
    },
    reminders: store.reminder_jobs,
    send,
  }
}

/**
 * 加载被测模块。用例统一传 `{ manual: true, force: true }`：
 * 派发是否捞当天任务取决于「运行时刻有没有过 16:00」，不固定就会随跑测试的时间漂移。
 */
function loadDispatch(fakeCloud: unknown) {
  const Module = require('node:module') as { _load: (...args: any[]) => any }
  const originalLoad = Module._load
  const modulePath = require.resolve('../../cloudfunctions/dispatchReminders/index.js')
  delete require.cache[modulePath]
  Module._load = function patched(request: string, ...args: any[]) {
    if (request === 'wx-server-sdk') return fakeCloud
    return originalLoad.call(this, request, ...args)
  }
  try {
    return require(modulePath) as { main(event?: Doc): Promise<{ ok: boolean; data: Record<string, any>; error?: Doc }> }
  } finally {
    Module._load = originalLoad
  }
}

function scheduledJob() {
  const today = shanghaiToday()
  return {
    item: {
      _id: 'item-1', ownerId: 'openid-1', inventoryStatus: 'active',
      name: '牛奶', quantity: 2, category: 'food', storageLocation: 'refrigerated',
      expiryDate: today, reminderLeadDays: 0,
    },
    job: {
      _id: 'item-1', itemId: 'item-1', ownerId: 'openid-1', status: 'scheduled',
      remindDate: today, templateId: 'template-1', updatedAt: new Date(),
    },
  }
}

describe('dispatch reminder failure states', () => {
  it('marks a database read failure before claim as failed', async () => {
    const fixture = scheduledJob()
    const fake = createCloud({ items: [fixture.item], reminders: [fixture.job], failInventoryRead: true })
    const result = await loadDispatch(fake.cloud).main({ manual: true, force: true })

    expect(result.data).toMatchObject({ due: 1, claimed: 0, failed: 1 })
    expect(fake.reminders[0]).toMatchObject({ status: 'failed', failureCode: 'DISPATCH_STAGE_FAILED' })
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('marks a claim failure as failed without sending', async () => {
    const fixture = scheduledJob()
    const fake = createCloud({ items: [fixture.item], reminders: [fixture.job], failClaim: true })
    const result = await loadDispatch(fake.cloud).main({ manual: true, force: true })

    expect(result.data).toMatchObject({ due: 1, claimed: 0, failed: 1 })
    expect(fake.reminders[0].status).toBe('failed')
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('separates an explicit OpenAPI rejection from an uncertain timeout', async () => {
    const rejectedFixture = scheduledJob()
    const rejectedError = Object.assign(new Error('platform rejected'), { errCode: 43101 })
    const rejected = createCloud({
      items: [rejectedFixture.item], reminders: [rejectedFixture.job], sendError: rejectedError,
    })
    const rejectedResult = await loadDispatch(rejected.cloud).main({ manual: true, force: true })
    expect(rejectedResult.data).toMatchObject({ claimed: 1, failed: 1, unknown: 0 })
    expect(rejected.reminders[0]).toMatchObject({
      status: 'failed',
      failureCode: '43101',
      failureReason: '微信平台明确返回发送失败：platform rejected',
    })

    const timeoutFixture = scheduledJob()
    const timeout = createCloud({
      items: [timeoutFixture.item], reminders: [timeoutFixture.job], sendError: new Error('network timeout'),
    })
    const timeoutResult = await loadDispatch(timeout.cloud).main({ manual: true, force: true })
    expect(timeoutResult.data).toMatchObject({ claimed: 1, failed: 0, unknown: 1 })
    expect(timeout.reminders[0]).toMatchObject({
      status: 'unknown',
      failureCode: 'RESULT_UNKNOWN',
      failureReason: '发送结果不确定，不自动重试：network timeout',
    })
  })

  it('marks a successful send with failed finalization as unknown and never retries it', async () => {
    const fixture = scheduledJob()
    const fake = createCloud({ items: [fixture.item], reminders: [fixture.job], failFinalize: true })
    const result = await loadDispatch(fake.cloud).main({ manual: true, force: true })

    expect(fake.send).toHaveBeenCalledTimes(1)
    expect(result.data).toMatchObject({ claimed: 1, unknown: 1, sent: 0 })
    expect(fake.reminders[0].status).toBe('unknown')
  })

  it('reconciles stale sending jobs to unknown without sending', async () => {
    const stale = {
      _id: 'item-stale', itemId: 'item-stale', ownerId: 'openid-1', status: 'sending',
      remindDate: shanghaiToday(), templateId: 'template-1',
      updatedAt: new Date(Date.now() - 16 * 60 * 1000),
    }
    const fake = createCloud({ reminders: [stale] })
    const result = await loadDispatch(fake.cloud).main({ manual: true, force: true })

    expect(result.data).toMatchObject({ due: 0, staleSending: 1 })
    expect(fake.reminders[0]).toMatchObject({ status: 'unknown', failureCode: 'STALE_SENDING' })
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('leaves today jobs untouched when the reminder time has not arrived', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-21T08:30:00+08:00'))
    try {
      const fixture = scheduledJob()
      const fake = createCloud({ items: [fixture.item], reminders: [fixture.job] })
      const result = await loadDispatch(fake.cloud).main({ manual: true })

      expect(result.data).toMatchObject({ due: 0, reached: false })
      expect(fake.reminders[0].status).toBe('scheduled')
      expect(fake.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('diagnoses reminder jobs without sending anything', async () => {
    const fixture = scheduledJob()
    const fake = createCloud({ items: [fixture.item], reminders: [fixture.job] })
    const result = await loadDispatch(fake.cloud).main({ manual: true, action: 'diag' })

    expect(result.data).toMatchObject({ total: 1, dueTodayCount: 1 })
    expect(fake.reminders[0].status).toBe('scheduled')
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('rejects forged manual calls from a mini program user', async () => {
    const fixture = scheduledJob()
    const fake = createCloud({
      items: [fixture.item], reminders: [fixture.job], openid: 'attacker-openid',
    })
    const result = await loadDispatch(fake.cloud).main({ manual: true, force: true })

    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(fake.reminders[0].status).toBe('scheduled')
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('sends one named future job early for a cloud-only acceptance test', async () => {
    const today = shanghaiToday()
    const futureRemindDate = new Date(`${today}T00:00:00+08:00`)
    futureRemindDate.setDate(futureRemindDate.getDate() + 1)
    const expiryDate = new Date(`${today}T00:00:00+08:00`)
    expiryDate.setDate(expiryDate.getDate() + 2)
    const dateKey = (value: Date) => value.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    const item = {
      _id: 'future-item', ownerId: 'openid-1', inventoryStatus: 'active',
      name: '验收物品', quantity: 1, category: 'food', storageLocation: 'cabinet',
      expiryDate: dateKey(expiryDate), reminderLeadDays: 1,
    }
    const job = {
      _id: 'future-item', itemId: 'future-item', ownerId: 'openid-1', status: 'scheduled',
      remindDate: dateKey(futureRemindDate), templateId: 'template-1', updatedAt: new Date(),
    }
    const fake = createCloud({ items: [item], reminders: [job] })
    const result = await loadDispatch(fake.cloud).main({
      manual: true, action: 'send-test', itemId: 'future-item', miniprogramState: 'developer',
    })

    expect(result.data).toMatchObject({ itemId: 'future-item', result: 'sent', mode: 'manual-test' })
    expect(fake.reminders[0].status).toBe('sent')
    expect(fake.send).toHaveBeenCalledTimes(1)
  })
})
