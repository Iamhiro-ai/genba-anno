// =============================================================================
// preload — M0 スキャフォールドのスタブ実装
//
// !!! これは起動確認用の骨組みです。M3（Electron 統合）で本実装に置き換えます。!!!
//   現状実装済み: appVersion() / imageUrl() / setDirtyState()(no-op)
//   それ以外は「M3で実装」の Error で reject する。
//
// 契約: src/shared/ipc.ts の GenbaAnnoIpc（変更禁止）。
//   window.genbaAnno に公開するのはこのオブジェクトのみ。
//   sandbox: true のため、この preload は CJS へバンドルされる必要がある
//   （electron.vite.config.ts の preload.build.rollupOptions.output.format = 'cjs'）。
// =============================================================================

import { contextBridge, ipcRenderer } from 'electron';
import { ANNO_PROTOCOL, IPC, type GenbaAnnoIpc } from '../src/shared/ipc';

/** M3 で実装予定のメソッド用プレースホルダ */
function notImplemented(method: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new Error(`[GenbaAnno] window.genbaAnno.${method}() は M3（Electron 統合）で実装されます`),
    );
}

const api: GenbaAnnoIpc = {
  // --- ダイアログ（M3） ---
  pickImageDir: notImplemented('pickImageDir'),
  pickDir: notImplemented('pickDir'),
  pickVideo: notImplemented('pickVideo'),

  // --- プロジェクト（M3） ---
  projectOpen: notImplemented('projectOpen'),
  projectRelist: notImplemented('projectRelist'),
  projectSaveFile: notImplemented('projectSaveFile'),
  projectListRecent: notImplemented('projectListRecent'),

  // --- サイドカー（M3） ---
  sidecarLoad: notImplemented('sidecarLoad'),
  sidecarSave: notImplemented('sidecarSave'),
  sidecarLoadAll: notImplemented('sidecarLoadAll'),

  // --- エクスポート（M3） ---
  exportBegin: notImplemented('exportBegin'),
  exportCopyImage: notImplemented('exportCopyImage'),
  exportWriteFile: notImplemented('exportWriteFile'),
  exportEnd: notImplemented('exportEnd'),

  // --- 動画フレーム抽出（M3 + M7） ---
  videoExtract: notImplemented('videoExtract'),
  onVideoExtractProgress: () => {
    // M3 で ipcRenderer.on(IPC.videoExtractProgress, …) を張る。現状は購読解除の no-op を返す。
    return () => undefined;
  },

  // --- その他 ---
  shellReveal: notImplemented('shellReveal'),
  appVersion: () => ipcRenderer.invoke(IPC.appVersion) as Promise<string>,
  setDirtyState: () => {
    // M3 で ipcRenderer.send(IPC.appDirtyState, dirty) を実装する。
  },

  // 純粋な URL 組み立てのみ。実際の配信は M3 の anno:// プロトコルハンドラが行う。
  imageUrl: (dir: string, file: string) =>
    `${ANNO_PROTOCOL}://image/${encodeURIComponent(dir)}/${encodeURIComponent(file)}`,
};

contextBridge.exposeInMainWorld('genbaAnno', api);
