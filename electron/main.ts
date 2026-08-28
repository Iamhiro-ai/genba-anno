// =============================================================================
// Electron メインプロセス（M3 本実装）
//
// 責務:
//   - フォルダ許可リスト（dialog で選択されたパス + recent.json のパスのみ）
//   - anno:// カスタムプロトコルによる画像配信（許可リスト経由でパス解決）
//   - src/shared/ipc.ts の全チャネルの handle 実装
//   - サイドカー / project.json の原子的書込（tmp → rename）+ 直前世代バックアップ
//   - ffmpeg-static による動画フレーム抽出（進捗を renderer へ send）
//   - dirty 状態に応じたクローズ前確認ダイアログ
//   - 本番ビルドの CSP をレスポンスヘッダにも付与
//
// セキュリティ方針（緩和禁止・CLAUDE.md 参照）:
//   contextIsolation: true / nodeIntegration: false / sandbox: true / webSecurity 既定
//   パス結合・検証は必ずこの main 側で行い、レンダラには相対名のみ渡す
//   （docs/DESIGN.md §1・§6 罠 #13）。
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import ffmpegStaticImport from 'ffmpeg-static';
import {
  ANNO_DIR_NAME,
  PROJECT_SCHEMA_VERSION,
  SIDECAR_SCHEMA_VERSION,
  type ImageEntry,
  type Project,
  type RecentProject,
  type SidecarFile,
  type VideoExtractParams,
  type VideoExtractProgress,
} from '../src/core/types';
// ディスク形式（snake_case）⇔ 内部型の変換は core/serialize.ts が唯一の境界
// （CLAUDE.md 設計ルール 5）。main もそこを通す。
import { jsonToProject, projectToJson } from '../src/core/serialize';
import {
  ANNO_PROTOCOL,
  IPC,
  type IpcExportSession,
  type IpcOpenProjectResult,
  type IpcSidecarBundle,
} from '../src/shared/ipc';
import {
  atomicCopyFile,
  atomicWriteFile,
  ensureDir,
  isDirectory,
  preserveBeforeOverwrite,
  writeFileWithBackup,
  type PreserveResult,
} from './lib/atomicWrite';
import { withFileLock } from './lib/fileLock';
import {
  INITIAL_PROGRESS_STATE,
  OUTPUT_PATTERN_BASE,
  buildFfmpegArgs,
  feedFfmpegProgress,
  normalizeVideoParams,
} from './lib/ffmpegArgs';
import { compareNatural, isImageFileName } from './lib/naturalSort';
import {
  isPathInside,
  isSafeFileName,
  parseAnnoImageUrl,
  safeDestSegments,
  safeJoin,
} from './lib/pathGuard';
import {
  SymlinkRejectedError,
  isRealPathInside,
  resolveDestPathNoSymlink,
  statRegularFile,
} from './lib/safeFs';
import { EMPTY_SIDECAR_SUMMARY, summarizeSidecar } from './lib/sidecarSummary';

/** electron-vite が dev サーバ起動時に注入する URL。本番ビルドでは undefined */
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL;

/**
 * 本番ビルドのレスポンスヘッダに付与する CSP。
 * !!! electron.vite.config.ts の injectCspPlugin（meta 注入）と同じ内容を保つこと !!!
 */
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: anno:",
  "media-src 'self' data: blob: anno:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

const RECENT_LIMIT = 10;
/** サイドカー一括読込時の同時オープン数（EMFILE 回避） */
const READ_CONCURRENCY = 32;
/**
 * IPC で受け取る JSON の上限（バイト）。
 * 壊れた・悪意ある巨大ペイロードでメインプロセスのメモリを食い潰さないための上限で、
 * 中身のスキーマ検証はレンダラ側 serialize.ts の責務のまま。
 */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

/** JSON 化してサイズ上限を検査する。超過時は日本語エラー */
function serializeJsonPayload(value: unknown, label: string): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_JSON_BYTES) {
    throw new Error(
      `${label}が大きすぎるため保存できません（${Math.round(bytes / 1024 / 1024)}MB / 上限 ${
        MAX_JSON_BYTES / 1024 / 1024
      }MB）。`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// フォルダ許可リスト
//   dialog で選択された、または recent.json に記録済み（=過去に dialog 経由で
//   選択された）ディレクトリのみを受け付ける。エクスポート出力先は
//   「このセッションで dialog:pickDir により選ばれたもの」に限定する。
// ---------------------------------------------------------------------------

type GrantSource = 'dialog' | 'recent';

interface DirGrant {
  /** path.resolve 済みの絶対パス */
  path: string;
  source: GrantSource;
}

const allowedDirs = new Map<string, DirGrant>();
/** dialog:pickVideo で選択された動画ファイルの絶対パス */
const allowedVideos = new Set<string>();

/** 許可リストのキー（Windows は大文字小文字を区別しない） */
function dirKey(resolved: string): string {
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function grantDir(target: string, source: GrantSource): string {
  const resolved = path.resolve(target);
  const key = dirKey(resolved);
  const existing = allowedDirs.get(key);
  // dialog 由来の許可を recent 由来で上書きして降格させない
  if (existing?.source === 'dialog' && source === 'recent') return existing.path;
  allowedDirs.set(key, { path: resolved, source });
  return resolved;
}

/**
 * 許可済みディレクトリなら絶対パスを返す。未許可なら null。
 * recent.json に載っているパスは「実在するディレクトリであること」を確認した上で
 * 遅延許可する（recent からの再オープンは dialog を経由しないため）。
 */
async function resolveAllowedDir(dir: unknown): Promise<string | null> {
  if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0')) return null;
  const resolved = path.resolve(dir);
  const granted = allowedDirs.get(dirKey(resolved));
  if (granted) return granted.path;

  const recent = await readRecentRaw();
  const inRecent = recent.some((entry) => {
    if (typeof entry?.dir !== 'string' || entry.dir.length === 0) return false;
    return dirKey(path.resolve(entry.dir)) === dirKey(resolved);
  });
  if (!inRecent) return null;
  if (!(await isDirectory(resolved))) return null;
  return grantDir(resolved, 'recent');
}

async function requireAllowedDir(dir: unknown): Promise<string> {
  const resolved = await resolveAllowedDir(dir);
  if (!resolved) {
    throw new Error('許可されていないフォルダです。フォルダを選び直してください。');
  }
  return resolved;
}

/** dialog で明示的に選択されたディレクトリのみ許可（エクスポート出力先・動画出力先） */
function requireDialogDir(dir: unknown): string {
  if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0')) {
    throw new Error('出力先フォルダのパスが不正です。');
  }
  const resolved = path.resolve(dir);
  const granted = allowedDirs.get(dirKey(resolved));
  if (!granted || granted.source !== 'dialog') {
    throw new Error('出力先フォルダが選択されていません。フォルダを選び直してください。');
  }
  return granted.path;
}

// ---------------------------------------------------------------------------
// _anno レイアウトのパス
// ---------------------------------------------------------------------------

const annoDirOf = (dir: string): string => path.join(dir, ANNO_DIR_NAME);
const annotationsDirOf = (dir: string): string => path.join(annoDirOf(dir), 'annotations');
const backupsDirOf = (dir: string): string => path.join(annoDirOf(dir), 'backups');
const projectFileOf = (dir: string): string => path.join(annoDirOf(dir), 'project.json');

/** _anno/annotations/<file>.json の絶対パス。file が不正なら例外 */
function sidecarPathOf(dir: string, file: unknown): string {
  if (!isSafeFileName(file)) {
    throw new Error('ファイル名が不正です。');
  }
  const resolved = safeJoin(annotationsDirOf(dir), `${file}.json`);
  if (!resolved) {
    throw new Error('ファイル名が不正です。');
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// 汎用ユーティリティ
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<{ ok: true; value: unknown } | { ok: false; missing: boolean }> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, missing: code === 'ENOENT' || code === 'ENOTDIR' };
  }
  try {
    // BOM 付き JSON への保険
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch {
    return { ok: false, missing: false };
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// recent projects（userData/recent.json）
// ---------------------------------------------------------------------------

function recentFilePath(): string {
  return path.join(app.getPath('userData'), 'recent.json');
}

/** 実在チェックをしない生の recent 一覧（許可判定の材料） */
async function readRecentRaw(): Promise<RecentProject[]> {
  const read = await readJsonFile(recentFilePath());
  if (!read.ok || !Array.isArray(read.value)) return [];
  return read.value.filter(
    (entry): entry is RecentProject =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as RecentProject).dir === 'string' &&
      (entry as RecentProject).dir.length > 0,
  );
}

async function writeRecent(list: RecentProject[]): Promise<void> {
  await ensureDir(path.dirname(recentFilePath()));
  await atomicWriteFile(recentFilePath(), `${JSON.stringify(list, null, 2)}\n`);
}

/** 最近開いたフォルダを先頭に積む（最大 RECENT_LIMIT 件） */
async function touchRecent(dir: string, name: string): Promise<void> {
  const current = await readRecentRaw();
  const key = dirKey(path.resolve(dir));
  const next: RecentProject[] = [
    { dir, name, lastOpenedAt: new Date().toISOString() },
    ...current.filter((entry) => dirKey(path.resolve(entry.dir)) !== key),
  ].slice(0, RECENT_LIMIT);
  try {
    await writeRecent(next);
  } catch (error) {
    console.warn('[GenbaAnno] recent.json の更新に失敗しました', error);
  }
}

// ---------------------------------------------------------------------------
// 画像列挙・サイドカー読込
// ---------------------------------------------------------------------------

interface ListResult {
  images: ImageEntry[];
  corruptSidecars: string[];
}

/** preserveBeforeOverwrite の結果を日本語の警告文にする（null なら退避不要だった） */
function describePreserved(preserved: PreserveResult | null): string | null {
  if (!preserved) return null;
  const name = path.basename(preserved.path);
  const message =
    preserved.reason === 'newer'
      ? `新しいバージョンで作られたファイルだったため、原本を ${name} として保存しました。`
      : `読み込めない壊れたファイルだったため、原本を ${name} として保存しました。`;
  console.warn('[GenbaAnno]', message, preserved.path);
  return message;
}


/**
 * dir 直下の画像を列挙し、各サイドカーの要約（status / annotationCount）を付ける。
 * サブフォルダは走査しない。シンボリックリンクは辿らない（許可フォルダ外への脱出防止）。
 */
async function listImages(dir: string): Promise<ListResult> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error('フォルダが見つかりません。移動または削除された可能性があります。');
    }
    throw error;
  });

  const files = entries
    .filter((entry) => entry.isFile() && isSafeFileName(entry.name) && isImageFileName(entry.name))
    .map((entry) => entry.name)
    .sort(compareNatural);

  const corruptSidecars: string[] = [];
  const images = await mapLimit(files, READ_CONCURRENCY, async (file): Promise<ImageEntry> => {
    const read = await readJsonFile(path.join(annotationsDirOf(dir), `${file}.json`));
    if (!read.ok) {
      if (!read.missing) corruptSidecars.push(file);
      return { file, ...EMPTY_SIDECAR_SUMMARY };
    }
    return { file, ...summarizeSidecar(read.value) };
  });

  corruptSidecars.sort(compareNatural);
  return { images, corruptSidecars };
}

// ---------------------------------------------------------------------------
// エクスポートセッション
// ---------------------------------------------------------------------------

interface ExportSession {
  projectDir: string;
  /** ダイアログで選ばれた出力先 */
  destDir: string;
  /** symlink 解決済みの出力先実体。配下判定はすべてこちらで行う */
  destDirReal: string;
  /** セッションを開いた webContents。他のウィンドウからは使えない */
  senderId: number;
}

const exportSessions = new Map<string, ExportSession>();

function requireExportSession(sessionId: unknown, senderId: number): ExportSession {
  if (typeof sessionId !== 'string') {
    throw new Error('エクスポートセッションが不正です。');
  }
  const found = exportSessions.get(sessionId);
  if (!found) {
    throw new Error('エクスポートセッションが終了しています。もう一度実行してください。');
  }
  if (found.senderId !== senderId) {
    throw new Error('エクスポートセッションが不正です。');
  }
  return found;
}

/** ウィンドウが閉じたらそのウィンドウのエクスポートセッションを破棄する */
function purgeExportSessions(senderId: number): void {
  for (const [id, session_] of exportSessions) {
    if (session_.senderId === senderId) exportSessions.delete(id);
  }
}

/**
 * 出力先の相対パスを検証し、symlink を一切辿らずに親ディレクトリを作って絶対パスを返す。
 *
 * destDir 配下に既存の symlink ディレクトリ（例: <dest>/images → /etc）があると、
 * mkdir -p や writeFile はそれを辿って外部へ書けてしまう。そのため
 * 出力先実体から 1 段ずつ lstat しながら降り、symlink を見つけたら即座に拒否する。
 */
async function resolveExportTarget(
  session_: ExportSession,
  destRelPath: unknown,
): Promise<string> {
  const segments = safeDestSegments(session_.destDirReal, destRelPath);
  if (!segments) {
    throw new Error('出力先のパスが不正です。');
  }
  try {
    return await resolveDestPathNoSymlink(session_.destDirReal, segments);
  } catch (error) {
    if (error instanceof SymlinkRejectedError) {
      // 出力先の外へ書かせようとする経路。診断できるよう記録する
      console.warn('[GenbaAnno] エクスポート出力先を拒否しました:', destRelPath, error.message);
    }
    throw error;
  }
}

/** destDir が出力先として妥当か（プロジェクト配下・_anno 内を拒否） */
function assertUsableDestDir(projectDir: string, destDir: string): void {
  if (dirKey(destDir) === dirKey(projectDir)) {
    throw new Error('出力先に画像フォルダ自身は指定できません。別のフォルダを選んでください。');
  }
  if (isPathInside(projectDir, destDir)) {
    throw new Error('出力先に画像フォルダの中は指定できません。別のフォルダを選んでください。');
  }
  const segments = path.resolve(destDir).split(/[\\/]/);
  if (segments.includes(ANNO_DIR_NAME)) {
    throw new Error(`出力先に ${ANNO_DIR_NAME} フォルダの中は指定できません。`);
  }
}

// ---------------------------------------------------------------------------
// dirty 状態（クローズ前確認）
// ---------------------------------------------------------------------------

const dirtyByWebContents = new Map<number, boolean>();
const forceCloseWindows = new Set<number>();

// ---------------------------------------------------------------------------
// 動画フレーム抽出（ffmpeg-static）
// ---------------------------------------------------------------------------

/**
 * ffmpeg-static の型宣言は `export default`、実体は CJS の `module.exports = string`。
 * バンドラの interop 差で `{ default: string }` になる場合があるため両方受ける。
 */
function resolveFfmpegPath(): string | null {
  const raw = ffmpegStaticImport as unknown;
  const value =
    typeof raw === 'string'
      ? raw
      : typeof (raw as { default?: unknown } | null)?.default === 'string'
        ? ((raw as { default: string }).default)
        : null;
  if (!value) return null;
  // asar 内のバイナリは実行できない。electron-builder の asarUnpack で展開済み
  return value.replace('app.asar', 'app.asar.unpacked');
}

let activeExtract: ChildProcess | null = null;

async function runVideoExtract(
  sender: WebContents,
  params: VideoExtractParams,
): Promise<void> {
  if (activeExtract) {
    throw new Error('フレーム抽出がすでに実行中です。完了までお待ちください。');
  }

  const destDir = requireDialogDir(params?.destDir);
  const videoPath = path.resolve(String(params?.videoPath ?? ''));
  if (!allowedVideos.has(dirKey(videoPath))) {
    throw new Error('動画ファイルが選択されていません。動画を選び直してください。');
  }

  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('同梱の ffmpeg が見つかりませんでした。アプリを再インストールしてください。');
  }

  // 先に検証・クランプしてから出力パターンを組み立てる
  // （format を検証前にパスへ埋めると path.join でフォルダ外へ出られてしまう）
  const normalized = normalizeVideoParams(params);
  const outputPattern = path.join(destDir, `${OUTPUT_PATTERN_BASE}.${normalized.format}`);
  const args = buildFfmpegArgs({ ...params, videoPath }, outputPattern);
  await ensureDir(destDir);

  const send = (progress: VideoExtractProgress): void => {
    if (!sender.isDestroyed()) sender.send(IPC.videoExtractProgress, progress);
  };

  await new Promise<void>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      send({ framesWritten: 0, done: true, error: String((error as Error)?.message ?? error) });
      resolve();
      return;
    }
    activeExtract = child;

    let progressState = INITIAL_PROGRESS_STATE;
    let stderrTail = '';
    let lastSentFrames = -1;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      progressState = feedFfmpegProgress(progressState, chunk);
      if (progressState.framesWritten !== lastSentFrames) {
        lastSentFrames = progressState.framesWritten;
        send({ framesWritten: progressState.framesWritten, done: false });
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });

    // error と close の両方が発火することがあるため 1 回だけ通知する
    let finished = false;
    const finish = (error?: string): void => {
      if (finished) return;
      finished = true;
      activeExtract = null;
      send(
        error
          ? { framesWritten: progressState.framesWritten, done: true, error }
          : { framesWritten: progressState.framesWritten, done: true },
      );
      resolve();
    };

    child.on('error', (error) => {
      finish(`ffmpeg の起動に失敗しました: ${error.message}`);
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish();
      } else {
        const detail = stderrTail.trim().split(/\r?\n/).slice(-3).join(' / ');
        finish(
          `フレーム抽出に失敗しました（終了コード ${code ?? signal ?? '不明'}）${
            detail ? `: ${detail}` : ''
          }`,
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// anno:// プロトコル（画像配信）
// ---------------------------------------------------------------------------

// standard/secure: <img> や fetch から通常のオリジンとして扱わせる
// corsEnabled + ハンドラの Access-Control-Allow-Origin: これが無いと
//   renderer 側で <img crossorigin="anonymous"> が使えず canvas が taint し、
//   getImageData（マグネットラインのサンプリング）が例外になる
//   （docs/DESIGN.md §6 罠 #3）。M4 は img.crossOrigin = 'anonymous' を設定すること。
protocol.registerSchemesAsPrivileged([
  {
    scheme: ANNO_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function registerAnnoProtocol(): void {
  protocol.handle(ANNO_PROTOCOL, async (request) => {
    const ref = parseAnnoImageUrl(request.url);
    if (!ref) return new Response('Bad Request', { status: 400 });
    if (!isImageFileName(ref.file)) return new Response('Forbidden', { status: 403 });

    const dir = await resolveAllowedDir(ref.dir);
    if (!dir) return new Response('Forbidden', { status: 403 });

    const absolute = safeJoin(dir, ref.file);
    if (!absolute) return new Response('Forbidden', { status: 403 });

    // 許可フォルダ直下に置かれた symlink 画像でフォルダ外を読ませない。
    // safeJoin は字句検証しかしないので、実体が通常ファイルであることを lstat で確認する。
    if ((await statRegularFile(absolute)) === null) {
      return new Response('Forbidden', { status: 403 });
    }
    // 念のため実体パスも許可フォルダの実体配下であることを確認する
    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
    if (!(await isRealPathInside(realDir, absolute))) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const response = await net.fetch(pathToFileURL(absolute).toString());
      if (!response.ok) return new Response('Not Found', { status: 404 });
      const mime = MIME_BY_EXT[path.extname(ref.file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(response.body, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-cache',
          // crossOrigin='anonymous' で読み込ませて canvas の taint を避けるため
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// IPC ハンドラ
// ---------------------------------------------------------------------------

/** 親ウィンドウがあればシート表示、無ければ独立ダイアログで開く */
async function showOpenDialog(
  event: IpcMainInvokeEvent,
  options: OpenDialogOptions,
): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

function registerIpcHandlers(): void {
  // --- ダイアログ ---------------------------------------------------------
  ipcMain.handle(IPC.dialogPickImageDir, async (event): Promise<string | null> => {
    const picked = await showOpenDialog(event, {
      title: '画像フォルダを選択',
      properties: ['openDirectory'],
    });
    return picked === null ? null : grantDir(picked, 'dialog');
  });

  ipcMain.handle(IPC.dialogPickDir, async (event, title: unknown): Promise<string | null> => {
    const picked = await showOpenDialog(event, {
      title: typeof title === 'string' && title.length > 0 ? title : 'フォルダを選択',
      properties: ['openDirectory', 'createDirectory'],
    });
    return picked === null ? null : grantDir(picked, 'dialog');
  });

  ipcMain.handle(IPC.dialogPickVideo, async (event): Promise<string | null> => {
    const picked = await showOpenDialog(event, {
      title: '動画ファイルを選択',
      properties: ['openFile'],
      filters: [
        {
          name: '動画',
          extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mts', 'm2ts', 'wmv'],
        },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    });
    if (picked === null) return null;
    const resolved = path.resolve(picked);
    allowedVideos.add(dirKey(resolved));
    return resolved;
  });

  // --- プロジェクト -------------------------------------------------------
  ipcMain.handle(IPC.projectOpen, async (_event, dir: unknown): Promise<IpcOpenProjectResult> => {
    const resolved = await requireAllowedDir(dir);
    if (!(await isDirectory(resolved))) {
      throw new Error('フォルダが見つかりません。移動または削除された可能性があります。');
    }

    // project.json が無い / JSON として壊れている場合は null を返し、
    // レンダラにデフォルト生成 → 保存させる。壊れている場合はこの時点で原本を退避する
    // （レンダラの保存を待たずに残す。契約 src/shared/ipc.ts のとおり warnings で通知）。
    const projectFile = projectFileOf(resolved);
    const warnings: string[] = [];
    const read = await readJsonFile(projectFile);
    let project: Project | null = null;

    if (read.ok) {
      const parsed = jsonToProject(read.value, path.basename(resolved));
      project = parsed.project;
      // クラス id の振り直し等は学習 ID に影響するので必ずユーザーへ見せる
      warnings.push(...parsed.warnings);
      if (parsed.warnings.length > 0) {
        console.warn('[GenbaAnno] project.json の警告:', parsed.warnings.join(' / '));
      }
    } else if (!read.missing) {
      warnings.push('project.json を読み込めませんでした。設定を作り直します。');
      console.warn('[GenbaAnno] project.json を解析できませんでした:', projectFile);
    }

    // 壊れている / 新しいスキーマ版なら、上書きされる前に原本を残す
    const preserved = describePreserved(
      await preserveBeforeOverwrite(projectFile, annoDirOf(resolved), PROJECT_SCHEMA_VERSION),
    );
    if (preserved) warnings.push(preserved);

    const { images, corruptSidecars } = await listImages(resolved);
    if (corruptSidecars.length > 0) {
      warnings.push(
        `${corruptSidecars.length}件のアノテーションファイルを読み込めませんでした（保存時に原本を退避します）。`,
      );
    }
    await touchRecent(resolved, project?.name ?? path.basename(resolved));

    return { dir: resolved, project, images, corruptSidecars, warnings };
  });

  ipcMain.handle(IPC.projectRelist, async (_event, dir: unknown): Promise<ImageEntry[]> => {
    const resolved = await requireAllowedDir(dir);
    const { images } = await listImages(resolved);
    return images;
  });

  ipcMain.handle(
    IPC.projectSaveFile,
    async (_event, dir: unknown, project: unknown): Promise<void> => {
      const resolved = await requireAllowedDir(dir);
      if (typeof project !== 'object' || project === null) {
        throw new Error('プロジェクト設定が不正です。');
      }
      // projectToJson は updated_at をそのまま書く純変換なので、書き込む側で時刻を進める
      const text = serializeJsonPayload(
        projectToJson({ ...(project as Project), updatedAt: new Date().toISOString() }),
        'プロジェクト設定',
      );
      const target = projectFileOf(resolved);
      // 自動保存と手動保存が重なっても「退避→バックアップ→tmp→rename」が交錯しないよう直列化
      await withFileLock(dirKey(target), async () => {
        await ensureDir(annoDirOf(resolved));
        // 上書きすると復元できない原本（壊れている / 新しいスキーマ版）を退避しておく。
        // クラス定義は学習 ID そのものなので 1 世代の backups だけでは守れない
        // （原本 → 次の保存で backups が押し出されて完全消失する経路がある）
        describePreserved(
          await preserveBeforeOverwrite(target, annoDirOf(resolved), PROJECT_SCHEMA_VERSION),
        );
        await writeFileWithBackup(target, text, backupsDirOf(resolved));
      });
    },
  );

  ipcMain.handle(IPC.projectListRecent, async (): Promise<RecentProject[]> => {
    const raw = await readRecentRaw();
    const checked = await mapLimit(raw, 8, async (entry) =>
      (await isDirectory(entry.dir)) ? entry : null,
    );
    return checked.filter((entry): entry is RecentProject => entry !== null);
  });

  // --- サイドカー ---------------------------------------------------------
  ipcMain.handle(
    IPC.sidecarLoad,
    async (_event, dir: unknown, file: unknown): Promise<SidecarFile | null> => {
      const resolved = await requireAllowedDir(dir);
      const target = sidecarPathOf(resolved, file);
      const read = await readJsonFile(target);
      if (!read.ok) {
        if (!read.missing) {
          // 壊れたサイドカーは「無し」として扱う（docs/DESIGN.md §2: 全損させない）。
          // 直後の保存で _anno/backups/ に退避されるため内容は復旧可能。
          console.warn('[GenbaAnno] サイドカーを解析できませんでした:', target);
        }
        return null;
      }
      return read.value as SidecarFile;
    },
  );

  ipcMain.handle(
    IPC.sidecarSave,
    async (_event, dir: unknown, file: unknown, data: unknown): Promise<void> => {
      const resolved = await requireAllowedDir(dir);
      const target = sidecarPathOf(resolved, file);
      if (typeof data !== 'object' || data === null) {
        throw new Error('保存データが不正です。');
      }
      const text = serializeJsonPayload(data, 'アノテーションデータ');
      await withFileLock(dirKey(target), async () => {
        await ensureDir(annotationsDirOf(resolved));
        // 壊れた / 新しいスキーマ版のサイドカーを上書きする場合も原本を退避する
        // （アノテーションの全損防止。1 世代の backups は次の保存で押し出される）
        describePreserved(
          await preserveBeforeOverwrite(target, backupsDirOf(resolved), SIDECAR_SCHEMA_VERSION),
        );
        await writeFileWithBackup(target, text, backupsDirOf(resolved));
      });
    },
  );

  ipcMain.handle(IPC.sidecarLoadAll, async (_event, dir: unknown): Promise<IpcSidecarBundle> => {
    const resolved = await requireAllowedDir(dir);
    const annotationsDir = annotationsDirOf(resolved);

    let names: string[];
    try {
      const entries = await fs.readdir(annotationsDir, { withFileTypes: true });
      names = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            isSafeFileName(entry.name) &&
            entry.name.toLowerCase().endsWith('.json') &&
            entry.name.length > '.json'.length,
        )
        .map((entry) => entry.name)
        .sort(compareNatural);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { sidecars: [], corrupt: [] };
      throw error;
    }

    const sidecars: { file: string; data: SidecarFile }[] = [];
    const corrupt: string[] = [];
    await mapLimit(names, READ_CONCURRENCY, async (name) => {
      const imageFile = name.slice(0, -'.json'.length);
      const read = await readJsonFile(path.join(annotationsDir, name));
      if (!read.ok) {
        if (!read.missing) corrupt.push(imageFile);
        return;
      }
      sidecars.push({ file: imageFile, data: read.value as SidecarFile });
    });

    sidecars.sort((a, b) => compareNatural(a.file, b.file));
    corrupt.sort(compareNatural);
    return { sidecars, corrupt };
  });

  // --- エクスポート -------------------------------------------------------
  ipcMain.handle(
    IPC.exportBegin,
    async (event, projectDir: unknown, destDir: unknown): Promise<IpcExportSession> => {
      const resolvedProject = await requireAllowedDir(projectDir);
      const resolvedDest = requireDialogDir(destDir);
      assertUsableDestDir(resolvedProject, resolvedDest);
      if (!(await isDirectory(resolvedDest))) {
        throw new Error('出力先フォルダが見つかりません。');
      }
      // 以降の配下判定はすべて symlink 解決後の実体パスで行う
      const destDirReal = await fs.realpath(resolvedDest);
      // 実体で見てもプロジェクト配下・_anno 内でないことを確認する
      const projectDirReal = await fs.realpath(resolvedProject);
      assertUsableDestDir(projectDirReal, destDirReal);

      const sessionId = randomUUID();
      exportSessions.set(sessionId, {
        projectDir: resolvedProject,
        destDir: resolvedDest,
        destDirReal,
        senderId: event.sender.id,
      });
      return { sessionId, destDir: resolvedDest };
    },
  );

  ipcMain.handle(
    IPC.exportCopyImage,
    async (event, sessionId: unknown, srcFile: unknown, destRelPath: unknown): Promise<void> => {
      const exportSession = requireExportSession(sessionId, event.sender.id);
      const src = safeJoin(exportSession.projectDir, srcFile as string);
      if (!src) throw new Error('コピー元のファイル名が不正です。');
      // コピー元はプロジェクト直下の「画像ファイル実体」に限る
      // （symlink 経由で許可フォルダ外のファイルを出力先へ持ち出せないようにする）
      if (!isImageFileName(srcFile as string)) {
        throw new Error('コピー元が画像ファイルではありません。');
      }
      if ((await statRegularFile(src)) === null) {
        throw new Error('コピー元の画像が見つかりません。');
      }
      const dest = await resolveExportTarget(exportSession, destRelPath);
      await atomicCopyFile(src, dest);
    },
  );

  ipcMain.handle(
    IPC.exportWriteFile,
    async (event, sessionId: unknown, destRelPath: unknown, data: unknown): Promise<void> => {
      const exportSession = requireExportSession(sessionId, event.sender.id);
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
        throw new Error('書き込むデータの形式が不正です。');
      }
      const dest = await resolveExportTarget(exportSession, destRelPath);
      // 中断時に途中まで書かれたファイルを残さない
      await atomicWriteFile(dest, data);
    },
  );

  ipcMain.handle(IPC.exportEnd, async (event, sessionId: unknown): Promise<void> => {
    if (typeof sessionId !== 'string') return;
    const found = exportSessions.get(sessionId);
    if (found && found.senderId === event.sender.id) exportSessions.delete(sessionId);
  });

  // --- 動画フレーム抽出 ---------------------------------------------------
  ipcMain.handle(IPC.videoExtract, async (event, params: unknown): Promise<void> => {
    if (typeof params !== 'object' || params === null) {
      throw new Error('抽出パラメータが不正です。');
    }
    await runVideoExtract(event.sender, params as VideoExtractParams);
  });

  // --- その他 -------------------------------------------------------------
  ipcMain.handle(IPC.shellReveal, async (_event, absPath: unknown): Promise<void> => {
    if (typeof absPath !== 'string' || absPath.length === 0 || absPath.includes('\0')) {
      throw new Error('パスが不正です。');
    }
    const resolved = path.resolve(absPath);
    const allowed = [...allowedDirs.values()].some(
      (grant) => isPathInside(grant.path, resolved, { allowEqual: true }),
    );
    if (!allowed) {
      throw new Error('許可されていないパスです。');
    }
    shell.showItemInFolder(resolved);
  });

  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  ipcMain.on(IPC.appDirtyState, (event, dirty: unknown) => {
    dirtyByWebContents.set(event.sender.id, dirty === true);
  });
}

// ---------------------------------------------------------------------------
// ウィンドウ
// ---------------------------------------------------------------------------

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
      preload: path.join(__dirname, '../preload/preload.js'),
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

  const webContentsId = win.webContents.id;

  // 未保存の変更がある状態で閉じようとしたら確認する（docs/DESIGN.md §4）
  win.on('close', (event) => {
    const id = webContentsId;
    if (forceCloseWindows.has(id)) return;
    if (dirtyByWebContents.get(id) !== true) return;

    event.preventDefault();
    // close イベント内での非同期ダイアログはウィンドウが先に閉じるため同期版を使う
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['保存せず終了', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '未保存の変更があります',
      message: '保存していない変更があります。',
      detail: '終了すると、保存していない編集内容は失われます。',
    });
    if (choice === 0) {
      forceCloseWindows.add(id);
      dirtyByWebContents.delete(id);
      win.destroy();
    }
  });

  win.on('closed', () => {
    dirtyByWebContents.delete(webContentsId);
    forceCloseWindows.delete(webContentsId);
    // 閉じたウィンドウのエクスポートセッションは破棄する（出力先の許可を残さない）
    purgeExportSessions(webContentsId);
  });

  // リロード等で webContents が作り直される場合もセッションを引き継がせない
  win.webContents.on('destroyed', () => {
    purgeExportSessions(webContentsId);
  });

  if (RENDERER_DEV_URL) {
    void win.loadURL(RENDERER_DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function applySessionHardening(): void {
  const defaultSession = session.defaultSession;

  // 本番ビルドでは meta だけでなくレスポンスヘッダにも CSP を付ける
  if (!RENDERER_DEV_URL) {
    defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP_HEADER],
        },
      });
    });
  }

  // カメラ・位置情報など、このアプリが使わない権限はすべて拒否する
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);
}

void app.whenReady().then(() => {
  applySessionHardening();
  registerAnnoProtocol();
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

app.on('before-quit', () => {
  if (activeExtract) {
    activeExtract.kill();
    activeExtract = null;
  }
});
