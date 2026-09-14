'use strict'

const { assert } = require('./error')

const FEEDBACK = 'user_feedback'
const FEEDBACK_MAX_CODE_POINTS = 500
const FEEDBACK_FIELDS = new Set(['content'])
const SCHEMA_VERSION = 1

function validateFeedbackInput(input) {
  assert(
    input && typeof input === 'object' && !Array.isArray(input),
    'INVALID_ARGUMENT',
    '反馈内容不正确',
  )
  for (const key of Object.keys(input)) {
    assert(FEEDBACK_FIELDS.has(key), 'FORBIDDEN_FIELD', `反馈字段 ${key} 不允许提交`)
  }
  assert(typeof input.content === 'string', 'INVALID_ARGUMENT', '请输入反馈内容')
  const content = input.content.trim()
  assert(content, 'INVALID_ARGUMENT', '请输入反馈内容')
  assert(
    Array.from(content).length <= FEEDBACK_MAX_CODE_POINTS,
    'INVALID_ARGUMENT',
    `反馈内容不能超过 ${FEEDBACK_MAX_CODE_POINTS} 个字`,
  )
  return { content }
}

function createFeedbackService({ db }) {
  assert(db, 'INTERNAL_ERROR', '数据库未初始化')

  async function submitFeedback(ownerId, input) {
    const normalized = validateFeedbackInput(input)
    const createdAt = db.serverDate()
    const result = await db.collection(FEEDBACK).add({
      data: {
        ownerId,
        content: normalized.content,
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
        schemaVersion: SCHEMA_VERSION,
      },
    })
    assert(result && typeof result._id === 'string' && result._id, 'INTERNAL_ERROR', '反馈提交失败')
    return { feedbackId: result._id }
  }

  return { submitFeedback }
}

module.exports = { FEEDBACK_MAX_CODE_POINTS, createFeedbackService, validateFeedbackInput }
