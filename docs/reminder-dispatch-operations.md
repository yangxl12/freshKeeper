# 到期提醒派发运维与验收

环境：`cloud1-d0gkh66ce94b1be08`。订阅消息发送依赖微信云调用票据；生产派发只能由微信开发者工具上传的定时触发器执行。仓库中 `cloudfunctions/dispatchReminders/config.json` 是该触发器的配置来源，`cloudbaserc.json` 不再声明普通提醒触发器。

## 变更前回读

保留现有失败任务，不手工改 `reminder_jobs`。在有 CloudBase 只读权限的终端查询：

```text
tcb fn detail dispatchReminders --json
tcb api tcb DescribeWxFunctionTriggers --body '{"EnvId":"cloud1-d0gkh66ce94b1be08","FunctionName":"dispatchReminders"}' --api-version 2018-06-08 --json
tcb fn log dispatchReminders --startTime "2026-09-29 15:55:00" --endTime "2026-09-29 16:10:00" --limit 100 --json
```

比较普通 `Triggers` 与微信触发器的名称、启用状态、cron、环境、版本和同一分钟调用次数，并记录请求 ID。CLI 时间范围的时区以实际返回为准。当前故障任务的 `-501007 / Invalid wxCloudApiToken` 已证明该次调用没有有效票据，但不能单凭任务记录推断是哪一种入口抢先领取。

## 修复顺序

1. 先确认微信定时触发器 `daily-reminder-dispatch` 已启用，cron 为 `0 0 * * * * *`。若微信视图缺失或错误，在微信开发者工具中对 `cloudfunctions/dispatchReminders/config.json` 执行「上传触发器」，然后再次回读微信触发器视图。
2. 在可丢弃的真机测试物品上验证微信入口能携带票据完成发送。`verify-self` 会消耗一次订阅额度并提前发送，只用于独立测试物品；自然整点验收必须使用另一条新建任务。
3. 只有微信入口独自实发成功后，才删除或停用会领取生产任务的普通 CloudBase/SCF 提醒触发器，并回读确认。删除命令的目标必须先从 `tcb fn detail` 核实；不要删除微信入口。
4. 部署 `inventoryApi`、`reminderApi`、`dispatchReminders` 与小程序前端后，回读云端代码和触发器。云函数部署不会自动保证已有触发器同步；前端源码提交也不代表体验版或正式版已发布。
   同时检查 `reminder_jobs` 的查询索引：派发的待重试查询使用 `status`、`remindDate`、`nextRetryAt`，诊断页使用 `remindDate`、`status`、`updatedAt`。按真实查询计划补足组合索引，并在有数据的环境中验证查询不会超时。CloudBase 的[索引说明](https://docs.cloudbase.net/recipes/optimize-database-query-performance)建议将等值条件放在组合索引前部。
5. 真机新建提醒日为当天的测试物品，确认一次授权只对应一个 `scheduled`。批量三件最多自动预约一件，其余逐件点击「开启提醒」。自然整点检查一次领取、`sendAttemptedAt`、`sent`、服务通知收到及点击跳转。连续两天通过后再关闭故障。

## 诊断口径

`dispatchReminders` 的只读 `action: "diag"` 接受 `remindDate`、`status`、`page`，每页 20 条。`byStatus` 用数据库 `count()` 统计指定提醒日，不受单次 `get()` 1000 条上限影响。原始 `failureReason` 只保留在数据库和受控日志中，详情页只显示安全的原因类别。

16:10 的应发未发监控应以 `reminder_jobs` 中当天 `scheduled`、`retryable` 的总数为分母和待处理数；异常码按 `failureCode` 聚合。当前仓库仅提供诊断接口和结构化派发日志，云端告警规则仍需在运维平台配置并验收。
