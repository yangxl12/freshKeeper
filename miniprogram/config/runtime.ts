/**
 * 本地接入真实小程序时填写。不要在仓库中提交密钥。
 * 云环境 ID 为空时使用开发者工具当前关联的云环境。
 */
export const CLOUD_ENV_ID = 'cloud1-d0gkh66ce94b1be08'

/**
 * 到期提醒的订阅消息模板 ID。
 *
 * 模板「物品保质期到期提醒」需在微信公众平台 → 功能 → 订阅消息 里创建
 * （或从模板库选用），字段依次为：物品名称 / 到期日期 / 物品类型 / 存放位置 / 数量。
 * 建好后把下面的占位串换掉，并同步 `cloudfunctions/dispatchReminders/template.js`
 * 里的 TEMPLATE_FIELDS 与 `cloudfunctions/reminderApi/index.js` 里的 REMINDER_TEMPLATE_ID。
 */
export const REMINDER_TEMPLATE_ID = 'TODO_REPLACE_WITH_REAL_TEMPLATE_ID'

/**
 * 快速录入能力开关。
 * 这里只决定按钮显不显示；真正能不能用还要看云端 `getCapabilities()` 的下发结果。
 * 文字/语音走云端大模型（混元 hy3），所以在微信公众平台的「用户隐私保护指引」里必须声明
 * 「用户输入的物品文字会发送至大模型用于结构化解析」。评审没过之前把 `aiParse` 置 false。
 */
export const QUICK_ENTRY_FEATURES = {
  recent: true,
  text: true,
  voice: false,
  datePhoto: false,
  aiParse: true,
} as const
