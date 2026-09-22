# 到期提醒（服务通知）不送达排查记录

环境：`cloud1-d0gkh66ce94b1be08`｜记录时间：2026-09-21

> **提醒时刻**：北京时间 **16:00**（`REMIND_HOUR=16` / `REMIND_MINUTE=0`）。
>
> **触发器不再绑死时刻**：`daily-reminder-dispatch` 配的是**每小时整点** `0 0 * * * * *`，
> 「到没到 16:00」由 `dispatchReminders` 里的 `reachedRemindTime()` 判断。
> 所以以后改提醒时刻只需改三处代码（见下）并重新部署，**不用再动控制台触发器**。
>
> 改提醒时刻要同步的地方（`npm run check` 会硬校验，不一致直接红）：
> ① `miniprogram/domain/reminder-time.ts` 的 `REMINDER_HOUR/REMINDER_MINUTE`
> ② `cloudfunctions/reminderApi/index.js` 的 `REMIND_HOUR/REMIND_MINUTE`
> ③ `cloudfunctions/dispatchReminders/index.js` 的 `REMIND_HOUR/REMIND_MINUTE`

## 〇、2026-09-21「说好 16:00 提醒，一条都没来」事故复盘

一次改动没完整落地造成的，**不是订阅消息本身的问题**：

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 16:00 完全没有派发动作 | 云端触发器仍是 `0 30 9 * * * *`（09:30）。本地把 `config.json` 改成 16:00 后**没有重新部署**，云端配置一直停在旧值 |
| 2 | 就算 09:30 那次跑了也发不出来 | 云端 `reminderApi/index.js` 仍是 `REMIND_HOUR=9 / REMIND_MINUTE=30` 的旧版本 —— 同样改了本地没部署 |
| 3 | 排查时看不出问题 | 前端 `reminder-time.ts` 已经写着 16:00，UI 显示「今天 16:00 提醒」，但云端是 09:30，两边各说各话 |

**教训（已固化成校验）**：

- 改完云函数必须**真的部署**。`cloud functions download` 拉云端代码跟本地 diff 是最可靠的核对方式。
- `envVariables` / `triggers` 是否随部署同步，不同 CLI 行为不一致，**以控制台实际值为准**，别信本地文件。
- `npm run check` 现在会硬校验：提醒时刻三处必须一致、`cloudbaserc.json` 与 `config.json` 的触发器和跳转状态必须一致。

**顺带做的加固**：

- 派发新增 `manual` 手工入口和 `action: 'diag'` 只读诊断，不再需要等定时器才能验证（见第四节）。
- 派发按时钟判断是否到点，触发器改成每小时 —— 触发器配一次就永久有效，以后改时刻只改代码。

## 一、已定位并已修的根因：订阅授权不在 tap 同步栈里发起

微信对 `wx.requestSubscribeMessage` 有硬性要求：**必须由用户 tap 事件同步触发**，
只要调用点落在任何一个 `await` 之后，就会被拒绝并抛

```
requestSubscribeMessage:fail can only be invoked by user TAP gesture
```

原实现两处都在「保存云函数返回之后」才申请授权：

- `item-form-sheet`：`save()` → `await saveItem()` → `armReminderAfterSave()` → 申请
- `quick-entry`：`persistDrafts()` → `await Promise.allSettled(saveItem...)` → 申请

后果是一条完整的死链：**授权每次都被拒 → 微信侧订阅额度恒为 0 →
`subscribeMessage.send` 必然失败 → 服务通知永远不来**。
用户侧只看到一句「提醒未开启，可稍后再试」，很容易被当成模板没配好。

> 自检：We 分析里的 `reminder_request_result` 事件，若 `result` 绝大多数是 `failed`，即是此症。

**修法**：把授权请求提到第一个 `await` 之前（`async` 函数在首个 `await` 之前的代码仍在
tap 的同步调用栈里），只把 Promise 留给保存成功后收结果。

- `item-form-sheet`：新增 `requiresReminderSetup()` 做同步判定
- `quick-entry`：新增 `hasReminderTarget()` 做同步判定

两处判据都必须与各自 `armReminderAfterSave()` / `armSavedReminders()` 内的跳过条件保持一致。

## 二、微信侧的一条硬限制（不是 bug，需要在产品上取舍）

**一次性订阅 = 一次点击换一条发送额度。**

`wx.requestSubscribeMessage` 只能活在 tap 同步栈里，而订阅请求本身是串行的，
所以**一次点击只能换来一次授权结果**。批量快速录入 N 条时，云端会为 N 条都落
`reminder_jobs`，但只有 1 条有额度，其余会在发送时以 `43101` 失败。

可选方向（待定）：

1. 维持现状：批量只有一条能推，其余靠用户逐件编辑再保存一次来补额度；
2. 保存结果页给出「逐条开启提醒」的列表，每条一个按钮 —— 每次点击都在 tap 同步栈里，
   可以真正攒出 N 条额度（唯一能绕开限制的做法，但需要新 UI）。

## 三、云端仍需人工核对（控制台）

| # | 位置 | 要确认的事 | 不对会怎样 |
| --- | --- | --- | --- |
| 1 | 云函数 → `dispatchReminders` → 配置 | 环境变量 `MINIPROGRAM_STATE` 指向当前在测的版本：开发版 `developer`／体验版 `trial`／正式版 `formal` | **不影响能否收到**，只决定点击通知跳进哪个版本；`developer` 只在本地开着开发者工具时可用，`formal` 在正式版未发布或未更新时跳不过去 |
| 2 | 云函数 → `dispatchReminders` → 触发器 | `daily-reminder-dispatch` 存在且已启用，cron 为 **每小时整点** `0 0 * * * * *`。到没到提醒时刻由代码判断，所以这个值配好就**再也不用改**。⚠️ 不同 CLI 对「部署是否同步触发器」行为不一致，`config.json` 改了务必在这里复核一次 | 没有任何任务被派发，`reminder_jobs` 一直停在 `scheduled` |
| 3 | 云函数 → `dispatchReminders` → API 权限 | 已勾选 `subscribeMessage.send` | 调用开放接口直接报无权限 |
| 4 | 公众平台 → 功能 → 订阅消息 → 我的模板 | 模板 ID `jXD8Fb4_ZudDL8FWO3dP4VXcYMWTXjqOaSaM1XBLwh8`，字段依次 `thing7 / time2 / number5 / number4 / thing3` | 发送报 `47003`（参数不合法）或 `40037`（模板 ID 无效） |

`envVariables` / `triggers` / `permissions` 是否随部署同步，不同 CLI 行为不一致，
**以控制台实际值为准**。`cloudbaserc.json` 与 `config.json` 的触发器和 `MINIPROGRAM_STATE`
必须一致（已由 `npm run check` 硬校验），否则又会出现「以为改了其实没改」。

## 四、马上测一条（不用等定时器）

派发函数有三个手工入口，都在**云函数 → `dispatchReminders` → 云端测试**里填参数运行：

| 参数 | 作用 |
| --- | --- |
| `{"manual": true, "action": "diag"}` | **只读诊断**，不碰任何数据。返回 `reminder_jobs` 全貌：总数、各状态计数、各提醒日计数、今天待发任务列表、最近 20 条记录（含 `failureCode`） |
| `{"manual": true, "force": true}` | **立刻派发**，忽略时钟，把今天及以前所有 `scheduled` 任务发一遍，返回 `sent` / `failed` / `unknown` 与每条明细 |
| `{"manual": true, "action": "send-test", "itemId": "任务ID", "miniprogramState": "developer"}` | **指定任务即时验收**。即使提醒日在未来也立刻发送这一条，适合当天已过 16:00 后做端到端验证；成功后任务会变为 `sent`，不会在原提醒日重复发送 |
| `{"manual": true}` | 按真实时钟判断（未到 16:00 则当天任务保持 `scheduled` 不动，只清理过期任务） |

> `manual: true` 是必须的，而且手工入口会硬校验调用上下文**没有 OPENID**，只允许控制台云端测试；
> 小程序用户即使伪造 `manual:true` 也会被 `FORBIDDEN` 拒绝。**先跑 `diag` 看有没有待发任务，再按日期选择 `force` 或指定 `send-test`。**

**落任务那一步才看时钟**：`reminderApi.arm` 在「提醒日 == 今天」时会把当前时刻与
`REMIND_HOUR / REMIND_MINUTE`（现为 **16:00**）比较，已过就返回 `missed`、不落任何任务。
所以**过了 16:00 再保存物品，当天这条就预约不上了** —— 要么在 16:00 之前保存，要么手工造数据。

### 路径 A：走真实链路（能一次验完整条链，推荐）

1. 真机新增一件物品，到期日填「今天 + 提前天数」（默认提前 1 天 → 填 `2026-09-22`，
   这样提醒日正好落在今天）
2. 保存时弹出的订阅面板点**允许**
3. 数据库 → `reminder_jobs`：应出现 `_id` = 该物品 `_id`、`status: 'scheduled'`、
   `remindDate: '2026-09-21'` 的记录
4. 云函数 → `dispatchReminders` → 云端测试 → 参数填 `{"manual": true, "force": true}` → 运行 → 应返回 `sent: 1`

### 路径 B：手工造数据（额度已有、只想验派发侧）

1. 数据库 → `inventory_items`：挑一件物品，记下 `_id`，把 `expiryDate` 改成
   「今天 + `reminderLeadDays`」（如今天 2026-09-21、提前 1 天 → 改成 `2026-09-22`）
2. 数据库 → `reminder_jobs`：找到 `_id` 等于该 `itemId` 的记录（`reminderApi` 用
   `doc(itemId).set()`，所以 `_id` 就是 itemId），把 `remindDate` 改成 `2026-09-21`、
   `status` 改成 `scheduled`；没有记录就照这个结构新增一条
3. 云函数 → `dispatchReminders` → 云端测试 → 参数填 `{"manual": true, "force": true}` → 运行

两条路径都看返回值 `sent` / `failed` / `unknown`，再看 `reminder_jobs` 里的 `failureCode`。

**前提**：这条记录对应的 openid 得先有订阅额度，否则必然 `43101`。
路径 A 天然包含授权这一步；走路径 B 也必须先在真机上完成过一次
「录入物品 → 弹出订阅面板 → 点允许」。

### `failureCode` 对照

| failureCode | 含义 |
| --- | --- |
| `sent`（状态） | 发送成功，链路已通 |
| `43101` | 用户拒绝接收 / 该模板没有剩余订阅额度 |
| `47003` | 模板参数不合法（字段序号或类型与公众平台模板不符） |
| `40037` | `template_id` 不正确 |
| `41030` | `page` 路径不存在 |
| 无权限类错误 | 云函数缺少 `subscribeMessage.send` 开放接口权限 |

## 五、验收顺序

1. 先按「三」把云端四项核对掉；
2. 真机走一次完整保存，`reminder_jobs` 应出现 `status: 'scheduled'` 且 `remindDate` 正确；
3. 按「四」跑一次 `diag`，确认待发任务真的存在（这一步能挡掉一半的无效排查）；
4. 按「四」跑一次 `force`，确认能收到服务通知；
5. 最后等一个自然整点（每小时都会跑），确认触发器真的在工作 —— 16:00 之后再看
   `reminder_jobs`，当天任务应已变成 `sent`。

## 六、体验版 / 开发版能不能收到通知？

**能。** 服务通知下发到用户微信的「服务通知」会话，与小程序跑在哪个版本无关。
`miniprogramState` 只决定**点击通知后跳进哪个版本**，不是能否下发的开关。微信开放社区口径：

> 推送没有体验版这个说法吧，都是推送到用户微信上的
> 开发版也是可以触发的，订阅成功后服务端调用接口下发消息

与版本真正相关的只有两项：

| 项 | 影响 |
| --- | --- |
| `miniprogramState` | 点击通知的**跳转落点**（`developer` / `trial` / `formal`，默认 `formal`） |
| 体验成员名单 | 只有名单内的微信号能打开体验版，因此也只有他们能授权、能收到 |

其余前提与版本无关：模板已审核通过（**不需要**小程序上线 / 认证 / 备案）、
该用户已授权且有剩余额度、云函数有 `subscribeMessage.send` 开放接口权限。

**必须真机。** 开发者工具模拟器不会把服务通知推到真机微信，订阅面板的表现也与真机不一致。

| 测试路径 | 授权 / 收通知 | 点击跳转 | 适用 |
| --- | --- | --- | --- |
| 开发者工具「预览」扫码 | 可以 | 二维码 25 分钟失效后跳不进 | 最快验证「能不能收到」 |
| 上传 → 设为体验版 → 扫码 | 可以 | 可以（配 `miniprogramState=trial`） | 完整闭环验收 |
| 模拟器 | 不行 | 不行 | 只能看 UI |

> ⚠️ 把控制台 `MINIPROGRAM_STATE` 改成 `trial` / `developer` 会让本地 `npm run check` 失败 ——
> `scripts/validate-project.mjs:112` 硬断言它必须是 `formal`。测试期可临时放宽该断言，或忽略这条失败。
