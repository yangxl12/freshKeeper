# freshKeeper 项目长期记忆

## 技术栈与约定
- 微信小程序（原生 TS + WXSS）+ 云开发 cloudfunctions；vitest **必须 3.2.7**（4.x/5.x 报
  `Cannot read properties of undefined (reading 'config')`，是版本问题不是缓存）；package.json 不单独锁 vite。
- 每次改代码后跑 `npm run check`（typecheck + test + check:project）→ commit → push
  `git@github.com:yangxl12/freshKeeper.git`。SSH 常被代理拦截（127.0.0.1:7888 未监听），
  第一次 push 失败就只提交，让用户代推。

## Git 踩坑
- **绝不要 `git stash push -- <path>`**：曾删空 `.git/refs`（git 报 not a repository，文件全变 A）。
  恢复：`mkdir -p .git/refs/{heads,tags,remotes}` → `git ls-remote origin` 取 sha → `git fetch origin` → `git update-ref`。
  对比基线用 `git show HEAD:<path> > /tmp/orig`。
- `fatal: bad object HEAD`：先 `git ls-remote origin`，远端有就 `git fetch origin` 拉回。

## 云函数部署
- `config.json` 的 `timeout`/`envVariables`/`triggers` **只在函数首次创建时写入云端**，后续 deploy 只更新代码。
  改超时/环境变量只能走云开发控制台（或删函数重建，慎用），CLI 没有该命令。
- 默认超时 3 秒，调 LLM 的函数上线第一件事改 60s。
  查线上配置：`/d/微信web开发者工具/cli.bat cloud functions info --env cloud1-d0gkh66ce94b1be08 --names <fn> --project D:/myProject/freshKeeper`。
- 「云函数本地调试」没有云开发网关注入，`cloud.ai()` 必 404（`AI_PARSE_DEGRADED` + `reason:"404"` 后降级）；
  `ai-client.js` 用 `TENCENTCLOUD_RUNENV === 'WX_LOCAL_SCF'` 识别并默认跳过 AI（逃生门 `QUICK_ENTRY_AI_LOCAL_DEBUG=true`）。
  验证 AI 只能走云端（关本地调试 + 模拟器/真机）。

## 模拟器里真调云函数（验收手段）
1. `/d/微信web开发者工具/cli.bat auto --project "D:/myProject/freshKeeper" --auto-port 9420 --trust-project`（约 3s）。
2. 起 `~/AppData/Local/uv/cache/archive-v0/<hash>/wechat_devtools_mcp/scripts/dist/daemon.bundle.js`（cwd 为同目录 scripts/），
   输出 `{"ready":true}` 后发 NDJSON `{"id":1,"script":"run_test_script","args":["--port","9420","--script","<探针>","--timeout","90"]}`。
3. 探针：`module.exports = async function (miniProgram) { return await miniProgram.evaluate(...) }`，内部可包 Promise 调 `wx.*`。
   模板见 `C:/Users/BYS/AppData/Local/Temp/wx-probe/`（`probe-cover.js` + `run-cover.mjs`、`run-state.mjs`）。
4. 云函数返回 `{ok, data, requestId}`，探针取值必须 `res.result.data.xxx`；`save` 的 `idempotencyKey` 必须是标准 UUID v4。
5. automator 的 page node 会失效（`page node not found` / 截图全白），但 `miniProgram.evaluate` 仍可用；
   该形态下 `getCurrentPages()[i].data` 只有 `__webviewId__`，读不到业务字段，别用它断言页面数据。
6. **只查小程序 API 真实返回值**：探针里直接包 Promise 调 `wx.xxx`。
   2026-09-11 靠这招拿到 `wx.getSetting({withSubscriptions:true})` 实返，定位提醒授权只看 mainSwitch 的 bug。
   **怀疑平台 API 行为先探针实测，别推理。**

## 快速录入：能力三档开关
- ① `QUICK_ENTRY_FEATURES`（`config/runtime.ts`）决定按钮显不显示；② 云端 `getCapabilities()` 回
  `voice`/`datePhoto`/`aiText` 决定能不能用；③ `QUICK_ENTRY_AI_ENABLED`（默认开，false/0/off/no 才关）是云函数急停。
- 按钮必须置灰 + 静态说明（不能只靠 toast，微信 toast 超 7 个汉字被截断，被用户吐槽）：
  `disabled="{{saving || recognitionState !== 'idle' || !capabilities.voice}}"`；说明行 `wx:for="{{unavailableHints}}"`
  （`preparePage` 生成，文案 `unavailableHintsOf`）。`startVoice`/`chooseDatePhoto` 开头的 `if (!capabilities.x) return` 是第二道保险，静默。
- 语音/拍日期不可用的根因：云端没配 `QUICK_ENTRY_TENCENT_SECRET_ID`/`_SECRET_KEY`（ASR 一句话识别 + OCR 高精度版），
  `tencent-provider.configured()` 为假。2026-09-10 线上实测 `{text:true, voice:false, datePhoto:false, aiText:true}`。密钥只能进控制台。
- 语音是**点击开始/点击结束**（wxml 无 touch 事件），`moveVoice`/`voiceBounds` 是死代码。

## 快速录入：其他约定
- 最近使用：`listRecentProfiles` 未部署（`INVALID_ACTION`）时降级 `listInventory(sort:'created_desc')` +
  `recentProfilesFromItems()`；区域不随草稿隐藏，点击是追加草稿（上限 `MAX_DRAFTS`）。
- 「已过期」用 `expiredFlags`（`getExpirySummary()` 过滤 `/^\d{4}-\d{2}-\d{2}$/` 再比），别拿中文占位「待补到期日」比大小。
- `.quick-input` 开了 `hold-keyboard`，任何"输入完就干活"的分支都要 `blurQuickInput()`
  （`wx.hideKeyboard` + `quickInputFocused:false` + `quickKeyboardHeight:0`）；
  不要用 `focus` 自动聚焦草稿名称框，用 `nameMissingFlags` 高亮。

## 快速录入：AI 解析
- 云函数端 `wx-server-sdk`（4.0.2）的 `cloud.ai()`，**provider 必须 `hunyuan-v3`**（不是 `cloudbase`），模型 `hy3`；
  provider/模型名只准出现在 `ai-client.js` 一处。
- 两条核心设计别丢：① 不让模型算日期（只出 `dateFacts`，换算交 `date-facts.js:normalizeFacts()`）；
  ② 证据回链防幻觉（每字段带 `evidence`，服务端校验不在原文就置 null 走 `confirmationFields`，绝不静默入库）。
- 降级链 AI → 自定义 provider → 本地 `rules-v3`；免费额度耗尽直接报错；单环境 5 并发
  （`EXCEED_CONCURRENT_REQUEST_LIMIT` 退避 300ms 重试一次）。
  AI 超时 `QUICK_ENTRY_AI_TIMEOUT_MS`（默认 6000，必须 < 前端 `recognizeTextItems` 的 8s `Promise.race`）。
- 文件分工：`ai-client.js`（唯一知道 provider/模型/返回结构，顶层不 require SDK，用时 lazy require）、
  `ai-prompt.js`、`ai-parse.js`、`ai-quota.js`（缓存 + 每日 50 次，内存不落库）。
  `createModel('hunyuan-v3')` 不在 `@cloudbase/ai` MODELS 表 → 走 DefaultSimpleModel，
  URL `…/v1/ai/hunyuan-v3/chat/completions`，正常路径。
- `domain/quick-entry.ts:createDraftFromParsed` 第 6 参是 `parserVersion`；AI 缺失字段**故意不写进 `confirmationFields`**；
  `recognizeTextItems` 返回 `{ items, parserVersion }`。页面测试假 setData 是 `Object.assign`，不认 `drafts[0]` 路径 key。
- 文档：`docs/ai-parse-plan.md`；`docs/ai-parse-research.md` 已过时。
- 待办：`quickEntryApi` 超时 60s（线上已确认 60）、隐私指引补「输入发送至大模型」、`quick-entry/` 存储生命周期清理、
  ASR/OCR 计费、复核 `AI_*` 日志。

## 封面生图（inventoryApi generateCover）
- `cloud.ai().createImageModel('hunyuan-image')` → `generateImage({model,prompt,size,n,revise,enable_thinking})`
  → `data[0].url`（临时，必须下载转存云存储）。provider/模型名只在 `cloudfunctions/inventoryApi/image-cover.js`。
- **model 必须 `HY-Image-3.0-Plus-4090-Tob-v1.0`**（`hunyuan-image` 作为 model 已于 2026-07-15 下线，provider 名不变）；
  **必须显式 `revise:{value:false}`/`enable_thinking:{value:false}`**，否则 +10~60s 必撞超时。
- **prompt 不能写「贴纸风格」**（会出灰底方块）；写「背景是纯白色，主体周围不要阴影」。出图约 5.8s。
- **扩展名按文件头魔数嗅探**（`sniffExtension`）：字节实测是 JPEG，URL 无后缀且 Content-Type 谎报 `image/png`。
- `cloud.init({ timeout: 45000 })` 是 SDK 单次 HTTP 超时（默认约 15s），不是云函数超时。
- 落 `coverFileId`（cloud://），**不 bump version**；同名复用；急停 `COVER_IMAGE_ENABLED`；生图 30s/下载 10s（函数需 60s）。
- 触发：保存成功后 fire-and-forget，失败静默 → 占位图。`inventory-row` 记 `coverFor/coverError`，
  封面 ID 变化才重试，回退 `/assets/inventory-placeholder.svg`。
- **封面回填**：`inventory-service.ts:onItemCoverReady(listener)` 广播 `{itemId,coverFileId}`，
  首页 onShow 订阅 / onHide 退订后 `patchItem`。别用轮询。
- 待办：编辑改名不重新生成；item-detail 仍用默认图；线上 inventoryApi 超时需 60s。

## 提醒授权开关（2026-09-11）
- 订阅消息授权是**系统级状态**，来源固定 `wx.getSetting({withSubscriptions:true})`；
  改状态只能 `wx.openSetting({withSubscriptions:true})`。
- **不能只看 `mainSwitch`**：用户单独关掉「临期提醒」模板时 mainSwitch 仍是 true，只有 `itemSettings[模板ID]` 变 `reject`。
  判据：`mainSwitch===false` → 未授权；`itemSettings[模板ID]` 为 `reject`/`ban` → 未授权；`mainSwitch===true` → 已授权；
  其余（不下发）→ 未授权。`itemSettings` 只含用户勾过「总是保持以上选择」的模板。
  实现收在 `services/reminder-service.ts:resolveReminderAuthorization`（纯函数，有单测），
  完整录入与「我的—提醒设置」共用。
- 「提醒授权」开关**不落本地状态**：`bindchange` 不读 `event.detail.value`，只弹窗 + 引导系统页。
- **开关回弹**：用 `authSwitchRebuilding` + `wx:if` 卸载重建（放在遮罩盖住表单之后）。
- 「提前提醒」行只剩天数输入框（`reminderEnabled` 已删）。`item-form-sheet` 被完整录入/快录完整录入 tab/编辑/重新入库共用。
- `item-form-sheet/index.json` 只有 `{"component": true}` → isolated，app.wxss class 进不来，样式必须自带。
- 组件同步状态用 `lifetimes.attached` + `pageLifetimes.show` 各读一次。

## UI / 工程约定
- 自定义 tabBar（`app.json` `tabBar.custom: true`，z-index 900）遮罩盖不住时别硬提 z-index，加 `hidden` 态：
  `getTabBar()?.setData({hidden:true})` + `opacity + translateY(120%) + pointer-events:none`。
- **WXSS 不支持通用选择器 `*`**（如 `.field-row > *`），会导致编译中断整页渲染；用显式 BEM 类名。
- 图标 `miniprogram/assets/icons/*.svg`（32×32 圆角底 + 24 栅格线稿）；
  状态色：在库/编辑=绿、临期/提醒=琥珀、过期/删除=红、已用完=蓝。

## 目录速记
- `miniprogram/pages/quick-entry/`：AI 快速录入页（草稿卡、日期/保质期模式切换）。
- `miniprogram/pages/item-form/`：手动录入表单页，`.field` 等样式在此页 wxss 局部定义。
- `docs/quick-entry-acceptance.md`、`docs/cloud-deployment.md`。
