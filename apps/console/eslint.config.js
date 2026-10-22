// REQ-UI-003 — console lint config: the repository rules, plus the Next.js exemption for files whose default export
// is the framework contract (pages, layouts, not-found, middleware, config files).
import tseslint from 'typescript-eslint';
import root from '../../eslint.config.js';

export default tseslint.config(
  { ignores: ['.next/**', 'next-env.d.ts', 'test-results/**', 'playwright-report/**'] },
  ...root,
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: [
      'src/app/**/page.tsx',
      'src/app/**/layout.tsx',
      'src/app/**/not-found.tsx',
      'src/middleware.ts',
      'next.config.mjs',
      'postcss.config.mjs',
      'eslint.config.js',
      'playwright.config.ts',
      'vitest.config.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
