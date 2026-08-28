// =============================================================================
// preload（M3 本実装）
//
// 契約: src/shared/ipc.ts の GenbaAnnoIpc（変更禁止）。
//   window.genbaAnno に公開するのはこのオブジェクトのみ。
//   ここは ipcRenderer.invoke への薄いラッパに徹する。
//   パス結合・検証・fs アクセスは一切行わない（すべて main の責務）。
//
// 制約:
//   - sandbox: true のため、この preload は CJS へバンドルされる必要がある
//     （electron.vite.config.ts の preload.build.rollupOptions.output.format = 'cjs'）。
//   - サンドボックス化された preload では node の path / fs は require できない。
//     そのため electron/lib/* は import しない（imageUrl は文字列結合のみで組み立てる）。
// =============================================================================

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ImageEntry,
  Project,
  RecentProject,
  SidecarFile,
  VideoExtractParams,
  VideoExtractProgress,
} from '../src/core/types';
import {
  ANNO_PROTOCOL,
  IPC,
  type GenbaAnnoIpc,
  type IpcExportSession,
  type IpcOpenProjectResult,
  type IpcSidecarBundle,
} from '../src/shared/ipc';

const api: GenbaAnnoIpc = {
  // --- ダイアログ ---------------------------------------------------------
  pickImageDir: () => ipcRenderer.invoke(IPC.dialogPickImageDir) as Promise<string | null>,
  pickDir: (title: string) => ipcRenderer.invoke(IPC.dialogPickDir, title) as Promise<string | null>,
  pickVideo: () => ipcRenderer.invoke(IPC.dialogPickVideo) as Promise<string | null>,

  // --- プロジェクト -------------------------------------------------------
  projectOpen: (dir: string) =>
    ipcRenderer.invoke(IPC.projectOpen, dir) as Promise<IpcOpenProjectResult>,
  projectRelist: (dir: string) =>
    ipcRenderer.invoke(IPC.projectRelist, dir) as Promise<ImageEntry[]>,
  projectSaveFile: (dir: string, project: Project) =>
    ipcRenderer.invoke(IPC.projectSaveFile, dir, project) as Promise<void>,
  projectListRecent: () =>
    ipcRenderer.invoke(IPC.projectListRecent) as Promise<RecentProject[]>,

  // --- サイドカー ---------------------------------------------------------
  sidecarLoad: (dir: string, file: string) =>
    ipcRenderer.invoke(IPC.sidecarLoad, dir, file) as Promise<SidecarFile | null>,
  sidecarSave: (dir: string, file: string, data: SidecarFile) =>
    ipcRenderer.invoke(IPC.sidecarSave, dir, file, data) as Promise<void>,
  sidecarLoadAll: (dir: string) =>
    ipcRenderer.invoke(IPC.sidecarLoadAll, dir) as Promise<IpcSidecarBundle>,

  // --- エクスポート -------------------------------------------------------
  exportBegin: (projectDir: string, destDir: string) =>
    ipcRenderer.invoke(IPC.exportBegin, projectDir, destDir) as Promise<IpcExportSession>,
  exportCopyImage: (sessionId: string, srcFile: string, destRelPath: string) =>
    ipcRenderer.invoke(IPC.exportCopyImage, sessionId, srcFile, destRelPath) as Promise<void>,
  exportWriteFile: (sessionId: string, destRelPath: string, data: Uint8Array | string) =>
    ipcRenderer.invoke(IPC.exportWriteFile, sessionId, destRelPath, data) as Promise<void>,
  exportEnd: (sessionId: string) => ipcRenderer.invoke(IPC.exportEnd, sessionId) as Promise<void>,

  // --- 動画フレーム抽出 ---------------------------------------------------
  videoExtract: (params: VideoExtractParams) =>
    ipcRenderer.invoke(IPC.videoExtract, params) as Promise<void>,
  onVideoExtractProgress: (cb: (p: VideoExtractProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: VideoExtractProgress): void => {
      cb(progress);
    };
    ipcRenderer.on(IPC.videoExtractProgress, listener);
    return () => {
      ipcRenderer.removeListener(IPC.videoExtractProgress, listener);
    };
  },

  // --- その他 -------------------------------------------------------------
  shellReveal: (absPath: string) => ipcRenderer.invoke(IPC.shellReveal, absPath) as Promise<void>,
  appVersion: () => ipcRenderer.invoke(IPC.appVersion) as Promise<string>,
  setDirtyState: (dirty: boolean) => {
    ipcRenderer.send(IPC.appDirtyState, dirty === true);
  },

  // 純粋な URL 組み立てのみ。実際の配信は main の anno:// プロトコルハンドラが
  // 許可リスト検証のうえで行う。
  imageUrl: (dir: string, file: string) =>
    `${ANNO_PROTOCOL}://image/${encodeURIComponent(dir)}/${encodeURIComponent(file)}`,
};

contextBridge.exposeInMainWorld('genbaAnno', api);
