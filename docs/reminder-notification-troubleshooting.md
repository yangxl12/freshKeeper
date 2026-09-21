# 到期提醒（服务通知）不送达排查记录

环境：`cloud1-d0gkh66ce94b1be08`｜记录时间：2026-09-21

> **2026-09-21 变更**：提醒时刻由北京时间 09:30 改为 **14:00**（当天下午即可验证链路）。
> 涉及 `domain/reminder-time.ts`、`reminderApi/index.js`、`dispatchReminders/config.json`、
> `cloudbaserc.json`、`scripts/validate-project.mjs` 与相关测试。
> ⚠️ 云端定时触发器**不会**随代码更新，必须去控制台手动改 —— 见第三节第 2 项。

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
| 2 | 云函数 → `dispatchReminders` → 触发器 | `daily-reminder-dispatch` 存在且已启用，时刻与代码内一致（现为每天 **14:00**）。⚠️ 触发器**只在函数首次创建时**写入云端，之后改 `config.json` / `cloudbaserc.json` 重新部署都**不会**同步 —— 改时刻必须在这里手改 | 没有任何任务被派发，`reminder_jobs` 一直停在 `scheduled` |
| 3 | 云函数 → `dispatchReminders` → API 权限 | 已勾选 `subscribeMessage.send` | 调用开放接口直接报无权限 |
| 4 | 公众平台 → 功能 → 订阅消息 → 我的模板 | 模板 ID `jXD8Fb4_ZudDL8FWO3dP4VXcYMWTXjqOaSaM1XBLwh8`，字段依次 `thing7 / time2 / number5 / number4 / thing3` | 发送报 `47003`（参数不合法）或 `40037`（模板 ID 无效） |

注意 `cloudbaserc.json` 写的是 `developer`、`cloudfunctions/dispatchReminders/config.json`
写的是 `formal`，两处不一致；而 `envVariables` / `triggers` / `permissions` **只在函数首次创建时**
写入云端，之后改配置或重新部署都不会同步。**以控制台实际值为准。**

## 四、马上测一条（不用等定时器）

**派发侧只比对日期**（`job.remindDate === 今天`），**不看时钟** —— 所以不必等定时器，
在控制台手动运行 `dispatchReminders` 就能立刻派发。

**落任务那一步才看时钟**：`reminderApi.arm` 在「提醒日 == 今天」时会把当前时刻与
`REMIND_HOUR / REMIND_MINUTE`（现为 **14:00**）比较，已过就返回 `missed`、不落任何任务。
所以要么在 14:00 之前保存，要么直接手工造数据。

### 路径 A：走真实链路（能一次验完整条链，推荐）

1. 真机新增一件物品，到期日填「今天 + 提前天数」（默认提前 1 天 → 填 `2026-09-22`，
   这样提醒日正好落在今天）
2. 保存时弹出的订阅面板点**允许**
3. 数据库 → `reminder_jobs`：应出现 `_id` = 该物品 `_id`、`status: 'scheduled'`、
   `remindDate: '2026-09-21'` 的记录
4. 云函数 → `dispatchReminders` → 云端测试 → 运行（无需参数）→ 应返回 `sent: 1`

### 路径 B：手工造数据（额度已有、只想验派发侧）

1. 数据库 → `inventory_items`：挑一件物品，记下 `_id`，把 `expiryDate` 改成
   「今天 + `reminderLeadDays`」（如今天 2026-09-21、提前 1 天 → 改成 `2026-09-22`）
2. 数据库 → `reminder_jobs`：找到 `_id` 等于该 `itemId` 的记录（`reminderApi` 用
   `doc(itemId).set()`，所以 `_id` 就是 itemId），把 `remindDate` 改成 `2026-09-21`、
   `status` 改成 `scheduled`；没有记录就照这个结构新增一条
3. 云函数 → `dispatchReminders` → 云端测试 → 运行（无需参数）

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
3. 按「四」手工触发一次，确认能收到服务通知；
4. 再等一个自然 14:00 的定时触发，确认触发器真的在工作（前提是已在控制台把触发器改成 14:00）。

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
