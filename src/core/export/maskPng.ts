// =============================================================================
// mask_png フォーマット: 0/255 の単チャネル（グレースケール）マスク PNG 生成。
// 出自: reference の seg_binary（PIL ImageDraw.polygon + mode 'L'）。
// PIL が無いので **純 TS のスキャンライン塗り**（even-odd）を実装する。
//
// 仕様:
//  - ポリゴンは1枚ずつ同一バッファへ塗り重ねる = union（配列を連結して even-odd に
//    かけると重なりが打ち消し合って穴が空くため、必ずポリゴン単位で塗る）
//  - サンプリングはピクセル中心（x+0.5, y+0.5）。境界は半開区間で、
//    矩形 (2,2)-(6,6) は x,y ∈ [2,5] の 4×4 ピクセルになる
//  - 1画像1マスク（クラス別マスクではない）。クラスの絞り込みは planner が済ませる
// =============================================================================

import { encode as encodePng } from 'fast-png';
import type { Pt } from '../types';
import { MAX_EXPORT_IMAGE_PIXELS } from './plan';
import type { ExportMaskTarget } from './plan';

/** マスクの前景値（0/255 二値） */
export const MASK_FOREGROUND = 255;

/**
 * ポリゴン群を 0/255 の 1 チャネルバッファ（長さ width*height）へ塗る。
 * 各ポリゴンは even-odd（自己交差の内側は穴）。ポリゴン同士は union。
 *
 * 寸法ガード: 壊れたサイドカー由来の巨大な width/height をそのまま確保すると
 * RangeError・数 GB のメモリ確保でアプリが落ちる。planner が先に弾いている
 * （excluded_extra.invalid_dimensions）ため通常ここには来ないが、多層防御として
 * 上限超過は静かに空マスクを返さず **明示的に throw** する（黙って真っ黒な
 * マスクを出すと誤った負例教師になるため）。
 */
export function rasterizePolygons(polygons: Pt[][], width: number, height: number): Uint8Array {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w * h > MAX_EXPORT_IMAGE_PIXELS) {
    throw new Error(
      `マスクの寸法が上限を超えています: ${String(width)}x${String(height)}` +
        `（上限 ${MAX_EXPORT_IMAGE_PIXELS}px）`,
    );
  }
  const out = new Uint8Array(w * h);
  if (w === 0 || h === 0) return out;
  for (const poly of polygons) fillPolygon(out, w, h, poly);
  return out;
}

function fillPolygon(out: Uint8Array, w: number, h: number, poly: Pt[]): void {
  const n = poly.length;
  if (n < 3) return;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, py] of poly) {
    if (!Number.isFinite(py)) return; // 非有限が混ざったポリゴンは塗らない（防御）
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  // ピクセル中心 y+0.5 が [minY, maxY) に入る行だけ処理する
  const yStart = Math.max(0, Math.ceil(minY - 0.5));
  const yEnd = Math.min(h - 1, Math.ceil(maxY - 0.5) - 1);
  const xs: number[] = [];

  for (let y = yStart; y <= yEnd; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      // 半開区間 [min,max) で交差判定 → 頂点をまたぐ辺の二重カウントを防ぐ
      if (yi <= sy === yj <= sy) continue;
      xs.push(xj + ((sy - yj) * (xi - xj)) / (yi - yj));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(w - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      if (x1 < x0) continue;
      out.fill(MASK_FOREGROUND, y * w + x0, y * w + x1 + 1);
    }
  }
}

/** 0/255 バッファを 8bit グレースケール PNG（1 チャネル）へエンコード */
export function encodeMaskPng(mask: Uint8Array, width: number, height: number): Uint8Array {
  return encodePng({ width, height, data: mask, depth: 8, channels: 1 });
}

/** マスク1枚分のプラン → PNG バイト列（runner が1枚ずつ呼ぶ） */
export function renderMaskPng(target: ExportMaskTarget): Uint8Array {
  const mask = rasterizePolygons(target.polygons, target.width, target.height);
  return encodeMaskPng(mask, Math.floor(target.width), Math.floor(target.height));
}
