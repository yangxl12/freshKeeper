# freshKeeper 性能分析报告

> 范围：`miniprogram/`（原生小程序 TS）与 `cloudfunctions/`（7 个云函数）。
> 方法：全量源码走读（约 8.4k 行业务代码，排除 `node_modules` 与 `package-lock.json`）+ 索引配置核对（`docs/cloud-deployment.md` 第 2 节）。
> 结论基于代码事实与云开发的已知行为模型，**未做真机压测**；文中带「估算」字样的数字均为数量级推导，落地前需按第 6 节方法实测。

---

## 1. 结论摘要

这个项目的问题**不在渲染，在网络与数据访问**。前端体积 381.7 KB、组件层级浅、`lazyCodeLoading: requiredComponents` 已开，渲染层没有硬伤。

真正的成本全在**「一次用户可见动作 → 多少次云函数/数据库往返」**上，而且有几处是数量级级别的浪费：

| 优先级 | 问题 | 定位 | 量级 |
| --- | --- | --- | --- |
| **P0-1** | 进入「物品录入」页可能触发 **最多 24 次数据库查询** | `cloudfunctions/inventoryApi/recent.js:65-88` | 24 次/次进入 |
| **P0-2** | 首页每次 `onShow` 固定 **5 次数据库读**（4 次 `count` + 1 次列表），无任何缓存 | `pages/home/index.ts:91-98`、`cloudfunctions/inventoryApi/index.js:229-257` | 5 次/次返回首页 |
| **P0-3** | 分页用 `skip(offset)`，深分页成本随页码线性上升；游标上限硬编码 10000 | `inventoryApi/index.js:183`、`:306` | O(offset) |
| **P0-4** | 列表翻页时**全量重下发**已加载数组，批量操作页因此变成 O(N²) | `batch-operation/index.ts:116-119` 等 3 处 | 估算 ~16 倍冗余下发 |
| **P0-5** | 到期提醒派发**逐条串行**，单批 50 条 × 20 批，必然撞云函数超时 | `dispatchReminders/index.js:238-253` | 500s 理论上限 vs 60s 超时 |
| **P0-6** | 列表封面直接加载 1024×1024 原图，无缩略图、无 `lazy-load` | `components/inventory-row/index.wxml:3`、`image-cover.js:19` | 10~100 倍带宽浪费 |
| P1 | 搜索走三字段正则 OR，无法命中索引；其中 1 个字段分支是纯冗余 | `inventoryApi/index.js:282-296` | 降级为范围扫描 |
| P1 | 写操作先读一次、事务内再读一次同一个文档 | `inventoryApi/index.js:355/461/487/511/529` | 每写 +1 RTT |
| P1 | 批量写用 20 路并发事务；回收站清理用 100 路并发事务 | `index.js:551-565`、`cleanupTrash/index.js:80` | 冲突/限流风险 |
| P1 | 云函数拆成 7 个，首页冷启动路径横跨 3 个函数 | `app.ts:27` + `home onShow` | 冷启动 ×3 |
| P2 | 派生视图数组 13 路并行 setData；表单每次输入 3 次 setData | `quick-entry/index.ts:509-535`、`item-form-sheet/index.ts:223-229` | 写放大 |
| P2 | 我的页每次 `onShow` 都读云端设置（无节流），资料读取却有 60s 节流 | `mine/index.ts:117-124` | 不一致 |

**最小必要动作**：先做 P0-1 / P0-2 / P0-5 三项。它们各自独立、改动局限在单个函数内部、不改数据模型，合计可消掉当前绝大部分无效往返。

---

## 2. 性能模型：当前一次典型会话的调用账

以「冷启动 → 首页 → 进快录页 → 保存 1 件 → 回首页」为例（云函数首次调用含冷启动）：

| 步骤 | 云函数调用 | 数据库操作 | 说明 |
| --- | --- | --- | --- |
| `onLaunch` | `userApi.touch` (1) | 1 读 + ≤1 写 | 独立冷启动 |
| 首页 `onShow` | `inventoryApi.getOverview` (1) | **4 次 count** | 独立冷启动 |
| 首页 `onShow` | `inventoryApi.listInventory` (1) | 1 次分页查询 | 同上函数，实例可复用 |
| 进快录页 | `quickEntryApi.getCapabilities` (1) | 0 | 独立冷启动 |
| 进快录页 | `inventoryApi.listRecentProfiles` (1) | **最多 24 次查询** | 见 3.1 |
| 进快录页 | `settingsApi.get` (1) | 1 读 | 独立冷启动 |
| 保存 1 件 | `inventoryApi.save` (1) | 2 读 + 1 事务 | 见 3.7 |
| 保存后生图 | `inventoryApi.generateCover` (1) | 2 读 + 1 写 + 生图 5.8s | fire-and-forget |
| 保存后挂提醒 | `reminderApi.arm` (1) | 1~2 读 + 1 写 | 串行等待，阻塞跳转 |
| 回首页 `onShow` | `getOverview` + `listInventory` (2) | **4 count + 1 查询** | 与上面完全重复，数据大概率没变 |

合计：**约 10 次云函数调用、30+ 次数据库操作**，其中至少 8 次数据库操作在当前场景下是纯重复的。

关键是**首页那 5 次读没有任何缓存**：`onShow` 无条件重拉，从详情页返回、从编辑页返回、从批量页返回都会重来一遍。这是用户感知最强的浪费。

---

## 3. P0：严重影响性能的问题

### 3.1 【P0-1】`listRecentProfiles` 单次调用最多 24 次数据库查询

**位置**：`cloudfunctions/inventoryApi/recent.js:65-88`

```js
async function readRecentProfiles(fetchPage, limit = 100) {
  const states = ['active', 'used_up'].map(status => ({ status, offset: 0, done: false, lastTime: Infinity }))
  while (rounds < MAX_RECENT_ROUNDS && states.some(state => !state.done && state.lastTime >= cutoff)) {
    rounds += 1
    await Promise.all(states.filter(...).map(async state => {
      const page = await fetchPage(state.status, state.offset, RECENT_PAGE_SIZE)  // ← 每轮 2 次查询
      ...
    }))
    const sorted = [...rows].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))  // ← 每轮全量重排
    for (const row of sorted) { ... }
  }
}
```

`RECENT_PAGE_SIZE = 30`、`MAX_RECENT_ROUNDS = 12`、`limit = 100`。调用方：`listRecentProfiles` → `inventoryApi/index.js:104-110`，每次 `fetchPage` 都是一次 `skip(offset).limit(30).get()`。

**为什么最坏情况是 24 次**：`limit = 100` 要求去重后攒够 100 个不同名字。只有 30 个活跃物品的用户，第一轮拿 30 条 active + N 条 used_up，去重后不到 100 → `cutoff` 被推到第 100 个唯一名字的时间戳（或 `-Infinity`）→ 循环条件恒真 → 一直跑到 12 轮上限才停。**小数据量用户反而最吃亏**：恰好是「物品没攒够 100 条」时，代码会一直翻到底再翻满 12 轮。

**别忽略的第二个问题**：`readRecentProfiles` 每轮都对累积的 `rows` 做一次全量排序。12 轮 × 增长中的 n → 估算 O(rounds × n log n) 的纯 CPU 开销，在冷启动实例上叠加。

**而且这个结果往往用不上**：调用点 `miniprogram/pages/quick-entry/index.ts:279` 在 `preparePage()` 里拉它，用途只是「识别结果补分类和存放位置」（注释 `:179`）。用户可能全程手输、根本不触发 AI 解析。

**修复方案**（按收益排序）：

1. **给 `readRecentProfiles` 加提前退出**：`rows.length >= limit * 1.5 && rounds >= 2` 就停。当前 `cutoff` 逻辑在数据不足时退化成「跑满轮数」，这是最需要修的一处。
2. **加索引后改单次查询**：建 `inventory_items: ownerId ASC, updatedAt DESC`，然后
   ```js
   const result = await db.collection(ITEMS)
     .where({ ownerId })
     .orderBy('updatedAt', 'desc')
     .limit(100)          // 一次拿 100 条，内存去重足够
     .get()
   ```
   跨状态（active + used_up 混合）按 `updatedAt` 排序取前 100，语义上比现在的「双状态各翻页再归并」更简单也更贴近「最近」。**这一条直接把 24 次降到 1 次**，代价是新增一个索引。
3. **延迟加载**：`preparePage` 不再预拉，改为首次需要匹配分类时（`buildDraftsFromText`）再请求，且只在缓存为空时拉。

---

### 3.2 【P0-2】首页 `onShow` 固定 5 次数据库读，无缓存

**位置**：`miniprogram/pages/home/index.ts:91-98`

```js
onShow() {
  this.syncTabBar()
  this.subscribeCoverUpdates()
  this.applyPendingHomeSort()
  void this.refreshOverview()      // → 4 次 count
  void this.refresh(true, false)   // → 1 次分页查询
  this.scheduleMidnightRefresh()
}
```

后台侧：

- `refreshOverview` → `getOverview`（`inventoryApi/index.js:229-257`）＝ 4 个 `count()`：active 总数、过期数、临期数、已用完数。
- `refresh(true, false)` → `listInventory`（`:259-313`）＝ 1 次分页查询。

**云开发 `count()` 的代价**：它需要扫描命中条件的全部记录来计数，成本随该用户文档数线性增长。4 次 `count` 比一次 30 条的列表查询贵得多——**首页最贵的部分恰恰是那 4 个统计数字**。

触发频率：首页 ↔ 详情页来回、编辑后返回、批量操作后返回、切 tab 回来——全部命中。

**修复方案**：

1. **合并成一次调用**（推荐）：让 `listInventory` 在 `cursor == null`（首屏）时顺带返回 `overview`，前端只调一次。省掉一次网络 RTT 和一次可能的冷启动，但 `count` 次数不变。
2. **进一步降 `count`**：改用一次 `where({ownerId, inventoryStatus:'active'}).field({expiryDate:true}).limit(1000).get()`，在云函数内存里聚合出四个数字。物品量在千条以内时，**1 次范围查询 < 4 次 count**。超 1000 条再退回 `count` 方案（需注意云开发单次 `get()` 上限 100/1000，分页累积）。
3. **前端加缓存 + 失效标记**：这是收益最大且风险最低的一步。
   ```js
   // home/index.ts
   let overviewCache = null
   let overviewDirty = true          // 任何写操作（save/complete/delete/quantity）后置 true
   onShow() { if (overviewDirty || !overviewCache) void this.refreshOverview() ... }
   ```
   物品增删改的地方（`applyQuantity`、`completeItemAction`、`deleteItemAction`、`quick-entry` 保存成功）已经是明确的事件点，加脏标记不复杂。配合 `wx.setStorageSync` 还能做到「先渲染缓存、再静默刷新」（SWR），弱网下首屏立刻有内容。
4. `scheduleMidnightRefresh`（`:151-158`）用 `setTimeout` 到次日 0 点跨日刷新——小程序切后台 5 分钟后 JS 挂起，这个定时器基本不会准时触发。跨日数据（过期/临期）实际靠的是用户下次进首页重新拉。既然要做缓存，**跨日失效必须补一个「上次刷新日期 ≠ 今天」的判断**，否则缓存会把昨天的「临期 3 件」一直显示下去。这是加缓存时最容易踩的坑。

---

### 3.3 【P0-3】`skip(offset)` 深分页

**位置**：`inventoryApi/index.js:183`（`listActive`）、`:306`（`listInventory`）、`:587`（`listHistory`）、`:614`（`listTrash`）

```js
const offset = decodeCursor(event.cursor, signature)   // payload.offset <= 10_000
...
const result = await query.skip(offset).limit(pageSize + 1).get()
```

`skip` 需要扫描并丢弃前 `offset` 条。第 20 页（offset=570）意味着每次都要空扫 570 条。`decodeCursor` 还把 offset 硬限制在 10000（`:119`），超过直接报 `INVALID_CURSOR` —— 也就是说**单用户超过 1 万条物品就没有第 334 页之后了**。

**修复方案**：改成真游标。`listInventory` 的默认排序是 `expiryDate ASC, createdAt DESC`，可以把上一页最后一条的 `(expiryDate, createdAt)` 编码进游标：

```js
// 下一页：expiryDate > last.expiryDate
//      或 (expiryDate === last.expiryDate && createdAt < last.createdAt)
where = command.and([baseWhere, command.or([
  { expiryDate: command.gt(lastExpiry) },
  { expiryDate: lastExpiry, createdAt: command.lt(lastCreatedAt) },
])])
```

需要用到的索引（`ownerId, inventoryStatus, expiryDate, createdAt`）**已经存在**，`cloud-deployment.md:25` 里有，所以这个改造不需要新建索引。

**注意**：`encodeCursor` 里的 `signature` 查询指纹机制要保留（防止用户翻页途中改筛选条件导致结果串页），只是把 payload 从 `{offset}` 换成 `{after, signature}`。

---

### 3.4 【P0-4】列表分页时全量重下发已加载数据

**三处相同模式**：

```js
// pages/home/index.ts:221-233
items: reset ? pageItems : [...this.data.items, ...pageItems],

// pages/mine/index.ts:361-367（回收站）
trashItems: reset ? pageItems : [...this.data.trashItems, ...pageItems],

// pages/batch-operation/index.ts:116-119  ← 最严重
} else {
  this.setData({ items: [...items] })
}
```

**批量操作页是这个问题的极端案例**（`:95-125`）：`do...while` 会一直翻页直到 `cursor` 为 null（即**拉完整个筛选范围内的全部物品**），并且**每翻一页都把已加载的全部数组重新 setData 一遍**。

设单页 30 条，共 N 条：

- setData 次数：N/30
- 累计下发条次：30 × (1 + 2 + ... + N/30) ≈ **N²/60**

N=300 时约 1500 条次（对比一次性下发的 300 条，**5 倍冗余**）；N=1000 时约 16667 条次（对比 1000 条，**16 倍冗余**）。单条 `InventoryCardItem` 序列化约 400-600 字节，1000 条就是 500 KB 级别的单次 `setData` —— 微信对单次 setData 有 1 MB 上限，而且大 payload 会直接阻塞 JS 线程（用户看到的就是翻页时明显卡顿）。

`batch-operation` 还有第二个隐患：它把**全部物品**拉进 `data.items`。回收站有 2000 件时，整个列表都在渲染层内存里，且 `toggleAll` / `updateSelection`（`:142-149`）每次都对全量数组做 `map` + `filter` 再整体 setData。

**修复方案**：

1. **先累积、最后一次 setData**（最小改动，立刻见效）：
   ```js
   const collected = []
   do {
     const result = await (intent.source === 'trash' ? listTrash(...) : listInventory(...))
     collected.push(...result.items.map(...))
     cursor = result.nextCursor
   } while (cursor)
   this.setData({ items: collected, loading: false })   // ← 只下发一次
   ```
   代价是丢失「边加载边显示件数」的体验。如果想两者都要，用**节流下发**（每 3 页或每 100 条才 setData 一次），把下发次数从 N/30 降到 N/100。
2. **增量赋值**：`this.setData({ [`items[${oldLen}]`]: pageItems[0] })` 逐个追加。能避免全量重传，但路径 map 在 30 个 key 时开销也不小，且代码可读性差。**不建议**优先做这个。
3. **加上限**：默认只加载前 200 条，之后提示「已显示 200 件，请用搜索缩小范围」。批量操作本来就不该对 2000 件无差别开放（云端 `validateBatchItems` 限 20 条/批，`validation.js:128`）。
4. **把 `[...items]` 的 map 换成引用操作**：`updateSelection` 现在是 `items.map(item => ...)` 生成全新对象数组，触发所有组件重渲染。改成只改变化项（配合路径 setData）。

---

### 3.5 【P0-5】到期提醒派发串行，必然超时

**位置**：`cloudfunctions/dispatchReminders/index.js:238-253`

```js
for (let batch = 0; batch < MAX_BATCHES; batch += 1) {          // 20 批
  const result = await db.collection(REMINDERS)
    .where({ status: 'scheduled', remindDate: command.lte(today) })
    .orderBy('remindDate', 'asc').limit(BATCH_SIZE).get()        // 50 条/批
  if (!result.data.length) break
  for (const job of result.data) {                              // ← 串行！
    const outcome = await processJob(job, today, config)
    ...
  }
}
```

单个 `processJob`（`:131-226`）的内部开销：

| 操作 | 次数 |
| --- | --- |
| `findOwnedItem`（物品校验） | 2 |
| `REMINDERS` 条件更新（claim / 标记 sending） | 2 |
| `cancelJob` 或 `updateJob` | 1~2 |
| `cloud.openapi.subscribeMessage.send` | 1 |

也就是**每条提醒 6-8 次数据库操作 + 1 次微信开放接口调用**。开放接口 RTT 典型 100-300ms，数据库每跳 5-20ms。乐观估计单条 250ms：

- 50 条/批 × 250ms = **12.5s/批**
- 20 批 = **250s**

云函数超时按 `cloud-deployment.md` 的约定是 60s（重函数）。**只要某天待发提醒超过 ~240 条，这个函数中途被杀**，而且因为是顺序处理，后半批用户的提醒会静默丢失（`status: 'scheduled'` 留着，第二天 `remindDate < today` 会被判成 `REMINDER_MISSED` 直接取消 —— 用户永远收不到）。

**修复方案**：

1. **并发化**（必做）：把内层 `for...of` 改成受控并发，如 8 路：
   ```js
   const CONCURRENCY = 8
   for (let i = 0; i < result.data.length; i += CONCURRENCY) {
     await Promise.all(result.data.slice(i, i + CONCURRENCY).map(job => processJob(job, today, config)))
   }
   ```
   250ms × 50 / 8 ≈ 1.6s/批，20 批 ≈ 32s，落在 60s 内。**注意 `processJob` 的 claim 更新（`:156-170`）已经用条件更新保证幂等**，并发是安全的（`updatedCount(claimResult) !== 1` 会返回 `skipped`）。
2. **补一次「剩余待发」观测**：现有日志只打 `summary`，建议再打一个 `remaining`（用 `count()` 查 `status:'scheduled' && remindDate <= today`），否则超时被截断时运维看不出漏了多少。
3. **调 `MAX_BATCHES` 与超时**：如果提醒量预期会破千，把重试窗口交给「下一个 5 分钟」的独立触发（用 `remindDate` 精确匹配），而不是靠单次调用跑完 20 批。

---

### 3.6 【P0-6】封面图：1024² 原图直出，无缩略图、无懒加载

**位置**：

- 生成端：`cloudfunctions/inventoryApi/image-cover.js:19` `const IMAGE_SIZE = '1024x1024'`
- 渲染端：`miniprogram/components/inventory-row/index.wxml:3` `<image class="item-card__image" src="{{coverSrc}}" mode="aspectFit" ... />`

列表里的封面展示尺寸是卡片左侧的小方块（WXSS 中 `item-card__image` 的实际渲染尺寸远小于 1024px），却拉的是 1024×1024 的 JPEG。**首页 30 条 = 30 张 1024² 图同时下载**，估算 150-500 KB/张 → 单次首屏 5-15 MB 图片流量。

而且 `<image>` 没有 `lazy-load` 属性 —— 加上 `lazy-load="{{true}}"` 后，微信只会加载出现在视口内（含前后 3 屏）的图片，**这是零成本的一行修改**。

**修复方案**：

1. **立刻可做**：`<image lazy-load>` + 保留 `binderror` 兜底（已有 `handleCoverError`，`:93-96`）。
2. **缩略图（收益最大）**：云存储支持在 fileID 后拼接图片处理参数：
   ```
   coverFileId + '?imageView2/2/w/200/h/200/format/webp/q/80'
   ```
   200px WebP 约 8-15 KB，**比原图小 20-40 倍**。需要在 `inventory-service` / `toInventoryCardItem` 里生成展示用的 `coverThumb` 字段（保留原 `coverFileId` 用于详情页大图）。注意带参数的 URL 不能直接当 `<image src>` 用于 `binderror` 重试判断的 key，`coverFor` 比较逻辑（`inventory-row/index.ts:52`）用的是 fileID，不受影响。
3. **降生图分辨率**：`IMAGE_SIZE` 改 `512x512`（封面在卡片上最多显示 ~200px，详情页也够）。生图耗时和费用都会下来（当前约 5.8s）。
4. **详情页**（`pages/item-detail`）用原图，不要复用缩略图 —— 那里用户会放大看。

---

## 4. P1：明确的低效点

### 4.1 搜索查询无法命中索引，且含一个冗余分支

**位置**：`cloudfunctions/inventoryApi/index.js:282-296`

```js
const keyword = db.RegExp({ regexp: escapeRegExp(search), options: 'i' })
where = command.and([
  where,
  command.or([
    { name: keyword },            // ← 冗余
    { searchName: keyword },
    { storageLocation: keyword },
    ...Object.entries(STORAGE_LABELS).filter(([, label]) => label.toLocaleLowerCase('zh-CN').includes(search))
      .map(([value]) => ({ storageLocation: value })),
  ]),
])
```

两个问题：

1. **`{ name: keyword }` 是冗余的**：`searchName` 在写入时就是 `name.toLocaleLowerCase('zh-CN')`（`validation.js:88`），而 `validateSearch` 也把关键词转成小写（`validation.js:149`）。带 `options: 'i'` 的正则匹配 `name` 与匹配 `searchName` 结果几乎完全重合，白白多扫一个字段。
2. **`regexp` 非前缀锚定时无法使用索引**：索引表（`cloud-deployment.md:25-32`）里也没有任何以 `searchName` 开头的索引。用户一输入搜索词，查询就从「索引范围扫描」退化成「该用户全量文档扫描 + 逐条正则」。

**修复**：
- 先删掉 `{ name: keyword }` 分支（零风险，立即减少扫描字段）。
- 建索引 `inventory_items: ownerId ASC, inventoryStatus ASC, searchName ASC`，并把正则改成**前缀锚定** `^${escapeRegExp(search)}`（前缀正则可以走索引）。代价是搜索语义从「包含」变成「前缀匹配」——对「搜物品名字开头」的场景够用，且是产品上更常见的预期。
- 若要保留「任意位置包含」，则改为写入时生成 `nameTokens: ['牛','牛奶','牛奶盒']` 前缀数组字段 + 索引，用 `command.in(keyword)` 查询。这是标准做法但工作量大，建议放到物品量确实破千之后再做。

### 4.2 写操作重复读同一个文档

**位置**：`inventoryApi/index.js` 的 `save:355`、`transition:461`、`moveToTrash:487`、`removePermanently:511`、`restore:529`

```js
await getOwnedItem(ownerId, itemId)                 // ← 事务外读第 1 次（仅用于「存在性」校验）
await db.runTransaction(async (transaction) => {
  const current = await getTransactionOwnedDoc(...) // ← 事务内读第 2 次（真正用于校验）
  assert(current, 'NOT_FOUND', '物品不存在或已被删除')
  ...
})
```

事务内那次断言已经覆盖了「不存在」，事务外这次是纯重复。**每次写操作多一次数据库往返**（云数据库 RTT 通常 5-20ms，事务上下文里更贵）。

**修复**：删掉事务外的 `await getOwnedItem(...)`。注意 `decrement`（`:424-455`）没用事务、走的是条件更新 + `updatedCount` 判定，本来就只需要一次读，是正确的范式 —— 其他写操作可以照这个思路进一步去事务化（见 4.3）。

**风险**：错误码会变（外部读抛 `NOT_FOUND`，事务内抛也是 `NOT_FOUND`，一致）。但 `save` 里 `await getOwnedItem` 是在 `assert` 版本校验之前，删掉后「物品不存在」与「版本冲突」的优先级顺序会变 —— 需要同步检查 `tests/` 里相关用例。

### 4.3 批量写并发过高

**位置**：`inventoryApi/index.js:551-565`

```js
await Promise.all(items.map(async (item) => {
  try { await mutation(ownerId, item) ... } catch (error) { ... }
}))
```

`validateBatchItems` 上限 20 条（`validation.js:128`），而每个 `mutation` 都是 `db.runTransaction`。**20 个并发事务打同一个用户的同一集合**，在云开发上很容易触发事务冲突重试甚至限流。客户端已经按 20 条分块（`batch-operation/index.ts:27 CHUNK_SIZE = 20`），云端再 20 路并发，叠加起来是 20 个并发事务的尖峰。

同样问题在 `cleanupTrash/index.js:80`：`Promise.allSettled(items.map(removeTrashItem))`，`BATCH_SIZE = 100` → **100 路并发事务**。

**修复**：
- `processBatch` 改为受控并发 5（分批 `Promise.all`）。20 条任务从「1 波 × 5 并发」变成「4 波 × 5 并发」，总耗时增加有限，但冲突率显著下降。
- 更彻底的做法：把 `moveToTrash` / `complete` 这类「读-校验-条件写」操作改成**无事务的条件更新**（`where({_id, ownerId, version, inventoryStatus:'active'}).update()` + `updatedCount !== 1 → CONFLICT`），就像 `decrement` 那样。这样批量操作可以放心并发，也省掉了事务里那次读。`cancelPendingReminder` 需要单独处理（它可以容忍最终一致，改为事务外调用）。
- `cleanupTrash` 的并发降到 10-20，或直接用 `where(...).remove()` 批量删除（云开发支持条件删除，一次删多条）+ 单独清理关联的 `reminder_jobs`。

### 4.4 详情页 2 次查询

**位置**：`inventoryApi/index.js:315-326`

```js
const item = await getOwnedItem(ownerId, itemId)              // 查 inventory_items
const reminderResult = await db.collection(REMINDERS)...      // 查 reminder_jobs
```

两次串行查询。**修复**：把 `reminderStatus` 冗余成 `inventory_items` 上的一个字段，在 `reminderApi.arm` / `dispatchReminders` 更新任务状态时同步写入。代价是两处写入点要同时维护，但详情页是高频路径（每次打开物品都走），省下的是一整次 RTT。或者用 `Promise.all` 把两次查询并行 —— 简单但收益有限（都还在一个函数里）。

### 4.5 `generateCover` 的同名复用查询缺索引

**位置**：`inventoryApi/index.js:633-636`

```js
const sameName = await db.collection(ITEMS)
  .where({ ownerId, name: item.name, inventoryStatus: 'active' })
  .limit(20)
  .get()
```

`name` 字段在现有索引表里**完全没有索引**（`cloud-deployment.md:25-32`）→ 全量扫描该用户文档。这个查询在「用户保存物品后的 fire-and-forget 路径」上，虽然不阻塞用户，但会持续消耗云函数执行时间和数据库读配额。

**修复**：索引表补一行 `inventory_items: ownerId ASC, inventoryStatus ASC, name ASC`。

### 4.6 云函数拆得过细，冷启动叠加

7 个独立云函数（`cloud-deployment.md:40-48`），每个有独立的 `node_modules` 与冷启动周期。首页冷启动路径横跨 3 个不同函数（`userApi.touch` → `inventoryApi.getOverview` → `inventoryApi.listInventory` → 进快录页还有 `quickEntryApi` + `settingsApi`）。

**修复方案（按性价比）**：

1. **合并 `settingsApi` 到 `userApi`**：`settingsApi/index.js` 只有 123 行、单集合读写，没有独立存在的必要。少一个函数＝少一个冷启动。
2. **`touch` 与 `getOverview` 合并**：两者都是「进首页时必调一次」，可以合成一次调用（`app.onLaunch` 的 touch 结果也可以顺带在首页带回来）。
3. **预留实例 / 预热**：给 `inventoryApi` 配一个 5 分钟一次的定时触发器做空调用（`getOverview` 或专门的健康检查 action）。云开发的预留实例要付费，但 1 个实例的成本远低于 3 个函数反复冷启动带来的体验损失。**注意**：空调用会产生 `count` 成本，建议加一个 `ping` action 只做 `cloud.init` 不碰数据库。
4. **精简依赖**：各 `package.json` 只保留 `wx-server-sdk`（核对是否有冗余依赖）。

---

## 5. P2：写放大与细节

### 5.1 快录页 `commitDrafts` 13 路并行 setData，且有重复计算

**位置**：`miniprogram/pages/quick-entry/index.ts:509-535`

```js
draftView(drafts) {
  const summaries = drafts.map(getExpirySummary)
  return {
    draftSummaries: drafts.map(getDraftSummary),
    expirySummaries: summaries,
    expiryBadges: summaries.map(s => expiryBadgeText(s, today)),
    expiryTones: summaries.map(s => expiryToneOf(s, today)),
    expiredFlags: summaries.map(s => expiryToneOf(s, today) === 'expired'),   // ← 同一函数算了两遍
    statusLabels: drafts.map(d => statusMeta(d).label),
    statusTones: drafts.map(d => statusMeta(d).tone),                          // ← 同一函数算了两遍
    ...
  }
}
```

三个问题：

1. `expiryToneOf` 和 `statusMeta` 各被调用两次（一次取 tone、一次取 flag/label），纯重复计算。
2. 13 个并行数组 + `drafts` 本身，每次 `commitDrafts` 都是 14 个 key 的 setData。切换一个草稿的选中状态（`toggleSelected` → `updateDraft` → `commitDrafts`）就会全量重算 + 全量下发。
3. 派生值（`expiryBadges` 等）**按索引与 `drafts` 隐式对齐**。任何一处 `filter` 都会导致错位（`appendRecentDrafts:393` 就有 `filter`）。这是正确性隐患，不只是性能。

**修复**：

- 把状态计算只做一次：`const metas = drafts.map(d => ({ tone: expiryToneOf(...), status: statusMeta(d) }))`，再从 `metas` 派生数组。
- **更彻底**：把展示字段直接合并进草稿对象（`draft.view = { badge, tone, statusLabel, ... }`），`commitDrafts` 只 setData 一个 `drafts` 数组。14 个 key 降到 1 个，索引对齐问题一并消失。
- `toggleSelected` 改用路径更新：`setData({ [`drafts[${index}].selected`]: next, selectableCount, pendingCount })`，避免整体重算。

### 5.2 表单每次输入 3 次 setData

**位置**：`components/item-form-sheet/index.ts:223-229`

```js
handleTextInput(event) {
  const field = event.currentTarget.dataset.field
  this.setData({ [field]: event.detail.value, dirty: true }, () => {
    if (field === 'shelfLifeValue' || field === 'reminderLeadDays') this.refreshDerived()
  })
}
```

`refreshDerived`（`:281-284`）＝ `updateExpiryPreview()`（1 次 setData）+ `updateReminderAt()`（1 次 setData）。**输入「保质期天数」时每敲一个字符触发 3 次 setData**。此外 `updateExpiryPreview` 在 `mode !== 'shelf_life'` 时也照常 `setData({expiryPreview: ''})`（`:298-300`），即使值没变。

**修复**：合并成一次 setData（先算出 `expiryPreview` / `reminderAtText` / `reminderMissed` 再一起下发）；`updateExpiryPreview` 加「值未变化就 return」的短路。

### 5.3 我的页 `onShow` 无节流读设置

**位置**：`miniprogram/pages/mine/index.ts:117-124`

```js
onShow() {
  this.syncTabBar()
  this.setData({ profile: readProfile() })
  void Promise.all([this.loadSettings(), this.loadProfile()])   // loadProfile 有 60s 节流，loadSettings 没有
  if (this.data.activeModal === 'trash') void this.loadTrash(true)
}
```

`loadProfile` 有 `PROFILE_READ_TTL_MS = 60_000` 节流（`:166-178`），`loadSettings`（`:143-158`）每次 onShow 都打云函数，而且里面还串行 `await readReminderAuthorization()`（读 `wx.getSetting`）。**两者节流策略不一致**。

**修复**：给 `loadSettings` 加同样的 TTL；`notificationSummary` 是纯本机系统状态，没必要和云端设置绑在同一条串行链上（改成并行）。

### 5.4 长列表没有虚拟化或上限保护

**位置**：`pages/home/index.wxml:150-163`、`miniprogram/pages/mine/index.wxml` 回收站列表

`wx:for` 全量渲染 `inventory-row`，每个组件带 observer（`inventory-row/index.ts:49-71`）。加上 `onReachBottom` 无限加载（`home/index.ts:145-149` ），物品到 500+ 时列表节点数会成为滚动卡顿的主因。

**修复**：**先加上限**（最简单）：加载到 200 条后停止自动加载，显示「已显示 200 件，请用搜索缩小范围」。这一步既防卡顿、又和 3.4 的批量页上限形成一致的产品规则。真有 500+ 物品的搜索场景，用搜索而不是无限滚动。**不建议**直接上 `recycle-view` —— 引入自定义组件、要改布局、和现有 `hover-class` / 无障碍标注的兼容成本高，物品量级不够时不划算。

### 5.5 其他

| 问题 | 位置 | 说明 |
| --- | --- | --- |
| 语音录制每秒 setData | `quick-entry/index.ts:734` | `setInterval(() => setData({voiceSeconds}), 1000)`。影响很小（只在录音中），可保留。 |
| `listActive` 是死代码 | `inventoryApi/index.js:177-227` | 4 次查询（3 count + 1 列表）的 legacy 实现，页面已改用 `listInventory`。**建议直接删**，减少云函数体积和误用风险。 |
| AI 限次是实例内存态 | `quickEntryApi/ai-quota.js:9-18` | 注释里已承认：多实例/冷启动会让 50 次/天的限额失效。这是成本问题，不是性能问题，但会实打实花钱——换云数据库集合（文档已提，接口不变）。 |
| 封面生图 1024² | `image-cover.js:19` | 见 3.6，和列表展示尺寸不匹配。 |
| 缺少前端耗时埋点 | `utils/analytics.ts` 只有 `reportAnalytics` | 云函数已打 `durationMs`（`:685`），前端没有。建议给首页首屏、列表翻页、保存流程各加一个 `Date.now()` 差值埋点，才能按第 6 节验证优化效果。 |

---

## 6. 优化路线图

分四批，每批独立可发布、可验证。

### 第 1 批：低成本高收益（估算 1-2 天）

| # | 动作 | 文件 | 风险 |
| --- | --- | --- | --- |
| 1 | 列表封面加 `lazy-load` | `inventory-row/index.wxml:3` | 无 |
| 2 | 封面用缩略图 URL（`imageView2/2/w/200/format/webp`） | `inventory-service` / `domain/inventory.ts` | 低（需确认云存储图片处理已开通） |
| 3 | 删掉搜索里 `{ name: keyword }` 冗余分支 | `inventoryApi/index.js:289` | 无 |
| 4 | 批量页改「先累积、一次 setData」 | `batch-operation/index.ts:95-125` | 低 |
| 5 | 首页/回收站加加载条数上限（200） | `home/index.ts`、`mine/index.ts` | 无 |
| 6 | `readRecentProfiles` 加提前退出 | `inventoryApi/recent.js:65-88` | 低（行为等价，只是少翻页） |
| 7 | 删掉写操作里事务外的 `getOwnedItem` | `index.js:355/461/487/511/529` | 中（需跑测试确认错误码顺序） |
| 8 | 表单 `refreshDerived` 合并 setData | `item-form-sheet/index.ts:223-313` | 低 |

### 第 2 批：索引与查询（估算 2-3 天）

| # | 动作 | 说明 |
| --- | --- | --- |
| 9 | 补两个索引 | `inventory_items: ownerId+updatedAt DESC`（支持 3.1 的单次查询）、`ownerId+inventoryStatus+name`（支持 4.5）。同步更新 `docs/cloud-deployment.md:21-34` 的索引表 |
| 10 | `listRecentProfiles` 改单次查询 | 24 次 → 1 次 |
| 11 | 首页 `getOverview` 改内存聚合（1 次范围查询替代 4 次 count） | 或保留 count 但合并调用 |
| 12 | `listInventory` 首屏顺带返回 `overview` | 前端首页从 2 次调用降到 1 次 |
| 13 | 游标从 offset 改 `(expiryDate, createdAt)` | 深分页线性成本 → 常数 |

### 第 3 批：并发与调度（估算 2-3 天）

| # | 动作 | 说明 |
| --- | --- | --- |
| 14 | `dispatchReminders` 内层串行改 8 路并发 | 250s → ~32s，必须先上，否则用户量上来必丢提醒 |
| 15 | `processBatch` 并发限制到 5；`cleanupTrash` 降到 10-20 | 降低事务冲突 |
| 16 | 批量操作去事务化（照 `decrement` 的条件更新范式） | 需要仔细设计 `cancelPendingReminder` 的补偿 |
| 17 | `settingsApi` 合并进 `userApi` | 少一个冷启动 |
| 18 | 给 `inventoryApi` 加 `ping` action + 5 分钟预热触发器 | 需评估预留实例成本 |

### 第 4 批：前端缓存与写放大（估算 3-4 天）

| # | 动作 | 说明 |
| --- | --- | --- |
| 19 | 首页 SWR 缓存 + 脏标记 + 跨日失效 | **最容易出错的一步**，必须处理「上次刷新日期 ≠ 今天」 |
| 20 | 快录页派生值合并进草稿对象 | 14 key → 1 key，同时修掉索引对齐隐患 |
| 21 | 我的页设置读取加节流 | 一行改动 |
| 22 | 前端首屏/翻页/保存耗时埋点 | 为后续优化提供数据 |

---

## 7. 验证方法

优化前后用同一套口径对比，否则改动无法收敛。

**1. 云函数侧（成本与耗时的主要来源）**

现有日志已经带了可用字段（`inventoryApi/index.js:685`、`quickEntryApi/index.js:124`）：

```json
{"requestId":"...","action":"listInventory","resultCode":"OK","durationMs":42}
```

- 在云开发控制台按 `action` 分组统计 `durationMs` 的 **P50/P95**，优化前后各取一周数据。
- 重点看三个 action：`getOverview`、`listRecentProfiles`、`dispatch`。
- **数据库读配额**是更客观的指标：云开发控制台的数据库监控里能看「读操作次数」。首页 5 次读降到 1-2 次，应该能在监控曲线上直接看到。

**2. 前端侧**

- 微信开发者工具「调试器 → Performance」录一段：冷启动 → 首页渲染 → 下拉刷新 → 翻页，导出 JSON 对比 `setData` 耗时与调用次数。
- 真机（低端安卓）体验：`wx.getPerformance()` 取 `firstRender` / `evaluateScript` 时间。
- 图片流量：开发者工具 Network 面板过滤云存储域名，看首屏图片总字节数（做缩略图后应下降一个数量级）。

**3. 回归红线**

改动集中在云端查询与 setData，**最容易坏的是这三处**，每次改完必须跑：

```powershell
& 'C:\Users\BYS\AppData\Local\Programs\PowerShell\7\pwsh.exe' -NoProfile -Command 'npm run check'
```

- `tests/unit/inventory-row.test.ts`（数量编辑态、动效）
- 批量操作相关用例（`CONFLICT` 回填、20 条分块）
- `recent.js` 的归并/去重用例（`mergeRecentItems` / `normalizeRecentName`）

游标从 offset 改成复合游标的改动，另外要手动验证「翻页途中改筛选条件」不会串页（`querySignature` 机制必须保留）。

---

## 8. 明确不建议做的事

1. **不要分包**。`miniprogram/` 总体积 381.7 KB（最大目录 `pages/quick-entry` 75.8 KB），主包上限 2 MB。分包带来的收益是零，管理成本是正的。
2. **不要引入虚拟列表组件**。物品量级到 200 条就加上限更划算（见 5.4）。等真的出现「必须浏览 1000+ 条」的产品需求再谈。
3. **不要为了性能去掉并发版本控制**（`version` + `CONFLICT`）。这是数据正确性的基础，批量操作的失败回填逻辑（`batch-operation/index.ts:202-213`）依赖它。要去事务化也要保留 `version` 条件更新（4.3 的方案就是这种）。
4. **不要把 `cloud.ai()` 的超时预算调大**。`DEFAULT_TIMEOUT_MS = 6000` 是刻意排在「前端 8s `Promise.race`」之前的（`ai-client.js:10-11`），调大只会让用户等更久然后拿到本地解析结果。
5. **不要用 `Remove-Item` 清理本项目文件**（环境已知问题），需要删文件走 `git clean -fx -- <路径>`。

---

## 附：本次走读覆盖的文件

**云函数**：`inventoryApi/{index,validation,recent,image-cover}.js`、`quickEntryApi/{index,ai-client,ai-quota}.js`、`userApi/index.js`、`dispatchReminders/index.js`、`cleanupTrash/index.js`
**小程序**：`app.{ts,json,wxss}`、`pages/{home,mine,quick-entry,item-detail,batch-operation,item-form}/index.ts`、`pages/home/index.wxml`、`components/{inventory-row,item-form-sheet}/index.{ts,wxml}`、`services/{inventory-service,quick-entry-service,cloud-client}.ts`、`domain/inventory.ts`、`utils/{analytics,shanghai-time}.ts`、`custom-tab-bar/index.ts`
**配置**：`project.config.json`、`docs/cloud-deployment.md`（索引表）
