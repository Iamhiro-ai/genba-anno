/// <reference types="node" />
// =============================================================================
// パス検証（純ロジック・fs / electron 非依存 = 単体テスト可能）
//
// 脅威モデル: レンダラが侵害された場合でも、
//   - 許可リスト外のディレクトリを読み書きできない
//   - 許可ディレクトリの「直下」以外へ出られない（'..' / 絶対パス / 区切り混入）
//   - エクスポート出力先の外へ書けない
// を成立させる。実際の許可リスト保持は electron/main.ts 側の責務。
//
// docs/DESIGN.md §6 罠 #13（Windows のパス・日本語ファイル名）対応:
//   区切りは常に `/` と `\` の両方を不正扱いし、結合は必ず path.join / path.resolve で行う。
// =============================================================================

import path from 'node:path';

/** ファイル名の最大長（多くの FS のベース名上限） */
export const MAX_FILE_NAME_LENGTH = 255;
/** destRelPath の最大長 */
export const MAX_REL_PATH_LENGTH = 1024;

/**
 * Windows の予約デバイス名。拡張子を付けても（CON.jpg）デバイスを指すため、
 * ベース名部分が一致したら拒否する。大文字小文字は区別しない。
 * これらを開くとファイルではなくデバイスに書き込まれ、保存が無言で失われる。
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/** Windows 予約デバイス名か（'CON' / 'con.jpg' / 'LPT1.json' などを真とする） */
export function isWindowsReservedName(name: string): boolean {
  const dot = name.indexOf('.');
  const stem = (dot === -1 ? name : name.slice(0, dot)).toUpperCase();
  return WINDOWS_RESERVED_NAMES.has(stem);
}

/**
 * 「ディレクトリ直下のベース名」として安全か。
 *
 * 拒否するもの:
 *   - 空文字 / 255 バイト超 / 文字列以外
 *   - '.' / '..'
 *   - パス区切り '/' '\' を含む
 *   - NUL および制御文字（0x00–0x1F, 0x7F）
 *   - ':' を含む（Windows のドライブ相対パス 'C:foo' と NTFS 代替データストリーム 'a:b' 対策）
 *   - 末尾が '.' または半角空白（Windows が暗黙に切り詰めて別ファイルを指す）
 *   - Windows の予約デバイス名（CON / NUL / COM1 など。拡張子付きも含む）
 */
export function isSafeFileName(file: unknown): file is string {
  if (typeof file !== 'string') return false;
  if (file.length === 0 || file.length > MAX_FILE_NAME_LENGTH) return false;
  if (file === '.' || file === '..') return false;
  if (file.includes('/') || file.includes('\\')) return false;
  if (file.includes(':')) return false;
  for (let i = 0; i < file.length; i += 1) {
    const code = file.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const last = file[file.length - 1];
  if (last === '.' || last === ' ') return false;
  if (isWindowsReservedName(file)) return false;
  return true;
}

/** ディレクトリパスとして最低限の体裁か（存在確認はしない） */
export function isPlausibleDirPath(dir: unknown): dir is string {
  return typeof dir === 'string' && dir.length > 0 && !dir.includes('\0');
}

/**
 * dir 直下の file への絶対パスを返す。安全でなければ null。
 * 正規化後に「親が dir と完全一致」「ベース名が入力と完全一致」まで検査する
 * （Windows の末尾ドット切り詰め等で別ファイルを指すのを防ぐ）。
 */
export function safeJoin(dir: string, file: string): string | null {
  if (!isPlausibleDirPath(dir)) return null;
  if (!isSafeFileName(file)) return null;
  const base = path.resolve(dir);
  const joined = path.resolve(base, file);
  if (path.dirname(joined) !== base) return null;
  if (path.basename(joined) !== file) return null;
  return joined;
}

/**
 * child が parent の配下か（正規化して比較）。
 * allowEqual=true のときのみ parent 自身を真とする。
 */
export function isPathInside(
  parent: string,
  child: string,
  opts?: { allowEqual?: boolean },
): boolean {
  if (!isPlausibleDirPath(parent) || !isPlausibleDirPath(child)) return false;
  const p = path.resolve(parent);
  const c = path.resolve(child);
  const rel = path.relative(p, c);
  if (rel === '') return opts?.allowEqual === true;
  if (path.isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  return true;
}

/** 絶対パス表記か（POSIX / Windows のドライブ・UNC を両方判定する） */
export function looksAbsolute(p: string): boolean {
  return (
    p.startsWith('/') ||
    p.startsWith('\\') ||
    /^[A-Za-z]:/.test(p) ||
    path.isAbsolute(p)
  );
}

/**
 * エクスポート出力先の相対パスを検証して絶対パスに解決する。安全でなければ null。
 *
 * 拒否するもの: 絶対パス / '..' / '.' / 空セグメント（'a//b'・末尾 '/'）/ NUL /
 * 制御文字 / ':' を含むセグメント / 正規化後に destDir の外へ出るもの。
 */
export function safeDestPath(destDir: string, destRelPath: unknown): string | null {
  const segments = safeDestSegments(destDir, destRelPath);
  if (!segments) return null;
  const base = path.resolve(destDir);
  const joined = path.resolve(base, ...segments);
  if (!isPathInside(base, joined)) return null;
  return joined;
}

/**
 * safeDestPath と同じ検証を行い、検証済みのパスセグメント列を返す。
 * 呼び出し側が 1 段ずつ mkdir / lstat しながら降りる（symlink 追従を防ぐ）ために使う。
 */
export function safeDestSegments(destDir: string, destRelPath: unknown): string[] | null {
  if (!isPlausibleDirPath(destDir)) return null;
  if (typeof destRelPath !== 'string') return null;
  if (destRelPath.length === 0 || destRelPath.length > MAX_REL_PATH_LENGTH) return null;
  if (looksAbsolute(destRelPath)) return null;

  const segments = destRelPath.split(/[\\/]/);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (!isSafeFileName(segment)) return null;
  }
  return segments;
}

/** anno://image/<dir>/<file> の解析結果 */
export interface AnnoImageRef {
  dir: string;
  file: string;
}

/** anno:// の画像 URL を組み立てる（preload の imageUrl と同一形式。テスト用） */
export function buildAnnoImageUrl(dir: string, file: string): string {
  return `anno://image/${encodeURIComponent(dir)}/${encodeURIComponent(file)}`;
}

/**
 * anno://image/<encodeURIComponent(dir)>/<encodeURIComponent(file)> を解析する。
 * 形式不正・デコード不能・ファイル名が安全でない場合は null（呼び出し側は 403/400 を返す）。
 * dir が許可リストにあるかの判定は行わない（main.ts の責務）。
 */
export function parseAnnoImageUrl(rawUrl: string): AnnoImageRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'anno:') return null;
  if (url.hostname !== 'image') return null;
  if (url.search !== '' || url.hash !== '') return null;

  const parts = url.pathname.split('/');
  // pathname は必ず '/' 始まり = ['', dir, file]
  if (parts.length !== 3) return null;
  if (parts[1] === '' || parts[2] === '') return null;

  let dir: string;
  let file: string;
  try {
    dir = decodeURIComponent(parts[1]);
    file = decodeURIComponent(parts[2]);
  } catch {
    return null;
  }
  if (!isPlausibleDirPath(dir)) return null;
  if (!isSafeFileName(file)) return null;
  return { dir, file };
}
