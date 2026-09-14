import { describe, expect, it } from 'vitest'

const feedbackModule = require('../../cloudfunctions/userApi/feedback') as {
  FEEDBACK_MAX_CODE_POINTS: number
  createFeedbackService(options: { db: unknown }): {
    submitFeedback(ownerId: string, input: unknown): Promise<{ feedbackId: string }>
  }
  validateFeedbackInput(input: unknown): { content: string }
}

type Doc = Record<string, unknown>

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return String((error as { code?: unknown }).code ?? '')
  }
  return ''
}

function createFakeDb() {
  const rows: Doc[] = []
  const createdAt = new Date('2026-09-14T10:00:00+08:00')
  return {
    rows,
    db: {
      serverDate: () => createdAt,
      collection: (name: string) => ({
        add: async ({ data }: { data: Doc }) => {
          rows.push({ _id: 'feedback-1', collection: name, ...data })
          return { _id: 'feedback-1' }
        },
      }),
    },
  }
}

describe('userApi 反馈校验', () => {
  it('去掉首尾空白并保留正文换行', () => {
    expect(feedbackModule.validateFeedbackInput({ content: '  第一行\n第二行  ' })).toEqual({
      content: '第一行\n第二行',
    })
  })

  it('拒绝空内容、非字符串和未知字段', () => {
    expect(codeOf(() => feedbackModule.validateFeedbackInput({ content: '   ' }))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => feedbackModule.validateFeedbackInput({ content: 1 }))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => feedbackModule.validateFeedbackInput({ content: '建议', ownerId: '伪造身份' }))).toBe(
      'FORBIDDEN_FIELD',
    )
  })

  it('最长 500 个码点，emoji 不按两个字符误判', () => {
    const max = feedbackModule.FEEDBACK_MAX_CODE_POINTS
    expect(feedbackModule.validateFeedbackInput({ content: '😀'.repeat(max) }).content).toBe('😀'.repeat(max))
    expect(codeOf(() => feedbackModule.validateFeedbackInput({ content: '😀'.repeat(max + 1) }))).toBe(
      'INVALID_ARGUMENT',
    )
  })
})

describe('userApi 提交反馈', () => {
  it('只使用服务端 ownerId，并写入待处理状态和服务端时间', async () => {
    const fake = createFakeDb()
    const service = feedbackModule.createFeedbackService({ db: fake.db })

    await expect(service.submitFeedback('openid-1', { content: ' 希望增加扫码录入 ' })).resolves.toEqual({
      feedbackId: 'feedback-1',
    })
    expect(fake.rows).toEqual([{
      _id: 'feedback-1',
      collection: 'user_feedback',
      ownerId: 'openid-1',
      content: '希望增加扫码录入',
      status: 'pending',
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
      schemaVersion: 1,
    }])
  })
})
