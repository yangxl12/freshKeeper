# freshKeeper 项目长期记忆

## 约定与本机踩坑
- 微信小程序原生 TS + WXSS + 云开发 cloudfunctions；vitest **必须 3.2.7**（4/5.x 报
  `Cannot read properties of undefined (reading 'config')`）；package.json 不单独锁 vite。
- 改完跑 `npm run check`（typecheck + test + check:project）→ commit → push
  `git@github.com:yangxl12/freshKeeper.git`；SSH 常被代理拦（127.0.0.1:7888 未监听），第一次 push 失败就只提交让用户代推。
- **本机 bash 缺 coreutils**（`sed`/`head`/`wc` 都没有）→ 用 PowerShell；PowerShell 的 stdout 会被吞，
  命令输出要 `Out-File` 落盘再 Read。
- **同一文件不要在一次消息里并行发多个 Edit**，会互相覆盖丢改动；顺序改。

## Git 踩坑
- **绝不 `git stash push -- <path>`**：曾删空 `.git/refs`（git 报 not a repository、文件全变 A）。
  恢复：`mkdir -p .git/refs/{heads,tags,remotes}` → `git ls-remote origin` 取 sha → `git fetch origin` → `git update-ref`。
  对比基线用 `git show HEAD:<path>`。
- `fatal: bad object HEAD`：先 `git ls-remote origin`，远端有就 `git fetch origin` 拉回。

## 云函数部署
- `config.json` 的 `timeout`/`envVariables`/`triggers` **只在函数首次创建时写入云端**，之后 deploy 只更新代码；
  改超时/环境变量只能去云开发控制台（CLI 无该命令）。默认超时 3s，调 LLM 的函数上线先改 60s。
- 「云函数本地调试」没有网关注入，`cloud.ai()` 必 404（`AI_PARSE_DEGRADED` + `reason:"404"`）；
  `ai-client.js` 用 `TENCENTCLOUD_RUNENV === 'WX_LOCAL_SCF'` 识别并跳过 AI（逃生门 `QUICK_ENTRY_AI_LOCAL_DEBUG=true`）。
  验证 AI 只能走云端。

## 模拟器验收（真调云函数）
1. `cli.bat auto --project "D:/myProject/freshKeeper" --auto-port 9420 --trust-project`。
2. 起 `~/AppData/Local/uv/cache/archive-v0/<hash>/wechat_devtools_mcp/scripts/dist/daemon.bundle.js`（cwd 为同目录 scripts/），
   `{"ready":true}` 后发 NDJSON `{"id":1,"script":"run_test_script","args":["--port","9420","--script","<探针>","--timeout","90"]}`。
3. 探针 `module.exports = async (mp) => mp.evaluate(...)`；模板见 `C:/Users/BYS/AppData/Local/Temp/wx-probe/`。
4. 云函数回 `{ok, data, requestId}`，探针取值必须 `res.result.data.xxx`；`save` 的 `idempotencyKey` 必须是标准 UUID v4。
5. automator 的 page node 会失效（截图全白），但 `miniProgram.evaluate` 仍可用；该形态 `getCurrentPages()[i].data`
   只有 `__webviewId__`，读不到业务字段，别用它断言页面数据。
6. **怀疑平台 API 行为先探针实测**（`evaluate` 里包 Promise 调 `wx.xxx`），别推理。

## 快速录入
- 能力三档：① `QUICK_ENTRY_FEATURES`（`config/runtime.ts`）决定按钮显不显示；② 云端 `getCapabilities()` 回
  `voice`/`datePhoto`/`aiText` 决定能不能用；③ `QUICK_ENTRY_AI_ENABLED` 是云函数急停。
- 不可用的按钮**必须置灰 + 静态说明**（`unavailableHints`，`preparePage` 生成），别弹 toast
  （微信 toast 超 7 个汉字被截断，被用户吐槽过）；`startVoice`/`chooseDatePhoto` 开头的
  `if (!capabilities.x) return` 是第二道保险，静默。
- 语音/拍日期不可用的根因：云端没配 `QUICK_ENTRY_TENCENT_SECRET_ID`/`_SECRET_KEY`（ASR 一句话识别 + OCR 高精度版），
  密钥只能进控制台。语音是**点击开始/点击结束**，`moveVoice`/`voiceBounds` 是死代码。
- 「从最近录入添加」是**独立页面** `pages/recent-entry/index`（原生导航栏返回 + 搜索 + 多选），
  quick-entry 只 `navigateTo`，回传走 eventChannel `pickedDrafts` → `appendRecentDrafts()` 整批前插。
  弹窗开关判独立的 `editorOpen`，别判 `editingIndex >= 0`（新选草稿还没进 picked，下标是 -1）。
  quick-entry 保留 `recentProfiles` 仅为识别结果匹配分类/位置；`listRecentProfiles` 的
  `INVALID_ACTION` 降级（`listInventory(sort:'created_desc')` + `recentProfilesFromItems()`）在 service 层。
- `MAX_DRAFTS = 20` 是草稿条数上限（达到后「从最近录入添加」置灰）；云端「一次最多 5 条」是单次解析的输出上限，两码事。
- 草稿编辑是**底部弹窗**（遮罩 + 82vh 面板），里面只复用 `item-form-sheet`（`purpose="draft"` 时组件不渲染自己的
  save-bar）；按钮由弹窗持有，点「完成」才经 `applyFormValuesToDraft` 回写草稿，带改动退出二次确认。
  新草稿整批插到列表最前。
- 「已过期」用 `expiredFlags`（`getExpirySummary()` 先过滤 `/^\d{4}-\d{2}-\d{2}$/` 再比），别拿中文占位「待补到期日」比大小。
- `.quick-input` 开了 `hold-keyboard`，任何"输入完就干活"的分支都要 `blurQuickInput()`
  （`wx.hideKeyboard` + `quickInputFocused:false`）；**别给原生 textarea 设大 `line-height`**
  （Android 光标与 placeholder 错位的根因），居中靠对称内边距。
- 页面测试的假 setData 是 `Object.assign`，不认 `drafts[0]` 路径 key，验证路径 setData 要自己捕获 patch。

## 快速录入：AI 解析
- 云函数端 `wx-server-sdk`(4.0.2) 的 `cloud.ai()`，**provider 必须 `hunyuan-v3`**（不是 `cloudbase`），模型用 `hy3`；
  provider/模型名只准出现在 `ai-client.js`。
- 两条核心设计别丢：① 不让模型算日期（只出 `dateFacts`，换算交 `date-facts.js:normalizeFacts()`）；
  ② 证据回链防幻觉（每字段带 `evidence`，服务端校验不在原文就置 null 走 `confirmationFields`，绝不静默入库）。
- 降级链 AI → 自定义 provider → 本地 `rules-v3`；免费额度耗尽直接报错；单环境 5 并发
  （`EXCEED_CONCURRENT_REQUEST_LIMIT` 退避 300ms 重试一次）。AI 超时 `QUICK_ENTRY_AI_TIMEOUT_MS`
  （默认 6000，必须 < 前端 `recognizeTextItems` 的 8s `Promise.race`）。
- `createModel('hunyuan-v3')` 不在 `@cloudbase/ai` MODELS 表 → 走 DefaultSimpleModel，
  URL `…/v1/ai/hunyuan-v3/chat/completions`，正常路径。
- `createDraftFromParsed` 第 6 参是 `parserVersion`；AI 缺失字段**故意不写进 `confirmationFields`**；
  `recognizeTextItems` 回 `{ items, parserVersion }`。
- `applyPrefill` 之后 `attached` 时发出的 `loadDefaults(null)` 会迟到覆盖 `reminderLeadDays`：
  组件用 `data.prefilled` 挡（2026-09-11 修）。
- 文档 `docs/ai-parse-plan.md`；`docs/ai-parse-research.md` 已过时。
- 待办：`quickEntryApi` 超时 60s、隐私指引补「输入发送至大模型」、`quick-entry/` 存储生命周期清理、ASR/OCR 计费。

## 封面生图（inventoryApi generateCover）
- `cloud.ai().createImageModel('hunyuan-image').generateImage(...)` → `data[0].url`（临时 URL，必须下载转存云存储）；
  provider/模型名只在 `cloudfunctions/inventoryApi/image-cover.js`。
- **model 必须 `HY-Image-3.0-Plus-4090-Tob-v1.0`**（`hunyuan-image` 作为 model 已 2026-07-15 下线，provider 名不变）；
  **必须显式 `revise:{value:false}`/`enable_thinking:{value:false}`**，否则 +10~60s 必撞超时。
- prompt 别写「贴纸风格」（会出灰底方块），写「背景是纯白色，主体周围不要阴影」；出图约 5.8s。
- 扩展名按**文件头魔数**嗅探：字节实测是 JPEG，但 URL 无后缀、Content-Type 谎报 `image/png`。
- `cloud.init({ timeout: 45000 })` 是 SDK 单次 HTTP 超时（默认约 15s），不是云函数超时。
- 落 `coverFileId`（cloud://）、**不 bump version**（展示数据，避免并发编辑 CONFLICT）；同名复用；
  急停 `COVER_IMAGE_ENABLED`；生图 30s/下载 10s（函数需 60s）。保存成功后 fire-and-forget，失败静默用占位图。
- 封面回填：`inventory-service.ts:onItemCoverReady(listener)` 广播 `{itemId,coverFileId}`，
  首页 onShow 订阅 / onHide 退订后 `patchItem`，别用轮询或延迟二次刷新。

## 提醒授权开关
- 订阅消息授权是**系统级状态**：来源固定 `wx.getSetting({withSubscriptions:true})`，
  改状态只能 `wx.openSetting({withSubscriptions:true})`，小程序写不进也关不掉。
- **不能只看 `mainSwitch`**：用户单独关掉「临期提醒」模板时 mainSwitch 仍是 `true`，只有 `itemSettings[模板ID]`
  变 `reject`。判据：`mainSwitch===false` → 未授权；`itemSettings[模板ID]` 为 `reject`/`ban` → 未授权；
  `mainSwitch===true` → 已授权；其余（不下发）→ 未授权。官方限制：`itemSettings` 只含用户勾过
  「总是保持以上选择」的模板，本项目走逐件授权属常态。
- 实现收在 `services/reminder-service.ts:resolveReminderAuthorization`（纯函数，有单测），
  「完整录入」与「我的—提醒设置」共用，别再各写一份。
- 开关**不落任何本地状态**：`bindchange` 不读 `event.detail.value`，只弹窗 + 引导去系统页；
  回弹用 `authSwitchRebuilding` + `wx:if` 卸载重建（放在遮罩盖住表单之后）。

## UI / 工程约定
- 自定义 tabBar（`app.json` `tabBar.custom:true`，z-index 900）遮罩盖不住时别硬提 z-index，加 `hidden` 态：
  `getTabBar()?.setData({hidden:true})` + `opacity` + `translateY(120%)` + `pointer-events:none`。
- **WXSS 不支持通用选择器 `*`**（如 `.field-row > *`），会导致编译中断、整页渲染不出来；用显式 BEM 类名。
- `item-form-sheet` 被完整录入/快录的完整录入 tab/草稿编辑/重新入库共用；`index.json` 只有 `{"component": true}`
  → isolated，app.wxss class 进不来，样式必须自带。
- 图标 `miniprogram/assets/icons/*.svg`（32×32 圆角底 + 24 栅格线稿）；
  状态色：在库/编辑=绿、临期/提醒=琥珀、过期/删除=红、已用完=蓝。
