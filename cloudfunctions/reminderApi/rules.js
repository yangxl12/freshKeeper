'use strict'

/** 发出去就结束的状态：不再重开、也不再重试，避免重复推送。 */
const TERMINAL_STATUSES = new Set(['sending', 'sent', 'unknown'])

function isTerminalReminderStatus(status) {
  return TERMINAL_STATUSES.has(status)
}

module.exports = { isTerminalReminderStatus }
