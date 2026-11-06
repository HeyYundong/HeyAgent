// Build lib/client.js in dsh's browser-factory format:
//   window.__ModuleLoader__.load({ id, factory: (require) => { CJS body; return module.exports } })
// Externals = dsh's shared platform module table (react, ui-primitives, …),
// see packages/client/web/src/platform.ts PLATFORM_MODULES.
// Run: node build.mjs   (esbuild installed in tmp/dshmock/tools)
import { createRequire } from 'node:module'
// esbuild lives in ../../tools (ESM ignores NODE_PATH, so resolve it explicitly).
const { build } = createRequire(new URL('../../tools/package.json', import.meta.url))('esbuild')
import { writeFileSync } from 'node:fs'

const id = 'heyagent-ui'
const r = await build({
  entryPoints: [new URL('./src/client.jsx', import.meta.url).pathname],
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', write: false,
  jsx: 'automatic',
  loader: { '.css': 'text', '.b64': 'text' },
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-store'],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const body = r.outputFiles[0].text
const out = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n${body}\nreturn module.exports; } });\n`
writeFileSync(new URL('./lib/client.js', import.meta.url), out)
console.log('built lib/client.js', out.length, 'bytes')
