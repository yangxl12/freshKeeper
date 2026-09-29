import { describe, expect, it, vi } from 'vitest'

type Doc = Record<string, any>

function loadReminderApi(item: Doc, reminder?: Doc) {
  const jobs = reminder ? [{ ...reminder }] : []
  const db = {
    serverDate: () => new Date(),
    collection(name: string) {
      let filter: Doc = {}
      return {
        where(next: Doc) { filter = next; return this },
        limit() { return this },
        async get() {
          const source = name === 'inventory_items' ? [item] : jobs
          return { data: source.filter((doc) => Object.entries(filter).every(([key, value]) => doc[key] === value)) }
        },
        async update({ data }: { data: Doc }) {
          const selected = jobs.filter((doc) => Object.entries(filter).every(([key, value]) => doc[key] === value))
          selected.forEach((doc) => Object.assign(doc, data))
          return { stats: { updated: selected.length } }
        },
        doc() {
          return {
            async set({ data }: { data: Doc }) { jobs.push({ ...data }) },
          }
        },
      }
    },
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init: vi.fn(),
    database: () => db,
    getWXContext: () => ({ OPENID: 'owner-1' }),
  }
  const Module = require('node:module') as { _load: (...args: any[]) => any }
  const originalLoad = Module._load
  const modulePath = require.resolve('../../cloudfunctions/reminderApi/index.js')
  delete require.cache[modulePath]
  Module._load = function patched(request: string, ...args: any[]) {
    if (request === 'wx-server-sdk') return cloud
    return originalLoad.call(this, request, ...args)
  }
  try {
    return {
      api: require(modulePath) as { main(event: Doc): Promise<Doc> },
      jobs,
    }
  } finally {
    Module._load = originalLoad
  }
}

const item = {
  _id: 'item-1', ownerId: 'owner-1', inventoryStatus: 'active',
  expiryDate: '2099-09-30', reminderLeadDays: 1, version: 4,
}

describe('reminder plan lifecycle', () => {
  it('archives a sent old plan and schedules the changed plan after a new authorization', async () => {
    const old = {
      _id: 'item-1', itemId: 'item-1', ownerId: 'owner-1',
      planKey: '2099-09-27:1', remindDate: '2099-09-26',
      status: 'sent', sentAt: new Date(), messageId: 'msg-old', updatedAt: new Date(),
    }
    const { api, jobs } = loadReminderApi(item, old)
    const result = await api.main({ action: 'arm', itemId: 'item-1' })

    expect(result.data).toMatchObject({ status: 'scheduled', remindDate: '2099-09-29' })
    expect(jobs[0]).toMatchObject({ status: 'scheduled', planKey: '2099-09-30:1', itemVersion: 4 })
    expect(jobs[0].attemptHistory).toMatchObject([{ status: 'sent', messageId: 'msg-old' }])
  })

  it('does not reopen the same scheduled plan', async () => {
    const old = {
      _id: 'item-1', itemId: 'item-1', ownerId: 'owner-1',
      planKey: '2099-09-30:1', remindDate: '2099-09-29',
      status: 'scheduled', updatedAt: new Date(),
    }
    const { api, jobs } = loadReminderApi(item, old)
    const result = await api.main({ action: 'arm', itemId: 'item-1' })

    expect(result.data.status).toBe('scheduled')
    expect(jobs[0].attemptHistory).toBeUndefined()
  })

  it('blocks a new plan while the previous send result is unknown', async () => {
    const old = {
      _id: 'item-1', itemId: 'item-1', ownerId: 'owner-1',
      planKey: '2099-09-27:1', remindDate: '2099-09-26',
      status: 'unknown', updatedAt: new Date(),
    }
    const { api, jobs } = loadReminderApi(item, old)
    const result = await api.main({ action: 'arm', itemId: 'item-1' })

    expect(result).toMatchObject({ ok: false, error: { code: 'PREVIOUS_RESULT_PENDING' } })
    expect(jobs[0].status).toBe('unknown')
  })
})
