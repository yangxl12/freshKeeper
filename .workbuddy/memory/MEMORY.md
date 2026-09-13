# freshKeeper 长期记忆

> 细节在 docs/，这里只放「不知道就会踩坑」的结论。
> 文档索引：上线手工项 `docs/launch-checklist.md`｜云环境 `docs/cloud-deployment.md`｜埋点 `docs/analytics-events.md`｜性能 `docs/performance-analysis.md`

## 工具链
- 原生小程序 TS + WXSS + 云开发。vitest 锁 **3.2.7**（4/5.x 报 config undefined）。
- bash 沙箱是坏的（`ls`/`dirname` 报 command not found，exit 127）→ 文件操作一律用 PowerShell 工具。
- PowerShell 跑 npm 会吞 stdout：`npm run check *>&1 | Out-File -Encoding utf8 .cN.txt` 再 Read。
  **每轮换文件名**（同名 Read 会读到上一轮的旧内容）。中文输出乱码，断言靠 ASCII 关键字定位。
- 临时文件 `.cA*.txt` / `.commitmsg.txt` 已在 `.gitignore`；但先 `git add -A` 再写 commitmsg 仍会带上，注意顺序。
- 删未跟踪文件 `git clean -fx -- <路径>`（Remove-Item 静默失效）；删已跟踪目录必须 `git rm -r -f`。
- `.git/index.lock` 残留 → 所有 git 命令报 `File exists`，确认无其他 git 进程后删锁文件。
- 同文件别并行 Edit（互相覆盖）；Write 前先 Read。

## Git
- **红线：绝不 `git stash push -- <path>`**（曾删空 `.git/refs`）。
- push 走 HTTPS + 代理 127.0.0.1:7888。失败时 exit 128 且 stdout/stderr **全空** = GCM 拿不到凭据
  （不是网络问题），**别反复重试**，等龙哥触发一次 OAuth 授权。**第一次 push 失败就只提交**。
- 提交中文：Write `.commitmsg.txt` 再 `git commit -F .commitmsg.txt`（`-F -` 拿不到 stdin）。

## 云函数
- `config.json` 的 timeout/envVariables/triggers **只在首次创建**时写云端，deploy 只更新代码
  → 建完必须去控制台改（新环境默认 **3s**；`quickEntryApi` / `userApi` 要 **60s**）。
- CLI：`D:\微信web开发者工具\cli.bat cloud functions deploy --env cloud1-d0gkh66ce94b1be08
  --names <fn> --project D:/my-project/freshKeeper`，**必须加 `--remote-npm-install`**。
  不加会把本地残缺的 `node_modules`（2982 文件 / 3.2 MB，缺 `@cloudbase/node-sdk`）整包传上云端，
  函数**每次调用都崩**，客户端只报统一的「服务暂时不可用」——2026-09-13 真踩过，别省。
  加 `-r` 后是 12 文件 / 34 KB。报 `当前函数处于Updating状态` → 等 60~75s 重跑。
- **改完云函数必须真的部署**：云端常年落后本地（`inventoryApi` 曾停在 1cec0b4 之前，
  导致首页概览字段压根没回传）。查漂移：`cli.bat cloud functions download --env <env> --name <fn>
  --path <临时目录> --project <项目>`，再和本地 diff / grep。
- 本地调试没有网关注入，`cloud.ai()` 必 404（代码已按 `WX_LOCAL_SCF` 自动跳过；逃生门
  `QUICK_ENTRY_AI_LOCAL_DEBUG=true`）。**验证 AI 路径只能走云端**。
- `INTERNAL_ERROR` 吞真堆栈：临时在 catch 加 `debug:String(error.stack)`，**用完必须撤掉**。

## 模拟器验收
- `cli.bat auto --project <项目> --auto-port 9420 --trust-project` 开自动化端口，然后**直连**
  `ws://127.0.0.1:9420` 发 NDJSON `{id,method,params}`（Node 22 内置 `WebSocket` 即可，无需装包）。
  可用方法：`App.getPageStack` / `Page.getData` / `Page.setData` / `Page.callMethod` /
  `App.callWxMethod`（如 `getStorageSync`、`getImageInfo`、`removeStorageSync`）。
  **不可用**：`App.evaluate`、`App.callFunction`（参数形态对不上）、`Page.screenshot`（webview unimplemented）、
  `Page.getElements`/`Page.getElement`（本机报 `appservice ... unimplemented`，且不穿透自定义组件）。
- 页面能不能修好，就发 `Page.callMethod refresh true false` 再 `Page.getData` 看数据。
  **验图片/URL 用 `App.callWxMethod getImageInfo {src}`**：成功=能显示，`file not found`=显示不出来。
- 复现故障态不用重启：`Page.callMethod invalidateOverview` + `Page.setData {overview:null}`。
- 探针取 `res.result.data.xxx`；`save` 的 idempotencyKey 须标准 UUID v4。
- 必须 TAP 手势的 API（shareFileMessage）只能真点，`evaluate` 不算点击。
  探针超时后仍在后台跑，立刻重跑会自相矛盾。平台行为先实测，别推理。

## 云数据库
- **不能往 `null` 字段创建子字段**（update 当嵌套路径处理，整条失败）→ 多字段状态一律拆**扁平字段**。
- 索引**没有 API**，只能控制台手点；开发/生产**各建一次**；字段顺序不能换、**别勾唯一**。表见 cloud-deployment.md §2。

## 模块铁律
- **用户体系**：`users`(`_id`=OPENID) + `userApi`；核心在注入式 `account.js`。
  设置已并入（`settings.js`，`settingsApi` 已删；前端 `settings-service.ts` **必须与云端一起发布**）。
  业务错误码只在 `error.code`。同日节流在 `app.ts:touchUserOnceToday()`。
- **批量**：云端上限 **20/批**，客户端 `CHUNK_SIZE=20` 必须对齐；入口 `globalData.pendingBatchIntent`。
  批量页 `loadAll` 每 100 条才 setData（原来每页一次 = O(N²)）。
- **快录**：`config/runtime.ts:QUICK_ENTRY_FEATURES` → 云端 `getCapabilities()` → 急停 `QUICK_ENTRY_AI_ENABLED`。
  不可用按钮**置灰别 toast**。`MAX_DRAFTS=20` ≠ 云端一次 5 条。草稿编辑复用 `item-form-sheet`。
- **AI 解析**：provider 必须 `hunyuan-v3` / 模型 `hy3`，名字只准出现在 `ai-client.js`。
  铁律：① 不让模型算日期（只出 `dateFacts`，`date-facts.js` 归一化）；② 证据回链防幻觉。
  降级 AI → 自定义 → `rules-v3`；AI 超时 6000ms < 前端 8s `Promise.race`。
- **封面生图**：model `HY-Image-3.0-Plus-4090-Tob-v1.0`，必须显式 `revise/enable_thinking=false`。
  落 `coverFileId` **不 bump version**；保存后 fire-and-forget；回填走 `onItemCoverReady()` 广播。
  ⚠️ **`cloud://` fileID 不支持拼图片处理参数**：`fileID + '?imageView2/...'` 实测 `file not found`
  → `<image>` onError 回退占位图（= 2026-09-13「首页封面消失」事故，466294a 回滚）。
  列表与详情页现在都用原 fileID（`coverThumbUrl` 的 `COVER_THUMB_QUERY` 为空）。
  真要做缩略图必须两条同时满足：`getTempFileURL` 转 https **且** 云存储开通「图像处理」扩展。
  `inventory-row` 的 observer 判据始终是原图 `coverFileId`（`coverFor`），这点不变。
- **列表**：`MAX_LIST_ITEMS=200` + `canLoadMoreItems()`。游标是**复合键**（`encodeKeyCursor`，payload `v:2`，
  键 `(expiryDate, createdAt)`，`createdAt` 走 `toIsoKey()`）；旧 offset 游标判 `INVALID_CURSOR`；
  `created_asc` 用 `gt`、其余用 `lt`。`listHistory`/`listTrash` 仍用老 offset 游标。
- **首页概览**：`home_overview_cache` + `overviewDirty` + SWR；写操作必须调 `invalidateOverview()`。
  **跨日失效靠比 `shanghaiTodayKey()`，不靠 setTimeout**。概览改由 `listInventory` 首屏顺带回传（`withOverview`）。
  **两条兜底缺一不可**：列表失败时、以及列表成功但没回传 `overview` 时，都要 `refreshOverview({force:true})`
  —— 少一条，顶部四张卡就停在骨架态（真踩过）。
- **概览统计**：`aggregateOverview()` 一次投影 + `limit(1000)` 内存算，满 1000 才退回 `countOverview()`。
  **别改成分页 skip 累积**（比 count 更贵）。
- **最近档案**：`recent.js:readRecentProfilesOnce`，按 `updatedAt DESC` 取 100 条内存去重。
  查询**必须**带 `inventoryStatus: command.in(PROFILE_STATUSES)`（否则回收站物品会进快录建议）；命中老索引，无需新建。
- **提醒**：手机端全去开关化。时间 = 到期日 − 提前天数，**当天 09:30** 推；纯函数 `domain/reminder-time.ts`；
  授权只在保存物品时申请，排在 `triggerEvent('saved')` 之前；模板字段映射**三处必改**。
  坑：`Number(null)===0`。未来时刻测试用例用 **2099 年**。派发已并发化（`JOB_CONCURRENCY=8`），
  claim 用条件更新保证幂等。
- **写操作**：`transition`/`moveToTrash`/`removePermanently`/`restore` 在 `inventoryApi/writes.js`（注入式），
  范式是「读一次 + `where({_id,ownerId,inventoryStatus,version})` 条件更新」，**已去事务**。
  ⚠️ `save`/`saveIdempotent` **仍用事务**（保护提醒改期 + 幂等键），别顺手也去掉。`processBatch` 并发 5。
- **埋点**：只走 `wx.reportEvent`（We 分析），统一经 `utils/analytics.ts` 的 `track()`/`trackDuration()`，
  **别在业务代码里直接调 `wx.reportXxx`**（绕过封装的事件不会进清单）。字段一律 snake_case，
  且必须与后台属性 ID 完全一致。

## UI / 工程
- 自定义 tabBar `z-index:900`；遮不住时加 `hidden` 态。
- **WXSS 不支持通用选择器 `*`**（会中断编译整页白屏）→ 显式 BEM 类名。
- 状态色：在库/编辑=绿、临期/提醒=琥珀、过期/删除=红、已用完=蓝。
- 页面测试的假 setData 是 `Object.assign`，不认 `drafts[0]` 这种路径 key。
- 图标在 `miniprogram/assets/icons/*.svg`。
