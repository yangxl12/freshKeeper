# freshKeeper 长期记忆

## 环境
- 原生小程序 TS + WXSS + 云开发；vitest 锁 **3.2.7**（4/5.x 报 config undefined）。bash 不可用（ls/cat command not found）。
- npm 脚本必须走：`& 'C:\Users\BYS\AppData\Local\Programs\PowerShell\7\pwsh.exe' -NoProfile -Command '...'`（禁 powershell.exe；stdout 会被吞，先 Out-File 再 Read）。
- 删文件只认 `git clean -fx -- <明确路径>`（Remove-Item 静默失效）。
- 同文件别并行 Edit（互相覆盖）；Write 前先 Read。
- 流程：`npm run check` → commit → push `git@github.com:yangxl12/freshKeeper.git`（SSH 常被代理拦，第一次失败就只提交、让用户代推）。

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
- **提醒**：手机端全去开关化。提醒时间 = 到期日 − 提前天数，**当天 09:30** 推；纯函数 `domain/reminder-time.ts`。授权只在保存物品时申请，排在 `triggerEvent('saved')` 之前。前端拦截只看日期。`reminderApi` 只有 arm；`dispatchReminders` 触发器 09:30 只处理 `remindDate===today`。模板字段映射写死在代码里（三处必改：`config/runtime.ts`、`reminderApi/index.js`、`dispatchReminders/template.js`），模板 ID 仍是占位。坑：`Number(null)===0`。未来时刻测试用例用 **2099 年**。

## UI / 工程
- 自定义 tabBar `z-index:900`；遮不住时加 `hidden` 态（`getTabBar()?.setData({hidden:true})`）。
- **WXSS 不支持通用选择器 `*`**（会中断编译整页白屏）→ 显式 BEM 类名。
- 图标 `miniprogram/assets/icons/*.svg`；状态色：在库/编辑=绿、临期/提醒=琥珀、过期/删除=红、已用完=蓝。
- 页面测试的假 setData 是 `Object.assign`，不认 `drafts[0]` 路径 key。
