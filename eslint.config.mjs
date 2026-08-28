// =============================================================================
// ESLint flat config
// 方針: TypeScript 推奨 + react-hooks のみ。型情報を使う重いルール
// （projectService）は使わない = 実装効率とチェック速度を優先する。
// 過度に厳しいルールは off にしてあるので、必要になったら都度足すこと。
// =============================================================================

import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'dist-web/**',
      'dist-electron/**',
      'release/**',
      'coverage/**',
      // 移植元の参照実装。読むだけで変更しないので lint 対象外
      'reference/**',
    ],
  },

  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // アンダースコア始まりの引数・変数は未使用を許可（移植コードで頻出）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // 移植・段階実装の途中で邪魔になるものは off
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // 事故に直結するものだけ error のまま残す
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // レンダラ（React）
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Electron main / preload / 設定ファイル: console 利用を許可
  {
    files: ['electron/**/*.ts', '*.config.{ts,mjs}', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
);
