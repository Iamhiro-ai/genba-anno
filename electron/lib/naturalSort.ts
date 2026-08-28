// =============================================================================
// 画像ファイルの列挙・自然順ソート（純ロジック・fs 非依存）
//
// IMG_2.jpg → IMG_10.jpg の順に並ぶこと（辞書順だと 10 が先に来る）。
// 日本語ファイル名も自然に並ぶよう Intl.Collator('ja', { numeric: true }) を使う。
// =============================================================================

import { IMAGE_EXTENSIONS } from '../../src/core/types';

const collator = new Intl.Collator('ja', {
  numeric: true,
  sensitivity: 'variant',
});

/**
 * 自然順比較。Collator が 0 を返した（照合上同値だが文字列は異なる）場合は
 * コードポイント順でタイブレークし、ソート結果を安定・決定的にする。
 */
export function compareNatural(a: string, b: string): number {
  const c = collator.compare(a, b);
  if (c !== 0) return c;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 対応画像ファイル名か。
 *   - 大文字小文字は無視（.JPG も対象）
 *   - ドットファイル（'.DS_Store' や '._IMG.jpg' 等）は除外
 *   - 拡張子だけの名前（'.jpg'）は除外
 */
export function isImageFileName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('.')) return false;
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.length > ext.length && lower.endsWith(ext));
}

/** 画像ファイル名のみを抽出して自然順に並べた新しい配列を返す */
export function filterAndSortImageNames(names: readonly string[]): string[] {
  return names.filter(isImageFileName).sort(compareNatural);
}
