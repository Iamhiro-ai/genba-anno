import { defineConfig } from 'vitest/config';

// -----------------------------------------------------------------------------
// vitest 設定。electron.vite.config.ts / vite.web.config.ts とは独立（vitest は
// vitest.config.* を優先して読むため、Electron 用のビルド設定と衝突しない）。
//
// 既定は node 環境: core/ の純関数（livewire / lineShape / geometry / serialize /
// export 生成）を DOM 無しで検証する。DOM が要るテストはファイル冒頭に
//   // @vitest-environment jsdom
// を書く方針（jsdom を使う場合は依存追加が必要）。
// -----------------------------------------------------------------------------

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'out/**', 'dist-web/**', 'release/**', 'reference/**'],
  },
});
