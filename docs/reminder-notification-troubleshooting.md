# 到期提醒（服务通知）不送达排查记录

环境：`cloud1-d0gkh66ce94b1be08`｜记录时间：2026-09-21

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
| 1 | 云函数 → `dispatchReminders` → 配置 | 环境变量 `MINIPROGRAM_STATE` 与**实际运行的版本**一致：开发版 `developer`／体验版 `trial`／正式版 `formal` | 状态与版本不匹配时，消息**不展示**，但接口返回成功 |
| 2 | 云函数 → `dispatchReminders` → 触发器 | `daily-reminder-dispatch` 存在且已启用（每天 09:30） | 没有任何任务被派发，`reminder_jobs` 一直停在 `scheduled` |
| 3 | 云函数 → `dispatchReminders` → API 权限 | 已勾选 `subscribeMessage.send` | 调用开放接口直接报无权限 |
| 4 | 公众平台 → 功能 → 订阅消息 → 我的模板 | 模板 ID `jXD8Fb4_ZudDL8FWO3dP4VXcYMWTXjqOaSaM1XBLwh8`，字段依次 `thing7 / time2 / number5 / number4 / thing3` | 发送报 `47003`（参数不合法）或 `40037`（模板 ID 无效） |

注意 `cloudbaserc.json` 写的是 `developer`、`cloudfunctions/dispatchReminders/config.json`
写的是 `formal`，两处不一致；而 `envVariables` / `triggers` / `permissions` **只在函数首次创建时**
写入云端，之后改配置或重新部署都不会同步。**以控制台实际值为准。**

## 四、马上测一条（不用等到 09:30）

派发侧只认「提醒日 == 今天」，而前端在 09:30 之后不再落任务，所以要手工造一条自洽数据：

1. 数据库 → `inventory_items`：挑一件物品，记下 `_id`，把 `expiryDate` 改成
   「今天 + `reminderLeadDays`」（如今天 2026-09-21、提前 1 天 → 改成 `2026-09-22`）
2. 数据库 → `reminder_jobs`：找到 `_id` 等于该 `itemId` 的记录（`reminderApi` 用
   `doc(itemId).set()`，所以 `_id` 就是 itemId），把 `remindDate` 改成 `2026-09-21`、
   `status` 改成 `scheduled`；没有记录就照这个结构新增一条
3. 云函数 → `dispatchReminders` → 云端测试 → 运行（无需参数）
4. 看返回值 `sent` / `failed` / `unknown`，再看 `reminder_jobs` 里的 `failureCode`

**前提**：这条记录对应的 openid 得先有订阅额度 —— 先在真机上完成一次
「录入物品 → 弹出订阅面板 → 点允许」，否则必然 `43101`。

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
4. 再等一个自然 09:30 的定时触发，确认触发器真的在工作。
