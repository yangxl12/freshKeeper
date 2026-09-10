'use strict'

// AI 生成物品封面小图。全项目只有这里知道生图 provider、模型名和生图返回结构。
// 设计要点：
// - 物品保存成功后由前端 fire-and-forget 调用 generateCover，任何失败都直接抛错，
//   物品保持无 coverFileId（前端继续显示默认占位图），绝不阻塞也不影响保存主流程。
// - hunyuan-image 返回的是临时 URL，会过期：这里必须下载后转存云存储，物品只落 fileID。
// - COVER_IMAGE_ENABLED=false/0/off/no 是急停开关（免费额度耗尽时在控制台设置），
//   与 ai-client.js 的 QUICK_ENTRY_AI_ENABLED 同一套约定。

const crypto = require('node:crypto')
const https = require('node:https')
const http = require('node:http')

const IMAGE_PROVIDER = 'hunyuan-image' // provider / 模型名只允许出现在这个文件里
const IMAGE_MODEL = 'hunyuan-image'
// inventoryApi 云函数整体超时 10s：生图 8s + 下载 6s 并行不可能都顶满，
// 两个预算各自独立限制，保证最坏情况也能在 10s 内失败返回。
const GENERATE_TIMEOUT_MS = 8000
const DOWNLOAD_TIMEOUT_MS = 6000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_NAME_LENGTH = 30

let sdkCache = null

function loadSdk() {
  if (!sdkCache) sdkCache = require('wx-server-sdk')
  return sdkCache
}

function coverEnabled() {
  const value = String(process.env.COVER_IMAGE_ENABLED || '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(value)
}

// 名称直接进 prompt，不能带控制字符/超长内容；截断即可，不做更多猜测。
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
}

function buildCoverPrompt(name) {
  return `手绘儿童绘本贴纸风格的${sanitizeName(name)}插画，单个主体居中构图，圆润可爱的粗线条描边，柔和明快的暖色调，扁平简洁，纯白色背景，画面中没有任何文字`
}

// 生图返回结构只在这里收敛：优先 OpenAI 风格 data[0].url，宽容收 imageUrl / url。
function extractImageUrl(result) {
  if (!result) return ''
  if (typeof result === 'string') return result.trim()
  if (Array.isArray(result.data) && result.data[0]) {
    const first = result.data[0]
    if (typeof first === 'string') return first.trim()
    if (first && typeof first.url === 'string') return first.url.trim()
  }
  if (typeof result.imageUrl === 'string') return result.imageUrl.trim()
  if (typeof result.url === 'string') return result.url.trim()
  return ''
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('http://') ? http : https
    const request = transport.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`IMAGE_DOWNLOAD_STATUS_${response.statusCode}`))
        return
      }
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_IMAGE_BYTES) {
          request.destroy()
          reject(new Error('IMAGE_TOO_LARGE'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error('IMAGE_DOWNLOAD_TIMEOUT')))
  })
}

function extensionOf(url) {
  const match = /\.([a-z0-9]{3,5})(?:[?#]|$)/i.exec(String(url || ''))
  const extension = match && match[1] ? match[1].toLowerCase() : 'png'
  return ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ? extension : 'png'
}

function coverCloudPath(ownerId, itemId, extension) {
  // ownerId 不进明文路径：云存储路径对所有云函数可见，做一层单向哈希。
  const ownerHash = crypto.createHash('sha1').update(String(ownerId || '')).digest('hex').slice(0, 16)
  return `covers/${ownerHash}/${itemId}-${Date.now()}.${extension}`
}

/**
 * 造一个 generateCoverImage({ ownerId, itemId, name }) -> { fileID, cloudPath }。
 * 单测里传 { sdk: fakeSdk, fetchImage, uploadFile } 即可，不会真的加载 wx-server-sdk。
 */
function createCoverService(options = {}) {
  const deps = {
    sdk: options.sdk || null,
    fetchImage: options.fetchImage || downloadImage,
    uploadFile: options.uploadFile || null,
    provider: options.provider || IMAGE_PROVIDER,
    model: options.model || IMAGE_MODEL,
    generateTimeoutMs: options.generateTimeoutMs || GENERATE_TIMEOUT_MS,
  }

  return async function generateCoverImage({ ownerId, itemId, name }) {
    const client = deps.sdk || loadSdk()
    const ai = client.ai()
    assert(ai && typeof ai.createImageModel === 'function', 'IMAGE_GEN_UNAVAILABLE')
    const imageModel = ai.createImageModel(deps.provider)
    assert(imageModel && typeof imageModel.generateImage === 'function', 'IMAGE_GEN_UNAVAILABLE')

    const result = await withTimeout(
      imageModel.generateImage({ model: deps.model, prompt: buildCoverPrompt(name), n: 1 }),
      deps.generateTimeoutMs,
      'IMAGE_GENERATE',
    )
    const imageUrl = extractImageUrl(result)
    if (!imageUrl) throw new Error('IMAGE_URL_MISSING')

    const buffer = await withTimeout(Promise.resolve(deps.fetchImage(imageUrl)), DOWNLOAD_TIMEOUT_MS, 'IMAGE_DOWNLOAD')
    if (!buffer || !buffer.length) throw new Error('IMAGE_EMPTY')

    const cloudPath = coverCloudPath(ownerId, itemId, extensionOf(imageUrl))
    const upload = deps.uploadFile || ((params) => client.uploadFile(params))
    const uploadResult = await upload({ cloudPath, fileContent: buffer })
    if (!uploadResult || !uploadResult.fileID) throw new Error('IMAGE_UPLOAD_FAILED')
    return { fileID: uploadResult.fileID, cloudPath }
  }
}

function assert(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code })
}

module.exports = {
  GENERATE_TIMEOUT_MS,
  buildCoverPrompt,
  coverCloudPath,
  coverEnabled,
  createCoverService,
  extensionOf,
  extractImageUrl,
  sanitizeName,
}
