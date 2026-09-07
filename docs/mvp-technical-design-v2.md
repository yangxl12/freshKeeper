# 保质期助手 MVP 技术方案 2

> 版本：V0.2 · 状态：首页与库存重构实施稿 · 更新日期：2026-09-07
>
> 产品依据：[MVP 产品设计文档 2](./mvp-product-design-v2.md)
>
> 技术基线：[MVP 技术方案 V0.1](./mvp-technical-design.md)

## 1. 方案结论

本次继续使用 **微信原生小程序 + 微信云开发**，不新增数据库集合、库存业务字段、云函数、状态库或 UI 框架。

在现有实现上完成四项调整：

1. 将当前 `pages/home` 改为只展示五项库存概览和新增入口。
2. 新增 `pages/inventory` Tab，承接搜索、种类、状态组合筛选和库存列表。
3. 在现有 `inventoryApi` 内新增 `getOverview`、`listInventory` 两个 action，统计与筛选全部在服务端完成。
4. 首页卡片通过一次性内存意图切换到库存 Tab；库存页消费意图后选中对应状态，不使用本地持久化或额外状态库。

日期、用户隔离、库存状态转换、提醒任务、设置、历史记录和错误响应继续遵循技术方案 V0.1。若两份技术文档存在冲突，首页与库存相关内容以本文为准，其余内容以 V0.1 为准。

## 2. 现状分析与改造边界

### 2.1 当前实现与目标差距

| 项目 | 当前实现 | V2 目标 |
| --- | --- | --- |
| Tab | 库存、我的 | 首页、库存、我的 |
| 首页职责 | 概览、搜索、位置/分类筛选、完整列表 | 五项概览、卡片跳转、新增入口 |
| 库存列表 | 位于首页，仅展示 `active` | 独立库存页，可查看 `active` 和 `used_up` |
| 筛选方式 | 分类、位置使用选择器 | 种类、状态两行直接点击，移除位置主筛选 |
| 概览接口 | `listActive` 同时返回列表和三项统计 | 独立返回五项统计，列表查询不重复统计 |
| 跨页筛选 | 无 | 首页卡片切换 Tab 并落到指定状态 |

### 2.2 保持不变

- `inventory_items`、`user_settings`、`reminder_jobs` 三个集合及现有字段。
- `active / used_up / discarded` 三种库存业务状态。
- 详细到期状态 `expired / due_today / due_in_3_days / due_in_7_days / safe`。
- 新增、编辑、详情、减量、用完、丢弃、误录删除、设置、提醒和“我的 → 历史记录”流程。
- 服务端可信 `OPENID`、集合禁止客户端直读写、字段白名单、版本冲突和事务规则。
- 自然日、`Asia/Shanghai` 业务时区和 `YYYY-MM-DD` 日期键规则。

### 2.3 不在本次建设

- 不保存派生的到期状态，也不新增统计快照或累计计数集合。
- 不引入全文检索、缓存服务、前端全局状态库或自定义 TabBar。
- 不恢复存放位置主筛选；物品的选填位置字段和信息展示仍保留，但不再提供全局默认存放位置。
- 不改变订阅消息的授权、派发和幂等策略。

## 3. 状态口径

新增页面级筛选类型 `InventoryViewStatus`，它只表达用户正在查看的列表范围，不写入数据库：

```ts
type InventoryViewStatus =
  | 'active_all'
  | 'expired'
  | 'expiring'
  | 'safe'
  | 'used_up'
```

服务端使用同一个 `serverToday` 计算概览和列表条件：

| 页面状态 | 数据条件 | 排序 |
| --- | --- | --- |
| `active_all` | `inventoryStatus = active` | `expiryDate ASC, createdAt DESC` |
| `expired` | `active` 且 `expiryDate < today` | `expiryDate ASC, createdAt DESC` |
| `expiring` | `active` 且 `today <= expiryDate <= today + 7 天` | `expiryDate ASC, createdAt DESC` |
| `safe` | `active` 且 `expiryDate > today + 7 天` | `expiryDate ASC, createdAt DESC` |
| `used_up` | `inventoryStatus = used_up` | `completedAt DESC` |

其中：

- “临期”包含今天到期以及未来 1～7 天到期。
- “状态良好”只包含距离到期超过 7 天的使用中物品。
- 已丢弃物品不进入首页统计和库存页，仍只在“我的 → 历史记录”展示。
- “已用完”是当前仍保留的 `used_up` 记录数；误录记录被硬删除后不再计数，不建设独立的终身累计事件表。
- 首页必须满足 `activeTotal = expired + expiringWithin7Days + safe`，`usedUpTotal` 独立于该等式。

详细到期状态仍用于物品行文案和“全部在库”分组，不与页面级 `expiring` 合并存储。

## 4. 页面与工程结构

```text
miniprogram/
├─ pages/
│  ├─ home/                 # 改造：五项概览 + 新增入口
│  ├─ inventory/            # 新增：搜索、两行筛选、列表
│  ├─ item-form/            # 不变
│  ├─ item-detail/          # 不变
│  └─ mine/                 # 不变，继续包含历史记录
├─ components/
│  ├─ inventory-row/        # 复用 active/history 两种展示
│  ├─ expiry-status/        # 复用
│  └─ empty-state/          # 复用
├─ domain/
│  ├─ inventory.ts          # 增加分类与页面状态选项
│  └─ expiry.ts             # 详细到期展示规则不变
├─ services/
│  └─ inventory-service.ts  # 增加 getOverview/listInventory
└─ types/
   ├─ index.d.ts            # 增加一次性跨 Tab 意图
   └─ inventory.ts          # 增加概览和页面状态类型
```

首页卡片只在一个页面使用，首版直接在 `home` 内实现，不为五张卡片提前抽象通用组件。种类和状态筛选同样先由库存页本地渲染；`inventory-row`、`expiry-status` 和 `empty-state` 继续复用。

`app.json` 调整为：

```text
pages/home/index       # pages 第一项，默认启动页
pages/inventory/index
pages/item-form/index
pages/item-detail/index
pages/mine/index

tabBar: 首页 / 库存 / 我的
```

三个 Tab 使用含义明确、选中态一致的本地图标；新增/编辑和详情页仍为非 Tab 二级页面。

## 5. 云函数接口设计

仍由 `inventoryApi` 单一入口按 `action` 分发，不新增云函数。统一响应结构、错误码和日志规则保持不变。

### 5.1 `getOverview`

输入无业务参数，不接受搜索、种类、状态或用户标识。

```ts
interface InventoryOverviewResult {
  activeTotal: number
  expired: number
  expiringWithin7Days: number
  usedUpTotal: number
  safe: number
  serverToday: string
}
```

实现采用一次聚合查询：

1. 先按可信 `ownerId` 匹配 `active` 和 `used_up` 记录。
2. 使用 `inventoryStatus`、`expiryDate`、`today` 和 `today + 7 天` 投影为四个互斥桶：`expired / expiring / safe / used_up`。
3. 按桶分组计数，未出现的桶补 0。
4. `activeTotal` 由前三个桶相加得到，确保首页等式始终成立。

统计不受库存页搜索和筛选影响。客户端不自行遍历当前页计算概览，也不缓存跨日统计。

### 5.2 `listInventory`

```ts
interface ListInventoryInput {
  search?: string
  category?: '' | 'food' | 'medicine' | 'household' | 'other'
  viewStatus?: InventoryViewStatus // 默认 active_all
  cursor?: string | null
  pageSize?: number               // 默认 30
}

interface ListInventoryResult {
  items: InventoryItem[]
  nextCursor: string | null
  serverToday: string
}
```

处理顺序固定为：

```text
可信 ownerId
  AND 合法的 inventoryStatus/expiryDate 条件
  AND 可选 category
  AND 可选 searchName 包含匹配
  → 排序
  → 游标分页
  → 补充展示字段
```

搜索、种类和状态必须先在服务端组合，再分页。禁止先取一页数据后在客户端过滤。条件变化时客户端清空旧游标和旧列表；游标只可用于生成它的同一组查询条件。

接口不再返回 `overview`，避免搜索、切换筛选和加载下一页时重复执行全局统计。首页只调用 `getOverview`，库存页只调用 `listInventory`。

### 5.3 兼容与保留 action

- `get / save / decrement / complete / discard / delete / listHistory` 保持不变。
- `listActive` 在 V2 上线阶段保留原响应结构，供已发布旧版本继续使用。
- V2 客户端不再调用 `listActive`；确认旧版本无需兼容后，再在后续版本删除该 action 和位置筛选专用代码。

## 6. 数据查询与索引

本次无数据迁移，只新增一条支持“已用完 + 种类”查询的复合索引：

| 用途 | 索引字段 |
| --- | --- |
| 使用中列表及到期范围 | `ownerId ASC, inventoryStatus ASC, expiryDate ASC, createdAt DESC` |
| 使用中 + 种类 | `ownerId ASC, inventoryStatus ASC, category ASC, expiryDate ASC, createdAt DESC` |
| 已用完列表 | `ownerId ASC, inventoryStatus ASC, completedAt DESC` |
| 已用完 + 种类 | `ownerId ASC, inventoryStatus ASC, category ASC, completedAt DESC`（新增） |

原有包含 `storageLocation` 的索引在兼容 `listActive` 期间保留，不能与 V2 发布同时删除。待旧 action 下线后，再根据生产查询日志决定是否移除，避免无依据地调整生产索引。

名称包含搜索继续使用经过转义的 `searchName` 正则，并先限定用户、业务状态和可选种类。MVP 家庭数据量下不引入全文检索；若真实数据表明单用户记录量或查询耗时超出当前方案，再单独评估前缀搜索或搜索服务。

## 7. 首页实现

### 7.1 页面状态

首页只维护：

```ts
{
  loading: boolean
  refreshing: boolean
  errorMessage: string
  overview: InventoryOverviewResult | null
}
```

- 首次进入显示骨架或加载态，不把未返回的数据误显示为 0。
- 接口成功后，即使五项均为 0 也正常展示全部卡片和新增引导。
- 已有数据刷新失败时保留上次概览，并明确提示“概览未更新”；首次加载失败显示错误和重试。
- `onShow`、下拉刷新和上海自然日跨日时重新调用 `getOverview`。

### 7.2 卡片跳转

| 首页卡片 | 库存页目标状态 |
| --- | --- |
| 物品总数 | `active_all` |
| 已过期 | `expired` |
| 临期 | `expiring` |
| 已用完 | `used_up` |
| 状态良好 | `safe` |

点击任一卡片时，首页写入一次性 `pendingInventoryIntent`，再调用 `wx.switchTab`：

```ts
interface InventoryFilterIntent {
  viewStatus: InventoryViewStatus
  source: 'home_card'
}
```

库存页在 `onShow` 同步读取并立即清空该意图，然后将搜索词和种类重置为默认值，只应用目标状态，再从第一页查询。这样落地列表口径与卡片数字一致，不会被库存页上次遗留的搜索或种类条件缩小。

该意图只保存在 `App.globalData`，不写入 Storage；切换失败时清除本次意图。它只是一次导航参数，不承担页面数据缓存。

## 8. 库存页实现

### 8.1 页面状态

```ts
{
  search: string
  category: '' | Category
  viewStatus: InventoryViewStatus
  items: InventoryItem[]
  groups: InventoryGroup[]
  nextCursor: string | null
  serverToday: string
  loading: boolean
  loadingMore: boolean
  errorMessage: string
  hasActiveConditions: boolean
}
```

`hasActiveConditions` 的口径为：

```text
search.trim() 非空
OR category 非“全部”
OR viewStatus 非 active_all
```

### 8.2 筛选行为

- 搜索输入使用约 300ms 防抖；一键清空搜索时保留种类和状态。
- 种类与状态选项直接点击，切换后立即清空列表游标并查询第一页。
- 点击种类“全部”只清除种类；点击“全部在库”只改变状态。
- “清除全部”将搜索、种类和状态恢复为 `'' / '' / active_all`。
- 从首页卡片进入时按第 7.2 节重置其他条件；用户直接点击底部“库存”时保留当前条件并刷新当前结果。
- 使用递增请求序号丢弃过期响应，防止连续输入或切换筛选时旧请求覆盖新结果。

种类行使用 5 列等宽布局，状态行也使用 5 列等宽布局；选中态同时使用底色、边框和文字字重，并设置 `aria-label`、选中语义和按压反馈。常见 320～430px 宽度下完整显示，不使用下拉框，也不依赖仅改变文字颜色。

### 8.3 列表与空状态

- `active_all` 可继续复用现有五类详细到期分组。
- `expired / expiring / safe` 已由顶部状态明确范围，使用平铺列表，避免重复分组标题。
- `used_up` 使用 `inventory-row` 的历史展示模式，按完成时间倒序；点击后仍进入物品详情。
- 默认无库存时提供“新增第一件物品”；有筛选但无结果时保留所有条件并提供“清除筛选”。
- 网络失败与无结果必须分开；加载更多失败保留已加载内容并允许重试。
- 固定新增按钮与列表底部安全区共同预留空间，不能遮挡最后一条记录。

## 9. 刷新、日期与一致性

- 首页和库存页每次 `onShow` 都从服务端刷新；MVP 数据量和页面数量较小，不增加复杂缓存或脏数据订阅机制。
- 当前未被实际用于条件判断的 `inventoryDirty` 布尔值在实现 V2 时删除，避免多个 Tab 争抢同一个“已消费”标记。
- 新增、编辑或处理物品后，无论用户返回首页还是库存页，该页面的下一次 `onShow` 都会取得最新数据。
- 当前可见 Tab 在上海时间跨过 00:00 后主动刷新；页面隐藏或卸载时清理计时器。
- 每个接口在一次请求内只生成一个 `serverToday`，查询范围和返回的展示字段都使用该值。
- 客户端不使用本机日期决定某条记录是否属于过期、临期或良好；服务端返回的 `expiryStatus` 仅用于展示和“全部在库”分组。

## 10. 安全与可靠性

V2 新接口继续执行 V0.1 的安全规则：

- `ownerId` 只来自 `cloud.getWXContext().OPENID`，拒绝客户端身份字段。
- `getOverview` 和 `listInventory` 的所有查询都必须包含 `ownerId`。
- `viewStatus`、分类、页大小、游标和搜索词均由服务端白名单校验；非法状态返回 `INVALID_ARGUMENT`。
- 搜索正则字符先转义，日志不记录搜索词、物品名称或 OPENID。
- 已用完列表只增加读取入口，不放宽已处理物品的编辑和状态转换限制。
- 首页或库存失败不影响新增、详情、历史和提醒；页面保留可恢复的重试入口。

提醒任务与库存状态的事务处理不变。物品转为 `used_up` 后，库存页可以查询到它，但待发提醒仍必须被取消；`discarded` 继续不进入库存页。

## 11. 测试方案

### 11.1 单元测试

- `viewStatus` 五个合法值、缺省值和非法值校验。
- `expired / expiring / safe` 在 `-1 / 0 / 7 / 8` 天边界的查询条件。
- 概览空数据补 0，以及 `activeTotal = expired + expiringWithin7Days + safe`。
- 首页卡片到库存状态的一一映射。
- `hasActiveConditions`、清空搜索、清除全部和筛选切换规则。
- 现有详细到期状态、日期加减、保存校验和库存状态转换测试全部保留。

### 11.2 云环境集成测试

准备覆盖四个种类、三种库存业务状态和到期边界的固定数据，验证：

1. 五项概览按记录数统计，不累加 `quantity`。
2. `activeTotal` 等于过期、临期、良好之和，已用完独立统计。
3. 搜索、种类、五种页面状态的两两和三项组合结果正确，并在分页前生效。
4. 使用中结果按到期日升序；已用完按完成时间降序。
5. 已丢弃不出现在首页概览和库存页，但仍出现在历史记录。
6. 用户 A 无法通过新 action 读取用户 B 的统计或列表。
7. 新增索引已生效，无缺索引异常；旧 `listActive` 在兼容期仍可调用。

### 11.3 开发者工具与真机验收

- 默认进入首页，底部 Tab 顺序和选中态为“首页 / 库存 / 我的”。
- 五张卡片分别跳到正确库存状态；数量为 0 的卡片也能进入对应空结果。
- 从首页卡片进入时搜索和种类已重置；直接切换库存 Tab 时当前条件保留。
- 搜索、种类、状态切换、清空单项、清除全部和加载更多交互正确。
- 新增、编辑、用完或丢弃后，首页和库存再次显示时数据一致。
- 320、375、390、430px 视口下筛选不重叠、不截断，按钮可触达，浮动新增按钮不遮挡列表。
- 断网、首次加载失败、刷新失败、空库存和无匹配结果均有不同反馈。
- 真机复核触控区域、安全区、Tab 切换和二级页面返回链路；提醒真机回归按 V0.1 执行。

## 12. 实施顺序

### 阶段 1：服务端与类型

- 增加 `InventoryViewStatus`、概览响应和库存列表响应类型。
- 在 `inventoryApi` 增加状态校验、`getOverview` 和 `listInventory`。
- 创建“已用完 + 种类 + 完成时间”复合索引。
- 补齐单元测试和云环境集成测试，保留 `listActive`。

完成标准：新接口覆盖五项统计和全部组合筛选，旧客户端接口不受影响。

### 阶段 2：库存页与导航

- 新增库存页，迁移现有搜索、分页、列表和跨日刷新能力。
- 将位置筛选替换为种类、状态两行直接筛选。
- 配置三项 Tab、图标和一次性跨 Tab 意图。

完成标准：直接进入库存页和从五张首页卡片进入时，筛选状态、结果和返回行为正确。

### 阶段 3：首页收敛与回归

- 首页改用 `getOverview`，删除搜索、筛选和列表代码。
- 删除客户端无效的 `inventoryDirty` 标记，统一使用 `onShow` 刷新。
- 完成开发者工具、云环境和真机回归，更新部署文档中的索引与验收项。

完成标准：产品文档 V2 的验收项全部通过，V0.1 未调整流程无回归。

## 13. 发布与回滚

发布顺序固定为：

```text
创建新索引
→ 部署兼容旧 action 的 inventoryApi
→ 验证新旧接口
→ 上传 V2 小程序体验版
→ 开发者工具与真机验收
→ 发布正式版
```

本次没有数据结构迁移，回滚客户端不会丢失数据。若 V2 页面出现阻断问题，可回滚小程序版本；服务端保留 `listActive`，旧版仍能运行。新索引和新 action 可暂时保留，不影响旧版。

## 14. 验收追踪

| 产品验收项 | 技术落点 |
| --- | --- |
| 首页五项数字正确 | `getOverview` 单次聚合、互斥桶、空桶补 0 |
| 卡片落到正确列表 | `pendingInventoryIntent` + `wx.switchTab` + 库存页一次性消费 |
| 搜索、种类、状态组合 | `listInventory` 服务端组合条件后分页 |
| 总数等式成立 | `activeTotal` 由三个互斥 active 桶相加 |
| 已用完独立统计和列表 | `usedUpTotal` + `viewStatus = used_up` |
| 新增/编辑/处理后同步 | 两个 Tab 的 `onShow` 服务端刷新 |
| 空结果和网络失败明确 | 独立的 loading/content/empty/error 状态 |
| 小屏可直接点击全部筛选 | 两行 5 列等宽控件、文字选中语义、真机验证 |

## 15. 官方依据

- [CloudBase 聚合搜索](https://docs.cloudbase.net/database/aggregate)
- [CloudBase Aggregate.group](https://docs.cloudbase.net/api-reference/server/node-sdk/database/aggregate/stages/group)
- [微信小程序 wx.switchTab](https://developers.weixin.qq.com/miniprogram/dev/api/route/wx.switchTab.html)
- [微信小程序全局配置与 tabBar](https://developers.weixin.qq.com/miniprogram/dev/reference/configuration/app.html#tabBar)
- 其余云函数、数据库权限、订阅消息和定时触发依据见 [MVP 技术方案 V0.1](./mvp-technical-design.md#17-官方依据)。
