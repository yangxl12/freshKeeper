'use strict'

function truncate(value, maxLength) {
  return Array.from(String(value)).slice(0, maxLength).join('')
}

function formatTemplateDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value))
  if (!match) return String(value)
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`
}

function buildReminderTemplateData(item, daysLeft, fields) {
  const note = daysLeft === 0 ? '今天到期' : `还有${daysLeft}天到期`
  return {
    [fields.itemField]: { value: truncate(item.name, 20) },
    [fields.dateField]: { value: formatTemplateDate(item.expiryDate) },
    [fields.remainingDaysField]: { value: String(daysLeft) },
    [fields.quantityField]: { value: String(item.quantity) },
    [fields.noteField]: { value: truncate(note, 20) },
  }
}

module.exports = { buildReminderTemplateData, formatTemplateDate, truncate }
