# 微信到期提醒始终发送失败：根因调查与闭环修复方案

> 调查日期：2026-09-29；环境：`cloud1-d0gkh66ce94b1be08`；本轮只读调查，未改业务代码、云配置或线上数据。2026-09-29 补入用户提供的当日失败任务和完整错误文本。

## 1. 结论与证据边界

用户在物品详情看到的「微信服务通知发送失败」，不是客户端发送请求当场报错。详情页只把 `reminder_jobs.status === 'failed'` 翻译成这句固定文案（`miniprogram/pages/item-detail/index.ts:65-69`）；`inventoryApi.get` 只把任务 `status` 返回给页面，不返回 `failureCode` / `failureReason`（`cloudfunctions/inventoryApi/index.js:365-376`）。仅凭页面文案无法定位原因；**用户随后提供了这次失败任务的完整错误，已把本次故障锁定在微信云调用票据鉴权层**。

### 本次失败任务：已定案的故障层

用户提供的 2026-09-29 新增物品（文档中隐去 openid 与完整物品 ID）：`remindDate=2026-09-29`，`acceptedAt=12:51:57`，`sendAttemptedAt=16:00:08`，`updatedAt=16:00:09`，`status=failed`，`sentAt=null`。完整错误为：

```text
failureCode: -501007
failureReason: 微信平台明确返回发送失败: openapi.subscribeMessage.send:fail -501007 invalid parameters. Invalid wxCloudApiToken
```

这证明**今天的定时派发确实触发、任务日期和物品资格校验已通过、任务已被领取，代码运行到 `cloud.openapi.subscribeMessage.send` 才失败**；不是“没到提醒时间”“云函数没部署”“数据库读取失败”。`-501007 / Invalid wxCloudApiToken` 是云调用链路的鉴权失败，发生在正常微信订阅消息业务错误码（例如额度 `43101`、模板字段 `47003`）之前。`failureReason` 开头的「微信平台明确返回发送失败」只是项目代码拼接的通用前缀（`dispatchReminders/index.js:188-193`），**不表示微信订阅消息接口已实际处理该消息**。腾讯云[云调用鉴权说明](https://docs.cloudbase.net/error-code/INVALID_WX_ACCESS_TOKEN)和[票据 FAQ](https://docs.cloudbase.net/faq/knowledge/missing-wxcloudapitoken-error)均指向调用来源/票据问题：普通云端来源不具备有效微信云调用票据，微信开发者工具配置的定时触发器是允许的例外。

**已知根因层**：16:00 领取该任务的函数调用没有可用的 `wxCloudApiToken`。**尚待区分的配置子原因**：它究竟来自普通 CloudBase/SCF 定时触发器，还是微信定时触发器虽存在但票据失效/环境绑定错误；若两种入口同时调用，是否普通入口先抢到任务。需要该整点的调用来源和两类触发器回读才能确认，不能从一条数据库记录猜定。`acceptedAt` 是 `arm` 写库时间，不能单凭此字段证明微信侧剩余额度，但本次错误已在额度校验前出现。

本轮从微信开发者工具 CLI **只读下载**云环境中的 `reminderApi` 与 `dispatchReminders`：其 `index.js` 与当前仓库逐字 diff 无差异，派发的 `template.js`、两个 `config.json` 也无差异；两函数线上状态为 Active，超时分别是 10/60 秒，运行时是 Nodejs20.19。这排除了“这两个函数的当前代码仍是旧版”这一猜测，**不等于**触发器、权限、环境变量、正式版小程序代码、真实数据库任务均已核对。下载的 `config.json` 是部署包内容，不能代替云端触发器回读。

除本次已锁定的票据故障外，代码还有三处**独立的产品/架构缺陷**。它们解释了为什么此前多次修改后问题仍难定位或难恢复，但**不是这条 `-501007` 的直接返回原因**：

1. **状态把多个故障混成一句话**：派发在调用微信前的数据库读取/领取异常，也会把任务写成 `failed`（`cloudfunctions/dispatchReminders/index.js:166-177, 273-286`）；页面不显示失败阶段和原因。此前改模板、改时间、改授权都可能没有碰到真正的失败点。
2. **一次授权可被错误复用于多条任务**：快速录入在一次点击中申请一次一次性订阅，却对全部成功保存的提醒目标逐条 `arm`，每条都写 `scheduled`（`miniprogram/pages/quick-entry/index.ts:658-703, 737-775`）。在没有额外可用订阅额度的前提下，多余任务发送时会得到 `43101`。这是代码可直接证明的确定性缺陷；是否正是用户当前这条失败任务的原因，要看其录入来源和 `failureCode`。
3. **失败没有自愈闭环**：微信明确拒绝、派发前异常都落为 `failed`，定时器只查询 `scheduled`，不会再处理该任务（`dispatchReminders/index.js:256-286, 424-433`）。详情页虽然有「开启提醒」按钮，但它要求提醒时间尚未过去（`miniprogram/pages/item-detail/index.ts:55-61`）；自然派发在 16:00 后失败时，按钮通常已经消失。已过提醒时刻的任务无法从现有界面补发。

**尚缺的配置子原因证据**：16:00 同一时刻 `dispatchReminders` 的调用日志/触发来源，普通触发器与微信触发器的真实启用状态、cron、环境和版本。获取前应保留原任务，不要先手工改库，以免覆盖现场。一次无效的 CLI 只读查询触发了登录授权页；本轮已停止等待，未登录或读取该配置。

## 2. 现有链路和“时间设置”的真实含义

```text
保存物品的 tap
  ├─ 同步调用 wx.requestSubscribeMessage（仅一次性订阅）
  └─ inventoryApi.save 成功后，若 accept → reminderApi.arm
       └─ reminder_jobs：_id = itemId；status = scheduled；remindDate = 到期日 - 提前天数
            └─ 每小时触发 dispatchReminders；仅在北京时间提醒日 16:00 后处理
                 ├─ 校验物品仍在库、到期日和提前天数仍吻合
                 ├─ scheduled → sending，记录 sendAttemptedAt
                 ├─ cloud.openapi.subscribeMessage.send
                 └─ sent / failed / unknown / cancelled
                      └─ inventoryApi.get 仅带 status → 详情页固定文案
```

`miniprogram/domain/reminder-time.ts`、`reminderApi/index.js`、`dispatchReminders/index.js` 当前都约定北京时间 16:00。设置「提前 N 天」只是计算提醒日期；**它不会自动完成微信订阅授权，也不是微信平台的原生定时消息**。`reminderApi.arm` 对当天 16:00 已过的提醒返回 `missed`，不创建任务（`reminderApi/index.js:103-116, 155-160`）。派发函数也只认提醒日当天，隔天将遗留任务取消而不补发（`dispatchReminders/index.js:202-206`）。

历史排查文档记载过三类不同事故：授权被放在 `await` 之后而触发微信手势限制；客户端 16:00 与云端旧 09:30 不一致；云端普通触发器仍停留在旧 cron。上述都是**当时的事故记录**，不能自动套用到 2026-09-29 的失败任务。当前源码已把授权请求移到首个 `await` 前，本轮下载也确认两函数代码一致。参见 `docs/reminder-notification-troubleshooting.md` 与提交 `990467d`、`706a3dd`、`804f8e6`。

## 3. 为什么会显示 `failed`：逐阶段判别

| 线上证据 | 已发生的阶段 | 指向的原因 / 下一步 |
| --- | --- | --- |
| 没有 `reminder_jobs` | 尚未预约 | 查看真机订阅结果是否 `accept`、`reminderApi.arm` 返回 `missed`/错误、已发布前端版本。此时页面通常应显示「未开启」或「已错过」，不应归为发送失败。 |
| `scheduled` 且已过 16:00 | 尚未领取 | 回读**真实**定时触发器 cron、启用状态、绑定版本、最近调用日志。不要只看仓库或下载的 `config.json`。 |
| `failed`，`sendAttemptedAt` 为空 | 微信接口尚未调用 | 派发前读库或领取异常；查看 `failureCode`（常见为 `DISPATCH_STAGE_FAILED`）及函数日志。不能用“微信拒发”解释。 |
| `failed`，`sendAttemptedAt` 有值，`43101` | 微信明确拒绝 | 查该 openid 对**该模板**的本次一次性订阅额度：真机是否 `accept`；是否批量 N 条共用一次授权；是否已在别处消费。`getSetting` 的“允许”不等于剩余额度。 |
| `failed`，`sendAttemptedAt` 有值，`47003` / `40037` | 微信模板校验 | 核对公众平台同一 AppID 下的模板 ID、`thing7/time2/number5/number4/thing3`、字段类型与实际发送值；不能只看源码注释。 |
| `failed`，`sendAttemptedAt` 有值，`41030` | 页面校验 | 核对 `pages/item-detail/index` 在指定 `miniprogramState` 对应的已发布版本中存在。 |
| **本次：`failed`，`-501007` 且原因明确为 `Invalid wxCloudApiToken`** | **微信云调用鉴权** | **定案为本次调用票据无效**。优先回看 16:00 触发来源；确认真正有票据的微信 IDE 定时触发器已上传并启用，同时排除普通定时调用抢任务。此时改模板/重新申请订阅都不能修复当前根因。 |
| `failed`，原因含 `INVALID_WX_ACCESS_TOKEN` 或 `missing wxCloudApiToken` | 云调用鉴权 | 核对**这次调用的来源**；普通控制台测试、普通定时触发器通常不带微信云调用票据。核对微信开发者工具上传的微信定时触发器及其真实调用日志。 |
| `unknown` / `sending` | 发送结果不确定 / 处理中 | 不直接重发；先查微信发送结果或日志。代码有 15 分钟 `sending → unknown` 对账，避免重复推送。 |
| `sent` 但用户没看到 | 微信 API 接收请求，最终送达未证实 | 核对微信「服务通知」、账号与模板、微信侧下发结果回调；当前代码没有记录微信的最终送达事件。 |

`failureCode` 的数字应以真实返回为准，表中仅列常见分支。`failureReason` 由 `dispatchReminders` 保留微信 SDK 的 `errMsg/message`，通常比页面文案更有诊断价值（`dispatchReminders/index.js:188-193, 264-272`）。对外分享记录时遮住 openid 和物品内容。

## 4. 高风险的定时触发器配置

本项目同时在 `cloudbaserc.json` 和 `cloudfunctions/dispatchReminders/config.json` 声明 `daily-reminder-dispatch`、`0 0 * * * * *`；历史记录还区分普通 CloudBase/SCF 触发器与微信开发者工具上传的微信定时触发器。腾讯云文档明确：普通来源缺少 `wxCloudApiToken` 时不能进行微信云调用；微信 IDE 配置的定时触发器是例外。见[云调用票据说明](https://docs.cloudbase.net/faq/knowledge/missing-wxcloudapitoken-error)和[上传触发器说明](https://docs.cloudbase.net/cloud-function/timer-trigger)。

**本次 `Invalid wxCloudApiToken` 使触发来源成为首要排查点**。若两套配置实际上产生两次独立的整点调用，普通调用可能先把 `scheduled` 原子领取为 `sending`，随后因票据无效写成永久 `failed`；带票据的微信调用只能看到任务已被领取而跳过。当前代码只校验 `!OPENID`，无法区分“有微信云调用票据的定时调用”和“无票据的普通定时调用”（`dispatchReminders/index.js:393-417`）。但**两套 API 是否是同一触发器的两种视图，以及哪次调用领取了这条任务，必须用同一整点的调用次数和请求来源证实；未证实前不要直接删除任一线上触发器**。

排查时回读：`GetFunction`/普通触发器视图、`DescribeWxFunctionTriggers`/微信触发器视图、同一整点 `dispatchReminders` 日志。比较 cron、启用状态、版本、实际调用次数和错误。历史文档中的 `tcb fn detail ...` / `tcb api tcb DescribeWxFunctionTriggers ...` 命令可作为操作入口，但实际 CLI 版本和授权状态需现场确认。2026-09-22/26 的“已修复”记录只是历史快照。

## 5. 现有状态机为何无法给出可靠的“已开启”承诺

- `requestReminderAuthorization()` 只向调用者返回布尔值；失败回调丢掉原始 `errMsg`，事件埋点只写 `failed`（`miniprogram/services/reminder-service.ts:91-124`）。真机手势错误、模板不可用和用户拒绝被折叠。
- `reminderApi.arm` 不验证本次 `accept` 对应的模板/物品，也不记录授权请求标识。`acceptedAt` 是创建任务时的服务器时间，不能证明微信平台尚有额度（`reminderApi/index.js:166-179`）。
- 快速录入把同一个 `Promise<boolean>` 在循环中多次读取，**Promise 被多次读取不等于微信获得多次订阅**；云端却创建多条任务。
- `reminderApi.arm` 发现 `scheduled` 或 `sent/sending/unknown` 时直接返回旧任务；物品改了到期日后，已 `sent` 的旧任务仍可能让详情页显示「已发送」，无法代表新的提醒周期（`reminderApi/index.js:161-166`；`inventoryApi/index.js:420-429` 只更新 `scheduled/failed/cancelled` 的日期）。
- 云函数顶层即使内部若干 job `failed`，仍返回 `{ok:true}` 且日志 `resultCode:'OK'`（`dispatchReminders/index.js:468-489`）。平台的函数成功率不能当作通知成功率。
- 现有 `diag` 仅取最多 1000 条、无排序后统计；数据多时不能称为“全貌”（`dispatchReminders/index.js:319-353`）。

## 6. 建议的彻底修复：先定案，再小范围重构

### 阶段 A：冻结现场、拿到唯一失败原因（只读）

1. 本次数据库证据已取得：`-501007 / Invalid wxCloudApiToken`。保留这条任务原记录；补读同 ID 物品的必要字段及 16:00 前后的 `dispatchReminders` 日志，取 `requestId`、调用来源、同一分钟调用次数、`summary.failed`。现有源码日志不记录逐 job 的原始异常，以数据库 `failureReason` 为准。
2. 回读**普通 CloudBase/SCF 触发器**和**微信定时触发器**的云端真实状态：启用、cron、绑定函数/版本、环境、最近执行；检查 `DescribeWxFunctionTriggers`。比较 16:00 同一分钟是否存在两个独立调用。不要用控制台“测试发送”推断自然定时链路，因为它没有正常微信云票据。
3. 若确认普通来源领取：先在测试环境保留/修好微信 IDE 触发器，证明它能独自携带票据实发；随后移除或隔离会领取生产任务的普通调度入口，并回读云端状态。若只有微信来源仍票据无效：重新上传该函数的微信触发器、核对云环境与关联 AppID/权限，必要时联系微信云开发支持并提供 16:00 请求 ID。两种情形都要重新走真机自然触发验收。
4. 待票据问题解决后再检查额度、模板、页面路径等下一层错误。当前 `-501007` 不能证明这些下一层配置正确，也不应先靠修改它们解决本次失败。

### 阶段 B：修可确定的代码缺陷

1. **授权额度与任务一一对应**：单件录入维持当前 tap 同步申请；批量录入在一次点击后只预约**最多一条**已获本次授权的任务。其余成功入库的物品显示「提醒待开启」，每件给独立的「开启提醒」按钮，用户每点一次申请一次、成功后只 `arm` 这一件。不要把一个 `accept` 复制给 N 个任务。
2. **拆分失败状态**：派发前读库/领取失败属于 `retryable`（附阶段、次数、下次尝试时间）；微信明确拒绝用 `failed_permanent` 或可操作的具体原因；网络超时/发送后落库失败保持 `unknown`，不自动重发。仅在确认 `sendAttemptedAt` 为空时允许自动重试，且限次数、指数退避、不得超过提醒日窗口。对 `43101` 引导重新由用户点击授权；对配置类错误先修配置再由用户重新预约，避免盲目循环。
3. **将故障原因暴露给运维和用户**：`inventoryApi.get` 可返回安全的 `reminderFailureCategory`、发生时间与建议操作；原始 `failureReason` 留在受控后台日志/数据库，不直接展示完整 SDK 文本。详情页区分「未获得订阅」「发送未成功」「系统处理中」「已错过」。`getSetting` 只能说明设置状态，文案不得承诺有可用一次性额度。
4. **发送前校验运行来源**：在领取任务前确认当前调用具备微信云调用能力；如果 SDK 不提供可靠的无副作用票据检查，则不要猜测 event 字段。先在测试环境验证来源，再只保留一个**经真机实发证明**可带票据的定时入口。确保普通触发不会领取生产任务。`cloudbaserc` 与微信触发器的同步/部署步骤要统一成可核对的单一运维流程。
5. **统一提醒实例语义**：任务至少包含 `itemId + remindDate + itemVersion/planVersion`，已发送的旧提醒不能代表修改后的新周期；新周期必须重新获得一次授权。保留发送尝试记录和微信返回 `msgid`（若 SDK 返回），以便审计，且避免双发。此项可在发送主链路稳定后实施。

### 阶段 C：部署与验收门槛

1. 先在测试环境部署两个云函数和前端，逐项回读真实触发器、权限、环境变量、模板、云端代码哈希；再上传与 `miniprogramState` 匹配的体验/正式版本。代码仓库一致或 CLI 显示部署成功均不足以过关。
2. **真机单条闭环**：当天 16:00 前新增一条提醒日为今天的测试物品，订阅面板点允许；确认唯一 `scheduled`，用小程序端 `verify-self` 仅对**可丢弃的测试物品**即时发送，检查 `sent`、微信「服务通知」和点击跳转。`verify-self` 会实际消耗一次额度且提前发送，不用于真实用户任务。
3. **自然整点闭环**：另建一条测试物品，不调用 `verify-self`，等真实微信定时触发；确认恰好一次领取、`sendAttemptedAt`、`sent`、微信实际收到。对同一时间普通来源调用，不得领取待发任务。
4. **反例矩阵**：拒绝授权→无 `scheduled`；批量 3 条→最多 1 条自动预约，其余有独立开启入口；额度不足→明确分类；模板字段错误→可定位 `47003`；无票据触发→不领取任务；读库暂时失败→可重试且不双发；超时结果未知→不盲目重发；到期日编辑→旧计划失效、新计划重新授权；跨天→不补发过期提醒。
5. 指标与告警分母用 `reminder_jobs`：每日到期任务数、已尝试数、`sent/failed/unknown/scheduled` 数，按 `failureCode` 聚合；16:10 对“应发未发”告警。`diag` 改为按日期/状态分页统计，不再以首页 1000 条代表全量。至少连续两天由真机新建的测试任务在自然触发后全部收到通知，且无票据、模板、系统异常码，再关闭故障；用户主动拒绝等业务分支单独统计。

## 7. 具体分支决策（取得线上 `failureCode` 后执行）

| 定案结果 | 优先修复 | 不应做的事 |
| --- | --- | --- |
| **本次 `-501007 / Invalid wxCloudApiToken`** | **核对 16:00 实际触发来源与两类触发器，保证只有经验证带有效票据的入口领取发送任务；然后新建真机测试任务验自然触发** | 改提醒时间、反复申请订阅、改模板字段、只重新部署函数代码或用控制台“测试”宣布修好 |
| 大量 `43101` 且多来自批量 | 先落地授权一对一；真机逐件补授权；历史已过时刻任务按产品规则归档 | 继续把一条 `accept` 用于所有批量任务；单纯重跑派发 |
| `INVALID_WX_ACCESS_TOKEN` | 先证明自然调用来源，修微信 IDE 触发器/普通来源竞争；再让用户对未过期任务重新授权并预约 | 仅改 `config.json`、仅部署函数代码、用控制台测试发送判定已修 |
| `47003` / `40037` | 核对同 AppID 的真实模板和字段类型，修映射、部署，再用一次新授权真机实发 | 只改客户端模板 ID 或只改云函数一侧 |
| `41030` | 修消息跳转页与对应版本，再真机发送/点击验证 | 把 `miniprogramState` 当作“收不到消息”的万能开关 |
| `DISPATCH_STAGE_FAILED` 且未 attempt | 根据日志修数据库/索引/权限/短暂故障，实施派发前可重试 | 反复向用户要订阅授权 |
| `unknown` 或 `sent` 但没看到 | 查微信最终下发事件与服务通知设置，再决定是否重发/补偿 | 在结果不确定时直接把任务改回 `scheduled` |

若微信云定时触发器在该环境始终无法稳定携带云调用票据，可改用**单一普通调度器 + 服务端 HTTPS 订阅消息接口**，由后端安全存放小程序密钥、管理 access token 与刷新、限流和审计；这是备选重构，复杂度和凭据风险更高。应先证明微信云原生链路不可修复，再采用此方案。

## 8. 本次调查的未完成项与资料

- 已取得用户当前失败任务的完整错误：`-501007 / Invalid wxCloudApiToken`。自然整点的调用日志和微信触发器 API 实际返回仍未取得，故**票据为何无效的具体触发器配置子原因尚未定案**；公众平台模板详情和最终送达能力应在票据修复后再验。
- 未运行发送测试、未改云数据或触发器；本轮下载/核对是只读的。`project.config.json` 在调查前已有仅末尾换行的未提交差异，本轮未触碰。
- 机制依据：[腾讯云云调用票据 FAQ](https://docs.cloudbase.net/faq/knowledge/missing-wxcloudapitoken-error)、[腾讯云定时触发器文档](https://docs.cloudbase.net/cloud-function/timer-trigger)、[腾讯云一次授权一条通知说明](https://cloud.tencent.com/document/product/1301/103770)、[腾讯云订阅消息示例与常见错误](https://docs.cloudbase.net/recipes/add-subscribe-message-cloud-function)。最后一篇示例是独立 CloudBase 接入，**仅用于一次性订阅和错误码机制**；本项目的实际部署是 `wx.cloud` / 微信云开发，必须按本项目运行环境验收。微信原始接口入口：[申请订阅](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)、[发送订阅消息](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-message-management/subscribe-message/sendMessage.html)。
