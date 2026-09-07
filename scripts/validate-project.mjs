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
for (const entry of cloudFunctions) {
  if (!entry.isDirectory()) continue
  const directory = join(cloudRoot, entry.name)
  for (const required of ['index.js', 'package.json', 'package-lock.json', 'config.json']) {
    if (!existsSync(join(directory, required))) {
      errors.push(`${directory}: 缺少 ${required}`)
    }
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
