// =============================================================================
// yolo_det / yolo_seg 共通の正規化・data.yaml 生成。
// 出自: reference の _yolo_label_lines() / _build_data_yaml()。
// =============================================================================

import type { ExportClassMapping } from './plan';

/** 正規化座標の小数桁数（参照実装と同じ 6 桁） */
export const COORD_DIGITS = 6;

/** 0..1 クランプ + 6 桁固定小数（-0 を出さない） */
export function norm(value: number, size: number): string {
  const v = size > 0 ? value / size : 0;
  const clamped = Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 1);
  return (clamped === 0 ? 0 : clamped).toFixed(COORD_DIGITS);
}

/** ラベルファイルの中身。行が無ければ空文字（= 0 バイトの負例ラベル） */
export function joinLabelLines(lines: string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * data.yaml。**`path:` キーは書かない**（ultralytics は path が無ければ yaml の
 * 親ディレクトリを基準にする。`path: .` を書くと settings の datasets_dir 基準に
 * 解決されて「データが見つからない」になる罠。docs/DESIGN.md §5）。
 *
 * hasVal=false（val が 0 枚）のとき images/val は存在せず、ultralytics は
 * val パス不在で例外を出す。学習が始まらない方が事故なので val を train に向け、
 * その旨をコメントで明記する。
 */
export function buildDataYaml(
  classes: ExportClassMapping[],
  format: 'yolo_det' | 'yolo_seg',
  hasVal: boolean,
): string {
  const names = classes.map((c) => `'${c.name.replace(/'/g, "''")}'`).join(', ');
  const lines = [
    `# genba-anno export (${format})`,
    '# class id は元プロジェクトの id を昇順に 0..N-1 へ振り直したもの',
    '# （対応表は export_manifest.json の class_id_map を参照）',
    'train: images/train',
  ];
  if (hasVal) {
    lines.push('val: images/val');
  } else {
    lines.push('# val 分割が 0 枚のため val は train を指す（val_ratio を 0 より大きくすると分かれます）');
    lines.push('val: images/train');
  }
  lines.push(`nc: ${classes.length}`, `names: [${names}]`, '');
  return lines.join('\n');
}
