// アノテーションエディタ用の幾何ユーティリティ
// 出自: reference/frontend/src/utils/annotationGeometry.ts（移植・挙動不変）
//       + bbox ユーティリティ（GenbaAnno 追加分・ファイル末尾）
// ヒット判定はスクリーン座標系の固定 px で使う想定（呼び出し側で座標変換済みの値を渡す）

import type { BBox, Pt } from './types';

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * 中心線（ポリライン）を幅 width の閉ポリゴンに変換する。
 * 各頂点で隣接セグメント法線の平均方向に width/2 オフセットし、
 * マイター長は width の 2 倍でクランプ（鋭角スパイク防止）。端点はフラットキャップ。
 * 左辺列 + 右辺列の逆順で閉ポリゴン化して返す（頂点数 = 中心線頂点数 × 2）。
 */
export function polylineToPolygon(points: Pt[], width: number): Pt[] {
  if (width <= 0) return [];
  // 長さ0セグメントを除去
  const pts: Pt[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || dist(p, last) > 1e-9) pts.push(p);
  }
  if (pts.length < 2) return [];

  const half = width / 2;
  const maxOffset = width * 2; // マイター長クランプ
  const n = pts.length;
  // 各セグメントの左法線（進行方向に対して左）
  const normals: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    normals.push([-dy / len, dx / len]);
  }

  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let dir: Pt;
    let offset = half;
    if (i === 0) {
      dir = normals[0];
    } else if (i === n - 1) {
      dir = normals[n - 2];
    } else {
      const mx = normals[i - 1][0] + normals[i][0];
      const my = normals[i - 1][1] + normals[i][1];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) {
        // 180度折り返し: マイター方向が定義できないので直前セグメントの法線を使う
        dir = normals[i - 1];
      } else {
        dir = [mx / ml, my / ml];
        // マイター長 = half / cos(θ/2)。cos(θ/2) = miter・normal
        const cosHalf = dir[0] * normals[i][0] + dir[1] * normals[i][1];
        offset = Math.min(half / Math.max(cosHalf, 1e-6), maxOffset);
      }
    }
    left.push([pts[i][0] + dir[0] * offset, pts[i][1] + dir[1] * offset]);
    right.push([pts[i][0] - dir[0] * offset, pts[i][1] - dir[1] * offset]);
  }
  right.reverse();
  return [...left, ...right];
}

/** shoelace 公式の絶対値（閉ポリゴンの面積） */
export function polygonArea(points: Pt[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(sum) / 2;
}

/** 点 p と線分 ab の最短距離・射影パラメータ t (0..1)・最近点 */
export function distToSegment(
  p: Pt,
  a: Pt,
  b: Pt
): { dist: number; t: number; closest: Pt } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 0
      ? Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0), 1)
      : 0;
  const closest: Pt = [a[0] + t * dx, a[1] + t * dy];
  return { dist: dist(p, closest), t, closest };
}

/** 点 p がポリゴン内部か（レイキャスティング法） */
export function pointInPolygon(p: Pt, points: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** 半径 radius 内で最も近い頂点の index（なければ -1） */
export function hitTestVertex(p: Pt, points: Pt[], radius: number): number {
  let best = -1;
  let bestD = radius;
  for (let i = 0; i < points.length; i++) {
    const d = dist(p, points[i]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * 半径 radius 内で最も近いエッジ。index はエッジ始点の頂点 index
 * （points[index] → points[(index+1) % n]）。頂点挿入は index+1 の位置に行う。
 */
export function hitTestEdge(
  p: Pt,
  points: Pt[],
  radius: number
): { index: number; t: number; closest: Pt } | null {
  let best: { index: number; t: number; closest: Pt } | null = null;
  let bestD = radius;
  for (let i = 0; i < points.length; i++) {
    const r = distToSegment(p, points[i], points[(i + 1) % points.length]);
    if (r.dist <= bestD) {
      bestD = r.dist;
      best = { index: i, t: r.t, closest: r.closest };
    }
  }
  return best;
}

/**
 * ポリゴン選択のヒット判定。内部ヒットに加え、edgeRadius > 0 なら
 * エッジ近傍ヒットでも成立（細長ポリゴン対策・設計書 §3.4）。
 */
export function hitTestPolygon(p: Pt, points: Pt[], edgeRadius = 0): boolean {
  if (points.length < 3) return false;
  if (pointInPolygon(p, points)) return true;
  return edgeRadius > 0 && hitTestEdge(p, points, edgeRadius) !== null;
}

// ---------------------------------------------------------------------------
// bbox ユーティリティ（GenbaAnno 追加分。上記の移植コードとは独立）
// ---------------------------------------------------------------------------

/** 2つの角点から正規化された bbox（w,h >= 0）を作る */
export function normalizeBBox(a: Pt, b: Pt): BBox {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/**
 * bbox を画像内 [0,imgW]×[0,imgH] に収める。
 * まず位置をシフトし、それでも収まらない場合は寸法を切り詰める（変形は最終手段）。
 */
export function clampBBoxToImage(box: BBox, imgW: number, imgH: number): BBox {
  let w = Math.min(box.w, imgW);
  let h = Math.min(box.h, imgH);
  let x = Math.min(Math.max(box.x, 0), imgW - w);
  let y = Math.min(Math.max(box.y, 0), imgH - h);
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  if (!Number.isFinite(w)) w = 0;
  if (!Number.isFinite(h)) h = 0;
  return { x, y, w, h };
}

/** 点が bbox 内（境界含む）か */
export function bboxContains(box: BBox, p: Pt): boolean {
  return p[0] >= box.x && p[0] <= box.x + box.w && p[1] >= box.y && p[1] <= box.y + box.h;
}

/** 点列の外接矩形。空配列は零矩形 */
export function bboxOfPoints(points: Pt[]): BBox {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of points) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** bbox を左上から時計回りの4頂点ポリゴンにする（yolo_seg の bbox 含めオプション用） */
export function bboxToPolygon(box: BBox): Pt[] {
  return [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ];
}
