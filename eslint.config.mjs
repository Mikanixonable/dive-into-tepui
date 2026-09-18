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
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
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
