# 保质期助手

面向家庭用户的微信原生小程序，完成“录入物品 → 查看临期状态 → 订阅提醒 → 标记用完或丢弃”的 MVP 闭环。

## 当前实现

- 首页：物品总数、已过期、临期、已用完四项概览与临期物品快捷列表
- 库存：名称搜索、种类与状态组合筛选、统一卡片列表和游标分页
- 物品：新增、编辑、两种到期日期录入、详情、减量、用完、丢弃和误录删除
- 我的：默认提醒天数、默认存放位置、微信通知状态说明和历史记录
- 云端：可信 OPENID 隔离、字段白名单、版本冲突、事务状态转换和一次性提醒任务
- 派发：每日定时扫描、原子领取、最多尝试一次、明确失败与未知结果分流

## 本地检查

```bash
npm install
npm run check
```

随后用微信开发者工具导入仓库根目录。首次连接真实环境前，请完成 [云开发接入与验收](./docs/cloud-deployment.md)。

## 工程目录

```text
miniprogram/       原生 TypeScript 小程序
cloudfunctions/    库存、设置、提醒和定时派发云函数
tests/unit/        日期、临期状态、服务端校验和提醒状态测试
docs/              产品、技术与部署文档
```

当前实现以 [MVP 产品设计文档 2](./docs/mvp-product-design-v2.md) 与 [MVP 技术方案 2](./docs/mvp-technical-design-v2.md) 为准；未调整流程继续沿用 [MVP 产品设计](./docs/mvp-product-design.md) 和 [MVP 技术方案](./docs/mvp-technical-design.md)。
