# 云端部署核验记录（2026-09-14）

环境：`cloud1-d0gkh66ce94b1be08`（开发测试环境）

部署代码基线：`4a712e6`（`index-ui`）

## 已完成

- 目标云函数已收敛为 6 个：`userApi`、`inventoryApi`、`quickEntryApi`、`reminderApi`、`cleanupTrash`、`dispatchReminders`；废弃的 `settingsApi` 已删除。
- 6 个函数均删除后重建为 Node.js 20.19；`reminderApi` 超时 10 秒，其余函数超时 60 秒。
- `inventoryApi` 已显式开启 AI 封面，并配置用户/全局日额度；生图使用已实测可用的最小档 512×512。`quickEntryApi` 已配置文字 AI、请求超时及用户/全局日额度，不存在 STT/OCR 环境变量。
- `dispatchReminders` 已通过微信开发者工具重新部署，应用 `subscribeMessage.send` 开放接口权限；当前开发环境 `MINIPROGRAM_STATE=developer`。
- 已创建并启用 `daily-reminder-dispatch`（每天 09:30）和 `daily-trash-cleanup`（每天 03:30）两个定时触发器。
- 已创建 `ai_usage_daily` 集合；`inventory_items`、`reminder_jobs`、`user_settings`、`users`、`ai_usage_daily` 均设为 `ADMINONLY`。
- `inventory_items` 已补齐四种库存排序及其分类过滤版本的 `_id` 兜底索引、历史/回收站稳定游标索引和封面引用索引，共 16 个索引。
- `reminder_jobs` 已补齐 `status + remindDate` 和 `status + updatedAt` 索引，共 5 个索引。
- 6 个函数均为 `Deployment completed`。`cleanupTrash` 云端执行成功；`dispatchReminders` 云端执行成功并收敛 2 条过期待发测试任务；4 个 API 函数均完成冷启动和鉴权边界验证。
- 仓库新增 `cloudbaserc.json`，固化运行时、超时、环境变量和定时触发器配置。

## 当前真实云端状态

| 云函数 | 超时 | 运行时 | 环境变量/触发器 |
| --- | ---: | --- | --- |
| `userApi` | 60 秒 | Node.js 20.19 | 无 |
| `inventoryApi` | 60 秒 | Node.js 20.19 | AI 封面开启，512×512，额度已配置 |
| `quickEntryApi` | 60 秒 | Node.js 20.19 | 文字 AI 与额度已配置 |
| `reminderApi` | 10 秒 | Node.js 20.19 | 无 |
| `cleanupTrash` | 60 秒 | Node.js 20.19 | 每天 03:30 |
| `dispatchReminders` | 60 秒 | Node.js 20.19 | `developer`；每天 09:30 |

## 仍需人工完成

1. 微信公众平台 → 功能 → 订阅消息 → 我的模板：核对模板 ID `jXD8Fb4_ZudDL8FWO3dP4VXcYMWTXjqOaSaM1XBLwh8`，字段必须依次为 `thing7/time2/number5/number4/thing3`。
2. 微信公众平台 → 设置与开发 → 服务内容声明 → 用户隐私保护指引：删除录音、语音识别、相机/OCR 相关声明；保留并写明“用户输入的物品文字会发送至大模型用于结构化解析，物品名称会用于生成 AI 封面”。
3. 微信开发者工具上传体验版，用两个微信账号完成订阅同意、拒绝、09:30 收到通知、点击进入物品详情的真机闭环。
4. 转正式版前，把 `cloudbaserc.json` 中 `MINIPROGRAM_STATE` 改为 `formal`，执行 `tcb --yes config update fn dispatchReminders`，再上传正式版。
