# freshKeeper 项目长期记忆

## 技术栈与约定

- 微信小程序（原生，TS + WXSS），云开发 cloudfunctions，测试用 vitest。
- 校验命令：`npm run check`（= typecheck + test + check:project），改动后必须跑通。
- 每次对话修改代码后需要 commit 并 push（见 AGENTS.md）。远端为 `git@github.com:yangxl12/freshKeeper.git`；当前沙箱环境 SSH 22 端口被代理拦截，push 会失败，需用户在本地执行。

## WXSS 限制（踩过的坑）

- **WXSS 不支持通用选择器 `*`**（如 `.field-row > *`），会导致编译报错中断整个页面渲染。
  替代方案：给相关子元素加显式 BEM 类名（如 `.field-row__item`）再写规则。
- 同理，写 WXSS 时优先用类选择器，避免通配/属性/复杂选择器。

## 目录速记

- `miniprogram/pages/quick-entry/`：AI 快速录入页，含草稿卡片、日期/保质期模式切换。
- `miniprogram/pages/item-form/`：手动录入表单页，字段样式（`.field` 等）主要在此页级 wxss 定义，未全局化。
