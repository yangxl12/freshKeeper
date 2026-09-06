# 云开发接入与验收

代码不包含 AppID、云环境 ID 或订阅模板配置。以下步骤需分别在开发和生产环境执行。

## 1. 连接小程序与云环境

1. 在 `project.config.json` 中把 `touristappid` 替换为真实 AppID。
2. 在微信开发者工具中开通云开发，并建立独立的开发、生产环境。
3. 在 `miniprogram/config/runtime.ts` 填写当前构建使用的云环境 ID 和一次性订阅消息模板 ID。
4. 不要向仓库提交密钥、私钥或 OPENID。

## 2. 建立数据集合

创建以下集合，并把客户端读写权限全部设为“无权限”；数据只允许云函数访问：

- `inventory_items`
- `user_settings`
- `reminder_jobs`

为开发、生产环境分别创建并确认以下复合索引：

| 集合 | 索引字段 |
| --- | --- |
| `inventory_items` | `ownerId ASC, inventoryStatus ASC, expiryDate ASC, createdAt DESC` |
| `inventory_items` | `ownerId ASC, inventoryStatus ASC, category ASC, expiryDate ASC, createdAt DESC` |
| `inventory_items` | `ownerId ASC, inventoryStatus ASC, storageLocation ASC, expiryDate ASC, createdAt DESC` |
| `inventory_items` | `ownerId ASC, inventoryStatus ASC, category ASC, storageLocation ASC, expiryDate ASC, createdAt DESC` |
| `inventory_items` | `ownerId ASC, inventoryStatus ASC, completedAt DESC` |
| `reminder_jobs` | `status ASC, remindDate ASC` |
| `reminder_jobs` | `ownerId ASC, status ASC` |

名称包含搜索使用当前用户范围内的正则匹配；首版不建立全文索引。

## 3. 部署云函数

在开发者工具中分别对以下目录执行“上传并部署：云端安装依赖”：

- `inventoryApi`
- `settingsApi`
- `reminderApi`
- `dispatchReminders`

运行时固定为 Node.js 20。函数调用权限配置为：已登录用户可调用前三个业务函数；`dispatchReminders` 禁止小程序端调用，只允许定时触发。

为 `reminderApi` 配置环境变量：

| 变量 | 值 |
| --- | --- |
| `REMINDER_TEMPLATE_ID` | 公众平台申请的一次性订阅模板 ID |

为 `dispatchReminders` 配置环境变量：

| 变量 | 值 |
| --- | --- |
| `REMINDER_ITEM_FIELD` | 物品名称字段：`thing7` |
| `REMINDER_DATE_FIELD` | 保质期字段：`time2` |
| `REMINDER_REMAINING_DAYS_FIELD` | 剩余天数字段：`number5` |
| `REMINDER_QUANTITY_FIELD` | 当前库存数量字段：`number4` |
| `REMINDER_NOTE_FIELD` | 备注字段：`thing3` |
| `MINIPROGRAM_STATE` | 开发 `developer`、体验 `trial`、正式 `formal` |

模板字段必须以公众平台实际审批结果为准。`dispatchReminders/config.json` 已声明 `subscribeMessage.send` 权限和每日 09:00 触发器；部署后仍需在控制台确认业务时区为 `Asia/Shanghai`，并确认该函数不能被客户端调用。

## 4. 发布前验证

自动检查：

```bash
npm run check
```

云环境至少验证：

- A 用户不能查看、修改或删除 B 用户的物品、历史和提醒任务。
- 同版本并发修改只有一次成功，另一请求返回冲突。
- 修改到期日会更新未发送任务；用完、丢弃和删除会取消待发任务。
- 临时改为每分钟触发后连续运行两次，同一任务最多收到一条消息；验证完恢复每日 09:00。
- 函数日志不出现完整物品名称、OPENID 或微信订阅原始报文。

真机必须完成：

- 两种日期录入各一次，覆盖新增、查看、编辑和二次确认删除。
- 数量 `2 → 1`、数量 `1 → 已用完`、丢弃和历史查看。
- 搜索、分类、位置及组合筛选，清空后恢复全部库存。
- 拒绝订阅后继续新增和编辑；接受后收到一次消息并正确进入详情。
- 杀掉微信进程后重新进入，确认数据仍存在。
- 使用两个微信账号确认数据隔离。

开发者工具模拟器不能替代订阅弹窗、消息触达、跳转、真实触控和安全区验收。

## 5. 依赖安全备注

截至 2026-09-06，根工程依赖审计为 0 项；最新稳定版 `wx-server-sdk@4.0.2` 的上游仍固定了存在公开审计告警的旧版 `axios` 与 `lodash.set/unset`。当前接口已限制可写字段、字符串长度和数据库路径，未开放任意 URL 或任意字段路径，但正式发布前仍应再次检查官方 SDK 更新。不要执行审计工具建议的强制降级到旧版 SDK；应在微信官方发布兼容修复后升级并重新跑云环境回归。
