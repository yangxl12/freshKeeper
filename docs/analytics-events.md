# 埋点事件登记清单

对应机器可读版本：

- **`docs/analytics-properties-batch.json`** —— 属性「批量JSON创建」弹窗直接粘贴的数组
- **`docs/analytics-events-batch.json`** —— 事件「批量JSON创建」弹窗直接粘贴的数组
  （schema：`event_id` / `event_name` / `event_comment` / `event_key_list`，`report_src` 省略即前端上报）
- **`docs/analytics-events.json`** —— 14 属性 + 26 事件完整定义（中文名、类型、触发位置）

改代码里的埋点后，三份 JSON 和本表格都要同步。

**命名铁律**：上报字段一律 snake_case（`duration_ms`）—— We 分析属性 ID 只允许小写字母、数字和下划线，
代码 key 必须和后台属性 ID 完全一致，否则收不到数。

## 为什么要登记

微信自定义分析是「**先配置、后上报**」。客户端调用 `wx.reportEvent` 时：

- 事件名没在后台建过 → 整条上报被丢弃
- 字段名没在后台建过 → 该字段被丢弃，其余保留
- **两种情况都不报错、控制台无输出、日志无痕**

所以「代码里写了埋点」不等于「后台有数据」。

只走 `wx.reportEvent`（We 分析）。老接口 `wx.reportAnalytics` 已被官方废弃，且两套系统的事件互不通用，
不再维护第二套配置。

所有上报统一走 `utils/analytics.ts` 的 `track()` / `trackDuration()`，
**别在业务代码里直接调 `wx.reportXxx`** —— 绕过封装的事件不会进这份清单，也就不会有人去登记。

## 登记入口

微信公众平台 → 左侧 **We 分析** → **数据管理** → **上报管理**

1. **属性管理** → 「批量JSON创建」→ 粘贴 `analytics-properties-batch.json`
2. **元事件** → 新增上报，按事件清单建 26 个（事件 ID 建完不可改）
3. 事件详情 → 「测试」验收（见下）

## 属性清单（14 个）

| 属性 ID | 类型 | 说明 |
| --- | --- | --- |
| `duration_ms` | 整数 | 耗时，毫秒 |
| `count` | 整数 | 物品条数 |
| `result` | 字符串 | `success` / `failed` / `partial` |
| `reason` | 字符串 | `save` / `quantity` 等场景标记 |
| `source` | 字符串 | 来源，如 `text` / `voice` / `photo` / `recent` / `manual` |
| `failure_code` | 字符串 | 业务错误码 |
| `slots` | 整数 | 最近档案槽位数 |
| `tab` | 字符串 | 快录页切换的页签 |
| `within_24h` | 整数 | 0 / 1 |
| `saved_count` | 整数 | 本次会话保存条数 |
| `draft_count` | 整数 | 草稿条数 |
| `candidate_count` | 整数 | 日期候选数 |
| `succeeded` | 整数 | 批量成功条数 |
| `failed` | 整数 | 批量失败条数 |

## 事件清单（26 个）

新增的性能事件在前，其余是已有事件。

| 事件 ID | 字段 | 触发位置 |
| --- | --- | --- |
| `home_first_screen` | `duration_ms` `count` `result` | `pages/home` 首屏列表刷出（onLoad 起算） |
| `home_list_refresh` | `duration_ms` `count` `result` | `pages/home` 下拉刷新 / 改筛选 |
| `home_list_more` | `duration_ms` `count` `result` | `pages/home` 上拉加载更多 |
| `item_save_result` | `duration_ms` `result` `reason` | `services/inventory-service` `saveItem` |
| `item_create_success` | — | `components/item-form-sheet` 新建成功 |
| `item_expiry_corrected` | `within_24h` | `components/item-form-sheet` 保存后改了到期日 |
| `item_used_up` | — | `pages/home`、`pages/item-detail` 标记用完 |
| `reminder_open_detail` | — | `pages/item-detail` 从提醒消息进详情 |
| `reminder_request_result` | `result` | `services/reminder-service` 订阅授权结果 |
| `quick_entry_open` | — | `pages/quick-entry` 进入 |
| `quick_entry_session_end` | `saved_count` `duration_ms` | `pages/quick-entry` 退出 |
| `quick_entry_switch_tab` | `tab` | `pages/quick-entry` 切页签 |
| `quick_entry_manual` | `source` | `pages/quick-entry` 转手动录入 |
| `quick_entry_save_result` | `result` `draft_count` `duration_ms` `succeeded` `failed` `source` | `pages/quick-entry` 批量保存结束 |
| `quick_parse_result` | `result` `duration_ms` `draft_count` `failure_code` | `pages/quick-entry` AI / 本地解析结束 |
| `draft_form_submit` | `source` | `pages/quick-entry` 草稿编辑完成 |
| `voice_permission_result` | `result` | `pages/quick-entry` 录音授权 |
| `voice_transcribe_result` | `result` `failure_code` | `pages/quick-entry` 语音转写 |
| `date_photo_result` | `result` `candidate_count` | `pages/quick-entry` 拍照识别日期 |
| `recent_entry_open` | `slots` | `pages/recent-entry`、`pages/quick-entry` |
| `recent_entry_edit` | — | `pages/recent-entry` 编辑档案 |
| `recent_entry_pick` | `source` | `pages/recent-entry` 选中档案 |
| `recent_entry_remove` | — | `pages/recent-entry` 删除档案 |
| `recent_entry_confirm` | `count` | `pages/recent-entry` 确认 |
| `recent_item_select` | `count` | `pages/quick-entry` 从档案批量选取 |
| `app_open` | — | `app.ts` 每次进前台（onShow） |

## 验收

1. 发布到体验版（开发版/体验版/正式版都能上报）。
2. We 分析 → 对应事件 → 点「**测试**」，选测试微信号，点开始测试。
3. 手机上把首页、快录、保存各走一遍。约 1 分钟后看「最近 1000 条测试记录」。
4. 每条记录都有校验结果，字段缺失或类型不符会直接标红 —— **这一步是唯一能确认埋点真的在收数的方式**。
