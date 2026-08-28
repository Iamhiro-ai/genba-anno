import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// -----------------------------------------------------------------------------
// `npm run dev:web` 専用の Vite 設定（レンダラのみをブラウザで動かす）。
// window.genbaAnno が存在しない環境になるため、adapters/mockAdapter.ts（M3）が
// 使われる。UI の E2E 検証・スクリーンショット確認用。
// -----------------------------------------------------------------------------

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
  },
  preview: {
    port: 5199,
    strictPort: true,
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'index.html') },
  },
});
