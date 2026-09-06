/**
 * Client 半打包管线（esbuild）：src/client/index.ts → lib/client.js，
 * 产出 dsh 模块加载器的 lazy-CJS factory 产物（banner/footer 包装）。
 * 构建后自检：产物以 banner 开头、footer 结尾，且全部 require() 都指向 baseline external。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** 浏览器模块表基线：产物只允许 require 这 8 个 specifier，其余一律内联。 */
const BASELINE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** 插件包名：注册 id 必须与 loader 期望的 entry 名一致，从 package.json 读取避免改名遗漏。 */
const packageName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

/** 加载器交接包装（与 dsh 内置 UI 包的 tsdown 产物形态一致）。 */
const BANNER = `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`
const FOOTER = 'return module.exports; } });'

const outFile = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const entry = fileURLToPath(new URL('../src/client/index.ts', import.meta.url))

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  sourcemap: true,
  jsx: 'automatic',
  external: BASELINE_EXTERNALS,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  banner: { js: BANNER },
  footer: { js: FOOTER },
  logLevel: 'info',
})

// —— 构建后自检 ——
// esbuild 会把 //# sourceMappingURL 注释放到 footer 之后，比对前先剥离
const code = readFileSync(outFile, 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '')
const fail = (message) => {
  console.error(`build-client: ${message}`)
  process.exit(1)
}
if (!code.startsWith(BANNER)) fail('产物缺少 __ModuleLoader__ banner 头')
if (!code.trimEnd().endsWith(FOOTER)) fail('产物缺少 __ModuleLoader__ footer 尾')
const requested = new Set()
for (const match of code.matchAll(/\brequire\(("|')([^"']+)\1\)/g)) requested.add(match[2])
const unexpected = [...requested].filter((specifier) => !BASELINE_EXTERNALS.includes(specifier))
if (unexpected.length > 0) {
  fail(`产物含非 baseline external 的 require：${unexpected.join(', ')}`)
}
console.log(`build-client: OK（external require：${[...requested].join(', ') || '无'}）`)
