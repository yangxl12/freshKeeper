# 依赖审计记录（2026-09-14）

## 结果

- 根项目执行 `npm audit --omit=dev --registry=https://registry.npmjs.org/`：0 个漏洞。
- 六个云函数均只直接依赖 `wx-server-sdk@4.0.2`，锁定的传递依赖一致。
- `quickEntryApi` 已删除腾讯 ASR/OCR SDK；所有云函数锁文件均不再包含 `tencentcloud-sdk-nodejs-asr` 或 `tencentcloud-sdk-nodejs-ocr`。
- 云函数审计仍报告 6 个上游传递依赖问题：5 个 high、1 个 moderate，来源为 `wx-server-sdk@4.0.2` 引入的 `@cloudbase/node-sdk`、`@cloudbase/database`、`axios@0.27.2`、`lodash.set@4.3.2` 和 `lodash.unset@4.5.2`。

## 处置

`npm audit` 给出的自动修复会把 `wx-server-sdk` 强制降级到 `2.5.3`，属于破坏性降级，也会失去当前云 AI 能力，因此本次不执行 `npm audit fix --force`。继续锁定微信官方 SDK `4.0.2`，等待官方升级传递依赖；升级时重新执行完整云函数回归与真机验证。

本记录只说明依赖供应链现状，不替代云端运行时、权限和函数版本核验。
