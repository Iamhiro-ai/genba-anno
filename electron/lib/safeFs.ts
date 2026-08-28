/// <reference types="node" />
// =============================================================================
// シンボリックリンクを辿らないファイルシステム操作（fs 依存・electron 非依存）
//
// pathGuard.ts の検証は「字句的」なので、許可フォルダの中に置かれた symlink は
// 素通りする:
//   - 画像フォルダ直下の IMG.jpg が /etc/passwd への symlink → anno:// で読めてしまう
//   - エクスポート出力先の images/ が外部ディレクトリへの symlink → 外へ書けてしまう
// そのため実際に触る直前に lstat / realpath で実体を確認する。
// =============================================================================

import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

/** symlink を辿らずに「通常ファイル」であることを確認する。違えば null */
export async function statRegularFile(target: string): Promise<Stats | null> {
  try {
    const st = await fs.lstat(target);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** target が symlink（実体は問わない）かどうか */
export async function isSymbolicLink(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * target の実体（symlink 解決後）が baseRealDir の実体配下にあるか。
 * baseRealDir 自身は真とする。解決できない場合は false（安全側）。
 */
export async function isRealPathInside(baseRealDir: string, target: string): Promise<boolean> {
  try {
    const base = await fs.realpath(baseRealDir);
    const real = await fs.realpath(target);
    if (real === base) return true;
    const rel = path.relative(base, real);
    if (rel === '' || path.isAbsolute(rel)) return false;
    return rel !== '..' && !rel.startsWith(`..${path.sep}`);
  } catch {
    return false;
  }
}

/** 出力先が symlink を含んでいたときのエラー（呼び出し側の判別用） */
export class SymlinkRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SymlinkRejectedError';
  }
}

/**
 * 検証済みセグメント列を baseRealDir から 1 段ずつ辿り、途中のディレクトリを作りながら
 * 最終的な書き込み先の絶対パスを返す。
 *
 * mkdir -p や writeFile は既存の symlink を黙って辿るため、
 *   <dest>/images → /etc という symlink があると /etc/... へ書けてしまう。
 * ここでは recursive を使わず 1 段ずつ lstat し、symlink を見つけた時点で失敗させる。
 * 「存在しないので作る」場合も 1 段ずつなので、拒否前に外部へディレクトリを作ってしまうこともない。
 *
 * @param segments pathGuard.safeDestSegments で検証済みのセグメント列
 */
export async function resolveDestPathNoSymlink(
  baseRealDir: string,
  segments: readonly string[],
): Promise<string> {
  if (segments.length === 0) {
    throw new Error('出力先のパスが不正です。');
  }
  const dirSegments = segments.slice(0, -1);
  const leaf = segments[segments.length - 1];

  let current = baseRealDir;
  for (const segment of dirSegments) {
    current = path.join(current, segment);
    let st: Stats | null;
    try {
      st = await fs.lstat(current);
    } catch {
      st = null;
    }
    if (st === null) {
      await fs.mkdir(current); // recursive:false = 途中の symlink を辿らせない
    } else if (st.isSymbolicLink()) {
      throw new SymlinkRejectedError(
        '出力先にシンボリックリンクが含まれているため書き込めません。',
      );
    } else if (!st.isDirectory()) {
      throw new SymlinkRejectedError('出力先のパスがフォルダではありません。');
    }
  }

  const target = path.join(current, leaf);
  // 既存の出力先が symlink なら上書きしない（リンク先の外部ファイルを壊さない）
  if (await isSymbolicLink(target)) {
    throw new SymlinkRejectedError('出力先にシンボリックリンクが含まれているため書き込めません。');
  }
  // 最終確認: 親の実体が出力先の実体配下であること
  if (!(await isRealPathInside(baseRealDir, current))) {
    throw new SymlinkRejectedError('出力先フォルダの外へは書き込めません。');
  }
  return target;
}
