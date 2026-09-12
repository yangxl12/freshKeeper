# freshKeeper 长期记忆

## 环境
- 原生小程序 TS + WXSS + 云开发；vitest 锁 **3.2.7**（4/5.x 报 config undefined）。bash 不可用（ls/cat command not found）。
- npm 脚本必须走：`& 'C:\Users\BYS\AppData\Local\Programs\PowerShell\7\pwsh.exe' -NoProfile -Command '...'`（禁 powershell.exe；stdout 会被吞，先 Out-File 再 Read）。
- 删文件只认 `git clean -fx -- <明确路径>`（Remove-Item 静默失效）。
- 同文件别并行 Edit（互相覆盖）；Write 前先 Read。
- 流程：`npm run check` → commit → push `git@github.com:yangxl12/freshKeeper.git`（SSH 常被代理拦，第一次失败就只提交、让用户代推）。
- **push 失败诊断**：`git push origin <branch> 2> .err.txt` + `$env:GIT_CURL_VERBOSE=1`（直接 `2>&1 | Out-String` 拿不到错误文本，只给 128）。
  2026-09-12 实测 **HTTP 401 + `www-authenticate: Basic realm="GitHub"`** = GCM 拿不出凭据（认证问题，非网络），
  代理隧道是好的（CONNECT 200 / TLS1.3 / edge=japaneast）。需龙哥触发一次 GCM OAuth 授权。
- 临时文件统一 `.xxx.txt` 落盘再 Read（stdout 常被吞）；**读中文测试输出会乱码，断言定位靠 ASCII 关键字**。

## Git 红线
- **绝不 `git stash push -- <path>`**（曾删空 `.git/refs`）。恢复：`mkdir -p .git/refs/{heads,tags,remotes}` → `ls-remote` → `fetch` → `update-ref`。
- `fatal: bad object HEAD` → 先 `git ls-remote origin`，远端有就 `git fetch origin`。
- **「待推送 N 个」先别信**：`git ls-remote origin` 的 `refs/heads/<branch>` 若等于 `git rev-parse HEAD`，就是本地引用坏了，跟提交无关。
  根因是 `.git/refs/remotes/origin/` 目录缺失 + `.git/packed-refs` 残留老值（两条会互相掩盖，`fetch` 也修不回来）。
  2026-09-12 已清掉 packed-refs 那条过期记录（备份 `.git/packed-refs.bak-20260912`）；本环境实测 **git 建不了带斜杠的引用**
  （`git branch a/b` 静默失败），两套 git 版本都复现，去你自己终端验证一次。

## 云函数（CLI `D:\微信web开发者工具\cli.bat`）
- `config.json` 的 timeout/envVariables/triggers **只在首次创建**时写入云端，deploy 只更新代码 → 建完去控制台改超时（默认 3s，重函数 60s）。
- 首建偶发 `Creating 状态` 报错 → 等 45s 重跑。
- `cli.bat cloud functions deploy --env cloud1-d0gkh66ce94b1be08 --names <fn> --project D:/myProject/freshKeeper [--remote-npm-install]`。
- 本地调试无网关注入，`cloud.ai()` 必 404；`ai-client.js` 用 `TENCENTCLOUD_RUNENV==='WX_LOCAL_SCF'` 跳过（逃生门 `QUICK_ENTRY_AI_LOCAL_DEBUG=true`）。
- `INTERNAL_ERROR` 吞真堆栈：临时在 catch 加 `debug:String(error.stack)` 定位，**用完必须撤掉**。

## 模拟器验收（真调云函数）
- `cli.bat auto --auto-port 9420 --trust-project`；起 `wechat_devtools_mcp` daemon，发 NDJSON `run_test_script`。
- 探针取 `res.result.data.xxx`；`save` 的 `idempotencyKey` 须标准 UUID v4。
- `page.$` / `element.tap()` 可用；**必须 TAP 手势的 API（shareFileMessage）只能真点**，`evaluate` 不算点击。
- 探针超时后仍在后台跑，立刻重跑会自相矛盾。怀疑平台 API 行为先实测，别推理。

## 云数据库
- **不能往 `null` 字段创建子字段**（update 把对象当嵌套路径，整条失败）→ 多字段状态一律拆**扁平字段**。
- `db.command.remove()` 污染注入式假 db → 本项目一律扁平字段 + `null`。

## 模块要点
- **用户体系**：`users`(`_id`=OPENID) + `userApi`；核心在注入式 `account.js`；action：touch/get/updateProfile/createAvatarUpload/exportData/confirmExport/deleteAccount。导出 `wx.shareFileMessage` 必须两步按钮，额度 3/天计「交付成功」。业务错误码**只在 `error.code`**。同日节流在 `app.ts:touchUserOnceToday()`。
- **批量操作**：入口靠 `globalData.pendingBatchIntent`，`?source=trash|home|inventory`；云端上限 **20/批**，客户端 `CHUNK_SIZE=20` 必须对齐；`mine` 回收站是弹窗，返回要在 `onShow` 重拉。
- **快录**：`config/runtime.ts:QUICK_ENTRY_FEATURES` → 云端 `getCapabilities()` → 急停 `QUICK_ENTRY_AI_ENABLED`。不可用按钮置灰别 toast。`MAX_DRAFTS=20` ≠ 云端一次 5 条。语音/拍日期不可用 = 云端没配密钥。草稿编辑用 `item-form-sheet`（`purpose="draft"`）。
- **AI 解析**：`cloud.ai()` provider 必须 `hunyuan-v3`／模型 `hy3`，名字只准在 `ai-client.js`。铁律：① 不让模型算日期（只出 `dateFacts`，`date-facts.js` 归一化）；② 证据回链防幻觉。降级 AI→自定义→`rules-v3`；AI 超时 6000ms < 前端 8s `Promise.race`。
- **封面生图**：model `HY-Image-3.0-Plus-4090-Tob-v1.0`，必须显式 `revise/enable_thinking=false`。落 `coverFileId` **不 bump version**；保存后 fire-and-forget；回填走 `onItemCoverReady()` 广播，首页 onShow 订阅 / onHide 退订。
  **列表用缩略图**：`domain/inventory.ts:coverThumbUrl()` 拼 `?imageView2/2/w/200/h/200/format/webp/q/80` 落到卡片 `coverThumb`；
  `inventory-row` 的 observer **封面身份判据仍是原图 `coverFileId`**（`coverFor`），别改成比 `coverThumb`。详情页用原图。
- **列表加载上限**：`MAX_LIST_ITEMS = 200` + `canLoadMoreItems()`，首页/回收站到顶后 `nextCursor` 置 null 并出提示。
- **列表游标是复合键**（2026-09-12 第二批）：`decodeKeyCursor`/`encodeKeyCursor`，payload 带 `v:2`，
  编码上一页最后一条的 `(expiryDate, createdAt)`，`createdAt` 统一走 `toIsoKey()`。旧 offset 游标判 `INVALID_CURSOR`。
  排序方向决定比较方向：`created_asc` 用 `gt`、其余用 `lt`，并列时再比 `createdAt lt`。
  `listHistory` / `listTrash` 仍用老 offset 游标（`decodeCursor`，排序键 `completedAt`）。
- **首页概览缓存**：`pages/home/index.ts` 的 `home_overview_cache` + `overviewDirty` 脏标记 + SWR。
  写操作（数量/完成/删除）必须调 `invalidateOverview()`。**跨日失效靠比 `shanghaiTodayKey()`，不靠 setTimeout**
  （切后台 5 分钟 JS 挂起，`scheduleMidnightRefresh` 基本不会准时触发）。
  **2026-09-12 第二批**：概览改由 `listInventory` 首屏顺带回传（`withOverview`，前端只在缓存不可用时索取），
  `onShow` 已不再单独调 `getOverview`；`refreshOverview({force:true})` 降级为**列表失败时的兜底**。
- **概览统计口径**：云端 `aggregateOverview()` 一次投影查询 `field({inventoryStatus, expiryDate})` + `limit(1000)`
  内存算四个数；拿满 1000 条（失真）才退回 `countOverview()` 的 4 次 count。
  **别改成分页 skip 累积**——1000 件要空扫 5500 条文档，比 count 更贵。
- **最近档案（`listRecentProfiles`）**：主路径 `recent.js:readRecentProfilesOnce(fetchTop)`，跨 active/used_up
  按 `updatedAt DESC` 一次取 100 条再内存去重（原双状态翻页最坏 24 次）。
  **依赖新索引 `ownerId ASC, updatedAt DESC`**，没建就是全量扫描。老的 `readRecentProfiles(fetchPage)` 保留为 fallback。
- **批量页下发**：`batch-operation/index.ts:loadAll` 先累积、每 `EMIT_BATCH_SIZE(100)` 条才 setData（原来每页一次 = O(N²)）。
- **提醒**：手机端全去开关化。提醒时间 = 到期日 − 提前天数，**当天 09:30** 推；纯函数 `domain/reminder-time.ts`。授权只在保存物品时申请，排在 `triggerEvent('saved')` 之前。前端拦截只看日期。`reminderApi` 只有 arm；`dispatchReminders` 触发器 09:30 只处理 `remindDate===today`。模板字段映射写死在代码里（三处必改：`config/runtime.ts`、`reminderApi/index.js`、`dispatchReminders/template.js`），模板 ID 仍是占位。坑：`Number(null)===0`。未来时刻测试用例用 **2099 年**。
  **派发已并发化**：`dispatchReminders/index.js:JOB_CONCURRENCY = 8`（原逐条串行 ≈250s 必超 60s 超时 → 现在 ~32s）。
  claim 用条件更新保证幂等，所以并发安全。日志新增 `remaining` 字段。
- **写操作不再有事务外预读**：`inventoryApi/index.js` 的 save/transition/moveToTrash/removePermanently/restore
  只有事务内那一次读（`getTransactionOwnedDoc` + assert），错误码语义不变，别再加回 `await getOwnedItem`。
  `processBatch` 是 `BATCH_CONCURRENCY = 5` 受控分批（不是一次 20 路并发事务）。

## UI / 工程
- 自定义 tabBar `z-index:900`；遮不住时加 `hidden` 态（`getTabBar()?.setData({hidden:true})`）。
- **WXSS 不支持通用选择器 `*`**（会中断编译整页白屏）→ 显式 BEM 类名。
- 图标 `miniprogram/assets/icons/*.svg`；状态色：在库/编辑=绿、临期/提醒=琥珀、过期/删除=红、已用完=蓝。
- 页面测试的假 setData 是 `Object.assign`，不认 `drafts[0]` 路径 key。
