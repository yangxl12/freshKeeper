/** 昵称长度按码点算，不按 UTF-16 单元：`.slice(20)` 会把 emoji 切成半个，渲染成方块。 */
const NICKNAME_MAX_CODE_POINTS = 20

/** 归一昵称：trim → 按码点截断 → 空白返回 null（null 表示「回默认昵称」）。 */
export function normalizeNickname(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return Array.from(trimmed).slice(0, NICKNAME_MAX_CODE_POINTS).join('')
}

/** 展示用：空或非默认才回落，避免把 null 直接渲染出来。 */
export function displayNickname(value: string | null | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback
}
