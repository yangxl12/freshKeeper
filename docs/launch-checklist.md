# 上线前手工操作清单

更新：2026-09-13。**这份清单只收录「代码和部署都替代不了、必须去后台点」的事项。**
功能类验收见 `quick-entry-acceptance.md`，云环境搭建见 `cloud-deployment.md`。

---

## A. 隐私合规（微信公众平台 →「用户隐私保护指引」）

这是审核硬项，代码一条都代替不了。当前需要写入指引的内容共 **5 条**：

| # | 声明内容 | 出处 |
| --- | --- | --- |
| A1 | 收集**昵称、头像**，用于个人资料展示 | `user-profile-plan.md` §10 |
| A2 | 提供**删除 / 注销个人信息**的路径：本项目为「我的 → 账号与数据」 | `cloud-deployment.md` §3.0 |
| A3 | **语音转写**：说明数据用途、腾讯云为第三方处理方、临时处理范围 | `cloud-deployment.md` §3.2 |
| A4 | **日期照片识别**：相机 / 相册权限用途为「识别本次录入的日期」 | `cloud-deployment.md` §3.2 |
| A5 | **用户输入的物品文字会发送至大模型（云开发内置混元）用于结构化解析**；文字和语音都走这条链路 | `cloud-deployment.md` §3.3、`quick-entry-acceptance.md` |

配套代码开关（改代码，但受 A5 评审结果驱动）：

- A5 审核通过前，`miniprogram/config/runtime.ts:QUICK_ENTRY_FEATURES.aiParse` 保持 `false`，
  页面会静默退回确定性规则，不弹提示；通过后再置 `true`。
- `app.json.permission` **不支持** `scope.record` / `scope.camera` 声明，
  不要试图用无效配置代替后台隐私指引（`cloud-deployment.md` §3.2）。

> 除隐私指引外，还需同步提交**审核材料**（第三方处理方说明），见 `quick-entry-acceptance.md` 第 2 条。

---

## B. 订阅消息模板（提醒功能的前提，现在是占位）

代码里 `REMINDER_TEMPLATE_ID` 仍是 `TODO_REPLACE_WITH_REAL_TEMPLATE_ID`，提醒功能实际发不出去。

1. 公众平台申请**一次性订阅消息模板**，拿到模板 ID 与字段名。
2. 模板 ID 要填 **3 处**，缺一处就静默失效：
   - `miniprogram/config/runtime.ts:15` 的 `REMINDER_TEMPLATE_ID`
   - 云函数 `reminderApi` 环境变量 `REMINDER_TEMPLATE_ID`
   - `cloudfunctions/dispatchReminders/template.js` 的字段映射
3. `dispatchReminders` 环境变量按**实际审批结果**核对字段名：

   | 变量 | 当前假定值 |
   | --- | --- |
   | `REMINDER_ITEM_FIELD` | `thing7` |
   | `REMINDER_DATE_FIELD` | `time2` |
   | `REMINDER_REMAINING_DAYS_FIELD` | `number5` |
   | `REMINDER_QUANTITY_FIELD` | `number4` |
   | `REMINDER_NOTE_FIELD` | `thing3` |

4. 每个投放阶段还要改 `MINIPROGRAM_STATE`：开发 `developer` / 体验 `trial` / 正式 `formal`。

---

## C. 腾讯云侧

- **开通识别服务**：一句话识别 + 通用文字识别（高精度版），确认计费；
  给 `quickEntryApi` 配 `QUICK_ENTRY_TENCENT_SECRET_ID` / `QUICK_ENTRY_TENCENT_SECRET_KEY`。
  密钥**不要**发到聊天、不要提交仓库。当前真实环境能力为 `voice: false`、`datePhoto: false`。
- **小程序成长计划**（公众平台 → 行业能力 → 小程序成长计划）：报名即到账，无审核，
  10 亿混元 Token + 10 万张生图，6 个月有效。一个小程序账号只能参加一次。
- **确认云环境套餐等级**：「CloudBase 内置模型调用」在**免费体验版环境不支持**，需个人版。
  如果 AI 解析一直降级，先查这一项。

---

## D. 云开发控制台

- **数据库索引 11 条**：开发、生产**各建一次**。字段顺序不能换，**不要勾唯一**。
  完整表见 `cloud-deployment.md` §2；操作步骤见 §2.1。
  2026-09-13 实测当时只建了 1 条（`ownerId + inventoryStatus + name`），其余 10 条全缺。
  > 索引没有 API，只能手点，这一点已反复确认过，别再找自动化路子。
- **集合权限全部设为「无权限」**：`inventory_items` / `user_settings` / `reminder_jobs` / `users`，
  数据只允许云函数访问。
- **云函数超时改成 60 秒**：`quickEntryApi`、`userApi`。
  `config.json` 的 `timeout` 只在**首次创建**时写入云端，更新部署不会重新应用，新环境默认只有 **3 秒**，
  必报 `FUNCTIONS_TIME_LIMIT_EXCEEDED`。
- **云函数调用权限**：`dispatchReminders` 和 `cleanupTrash` 禁止小程序端调用，只允许定时触发。
- **触发器时区确认 `Asia/Shanghai`**：`dispatchReminders` 每日 09:00、`cleanupTrash` 每日 03:30。
- **云存储安全规则**：本人可上传 / 删除自己的文件，禁止他人读取；
  另给 `quick-entry/` 配最短可用生命周期清理，兜底断网、进程被杀、函数硬超时留下的孤立媒体。

---

## E. 微信后台其他

- **AppID**：`project.config.json` 里的 `touristappid` 换成真实 AppID。
- **We 分析埋点登记**：公众平台 → We 分析 → 数据管理 → 上报管理。
  **先配置后上报**，没登记的事件和属性会被**静默丢弃**（不报错、无日志）。
  - 属性管理 →「批量JSON创建」→ 粘贴 `docs/analytics-properties-batch.json`（14 个属性）
  - 元事件 → 新增上报 26 个，参考 `docs/analytics-events-batch.json`（事件 ID 建完不可改）
  - 完整定义见 `docs/analytics-events.md`
- **ICP 备案**：小程序上架的前置条件（2023-09 起）。项目文档里没有记录过这项，
  **需要你自己确认备案状态**。
- **服务类目**：核对所选类目是否需要额外资质（`mvp-technical-design.md` §14 只提到「核对类目」，
  未指定具体类目）。

---

## 一句话优先级

挡住功能可用的有三件：**B 订阅模板 ID（提醒发不出去）**、**D 云函数超时 60 秒（快录直接报错）**、
**A 隐私指引（审核不过）**。索引只影响性能，不挡住上线。
