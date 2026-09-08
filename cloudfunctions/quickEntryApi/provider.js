'use strict'

const { assert, fail } = require('./validation')

function providerConfigured(kind) {
  return Boolean(process.env[`QUICK_ENTRY_${kind}_ENDPOINT`] && process.env[`QUICK_ENTRY_${kind}_API_KEY`])
}

async function requestProvider(kind, payload) {
  assert(providerConfigured(kind), 'AI_UNAVAILABLE', '识别服务暂未配置，请使用完整填写')
  const endpoint = process.env[`QUICK_ENTRY_${kind}_ENDPOINT`]
  assert(/^https:\/\//i.test(endpoint), 'AI_UNAVAILABLE', '识别服务地址配置不正确')
  const timeout = Math.min(30000, Math.max(1000, Number(process.env.QUICK_ENTRY_TIMEOUT_MS) || 8000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env[`QUICK_ENTRY_${kind}_API_KEY`]}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(process.env[`QUICK_ENTRY_${kind}_MODEL`] ? { model: process.env[`QUICK_ENTRY_${kind}_MODEL`] } : {}),
        ...payload,
      }),
      signal: controller.signal,
    })
    const body = await response.text()
    assert(body.length <= 1024 * 1024, 'INVALID_PROVIDER_RESPONSE', '识别服务响应过大')
    assert(response.ok, 'AI_UNAVAILABLE', '识别服务暂时不可用，请稍后重试')
    try {
      return JSON.parse(body)
    } catch (_error) {
      fail('INVALID_PROVIDER_RESPONSE', '识别服务返回格式不正确')
    }
  } catch (error) {
    if (error?.name === 'AbortError') fail('QUICK_ENTRY_TIMEOUT', '识别超时，请重试或使用完整填写')
    if (error?.code) throw error
    fail('AI_UNAVAILABLE', '识别服务暂时不可用，请稍后重试')
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { providerConfigured, requestProvider }
