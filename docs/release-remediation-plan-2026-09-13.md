# freshKeeper 发布整改与功能收口方案

> 编制日期：2026-09-13
>
> 仓库基线：`index-ui` / `a893771`
>
> 云环境核查：`cloud1-d0gkh66ce94b1be08`
>
> 输入依据：`docs/code-review-report-2026-09-13.md`、当前仓库源码、微信开发者工具 CLI 返回的云函数清单与已部署代码包
>
> 状态：**待实施；全部发布阻断项关闭前不得发布正式版**

## 1. 最终产品决策

本轮不再保留“以后也许会重新开启”的半成品，按以下边界收口：

1. **快速录入只保留文字录入、最近录入和完整录入。** 语音录入与 OCR/拍照识别从界面、客户端状态、服务契约、云函数 action、依赖、配置、权限、埋点和测试中彻底删除，不再使用功能开关隐藏。
2. **临期提醒统一使用微信小程序一次性订阅消息。** 消息最终出现在微信的“服务通知”中；项目不再实现另一套本地提醒、站内提醒或旧模板消息。
3. **旧提醒交互彻底退出。** 不再有“是否开启提醒”的物品开关、详情页开启/取消按钮、首页提醒快捷操作和客户端 `cancel` action。只保留：默认提前天数、单品提前天数、计算出的提醒时间和微信服务通知任务。
4. **物品保存与提醒解耦。** 物品先可靠入库；符合条件时由用户操作触发微信订阅授权，授权成功再预约一条服务通知。用户拒绝、平台失败或提醒时刻已过，都不能回滚物品保存。
5. **不带占位配置发布。** 模板 ID、模板关键词、云函数运行时、超时、触发器、权限、发布状态、数据库索引和隐私声明必须有可核验结果，不能只在文档中写“之后配置”。
6. **审查报告中的 P0/P1 全部在发布前修复。** P2 按本方案的顺序处理；没有完成的 P2 必须有明确的版本和验收记录，不能继续处于“知道但无人负责”的状态。

“彻底删除旧提醒”不等于删除 `reminderLeadDays` 或 `reminder_jobs`。前者是计算服务通知日期所需的业务字段，后者是防重复发送、记录发送结果所需的云端任务。要删除的是旧交互、旧 action、旧部署代码和旧配置双轨。

## 2. 已核实的当前状态

### 2.1 仓库状态

| 检查项 | 当前结果 | 判定 |
| --- | --- | --- |
| 小程序 AppID | `project.config.json` 已配置 `wxae5abe122a9e9bd5` | 已配置 |
| 云环境 ID | `miniprogram/config/runtime.ts` 已配置 `cloud1-d0gkh66ce94b1be08` | 已配置，但目前只有一个云环境 |
| 语音/OCR 界面 | `QUICK_ENTRY_FEATURES.voice/datePhoto` 为 `false` | 只是隐藏，不是删除 |
| 语音/OCR 客户端代码 | 录音、相机、相册、上传、转写、OCR 状态机全部还在 | 未删除 |
| 语音/OCR 云端代码 | `transcribeVoice`、`recognizeDatePhoto`、`createMediaUpload` 和腾讯 ASR/OCR provider 全部还在 | 未删除 |
| 语音/OCR 依赖 | `tencentcloud-sdk-nodejs-asr`、`tencentcloud-sdk-nodejs-ocr` 仍在锁文件 | 未删除 |
| 服务通知客户端 | 已使用 `wx.requestSubscribeMessage` | 技术方向正确 |
| 服务通知发送端 | 已使用 `cloud.openapi.subscribeMessage.send` | 技术方向正确 |
| 服务通知模板 ID | 客户端和当前 `reminderApi` 都是 `TODO_REPLACE_WITH_REAL_TEMPLATE_ID` | **发布阻断** |
| 服务通知字段 | 当前源码假定 `thing1/time2/thing3/thing4/number5` | 未经平台模板验证 |
| 提醒时间 | 客户端与仓库触发器统一为北京时间 09:30 | 源码一致 |
| 跳转版本 | `dispatchReminders/config.json` 仍为 `developer` | 正式版不合格 |
| 自动清理 | 仓库存在 `cleanupTrash` 和 03:30 触发器配置 | 仅源码存在 |
| 发布检查 | `npm run check` 不检查占位模板、远端函数版本、触发器和发布状态 | 缺失 |

### 2.2 真实云环境状态

通过微信开发者工具 CLI 查询并下载云端代码包后，确认仓库与云端不是同一个版本：

| 项目 | 云端现状 | 目标状态 |
| --- | --- | --- |
| 云环境数量 | 仅发现 `cloud1-d0gkh66ce94b1be08` | 明确它是生产还是开发环境；测试数据和生产数据不得混用 |
| 云函数清单 | `dispatchReminders`、`inventoryApi`、`quickEntryApi`、`reminderApi`、`settingsApi`、`userApi` | 删除废弃 `settingsApi`，补部署缺失的 `cleanupTrash` |
| 云函数运行时 | 查询到的 6 个函数全部为 Node.js 16.13 | 与仓库统一为 Node.js 20 |
| `dispatchReminders` | 云端超时 3 秒；下载代码仍是旧字段环境变量、09:00 配置、`developer` 跳转 | 60 秒、09:30、正式环境为 `formal`、只保留新契约 |
| `reminderApi` | 云端超时 3 秒；下载代码仍有旧 `cancel` action，模板从环境变量读取 | 10 秒；只保留 `arm`；模板契约与客户端一致 |
| `quickEntryApi` | 下载代码仍公开语音/OCR action 和媒体上传 action | 只保留文字解析与能力读取 |
| `userApi` | 下载代码未包含 `getSettings/updateSettings` | 部署当前合并后的设置接口 |
| `inventoryApi` | 下载代码与仓库当前版本一致 | 后续部署本方案修复 |
| `cleanupTrash` | 云端不存在 | 新建、配置 60 秒和每日 03:30 触发器 |

另外，云端旧 `reminderApi` 代码包中已有模板 ID：

```text
jXD8Fb4_ZudDL8FWO3dP4VXcYMWTXjqOaSaM1XBLwh8
```

旧派发代码包记录的关键词契约为：

| 内容 | 关键词 |
| --- | --- |
| 物品名称 | `thing7` |
| 到期日期 | `time2` |
| 剩余天数 | `number5` |
| 当前数量 | `number4` |
| 备注 | `thing3` |

模板 ID 本来就会下发到小程序客户端，不属于密钥。实施时优先在 AppID `wxae5abe122a9e9bd5` 的公众平台模板列表中核对并复用这份已存在的模板，避免无必要地重新申请。若模板已被删除或关键词与上表不一致，必须以公众平台实际模板为准创建/选择新模板，然后一次性同步所有代码与云端任务；禁止猜测关键词编号。

### 2.3 结论

当前状态不能发布。最大风险不是“某一个配置没填”，而是**仓库、已部署云函数和微信平台模板存在三套不同事实**：

- 当前客户端拿到的是占位模板 ID，无法正常申请订阅；
- 云端仍运行旧提醒接口和旧派发字段；
- 定时函数的真实运行参数没有随仓库 `config.json` 更新；
- 当前客户端调用 `userApi.getSettings`，已部署 `userApi` 却没有该 action；
- 自动清理函数没有部署，回收站不会按设计自动清理。

因此不能只替换一个模板 ID，也不能只“重新上传代码”。必须按第 8 节的顺序做一次受控收口。

## 3. 目标提醒链路

微信“服务通知”在本项目中的准确实现是“小程序一次性订阅消息”，不存在另一套需要改接的“服务通知 API”。目标链路如下：

```text
用户点击保存物品
  → 物品先成功入库
  → wx.requestSubscribeMessage 申请本次消息额度
  → 用户同意后调用 reminderApi.arm
  → reminder_jobs 记录 remindDate 与发送状态
  → 每日 09:30 dispatchReminders 领取当天任务
  → cloud.openapi.subscribeMessage.send
  → 微信“服务通知”展示消息
  → 点击消息进入 pages/item-detail/index
```

产品规则固定为：

- 提醒日期 = 到期日期 − 单品提前天数；推送时刻为北京时间 09:30。
- 一次授权只对应一次模板消息发送额度，不能把它描述成“永久开启”。
- 快速录入多件物品时逐件申请；用户拒绝或授权调用失败后停止继续弹出，但已经保存的物品不受影响。
- 提醒日早于今天不申请授权；提醒日为今天但 09:30 已过，由云端返回 `missed`，不落新任务、不补发。
- 已用完、移入回收站或永久删除时，待发送任务由服务端取消；界面不提供单独“取消提醒”。
- 发送结果不确定时进入 `unknown`，不自动重发，避免一条授权额度产生重复通知。

## 4. 语音与 OCR 的彻底删除方案

### 4.1 小程序端

| 文件 | 必须删除/调整的内容 |
| --- | --- |
| `miniprogram/config/runtime.ts` | 删除 `voice`、`datePhoto` 开关及相关说明；不允许继续以 `false` 保留 |
| `miniprogram/pages/quick-entry/index.wxml` | 删除麦克风按钮、拍日期按钮、相机面板、照片预览、录音/转写提示、草稿编辑器拍照入口；把“说出或输入”改成“输入” |
| `miniprogram/pages/quick-entry/index.ts` | 删除 recorder 单例与生命周期、语音状态机、相机/相册/OCR 状态机、临时媒体清理、相关埋点和 `voice/date_photo` 分支 |
| `miniprogram/pages/quick-entry/index.wxss` | 删除录音按钮、麦克风图标、日期扫描图标、相机、照片预览和录音动画样式 |
| `miniprogram/services/quick-entry-service.ts` | 删除 `transcribeVoice`、`recognizeDatePhoto`、`uploadQuickEntryMedia`、`removeMedia` |
| `miniprogram/types/quick-entry.ts` | `QuickEntrySource` 删除 `voice/date_photo`；删除 `DatePhotoResult`、OCR 专属错误码和照片 evidence；日期候选保留文字解析需要的部分 |
| `miniprogram/domain/quick-entry.ts` | 删除拍照来源的特殊分支；保留文字解析中的多日期候选与冲突确认能力 |

清理后快速录入页面不再申请麦克风、相机或相册权限，也不再创建任何音频/图片临时文件。

### 4.2 云函数端

| 文件 | 必须删除/调整的内容 |
| --- | --- |
| `cloudfunctions/quickEntryApi/index.js` | 删除 `transcribeVoice`、`recognizeDatePhoto`、`createMediaUpload`、媒体下载/删除逻辑；handlers 只保留文字相关 action |
| `cloudfunctions/quickEntryApi/provider.js` | 收成纯文字 provider，不再识别 `STT/OCR` 类型，不再加载腾讯 provider |
| `cloudfunctions/quickEntryApi/tencent-provider.js` | 整个文件删除 |
| `cloudfunctions/quickEntryApi/validation.js` | 删除 `validateMedia`、`mediaOwnerPrefix`，只保留文字与身份字段校验 |
| `cloudfunctions/quickEntryApi/date-facts.js` | 删除 `normalizePhotoResult` 和照片专属格式；保留文字 provider 结果校验 |
| `cloudfunctions/quickEntryApi/package.json` / lock | 删除腾讯 ASR/OCR SDK 并重新生成锁文件 |

云端部署后，旧客户端若继续调用语音/OCR action，统一得到 `INVALID_ACTION`，不会再上传或处理媒体。这是预期的硬下线行为。

### 4.3 外部资源与隐私收尾

1. 删除 `quickEntryApi` 云端的所有 `QUICK_ENTRY_STT_*`、`QUICK_ENTRY_OCR_*`、`QUICK_ENTRY_TENCENT_*` 环境变量。
2. 若腾讯云密钥只服务于本项目的 ASR/OCR，撤销该密钥并关闭对应服务；若密钥被其他项目共用，只删除本函数绑定，不能误删共用密钥。
3. 新版本上线并确认不再产生临时媒体后，清理云存储 `quick-entry/` 前缀遗留对象；执行前先导出对象清单和总字节数。
4. 微信公众平台“用户隐私保护指引”中删除录音、相机和相册用途声明；仍需保留“物品文字用于结构化解析”，以及启用 AI 封面时“物品名称用于生成封面”的说明。
5. 删除 `voice_permission_result`、`voice_transcribe_result`、`date_photo_result` 等埋点定义和后台事件配置。
6. 删除 OCR/媒体归属/语音与照片 UI 测试；新增反向契约测试，保证生产源码不再出现 `scope.record`、`getRecorderManager`、`<camera>`、`chooseMedia`、`transcribeVoice`、`recognizeDatePhoto`、腾讯 ASR/OCR SDK。

“彻底删除”的验收范围是生产源码、云端部署、依赖、配置、权限、存储和隐私声明。审查报告和本方案作为历史记录可以继续出现“语音/OCR”字样。

## 5. 微信服务通知与旧提醒收口方案

### 5.1 模板契约只保留一份事实

优先复用云端已有模板 ID 和已批准关键词，原因是它最可能已经获得当前 AppID 的平台批准，也能保留已有订阅额度和有效待发任务。实施步骤：

1. 在公众平台确认模板 ID `jXD8...Lwh8` 仍位于当前小程序的“一次性订阅消息”模板列表中。
2. 核对 5 个关键词的名称、类型和编号与第 2.2 节一致。
3. 确认无误后同步：
   - `miniprogram/config/runtime.ts` 的 `REMINDER_TEMPLATE_ID`；
   - `cloudfunctions/reminderApi/index.js` 的 `REMINDER_TEMPLATE_ID`；
   - `cloudfunctions/dispatchReminders/template.js` 的字段映射与内容生成。
4. `scripts/validate-project.mjs` 新增硬校验：禁止 `TODO_`，校验两个模板 ID 完全一致，校验字段集合没有示例值，校验 09:30 与 cron 一致。

不再使用 `REMINDER_TEMPLATE_ID` 和 `REMINDER_*_FIELD` 云端环境变量覆盖代码，因为现有部署已经证明这会制造长期漂移。模板 ID 不是密钥，可以受版本控制；真正的密钥仍不得提交。

### 5.2 删除旧提醒模型

仓库当前界面已经基本去掉旧开关，但云端仍在运行旧代码。需要同时完成：

- 部署当前 `reminderApi`，彻底移除远端 `cancel` action；
- 删除云端 `REMINDER_TEMPLATE_ID` 与 5 个 `REMINDER_*_FIELD` 旧环境变量；
- 确认首页、详情页、表单和“我的”中不存在开启/取消提醒开关和快捷菜单；
- 保留 `cancelled` 任务状态，仅供“物品已用完/删除、任务过期、发送前物品变化”等服务端状态使用，它不是旧用户功能；
- 旧客户端调用 `cancel` 返回 `INVALID_ACTION`，服务端日志可观察但不恢复旧 action；
- 迁移前暂停派发触发器。若复用同一模板 ID，重新计算并保留仍有效的 `scheduled` 任务；无效或已错过任务落 `cancelled` 和明确原因。若必须换模板 ID，旧授权不能迁移到新模板，所有旧 `scheduled` 任务必须取消，不能擅自改 ID 后发送。

### 5.3 修正文案与状态判断

当前界面仍有两处过度承诺：

- “我的”页把订阅主开关打开等同于“已开启，到期前会自动推送”；
- 详情页在没有 `scheduled` 任务时也显示“到点自动推送”。

一次性订阅消息的剩余额度无法仅靠 `wx.getSetting` 准确判断。目标文案必须改成事实状态：

| 条件 | 展示文案 |
| --- | --- |
| 微信订阅总开关关闭 | 微信服务通知总开关已关闭 |
| 当前模板被拒绝/封禁 | 本小程序的服务通知已关闭 |
| 微信设置允许，但无法确认本次额度 | 保存物品时会申请本次微信服务通知 |
| job 为 `scheduled` | 已预约，将于指定时间推送 |
| job 为 `sending` | 正在推送 |
| job 为 `sent` | 已推送 |
| job 为 `failed` | 推送失败 |
| job 为 `unknown` | 发送结果待确认，不会自动重发 |
| job 为空或 `cancelled` | 本次未预约/已停止 |
| 提醒时刻已过 | 已错过，不补发 |

从微信设置页返回时必须单独刷新订阅设置；不能被当前 60 秒服务端设置缓存挡住。

### 5.4 派发可靠性

修复审查报告 P1-06 时采用“不重复发送优先”的状态机：

- `processJob` 返回 `jobIdHash/stage/result`，不记录明文 OPENID 或物品名；
- claim 前异常：尽力把仍为 `scheduled` 的任务置为 `failed`；
- claim 后异常：把仍为 `sending` 的任务置为 `unknown`；
- 每次定时任务先把超过 15 分钟的 `sending` 任务对账为 `unknown`，绝不自动重发；
- 增加 `status ASC, updatedAt ASC` 索引支持僵尸任务查询；
- 汇总日志至少包含 due、claimed、sent、failed、unknown、cancelled、staleSending 数量；
- 对数据库读取失败、claim 失败、OpenAPI 明确拒绝、OpenAPI 超时、成功后状态写入失败分别做故障注入测试。

## 6. 代码审查问题处理矩阵

| 编号 | 处理方案 | 完成标准 | 阶段 |
| --- | --- | --- | --- |
| P0-01 提醒配置冲突 | 按第 5 节统一真实模板、字段、09:30、`formal`、OpenAPI 权限与真机闭环；加入发布检查 | 无占位值；体验版和正式版各成功收到一条并正确跳转 | 发布前 |
| P1-01 概览缓存不失效 | 把缓存和失效入口移到共享小模块；所有库存 mutation 成功后由 `inventory-service` 统一失效；注销清内存与持久化缓存 | 新增、编辑、用完、删除、恢复、批量、注销后数字立即正确 | 发布前 |
| P1-02 导出提醒字段过期 | 导出改为 `itemId/remindDate/acceptedAt/sendAttemptedAt/sentAt/status/failureCode`，schema 升为 2；用真实 arm 结构做契约测试 | 导出不丢提醒日期和物品关联，不含 `ownerId/templateId` | 发布前 |
| P1-03 库存游标漏项 | 游标升级为 v3，最后排序键增加 `_id`；所有查询和复合索引同步增加唯一兜底排序 | 60 条相同到期日和时间戳的数据跨页无重复、无遗漏 | 发布前 |
| P1-04 封面生命周期 | 先把 `COVER_IMAGE_ENABLED` 改为显式 `true` 才开启；每个物品拥有独立 fileID，同名复用改为复制文件而不是共享引用；永久删除/自动清理/注销先收集再删文件；遗留共享文件按引用数兼容处理 | 删除后不再新增孤儿文件，共享旧封面不被误删 | 发布前 |
| P1-05 AI 成本保护 | 文字解析与封面分别使用持久化“用户+日期”计数，并增加全局日上限；开关默认 fail-closed；上线前可先保持封面关闭 | 冷启动和多实例不能绕过限额，达到全局水位可立即熔断 | 发布前 |
| P1-06 派发异常卡死 | 按第 5.4 节落失败阶段、`unknown` 和僵尸对账 | 任意阶段异常后任务都进入可解释状态，不长期停在 `sending` | 发布前 |
| P2-01 概览卡与筛选冲突 | 点击概览卡时清空搜索词和分类，保留排序 | 卡片数字与点击后的列表口径一致 | 发布前顺手修复 |
| P2-02 反馈假成功 | MVP 直接删除意见反馈入口、弹窗、本地 key 和“已收到”提示，不新增暂时无人处理的后台 | 页面和本地存储不再出现假反馈能力 | 发布前顺手修复 |
| P2-03 存放位置无限长 | 服务端按 Unicode 码点限制 80 字；前端 `maxlength=80`；AI 结果同上限 | 异常客户端无法写入超长字段 | 发布前顺手修复 |
| P2-04 批量页无限加载 | 复用 `MAX_LIST_ITEMS=200`，达到上限停止并提示缩小筛选；暂不做服务端大任务 | 大账户进入批量页不会无限请求和渲染 | 第二批 |
| P2-05 最近录入过早截断 | 单次取 `min(limit × 2, 200)` 后去重，仍不足就返回现有结果，不恢复多轮深翻页 | 高重复数据下能返回更多唯一档案且只发一次查询 | 第二批 |
| P2-06 历史/回收站偏移分页 | 改为 `completedAt + _id` 的稳定键集游标并带查询签名 | 翻页期间插入/恢复/删除不导致边界重复或漏项 | 第二批 |
| P2-07 数量调整走完整保存 | 新增带 `version` 的 `setQuantity` 条件更新；删除无调用的 `decrement`；数量变化不再失效概览 | 一次轻量更新完成，冲突仍返回 `CONFLICT` | 第二批 |
| P2-08 上游依赖告警 | 删除 ASR/OCR SDK 后重跑审计；持续跟踪 `wx-server-sdk` 官方更新，不执行强制降级 | 审计结果有日期、上游来源和处置记录 | 持续 |

补充修复当前报告未单列、但本次实查发现的问题：

- 部署当前 `userApi` 后再删除旧 `settingsApi`，否则提醒默认天数读写会继续失败；
- 部署缺失的 `cleanupTrash`，否则 30 天自动清理只是界面承诺；
- 所有云函数运行时统一到 Node.js 20，实际超时值与仓库一致；
- 修复“从微信设置返回不刷新”和“无 job 却显示自动推送”的误导状态；
- 加入仓库—云端版本核对，不再用本地文件存在来推断线上已生效。

## 7. 配置目标清单

### 7.1 云函数

| 云函数 | 运行时 | 超时 | 环境变量 | 触发/权限 |
| --- | ---: | ---: | --- | --- |
| `inventoryApi` | Node.js 20 | 60 秒 | `COVER_IMAGE_ENABLED=false`，完成额度与生命周期后再显式改 `true`；另设封面用户/全局日限额 | 已登录用户可调用 |
| `quickEntryApi` | Node.js 20 | 60 秒 | 保留文字 AI 开关、模型、超时、用户/全局日限额；删除全部 STT/OCR/Tencent 变量 | 已登录用户可调用 |
| `reminderApi` | Node.js 20 | 10 秒 | 无模板环境变量 | 已登录用户可调用 |
| `userApi` | Node.js 20 | 60 秒 | 无 | 已登录用户可调用，必须包含 settings actions |
| `dispatchReminders` | Node.js 20 | 60 秒 | 仅保留 `MINIPROGRAM_STATE`；正式环境为 `formal` | 仅定时触发；允许云调用 `subscribeMessage.send`；每日 09:30，Asia/Shanghai |
| `cleanupTrash` | Node.js 20 | 60 秒 | 无 | 仅定时触发；每日 03:30，Asia/Shanghai |

`config.json` 只能作为期望值，不能作为线上已生效的证据。现有环境中已验证“更新部署只替换代码，未同步运行时/超时”等配置；实施后必须再次用 CLI/控制台读取真实值并记录。

### 7.2 数据库与存储

至少需要这些集合，客户端权限统一为不可直接读写：

- `inventory_items`
- `user_settings`
- `reminder_jobs`
- `users`
- `ai_usage_daily`（新增，AI 文字解析与封面持久额度）

现有索引必须在代码改完后按最终查询重新核对，重点包括：

- 库存列表相关索引的最后排序键增加 `_id`；
- 历史/回收站增加 `ownerId + inventoryStatus + completedAt + _id`；
- 提醒派发保留 `status + remindDate`，增加 `status + updatedAt`；
- 最近录入保留 `ownerId + inventoryStatus + updatedAt`；
- 自动清理保留 `inventoryStatus + purgeAfter`；
- 封面同名查找在迁移期保留 `ownerId + inventoryStatus + name`。

存储侧执行两类清理：

1. 语音/OCR 下线后一次性清理 `quick-entry/` 临时媒体；
2. 封面改为单物品独占 fileID，并补永久删除、自动清理、账号注销的删除闭环；对历史共享 fileID 先查引用，不能直接删。

### 7.3 微信公众平台

需要核验并留截图/日期的项目：

- 当前 AppID 下的一次性订阅消息模板、模板 ID、5 个关键词及其类型；
- 服务类目是否允许使用所选模板；
- 用户隐私保护指引：移除录音/相机/相册，保留文字解析、AI 封面（若启用）、昵称头像、导出和注销路径；
- ICP 备案与所选服务类目资质；
- 体验版、正式版的消息跳转页面均存在于对应版本 `app.json`。

公众平台模板审批、主体认证和 ICP 状态不能从仓库或开发者工具 CLI 伪造。实施时应直接使用当前已登录的管理员账号处理；只有遇到微信要求主体管理员扫码/确认时，才需要账号持有人完成该平台动作。

## 8. 实施与部署顺序

顺序不能颠倒，否则可能由旧定时任务发送旧字段消息，或由新客户端调用旧云函数。

### 第一批：功能硬删除和发布阻断修复

1. 暂停云端 `daily-reminder-dispatch` 触发器，记录待发任务各状态数量。
2. 完成语音/OCR 全链路删除，更新依赖与测试。
3. 收敛真实订阅模板契约，修复提醒状态文案、派发异常状态和导出 schema。
4. 修复概览缓存、唯一游标、存放位置上限、反馈假成功、封面开关/额度/生命周期。
5. 给发布检查加入模板、字段、时间、状态、废弃代码和云函数清单校验。
6. 执行 `npm run check`、依赖审计和新增专项测试。

### 第二批：云端对齐

1. 先部署 `userApi`、`inventoryApi`、`quickEntryApi`、`reminderApi`，使用云端安装依赖。
2. 在控制台把 4 个 API 函数的运行时、超时和环境变量改为第 7.1 节目标值。
3. 验证当前客户端的设置读写、文字快速录入、库存写入和预约任务都命中新 action。
4. 删除云端废弃 `settingsApi`。
5. 新建并部署 `cleanupTrash`，配置 03:30 触发器和仅定时触发权限。
6. 部署 `dispatchReminders`，配置 09:30、Asia/Shanghai、60 秒、OpenAPI 权限和正确的 `MINIPROGRAM_STATE`。
7. 处理旧待发任务：同模板则迁移有效任务，不同模板则取消旧任务并记录原因。
8. 体验版真机闭环通过后恢复提醒触发器；正式发布前把生产环境跳转状态改为 `formal`。

### 第三批：P2 稳定性与性能

1. 批量页 200 条上限；
2. 最近录入扩大候选后去重；
3. 历史/回收站稳定游标；
4. 数量轻量更新；
5. 覆盖率报告、云函数依赖审计和部署记录固化。

如果当前唯一云环境含开发测试数据，先新建独立生产环境并完整复制“集合结构、权限、索引、函数配置”，再上传正式版；如果它已被明确指定为生产环境，则新建开发环境，把后续测试从生产数据中移走。不能继续让一个未定用途的环境同时承担开发和生产。

## 9. 验收标准

### 9.1 静态与自动化

- `npm run check` 全部通过。
- 生产源码和云函数依赖中不再出现语音/OCR 接口、状态、权限、SDK 或环境变量。
- `REMINDER_TEMPLATE_ID` 无 `TODO_`，客户端与云端完全一致。
- 09:30 常量与 7 段 cron 一致；正式环境 `MINIPROGRAM_STATE=formal`。
- 60 条相同日期、相同时间戳的库存跨页无重复、无遗漏。
- 导出 schema v2 与 `reminderApi.arm` 真实写入结构一致。
- 所有库存写路径和注销路径都有概览缓存失效测试。
- 依赖审计中不再包含腾讯 ASR/OCR SDK 引入的告警；微信 SDK 上游告警单独记录，不强制降级。

### 9.2 云端配置

- 云函数清单恰好为 6 个目标函数，不存在 `settingsApi`，存在 `cleanupTrash`。
- 6 个函数真实运行时均为 Node.js 20，真实超时和第 7.1 节一致。
- `dispatchReminders` 和 `cleanupTrash` 不能被小程序端直接调用。
- 数据库集合权限、索引状态均有控制台截图或导出记录。
- 云端代码包与当前提交一致，不再出现旧 `cancel`、语音/OCR action 和旧提醒字段环境变量。
- 临时媒体不再增长；永久删除和自动清理后封面文件同步减少且不误删被引用文件。

### 9.3 真机服务通知闭环

至少用两个微信账号在体验版完成：

1. 同意授权 → 任务变为 `scheduled` → 09:30 收到服务通知 → 点击进入正确物品详情；
2. 拒绝授权 → 物品仍保存，不产生假 `scheduled` 任务；
3. 同一 job 重复触发最多发送一次；
4. 保存多件物品时授权弹窗行为符合一次性订阅限制，拒绝后不继续连弹；
5. 编辑到期日会正确改期，标记已用完/删除会停止待发任务；
6. 发送超时或状态更新失败后进入 `unknown`，不会自动重发；
7. 服务通知点击路径在体验版使用 `trial`、正式版使用 `formal`；
8. 从微信设置返回后，页面立即显示最新的服务通知通道状态。

## 10. 发布门槛与回滚

以下任一项未完成都不得发布正式版：

- 模板/字段未从公众平台核实；
- 云端仍有旧提醒/语音/OCR 代码或占位模板；
- 提醒定时任务仍是 3 秒、09:00 或 `developer`；
- `cleanupTrash` 未部署；
- `userApi` 未包含 settings actions；
- 体验版没有收到真实服务通知并完成跳转；
- AI 封面仍默认开启且没有可靠额度/文件生命周期保护。

若提醒发布后异常，第一动作是暂停 `daily-reminder-dispatch`，保留任务数据和日志排查；不要重置数据库，也不要把 `unknown` 改回 `scheduled`。代码可以回滚到上一个稳定提交，但语音/OCR 不作为回滚项重新启用。

## 11. 官方能力参考

- [小程序订阅消息](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html)
- [`wx.requestSubscribeMessage`](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)
- [`subscribeMessage.send`](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-message-management/subscribe-message/sendMessage.html)
- [云函数定时触发器](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/functions/triggers.html)

本方案是当前版本唯一的整改和部署依据。历史审查报告保留作证据，但其中已经删除的旧设计文档路径、09:00 说明和环境变量模板契约不再作为实施口径。
