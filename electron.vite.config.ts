import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * 本番ビルドの index.html に CSP の meta タグを注入する。
 * dev サーバには適用しない（Vite / React Fast Refresh がインラインの module script を
 * 使うため、script-src 'self' だと HMR が動かなくなる）。
 * anno: は M3 で登録する画像配信用カスタムプロトコル。
 */
function injectCspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // React のインラインスタイル用
    "img-src 'self' data: blob: anno:",
    "media-src 'self' data: blob: anno:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');

  return {
    name: 'genba-anno:inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
      // <meta charset> は head の先頭に残す必要があるため、その直後に差し込む
      const charset = '<meta charset="UTF-8" />';
      return html.includes(charset)
        ? html.replace(charset, `${charset}\n    ${meta}`)
        : html.replace('<head>', `<head>\n    ${meta}`);
    },
  };
}

// -----------------------------------------------------------------------------
// electron-vite ビルド構成
//   main     : electron/main.ts     -> out/main/main.js      (CJS)
//   preload  : electron/preload.ts  -> out/preload/preload.js(CJS / sandbox 対応)
//   renderer : index.html + src/    -> out/renderer/
//
// パスエイリアスは意図的に定義しない（モジュール間は相対 import で統一する。
// docs/DESIGN.md §3 の依存方向を import パスから目視できるようにするため）。
// -----------------------------------------------------------------------------

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
      rollupOptions: { output: { entryFileNames: 'main.js' } },
    },
    // dependencies（ffmpeg-static 等）は bundle せず実行時 require させる
    plugins: [externalizeDepsPlugin()],
  },

  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      // sandbox: true の preload は CJS でなければならない
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'preload.js' } },
    },
    plugins: [externalizeDepsPlugin()],
  },

  renderer: {
    root: __dirname,
    build: {
      outDir: 'out/renderer',
      emptyOutDir: true,
      // electron-vite の既定は minify: false。配布物のサイズを抑えるため明示的に有効化する
      // （main / preload は既定のまま非圧縮 = クラッシュ時のスタックトレースを読めるように）
      minify: 'esbuild',
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
    plugins: [react(), injectCspPlugin()],
    server: { port: 5173 },
  },
});
