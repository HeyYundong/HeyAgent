import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // src/components/ui 和 src/hooks 归 shadcn CLI 管，不手改（docs/ui-rules.md §5.7）。
  // 上游的 hooks/use-mobile.ts 过不了 react-hooks/set-state-in-effect（2026-10-17 用 `shadcn add use-mobile --diff` 看过，上游还没修），所以不检查这两处
  globalIgnores(['dist', 'src/components/ui', 'src/hooks']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
