import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const files = []

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const target = join(directory, entry.name)
    if (entry.isDirectory()) walk(target)
    else files.push(target)
  }
}

walk(root)

for (const file of files.filter((candidate) => extname(candidate) === '.json')) {
  try {
    JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    errors.push(`${file}: JSON 无法解析（${error.message}）`)
  }
}

const appJsonPath = join(root, 'miniprogram', 'app.json')
const appConfig = JSON.parse(readFileSync(appJsonPath, 'utf8'))
for (const page of appConfig.pages) {
  for (const extension of ['.ts', '.json', '.wxml', '.wxss']) {
    const file = join(root, 'miniprogram', `${page}${extension}`)
    if (!existsSync(file)) errors.push(`${file}: app.json 声明的页面文件缺失`)
  }
}

for (const configPath of files.filter((file) => file.endsWith('.json'))) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (!config.usingComponents) continue
  for (const componentPath of Object.values(config.usingComponents)) {
    if (typeof componentPath !== 'string' || !componentPath.startsWith('/')) continue
    const base = join(root, 'miniprogram', componentPath.slice(1))
    for (const extension of ['.ts', '.json', '.wxml', '.wxss']) {
      if (!existsSync(`${base}${extension}`)) {
        errors.push(`${configPath}: 组件 ${componentPath}${extension} 不存在`)
      }
    }
  }
}

for (const templatePath of files.filter((file) => file.endsWith('.wxml'))) {
  const scriptPath = templatePath.replace(/\.wxml$/, '.ts')
  if (!existsSync(scriptPath)) continue
  const template = readFileSync(templatePath, 'utf8')
  const script = readFileSync(scriptPath, 'utf8')
  const bindingPattern = /\b(?:bind|catch)(?::[\w-]+|[\w-]+)="([A-Za-z_$][\w$]*)"/g
  for (const match of template.matchAll(bindingPattern)) {
    const handler = match[1]
    if (!new RegExp(`\\b${handler}\\s*\\(`).test(script)) {
      errors.push(`${templatePath}: 事件处理函数 ${handler} 未在同名 TypeScript 文件中定义`)
    }
  }
}

const cloudRoot = join(root, 'cloudfunctions')
const cloudFunctions = readdirSync(cloudRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
const expectedCloudFunctions = ['cleanupTrash', 'dispatchReminders', 'inventoryApi', 'quickEntryApi', 'reminderApi', 'userApi']
const actualCloudFunctions = cloudFunctions.map((entry) => entry.name).sort()
if (JSON.stringify(actualCloudFunctions) !== JSON.stringify(expectedCloudFunctions)) {
  errors.push(`云函数清单不正确：期望 ${expectedCloudFunctions.join(', ')}，实际 ${actualCloudFunctions.join(', ')}`)
}
for (const entry of cloudFunctions) {
  if (!entry.isDirectory()) continue
  const directory = join(cloudRoot, entry.name)
  for (const required of ['index.js', 'package.json', 'package-lock.json', 'config.json']) {
    if (!existsSync(join(directory, required))) {
      errors.push(`${directory}: 缺少 ${required}`)
    }
  }
  const packageConfig = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (packageConfig.engines?.node !== '20') errors.push(`${directory}: Node.js 运行时必须为 20`)
}

const runtimeSource = readFileSync(join(root, 'miniprogram', 'config', 'runtime.ts'), 'utf8')
const reminderSource = readFileSync(join(cloudRoot, 'reminderApi', 'index.js'), 'utf8')
const templateSource = readFileSync(join(cloudRoot, 'dispatchReminders', 'template.js'), 'utf8')
const clientTemplateId = /REMINDER_TEMPLATE_ID\s*=\s*'([^']+)'/.exec(runtimeSource)?.[1]
const serverTemplateId = /REMINDER_TEMPLATE_ID\s*=\s*'([^']+)'/.exec(reminderSource)?.[1]
if (!clientTemplateId || clientTemplateId.startsWith('TODO_')) errors.push('客户端提醒模板 ID 仍是占位值')
if (clientTemplateId !== serverTemplateId) errors.push('客户端与 reminderApi 的提醒模板 ID 不一致')

for (const field of ["name: 'thing7'", "expiryDate: 'time2'", "remainingDays: 'number5'", "quantity: 'number4'", "note: 'thing3'"]) {
  if (!templateSource.includes(field)) errors.push(`提醒模板字段缺失或错误：${field}`)
}

const dispatchConfig = JSON.parse(readFileSync(join(cloudRoot, 'dispatchReminders', 'config.json'), 'utf8'))
const inventoryConfig = JSON.parse(readFileSync(join(cloudRoot, 'inventoryApi', 'config.json'), 'utf8'))
const reminderConfig = JSON.parse(readFileSync(join(cloudRoot, 'reminderApi', 'config.json'), 'utf8'))
const cleanupConfig = JSON.parse(readFileSync(join(cloudRoot, 'cleanupTrash', 'config.json'), 'utf8'))
const cloudbaseConfig = JSON.parse(readFileSync(join(root, 'cloudbaserc.json'), 'utf8'))
const inventoryCloudbaseConfig = cloudbaseConfig.functions?.find((item) => item.name === 'inventoryApi')
if (dispatchConfig.timeout !== 60) errors.push('dispatchReminders 超时必须为 60 秒')
if (inventoryConfig.envVariables?.COVER_IMAGE_ENABLED !== 'true') {
  errors.push('inventoryApi AI 封面必须显式开启')
}
if (inventoryCloudbaseConfig?.envVariables?.COVER_IMAGE_ENABLED !== inventoryConfig.envVariables?.COVER_IMAGE_ENABLED) {
  errors.push('cloudbaserc.json 与 inventoryApi/config.json 的 AI 封面开关不一致')
}
if (reminderConfig.timeout !== 10) errors.push('reminderApi 超时必须为 10 秒')
if (cleanupConfig.timeout !== 60) errors.push('cleanupTrash 超时必须为 60 秒')
if (dispatchConfig.envVariables?.MINIPROGRAM_STATE !== 'formal') errors.push('正式发布跳转状态必须为 formal')
if (dispatchConfig.triggers?.[0]?.config !== '0 0 14 * * * *') errors.push('提醒触发器必须为北京时间 14:00')
if (cleanupConfig.triggers?.[0]?.config !== '0 30 3 * * * *') errors.push('回收站清理触发器必须为北京时间 03:30')

const productionFiles = files.filter((file) =>
  (file.startsWith(join(root, 'miniprogram')) || file.startsWith(cloudRoot))
  && !file.endsWith('package-lock.json'))
const retiredNeedles = [
  'scope.record', 'getRecorderManager', '<camera', 'chooseMedia',
  'transcribeVoice', 'recognizeDatePhoto', 'createMediaUpload',
  'tencentcloud-sdk-nodejs-asr', 'tencentcloud-sdk-nodejs-ocr',
  'QUICK_ENTRY_STT_', 'QUICK_ENTRY_OCR_', 'QUICK_ENTRY_TENCENT_',
]
for (const file of productionFiles) {
  const source = readFileSync(file, 'utf8')
  for (const needle of retiredNeedles) {
    if (source.includes(needle)) errors.push(`${file}: 仍包含已下线能力 ${needle}`)
  }
}

for (const file of files.filter(
  (candidate) => candidate.includes(`${join(root, 'cloudfunctions')}\\`) && candidate.endsWith('.js'),
)) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) errors.push(`${file}: ${result.stderr.trim()}`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`项目结构检查通过：${appConfig.pages.length} 个页面，${cloudFunctions.length} 个云函数，JSON 与云函数语法有效。`)
