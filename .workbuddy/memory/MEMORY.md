# freshKeeper 项目长期记忆

## 技术栈与约定

- 微信小程序（原生，TS + WXSS），云开发 cloudfunctions，测试用 vitest。
- 校验命令：`npm run check`（= typecheck + test + check:project），改动后必须跑通。
- 每次对话修改代码后需要 commit 并 push（见 AGENTS.md）。远端为 `git@github.com:yangxl12/freshKeeper.git`；当前沙箱环境 SSH 22 端口被代理拦截，push 会失败，需用户在本地执行。

## 测试环境（踩过的坑）

- **vitest 必须用 3.2.7**（2026-09-08 起）。vitest 5.0.0 / 4.1.11（配 vite 7 或 8）在本机运行全部测试会报
  `TypeError: Cannot read properties of undefined (reading 'config')`（@vitest/runner 全局状态未初始化，
  即 runner 模块被加载成两份），11 个文件全挂。换回 3.2.7 后 11 文件 81 测试稳定通过。
- 排查同类问题时别只清 `node_modules/.vite`、`node_modules/.vite-temp` 缓存——清缓存只是偶尔让单次运行"侥幸"通过，
  根因是 vitest 版本，改版本才彻底解决（记得 `rm -rf node_modules && npm ci`）。
- 不要在 package.json 里单独锁 `vite`，交给 vitest 自己带。

## 快速录入：语音 / OCR 能力开关

- 按钮（语音「按住说」、「拍日期」、草稿卡内联「拍日期」）显示只由 `QUICK_ENTRY_FEATURES`（`miniprogram/config/runtime.ts`）决定，
  **不再受云端 `capabilities` 控制**；服务能力没配（云函数 `providerConfigured('STT'/'OCR')` 返回 false）时点击/按住统一
  `wx.showToast('暂时未接入，敬请期待')`，不申请权限、不启动识别。提示文案常量在页面 ts 里：`PENDING_INTEGRATION_TOAST`。

## WXSS 限制（踩过的坑）

- **WXSS 不支持通用选择器 `*`**（如 `.field-row > *`），会导致编译报错中断整个页面渲染。
  替代方案：给相关子元素加显式 BEM 类名（如 `.field-row__item`）再写规则。
- 同理，写 WXSS 时优先用类选择器，避免通配/属性/复杂选择器。

## 目录速记

- `miniprogram/pages/quick-entry/`：AI 快速录入页，含草稿卡片、日期/保质期模式切换。
- `miniprogram/pages/item-form/`：手动录入表单页，字段样式（`.field` 等）主要在此页级 wxss 定义，未全局化。
