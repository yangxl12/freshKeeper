# 用户体系 B 档实现方案：昵称头像上云 + 数据导出

> 接 `docs/user-account-plan.md`（A 档）。本文假设 **A1 / A2 已完成**：
> `users` 集合已存在，`userApi` 已有 `touch` / `get` / `deleteAccount`，
> 且 `users` 已预留 `nickname` / `avatarFileId` 两个字段（A 档恒为 `null`）。

## 0. 范围

| 阶段 | 内容 | 收益 | 可独立上线 |
| --- | --- | --- | --- |
| **B1** | 昵称/头像上云，多端一致 | 换设备/清缓存不丢资料 | 是 |
| **B2** | 数据导出 | 合规（个人信息可携带） | 是 |

### 非目标

- C 档家庭共享（`ownerId` → `householdId` 全量迁移）。
- 头像裁剪 / 滤镜 / 多尺寸生成。
- 把 A 档的 `exportData` 之外的东西搬到 `userApi`。
- 改 `inventoryApi` 等业务函数。

---

## 1. 现状盘点（要动的就这三处）

| 位置 | 现在 | B 档后 |
| --- | --- | --- |
| `pages/mine/index.ts:readProfile` | 读 `wx.getStorageSync('mine_profile')` | 读云端，本地存储**降级为缓存** |
| `pages/mine/index.ts:saveProfile` | `wx.setStorageSync` | 调 `userApi.updateProfile` |
| `pages/mine/index.ts:chooseAvatar` | `saveFileSync` 到 `USER_DATA_PATH` | 上传云存储，存 `fileID` |

关键事实：

- `open-type="chooseAvatar"` 的 `event.detail.avatarUrl` 是**临时文件路径**，不是 fileID，**必须先上传**。
- 微信 `<image src="{{...}}">` **直接支持 `cloud://` fileID**，不用换临时 URL。`mine/index.wxml`
  的 `<image>` 一行都不用改。
- 客户端上传云存储的通道本项目已验证：`quick-entry-service.ts:uploadQuickEntryMedia`
  就是「云函数发 cloudPath → `wx.cloud.uploadFile` → 拿 fileID」。头像照抄，**不要自己发明新写法**。

---

## 2. 上传路径设计

新增 `userApi` action `createAvatarUpload`，返回：

```
{ cloudPath: `avatars/<sha256(openid)[:32]>/<时间戳>-<uuid>.<ext>` }
```

- **哈希而不明文**：云存储路径对所有云函数可见，明文 OPENID 不该落路径。与
  `covers/<sha1(ownerId)[:16]>/`、`quick-entry/<sha256(openid)[:32]>/` 同一约定。
- 好处：注销时能按 `avatars/<hash>/` 前缀一次性清干净（A2 的清理逻辑要同步加上这一族）。
- `ext` 从临时路径取，兜底 `png`；白名单 `png/jpg/jpeg/webp`，其余一律当 `png`。

---

## 3. 数据契约：`updateProfile`

语义：**局部更新**，只改传入的字段；`null` 表示清空（回默认态）。

| 字段 | 校验 |
| --- | --- |
| `nickname` | `string` 或 `null`；非 null 时 trim 后非空，**按码点长度** 1~20 |
| `avatarFileId` | `string` 或 `null`；非 null 时必须 `cloud://` 开头、长度 ≤512，且**含 `avatars/<当前用户hash>/` 前缀** |
| 其他任何字段 | `FORBIDDEN_FIELD` |

两个必须防的点：

**① 防挂别人的文件。** 只校验 `cloud://` 不够——用户可以把 B 的 fileID 填进来。
必须复刻 `quickEntryApi/validation.js:validateMedia` 的前缀比对：
`fileID.includes('/avatars/' + sha256(ownOpenid).slice(0,32) + '/')`，不匹配直接 `INVALID_ARGUMENT`。

**② 代理对（surrogate pair）陷阱。** 客户端现在是 `profileNickname.trim().slice(0, 20)`，
`.slice` 按 UTF-16 单元切，**emoji 昵称会被切成半个字符，渲染成方块**。
input 上的 `maxlength="20"` 同样按 UTF-16 计数，只能当软约束。
B 档一并修：客户端与服务端都改成 `Array.from(value).slice(0, 20).join('')`，服务端做最终把关。

---

## 4. 换头像完整流程（含旧图清理）

```
1. chooseAvatar                → 临时路径 avatarUrl
2. wx.compressImage({ src, quality: 80 })
3. createAvatarUpload          → cloudPath
4. wx.cloud.uploadFile         → fileID
5. updateProfile({ avatarFileId: fileID })
6. 服务端：读旧 avatarFileId，与新的不同 → 更新成功后 cloud.deleteFile(旧)
```

- **第 2 步别省**：`chooseAvatar` 拿到的是原图，可能几 MB。压缩后再传，上传耗时和存储都省。
  压缩失败就退回原图继续，不要中断流程。
- **第 6 步必须失败静默**：删旧文件失败只记日志，**不回滚更新、不向用户报错**。
  与 `inventoryApi/image-cover.js` 的 fire-and-forget 一致。遗留的孤儿文件可接受，
  注销时按前缀统一清。
- 用户连点保存要防重入（`saving` 标志 + 按钮 disabled），否则会并发上传出一堆孤儿。
- 头像 fileID 直接给 `<image>` 用。已知权衡：云存储默认权限下，**知道 fileID 就能读**；
  但 fileID 里的目录是 openid 哈希，不可枚举，对头像这种非敏感数据够用。
  要更强隔离得改存储安全规则，A/B 档不做。

---

## 5. 读取与降级

`pages/mine` onShow 里**并发**读，不要串行：

```
Promise.all([ getSettings(), getUserProfile() ])
```

- 云端成功 → 覆盖本地缓存 `mine_profile`（本地存储从此只是缓存 + 离线兜底）。
- 云端失败 → **用本地缓存渲染，profile 区不显示错误态，静默降级**。
  设置区照旧走 `settingsError` 那套。理由：资料读不到不影响任何核心操作，
  弹错误提示只会制造焦虑。
- **读节流**：`onShow` 每次都请求太浪费。模块级记一个时间戳，60s 内不重复读；
  用户保存成功后强制重置，保证改完立刻一致。

---

## 6. 存量数据迁移（本地 → 云端）

存量用户的 `mine_profile` 躺在本地，云端还是 `null`。两个选项：

| 方案 | 说明 |
| --- | --- |
| 不迁移 | 最省事。用户下次改资料才写云端，之前继续读本地缓存 |
| **条件式一次性迁移（推荐）** | 打开资料弹窗时判断，满足条件才推云端，成功后置 `profile_migrated=true` |

迁移条件必须是**两个都满足**：

```
云端 nickname === null
且 ( 本地 nickname !== '保质记用户'  或  本地 avatar 非空 )
```

**为什么必须带"非默认值"条件**：默认昵称"保质记用户"是占位符，把它迁上云等于没迁，
只会往 `users` 里灌噪音，还会让"用户到底改没改过资料"这个判断失真。

其他约束：

- **本地头像迁移要容错**。本地头像路径指向 `USER_DATA_PATH`，重装或清缓存后文件已不存在，
  上传必然失败 → **只迁昵称，头像留空让用户重选**，不要因为头像失败整个迁移失败。
- **迁移不放 `onLaunch`**。上传是重操作，会拖慢启动。放"打开资料弹窗"这个低频路径。
- 迁移成功后要清掉本地头像的失效路径，否则下次 `<image src>` 会一直加载失败。

---

## 7. B2：数据导出

### 7.1 导出什么

| 来源 | 含 | 不含 |
| --- | --- | --- |
| `inventory_items` | 全部状态（active / used_up / discarded），含 `coverFileId` | — |
| `user_settings` | `defaultReminderLeadDays` | `ownerId` / `_id` |
| `users` | `nickname` / `createdAt` / `lastSeenAt` | `_id` / `ownerId` |
| `reminder_jobs` | 提醒时间与状态 | `templateId`（系统配置，不属于用户数据） |

### 7.2 为什么不直接把 JSON 返回给客户端

云函数响应体有大小上限（约 1MB），物品多了必然超。所以走云存储中转，
客户端拿 `fileID` 自己下载。

### 7.3 流程

```
userApi action exportData
  → 分批读 items（每次 100 条，循环拼装）
  → buildExportPayload()          纯函数，可单测
  → JSON.stringify(payload, null, 2)
  → cloud.uploadFile → exports/<sha256(openid)[:32]>/<YYYYMMDD-HHmmss>.txt
  → users.lastExportedAt = serverDate
  → 返回 { fileID, fileName }

客户端
  → wx.cloud.downloadFile({ fileID }) → tempFilePath
  → wx.shareFileMessage({ filePath, fileName })    转发到文件传输助手
  → 收尾：云端 deleteFile(导出文件) + 本地 unlink(tempFilePath)
```

### 7.4 格式选择：`.txt` 里装 JSON，不用 `.json`

三个平台事实叠在一起，只有 `.txt` 能走通：

1. `wx.openDocument` 支持的类型是 doc/docx/xls/xlsx/ppt/pptx/pdf —— **既不支持 `.json` 也不支持 `.txt`**。
   所以**不用 `openDocument`**。
2. 只能走 `wx.shareFileMessage`：转发到微信会话（文件传输助手），在电脑端打开。
3. `shareFileMessage` 对 `.json` 扩展名支持不稳，**`.txt` 最保险**，内容仍是完整 JSON，机器可读。

文件名建议 `保质记-数据导出-20260911-1314.txt`（用户看得懂、按时间可区分）。

### 7.5 配额与记录

- `users` 加 `lastExportedAt: serverDate`。合规上"已提供过导出"需要留痕，排障也用得上。
- 加每日限次。**计数落库，不要用实例内存**（复用 `quickEntryApi/ai-quota.js` 的实例内存思路在这里是错的
  —— 导出频率低，实例内存会被冷启动清空，计数不准）。在 `users` 上加
  `exportCountDate` + `exportCount` 两个字段，按上海日期滚动即可。

---

## 8. 测试清单

沿用项目标准：纯逻辑抽纯函数、页面用 stub、改行为必补测试。

**纯函数**

- `normalizeNickname(raw)`：码点截断（emoji 不被切开）、trim、纯空白 → `null`、恰好 20 码点边界。
- `avatarCloudPath(hash, ext)`：前缀与扩展名白名单。
- `shouldMigrateProfile(localProfile, remoteProfile)`：默认昵称**不**迁 / 非默认迁 / 云端已有值不迁 / 头像失效只迁昵称。
- `buildExportPayload(items, settings, user, reminders)`：快照测试，断言**不含** `ownerId` / `_id` / `templateId`。

**页面 / 服务**

- `saveProfile` 调的是 `updateProfile`，**不再**直接 `setStorageSync`（spy 断言）。
- 选头像后的调用顺序：`compressImage` → `createAvatarUpload` → `uploadFile` → `updateProfile`。
- `compressImage` 失败仍继续上传原图。
- 云端读失败 → 回退本地缓存渲染，页面不进入错误态。
- 读节流：60s 内二次 `onShow` 不重复请求；保存后重置节流。
- 防重入：保存中点第二次不重复提交。

---

## 9. 验收

- [ ] 设备 A 改昵称/头像 → 设备 B 打开「我的」，看到相同内容（B 档的核心收益）。
- [ ] 昵称填超 20 个码点的 emoji 串 → 保存后无方块乱码，服务端按码点截断。
- [ ] 连换三次头像 → 云存储 `avatars/<hash>/` 下只剩 1 个文件；删旧失败时留残留但不影响功能。
- [ ] 手工构造别人的 `avatarFileId` 提交 → `INVALID_ARGUMENT`。
- [ ] 存量用户首次打开资料弹窗 → 非默认昵称被迁到云端；默认昵称「保质记用户」不被迁。
- [ ] 导出：20 条 / 300 条物品各跑一次都在云函数超时内；转发到文件传输助手能打开，JSON 完整且不含标识字段。
- [ ] 导出后 `users.lastExportedAt` 有值；超每日限次返回明确错误码。
- [ ] 注销（A2）后 `covers/` 与 `avatars/` 下该用户目录都清空。
- [ ] `npm run check` 全绿。

---

## 10. 部署与回滚

1. `userApi` 增加 `createAvatarUpload` / `updateProfile` / `exportData` 三个 action，重新部署。
   这次是**更新部署**，A 档首建时写好的 `timeout: 60` 沿用即可，不用再动控制台。
2. 前端发版。
3. 《用户隐私保护指引》补一条：**收集昵称与头像用于个人资料展示**。这是审核项，别漏。
4. 回滚：前端回滚即可。云端 `updateProfile` / `exportData` 保留无副作用；
   本地存储仍是兜底缓存，回滚后资料不丢（最多是失去多端一致性）。

---

## 11. 需要真机验证的两点

1. `type="nickname"` 输入框 + 微信键盘的"使用微信昵称"自动填充，
   **`bindinput` 是否触发**（部分 Android 版本不触发，导致保存的昵称是旧值）。
   若不触发，补 `bindblur` 兜底读取。
2. `wx.shareFileMessage` 对 `.txt` 的实际行为（是否能选中"文件传输助手"、
   电脑端打开后 JSON 是否完整）。这是导出链路上唯一没在项目里验证过的 API。
