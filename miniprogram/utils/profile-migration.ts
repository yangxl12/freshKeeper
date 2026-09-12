/**
 * 存量资料迁移判定：本地 `mine_profile` 里的资料要不要推到云端 `users`。
 * 只有「云端还是空的」且「本地确实改过」才迁——默认昵称是占位符，迁上去只会污染数据，
 * 还会让「用户到底改没改过资料」这个判断失真。
 */
export interface LocalProfile {
  nickname: string
  avatar: string
}

export interface RemoteProfile {
  nickname: string | null
  avatarFileId: string | null
}

export function shouldMigrateProfile(
  local: LocalProfile,
  remote: RemoteProfile | null,
  defaultNickname: string,
): boolean {
  if (!remote || remote.nickname !== null) return false
  const nicknameChanged = Boolean(local.nickname) && local.nickname !== defaultNickname
  // 已经是 cloud:// 的头像说明它本来就在云端，再迁一次只会把云端的值覆盖成空。
  const avatarPending = Boolean(local.avatar) && !local.avatar.startsWith('cloud://')
  return nicknameChanged || avatarPending
}
