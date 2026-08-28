// =============================================================================
// IPC 契約（main ⇔ preload ⇔ renderer）
// 管理: オーケストレーター。変更にはオーケストレーター承認が必要。
//
// セキュリティ方針:
//   - contextIsolation: true / nodeIntegration: false / sandbox: true
//   - preload は contextBridge で window.genbaAnno にこの GenbaAnnoIpc のみを公開する
//   - パス結合・検証は必ず main 側で行う:
//       * project:* / sidecar:* の dir は「このセッションで dialog により選択されたフォルダ」
//         の許可リストに載っているものだけ受け付ける（recent 復元時は open で再登録）
//       * file はパス区切り・'..'・NUL を含まないベース名のみ受け付ける
//       * export:write の destRelPath は正規化後に destDir 配下であることを検証する
//   - 画像配信は anno:// カスタムプロトコル。URL に埋めるのは opaque な projectId + ファイル名
//     とし、main 側で許可リスト経由の絶対パスへ解決する
// =============================================================================

import type {
  ImageEntry,
  Project,
  RecentProject,
  SidecarFile,
  VideoExtractParams,
  VideoExtractProgress,
} from '../core/types';

// ---------------------------------------------------------------------------
// チャネル名（invoke/handle）
// ---------------------------------------------------------------------------

export const IPC = {
  dialogPickImageDir: 'dialog:pickImageDir',
  dialogPickDir: 'dialog:pickDir',
  dialogPickVideo: 'dialog:pickVideo',
  projectOpen: 'project:open',
  projectRelist: 'project:relist',
  projectSaveFile: 'project:saveFile',
  projectListRecent: 'project:listRecent',
  sidecarLoad: 'sidecar:load',
  sidecarSave: 'sidecar:save',
  sidecarLoadAll: 'sidecar:loadAll',
  exportBegin: 'export:begin',
  exportCopyImage: 'export:copyImage',
  exportWriteFile: 'export:writeFile',
  exportEnd: 'export:end',
  videoExtract: 'video:extract',
  videoExtractProgress: 'video:extractProgress', // main → renderer (send)
  shellReveal: 'shell:reveal',
  appVersion: 'app:version',
  appDirtyState: 'app:dirtyState', // renderer → main: 閉じる前確認用の dirty フラグ通知
} as const;

// ---------------------------------------------------------------------------
// ペイロード型
// ---------------------------------------------------------------------------

export interface IpcOpenProjectResult {
  dir: string;
  /**
   * project.json が無い場合 null（renderer がデフォルト生成→保存）。
   * JSON.parse 不能なほど壊れている場合も null だが、main は上書き前に必ず
   * 原本を _anno/project.json.corrupt-<ISO8601> へ退避し、warnings で通知する。
   * parse 可能で内容が不正な場合は jsonToProject が修復した Project を返し、
   * 修復内容（クラス id 振り直し等・学習 ID に影響）を warnings に載せる。
   */
  project: Project | null;
  images: ImageEntry[];
  corruptSidecars: string[];
  /** project.json の修復・退避など、ユーザーに見せるべき警告（日本語） */
  warnings: string[];
}

/** エクスポート用: 全サイドカーの一括読込結果（file はプロジェクト内ベース名） */
export interface IpcSidecarBundle {
  sidecars: { file: string; data: SidecarFile }[];
  corrupt: string[];
}

export interface IpcExportSession {
  sessionId: string;
  destDir: string;
}

// ---------------------------------------------------------------------------
// preload が window.genbaAnno に公開する API 形状
// ---------------------------------------------------------------------------

export interface GenbaAnnoIpc {
  pickImageDir(): Promise<string | null>;
  pickDir(title: string): Promise<string | null>;
  pickVideo(): Promise<string | null>;

  projectOpen(dir: string): Promise<IpcOpenProjectResult>;
  projectRelist(dir: string): Promise<ImageEntry[]>;
  projectSaveFile(dir: string, project: Project): Promise<void>;
  projectListRecent(): Promise<RecentProject[]>;

  sidecarLoad(dir: string, file: string): Promise<SidecarFile | null>;
  sidecarSave(dir: string, file: string, data: SidecarFile): Promise<void>;
  /** エクスポート時にまとめて読む（画像ごとの往復を避ける） */
  sidecarLoadAll(dir: string): Promise<IpcSidecarBundle>;

  exportBegin(projectDir: string, destDir: string): Promise<IpcExportSession>;
  exportCopyImage(sessionId: string, srcFile: string, destRelPath: string): Promise<void>;
  exportWriteFile(
    sessionId: string,
    destRelPath: string,
    data: Uint8Array | string,
  ): Promise<void>;
  exportEnd(sessionId: string): Promise<void>;

  videoExtract(params: VideoExtractParams): Promise<void>;
  onVideoExtractProgress(cb: (p: VideoExtractProgress) => void): () => void; // 戻り値=購読解除

  shellReveal(absPath: string): Promise<void>;
  appVersion(): Promise<string>;
  /** dirty 状態を main へ通知（true の間、ウィンドウクローズ時に確認ダイアログ） */
  setDirtyState(dirty: boolean): void;

  /** 画像 URL の組み立て（anno://image/<encodeURIComponent(dir)>/<encodeURIComponent(file)>） */
  imageUrl(dir: string, file: string): string;
}

declare global {
  interface Window {
    /** Electron 実行時のみ存在（ブラウザ実行時は undefined → mockAdapter を使う） */
    genbaAnno?: GenbaAnnoIpc;
  }
}

export const ANNO_PROTOCOL = 'anno';
