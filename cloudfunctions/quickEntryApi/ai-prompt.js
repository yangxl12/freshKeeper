'use strict'

// 模型看到的指令只在这里定义。改 prompt 后必须重跑 tests/unit/ai-parse.test.ts 与验收用例。
const SYSTEM_PROMPT = [
  '你是保质期管理小程序的录入解析器：把用户的一句话拆成结构化物品清单。',
  '',
  '只输出一个 JSON 对象。不要 markdown 代码块，不要解释文字，不要注释。',
  '',
  '输出格式：',
  '{"items":[{"name":字符串或null,"quantity":正整数或null,"unit":字符串或null,"category":"food"|"medicine"|"household"|"other"|null,"storageLocation":字符串或null,"dateFacts":[日期事实],"evidence":{"name":字符串,"quantity":字符串,"unit":字符串,"storageLocation":字符串}}]}',
  '',
  '日期事实只描述原文里出现的时间，可选形态：',
  '- 相对时间（今天/明天/后天/3天后/半个月后/2周后）：{"kind":"relative","offsetDays":整数,"label":"expiry"|"production","rawText":"原文片段"}',
  '- 明确的年月日：{"kind":"absolute","year":整数,"month":整数,"day":整数,"label":"expiry"|"production","rawText":"原文片段"}',
  '- 只有月日、没有年份：{"kind":"absolute","month":整数,"day":整数,"label":"expiry"|"production","rawText":"原文片段"}',
  '- 保质期时长：{"kind":"shelf_life","value":正整数,"unit":"day"|"month"|"year","rawText":"原文片段"}',
  '',
  'evidence 是证据：每个非 null 的字段都要给出它在原文中对应的连续片段，必须从原文原样复制。',
  '服务端会拿 evidence 去原文里核对，对不上的字段会被直接丢弃，所以宁可返回 null 也不要编造。',
  'dateFacts 的 rawText 承担同样的职责，同样是原文的原样片段（例如“2周后过期”“保质期21天”）。',
  '',
  '铁律：',
  '1. 原文没有明确说出来的字段一律返回 null。禁止推测、禁止补全、禁止使用常识。',
  '2. 绝对不要计算日期。日期换算由服务端完成，你只负责把时间表达翻译成上面的结构。',
  '3. 原文没有写数量时 quantity 必须是 null，绝对不能默认填 1。',
  '4. 中文数字数量（一包、两盒、三个）要转成阿拉伯数字放进 quantity，evidence 里给出包含中文数字的原文片段。',
  '5. quantity 与 value 必须是正整数；offsetDays 是整数（今天=0，明天=1，后天=2，2周后=14）。',
  '6. category 只能取 food（食品）、medicine（药品）、household（日化）、other（其他）；拿不准就 null。',
  '7. storageLocation 只填原文里明确出现的地点，例如“放冰箱”填“冰箱”，evidence 给“放冰箱”。',
  '8. 与物品无关的闲聊直接返回 {"items":[]}。',
  '9. 一次最多 5 件物品。',
].join('\n')

const EXAMPLES = [
  [
    '鲜牛奶2盒9月12日到期，放冰箱',
    '{"items":[{"name":"鲜牛奶","quantity":2,"unit":"盒","category":"food","storageLocation":"冰箱","dateFacts":[{"kind":"absolute","month":9,"day":12,"label":"expiry","rawText":"9月12日到期"}],"evidence":{"name":"鲜牛奶","quantity":"2盒","unit":"2盒","storageLocation":"放冰箱"}}]}',
  ],
  [
    '瓜子一包2周后过期',
    '{"items":[{"name":"瓜子","quantity":1,"unit":"包","category":"food","storageLocation":null,"dateFacts":[{"kind":"relative","offsetDays":14,"label":"expiry","rawText":"2周后过期"}],"evidence":{"name":"瓜子","quantity":"一包","unit":"一包"}}]}',
  ],
  [
    '买了三个苹果',
    '{"items":[{"name":"苹果","quantity":3,"unit":null,"category":"food","storageLocation":null,"dateFacts":[],"evidence":{"name":"苹果","quantity":"三个"}}]}',
  ],
  [
    '牛奶',
    '{"items":[{"name":"牛奶","quantity":null,"unit":null,"category":"food","storageLocation":null,"dateFacts":[],"evidence":{"name":"牛奶"}}]}',
  ],
  [
    '酸奶保质期21天',
    '{"items":[{"name":"酸奶","quantity":null,"unit":null,"category":"food","storageLocation":null,"dateFacts":[{"kind":"shelf_life","value":21,"unit":"day","rawText":"保质期21天"}],"evidence":{"name":"酸奶"}}]}',
  ],
  [
    '帮我看看今天天气',
    '{"items":[]}',
  ],
]

const REPAIR_NOTICE = '上面的输出不是合法 JSON。请只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。'

function userPrompt(text) {
  // 用围栏隔开用户输入，顺手拆掉可能破坏围栏的连续引号。
  return `待解析输入：\n"""\n${String(text).replace(/"{3,}/g, '”””')}\n"""`
}

function buildMessages(text) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
  for (const [sample, expected] of EXAMPLES) {
    messages.push({ role: 'user', content: userPrompt(sample) })
    messages.push({ role: 'assistant', content: expected })
  }
  messages.push({ role: 'user', content: userPrompt(text) })
  return messages
}

function buildRepairMessages(text, previousOutput) {
  const previous = typeof previousOutput === 'string' ? previousOutput.trim().slice(0, 2000) : ''
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(text) },
    { role: 'assistant', content: previous || '(空)' },
    { role: 'user', content: REPAIR_NOTICE },
  ]
}

module.exports = { SYSTEM_PROMPT, buildMessages, buildRepairMessages, userPrompt }
