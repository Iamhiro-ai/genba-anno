/// <reference types="node" />
// =============================================================================
// 原子的書込 + 直前世代バックアップ（docs/DESIGN.md §6 罠 #12）
//
//   1. 既存ファイルがあれば _anno/backups/<同名> へコピー（1 世代・lazy 作成）
//   2. 同一ディレクトリに `.tmp-<random>` を書き、fsync してから rename で置換
//
// 同一ディレクトリに tmp を作るのは、rename が同一ファイルシステム内でのみ
// 原子的だから（OS の tmp へ書いて move すると「コピー+削除」に化ける）。
// =============================================================================

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

/** ディレクトリを mkdir -p */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 存在するか（種別は問わない） */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** ディレクトリとして存在するか（シンボリックリンクは辿る） */
export async function isDirectory(target: string): Promise<boolean> {
  try {
    const st = await fs.stat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * tmp 書込 → fsync → rename でファイルを原子的に置換する。
 * 親ディレクトリは mkdir -p される。失敗時は tmp を掃除して再 throw。
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpPath = path.join(dir, `.tmp-${randomBytes(8).toString('hex')}`);

  let handle: FileHandle | undefined;
  try {
    // 'wx' = 既存なら失敗（tmp 名の衝突を検出する）
    handle = await fs.open(tmpPath, 'wx');
    await handle.writeFile(data);
    try {
      await handle.sync();
    } catch {
      // 一部の FS（ネットワークドライブ等）は fsync 非対応。書込自体は成功しているので続行
    }
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * tmp へコピー → rename でファイルを原子的に置換する。
 * エクスポート中断時に「途中まで書かれた画像」が残らないようにするため。
 */
export async function atomicCopyFile(srcPath: string, destPath: string): Promise<void> {
  const dir = path.dirname(destPath);
  await ensureDir(dir);
  const tmpPath = path.join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  try {
    await fs.copyFile(srcPath, tmpPath);
    await fs.rename(tmpPath, destPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 既存ファイルを backupDir へ 1 世代退避する。
 * 対象が無ければ何もしない（backupDir も作らない = lazy 作成）。
 * @returns バックアップを取ったら true
 */
export async function backupExisting(filePath: string, backupDir: string): Promise<boolean> {
  if (!(await pathExists(filePath))) return false;
  await ensureDir(backupDir);
  await fs.copyFile(filePath, path.join(backupDir, path.basename(filePath)));
  return true;
}

/** 上書き前に原本を残すべき理由 */
export type PreserveReason =
  /** JSON として壊れている（parse 不能） */
  | 'corrupt'
  /** schema_version がこのアプリより新しい（上書きすると未知フィールドが消える） */
  | 'newer';

export interface PreserveResult {
  path: string;
  reason: PreserveReason;
}

/**
 * 上書きすると復元できない情報が失われる既存ファイルを、
 * 「後続の保存で押し出されない名前」で destDir へ退避する。
 *
 * backups/<同名> は 1 世代しか持たないため、
 *   保存#1 → backups に原本 / 保存#2 → backups が新しい内容で上書き → 原本消失
 * という経路が存在する。project.json のクラス定義は学習 ID そのもの
 * （docs/DESIGN.md §2）なので、これだけは必ず残す。
 *
 * 退避する条件:
 *   - JSON として parse できない                     → '<名前>.corrupt-<ISO8601>'
 *   - parse できるが schema_version が現行より大きい → '<名前>.newer-<ISO8601>'
 *     （将来版が書いたファイルを旧版で上書きすると未知フィールドが黙って消えるため）
 *
 * 同じ内容の退避ファイルが既にある場合は作らない（プロジェクトを開き直すたびに
 * 増殖させない）。退避に失敗しても保存自体は止めない
 * （保存できないほうが実害が大きいため呼び出し側で握りつぶす想定）。
 *
 * @param currentSchemaVersion このアプリが書ける最新のスキーマ版
 * @returns 退避したら {path, reason}。退避不要・失敗時は null
 */
export async function preserveBeforeOverwrite(
  filePath: string,
  destDir: string,
  currentSchemaVersion: number,
): Promise<PreserveResult | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return null; // 存在しない or 読めない
  }

  let reason: PreserveReason;
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { schema_version?: unknown }).schema_version
        : undefined;
    if (typeof version === 'number' && version > currentSchemaVersion) {
      reason = 'newer';
    } else {
      // 正常に読める現行版 → 通常の 1 世代バックアップに任せる
      return null;
    }
  } catch {
    reason = 'corrupt';
  }

  const base = `${path.basename(filePath)}.${reason}-`;
  try {
    // 同内容の退避が既にあれば作り直さない
    const existing = await fs.readdir(destDir).catch(() => [] as string[]);
    for (const name of existing) {
      if (!name.startsWith(base)) continue;
      const previous = await fs.readFile(path.join(destDir, name), 'utf8').catch(() => null);
      if (previous === text) return null;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(destDir, `${base}${stamp}`);
    await ensureDir(destDir);
    await fs.copyFile(filePath, dest);
    return { path: dest, reason };
  } catch {
    return null;
  }
}

/** 直前世代を backupDir へ退避してから原子的に書き込む */
export async function writeFileWithBackup(
  filePath: string,
  data: string | Uint8Array,
  backupDir: string,
): Promise<void> {
  await backupExisting(filePath, backupDir);
  await atomicWriteFile(filePath, data);
}

/** JSON を 2 スペースインデントで原子的に書き込む（末尾改行あり） */
export async function writeJsonWithBackup(
  filePath: string,
  value: unknown,
  backupDir: string,
): Promise<void> {
  await writeFileWithBackup(filePath, `${JSON.stringify(value, null, 2)}\n`, backupDir);
}
