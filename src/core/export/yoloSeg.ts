// =============================================================================
// yolo_seg: セグメンテーションラベル `class x1 y1 x2 y2 ...`（正規化・6 桁）。
// 出自: reference の _yolo_label_lines()（座標クランプ・6 桁丸めまで同一）。
//
// 対象 kind: polygon / line は常に。bbox は includeBBoxAsPolygon（既定 OFF）のとき
// 矩形 4 点ポリゴンとして含める（planner が ExportItem.points に 4 点を入れて渡す）。
// クラス ID のリマップ規則は yolo_det と同一（classes.ts）。
// =============================================================================

import type { ExportItem, PreparedImage } from './plan';
import { joinLabelLines, norm } from './yoloCommon';

/** 1 画像分のラベル行（class x1 y1 x2 y2 ...） */
export function yoloSegLabelLines(items: ExportItem[], width: number, height: number): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (item.points.length < 3) continue; // ポリゴンとして成立しない行は書かない
    const coords: string[] = [];
    for (const [px, py] of item.points) {
      coords.push(norm(px, width));
      coords.push(norm(py, height));
    }
    lines.push(`${item.classId} ${coords.join(' ')}`);
  }
  return lines;
}

/** labels/{split}/<stem>.txt の中身（アノテーション 0 件なら空 = 負例） */
export function yoloSegLabelFile(image: PreparedImage): string {
  return joinLabelLines(yoloSegLabelLines(image.items, image.width, image.height));
}
