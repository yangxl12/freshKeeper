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

## 目录速记

- `miniprogram/pages/quick-entry/`：AI 快速录入页，含草稿卡片、日期/保质期模式切换。
- `miniprogram/pages/item-form/`：手动录入表单页，字段样式（`.field` 等）主要在此页级 wxss 定义，未全局化。
