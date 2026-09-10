import { describe, expect, it } from 'vitest'

const imageCover = require('../../cloudfunctions/inventoryApi/image-cover') as {
  GENERATE_TIMEOUT_MS: number
  buildCoverPrompt(name: string): string
  coverCloudPath(ownerId: string, itemId: string, extension: string): string
  coverEnabled(): boolean
  createCoverService(options?: Record<string, unknown>): (input: { ownerId: string; itemId: string; name: string }) => Promise<{ fileID: string; cloudPath: string }>
  extensionOf(url: string): string
  extractImageUrl(result: unknown): string
  sanitizeName(name: string): string
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
    expect(imageCover.GENERATE_TIMEOUT_MS).toBeLessThan(10_000)
  })
})
