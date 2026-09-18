// DEVELOP/CODING-RULE.md のうち、構文だけで判定できる規則を当てる。
// 既存の違反は eslint-suppressions.json が持ち、件数は減らすだけにする。増やしてよいのは規則を
// 足したときだけで、そのときは `npx eslint --suppress-rule <規則> src tests tools` で既存の違反を載せる。
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const typescriptFiles = ['src/**/*.ts', 'tests/**/*.ts', 'tools/**/*.ts'];

export default defineConfig([
  {
    ignores: [
      'docs/**',
      'tests/dist/**',
      'dist/**',
      '.bgm-lab/**',
      '.cloud-lab/**',
      '.render-lab/**',
    ],
  },
  {
    files: typescriptFiles,
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'default export を使わず、named export を使う。',
        },
        {
          selector: 'TSUnionType > TSUndefinedKeyword',
          message: '不在は T | null で表す(CODING-RULE 1.6)。省略可能な欄 `?:` へ書き換えても不在は undefined のまま。',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/prefer-function-type': 'error',
      '@typescript-eslint/array-type': ['error', { default: 'array' }],
      '@typescript-eslint/parameter-properties': ['error', { prefer: 'parameter-property' }],
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
          accessibility: 'explicit',
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-for-of': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'tools/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      // 長さは責務が複数あることの徴候であって違反ではない(CODING-RULE 1.2)。診断の入口として警告に留める。
      'max-lines': ['warn', 500],
      'max-lines-per-function': ['warn', 100],
    },
  },
  {
    files: ['tools/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
