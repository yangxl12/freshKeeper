# 保质期助手

面向家庭用户的微信原生小程序，完成“录入物品 → 查看临期状态 → 订阅提醒 → 处理库存 → 删除或恢复”的管理闭环。

## 当前实现

- 首页：四项纯文字库存概览、临期快捷列表与批量处理
- 库存：名称搜索、种类与状态组合筛选、游标分页及筛选结果批量处理
- 物品：新增、编辑、自由填写存放位置、两种日期录入、任意正整数减量和用完处理
- 我的：弹窗式提醒设置、已用完处理记录，以及支持恢复、手动或批量彻底删除的回收站
- 云端：可信 OPENID 隔离、字段白名单、版本冲突、单条/批量事务状态转换和一次性提醒任务
- 定时任务：每日派发临期提醒；每日清理保留期已满 30 天的已删除数据

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
