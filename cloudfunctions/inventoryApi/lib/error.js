'use strict'

class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

function assert(condition, code, message) {
  if (!condition) throw new AppError(code, message)
}

function normalizeError(error) {
  if (error instanceof AppError) return error
  return new AppError('INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
}

module.exports = { AppError, assert, normalizeError }
