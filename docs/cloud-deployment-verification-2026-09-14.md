# 云端部署核验记录（2026-09-14）

环境：`cloud1-d0gkh66ce94b1be08`

代码提交：`1a29f27`（`index-ui`，含 `ai_usage_daily` 尚未创建时的注销兼容）

## 已完成

- `npm run check` 通过：35 个测试文件、454 项测试全部通过，类型检查和项目结构检查通过。
- 使用微信开发者工具 CLI 与云端安装依赖方式成功部署 `userApi`、`inventoryApi`、`quickEntryApi`、`reminderApi`。
- 创建并成功部署 `cleanupTrash`；首次创建时平台短暂返回 `Creating` 竞态，函数转为 `Active` 后幂等重试成功。
- 从云端回下载 `userApi`，除不属于代码包事实的 `config.json` 外，9 个源码/依赖清单文件的 SHA-256 均与本地提交一致。
- `dispatchReminders` 尚未更新：当前工具无法暂停线上触发器，也无法同步控制面配置，避免在旧配置仍生效时直接切换派发逻辑。

## 当前真实云端状态

| 云函数 | 代码 | 超时 | 运行时 | 判定 |
| --- | --- | ---: | --- | --- |
| `userApi` | 已部署本提交 | 60 秒 | Node.js 16.13 | 运行时待改 |
| `inventoryApi` | 已部署本提交 | 60 秒 | Node.js 16.13 | 运行时待改 |
| `quickEntryApi` | 已部署本提交 | 60 秒 | Node.js 16.13 | 运行时待改 |
| `reminderApi` | 已部署本提交 | 3 秒 | Node.js 16.13 | 超时、运行时待改 |
| `cleanupTrash` | 已部署本提交 | 3 秒 | Node.js 16.13 | 超时、运行时、触发器待改 |
| `dispatchReminders` | 仍为旧代码 | 3 秒 | Node.js 16.13 | 暂停后再部署和配置 |
| `settingsApi` | 废弃函数仍存在 | 3 秒 | Node.js 16.13 | 验证 `userApi` 设置读写后删除 |

云函数清单目前为 7 个，尚未达到目标的 6 个。微信开发者工具的更新部署只替换代码包，不会把仓库 `config.json` 中的运行时、超时、环境变量、权限和触发器同步到已存在函数；新建函数也仍采用平台默认的 3 秒与 Node.js 16.13。

## 发布前控制台操作

1. 明确当前唯一云环境是生产还是开发环境；若含混用测试数据，先建立独立生产环境。
2. 暂停 `daily-reminder-dispatch`，记录 `reminder_jobs` 各状态数量。
3. 创建 `ai_usage_daily` 集合，客户端权限设为不可直接读写；同时核对其余集合权限。
4. 将 6 个目标函数运行时改为 Node.js 20；API/清理/派发超时按整改方案改为 60/10 秒目标值。
5. 删除 `quickEntryApi` 的 STT/OCR/Tencent 环境变量；配置文字 AI 用户与全局日限额。`inventoryApi` 保持 `COVER_IMAGE_ENABLED=false`，同时配置封面用户与全局日限额。
6. 核对并创建最终索引：库存列表排序末尾 `_id`、历史/回收站 `completedAt + _id`、提醒 `status + remindDate` 与 `status + updatedAt`、最近录入及自动清理索引。
7. 验证 `userApi.getSettings/updateSettings` 后删除 `settingsApi`。
8. 为 `cleanupTrash` 配置每日 03:30（Asia/Shanghai）触发器，并禁止小程序直接调用。
9. 在公众平台核对模板 ID 与 `thing7/time2/number5/number4/thing3`；处理旧待发任务后，部署 `dispatchReminders`，配置 60 秒、09:30、`subscribeMessage.send` 权限及正确发布状态，再恢复触发器。
10. 完成体验版双账号真机订阅消息闭环、隐私声明清理、临时媒体清单导出与存储清理后，才可判定发布门槛关闭。

本记录明确区分“代码包已部署”和“控制面配置已生效”；在上述项目完成前不得发布正式版。
