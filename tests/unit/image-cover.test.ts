import { describe, expect, it } from 'vitest'

const imageCover = require('../../cloudfunctions/inventoryApi/image-cover') as {
  DOWNLOAD_TIMEOUT_MS: number
  GENERATE_TIMEOUT_MS: number
  IMAGE_MODEL: string
  IMAGE_SIZE: string
  buildCoverPrompt(name: string): string
  coverCloudPath(ownerId: string, itemId: string, extension: string): string
  coverEnabled(): boolean
  createCoverService(options?: Record<string, unknown>): (input: { ownerId: string; itemId: string; name: string }) => Promise<{ fileID: string; cloudPath: string }>
  extensionOf(url: string, contentType?: string, buffer?: Buffer | null): string
  extractImageUrl(result: unknown): string
  sanitizeName(name: string): string
  sniffExtension(buffer: Buffer | null): string
}

function withEnv(name: string, value: string | undefined, run: () => void) {
  const saved = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    run()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

describe('image-cover sanitize / prompt', () => {
  it('strips control whitespace and truncates long names', () => {
    expect(imageCover.sanitizeName('  全麦\n面包\t大袋  ')).toBe('全麦 面包 大袋')
    expect(imageCover.sanitizeName('长'.repeat(50))).toHaveLength(30)
  })

  it('keeps the item name inside the hand-drawn prompt', () => {
    const prompt = imageCover.buildCoverPrompt('酸奶')
    expect(prompt).toContain('酸奶')
    expect(prompt).toContain('手绘')
  })

  it('never asks for a sticker style (that wording produced a grey backdrop)', () => {
    const prompt = imageCover.buildCoverPrompt('酸奶')
    expect(prompt).not.toContain('贴纸')
    expect(prompt).toContain('纯白色')
  })

  it('treats the kill switch as enabled by default and off only for explicit values', () => {
    withEnv('COVER_IMAGE_ENABLED', undefined, () => expect(imageCover.coverEnabled()).toBe(true))
    withEnv('COVER_IMAGE_ENABLED', 'false', () => expect(imageCover.coverEnabled()).toBe(false))
    withEnv('COVER_IMAGE_ENABLED', '0', () => expect(imageCover.coverEnabled()).toBe(false))
    withEnv('COVER_IMAGE_ENABLED', '1', () => expect(imageCover.coverEnabled()).toBe(true))
  })
})

describe('image-cover response shape', () => {
  it('extracts the first data url (OpenAI style)', () => {
    expect(imageCover.extractImageUrl({ data: [{ url: 'https://a/b.png' }] })).toBe('https://a/b.png')
  })

  it('falls back to imageUrl / url / raw string', () => {
    expect(imageCover.extractImageUrl({ imageUrl: 'https://a/1.jpg' })).toBe('https://a/1.jpg')
    expect(imageCover.extractImageUrl({ url: 'https://a/2.webp' })).toBe('https://a/2.webp')
    expect(imageCover.extractImageUrl('https://a/3.png')).toBe('https://a/3.png')
  })

  it('returns empty for unusable results so callers can fall back', () => {
    expect(imageCover.extractImageUrl(null)).toBe('')
    expect(imageCover.extractImageUrl({ data: [] })).toBe('')
    expect(imageCover.extractImageUrl({})).toBe('')
  })
})

describe('image-cover storage path', () => {
  it('hides the openid behind a hash and keeps the extension whitelist', () => {
    const path = imageCover.coverCloudPath('openid-1', 'item-1', 'png')
    expect(path).toMatch(/^covers\/[0-9a-f]{16}\/item-1-\d+\.png$/)
    expect(path).not.toContain('openid-1')
    expect(imageCover.extensionOf('https://a/b.png?sign=x')).toBe('png')
    expect(imageCover.extensionOf('https://a/b.webp')).toBe('webp')
    expect(imageCover.extensionOf('https://a/b.exe')).toBe('png')
  })

  it('prefers Content-Type over the url suffix (image urls often lie)', () => {
    expect(imageCover.extensionOf('https://a/b.png', 'image/jpeg')).toBe('jpg')
    expect(imageCover.extensionOf('https://a/no-ext', 'image/png')).toBe('png')
    expect(imageCover.extensionOf('https://a/no-ext', 'image/webp; charset=binary')).toBe('webp')
    expect(imageCover.extensionOf('https://a/no-ext', '')).toBe('png')
  })

  it('sniffs the magic bytes, because both the url and Content-Type lied', () => {
    // 实测：混元返回的 JPEG 字节，URL 无后缀、Content-Type 还声明 image/png。
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.alloc(8)])
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])
    const unknown = Buffer.alloc(16)

    expect(imageCover.sniffExtension(jpeg)).toBe('jpg')
    expect(imageCover.sniffExtension(png)).toBe('png')
    expect(imageCover.sniffExtension(webp)).toBe('webp')
    expect(imageCover.sniffExtension(unknown)).toBe('')

    // 魔数战胜 URL 后缀与 Content-Type。
    expect(imageCover.extensionOf('https://a/b.png', 'image/png', jpeg)).toBe('jpg')
    expect(imageCover.extensionOf('https://a/b.jpg', 'image/jpeg', png)).toBe('png')
  })
})

describe('image-cover service', () => {
  const ownerId = 'owner-1'
  const itemId = 'item-1'

  function fakeSdk(generateImpl: (input: unknown) => unknown) {
    return {
      ai() {
        return {
          createImageModel(provider: string) {
            expect(provider).toBe('hunyuan-image')
            return { generateImage: generateImpl }
          },
        }
      },
      uploadFile({ cloudPath, fileContent }: { cloudPath: string; fileContent: Buffer }) {
        return Promise.resolve({ fileID: `cloud://env.${cloudPath}` })
      },
    }
  }

  it('generates, downloads and uploads, returning the cloud fileID', async () => {
    const generate = imageCover.createCoverService({
      sdk: fakeSdk(() => Promise.resolve({ data: [{ url: 'https://cdn/img.png' }] })),
      fetchImage: () => Promise.resolve(Buffer.from('fake-image')),
    })
    const result = await generate({ ownerId, itemId, name: '牛奶' })
    expect(result.fileID).toMatch(/^cloud:\/\/env\.covers\//)
  })

  it('throws (never resolves) when the model returns no url', async () => {
    const generate = imageCover.createCoverService({
      sdk: fakeSdk(() => Promise.resolve({ data: [] })),
      fetchImage: () => Promise.resolve(Buffer.from('x')),
    })
    await expect(generate({ ownerId, itemId, name: '牛奶' })).rejects.toThrow('IMAGE_URL_MISSING')
  })

  it('throws when the generated image cannot be downloaded', async () => {
    const generate = imageCover.createCoverService({
      sdk: fakeSdk(() => Promise.resolve({ data: [{ url: 'https://cdn/img.png' }] })),
      fetchImage: () => Promise.resolve(Buffer.alloc(0)),
    })
    await expect(generate({ ownerId, itemId, name: '牛奶' })).rejects.toThrow('IMAGE_EMPTY')
  })

  it('names the stored object after the real bytes, not the url suffix or content type', async () => {
    const generate = imageCover.createCoverService({
      sdk: fakeSdk(() => Promise.resolve({ data: [{ url: 'https://cdn/img' }] })),
      fetchImage: () => Promise.resolve({ buffer: Buffer.from('jpeg-bytes'), contentType: 'image/jpeg' }),
    })
    // 传进来的 url 没有后缀，content-type 说是 jpeg；落库必须带正确扩展名。
    const result = await generate({ ownerId, itemId, name: '牛奶' })
    expect(result.cloudPath).toMatch(/\.jpg$/)

    const sniffed = imageCover.createCoverService({
      sdk: fakeSdk(() => Promise.resolve({ data: [{ url: 'https://cdn/img' }] })),
      // content-type 撒谎说 png，字节是 JPEG —— 以字节为准。
      fetchImage: () => Promise.resolve({
        buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]),
        contentType: 'image/png',
      }),
    })
    await expect(sniffed({ ownerId, itemId, name: '牛奶' })).resolves.toMatchObject({
      cloudPath: expect.stringMatching(/\.jpg$/),
    })
  })

  it('throws when storage upload fails', async () => {
    const sdk = fakeSdk(() => Promise.resolve({ data: [{ url: 'https://cdn/img.png' }] }))
    sdk.uploadFile = () => Promise.resolve({})
    const generate = imageCover.createCoverService({
      sdk,
      fetchImage: () => Promise.resolve(Buffer.from('fake-image')),
    })
    await expect(generate({ ownerId, itemId, name: '牛奶' })).rejects.toThrow('IMAGE_UPLOAD_FAILED')
  })

  it('fails fast when generation exceeds the budget (must stay under function timeout)', async () => {
    const generate = imageCover.createCoverService({
      sdk: fakeSdk(() => new Promise(() => {})),
      generateTimeoutMs: 30,
      fetchImage: () => Promise.resolve(Buffer.from('x')),
    })
    await expect(generate({ ownerId, itemId, name: '牛奶' })).rejects.toThrow('IMAGE_GENERATE_TIMEOUT')
    // 云函数超时是 60s（只能在云开发控制台配置）：两条独立预算之和必须留足余量，
    // 否则云函数被杀，调用方拿到的是 FUNCTION_TIMEOUT 而不是可降级的业务错误。
    expect(imageCover.GENERATE_TIMEOUT_MS + imageCover.DOWNLOAD_TIMEOUT_MS).toBeLessThan(50_000)
  })

  it('sends the live model id with revise/thinking disabled (old alias was retired)', async () => {
    let captured: Record<string, unknown> = {}
    const sdk = fakeSdk((input: unknown) => {
      captured = input as Record<string, unknown>
      return Promise.resolve({ data: [{ url: 'https://cdn/img.png' }] })
    })
    const generate = imageCover.createCoverService({
      sdk,
      fetchImage: () => Promise.resolve(Buffer.from('fake-image')),
      uploadFile: () => Promise.resolve({ fileID: 'cloud://f.png' }),
    })
    await generate({ ownerId, itemId, name: '牛奶' })
    // 'hunyuan-image' 作为 model 已于 2026-07-15 下线；必须是带版本号的具体模型。
    expect(captured.model).toBe(imageCover.IMAGE_MODEL)
    expect(captured.model).not.toBe('hunyuan-image')
    expect(captured.size).toBe(imageCover.IMAGE_SIZE)
    expect(captured.revise).toEqual({ value: false })
    expect(captured.enable_thinking).toEqual({ value: false })
    expect(captured.prompt).toContain('牛奶')
  })
})
