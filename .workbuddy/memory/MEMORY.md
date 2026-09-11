# freshKeeper 项目长期记忆

## 环境与流程
- 原生小程序 TS + WXSS + 云开发；vitest 锁 **3.2.7**（4/5.x 报 `Cannot read properties of undefined (reading 'config')`）。
- **bash 不可用**（`ls`/`cat`/`sed` 全 command not found，`npm run check` 报 `/usr/bin/env: bash`）。
  npm 脚本走 PowerShell，且必须用完整路径：
  `& 'C:\Users\BYS\AppData\Local\Programs\PowerShell\7\pwsh.exe' -NoProfile -Command '...'`（禁止 powershell.exe；
  stdout 会被吞，先 `Out-File` 落盘再 Read）。
- **删文件**必须 PowerShell + `dangerouslyDisableSandbox`，删完 `Test-Path` 复核（沙箱内静默失效，沙箱外 genie-trash SAFE_DELETE_FAIL_CLOSED）。
- `.gitignore` 有 `node_modules/`、`*.log`、`coverage/`、`project.private.config.json`；`check-output.log`/`test-new.log` 是被跟踪的历史文件。
- 同文件别并行发多个 Edit（互相覆盖）；Write 前先 Read。
- 流程：`npm run check`（typecheck + test + check:project）→ commit → push
  `git@github.com:yangxl12/freshKeeper.git`（SSH 常被代理拦，第一次失败就只提交、让用户代推）。

## Git
- **绝不 `git stash push -- <path>`**（曾删空 `.git/refs`）。恢复：`mkdir -p .git/refs/{heads,tags,remotes}` →
  `git ls-remote origin` → `git fetch origin` → `git update-ref`。
- `fatal: bad object HEAD` → 先 `git ls-remote origin`，远端有就 `git fetch origin`。基线对比用 `git show HEAD:<path>`。

## 云函数 / 部署（CLI `D:\微信web开发者工具\cli.bat`）
- `config.json` 的 `timeout`/`envVariables`/`triggers` 只在**首次创建**时写入云端，deploy 只更新代码
  → 建完必须去控制台改超时（默认 3s，重函数 60s）。
- 首建偶发 `UpdateFunctionCode 当前函数处于 Creating 状态` → 等 45s 重跑同一条命令。
- `cli.bat cloud functions list|info|deploy --env cloud1-d0gkh66ce94b1be08 --names <fn> --project D:/myProject/freshKeeper [--remote-npm-install]`。
- 本地调试无网关注入，`cloud.ai()` 必 404；`ai-client.js` 用 `TENCENTCLOUD_RUNENV === 'WX_LOCAL_SCF'` 跳过
  （逃生门 `QUICK_ENTRY_AI_LOCAL_DEBUG=true`）。

## 模拟器验收（真调云函数）
1. `cli.bat auto --project "D:/myProject/freshKeeper" --auto-port 9420 --trust-project`。
2. 起 `wechat_devtools_mcp/scripts/dist/daemon.bundle.js`（cwd 为其 scripts/），`{"ready":true}` 后发 NDJSON
   `{"id":1,"script":"run_test_script","args":["--port","9420","--script","<探针>","--timeout","90"]}`。
3. 探针 `module.exports = async (mp) => mp.evaluate(...)`，模板 `C:/Users/BYS/AppData/Local/Temp/wx-probe/`。
4. 云函数回 `{ok,data,requestId}` → 探针取 `res.result.data.xxx`；`save` 的 `idempotencyKey` 须标准 UUID v4。
5. `page.$` / `element.tap()` 可用：`mp.currentPage()` → `page.setData(...)` → `page.$('.sel')` → `tap()` → `page.data('k')`。
   `getCurrentPages()[i].data` 只有 `__webviewId__`，别用它断言页面数据。必须 TAP 手势的 API（`shareFileMessage` 等）
   只能真点，`evaluate` 不算点击；页面没日志时在 `mp.evaluate` 里先钩原生 API 包一层抓 `errMsg` 再点。
6. 探针**超时后会在后台继续跑**：立刻重跑会两个探针操作同一账号、结果自相矛盾 → 先等它跑完。
7. **怀疑平台 API 行为先探针实测**，别推理。
8. 云函数 `INTERNAL_ERROR` 吞掉真堆栈（`normalizeError` 只留 code+message）：临时在 catch 里加
   `debug: String(error.stack).slice(0,400)`，部署后跑探针看真因，**用完必须撤掉并复核线上**。

## 云数据库（wx-server-sdk）
- **不能往 `null` 字段创建子字段**：`update({data:{a:{b:1}}})` 在 `a` 为 null 时报
  `Cannot create field 'b' in element {a: null}` 且整条失败（update 把对象值当嵌套路径写）
  → 多字段状态一律拆扁平字段，`null` 只用于扁平标量（`nickname:null` 一直安全）。
- `db.command.remove()` 会污染注入式假 db → 本项目一律扁平字段 + `null` 绕开。

## 用户体系（docs/user-account-plan.md、docs/user-profile-plan.md）
- 集合 `users`（`_id`=OPENID + 冗余 `ownerId`）+ 云函数 `userApi`（index/error/validation/date/account.js）。
- 核心逻辑在注入式 `account.js:createAccountService({db, deleteFile, uploadFile})`，只有 `index.js` require `wx-server-sdk`（单测注入假 db）。
- action：`touch`（同日双层节流）/ `get` / `updateProfile` / `createAvatarUpload` / `exportData` / `confirmExport` / `deleteAccount`。
- 导出：`wx.shareFileMessage` **只认 TAP 手势**（调用栈不能有 await）→ 按钮必须两步；额度计「交付成功」（3/天，
  `confirmExport` 才 +1），未交付的当天文件用 `exportPendingFileId/FileName/Date` 复用。
- 注销：收集 coverFileId + 头像 fileID → `deleteFile`（50/批）→ remove 四个集合；20 轮上限抛 `DELETE_INCOMPLETE`；重试幂等、不留墓碑。
- 业务错误码**只在 `error.code`**，测试断言 `error.code`，别 `toThrow('CODE')`。
- 客户端 `services/user-service.ts`；同日节流收在 app.ts 的 `touchUserOnceToday()`；
  `utils/shanghai-time.ts:shanghaiTodayKey()` 给上海日期串。结果提示一律 modal（toast 超 7 汉字截断）。

## 批量操作（pages/batch-operation）
- 入口靠 `app.globalData.pendingBatchIntent`（`{source, search?, category?, viewStatus?}`）传参，
  `?source=trash|home|inventory` 定范围；`source=trash` → 标题「回收站批量操作」、只显示「彻底删除」+「取消」。
- 入口现状：`home`（更多菜单）、`mine → 回收站 → 批量管理`（带当前 `trashSearch`）。新增入口照抄这个套路。
- 云端 `validateBatchItems` 上限 **20 条/批**，客户端 `CHUNK_SIZE = 20` 必须对齐；`batchPermanentDelete` 走同一个 `processBatch`。
- 失败项按 `CONFLICT`（版本变了）回填并保留选中，成功后把成功项从本地列表摘掉。
- `mine` 回收站是弹窗（不是页面），从批量页返回不会重建，**必须在 `onShow` 里判 `activeModal === 'trash'` 重拉**。

## 快速录入
- 三档能力：`config/runtime.ts:QUICK_ENTRY_FEATURES` → 云端 `getCapabilities()`（voice/datePhoto/aiText）→ 云函数急停 `QUICK_ENTRY_AI_ENABLED`。
- 不可用按钮**必须置灰 + 静态说明**（`unavailableHints`），别 toast；入口函数开头 `if (!capabilities.x) return` 是第二道保险。
- 语音/拍日期不可用根因：云端没配 `QUICK_ENTRY_TENCENT_SECRET_ID`/`_SECRET_KEY`（密钥只能进控制台）；
  语音是点击开始/点击结束，`moveVoice`/`voiceBounds` 是死代码。
- 「从最近录入添加」= 独立页面 `pages/recent-entry/index`，回传走 eventChannel `pickedDrafts` → `appendRecentDrafts()` 整批前插；
  弹窗开关判 `editorOpen`，别判 `editingIndex >= 0`。
- `MAX_DRAFTS = 20`（草稿条数）≠ 云端「一次最多 5 条」（单次解析输出）。
- 草稿编辑是底部弹窗（82vh），复用 `item-form-sheet`（`purpose="draft"` 时不渲染自己的 save-bar），点「完成」才回写，带改动退出二次确认。
- `item-form-sheet` 的「到期日期 ↔ 保质期计算」切换**只切 mode，不清另一侧字段**（下游三处按 mode 归一化）。
- 「已过期」用 `expiredFlags`（先过滤 `/^\d{4}-\d{2}-\d{2}$/` 再比），别拿中文占位比大小。
- `.quick-input` 开 `hold-keyboard`，"输入完就干活"的分支要 `blurQuickInput()`；原生 textarea 别设大 `line-height`（Android 光标错位根因）。

## AI 解析（docs/ai-parse-plan.md；ai-parse-research.md 已过时）
- `cloud.ai()` **provider 必须 `hunyuan-v3`**（不是 cloudbase），模型 `hy3`；名字只准出现在 `ai-client.js`。
- 两条铁律：① 不让模型算日期（只出 `dateFacts`，换算在 `date-facts.js:normalizeFacts()`）；
  ② 证据回链防幻觉（字段带 `evidence`，不在原文就置 null 走 `confirmationFields`，绝不静默入库）。
- 降级链 AI → 自定义 provider → 本地 `rules-v3`；单环境 5 并发（`EXCEED_CONCURRENT_REQUEST_LIMIT` 退避 300ms 重试一次）；
  AI 超时默认 6000ms，必须 < 前端 8s `Promise.race`。`createDraftFromParsed` 第 6 参是 `parserVersion`。
- `applyPrefill` 后迟到的 `loadDefaults(null)` 会覆盖 `reminderLeadDays` → 组件用 `data.prefilled` 挡。
- 待办：`quickEntryApi` 超时 60s、隐私指引补「输入发送至大模型」、快录存储清理、ASR/OCR 计费。

## 封面生图（inventoryApi generateCover）
- `cloud.ai().createImageModel('hunyuan-image').generateImage(...)` → `data[0].url`（临时 URL，要转存云存储）。
- model 必须 `HY-Image-3.0-Plus-4090-Tob-v1.0`；必须显式 `revise:{value:false}` / `enable_thinking:{value:false}`，否则必撞超时。出图约 5.8s。
- prompt 写「背景纯白，主体周围不要阴影」，别写「贴纸风格」（出灰底方块）。
- 扩展名按**文件头魔数**嗅探（URL 无后缀、Content-Type 谎报 image/png）；`cloud.init({timeout:45000})` 是 SDK 单次 HTTP 超时。
- 落 `coverFileId`（cloud://）**不 bump version**（避免并发 CONFLICT）；急停 `COVER_IMAGE_ENABLED`；函数需 60s；
  保存成功后 fire-and-forget，失败静默用占位图。
- 回填走 `inventory-service.ts:onItemCoverReady()` 广播，首页 onShow 订阅 / onHide 退订。

## 提醒授权开关
- 订阅消息授权是**系统级状态**：读 `wx.getSetting({withSubscriptions:true})`，改只能 `wx.openSetting({withSubscriptions:true})`。
- 判据收在 `services/reminder-service.ts:resolveReminderAuthorization`（纯函数 + 单测，共用别各写一份）：
  `mainSwitch===false` → 未授权；`itemSettings[模板ID]` 为 `reject`/`ban` → 未授权；`mainSwitch===true` → 已授权；其余未授权。
- 开关**不落本地状态**：`bindchange` 不读 `event.detail.value`，只弹窗引导；回弹用 `authSwitchRebuilding` + `wx:if` 卸载重建。

## UI / 工程约定
- 自定义 tabBar（`tabBar.custom:true`，z-index 900）遮不住时加 `hidden` 态：`getTabBar()?.setData({hidden:true})` + `opacity` + `translateY(120%)` + `pointer-events:none`。
- **WXSS 不支持通用选择器 `*`**（`.field-row > *` 会中断编译、整页白屏）→ 用显式 BEM 类名。
- `item-form-sheet` 是 isolated（`index.json` 只有 `{"component":true}`），app.wxss 进不来，样式自带。
- 图标 `miniprogram/assets/icons/*.svg`；状态色：在库/编辑=绿、临期/提醒=琥珀、过期/删除=红、已用完=蓝。
- 数量编辑态 ± 按钮收起让位，宽度按字数分档（56/76/96/116rpx）inline 下发；反馈 = 数字动效 + `wx.vibrateShort(light)`。
  **改这两处要同步 `tests/unit/inventory-row.test.ts`。**
- 页面测试的假 setData 是 `Object.assign`，不认 `drafts[0]` 路径 key；验证路径 setData 要自己捕获 patch。
