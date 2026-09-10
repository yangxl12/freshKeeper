# freshKeeper 项目长期记忆

## 技术栈与约定
- 微信小程序（原生 TS + WXSS），云开发 cloudfunctions，测试 vitest **必须 3.2.7**（4.x/5.x 在本机全部报
  `Cannot read properties of undefined (reading 'config')`，根因是版本不是缓存）；package.json 不要单独锁 vite。
- 改动后必跑 `npm run check`（typecheck + test + check:project），再 commit + push 到 `git@github.com:yangxl12/freshKeeper.git`。
  SSH 偶尔被代理拦截（127.0.0.1:7888 未监听），先试直连，失败就只提交让用户代推。

## Git 仓库（踩过的坑）
- **绝对不要 `git stash push -- <path>`**：曾把 `.git/refs` 删空，git 报 `fatal: not a git repository`，
  `git status` 把全部文件显示成 `A`。恢复：`mkdir -p .git/refs/{heads,tags,remotes}` → `git ls-remote origin` 取 sha
  → `git fetch origin` 拉回对象 → `git update-ref refs/heads/<branch> <sha>`。
  要对比改动前基线用 `git show HEAD:<path> > /tmp/orig`，别用 stash。
- `fatal: bad object HEAD` / 大批对象丢失：先 `git ls-remote origin`，远端若已含这些提交，`git fetch origin` 即可拉回。

## 云函数部署（踩过的坑）
- `config.json` 的 `timeout`/`envVariables`/`triggers` **只在函数首次创建时写入云端**；之后 deploy（CLI 与开发者工具）
  只更新代码。改超时/环境变量必须去**云开发控制台 → 云函数 → 配置**（或删函数重建，慎用）。CLI 没有改配置的命令。
- 微信云函数默认超时 3 秒，任何调 LLM 的函数上线第一件事就是改 60s。
  查线上配置：`/d/微信web开发者工具/cli.bat cloud functions info --env cloud1-d0gkh66ce94b1be08 --names <fn> --project D:/myProject/freshKeeper`。
- 开发者工具的「云函数本地调试」没有云开发网关注入，`cloud.ai()` 必 404（日志 `AI_PARSE_DEGRADED` + `reason:"404"` 后降级）；
  `ai-client.js` 用 `TENCENTCLOUD_RUNENV === 'WX_LOCAL_SCF'` 识别该形态并默认跳过 AI，逃生门 `QUICK_ENTRY_AI_LOCAL_DEBUG=true`。
  验证 AI 只能走云端（关本地调试 + 模拟器/真机）。

## 模拟器里真调云函数（验收手段，可复用）
1. `/d/微信web开发者工具/cli.bat auto --project "D:/myProject/freshKeeper" --auto-port 9420 --trust-project`（约 3s 返回）。
2. 起 `~/AppData/Local/uv/cache/archive-v0/<hash>/wechat_devtools_mcp/scripts/dist/daemon.bundle.js`（cwd 设同目录 scripts/），
   它先输出 `{"ready":true}`，再发 NDJSON `{"id":1,"script":"run_test_script","args":["--port","9420","--script","<探针绝对路径>","--timeout","90"]}`。
3. 探针格式：`module.exports = async function (miniProgram) { return await miniProgram.evaluate(...) }`，
   内部可 `new Promise(r => wx.cloud.callFunction({...}))`。driver 示例见 `C:/Users/BYS/AppData/Local/Temp/wx-probe/`。

## 快速录入：能力三档开关
- ① `QUICK_ENTRY_FEATURES`（`config/runtime.ts`）决定按钮**显不显示**；
  ② 云端 `getCapabilities()` 回 `voice`/`datePhoto`/`aiText` 决定**能不能用**；
  ③ `QUICK_ENTRY_AI_ENABLED`（默认开，取值 false/0/off/no 才关）是云函数急停。
- **按钮必须置灰并给静态说明**，否则「看着能点、点了没反应」会被当成坏了（2026-09-10 修复）：
  `disabled="{{saving || recognitionState !== 'idle' || !capabilities.voice}}"`；
  说明行 `wx:for="{{unavailableHints}}"`（在 `preparePage` 里按能力/探测结果生成，文案见 `unavailableHintsOf`）。
  **不要弹 toast**：微信 `wx.showToast` 标题超 7 个汉字会被截断，被用户吐槽过。
- `startVoice` / `chooseDatePhoto` 开头的 `if (!capabilities.x) return` 是第二道保险，静默、不 toast。
- **语音/拍日期不可用的根因**：云端没配 `QUICK_ENTRY_TENCENT_SECRET_ID` / `QUICK_ENTRY_TENCENT_SECRET_KEY`
  （腾讯云 ASR「一句话识别」+ OCR「通用文字识别（高精度版）」），`tencent-provider.configured()` 为假 → 能力下发 false。
  2026-09-10 实测线上返回 `{text:true, voice:false, datePhoto:false, aiText:true}`。密钥只能进控制台，不能进仓库/聊天。
- 语音交互是**点击开始 / 点击结束**（不是按住说话）：wxml 没绑任何 touch 事件，`moveVoice` / `voiceBounds` 是死代码。

## 快速录入：其他约定
- 最近使用：云端 `listRecentProfiles` 未部署（`INVALID_ACTION`）时降级 `listInventory(sort:'created_desc')` +
  `recentProfilesFromItems()`（与 `batchDelete`/`listTrash` 同一套路）；区域不随草稿出现而隐藏，点击是**追加**草稿（上限 `MAX_DRAFTS = 5`）。
- 「已过期」用 `expiredFlags`（`getExpirySummary()` 过 `/^\d{4}-\d{2}-\d{2}$/` 再比），别拿中文占位「待补到期日」和 today 比大小。
- 输入法：`.quick-input` 开了 `hold-keyboard`，任何"输入完就干活"的分支都要 `blurQuickInput()`
  （`wx.hideKeyboard` + `quickInputFocused:false` + `quickKeyboardHeight:0`）；不要用 `focus` 自动聚焦草稿名称框
  （会重弹键盘），用 `nameMissingFlags` 做高亮。

## 快速录入：AI 解析
- 云函数端用 `wx-server-sdk`（本项目 4.0.2）的 `cloud.ai()`，**provider 必须是 `hunyuan-v3`**，不是 `cloudbase`
  （后者仅资源点套餐可用且需控制台开 hy3 开关；`hunyuan-v3` 两种套餐都行、只耗免费额度）；模型用 `hy3`（`hy3-preview` 将下线）。
  provider / 模型名只准出现在 `ai-client.js` 一处。
- 两个核心设计别丢：① **不让模型算日期**（只输出 `dateFacts`，换算交 `date-facts.js:normalizeFacts()`）；
  ② **证据回链防幻觉**（每个字段带 `evidence`，服务端校验确实出现在原文，对不上置 null 走 `confirmationFields`，绝不静默入库）。
- 降级链 AI → 自定义 provider → 本地 `rules-v3`；`hunyuan-v3` 免费额度耗尽**直接报错**，单环境仅 5 并发
  （`EXCEED_CONCURRENT_REQUEST_LIMIT` 退避 300ms 重试一次）。AI 超时 `QUICK_ENTRY_AI_TIMEOUT_MS`
  （默认 6000，必须 < 前端 `recognizeTextItems` 的 8s `Promise.race`）。
- 文件分工：`ai-client.js`（唯一知道 provider/模型/返回结构，顶层不 require SDK，用时 lazy require 否则单测会加载真 SDK）、
  `ai-prompt.js`、`ai-parse.js`（宽容清洗 → `normalizeTextResult` 严格兜底）、`ai-quota.js`（结果缓存 + 每日 50 次，内存不落库）。
  `createModel('hunyuan-v3')` 不在 `@cloudbase/ai` 的 MODELS 表内 → 走 DefaultSimpleModel，
  URL `…/v1/ai/hunyuan-v3/chat/completions`，正常路径不是 bug。
- `domain/quick-entry.ts:createDraftFromParsed` 第 6 参是 `parserVersion`，另有 `aiMissingFields`；
  AI 缺失字段**故意不写进 `confirmationFields`**（会把 savable 变成「待确认」，破坏 acceptance 测试契约）；
  `recognizeTextItems` 返回 `{ items, parserVersion }` 而不是裸 items。
- 页面测试的假 setData 是 `Object.assign`，不认 `drafts[0]` 这类路径 key，验证路径 setData 要自己捕获 patch。
- 文档：计划 `docs/ai-parse-plan.md`；`docs/ai-parse-research.md` 结论已过时（node-sdk 说法作废）。
- 真机/后台待办：`quickEntryApi` 超时 60s（已确认线上是 60）、隐私指引补「输入发送至大模型」、
  `quick-entry/` 存储生命周期清理、ASR/OCR 密钥与腾讯云计费、复核 `AI_*` 日志。

## UI / 工程约定
- 自定义 tabBar（`app.json` `tabBar.custom: true`，z-index 900）遮罩盖不住时**别硬提 z-index**（层叠上下文不可靠）；
  给 tabBar 加 `hidden` 态：`getTabBar()?.setData({hidden:true})` + `opacity + translateY(120%) + pointer-events:none`。
- **WXSS 不支持通用选择器 `*`**（如 `.field-row > *`），会导致编译中断整个页面渲染；用显式 BEM 类名。
- 图标用 `miniprogram/assets/icons/*.svg`（32×32 圆角底 + 24 栅格线稿，`<image mode="aspectFit">`）；
  状态色：在库/编辑=绿、临期/提醒=琥珀、过期/删除=红、已用完=蓝。

## 目录速记
- `miniprogram/pages/quick-entry/`：AI 快速录入页（草稿卡、日期/保质期模式切换）。
- `miniprogram/pages/item-form/`：手动录入表单页，`.field` 等样式在此页 wxss 局部定义，未全局化。
- `docs/quick-entry-acceptance.md`（验收现状，含"未开通"能力结论）、`docs/cloud-deployment.md`（部署与密钥配置）。
