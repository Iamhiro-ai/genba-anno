// =============================================================================
// Electron メインプロセス — M0 スキャフォールドの最小ブート実装
//
// !!! これは起動確認用の骨組みです。M3（Electron 統合）で本実装に置き換えます。!!!
//   M3 の担当範囲:
//     - anno:// カスタムプロトコル登録（許可リスト経由のパス解決・パス検証）
//     - src/shared/ipc.ts の IPC 全チャネルの handle 実装
//     - サイドカーの原子的書込（tmp → rename）+ 直前世代バックアップ
//     - ffmpeg-static による動画フレーム抽出
//     - dirty 状態に応じたクローズ前確認ダイアログ
//     - 本番ビルドの CSP をレスポンスヘッダで付与（現状は index.html への meta 注入のみ）
//
// セキュリティ方針（緩和禁止・CLAUDE.md 参照）:
//   contextIsolation: true / nodeIntegration: false / sandbox: true / webSecurity 既定
// =============================================================================

import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { IPC } from '../src/shared/ipc';

/** electron-vite が dev サーバ起動時に注入する URL。本番ビルドでは undefined */
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL;

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#FFFFFF',
    title: 'GenbaAnno',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 白画面のちらつきを避けてから表示
  win.once('ready-to-show', () => {
    win.show();
  });

  // 外部リンクはアプリ内で開かず既定ブラウザへ（https / mailto のみ許可）
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'https:' || scheme === 'mailto:') {
        void shell.openExternal(url);
      }
    } catch {
      // 不正な URL は無視
    }
    return { action: 'deny' };
  });

  // アプリ内ナビゲーションを禁止（dev サーバと同一オリジンのみ許可）
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    if (RENDERER_DEV_URL) {
      try {
        allowed = new URL(url).origin === new URL(RENDERER_DEV_URL).origin;
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      event.preventDefault();
    }
  });

  if (RENDERER_DEV_URL) {
    void win.loadURL(RENDERER_DEV_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpcHandlers(): void {
  // M0 で実装済みなのは app:version のみ。残りは M3 で追加する。
  ipcMain.handle(IPC.appVersion, () => app.getVersion());
}

void app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();

  // macOS: Dock アイコンから再起動されたときにウィンドウを作り直す
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
