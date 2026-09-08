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
| `inventory_items` | `ownerId ASC, inventoryStatus ASC, category ASC, completedAt DESC` |
| `inventory_items` | `ownerId ASC, inventoryStatus ASC, updatedAt DESC` |
| `inventory_items` | `inventoryStatus ASC, purgeAfter ASC` |
| `reminder_jobs` | `status ASC, remindDate ASC` |
| `reminder_jobs` | `ownerId ASC, status ASC` |

名称包含搜索使用当前用户范围内的正则匹配；首版不建立全文索引。

## 3. 部署云函数

在开发者工具中分别对以下目录执行“上传并部署：云端安装依赖”：

- `inventoryApi`
- `settingsApi`
- `reminderApi`
- `dispatchReminders`
- `cleanupTrash`
- `quickEntryApi`

编译或上传小程序不会同步更新云函数。只要 `cloudfunctions/` 有改动，发布对应客户端前必须单独部署相关函数；否则新客户端仍会调用旧接口。也可以使用开发者工具 CLI：

```bash
cli cloud functions deploy --env <环境ID> --names <函数名> --project <项目目录> --remote-npm-install
```

部署 `settingsApi` 后，应在“我的 → 提醒设置”中修改默认提醒天数并保存一次，确认云端只校验提醒天数；保存时会同时清除当前用户历史设置中的废弃默认存放位置字段。

运行时固定为 Node.js 20。函数调用权限配置为：已登录用户可调用 `inventoryApi`、`settingsApi`、`reminderApi` 和 `quickEntryApi`；`dispatchReminders` 和 `cleanupTrash` 禁止小程序端调用，只允许定时触发。

### 3.1 快速录入识别服务

`quickEntryApi` 通过 HTTPS JSON 适配器调用识别服务。未配置的语音和拍日期能力仍保留按钮，不申请权限或启动识别：语音点击或按住提示“暂时未接入，敬请期待”，拍日期提示“拍照识别未开通，请手动选日期”。按需配置：

当前版本文字快录内置确定性解析器，无需第三方密钥。客户端和云函数使用同一实现，`npm run check:project` 会检查两份文件一致；修改后执行 `node scripts/sync-quick-parser.mjs --write`。

语音和日期照片已增加腾讯云官方 SDK 接入，无需另建代理服务。在腾讯云账号开通“一句话识别”和“通用文字识别（高精度版）”后，给 **quickEntryApi 的云端环境变量**配置：

| 变量 | 用途 |
| --- | --- |
| `QUICK_ENTRY_TENCENT_SECRET_ID` | 仅具有 ASR/OCR 所需权限的账号 SecretId |
| `QUICK_ENTRY_TENCENT_SECRET_KEY` | 对应 SecretKey，禁止写到小程序或提交 Git |
| `QUICK_ENTRY_TENCENT_REGION` | 可选，默认 `ap-guangzhou` |

已有自定义 HTTPS 服务时，以下 ENDPOINT 配置优先于腾讯云适配器。STT 不再依赖外部 TEXT 服务开通。能力发现仅证明配置存在，发布前仍需实际调用验证服务权限、余额和输出。

参考官方接口：[一句话识别](https://cloud.tencent.com/document/api/1093/35646)、[通用文字识别（高精度版）](https://cloud.tencent.com/document/product/866/34937)。

| 变量 | 用途 |
| --- | --- |
| `QUICK_ENTRY_TEXT_ENDPOINT` / `QUICK_ENTRY_TEXT_API_KEY` / `QUICK_ENTRY_TEXT_MODEL` | 文字结构化解析 |
| `QUICK_ENTRY_STT_ENDPOINT` / `QUICK_ENTRY_STT_API_KEY` / `QUICK_ENTRY_STT_MODEL` | 语音转写 |
| `QUICK_ENTRY_OCR_ENDPOINT` / `QUICK_ENTRY_OCR_API_KEY` / `QUICK_ENTRY_OCR_MODEL` | 日期照片识别 |
| `QUICK_ENTRY_TIMEOUT_MS` | 外部请求超时，默认 8000 毫秒 |

适配器统一使用 `Authorization: Bearer <API_KEY>` 和 JSON 请求。文字接口接收 `text/serverToday`，返回技术方案定义的 `items[].dateFacts`；语音、图片接口接收 `mediaType/mediaBase64`，分别返回 `{ text }` 和 `{ candidates }` 或 `{ dateFacts }`。上线前必须完成服务商隐私评审、媒体删除和真机权限验收。

日期照片响应还支持 `shelfLifeValue/shelfLifeUnit/sourceText`；`dateFacts` 中的 `shelf_life` 也会被保留。腾讯云 OCR 仅提取日期及保质期，不从照片推测商品名称。低置信度结果保持待补充。

### 3.2 临时媒体和微信后台配置

- 客户端先调用 `createMediaUpload` 获取当前用户专属临时路径，存储目录为 `quick-entry/<用户标识的哈希>/<audio|image>/`。云函数在下载、识别、删除前核对归属；不接受其他用户的路径。
- 存储安全规则须允许用户上传、删除自己的文件，并禁止其他用户读取。云函数处理完成在 `finally` 删除；客户端在成功或失败后再尝试删除。为 `quick-entry/` 配置最短可用生命周期清理，兜底网络中断、云函数硬超时或微信进程终止后的孤立文件；不要将其当成长期商品图库。
- 微信公众平台“用户隐私保护指引”声明本次语音转写、日期照片识别的数据用途、腾讯云处理方和临时处理范围，并同步审核材料。代码不能代替后台提交。
- 麦克风使用 `wx.authorize({scope:'scope.record'})`，相机由用户点击后创建 `camera`，相册通过单张 `chooseMedia`。`app.json.permission` 不支持 `scope.record`/`scope.camera` 声明，不能用无效配置代替后台隐私指引。
- 真机逐项检查首次授权、拒绝后改用文字/手动、移出取消录音、30 秒停止、相机/相册拒绝、弱网重试和安全区。两个账号分别验证近期列表和媒体归属。

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

`cleanupTrash/config.json` 声明每日 03:30 触发器。首次运行会把旧版 `discarded` 数据迁移为 `deleted`，并从迁移时重新给予完整 30 天保留期；后续仅彻底删除 `purgeAfter` 已到的 `deleted` 数据。部署后需确认触发器使用 `Asia/Shanghai` 时区，并确认该函数不能被客户端调用。

## 4. 发布前验证

自动检查：

```bash
npm run check
```

云环境至少验证：

- A 用户不能查看、修改或删除 B 用户的物品、历史和提醒任务。
- 同版本并发修改只有一次成功，另一请求返回冲突。
- 修改到期日会更新未发送任务；用完和删除会取消待发任务。
- 删除后记录进入回收站；重新编辑并入库后恢复为有效库存，旧提醒记录被清除。
- 手动触发 `cleanupTrash`，验证旧 `discarded` 数据只迁移不删除；已满 30 天的 `deleted` 数据被彻底删除，未满 30 天和 `used_up` 数据保留。
- 临时改为每分钟触发后连续运行两次，同一任务最多收到一条消息；验证完恢复每日 09:00。
- 函数日志不出现完整物品名称、OPENID 或微信订阅原始报文。

真机必须完成：

- 两种日期录入各一次，覆盖新增、查看、编辑和二次确认删除。
- 数量按任意正整数减少、减量等于当前数量时确认转为已用完、超量时阻止提交。
- 首页临期、库存当前筛选和回收站三个批量入口均验证多选、全选、取消与二次确认删除。
- 首页四张概览卡分别进入正确的库存状态，且数字满足“物品总数 = 已过期 + 临期 + 状态良好”。
- 库存页搜索、种类、状态的两两与三项组合筛选，清空后恢复全部在库物品。
- 选择“已用完”时按完成时间倒序展示；删除数据只出现在“我的 → 回收站”。
- 回收站详情可重新编辑并入库，单条与批量彻底删除均不可恢复。
- 拒绝订阅后继续新增和编辑；接受后收到一次消息并正确进入详情。
- 杀掉微信进程后重新进入，确认数据仍存在。
- 使用两个微信账号确认数据隔离。

开发者工具模拟器不能替代订阅弹窗、消息触达、跳转、真实触控和安全区验收。

## 5. 依赖安全备注

截至 2026-09-06，根工程依赖审计为 0 项；最新稳定版 `wx-server-sdk@4.0.2` 的上游仍固定了存在公开审计告警的旧版 `axios` 与 `lodash.set/unset`。当前接口已限制可写字段、字符串长度和数据库路径，未开放任意 URL 或任意字段路径，但正式发布前仍应再次检查官方 SDK 更新。不要执行审计工具建议的强制降级到旧版 SDK；应在微信官方发布兼容修复后升级并重新跑云环境回归。
