# 提醒功能梳理与收口方案

> ⚠️ **本文档描述的「单品开关 + 详情页提醒弹窗」模型已于 2026-09-12 被推翻**，见文末
> 「2026-09-12 改版」。下面保留原文用于追溯当时为什么这么设计。

> 状态：**已落地（2026-09-11）**，首页入口取 B 案（直接删）。
> 目标是把散落在 8 处的「提醒」收成 4 个概念、每个概念一个家。

## 一、平台硬约束（先认这个，再谈设计）

1. **一次性订阅消息**：用户每同意一次 = 换到 1 条下发额度，发一条就没了。所以「提醒」的真实粒度是
   **某件物品的这一次提醒**，不是一个可以常开的开关。
2. **授权状态只读**：`wx.getSetting({ withSubscriptions: true })` 只能读；要改只能
   `wx.openSetting({ withSubscriptions: true })` 跳系统页。小程序侧任何 switch 都只能是镜像。
3. **拿不到长期订阅**：长期订阅只开放给政务/医疗/交通/金融等类目，保质期工具不在内。
4. **额度不能批量拿**：`requestSubscribeMessage` 一次调用对同一模板只加 1 条额度。
   N 件物品要 N 次调用（用户没勾「总是保持以上选择」时就是 N 次弹窗）。

> 结论：**别把它做成开关语义**。用户看到 switch 会以为「开一次永久生效」，
> 而真相是「这一件、这一次」。文案与控件形态必须承认这个事实。

## 二、现状：4 个概念 × 8 个入口

| 概念 | 存储 | 现在能在哪里改 | 判定 |
| --- | --- | --- | --- |
| 1. 单品提前天数 | `inventory_items.reminderLeadDays`（必填 0~30） | 完整录入表单、草稿编辑表单、详情只读展示 | 合理 |
| 2. 账号默认天数 | `settings.defaultReminderLeadDays` | 我的·提醒设置 ✅、**录入表单内弹窗** ❌、**草稿表单内弹窗** ❌ | 重复 3 处 |
| 3. 微信通知授权 | 微信系统，不落库 | 我的·提醒设置 ✅、**录入表单假开关** ❌、**草稿表单假开关** ❌ | 重复 3 处 |
| 4. 这一次提醒任务 | `reminder_jobs`（`_id` = itemId） | 详情·提醒弹窗 ✅、**首页更多菜单** ⚠️ | 首页是盲操作 |

### 现存问题清单

- **P0 越界写入**：`item-form-sheet` 的「提醒设置」弹窗点保存会写**全局** `settings`，
  并顺手把当前表单/草稿的 `reminderLeadDays` 覆盖成新的默认值（`index.ts` 的 `saveReminderSettings`）。
  在草稿编辑里改一下「默认提前提醒」，全账号默认值就变了 —— 用户完全预期不到。
- **P0 假开关**：表单里的「提醒授权」switch 不落任何状态，拨动只是弹窗引导，
  还要靠 `authSwitchRebuilding` 卸载重建把它掰回去。用户拨了没反应 = 功能坏了的观感。
- **P1 首页盲操作**：`inventoryApi` 的列表接口**不返回** `reminderStatus`（只有 `get` 返回），
  所以首页更多菜单的「提醒」永远显示同一个样子。已经开过的再点：白弹一次授权；
  已发送过的再点：直接报 `REMINDER_TERMINAL`「本次提醒已经处理」。
- **P1 语义混乱**：同一个词「提醒」在 UI 上同时表示天数、授权、任务三种东西。
- **P2 静默取消**：`dispatchReminders` 发现 `remindDate` 与物品当前值不符时直接
  `cancelInvalidJob`，用户收不到也不知道。（编辑保存时 `inventoryApi.save` 已同步 `remindDate`，
  主要影响历史数据与并发，但 `failed`/`cancelled` 的 job 只改日期不改状态，等于永久哑火。）
- **P2 命名坑**：`mine/index.ts` 把天数当 picker 索引用（`reminderDayIndex: settings.defaultReminderLeadDays`）。
  现在 options 是 0~30 连续，索引恰好等于值，一改选项就炸。应改名 `reminderDayValue` 并显式查索引。

## 三、目标模型：四层，各只有一个家

| 层 | 是什么 | 唯一入口 | 控件形态 |
| --- | --- | --- | --- |
| L1 通知通道 | 微信是否允许推送 | 我的 → 提醒设置 | 状态文字 + 「去微信设置」按钮，**不用 switch** |
| L2 默认天数 | 新建物品的初始值 | 我的 → 提醒设置 | picker，副标题写明「只影响新建」 |
| L3 单品天数 | 这件物品到期前几天提醒 | 录入 / 编辑表单 | 数字输入 +「天」 |
| L4 单次提醒 | 这件物品这一次的提醒任务 | 详情主按钮 + 保存成功后的顺手开启 | 按钮，文案带状态与日期 |

## 四、改动清单

### P0 · 删重复（改动最小、收益最大）✅

1. `components/item-form-sheet`：删掉「提醒授权」switch 行 + 整个「提醒设置」弹窗。
   连带删除 `subscriptionAuthorized` / `subscriptionSummary` / `authSwitchRebuilding` /
   `reminderSettingsVisible` / `reminderSaving` / `reminderDayIndex` / `reminderDayOptions`、
   `handleReminderAuthSwitch` / `saveReminderSettings` / `closeReminderSettings` /
   `openNotificationSettings` / `readReminderAuthorization`，以及组件里对 `updateSettings` 的调用。
   表单只保留一行：**「到期前 __ 天提醒」**。
2. 表单 hint 改成一句真话：「保存后可开启一次微信提醒，每件物品单独授权」。
3. 「我的 → 提醒设置」里把 switch 换成状态文字 + 按钮，与 L1 的形态一致。

### P1 · 让「开提醒」发生在该发生的时刻 ✅

4. 表单底部加一个勾选：**「保存后开启到期提醒」**（默认勾选；只在新建时显示，
   编辑与重新入库交给详情页）。保存成功 → `requestSubscribeMessage` → `armReminder`，
   **必须排在 `triggerEvent('saved')` 之前**，否则宿主 `navigateBack` 会把授权弹窗打断。
   到期日已过时不申请授权，直接提示「已过期，不提醒」。
   整段失败只提示不回滚——物品已入库，提醒是附加动作。
5. 详情页提醒态文案按 job 状态显性化，别再出现「无需提醒」这种含糊词：
   - 无 job → 「未开启」+ 说明里带真实推送日期，按钮「开启到期提醒」
   - `scheduled` → 「已预约 · 9 月 27 日」，按钮「取消提醒」
   - `sending` / `sent` / `unknown` → **不给任何按钮**。云端 `rules.js:canArmReminder`
     把这三个当终态，改到期日也不会解锁，所以文案里不能出现「可以重新开启」
   - `failed` / `cancelled` → 说明原因 + 「重新开启提醒」
   - 物品已过期 / 非在库 → 无按钮 + 「这件物品已经过期，不再发送提醒」
   - 推送日期本地按「到期日 - 提前天数」换算：保存时云端同步 `remindDate`，
     派发时对不上的任务直接作废，所以真能发出去的任务日期必然等于这个值，不必为它加接口字段。
6. 快速录入**不做批量开提醒**（约束 4：N 件 = N 次弹窗，体验必崩），
   批量保存后也不额外弹提示——刚录完就弹说明是噪音，详情页的状态位已经足够显眼。

### P2 · 首页更多菜单：取 B 案 ✅

- **B 案（已采用）**：删掉更多菜单里的「提醒」，提醒只在详情页操作。
  理由：开提醒需要先看见任务状态才能决策，塞进一个看不见状态的快捷菜单本身就是错的
  （旧实现里已开过的再点会白弹一次授权，已发送的再点直接报 `REMINDER_TERMINAL`）。
  连带删除 `remindItem` 与 `assets/icons/action-remind.svg`。
- **A 案（未采用，留档）**：`listActive` / `listHistory` 批量 join `reminder_jobs` 带出
  `reminderStatus`，菜单文案随状态变。成本是每页多一次查询，且要动云函数重新部署。

### P2 · 收尾 ✅

7. `mine/index.ts` 的 `reminderDayIndex` 改名 `reminderDayValue`，picker 的 `value` 显式算索引。
8. 术语统一：功能名「到期提醒」；L1 叫「微信通知」；L3 叫「到期前 N 天提醒」。物品级不再出现「设置」二字。
9. `dispatchReminders` 的静默取消补一条 `failureReason` 落库，方便排查（不改行为）。

## 五、验收要点

- 表单（完整录入 / 草稿编辑 / 详情编辑）里搜不到「授权」「默认」字样，只有一行天数。
- 在草稿里改天数不再影响账号默认值 —— 已由单测锁死。
- 详情页 6 种 job 状态都有明确文案与可点性，过期物品不给按钮。
- 新建时勾了「保存后开启到期提醒」→ 保存成功后弹一次授权，成功后详情显示「已预约 + 日期」。
- 「我的 → 提醒设置」是全局设置的唯一入口，改天数只影响后续新建。

### 落地清单（2026-09-11）

| 文件 | 改动 |
| --- | --- |
| `components/item-form-sheet/{ts,wxml,wxss}` | 删假开关 + 删提醒设置弹窗 + 加「保存后开启到期提醒」勾选与 `armReminderAfterSave` |
| `pages/item-detail/{ts,wxml}` | `decorateItem` 重写成状态机，产出 `reminderStateText` / `reminderCopy` / `reminderSendDateText` / `canArmReminder` / `canCancelReminder` |
| `pages/home/{ts,wxml}` | 删更多菜单的「提醒」项与 `remindItem`，`MoreAction` 收成 `complete \| delete` |
| `pages/mine/{ts,wxml}` | `savedReminderDayIndex` → `savedReminderDayValue` + `reminderDayIndexOf()` 显式换算；「提醒授权」→「微信通知」 |
| `services/reminder-service.ts` | 授权状态说明文案对齐新入口 |
| `tests/unit/item-form-sheet.test.ts` | 新增 8 例：勾选默认值、arm 顺序早于 saved、编辑不 arm、过期不 arm、arm 失败不影响保存、拒绝授权不叠提示、组件不再有账号设置入口 |
| `tests/unit/item-detail-reminder.test.ts` | 新建 14 例锁死六态文案与可点性 |

`npm run check` 全绿：370 tests / 26 files。云函数一行未改，无需重新部署。

### 仍未做（本次范围外）

- `dispatchReminders` 发现 `remindDate` 与物品不符时仍是静默取消，只在日志里留痕。
- 快速录入批量路径没有开启提醒的入口，与单条录入不对称——这是平台约束，不是遗漏。

---

## 2026-09-12 改版：提醒彻底去开关化

### 为什么推翻上文

上文的 L4「单次提醒」需要用户在详情页手动点「开启到期提醒」。结论是：**没人会点**。
用户对提醒的预期是「录了就自动推」，而不是「先去详情页开一下」。

### 新模型（只有 2 个概念）

| 层 | 是什么 | 唯一入口 | 形态 |
| --- | --- | --- | --- |
| L1 默认提前天数 | 新建物品的初始值 | 我的 → 提醒设置 | picker；同页只读展示微信通知授权状态 + 「去微信设置」 |
| L2 提醒时间 | 到期日 − 提前天数，当天 **09:30** | 录入/编辑表单、物品详情 | **只读派生值**，不可编辑，没有开关 |

授权接入点只剩一个：**点「加入库存」/「保存修改」时同步申请一次**。
`wx.requestSubscribeMessage` 在用户勾过「总是保持以上选择」后不再弹窗，静默拿到额度。

### 硬规则

1. **提醒时刻统一 09:30**（北京时间）。前端 `domain/reminder-time.ts:REMINDER_HOUR/MINUTE`
   与云端 `dispatchReminders/config.json` 的触发器必须一致，改一处就要改另一处。
2. **过期不补发**。`dispatchReminders` 只处理 `remindDate === today` 的任务，
   `remindDate < today` 的一律置 `cancelled` + `failureCode: REMINDER_MISSED`。
   `reminderApi.arm` 在提醒时刻已过时直接返回 `{status:'missed'}` 且**不落任务**。
3. **前端拦截只看日期**（`reminder.date < today`），不看时钟：前端拿真实时钟判断会让
   行为随运行时刻漂移。当天 09:30 是否已过由云端 arm 再判一次。
4. **`missed` 只用于展示**（表单/详情打出「已错过」），不落库、不进 `ReminderStatus`。
5. **取消入口不存在**。要停掉提醒就删物品或标记已用完；`reminderApi` 不再有 `cancel` action。
6. 编辑既有物品时只在**缺额度**（无任务 / failed / cancelled）才重新申请授权，
   已预约与已发送（终态）直接跳过，避免改个数量就弹一次。

### 待办（部署前必做）

1. 在微信公众平台 → 功能 → 订阅消息 建模板「物品保质期到期提醒」，字段：
   物品名称 / 到期日期 / 物品类型 / 存放位置 / 数量。
2. 拿到模板 ID 与关键词序号后改三处（都刻意写死，不读环境变量——
   云函数 `envVariables` 只在首次创建时写入云端，读它反而会被旧值盖掉）：
   - `miniprogram/config/runtime.ts` → `REMINDER_TEMPLATE_ID`
   - `cloudfunctions/reminderApi/index.js` → `REMINDER_TEMPLATE_ID`
   - `cloudfunctions/dispatchReminders/template.js` → `TEMPLATE_FIELDS`
3. 云开发控制台把 `daily-reminder-dispatch` 触发器从 `0 0 9 * * * *` 改成 `0 30 9 * * * *`
   （`config.json` 的 `triggers` 同样不参与更新）。
4. 顺手删掉控制台里残留的 `REMINDER_ITEM_FIELD` / `REMINDER_DATE_FIELD` /
   `REMINDER_REMAINING_DAYS_FIELD` / `REMINDER_QUANTITY_FIELD` / `REMINDER_NOTE_FIELD`
   / `REMINDER_TEMPLATE_ID` 环境变量。
5. 上线前把 `MINIPROGRAM_STATE` 从 `developer` 改成 `formal`，否则推送在正式版收不到。

