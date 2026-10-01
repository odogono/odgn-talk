import nkzw from '@nkzw/eslint-config';

export default [
  {
    ignores: [
      '.cache/**',
      '.claude/**',
      '.codex/**',
      '.vscode/**',
      'dist/**',
      'node_modules/**',
      'src/generated/**',
      'spec/**',
    ],
  },
  ...nkzw.map(config => ({
    ...config,
    files: config.files ?? ['**/*.ts', 'eslint.config.js'],
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { Bun: 'readonly' },
    },
    rules: {
      // Table and map insertion order can be observable in the Core and Spec tools.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      'arrow-body-style': ['error', 'as-needed'],
      'arrow-parens': ['error', 'as-needed'],
      'arrow-spacing': ['error', { after: true, before: true }],
      'func-style': ['error', 'expression', { allowArrowFunctions: true }],
      'no-var': 'error',
      'perfectionist/sort-objects': 'off',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
    },
    settings: {
      'import-x/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
  },
  {
    files: ['tools/**/*.ts'],
    rules: {
      // These command-line Hosts print their reports and diagnostics.
      'no-console': 'off',
    },
  },
  {
    files: [
      'tools/corpus/**/*.ts',
      'tools/grammar/**/*.ts',
      'tools/machine/**/*.ts',
      'tools/spec/**/*.ts',
      'types/toml.d.ts',
    ],
    rules: {
      // Existing Spec prototypes use dynamic parse trees and schema-validated TOML.
      '@typescript-eslint/no-explicit-any': 'off',
      // Their small validators keep helpers next to the schema they validate.
      'unicorn/consistent-function-scoping': 'off',
    },
  },
  {
    files: ['src/encoding.ts', 'src/readers.ts', 'tools/corpus/check.ts'],
    rules: {
      // JSON/display readers must recognize the Spec's exact control-character ranges.
      'no-control-regex': 'off',
    },
  },
];
