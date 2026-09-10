# 快速录入接入 AI 解析：云开发能力调研

> 调研时间：2026-09-10 ｜ 状态：仅调研，未改动任何代码

## 一、结论

**有现成能力，不用另买第三方 API。** 微信云开发内置了大模型调用能力：

- 小程序端：`wx.cloud.extend.AI`
- 云函数端：`@cloudbase/node-sdk` 的 `app.ai()`

本项目已开通云开发（环境 `cloud1-d0gkh66ce94b1be08`，见 `miniprogram/config/runtime.ts`），底座是现成的。

**但不是完全免费。** Token 按量计费，1000 Token 点 = 1 元。不过有官方免费路径：报名「小程序成长计划」可白拿 10 亿混元 Token（有效期 6 个月），本项目场景够用到不能再够。

**推荐架构：走云函数，不走小程序端。** 直接复用现有 `cloudfunctions/quickEntryApi`，前端返回值结构完全不变。

---

## 二、能力清单（2026-09 现状）

| 能力 | 接口 | 本项目是否需要 |
| --- | --- | --- |
| 非流式生文 | `generateText()` | **需要，主用法** |
| 流式生文 | `streamText()` | 不需要 |
| 工具调用 | `streamText({ tools })` | 备选（强约束输出时用） |
| Agent 智能体 | `AI.bot.sendMessage()` 等 | 不需要 |
| 工作流（无代码编排） | 控制台配置，大模型节点 + JS 节点 | 不需要 |
| 生图 | 仅 Node SDK，小程序端不支持 | 不需要 |

可用模型（统一入口 `createModel("cloudbase")`）：
DeepSeek-V4-Flash / V4-Pro、混元 Hy3 / Hy3-preview、GLM、Kimi、MiniMax。

**注意 SDK 差异，别搞混：**

| | 小程序端 | 云函数端（Node） |
| --- | --- | --- |
| 初始化 | `wx.cloud.init({ env })` | `tcb.init({ env, timeout: 60000 })` |
| 取模型 | `wx.cloud.extend.AI.createModel("cloudbase")` | `app.ai().createModel("cloudbase")` |
| `generateText` 参数 | 直接传 `{ model, messages }` | 同左 |
| `generateText` 返回值 | 原始响应 → `res.choices[0].message.content` | 封装过 → `res.text` |
| `streamText` 参数 | 包在 `data` 里 | 直接传 |
| 基础库要求 | 3.7.1+（老 provider）/ 3.15.1+（新模型） | **无要求** |

## 三、能不能稳定产出固定 JSON？

**没有 `response_format: json_schema` 这种严格模式。** 两条路：

**方案 A（推荐先用）：Prompt 强约束**
- system prompt 里给死字段名、类型、枚举白名单，附 2~3 条 few-shot 示例，要求"只输出 JSON，不要解释文字"
- 服务端 `JSON.parse`，失败 → 重试一次 → 再失败降级本地正则
- 成本最低，这类字段抽取任务成功率够高

**方案 B（A 不够用时再上）：工具调用**
- 把 `saveInventoryItems` 定义成 tool，`parameters` 写 JSON Schema，枚举写死在 schema 里，`autoExecute: false`
- 模型必须按 schema 出参，结构化最稳
- 代价：多一轮 token，代码更绕

**枚举必须服务端二次校验。** 别信模型。`category` 只有 `food/medicine/household/other`，`unit` 上限 8 字符，日期必须合法 —— 这些用现有 `cloudfunctions/quickEntryApi/validation.js` 再筛一遍。

## 四、最关键的一件事：允许模型说"不知道"

模型会幻觉，典型表现是**编造数量**。用户只说"买了牛奶"，它可能自信地返回 `quantity: 1`（甚至 `2`）。日期同理。

好在 `QuickEntryParseResult` 已有完美承接机制：
`dateCandidates` → `role: 'unknown'` → `confirmationFields` → 强制用户在 UI 上确认。

所以 prompt 里必须写明：

> 未明确提及的字段一律返回 null，禁止推测和补全。

这样"没说的话"会走你现有的确认流程，不会静默写进数据库。**这是方案能否落地的核心，是产品问题不是技术问题。**

## 五、为什么走云函数

| 维度 | 小程序端 | 云函数端 |
| --- | --- | --- |
| 基础库要求 | 3.7.1+ / 3.15.1+ | 无 |
| Prompt 位置 | 前端包内，可被反编译 | 服务端，不暴露 |
| 限频 / 缓存 / 校验 | 前端做，可绕过 | 服务端做，可靠 |
| 复用现有代码 | 难 | 可直接复用 `validation.js` / `rules.js` |
| 计费项 | 小程序 API 调用次数 + Token | 云函数资源 + Token |

本项目 `project.config.json` 的 `libVersion` 是 **3.8.10**。走小程序端要用上 Hy3 / DeepSeek-V4，得升到 3.15.1，等于强制用户升级微信客户端 —— 有兼容性风险。走云函数完全绕开这个问题。

**结论：新增或扩展云函数，前端只改一处调用点。**

## 六、价格

### Token 点资源包

1000 点 = 1 元，有效期 1 年。

| 规格 | 价格 |
| --- | --- |
| 5 万点 | 50 元 |
| 10 万点 | 100 元 |
| 100 万点 | 1000 元 |
| 1000 万点 | 10000 元 |

### 单价（点 / 百万 tokens）

| 模型 | 输入 | 输出 | 缓存命中 |
| --- | --- | --- | --- |
| DeepSeek-V4-Flash 原厂直供 | 1000（1 元） | 2000（2 元） | 20（0.02 元） |
| Hy3 preview（<16k） | 1200 | 4000 | 400 |
| DeepSeek-V4-Pro | 12000 起 | 24000 起 | 1000 |

### 本项目实际成本

一句 30 字输入 + 固定 prompt ≈ 输入 400 tokens，输出 300 tokens：

```
输入 400 × 1000/1M = 0.4 点
输出 300 × 2000/1M = 0.6 点
单次 ≈ 1 点 = 0.001 元
```

**50 元 ≈ 5 万次识别。** 单人每天录 5 条，够跑 27 年。

**钱不是问题。真正要防的是滥用和并发。**

## 七、免费路径（第一件该做的事）

**「小程序成长计划」**，活动期 2026-01-01 ~ 2026-12-31，二期从 2026-07-01 起：

- 10 亿混元 Token + 10 万张生图，自申请成功起 6 个月有效
- **使用范围仅限小程序和云函数中调用** —— 正好覆盖本项目
- 免费额度覆盖模型：`hy3`、`hy3-preview`、`hunyuan-2.0-*`、`hunyuan-turbos-latest`、`hunyuan-t1-latest`
- 报名前无环境 → 送 6 个月个人版环境；已有体验版环境 → 自动升级；已有正式环境 → 发 120 元代金券
- 入口：**微信公众平台 → 行业能力 → 小程序成长计划**，报名即到账，无审核

### 两个坑

1. **一个小程序账号只能参加一次**，资源包 6 个月到期不补。
2. **环境套餐等级限制**：控制台套餐说明里，「CloudBase 内置模型调用」在**免费体验版环境是不支持的**，个人版（19.9 元/月，限时优惠）才支持。自定义大模型要标准版（199 元/月），本项目不需要。

   → 所以要么报名成长计划把 `cloud1-d0gkh66ce94b1be08` 升级为个人版，要么直接开个人版。**先去控制台确认当前环境的套餐等级。**

## 八、风险清单

1. **延迟**：AI 1~3 秒，本地正则 <10ms。→ 上 loading 态，5 秒超时直接降级本地规则，UI 上标"AI 识别"小标识。
2. **幻觉**：见第四节，靠 `null` + `confirmationFields` 兜。
3. **并发**：免费额度并发有限，可能报 `EXCEED_CONCURRENT_REQUEST_LIMIT`。→ 加排队与重试（`hy3` 与 `hy3-preview` 之间可互相切换分摊）。
4. **成本滥用**：任何用户都能触发。→ 服务端按用户每日限次（如 30 次/天），并按 `normalizeRecentName(text) + today` 做结果缓存（该函数已存在）。
5. **隐私合规**：用户输入会发送至大模型。`QUICK_ENTRY_FEATURES` 注释里已写"P1 provider 完成隐私评审后再逐项开启"，本功能属于同类，隐私政策需补一条说明。小程序审核会看。
6. **接口演进**：`wx.cloud.extend.AI` 仍在迭代，返回结构在各端不一致（连 `finish_reasion` 这种拼写错误都出现过）。→ 模型名与返回结构集中在一个 adapter 文件里，不要散落各处。

## 九、落地路径（最小改动）

1. **云开发控制台 → AI → 生文模型**，启用 `hy3-preview`（或先报名成长计划拿额度）
2. **云函数侧**：给 `cloudfunctions/quickEntryApi` 加一个 action（或新建 `quickEntryAi`）
   - 入参：`{ text, today, maxItems: 5 }`
   - system prompt：固定字段 schema + 枚举白名单 + few-shot 3 条
     - 示例："牛奶2盒9月12日过期放冰箱" / "瓜子一包2周后过期" / "买了三个苹果"
   - 调 `app.ai().createModel("cloudbase").generateText({ model: 'hy3-preview', messages })`
   - `JSON.parse` → 复用 `validation.js` 校验 → 组装成现有 `QuickEntryParseResult` 结构
   - 返回 `{ items, serverToday, parserVersion: 'ai-v1' }`
3. **前端**：`miniprogram/services/quick-entry-service.ts:56` 那一处调用点改为 AI 优先，5 秒超时或异常 → 回退 `parseQuickTextLocally`
4. **开关**：`miniprogram/config/runtime.ts` 的 `QUICK_ENTRY_FEATURES` 加一项（如 `aiParse`）
5. **UI**：`miniprogram/pages/quick-entry/index.ts` 解析分支加 loading + 来源标识

因为云函数返回结构与现有 `QuickEntryParseResult` 完全一致，`createDraftFromParsed` 等下游逻辑零改动。

## 十、附：语音输入的额外一环

「按住说」如果要真正可用，**语音转文字不属于大模型的能力范围**，需要另外接：

- **微信同声传译插件**（插件市场申请，提供 `wx.getRecordRecognitionManager` 语音识别）
- 转成文字后，再走上面同一套 AI 抽取流程

这正好对应 `capabilities.voice` 目前置灰的逻辑。

---

## 参考来源

- [wx.cloud.extend.AI SDK 文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/extend/ai.html)
- [小程序调用 CloudBase AI 模型](https://docs.cloudbase.net/ai/model/miniprogram-access)
- [Node SDK 调用](https://docs.cloudbase.net/ai/model/nodejs-access)
- [小程序成长计划](https://docs.cloudbase.net/ai/ai-inspire-plan)
- [Token 点计费标准](https://cloud.tencent.com/document/product/865/39095)
- [云开发套餐配额与能力项](https://cloud.tencent.com/document/product/876/127357)
