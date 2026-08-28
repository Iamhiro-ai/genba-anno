// ライン中心線メタデータ（LineMeta）からのポリゴン再生成・分岐管理の純関数群。
// 2026-07-14 要望4（延長・短縮・分岐）+ 要望5（可変幅テーパー）。DOM 非依存・Node 検証可能。
//
// ポリゴン化の方針（union 判断・エクスポート互換）:
//   - 単一枝・一様幅: 既存 polylineToPolygon（フラットキャップ・従来と完全同一形状＝後方互換）
//   - 単一枝・可変幅: polylineToVariablePolygon（点ごと半幅のリボン・要望5）
//   - 複数枝: 距離場ラスタ化（可変半径カプセルの stroke union）→ Moore 境界追跡 → DP 間引き
//     で「単一の外周ポリゴン」を生成する。COCO/yolo_seg の 1インスタンス=1ポリゴン構造を
//     維持するため multi-polygon 案は不採用（COCO export は segmentation:[flat1本]・
//     yolo_seg は1行=1インスタンスのため、複数ポリゴン分割はインスタンス数を変えてしまう）。
//     量子化誤差はセル寸法（bbox長辺/768・下限0.5px）以下 ≈ 640px 画像で 1px 未満。
//
// 単体検証: frontend/scripts/verify_lineshape.mjs

import type { LineMeta, Pt } from './types';
import { distToSegment, polylineToPolygon } from './geometry';
import { douglasPeucker } from './livewire';

const MAX_CELLS = 768; // ラスタグリッド長辺の上限（性能と精度のバランス）

function clampToImage(p: Pt, w: number, h: number): Pt {
  return [Math.min(Math.max(p[0], 0), w), Math.min(Math.max(p[1], 0), h)];
}

/**
 * 枝 index bi の点ごと幅配列を正規化して返す（要望5）。
 * meta.widths[bi] が「枝の頂点数と同数・全て有限正」のときのみ採用し、
 * それ以外（旧データ・不整合）は meta.width の一様配列にフォールバック（後方互換）。
 */
export function normalizedWidths(meta: LineMeta, bi: number): number[] {
  const br = meta.branches[bi] ?? [];
  const ws = meta.widths?.[bi];
  if (
    Array.isArray(ws) &&
    ws.length === br.length &&
    ws.every((w) => typeof w === 'number' && isFinite(w) && w > 0)
  ) {
    return ws.slice();
  }
  return new Array(br.length).fill(meta.width);
}

function isUniform(ws: number[]): boolean {
  if (ws.length === 0) return true;
  const w0 = ws[0];
  return ws.every((w) => Math.abs(w - w0) < 1e-9);
}

/**
 * 中心線（ポリライン）+ 点ごとの幅 → 可変幅リボンの閉ポリゴン（要望5）。
 * polylineToPolygon の per-point 幅版: 各頂点で隣接法線平均方向に widths[i]/2 オフセット、
 * マイター長は widths[i] の2倍でクランプ（鋭角スパイク防止）、端点はフラットキャップ。
 * widths が一様のときは polylineToPolygon と同一出力になる（同一演算・後方互換）。
 */
export function polylineToVariablePolygon(points: Pt[], widths: number[]): Pt[] {
  // 長さ0セグメント除去（widths を平行に維持）
  const pts: Pt[] = [];
  const ws: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) {
      pts.push(p);
      ws.push(widths[i] ?? widths[widths.length - 1] ?? 0);
    }
  }
  if (pts.length < 2 || ws.some((w) => w <= 0)) return [];

  const n = pts.length;
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
    const half = ws[i] / 2;
    const maxOffset = ws[i] * 2; // マイター長クランプ（点ごと）
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
        dir = normals[i - 1]; // 180度折り返し
      } else {
        dir = [mx / ml, my / ml];
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

/**
 * LineMeta から表示/保存用の閉ポリゴンを再生成する。
 * 単一枝は（一様幅なら従来の polylineToPolygon・可変幅ならリボン）。複数枝はラスタ union の外周1本。
 * 生成不能（退化）なら空配列。
 */
export function regenLinePolygon(meta: LineMeta, imgW: number, imgH: number): Pt[] {
  if (meta.width <= 0) return [];
  // widths との対応を保ったまま退化枝を除外
  const pairs: { br: Pt[]; ws: number[] }[] = [];
  meta.branches.forEach((br, bi) => {
    if (br.length >= 2) pairs.push({ br, ws: normalizedWidths(meta, bi) });
  });
  if (pairs.length === 0) return [];

  const single = (p: { br: Pt[]; ws: number[] }): Pt[] =>
    (isUniform(p.ws)
      ? polylineToPolygon(p.br, p.ws[0] ?? meta.width)
      : polylineToVariablePolygon(p.br, p.ws)
    ).map((q) => clampToImage(q, imgW, imgH));

  if (pairs.length === 1) return single(pairs[0]);
  const contour = rasterUnionContour(
    pairs.map((p) => p.br),
    pairs.map((p) => p.ws)
  );
  if (!contour || contour.length < 3) {
    return single(pairs[0]); // 退化時は幹のみで生成（安全側フォールバック）
  }
  return contour.map((p) => clampToImage(p, imgW, imgH));
}

/**
 * 複数ポリラインの幅付き stroke union の外周を求める（要望5: 点ごと半径のカプセルスタンプ）。
 * 距離場スタンプでラスタ化 → Moore 境界追跡 → DP 間引き。
 * widths は branches と同形状（枝ごと・点ごと）。一様幅は同値配列を渡す。
 */
export function rasterUnionContour(branches: Pt[][], widths: number[][]): Pt[] | null {
  let maxW = 0;
  for (const ws of widths) for (const w of ws) if (w > maxW) maxW = w;
  if (maxW <= 0) return null;
  const rMax = maxW / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const br of branches) {
    for (const [x, y] of br) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return null;
  minX -= rMax + 2;
  minY -= rMax + 2;
  maxX += rMax + 2;
  maxY += rMax + 2;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const cell = Math.max(Math.max(spanX, spanY) / MAX_CELLS, 0.5);
  const gw = Math.ceil(spanX / cell) + 4; // 外周2セルはゼロ境界
  const gh = Math.ceil(spanY / cell) + 4;
  const ox = minX - 2 * cell;
  const oy = minY - 2 * cell;
  const grid = new Uint8Array(gw * gh);

  // 可変半径カプセルスタンプ（セル中心が「セグメント上の最近点における補間半径」以内なら塗る）
  // ホットループのため点-線分距離をインライン展開（関数呼び出し/オブジェクト割当を排除）
  for (let bi = 0; bi < branches.length; bi++) {
    const br = branches[bi];
    const ws = widths[bi] ?? [];
    for (let i = 0; i < br.length - 1; i++) {
      const a = br[i];
      const b = br[i + 1];
      const rA = (ws[i] ?? maxW) / 2;
      const rB = (ws[i + 1] ?? maxW) / 2;
      const rSeg = Math.max(rA, rB);
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby;
      const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - rSeg - ox) / cell));
      const x1 = Math.min(gw - 1, Math.ceil((Math.max(a[0], b[0]) + rSeg - ox) / cell));
      const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - rSeg - oy) / cell));
      const y1 = Math.min(gh - 1, Math.ceil((Math.max(a[1], b[1]) + rSeg - oy) / cell));
      for (let cy = y0; cy <= y1; cy++) {
        const py = oy + (cy + 0.5) * cell;
        const rowBase = cy * gw;
        for (let cx = x0; cx <= x1; cx++) {
          const idx = rowBase + cx;
          if (grid[idx]) continue;
          const px = ox + (cx + 0.5) * cell;
          const apx = px - a[0];
          const apy = py - a[1];
          let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const dx = apx - t * abx;
          const dy = apy - t * aby;
          const rr = rA + (rB - rA) * t;
          if (dx * dx + dy * dy <= rr * rr) grid[idx] = 1;
        }
      }
    }
  }

  // 開始画素（行優先で最初の set セル。左隣は必ず空き）
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (grid[y * gw + x]) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return null;

  // Moore 近傍境界追跡（時計回り: E,SE,S,SW,W,NW,N,NE）
  const dirs: Pt[] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const dirIndexOf = (dx: number, dy: number): number => {
    for (let i = 0; i < 8; i++) if (dirs[i][0] === dx && dirs[i][1] === dy) return i;
    return 4; // 起こらない想定（隣接保証あり）。保険で W
  };
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < gw && y < gh && grid[y * gw + x] === 1;
  const contourCells: Pt[] = [];
  let px = sx;
  let py = sy;
  // 開始セルは行優先スキャンの最初の fg なので、左隣（W）は必ず背景 → そこから時計回り探索
  let backtrackDir = 4; // W
  const maxSteps = gw * gh * 4;
  for (let step = 0; step < maxSteps; step++) {
    contourCells.push([px, py]);
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const d = (backtrackDir + k) % 8;
      const nx = px + dirs[d][0];
      const ny = py + dirs[d][1];
      if (at(nx, ny)) {
        // 直前に調べた空きセル（k=1 のときは backtrack 自身）が新しい backtrack になる。
        // 連続する方位のセル同士は必ず隣接するため、新Pからの方位は再計算できる。
        const prev = (backtrackDir + k - 1) % 8;
        const bx = px + dirs[prev][0];
        const by = py + dirs[prev][1];
        px = nx;
        py = ny;
        backtrackDir = dirIndexOf(bx - px, by - py);
        moved = true;
        break;
      }
    }
    if (!moved) break; // 孤立1セル
    // 開始セルに戻ったら1周完了（stroke幅≥3セルの前提で境界は開始セルを1回だけ通る）
    if (px === sx && py === sy) break;
  }
  return finalizeContour(contourCells, ox, oy, cell);
}

function finalizeContour(cells: Pt[], ox: number, oy: number, cell: number): Pt[] | null {
  if (cells.length < 3) return null;
  const pts: Pt[] = cells.map(([cx, cy]) => [ox + (cx + 0.5) * cell, oy + (cy + 0.5) * cell]);
  const simplified = douglasPeucker(pts, 1.3 * cell) as Pt[];
  return simplified.length >= 3 ? simplified : pts;
}

/** 画像座標 p に最も近い中心線上の位置（枝index・セグメントindex・パラメータt・最近点・距離）。 */
export function nearestOnBranches(
  branches: Pt[][],
  p: Pt
): { branchIndex: number; segIndex: number; t: number; point: Pt; dist: number } | null {
  let best: { branchIndex: number; segIndex: number; t: number; point: Pt; dist: number } | null =
    null;
  branches.forEach((br, bi) => {
    for (let i = 0; i < br.length - 1; i++) {
      const r = distToSegment(p, br[i], br[i + 1]);
      if (!best || r.dist < best.dist) {
        best = { branchIndex: bi, segIndex: i, t: r.t, point: r.closest, dist: r.dist };
      }
    }
  });
  return best;
}

/**
 * 幹（branches[0]）に連結している枝の index 一覧を返す（短縮・枝削除後の孤立枝除去）。
 * widths 等の平行配列を同期フィルタするために index を返す（要望5）。
 * 連結判定: 枝の先頭点（アンカー）が、残存ポリラインのいずれかに width/2+1 以内。
 * 枝が別の枝に付く多段分岐にも対応（fixpoint まで反復）。
 */
export function connectedBranchIndices(branches: Pt[][], width: number): number[] {
  if (branches.length <= 1) return branches.map((_, i) => i);
  const tol = Math.max(width / 2, 3) + 1;
  const isNear = (p: Pt, polyline: Pt[]): boolean => {
    for (let i = 0; i < polyline.length - 1; i++) {
      if (distToSegment(p, polyline[i], polyline[i + 1]).dist <= tol) return true;
    }
    return false;
  };
  const keptIdx: number[] = [0];
  const used = new Array(branches.length).fill(false);
  used[0] = true;
  let changed = true;
  while (changed) {
    changed = false;
    branches.forEach((br, i) => {
      if (used[i] || br.length < 2) return;
      if (keptIdx.some((k) => isNear(br[0], branches[k]))) {
        keptIdx.push(i);
        used[i] = true;
        changed = true;
      }
    });
  }
  return keptIdx.sort((a, b) => a - b);
}

/** connectedBranchIndices の枝配列版（既存呼び出し・テスト互換用ラッパー）。 */
export function filterConnectedBranches(branches: Pt[][], width: number): Pt[][] {
  return connectedBranchIndices(branches, width).map((i) => branches[i]);
}

/** 中心線の端点ハンドル一覧（延長の起点）。幹=両端、枝=自由端（先端）のみ。 */
export function lineEndpoints(
  meta: LineMeta
): { branchIndex: number; attach: 'start' | 'end'; point: Pt }[] {
  const eps: { branchIndex: number; attach: 'start' | 'end'; point: Pt }[] = [];
  meta.branches.forEach((br, bi) => {
    if (br.length < 2) return;
    if (bi === 0) eps.push({ branchIndex: 0, attach: 'start', point: br[0] });
    eps.push({ branchIndex: bi, attach: 'end', point: br[br.length - 1] });
  });
  return eps;
}

/**
 * 点単位巻き戻し（確定済みライン・Backspace）の対象点を返す。
 * 対象 = **最も新しい枝（最大 index の有効枝）の自由端（末尾点）**。
 * 幹（branchIndex=0）は「末尾（end 側）」を対象にする。分岐がある間は枝から先に削れる。
 * @returns 次に削除される中心線点（branchIndex・画像座標）。有効枝が無ければ null
 */
export function lineTailTarget(meta: LineMeta): { branchIndex: number; point: Pt } | null {
  for (let i = meta.branches.length - 1; i >= 0; i--) {
    const br = meta.branches[i];
    if (br.length >= 2) return { branchIndex: i, point: br[br.length - 1] };
  }
  return null;
}

/**
 * 確定済みラインの「末尾の中心線点」を1つ削除した branches/widths を返す（要望: 点単位巻き戻し）。
 * - 対象は lineTailTarget（最大 index の有効枝の末尾点）。widths も平行に同期して縮む。
 * - 削って2点未満になる枝は**枝ごと削除**。幹（branch0）が2点未満になるとライン全体が消滅する。
 * - 幹の短縮で切り離された枝は connectedBranchIndices で除去する。
 * DOM 非依存の純関数（reducer から呼び出し・単体検証は verify_lineshape.mjs）。
 * @returns { branches, widths }。ライン全体が消滅する場合は branches:[]（呼び出し側でポリゴン削除）
 */
export function trimLineTail(meta: LineMeta): { branches: Pt[][]; widths: number[][] } {
  const target = lineTailTarget(meta);
  if (!target) return { branches: [], widths: [] };
  const bi = target.branchIndex;
  const branches = meta.branches.map((b) => b.slice());
  const widths = meta.branches.map((_, i) => normalizedWidths(meta, i));
  const trimmedBr = branches[bi].slice(0, -1);
  const trimmedWs = widths[bi].slice(0, -1);
  if (trimmedBr.length < 2) {
    if (bi === 0) return { branches: [], widths: [] }; // 幹が退化 → ライン消滅
    branches.splice(bi, 1);
    widths.splice(bi, 1);
  } else {
    branches[bi] = trimmedBr;
    widths[bi] = trimmedWs;
  }
  // 末尾削除で幹から切り離された枝を index 同期で除去
  const keptIdx = connectedBranchIndices(branches, meta.width);
  return { branches: keptIdx.map((i) => branches[i]), widths: keptIdx.map((i) => widths[i]) };
}
