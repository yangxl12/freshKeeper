import { describe, expect, it } from 'vitest'

import { displayNickname, normalizeNickname } from '../../miniprogram/utils/nickname'
import { shouldMigrateProfile } from '../../miniprogram/utils/profile-migration'

const DEFAULT_NICKNAME = '保质记用户'

describe('normalizeNickname（客户端）', () => {
  it('去空白并按码点截断', () => {
    expect(normalizeNickname('  龙哥  ')).toBe('龙哥')
    expect(normalizeNickname('   ')).toBeNull()
    expect(normalizeNickname('')).toBeNull()
  })

  it('emoji 昵称不会被切成半个（UTF-16 slice 的坑）', () => {
    const value = normalizeNickname('😀'.repeat(15)) as string
    expect(Array.from(value)).toHaveLength(15)
    // 30 个 UTF-16 单元、15 个码点：按 slice(20) 切会留下半个代理对。
    expect(value).not.toContain('�')

    const mixed = normalizeNickname('a'.repeat(19) + '😀') as string
    expect(Array.from(mixed)).toHaveLength(20)
    expect(mixed.endsWith('😀')).toBe(true)
  })

  it('超长普通昵称截到 20 个码点', () => {
    expect(normalizeNickname('长'.repeat(50)) as string).toBe('长'.repeat(20))
  })
})

describe('displayNickname', () => {
  it('空值回落默认昵称', () => {
    expect(displayNickname(null, DEFAULT_NICKNAME)).toBe(DEFAULT_NICKNAME)
    expect(displayNickname('  ', DEFAULT_NICKNAME)).toBe(DEFAULT_NICKNAME)
    expect(displayNickname('龙哥', DEFAULT_NICKNAME)).toBe('龙哥')
  })
})

describe('shouldMigrateProfile', () => {
  it('默认昵称 + 没头像 → 不迁（占位符不该污染云端）', () => {
    expect(
      shouldMigrateProfile({ nickname: DEFAULT_NICKNAME, avatar: '' }, { nickname: null, avatarFileId: null }, DEFAULT_NICKNAME),
    ).toBe(false)
  })

  it('改过昵称 → 迁', () => {
    expect(
      shouldMigrateProfile({ nickname: '龙哥', avatar: '' }, { nickname: null, avatarFileId: null }, DEFAULT_NICKNAME),
    ).toBe(true)
  })

  it('只有头像 → 也迁', () => {
    expect(
      shouldMigrateProfile(
        { nickname: DEFAULT_NICKNAME, avatar: 'wxfile://x.png' },
        { nickname: null, avatarFileId: null },
        DEFAULT_NICKNAME,
      ),
    ).toBe(true)
  })

  it('本地头像已经是 cloud:// → 不迁（别把云端已有的头像清掉）', () => {
    expect(
      shouldMigrateProfile(
        { nickname: DEFAULT_NICKNAME, avatar: 'cloud://env.1/avatars/x.png' },
        { nickname: null, avatarFileId: 'cloud://env.1/avatars/x.png' },
        DEFAULT_NICKNAME,
      ),
    ).toBe(false)
  })

  it('云端已有昵称 → 不迁（云端为准）', () => {
    expect(
      shouldMigrateProfile({ nickname: '龙哥', avatar: '' }, { nickname: '云端昵称', avatarFileId: null }, DEFAULT_NICKNAME),
    ).toBe(false)
  })

  it('还没读到云端档案 → 不迁', () => {
    expect(shouldMigrateProfile({ nickname: '龙哥', avatar: '' }, null, DEFAULT_NICKNAME)).toBe(false)
  })
})
