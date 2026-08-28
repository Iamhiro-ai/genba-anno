// =============================================================================
// StorageAdapter インターフェース（実装契約）
// 管理: オーケストレーター。変更にはオーケストレーター承認が必要。
//
// レンダラ（React 側）はストレージへ必ずこのインターフェース経由でアクセスする。
//   - electronAdapter: window.genbaAnno（preload 経由 IPC）をラップ
//   - mockAdapter: ブラウザ単体実行（npm run dev:web）用。Canvas 生成のサンプル画像を内蔵し、
//     保存はメモリ上に保持（E2E テストで内容を検査できるよう export で取り出せること）
// =============================================================================

import type {
  ExportProgress,
  ImageEntry,
  Project,
  RecentProject,
  SidecarFile,
  VideoExtractParams,
  VideoExtractProgress,
} from '../core/types';

/** プロジェクト（フォルダ）を開いた結果 */
export interface OpenProjectResult {
  dir: string; // 絶対パス（mock は仮想 ID）
  /** project.json が無かった場合は null（呼び出し側がデフォルト生成して保存する） */
  project: Project | null;
  images: ImageEntry[]; // 自然順ソート済み
  /** 読み込み時に壊れていて無視したサイドカーのファイル名（警告表示用） */
  corruptSidecars: string[];
  /** project.json の修復・退避など、ユーザーに見せるべき警告（日本語・トースト用） */
  warnings: string[];
  /** 保存を進めると元データが失われ得る状態（詳細は shared/ipc.ts の同名フィールド参照） */
  lossy: boolean;
}

/**
 * エクスポート書き込みセッション。
 * begin で確保した出力先以外へは書けない（パス検証は adapter/main 側の責務）。
 */
export interface ExportWriter {
  /** プロジェクト内の画像を無変換でコピー（EXIF orientation 1/なしの場合） */
  copyImage(srcFile: string, destRelPath: string): Promise<void>;
  /** 生成したバイナリ/テキストを書き込む（labels, masks, data.yaml, manifest, 再エンコード画像） */
  writeFile(destRelPath: string, data: Uint8Array | string): Promise<void>;
  /** セッション終了（mock はここで結果を確定） */
  end(): Promise<void>;
}

export interface StorageAdapter {
  readonly kind: 'electron' | 'mock';

  // --- プロジェクト ---
  /** フォルダ選択ダイアログ。キャンセルは null */
  pickImageDirectory(): Promise<string | null>;
  openProject(dir: string): Promise<OpenProjectResult>;
  /** 画像一覧の再走査（フォルダに画像が追加された時用） */
  relistImages(dir: string): Promise<ImageEntry[]>;
  listRecent(): Promise<RecentProject[]>;
  saveProjectFile(dir: string, project: Project): Promise<void>;

  // --- 画像・サイドカー ---
  /** <img src> に渡せる URL（electron: anno://…、mock: blob/data URL） */
  imageUrl(dir: string, file: string): string;
  loadSidecar(dir: string, file: string): Promise<SidecarFile | null>;
  /** 原子的書き込み + 直前世代バックアップ */
  saveSidecar(dir: string, file: string, data: SidecarFile): Promise<void>;
  /** エクスポート用: 全サイドカーの一括読込（IPC 往復を画像ごとに発生させない） */
  loadAllSidecars(dir: string): Promise<{
    sidecars: { file: string; data: SidecarFile }[];
    corrupt: string[];
  }>;

  // --- エクスポート ---
  /** 出力先フォルダ選択ダイアログ（タイトル指定可）。キャンセルは null */
  pickDirectory(title: string): Promise<string | null>;
  beginExport(projectDir: string, destDir: string): Promise<ExportWriter>;

  // --- 動画フレーム抽出（M7。electron のみ。mock は throw ではなく supported=false） ---
  readonly videoSupported: boolean;
  pickVideoFile(): Promise<string | null>;
  extractFrames(
    params: VideoExtractParams,
    onProgress: (p: VideoExtractProgress) => void,
  ): Promise<void>;

  // --- その他 ---
  revealInFolder(absPath: string): Promise<void>; // Finder/Explorer で表示（mock は no-op）
  appVersion(): Promise<string>;
}

/** エクスポート実行時の進捗コールバック */
export type ExportProgressHandler = (p: ExportProgress) => void;
