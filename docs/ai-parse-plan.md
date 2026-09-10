# 快速录入接入 AI 解析：实现计划

> 制定时间：2026-09-10 ｜ 状态：P0/P1/P2 均已编码落地，实施记录见第 12、13 节
> 前置调研见 `docs/ai-parse-research.md`（部分结论已被本文档纠正）

## 0. 一句话结论

用 `wx-server-sdk` 的 `cloud.ai()` 在**现有云函数 `quickEntryApi` 内**调用 `hy3` 模型做结构化抽取
（provider 用 `hunyuan-v3`，见第 2 节），
返回结构保持不变（`QuickEntryParseResult`），前端只加一个开关和一个来源标识，下游零改动。

**但"准确无误"做不到，也不该追求。** 能做的是三件事：

1. 让模型**只输出原文里有的信息**，没说的必须返回 `null`；
2. 服务端**不信任模型**，每个字段都要能追回原文（证据回链），追不回就丢弃；
3. 丢弃的字段进现有的 `confirmationFields` 流程，**交给用户确认**，而不是静默入库。

## 1. 与旧调研的差异（必须纠正）

| 项 | 旧调研结论 | 官方文档现状 | 影响 |
| --- | --- | --- | --- |
| 云函数端 SDK | `@cloudbase/node-sdk` 的 `app.ai()` | **`wx-server-sdk` ≥ 3.0.5-beta.1 的 `cloud.ai()`**（本项目 4.0.2 ✅） | 不装新依赖，不用改包体积 |
| 模型名 | `hy3-preview` | `hy3-preview` **即将下线**，用 `hy3` | 直接用 `hy3`，别写 preview |
| provider | 未提及 | `cloudbase`：**仅资源点套餐可用**，需手动开模型开关<br>`hunyuan-v3`：**资源点 / 非资源点套餐均可**，无需开关，只消耗免费额度 | **用 `hunyuan-v3`**，原因见第 2 节 |
| 返回值 | `res.text` | `result.text` / `result.usage` / `result.messages` | 取 `result.text` |
| 超时 | 未提及 | 建议 `cloud.init({ timeout: 60000 })` | 云函数 `config.json` timeout 现为 30s，够用但建议同步调 |

`cloud.ai()` 调用形态（已确认，与 node-sdk 不同）：

```js
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 60000 })
const model = cloud.ai().createModel('hunyuan-v3')
const result = await model.generateText({ model: 'hy3', messages })
// result.text 是生成文本；result.usage 是 token 用量
```

## 2. provider 必须选 `hunyuan-v3`（踩过的坑）

**结论：用 `hunyuan-v3`，不要开 hy3 模型开关，不要切换套餐。**

两个 provider 是两条独立通道，别搞混：

| 对比项 | `cloudbase` | `hunyuan-v3` |
| --- | --- | --- |
| 适用套餐 | **仅资源点套餐** | 资源点 + **非资源点套餐均可** |
| 模型开关 | **需在控制台手动开启 `hy3`** | **无需开启，也不支持关闭** |
| 免费额度消耗 | 来源允许时优先消耗免费额度 | **仅消耗免费额度** |
| 免费额度耗尽 | 自动转套餐额度扣费 | **直接报错** |
| 来源不允许时 | 自动转套餐额度 | 报错 |

本项目环境 `cloud1-d0gkh66ce94b1be08` 是**非资源点计费**（成长计划一期报名的环境属"配额制套餐"，
或环境仍为体验版）。控制台里点 `hy3` 开关会提示"需先切换为资源点套餐"——
**那是 `cloudbase` 通道的开关，与本项目无关，不要跟着去切套餐。**

微信官方 FAQ 原话：

> 生文模型：使用 `ai.createModel("hunyuan-v3")`，model 传 `hy3`。

**什么时候才需要切套餐？** 免费额度耗尽之后。官方给的迁移路径：

```js
// 额度用尽前
const model = ai.createModel('hunyuan-v3')
// 切换资源点套餐后
const model = ai.createModel('cloudbase')
```

provider 名只允许出现在 `ai-client.js` 一处，将来切换只改一行。

### 由此带来的两个硬约束

1. **额度耗尽 = 硬失败，不是静默扣费。** 所以降级链（AI → provider → 本地 `rules-v3`）不是可选项，
   是必需品。额度告警也不能省（控制台在 80% / 90% / 100% 发公众号消息提醒）。
2. **并发只有 5**（体验模型限制）。超了报 `EXCEED_CONCURRENT_REQUEST_LIMIT`，
   必须做退避重试 + 前端排队，不能让用户看到错误码。

### 开工前你只需要确认一件事

**免费额度已到账** —— 用小程序扫码登录云开发 Web 控制台，或微信开发者工具「云开发 → AI」模块查看用量。
成长计划赠送额度**仅限小程序和云函数调用**，正好覆盖本方案。

## 3. 架构与降级链

```
用户输入
  └─ 前端 parseQuickText()                        ← 不改签名、不改返回结构
       └─ 云函数 parseText
            ├─ ① AI 解析（ai-parse.js）           ← 新增，主路径
            │    失败 / 超时 / 输出不合规
            ├─ ② 自定义 provider（provider.js）    ← 保留现状，不动
            │    未配置
            └─ ③ 本地 rules-v3（quick-text.js）    ← 最终兜底，已有
```

- 三级降级对前端**完全透明**，`services/quick-entry-service.ts` 不用改。
- AI 不可用时**不发 toast**（微信 toast 超 7 字被截断，已被吐槽过），只在 UI 上不显示 `AI` 徽章。

## 4. 核心设计：让"准确"可验证

这是整个方案能不能落地的关键，不是技术问题是产品问题。

### 4.1 约束模型输出（L1）

system prompt 里写死：

- 完整的字段清单 + 类型 + 枚举白名单（`category` ∈ `food/medicine/household/other`）
- 3 条 few-shot（覆盖三种典型句式，见第 8 节验收用例）
- 铁律：**"未在原文中明确出现的字段一律返回 null，禁止推测、禁止补全、禁止使用常识。"**
- 铁律：**"不要计算日期，只把原文里的时间表达转成结构化事实。"**
- 只输出 JSON，不要 markdown 代码块，不要解释文字

### 4.2 让模型不碰日期（L2）

日期换算是幻觉高发区（"2周后"→ 模型算错、闰月算错、跨年算错）。

**模型只输出事实，服务端算日期：**

```json
{ "kind": "relative", "offsetDays": 14, "label": "expiry", "rawText": "2周后过期" }
{ "kind": "absolute", "year": 2026, "month": 9, "day": 12, "label": "expiry", "rawText": "9月12日过期" }
{ "kind": "shelf_life", "value": 6, "unit": "month", "rawText": "保质期6个月" }
```

这套协议**现有的 `date-facts.js:normalizeFacts()` 已经完整支持**，包括 `offsetDays` 换算、`nearestMonthDay` 就近推年。
零新增日期逻辑。

### 4.3 证据回链（L3，最关键的一层）

要求模型对**每个非推断字段**附带原文片段：

```json
{
  "items": [{
    "name": "牛奶",
    "quantity": 2,
    "unit": "盒",
    "category": "food",
    "storageLocation": "冰箱",
    "dateFacts": [{ "kind": "absolute", "year": 2026, "month": 9, "day": 12, "label": "expiry", "rawText": "9月12日过期" }],
    "evidence": { "name": "牛奶", "quantity": "2盒", "unit": "2盒", "storageLocation": "放冰箱" }
  }]
}
```

服务端逐字段校验：**把 `evidence` 去空白后，检测它是否真的出现在用户原文中**。

- 对得上 → 保留该字段
- 对不上（模型编的）→ **该字段置 `null`**，让它走 `confirmationFields` 强制用户确认

这一招直接干掉"买了牛奶 → 模型自信返回 `quantity: 1`"这类幻觉。成本几乎为零（一次 `includes`），
且**可测试**——单测里塞一个"没有数量的原文 + 模型硬编数量"的假响应，断言字段被丢弃。

`category` 是例外：它本来就是从名称推断的，允许无证据，但必须落在枚举白名单内。

### 4.4 服务端宽容清洗（重要，别踩坑）

`date-facts.js:normalizeTextResult()` 用的是 **`assert` + 抛错**：任何一条 item 里有一个脏字段
（如 `quantity: "两盒"` 非整数），**整批请求抛 `INVALID_PROVIDER_RESPONSE`**，前端直接降级本地规则，
连本来识别对的物品一起丢。

所以 `ai-parse.js` 必须**先做逐字段宽容清洗**（非法值 → 丢弃成 `null`），
再把干净 body 喂给 `normalizeTextResult` 做严格兜底校验。两层职责不同：

- `ai-parse.js` = 宽容 sanitize，尽量保住能用的字段
- `normalizeTextResult` = 严格 validate，兜住一切漏网的

## 5. 文件改动清单

### 新增

| 文件 | 职责 |
| --- | --- |
| `cloudfunctions/quickEntryApi/ai-client.js` | **SDK 适配层**。隔离 `cloud.ai()`、模型名、返回结构。风险 6 要求"模型名与返回结构集中在一个 adapter 文件里，不要散落各处"；同时便于单测注入假实现 |
| `cloudfunctions/quickEntryApi/ai-prompt.js` | system prompt + few-shot。独立成文件，方便迭代和回归对比 |
| `cloudfunctions/quickEntryApi/ai-parse.js` | 编排：调模型 → 提取 JSON → 证据回链校验 → 宽容清洗 → 转 dateFacts body |
| `cloudfunctions/quickEntryApi/ai-quota.js` | 按 openid 每日限次 + 结果缓存（见第 6 节） |
| `tests/unit/ai-parse.test.ts` | 单测，注入假 AI client（见第 7 节） |

### 修改

| 文件 | 改动 |
| --- | --- |
| `cloudfunctions/quickEntryApi/index.js` | `parseText()` 增加 AI 优先分支；`getCapabilities()` 增加 `aiText` 字段 |
| `cloudfunctions/quickEntryApi/config.json` | 增加 `QUICK_ENTRY_AI_ENABLED` / `QUICK_ENTRY_AI_PROVIDER`（默认 `hunyuan-v3`）/ `QUICK_ENTRY_AI_MODEL`（默认 `hy3`）；timeout 视情况调到 60 |
| `miniprogram/config/runtime.ts` | `QUICK_ENTRY_FEATURES` 增加 `aiParse: true` |
| `miniprogram/pages/quick-entry/index.ts` | 识别中文案（"AI 识别中…"，超 3 秒改"正在仔细识别…"）；草稿卡片显示 `AI` 徽章（`parserVersion` 以 `ai-` 开头时） |
| `miniprogram/types/quick-entry.ts` | `QuickEntryCapabilities` 增加可选的 `aiText?: boolean` |

### 明确不动

- `miniprogram/services/quick-entry-service.ts` —— 返回结构一致，签名不变
- `miniprogram/domain/quick-entry.ts` —— `createDraftFromParsed` 等下游全部逻辑零改动
- `cloudfunctions/quickEntryApi/date-facts.js` / `quick-text.js` —— 完全复用
- `scripts/sync-quick-parser.mjs` 的同步关系 —— 新模块不参与双副本同步

## 6. 限流、缓存与并发

**钱不是问题**（单次约 1 点 = 0.001 元），要防的是滥用和并发。

| 机制 | 做法 | 说明 |
| --- | --- | --- |
| 结果缓存 | key = `sha256(normalizedText \| serverToday)`，命中直接返回，0 成本 | 先放云函数实例内存 `Map`（足够），后续可换云数据库集合 |
| 每日限次 | 按 `OPENID` 计，默认 50 次/天，存云数据库 | 超限返回 `AI_QUOTA_EXCEEDED` → 前端**静默**降级本地规则，不弹提示 |
| 并发超限 | 捕获 `EXCEED_CONCURRENT_REQUEST_LIMIT`，退避重试 1 次 | **体验模型单环境只有 5 并发**，这是最容易撞的墙 |
| 日均用量告警 | 云函数内统计调用次数，接近日限时记 `warn` 日志 | 控制台 80%/90%/100% 有公众号提醒，但自己留一份可观测数据 |
| 超时 | 云函数内 8s 超时（复用 `QUICK_ENTRY_TIMEOUT_MS` 语义），前端已有 8s `Promise.race` 兜底 | 双层超时，避免用户干等 |

## 7. 测试计划

新增 `tests/unit/ai-parse.test.ts`，**注入假 AI client**，不真调模型（快、可重复、免费）：

| 用例 | 断言 |
| --- | --- |
| 正常输入（名称+数量+单位+绝对日期+存放位置） | 字段全部正确映射，无 `confirmationFields` |
| 模型输出带 markdown 代码块包裹 | 能正确剥离并解析 |
| **幻觉：原文无数量，模型返回 `quantity: 1`** | 证据回链失败 → `quantity` 被置 null → 进 `confirmationFields` |
| **幻觉：模型编了个原文没有的日期** | 该 dateFact 被丢弃 |
| 相对时间"2周后" | 换算成 `today + 14`，且由服务端算，不由模型算 |
| 保质期"保质期6个月" | `expiryInputMode: 'shelf_life'`，`shelfLifeValue: 6` |
| 一条 item 里数量是脏值（`"两盒"`） | 只丢该字段，**其余字段和其余 item 全部保住**（不整批失败） |
| JSON 截断 / 解析失败 | 重试一次 → 再失败抛 `AI_UNAVAILABLE`，前端降级 |
| 模型返回 6 个物品 | 抛 `TOO_MANY_DRAFTS` |
| 超时 | 抛 `QUICK_ENTRY_TIMEOUT` |
| 空物品 / 闲聊输入（"今天天气怎么样"） | 不产出物品，走前端 fallback 草稿 |

跑 `npm run check` 必须全绿。

## 8. 验收标准

给一组固定用例，上线前手工过一遍（也是 few-shot 的素材来源）：

| 输入 | 期望 |
| --- | --- |
| `牛奶2盒9月12日过期放冰箱` | name=牛奶, qty=2, unit=盒, expiry=2026-09-12, storage=冰箱，无需确认 |
| `瓜子一包2周后过期` | name=瓜子, qty=1, unit=包, expiry=today+14，无需确认 |
| `买了三个苹果` | name=苹果, qty=3；**unit 为 null → 需用户确认单位** |
| `牛奶` | name=牛奶；**qty/unit/日期全部 null → 全部需确认**，绝不填 1 |
| `今天买的酸奶，保质期21天` | name=酸奶, shelfLifeValue=21, unit=day |
| `帮我看看今天天气` | 不产出物品，走 fallback 草稿，不报错 |

**准确率目标：字段级 precision ≥ 0.95，recall 允许偏低。**
即"宁可让它说不知道，也不许猜错"——猜错会写脏数据，说不知道用户补一下就行。

## 9. 分阶段实施

### P0 — 打通链路（最小可用）
1. 确认免费额度已到账（控制台 AI 页）；**provider 用 `hunyuan-v3`，不开模型开关、不切套餐**
2. 写 `ai-client.js` + `ai-prompt.js`
3. 写 `ai-parse.js` 基础版（调模型 → 解析 JSON → 清洗 → 复用 `normalizeTextResult`）
4. `index.js` 挂上 AI 分支
5. 写单测正常/异常路径
6. 微信开发者工具真机验证 3 条用例

### P1 — 上强度
7. 证据回链校验 + 幻觉单测
8. 相对时间 / 保质期协议打通
9. 限流 + 缓存 + 并发重试
10. 跑满第 8 节全部验收用例，调 prompt

### P2 — 收尾
11. UI：识别中文案 + `AI` 徽章 + 降级静默
12. `QUICK_ENTRY_FEATURES.aiParse` 开关 + capabilities 下发
13. 隐私政策补一条（用户输入会发送至大模型），处理 `runtime.ts` 里"P1 provider 完成隐私评审后再逐项开启"这句注释的约束
14. 语音链路接上 AI（同声传译插件转文字 → 同一套抽取流程）

## 10. 风险清单

| 风险 | 应对 |
| --- | --- |
| **幻觉写脏数据** | 证据回链 + 未提及必须 null + `confirmationFields` 兜底（本方案核心） |
| **一条脏数据毁整批** | `ai-parse.js` 宽容清洗前置，不让 `assert` 整批抛错 |
| **延迟 1~3 秒** | loading 文案 + 8s 双层超时 + 静默降级本地规则 |
| **免费额度并发不够（上限 5）** | 捕获 `EXCEED_CONCURRENT_REQUEST_LIMIT` 退避重试 1 次；前端提示"稍后重试"而非报错码 |
| **额度用尽** | `hunyuan-v3` 通道会**直接报错**（不静默扣费）→ 必须降级本地 `rules-v3`；同时做每日限次 + 用量日志；真耗尽后再切资源点套餐并把 provider 改成 `cloudbase`（只改 `ai-client.js` 一行） |
| **`hy3-preview` 下线** | 直接用 `hy3`，模型名只出现在 `ai-client.js` 一处 |
| **SDK 返回结构演进** | 全部收敛在 `ai-client.js`，散落即失控（旧调研已提过 `finish_reasion` 拼写错误的前车之鉴） |
| **隐私合规** | 隐私政策补充说明；小程序审核会看这一条，别漏 |
| **prompt 回归无保障** | prompt 独立成 `ai-prompt.js` + 固定验收用例，改动后必跑 |

## 11. 参考来源

- [小程序成长计划使用指南](https://docs.cloudbase.net/ai/ai-inspire-plan-guide)
- [小程序成长计划（微信官方，含 provider FAQ）](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/billing/ai-inspire-plan.html)
- [wx-server-sdk 调用大模型](https://docs.cloudbase.net/ai/model/wx-server-sdk-access)
- [小程序端调用大模型](https://docs.cloudbase.net/ai/model/miniprogram-access)
- [接入大模型总览（模型开关、资源点套餐）](https://docs.cloudbase.net/ai/model/overview)
- [Hy3 preview 下线通知](https://docs.cloudbase.net/ai/announcement/hy3-preview-offline)

## 12. P0 实施记录（2026-09-10，已上线并验证）

已落地：`ai-client.js`（SDK 适配层，唯一出现 provider / 模型名 / 返回结构的地方）、
`ai-prompt.js`（system prompt + 4 条 few-shot）、`ai-parse.js`（`aiParseText({text, serverToday, generate, timeoutMs})`）、
`index.js` 的 AI 优先分支 + `getCapabilities().aiText`、`config.json` 新增 AI 变量、
`tests/unit/ai-parse.test.ts`（23 条，含假 SDK 注入）。`npm run check` 全绿。

### 实测结论（真机 = 开发者工具模拟器 + 云端真调）

- 免费额度**已到账**，`hunyuan-v3` + `hy3` 直连可用，返回 `usage: {prompt_tokens: 748, completion_tokens: 60}`（单次约 0.8 Token 点）。
- **不需要任何控制台开关**；控制台里那个 `hy3` 开关属 `cloudbase` 通道，与本方案无关。
- 延迟：单条输入 **1.6～2.4 秒**；五条物品的长输入 **~4.9 秒**。
- 验收 6 条用例线上全对：`牛奶` 不会补 1、`买了三个苹果` unit 留空走确认、`2周后过期` 由服务端算成 `today+14`、闲聊走兜底草稿。

### 对计划的四处修正

1. **AI 超时用独立的 `QUICK_ENTRY_AI_TIMEOUT_MS`（默认 6000），且上限不超过 `QUICK_ENTRY_TIMEOUT_MS`。**
   计划写的"复用 8s"不成立：前端 `recognizeTextItems` 有 8s `Promise.race`，AI 撑满 8s 时用户早已降级，等于白调一次模型。
2. **`QUICK_ENTRY_AI_ENABLED` 改成"默认开启 + 急停开关"**（`false`/`0`/`off` 关闭）。
   原因见下条踩坑：环境变量不随部署生效，若开启依赖环境变量，新环境部署完就是死的。
3. **`index.js` 降级时吞掉所有 AI 错误**，包括 `TOO_MANY_DRAFTS`：模型幻觉出 6 件时降级本地反而更对；
   真是 6 件本地也会自己抛同样的错。
4. **`cloud.init` 的 `timeout` 与 `config.json` 的 `timeout` 都写 60**，但注意它们不一定生效（见下）。

### 最大的坑：`config.json` 只在函数首次创建时写入云端

`quickEntryApi/config.json` 里的 `timeout` / `envVariables` **不会随"更新部署"应用**——
`cli cloud functions deploy`（以及开发者工具对已存在函数的上传）**只更新代码**。
线上实测 `timeout = 3`（新环境默认值），而 `config.json` 写的是 60；`QUICK_ENTRY_AI_ENABLED` 也因此读不到。

三层证据：
① `cli cloud functions info` 显示 `timeout: 3`、`runtime: Nodejs16.13`；
② `getCapabilities().aiText` 为 `false`（新代码已上线，说明不是代码没更新，而是环境变量没到）；
③ 五条物品的输入报 `errCode: -504003 FUNCTIONS_TIME_LIMIT_EXCEEDED ... timed out after 3 seconds`。

结论：**超时和 `envVariables` 必须去云开发控制台改**（或删函数重新部署，仅首建读 `config.json`）。
详见 `docs/cloud-deployment.md` 第 3.3 节。

## 13. P1 / P2 实施记录（2026-09-10 完成编码，待真机复核）

### P1-7 证据回链（L3）

`ai-parse.js` 落地上文第 4.3 节的方案：每个非推断字段（`name` / `quantity` / `unit` / `storageLocation` /
`dateFacts[].rawText`）必须能在用户原文里追回，追不回就丢成 `null`，并记一条 `AI_EVIDENCE_REJECTED` 日志。

- 归一化用 `NFKC + 去空白 + 转小写`，抹平模型抄原文时的全半角与空格差异（`鲜牛奶 ２盒` 能匹配 `鲜牛奶2盒`）。
- 数字用 `(?<!\d)N(?!\d)` 边界匹配，避免「2」被「2026年9月12日」里的 2 蒙对。
- 没有 `evidence` 时退化为拿字段值本身核对原文；中文数量靠 evidence 兜住（`买了三个苹果` → evidence「三个」→ quantity 3）。
- `category` 是例外：它本来就从名称推断，只校验枚举白名单。
- 一次性幻觉（原文`牛奶`、模型给 `quantity: 1`）再也进不了草稿；所有字段都追不回来时抛 `AI_UNAVAILABLE`，直接降级本地规则。

### P1-8 相对时间 / 保质期

P0 已通，本轮补齐 few-shot（`2周后过期`、`保质期21天`、`买了三个苹果`、闲聊兜底）与对应回归用例。

### P1-9 限流 / 缓存 / 并发退避

新增 `cloudfunctions/quickEntryApi/ai-quota.js`：

| 机制 | 实现 |
| --- | --- |
| 结果缓存 | `sha256(NFKC去空白小写(text) \| serverToday)`，TTL 6 小时、上限 200 条，命中记 `AI_PARSE_CACHE_HIT` 并直接返回 |
| 每日限次 | 按 `OPENID`，默认 50 次/天（`QUICK_ENTRY_AI_DAILY_LIMIT` 覆盖），超限记 `AI_QUOTA_EXCEEDED` 后静默降级 |
| 近限告警 | 到 80% 记 `AI_QUOTA_NEAR_LIMIT`，日志里带 `used/limit` |
| 并发超限 | `ai-parse.js` 捕获 `EXCEED_CONCURRENT_REQUEST_LIMIT`，退避 300ms 重试一次；仍在超时/超限就交给调用方降级 |
| 用量记录 | 每次成功调用记 `AI_TOKEN_USAGE`（`result.usage`） |

### 有意偏离计划的两处

1. **限次与缓存放云函数实例内存，不落云数据库。** 集合不存在会让云函数直接报错，而本项目已经因为
   「配置不随部署生效」踩过一次坑（见第 12 节与 `docs/cloud-deployment.md` 3.3）；
   单次解析约 1 Token 点（0.001 元），内存限次足够挡误触与脚本刷量。真要精确计量再换集合，`ai-quota.js` 接口不变。
2. **没有把 AI 追不回的字段塞进 `confirmationFields`**（第 5 节要求 `domain/quick-entry.ts` 零改动）。
   改用 `aiMissingFields` + 卡片上一行「AI 没在原文里找到数量/单位，已按默认值填上，请核对」表达，
   不动草稿的 `savable` 判定——否则 `香蕉，2026年9月14号过期` 这类本来就合法的草稿会被降级成「待确认」。

### P2-11 / P2-12 前端

- `QUICK_ENTRY_FEATURES.aiParse`（`config/runtime.ts`）+ `getCapabilities().aiText` 双开关；按钮始终显示，未接入时静默、不弹提示。
- 识别中文案：AI 路径显示「AI 识别中…」，超过 3 秒改「正在仔细识别…」；确定性规则仍显示「正在识别…」。
- 草稿卡在 `parserVersion` 以 `ai-` 开头时显示 `AI` 徽章。
- 三级降级对用户完全静默：不弹 toast、不暴露错误码。

### 本地调试跑不了 AI（2026-09-10 实测）

开发者工具的「云函数本地调试」跑的是本地 node 进程，没有云开发网关注入，`cloud.ai()` 的 `/v1/ai/`
请求会被直接 **404**，日志长这样：

```text
{"resultCode":"AI_PARSE_DEGRADED","reason":"404","durationMs":485}
{"requestId":"...","action":"parseText","resultCode":"OK","durationMs":506}
```

485ms 后静默降级本地规则、接口照样返回 `OK`——功能没坏，但每次白等约 0.5s，日志还会被误读成代码 bug。
`ai-client.js` 现在按 `TENCENTCLOUD_RUNENV === 'WX_LOCAL_SCF'`（SDK 内部区分本地调试用的同一个变量）
识别该形态并**默认跳过 AI**，`capabilities.aiText` 也如实返回 `false`，前端不显示 AI 文案与徽章；
要在本地调试里联调云端 AI，把 `QUICK_ENTRY_AI_LOCAL_DEBUG` 设为 `true`。
**验证 AI 路径只能走云端**：关掉本地调试开关，用模拟器非本地调试模式或真机。

### P2-13 隐私

`runtime.ts` 的注释约束已落地为明确要求：在微信公众平台「用户隐私保护指引」声明
**用户输入的物品文字会发送至大模型（云开发内置混元）用于结构化解析**，评审未过时把 `aiParse` 置 false。
`docs/cloud-deployment.md` 3.3 与 `docs/quick-entry-acceptance.md` 同步补了这条。

### P2-14 语音链路

无需额外改动。语音转写后回填 `inputText` 并走 `generateDrafts('voice')`，与文字共用同一条
`parseQuickText → 云函数 parseText → AI` 链路，`parserVersion`、`AI` 徽章、证据回链全部自动生效。

### 测试

- `tests/unit/ai-parse.test.ts`：39 条（含 8 条证据回链、5 条验收用例、3 条并发退避）。
- `tests/unit/ai-quota.test.ts`：9 条（缓存键归一化、TTL/隔离、限次、近限水位、跨天重置）。
- `tests/unit/quick-entry-page.test.ts`：新增 5 条 AI 表现用例。
- `npm run check` 全绿（14 个测试文件 / 175 项测试）。

### 仍需真机复核

1. `EXCEED_CONCURRENT_REQUEST_LIMIT` 退避重试在真实并发下的触发与成功率。
2. `AI_PARSE_CACHE_HIT` 的实际命中率（重复录入同一句话是否真的 0 成本）。
3. `AI_QUOTA_NEAR_LIMIT` / `AI_TOKEN_USAGE` 日志在云开发控制台是否方便观察，日限量 50 是否合适。


