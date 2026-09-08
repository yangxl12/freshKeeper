import { readFileSync, writeFileSync } from 'node:fs'
const source = new URL('../miniprogram/domain/quick-text.js', import.meta.url)
const target = new URL('../cloudfunctions/quickEntryApi/quick-text.js', import.meta.url)
const content = readFileSync(source, 'utf8')
if (process.argv.includes('--write')) writeFileSync(target, content)
else if (readFileSync(target, 'utf8') !== content) throw new Error('Run node scripts/sync-quick-parser.mjs --write')
