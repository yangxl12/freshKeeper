'use strict'

const TERMINAL_STATUSES = new Set(['sending', 'sent', 'unknown'])

function canArmReminder(status) {
  return !status || ['failed', 'cancelled'].includes(status)
}

function isTerminalReminderStatus(status) {
  return TERMINAL_STATUSES.has(status)
}

function canCancelReminder(status) {
  return ['scheduled', 'failed', 'cancelled'].includes(status)
}

module.exports = { canArmReminder, canCancelReminder, isTerminalReminderStatus }
