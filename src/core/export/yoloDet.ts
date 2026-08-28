// =============================================================================
// yolo_det: 物体検出ラベル `class cx cy w h`（正規化・6 桁）。
//
// 対象 kind: bbox は常に。polygon / line は includeDerivedBoxes（既定 ON）のとき
// 外接矩形として含める（planner が ExportItem.box に外接矩形を入れて渡す）。
// =============================================================================

import type { ExportItem, PreparedImage } from './plan';
import { joinLabelLines, norm } from './yoloCommon';

/** 1 画像分のラベル行（class cx cy w h） */
export function yoloDetLabelLines(items: ExportItem[], width: number, height: number): string[] {
  return items.map((item) => {
    const { x, y, w, h } = item.box;
    const cx = norm(x + w / 2, width);
    const cy = norm(y + h / 2, height);
    const nw = norm(w, width);
    const nh = norm(h, height);
    return `${item.classId} ${cx} ${cy} ${nw} ${nh}`;
  });
}

/** labels/{split}/<stem>.txt の中身（アノテーション 0 件なら空 = 負例） */
export function yoloDetLabelFile(image: PreparedImage): string {
  return joinLabelLines(yoloDetLabelLines(image.items, image.width, image.height));
}
