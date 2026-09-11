# 用户体系 A 档实现方案：用户档案层 + 账号注销

## 0. 范围与前提

**本文只做 A 档**，不改任何现有业务集合的字段与查询语义。

| 阶段 | 内容 | 可独立上线 |
| --- | --- | --- |
| **A1** | 引入 `users` 集合 + 新增 `userApi` 云函数 + 客户端启动时轻量上报 | 是，纯增量 |
| **A2** | 账号注销（清空我的数据） | 是，依赖 A1 |

A2 是微信审核与《个人信息保护法》的硬性要求（"必须提供删除个人信息的方式"），
建议紧随 A1 一起做，别拖到上架前才补。若本轮只想动最小面，可先只上 A1。

### 非目标（本档明确不做）

- 昵称/头像上云（B 档）。`pages/mine` 的 `mine_profile` 本地存储**原样保留**。
- 家庭共享 / 多成员 / 权限（C 档，需要 `ownerId` → `householdId` 的全量迁移）。
- 数据导出、unionid 接入、封禁黑名单。
- 改动 `inventoryApi` / `settingsApi` / `reminderApi` / `quickEntryApi` 的鉴权与查询逻辑。

### 必须遵守的既有约束

1. 身份只有一个来源：`cloud.getWXContext().OPENID`。前端不传身份字段，云函数一律拒绝。
2. 所有集合的客户端权限为「无权限」，只允许云函数访问。
3. 错误统一 `{ ok, error: { code, message }, requestId }`，日志只打 `requestId / action / resultCode / durationMs`。
4. 时间判定统一 `Asia/Shanghai`；`config.json` 的 `timeout` 只在函数首建时生效。
5. 改动必须过 `npm run check`（typecheck + test + check:project），并补测试。

---

## 1. 设计决策

### D1. `users` 由谁写：新增独立 `userApi`，不在业务函数里写

| 方案 | 结论 |
| --- | --- |
| 四个业务函数入口各自 upsert | ❌ 写放大：每次业务调用多一次 DB 写；且活跃度统计被调用次数污染 |
| 只在业务写入（save/update）时 upsert | ❌ 只读用户（打开看一眼就退）统计不到 |
| 新增 `userApi`，客户端启动调一次 `touch` | ✅ 单点、可节流、职责清晰，注销也需要一个独立入口 |

### D2. `touch` 双层节流，按上海日期判定

每次冷启动都写 `lastSeenAt` 是浪费（一天开十次写十次）。两层一起做：

- **客户端**：本地存 `user_touch_date`，与当前上海日期相同则跳过调用。
- **服务端**：读出档案，若 `lastSeenAt` 已是今天（上海时区）则直接返回、不写库。
  兜住多端同日登录和用户手改本地时间的情况。

### D3. 沿用"先查再写"，不用 `.update()` 的副作用

云开发 `doc().update()` 对不存在的文档返回 `updated: 0`，本项目的既有做法（`settingsApi`）是
**先 `find` 再决定 `update` / `set`**。A 档保持同一写法，不引入未在本项目验证过的平台行为。
（若想省一次读，需先用探针实测 `update` 对不存在文档的真实返回，验证后再改。）

### D4. `ownerId` 冗余保留

`_id` 已经是 OPENID，理论上不必再存 `ownerId`。但 `user_settings` 是 `_id: ownerId, ownerId` 双写，
为保持"所有集合都能用同一个 `where({ ownerId })` 扫"的一致性，`users` 同样写入 `ownerId`。

### D5. 不用 `_openid` 自动字段

`_openid` 只在客户端直连数据库写入时自动生成。本项目全部走云函数，该字段不会出现，
因此 `ownerId` 必须显式写。**不要**为了拿 `_openid` 而开放集合权限。

---

## 2. 数据模型

集合名：`users`，`_id = OPENID`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 微信 OPENID，也是主键，一人一档 |
| `ownerId` | string | 与 `_id` 相同，见 D4 |
| `nickname` | string/null | A1 恒为 `null`，B 档启用（≤20 字） |
| `avatarFileId` | string/null | A1 恒为 `null`，B 档启用（云存储 `cloud://`） |
| `createdAt` | serverDate | 首次 touch 时写入，此后不再改 |
| `lastSeenAt` | serverDate | 每次有效 touch 更新 |
| `schemaVersion` | number | 初值 `1`，后续字段演进用 |

Android/后端读取注意：`serverDate` 落库后是 Date，返回客户端可能是时间戳/ISO 串，
前端只做展示，别参与日期比较——比较一律在服务端用上海日期串做。

---

## 3. 云函数 `userApi`

新建目录 `cloudfunctions/userApi/`，结构对齐 `settingsApi`（`index.js` + `error.js` + `validation.js` + `config.json` + `package.json`）。

### 3.1 Action 契约

| action | 入参 | 返回 | 阶段 |
| --- | --- | --- | --- |
| `touch` | 无 | `{ created: boolean, lastSeenAt: string }` | A1 |
| `get` | 无 | `{ nickname, avatarFileId, createdAt, lastSeenAt }` | A1 |
| `updateProfile` | `data: { nickname?, avatarFileId? }` | 更新后的档案 | B 档启用，A1 先留壳或直接不实现 |
| `deleteAccount` | `data: { confirm: 'DELETE' }` | `{ deleted: { items, reminders, settings, files } }` | A2 |

入口统一复用现有骨架：`assertSafeEvent` → 取 `OPENID` → `handlers[action]` → 统一包 `{ ok, data, requestId }`，
`AppError` 未命中降级为 `INTERNAL_ERROR`。**这一份骨架在 4 个函数里已各抄了一遍**，
A 档不做公共模块抽取（会牵动 4 个函数的部署），仅在 `userApi` 内自成一份。

### 3.2 `touch` 逻辑

```
ownerId = getWXContext().OPENID
today   = 上海日期串
doc     = where({ _id: ownerId }).limit(1).get()

不存在 → doc(ownerId).set({ ownerId, nickname: null, avatarFileId: null,
                            createdAt: serverDate, lastSeenAt: serverDate, schemaVersion: 1 })
                       → { created: true }

存在且 lastSeenAt 已是今天 → 直接返回，不写库
存在且过期 → where({ _id, ownerId }).update({ lastSeenAt: serverDate })
```

### 3.3 `deleteAccount` 逻辑（A2，顺序不能错）

**核心顺序：先收集 fileID → 删云存储 → 删数据库。** 反过来就收集不到 `coverFileId` 了。

```
0) 校验 data.confirm === 'DELETE'，否则 INVALID_ARGUMENT（防误触，服务端二次把关）
1) 分批读出 inventory_items（where ownerId，每次 100 条），
   收集 coverFileId 非空的 fileID 列表 + 各集合总数
2) 分批 cloud.deleteFile：单次最多 50 个 fileID（平台限制），循环直到删完
3) 分批 remove：
   - inventory_items  where({ ownerId })
   - reminder_jobs     where({ ownerId })
   - user_settings     where({ ownerId })
   - users             where({ _id: ownerId })
   云函数端单次 remove 上限 1000 条；外层加循环 + 最大轮次（建议 20 轮），
   超限直接报错，让用户重试（重试天然幂等）
4) 返回各集合删除条数
```

要点：

- **幂等天然成立**：删干净后再调就是空删，不做墓碑文档。留一条 `deletedAt` 标记反而是残留个人信息。
- **注销后重新进入 = 新用户**，会重新 touch 出一条空档案。这是预期行为，在 UI 文案里说清楚。
- **孤儿文件**：快录临时媒体（`quick-entry/<hash>/...`）正常在识别后就被
  `removeTemporaryFile` 删掉，注销时不保证清空。**不为此新增云存储列举逻辑**——
  若日后发现残留，用 `covers/<sha1(ownerId)[:16]>/` 与 `quick-entry/<sha256(openid)[:32]>/`
  两个前缀做一次离线清理即可。
- **超时必须调大**：`userApi/config.json` 写 `"timeout": 60`。
  ⚠️ 该项目已知坑：`config.json` 的 `timeout` **只在函数首次创建时写入云端**，
  所以必须在**首建前**就把 config 写对，或者建完后去云开发控制台改。deploy 不会重新应用。
- **注意云函数单实例内存**：不要在 `deleteAccount` 里缓存海量 fileID。本项目假设单用户 <500 条，
  一次 `get(100)` 分批收集即可，够用。

---

## 4. 客户端改造

### 4.1 新增 `miniprogram/services/user-service.ts`

对齐 `settings-service.ts` 的写法，全部走 `callCloud`：

```ts
export function touchUser(): Promise<{ created: boolean; lastSeenAt: string }>
export function getUserProfile(): Promise<UserProfile>
export function deleteAccount(): Promise<DeleteAccountResult>   // A2
```

### 4.2 `miniprogram/app.ts` onLaunch

在 `wx.cloud.init(...)` 之后追加一次静默上报：

```
onLaunch() {
  ...wx.cloud.init(...)

  // 用户活跃埋点：同一天只调一次；失败静默，不阻塞启动。
  try {
    const today = <上海日期串>
    if (wx.getStorageSync(TOUCH_STORAGE_KEY) !== today) {
      void touchUser()
        .then(() => wx.setStorageSync(TOUCH_STORAGE_KEY, today))
        .catch(() => {})
    }
  } catch (_error) {}
}
```

- **只在 `onLaunch` 调，不要放 `onShow`**：小程序频繁前后台切换会反复触发。
- 失败必须静默：这是埋点，不是核心链路。
- 上海日期串的生成放 `services/`（或复用 `domain/` 里的日期工具），
  **不要**在 `app.ts` 里手写时区换算。

### 4.3 注销入口（A2）

位置：`pages/mine` 的"设置"弹窗（`activeModal === 'settings'`）底部新增一行危险操作，
或独立第 6 个 entry。建议独立 entry（`data-entry="account"`），
沿用现有 `.entry` / `.entry__icon--*` 样式 + 新建一个红色图标资源。

交互必须**两步确认**（不可逆）： 

1. `wx.showModal` 说明后果，列清楚"将删除：全部物品、回收站、提醒任务、提醒设置"。
2. 第二次 `wx.showModal`，`confirmText: '确认注销'`、`confirmColor: '#A33F32'`，文案强调不可恢复。
3. 调 `deleteAccount()` → 成功后 `wx.clearStorage()`（清掉 `mine_profile` / 草稿 / `user_touch_date`）→ `wx.reLaunch` 回首页。

渠道注意：

- **不要用 toast 提示结果**。项目已知：微信 toast 超 7 个汉字被截断。用 `wx.showModal` 或页面内状态展示。
- 删除过程中要有 loading 态（`wx.showLoading` + `wx.hideLoading`），因为可能要删几百条。
- 失败要给出可重试的提示（幂等，重试安全）。

### 4.4 隐私指引（A2 配套）

《用户隐私保护指引》里需补一条"用户如何删除/注销个人信息"的说明，指向 `pages/mine` 的注销入口。
这是审核项，代码之外的操作，别漏。

---

## 5. 权限、索引与部署

### 5.1 权限

| 项 | 配置 |
| --- | --- |
| `users` 集合 | 客户端读写权限 **全部"无权限"** |
| `userApi` | 「已登录用户可调用」 |

### 5.2 索引

- `_id` 是主键，`touch` / `get` / `deleteAccount` 都命中主键或 `ownerId` 单字段，**A 档无需新增索引**。
- 可选（后加）：`lastSeenAt DESC`，供运营侧排"最近活跃"。不参与线上业务，不急。

### 5.3 部署顺序

1. 控制台创建 `users` 集合，权限设为无。
2. 在 `createMediaUpload` 同款前提下确认 `userApi/config.json` 已含 `"timeout": 60`，
   然后**首次**上传部署 `userApi`（"云端安装依赖"）。
3. 若首建时 timeout 没写对 → 去云开发控制台手动改成 60s（CLI 没有该命令）。
4. 前端发版（onLaunch touch）。
5. A2 发版注销入口。

### 5.4 回滚

- A1 纯增量：前端回滚即可，`users` 集合留着无害，不产生孤儿。
- A2 回滚：前端入口先摘掉；`userApi.deleteAccount` 保留不影响任何东西。

---

## 6. 测试清单

沿用项目标准：改行为必补测试，组件/服务层用 stub，纯逻辑抽纯函数。

- **纯函数** `shouldTouchToday(lastSeenAt, today)`：跨天 / 同日 / 无记录 / 异常值。
- **纯函数** `chunk(list, size)`：用于 fileID（50）与 items（100）分批。
- **`updateProfile` 校验**：字段白名单（只允许 `nickname` / `avatarFileId`）、
  昵称长度上限、`avatarFileId` 必须是 `cloud://` 且前缀属于当前用户（复刻
  `quickEntryApi/validation.js:validateMedia` 的前缀比对思路，前缀为 `avatars/<sha256(openid)[:32]>/`）。
- **`deleteAccount`**：用假 db / 假 `deleteFile` 断言 ① 先收集 fileID 再删存储 ② 分批调用次数 ③ 各集合都被删。
- **前端 `user-service.ts`**：`callCloud` 的 action 与 data 形状。
- **`app.ts` 节流**：同日不重复调用、调用失败不写本地 key。

---

## 7. 验收

- [ ] 新用户首次进入 → `users` 出现一条 `_id = OPENID`、`createdAt` 有值的记录。
- [ ] 同一天二次冷启动 → `lastSeenAt` 不变（服务端未写库，靠客户端节流 + 服务端双保险）。
- [ ] 次日启动 → `lastSeenAt` 更新为当天。
- [ ] 两个微信账号分别登录 → `users` 两条独立记录，互不影响。
- [ ] 客户端伪造 `ownerId` / `openid` 提交 → `FORBIDDEN_FIELD`。
- [ ] 注销：删完 4 个集合里该用户全部数据 + 云存储封面图；再次进入小程序是空数据、重新生成 `users` 记录。
- [ ] 注销中途失败后重试 → 结果一致，不重复报错、不留残余。
- [ ] 注销耗时（按 300 条物品估算）在云函数 60s 超时内。
- [ ] `npm run check` 全绿。

---

## 8. 后续（不在本档）

- **B 档**：`pages/mine` 昵称/头像从本地 `wx.setStorageSync` 迁到 `users`（`avatarFileId` 走云存储），
  顺带补数据导出。**方案见 `docs/user-profile-plan.md`。**
- **C 档**：家庭共享。引 `households` + `members`，`inventory_items.ownerId` 语义换成 `householdId`，
  涉及全量数据迁移 + 双写期 + 重建全部 `ownerId` 索引，代价最高，无明确需求前不动。
