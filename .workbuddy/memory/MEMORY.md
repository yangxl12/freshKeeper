# freshKeeper 项目长期记忆

## 技术栈与约定

- 微信小程序（原生，TS + WXSS），云开发 cloudfunctions，测试用 vitest。
- 校验命令：`npm run check`（= typecheck + test + check:project），改动后必须跑通。
- 每次对话修改代码后需要 commit 并 push（见 AGENTS.md）。远端为 `git@github.com:yangxl12/freshKeeper.git`。SSH 偶尔被代理拦截（报 127.0.0.1:7888 未监听，需用户本地 push）；
2026-09-10 实测 `git ls-remote` / `git push origin index-ui` 直连成功，先试再判定需要用户代推。

## 弹窗层级（自定义 tabBar）

- `app.json` 用 `tabBar.custom: true`，标签栏是 `miniprogram/custom-tab-bar` 组件（z-index 900，悬浮 + 按钮 1000）。
  页面遮罩 `.sheet-mask` 单纯提高 z-index **不保证**盖住它（层叠上下文不可靠）。
- 可靠做法：自定义 tabBar 加 `hidden` 态（页面上浮层打开时 `getTabBar()?.setData({hidden:true})`，关闭/回页面复位），
  配合 `opacity + translateY(120%) + pointer-events:none` 过渡。首页已在 `openMore/closeMore`、`openQuantity/closeQuantity`、
  `onShow → syncTabBar` 中处理。

## Git 仓库健康（踩过的坑）

- 远端 `git@github.com:yangxl12/freshKeeper.git` 是唯一兜底，**改动后务必及时 push**。
- **绝对不要跑 `git stash push -- <path>`**：2026-09-10 第二次踩坑，这次直接把 `.git/refs` 整个删掉，
  git 报 `fatal: not a git repository`（同时 `fatal: xxx is not a valid object`），`git status` 把所有文件显示成 `A`。
  恢复步骤：①`mkdir -p .git/refs/heads .git/refs/tags .git/refs/remotes`；②`git ls-remote origin` 拿到分支 sha；
  ③`git fetch origin` 把丢掉的对象拉回；④`git update-ref refs/heads/<branch> <sha>`。之后 `git status` 恢复正常。
  想对比"改动前"的基线，改用 `git show HEAD:<path> > /tmp/orig && cp /tmp/orig <path>` 再还原，别用 stash。
- 若出现 `fatal: bad object HEAD` / 大量对象丢失：先 `git ls-remote origin` 确认远端是否已含这些提交，
  若已含，直接 `git fetch origin` 即可把对象拉回（2026-09-10 用此法救回过一次）。
- 避免在仓库里跑 `git stash push -- <path>`；`refs/codex/turn-diffs/checkpoints/*` 这类失效 ref 会让 fetch 报错（可删）。

## 图标资源

- 小程序图标用 `miniprogram/assets/icons/*.svg`（32×32 圆角底 + 24 栅格线稿，`<image mode="aspectFit">` 渲染），
  比 WXSS 伪元素拼图标更可控；配色沿用状态色：在库/编辑=绿、临期/提醒=琥珀、过期/删除=红、已用完=蓝。

## 测试环境（踩过的坑）

- **vitest 必须用 3.2.7**（2026-09-08 起）。vitest 5.0.0 / 4.1.11（配 vite 7 或 8）在本机运行全部测试会报
  `TypeError: Cannot read properties of undefined (reading 'config')`（@vitest/runner 全局状态未初始化，
  即 runner 模块被加载成两份），11 个文件全挂。换回 3.2.7 后 11 文件 81 测试稳定通过。
- 排查同类问题时别只清 `node_modules/.vite`、`node_modules/.vite-temp` 缓存——清缓存只是偶尔让单次运行"侥幸"通过，
  根因是 vitest 版本，改版本才彻底解决（记得 `rm -rf node_modules && npm ci`）。
- 不要在 package.json 里单独锁 `vite`，交给 vitest 自己带。

## 快速录入：语音 / OCR 能力开关

- 按钮（语音「按住说」、「拍日期」、草稿卡内联「拍日期」）**始终显示**（由 `QUICK_ENTRY_FEATURES`，`config/runtime.ts` 决定），
  未接入时**置灰 `disabled`**（`disabled="{{... || !capabilities.voice}}"`，`capabilities` 来自 `quickEntryApi.getCapabilities`）。
- **不要弹 toast**：微信 `wx.showToast` 标题超过 7 个汉字会被截断，出现过「拍照识别未开通…」这类被用户吐槽的残缺提示。
  未接入就静默禁用，只在输入卡片下给一行静态说明 `.feature-hint`。

## 快速录入：最近使用

- 云端 `inventoryApi.listRecentProfiles` 未部署（`INVALID_ACTION`）时，`services/quick-entry-service.ts` 会降级为
  `listInventory(sort:'created_desc', pageSize:30)` + `recentProfilesFromItems()` 本地归并（与 `batchDelete`/`listTrash` 同一降级套路）。
- 最近使用区**不随草稿出现而隐藏**（原 `wx:if` 带 `!drafts.length`，生成过一次草稿就再也看不到，被当成功能坏了）；
  点击是**追加**草稿而非替换，上限 `MAX_DRAFTS = 5`。
- 「已过期」提示用 `expiredFlags`（`commitDrafts` 里对 `getExpirySummary()` 做 `/^\d{4}-\d{2}-\d{2}$/` 校验再比较），
  不要直接拿中文占位文案 `待补到期日` 和 `today` 比大小。

## WXSS 限制（踩过的坑）

- **WXSS 不支持通用选择器 `*`**（如 `.field-row > *`），会导致编译报错中断整个页面渲染。
  替代方案：给相关子元素加显式 BEM 类名（如 `.field-row__item`）再写规则。
- 同理，写 WXSS 时优先用类选择器，避免通配/属性/复杂选择器。

## 快速录入：输入法焦点

- `.quick-input` textarea 开了 `hold-keyboard="{{true}}"`，点「确定」不会自动收起输入法。
  任何"输入完就去干活"的分支都要调 `blurQuickInput()`（`wx.hideKeyboard()` + `quickInputFocused:false` + `quickKeyboardHeight:0`）。
- **不要**再用 `focus` 自动聚焦草稿的名称输入框（`focusNameId` 已删），会把键盘重新弹起来；
  用 `nameMissingFlags` 做视觉高亮即可。

## 快速录入：AI 解析（2026-09-10，已按官方文档校正）

- 云开发已内置大模型能力，不必买第三方 API。**云函数端用 `wx-server-sdk` 的 `cloud.ai()`**（本项目已装 4.0.2，
  要求 ≥3.0.5-beta.1），**不是** `@cloudbase/node-sdk` 的 `app.ai()` —— 这是 2026-09-10 读官方文档后的校正，
  `docs/ai-parse-research.md` 里的 node-sdk 结论已作废。
  ```js
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 60000 })
  const model = cloud.ai().createModel('hunyuan-v3')   // 不是 'cloudbase'，见下条
  const result = await model.generateText({ model: 'hy3', messages })  // result.text / result.usage
  ```
- **模型用 `hy3`，不要用 `hy3-preview`（官方已公告即将下线）。** 模型名只允许出现在 adapter 文件里。
- **provider 必须用 `hunyuan-v3`，不是 `cloudbase`**（2026-09-10 踩坑确认）：
  `cloudbase` **仅资源点套餐可用**且**需在控制台手动开 `hy3` 开关**；`hunyuan-v3` 资源点/非资源点套餐**均可**、
  **无需开关也不支持关闭**、**只消耗免费额度**。本项目环境 `cloud1-d0gkh66ce94b1be08` 是非资源点计费，
  在控制台点 hy3 开关会被拦（提示"需先切换为资源点套餐"）——**别去切套餐**，那开关属于 cloudbase 通道。
  微信官方 FAQ 原话：「生文模型：使用 `ai.createModel("hunyuan-v3")`，model 传 `hy3`」。
  provider 名只允许出现在 `ai-client.js` 一处，将来额度耗尽切资源点套餐时只改这一行（`hunyuan-v3` → `cloudbase`）。
- **`hunyuan-v3` 通道两个硬约束**：① 免费额度耗尽**直接报错**（不静默扣套餐），降级链是必需品不是可选项；
  ② 体验模型**单环境仅 5 并发**，超了报 `EXCEED_CONCURRENT_REQUEST_LIMIT`，必须退避重试。
  「CloudBase 内置模型调用」在免费体验版环境不支持，个人版/资源点套餐才支持（成长计划报名会升级或发代金券）。
- 计费：1000 Token 点 = 1 元；单次解析约 1 点（0.001 元）。「小程序成长计划」送 10 亿混元 Token，
  **仅限小程序/云函数调用**；在 AI 工具等非小程序场景调用会走套餐扣费。
- 无 `response_format: json_schema`。降级链：AI → 自定义 provider → 本地 `rules-v3`。
- **两个关键设计（别丢）**：
  1. **不让模型算日期**。模型只输出 `dateFacts`（`kind: absolute` 给年月日 / `kind: relative` 给 `offsetDays` /
     `kind: shelf_life` 给 value+unit），日期换算交给现成的 `date-facts.js:normalizeFacts()`，零新增日期逻辑。
  2. **证据回链防幻觉**。要求模型对每个非推断字段给原文片段（`evidence`），服务端去空白后校验它确实出现在用户原文里，
     对不上就把该字段置 `null` 走 `confirmationFields`，绝不静默入库。
- **踩坑预警**：`normalizeTextResult()` 用 `assert` 抛错——一条 item 有个脏字段会导致**整批** `INVALID_PROVIDER_RESPONSE`。
  所以 AI 层必须先做逐字段宽容清洗（非法值丢成 null），再喂给它做严格兜底。
- 计划文档见 `docs/ai-parse-plan.md`；旧调研见 `docs/ai-parse-research.md`（结论部分已过时）。
- **P0 已落地（2026-09-10，commit 4c0f835）**：`ai-client.js`（唯一知道 provider/模型名/返回结构的地方，
  顶层不 require wx-server-sdk，调用时才 lazy require，否则单测会加载真 SDK）、`ai-prompt.js`（system + 4 few-shot）、
  `ai-parse.js`（`aiParseText({text, serverToday, generate, timeoutMs})`，宽容清洗 → `normalizeTextResult` 严格兜底，
  `parserVersion='ai-v1'`）。`index.js` 的 AI 分支**吞掉一切错误**静默降级（连 `TOO_MANY_DRAFTS` 也吞，模型幻觉 6 件时降级更对）。
- AI 超时用独立 `QUICK_ENTRY_AI_TIMEOUT_MS`（默认 6000，再取 min 于 `QUICK_ENTRY_TIMEOUT_MS`）——
  不能用满 8s，前端 `recognizeTextItems` 有 8s `Promise.race`，撑满等于用户已降级。
- `createModel('hunyuan-v3')` 不在 `@cloudbase/ai` 的 MODELS 表内，会走 DefaultSimpleModel：
  URL = `…/v1/ai/hunyuan-v3/chat/completions`，body 原样透出 `{model:'hy3', messages}`，这是正常路径不是 bug。
- 待办：P1 = 证据回链 `evidence` + `ai-quota.js` 限流缓存 + `EXCEED_CONCURRENT_REQUEST_LIMIT` 退避重试；
  P2 = `runtime.ts` 的 `aiParse` 开关、识别中文案 + `AI` 徽章、隐私政策。真机验证前必须先部署 `quickEntryApi`。

## 云函数部署（踩过的坑，2026-09-10）

- **`config.json` 的 `timeout` / `envVariables` / `triggers` 只在函数首次创建时写入云端。**
  `cli cloud functions deploy`（和开发者工具对已存在函数的上传）**只更新代码**，不重新应用函数配置。
  改超时/环境变量必须去**云开发控制台 → 云函数 → 配置**（或删函数重新部署，慎用，会重置调用权限）。
  CLI 没有改配置的命令；IDE 本地 HTTP 服务端只有 `/cloud/functions/{list,info,deploy,inc-deploy,download}`。
  实证：config.json 写 `timeout: 60`，线上仍是默认 **3 秒**。
- **微信云函数默认超时只有 3 秒**，调用 LLM 一定撞墙（单条输入 1.6~2.4s，五条物品约 4.9s →
  `FUNCTIONS_TIME_LIMIT_EXCEEDED`）。凡是加 AI/长任务的函数，上线第一件事就是把超时调到 60s。
- 查线上函数配置：`cli cloud functions info --env <环境ID> --names <函数名> --project <项目目录>`
  （CLI 在 `D:\微信web开发者工具\cli.bat`；`scripts/start-wechat-devtools-mcp.mjs --check` 在本机因沙箱禁 `reg.exe` 定位失败，
  直接走 `/d/微信web开发者工具/cli.bat`）。
- **在模拟器里真调云函数**（验收用，可复用）：先 `cli auto --project ... --auto-port 9420 --trust-project`，
  再起 `wechat-devtools-mcp` 包里的 `scripts/dist/daemon.bundle.js`（在 uv 缓存
  `~/AppData/Local/uv/cache/archive-v0/<hash>/wechat_devtools_mcp/` 下），发 NDJSON
  `{"id":1,"script":"run_test_script","args":["--port","9420","--script","<探针绝对路径>","--timeout","90"]}`；
  探针导出 `async function(miniProgram)`，内部 `miniProgram.evaluate(() => new Promise(r => wx.cloud.callFunction({...})))`。
- `QUICK_ENTRY_AI_ENABLED` 默认开启、只在取值 `false/0/off/no` 时关闭（急停开关）。
  开启不能依赖环境变量，否则新环境部署完直接是死的。

## 目录速记

- `miniprogram/pages/quick-entry/`：AI 快速录入页，含草稿卡片、日期/保质期模式切换。
- `miniprogram/pages/item-form/`：手动录入表单页，字段样式（`.field` 等）主要在此页级 wxss 定义，未全局化。
