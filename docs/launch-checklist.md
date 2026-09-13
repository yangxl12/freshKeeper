# 上线前必做（只有你能操作）

更新：2026-09-13。全部是后台手工项，代码和部署替代不了。
功能验收见 `quick-entry-acceptance.md`，云环境搭建见 `cloud-deployment.md`。

先做 1–3，它们直接挡功能；4 以后是性能与合规。

---

## 1. 订阅消息模板 —— 不做，提醒功能发不出去

1. 公众平台 → 功能 → 订阅消息 → 申请**一次性订阅**模板，字段选：物品名称、到期日、剩余天数、当前数量、备注。
2. 记下**模板 ID** 和 5 个字段名（形如 `thing7`、`time2`）。
3. 填 3 处，缺一处静默失效：
   - `miniprogram/config/runtime.ts:15` → `REMINDER_TEMPLATE_ID`
   - 云开发控制台 → 云函数 → `reminderApi` → 配置 → 环境变量 `REMINDER_TEMPLATE_ID`
   - `cloudfunctions/dispatchReminders/template.js` → 字段映射改成实际字段名
4. `dispatchReminders` 环境变量 `MINIPROGRAM_STATE`：开发 `developer` / 体验 `trial` / 正式 `formal`。

---

## 2. 云函数超时改 60 秒 —— 不改，快录必报错

云开发控制台 → 云函数 → 配置 → 超时时间 → **60 秒**，逐个改：

- `quickEntryApi`
- `userApi`

（新环境默认 3 秒，更新部署不会自动带上 `config.json` 里的值。）

---

## 3. 用户隐私保护指引 —— 审核项

公众平台 → 设置 → 服务内容声明 → **用户隐私保护指引** → 编辑，补上这 5 条：

1. 收集**昵称、头像** —— 用于个人资料展示。
2. 提供删除/注销路径 —— 「我的 → 账号与数据」。
3. **语音转写** —— 用途：识别本次录入内容；第三方处理方：腾讯云；不长期留存。
4. **相机/相册** —— 用途：识别本次录入的日期。
5. **文字/语音会发送至大模型（云开发内置混元）用于结构化解析**。

代码联动：`miniprogram/config/runtime.ts` 的 `QUICK_ENTRY_FEATURES.aiParse` —— 审核通过前 `false`，通过后 `true`。

---

## 4. 数据库索引（11 条，开发、生产各建一次）

云开发控制台 → 数据库 → 集合 → **索引管理** → 添加索引。
规则：**字段顺序不能换，不要勾唯一**。

`inventory_items`（9 条）：

| # | 字段（顺序固定） |
| --- | --- |
| 1 | `ownerId` ASC, `inventoryStatus` ASC, `expiryDate` ASC, `createdAt` DESC |
| 2 | `ownerId` ASC, `inventoryStatus` ASC, `category` ASC, `expiryDate` ASC, `createdAt` DESC |
| 3 | `ownerId` ASC, `inventoryStatus` ASC, `storageLocation` ASC, `expiryDate` ASC, `createdAt` DESC |
| 4 | `ownerId` ASC, `inventoryStatus` ASC, `category` ASC, `storageLocation` ASC, `expiryDate` ASC, `createdAt` DESC |
| 5 | `ownerId` ASC, `inventoryStatus` ASC, `completedAt` DESC |
| 6 | `ownerId` ASC, `inventoryStatus` ASC, `category` ASC, `completedAt` DESC |
| 7 | `ownerId` ASC, `inventoryStatus` ASC, `updatedAt` DESC |
| 8 | `ownerId` ASC, `inventoryStatus` ASC, `name` ASC |
| 9 | `inventoryStatus` ASC, `purgeAfter` ASC |

`reminder_jobs`（2 条）：

| # | 字段 |
| --- | --- |
| 10 | `status` ASC, `remindDate` ASC |
| 11 | `ownerId` ASC, `status` ASC |

---

## 5. 集合权限

云开发控制台 → 数据库 → 集合 → 权限设置 → **所有用户不可读写**（只允许云函数访问）：

`inventory_items`、`user_settings`、`reminder_jobs`、`users`

---

## 6. 云函数调用权限

云开发控制台 → 云函数 → 配置 → 权限 → 改为**仅定时触发、禁止小程序端调用**：

- `dispatchReminders`
- `cleanupTrash`

---

## 7. 触发器时区

确认两个定时触发器时区为 `Asia/Shanghai`：

- `dispatchReminders` —— 每日 09:00
- `cleanupTrash` —— 每日 03:30

---

## 8. 云存储规则

云开发控制台 → 存储 → 权限设置：

- 安全规则：仅创建者可读写（他人不可读）。
- 为 `quick-entry/` 目录配**最短可用生命周期清理**。

---

## 9. 腾讯云识别服务（语音、拍日期）

1. 腾讯云控制台开通「一句话识别」和「通用文字识别（高精度版）」，确认计费。
2. 建一个只有 ASR/OCR 权限的子账号，拿 SecretId / SecretKey。
3. 云开发控制台 → 云函数 → `quickEntryApi` → 环境变量：

   | 变量 | 值 |
   | --- | --- |
   | `QUICK_ENTRY_TENCENT_SECRET_ID` | 上一步的 SecretId |
   | `QUICK_ENTRY_TENCENT_SECRET_KEY` | 上一步的 SecretKey |
   | `QUICK_ENTRY_TENCENT_REGION` | 可选，默认 `ap-guangzhou` |

密钥不要发聊天、不要提交仓库。

---

## 10. 小程序成长计划 + 云环境套餐（AI 解析的前提）

1. 公众平台 → 行业能力 → **小程序成长计划** → 报名（无审核，一个账号一次，10 亿混元 Token 有效期 6 个月）。
2. 云开发控制台 → 环境 → 套餐：确认为**个人版**。免费体验版不支持内置模型调用，会导致 AI 一直静默降级。

---

## 11. We 分析埋点登记

公众平台 → **We 分析** → 数据管理 → 上报管理：

1. 属性管理 → 批量JSON创建 → 粘贴 `docs/analytics-properties-batch.json`（14 个属性）
2. 元事件 → 批量JSON创建 → 粘贴 `docs/analytics-events-batch.json`（26 个事件）；
   没有批量入口就逐个新增。**事件 ID 建完不可改**。

不登记 = 上报被静默丢弃，不报错不留痕。

---

## 12. 杂项

- `project.config.json` 的 `touristappid` → 换成真实 AppID。
- **ICP 备案**：小程序上架前置条件，文档里从没记录过，去公众平台确认状态。
- **服务类目**：确认所选类目不需要额外资质。
