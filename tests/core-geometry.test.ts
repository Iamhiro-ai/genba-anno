// =============================================================================
// core/geometry.ts の純関数テスト（M1 / MT）。
//
// 前半: reference からの移植分（polylineToPolygon / polygonArea / distToSegment /
//       pointInPolygon / hitTest*）。挙動不変が契約なので「実装が仕様」として、
//       レンジ・単調性・境界規約を固定する。
// 後半: GenbaAnno 追加分の bbox ユーティリティ。
//
// 較正定数の具体値はアサートしない（geometry には無い）。マイター長クランプ等は
// 「width の 2 倍」という実装コメント上の規約のみを、幅からの相対値で検証する。
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  bboxContains,
  bboxOfPoints,
  bboxToPolygon,
  clampBBoxToImage,
  distToSegment,
  hitTestEdge,
  hitTestPolygon,
  hitTestVertex,
  normalizeBBox,
  pointInPolygon,
  polygonArea,
  polylineToPolygon,
} from '../src/core/geometry';
import type { BBox, Pt } from '../src/core/types';

/** 10x10 の正方形（画面座標系: y は下向き） */
const SQUARE: Pt[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

/** U 字（凹）ポリゴン。x=3..7 / y=5..20 が窪み（外部） */
const U_SHAPE: Pt[] = [
  [0, 0],
  [10, 0],
  [10, 20],
  [7, 20],
  [7, 5],
  [3, 5],
  [3, 20],
  [0, 20],
];

/** 符号付き面積（shoelace）。画面座標系（y 下向き）では正 = 時計回り。 */
function signedArea(points: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

// ---------------------------------------------------------------------------
// polylineToPolygon
// ---------------------------------------------------------------------------

describe('polylineToPolygon', () => {
  it('width <= 0 は空配列', () => {
    const line: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(polylineToPolygon(line, 0)).toEqual([]);
    expect(polylineToPolygon(line, -5)).toEqual([]);
  });

  it('有効点が 2 未満（空・1 点・同一点の連続）は空配列', () => {
    expect(polylineToPolygon([], 10)).toEqual([]);
    expect(polylineToPolygon([[5, 5]], 10)).toEqual([]);
    expect(
      polylineToPolygon(
        [
          [5, 5],
          [5, 5],
          [5, 5],
        ],
        10
      )
    ).toEqual([]);
  });

  it('頂点数 = 中心線頂点数 × 2 の閉リボンで、左右が中心線から ±width/2', () => {
    const line: Pt[] = [
      [0, 0],
      [50, 0],
      [100, 0],
    ];
    const poly = polylineToPolygon(line, 10);
    expect(poly).toHaveLength(line.length * 2);
    // 左辺列 = 前半、右辺列 = 後半（逆順）
    for (let i = 0; i < line.length; i++) {
      const left = poly[i];
      const right = poly[poly.length - 1 - i];
      expect(left[0]).toBeCloseTo(line[i][0], 9);
      expect(right[0]).toBeCloseTo(line[i][0], 9);
      expect(left[1] - line[i][1]).toBeCloseTo(5, 9);
      expect(right[1] - line[i][1]).toBeCloseTo(-5, 9);
    }
  });

  it('長さ 0 セグメントは除去され、一意点のぶんだけ頂点が出る', () => {
    const withDup: Pt[] = [
      [0, 0],
      [0, 0],
      [10, 0],
      [10, 0],
      [20, 0],
    ];
    const clean: Pt[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    expect(polylineToPolygon(withDup, 8)).toEqual(polylineToPolygon(clean, 8));
    expect(polylineToPolygon(withDup, 8)).toHaveLength(6);
  });

  it('直線リボンの面積 = 長さ × 幅', () => {
    const poly = polylineToPolygon(
      [
        [0, 0],
        [100, 0],
      ],
      10
    );
    expect(polygonArea(poly)).toBeCloseTo(1000, 6);
  });

  it('鋭角のマイター長は width の 2 倍でクランプされる（スパイク防止）', () => {
    const width = 4;
    // ほぼ折り返す鋭角（頂点 [10,0] で 180 度近く戻る）
    const spike: Pt[] = [
      [0, 0],
      [10, 0],
      [0, 0.5],
    ];
    const poly = polylineToPolygon(spike, width);
    const apex = spike[1];
    const left = poly[1];
    const right = poly[poly.length - 2];
    const dl = Math.hypot(left[0] - apex[0], left[1] - apex[1]);
    const dr = Math.hypot(right[0] - apex[0], right[1] - apex[1]);
    expect(dl).toBeLessThanOrEqual(width * 2 + 1e-9);
    expect(dr).toBeLessThanOrEqual(width * 2 + 1e-9);
    // クランプが効いている（半幅より明確に伸びているがクランプ値を超えない）
    expect(dl).toBeCloseTo(width * 2, 6);
  });

  it('180 度折返しでも NaN を出さず有限座標を返す（直前セグメント法線を使用）', () => {
    const fold: Pt[] = [
      [0, 0],
      [10, 0],
      [0, 0],
    ];
    const poly = polylineToPolygon(fold, 4);
    expect(poly).toHaveLength(6);
    for (const [x, y] of poly) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    // 折返し頂点は直前セグメントの法線方向に半幅ぶんだけオフセット
    expect(poly[1]).toEqual([10, 2]);
  });
});

// ---------------------------------------------------------------------------
// polygonArea
// ---------------------------------------------------------------------------

describe('polygonArea', () => {
  it('矩形・三角形の面積', () => {
    expect(polygonArea(SQUARE)).toBeCloseTo(100, 9);
    expect(
      polygonArea([
        [0, 0],
        [4, 0],
        [0, 3],
      ])
    ).toBeCloseTo(6, 9);
  });

  it('巻き順に依存しない（絶対値）', () => {
    const cw = polygonArea(SQUARE);
    const ccw = polygonArea([...SQUARE].reverse());
    expect(ccw).toBeCloseTo(cw, 9);
  });

  it('退化形状（2 点以下・共線）は 0', () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([[1, 1]])).toBe(0);
    expect(
      polygonArea([
        [0, 0],
        [10, 10],
      ])
    ).toBeCloseTo(0, 9);
    expect(
      polygonArea([
        [0, 0],
        [5, 5],
        [10, 10],
      ])
    ).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------------------
// distToSegment
// ---------------------------------------------------------------------------

describe('distToSegment', () => {
  it('垂線が線分内に落ちる場合は t と最近点を返す', () => {
    const r = distToSegment([5, 3], [0, 0], [10, 0]);
    expect(r.dist).toBeCloseTo(3, 9);
    expect(r.t).toBeCloseTo(0.5, 9);
    expect(r.closest).toEqual([5, 0]);
  });

  it('線分の外側では t が 0 / 1 にクランプされる', () => {
    const before = distToSegment([-5, 0], [0, 0], [10, 0]);
    expect(before.t).toBe(0);
    expect(before.dist).toBeCloseTo(5, 9);
    expect(before.closest).toEqual([0, 0]);

    const after = distToSegment([30, 0], [0, 0], [10, 0]);
    expect(after.t).toBe(1);
    expect(after.dist).toBeCloseTo(20, 9);
    expect(after.closest).toEqual([10, 0]);
  });

  it('退化線分（a == b）は t=0・端点までの距離', () => {
    const r = distToSegment([3, 4], [0, 0], [0, 0]);
    expect(r.t).toBe(0);
    expect(r.dist).toBeCloseTo(5, 9);
    expect(r.closest).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// pointInPolygon
// ---------------------------------------------------------------------------

describe('pointInPolygon', () => {
  it('内部 true / 外部 false', () => {
    expect(pointInPolygon([5, 5], SQUARE)).toBe(true);
    expect(pointInPolygon([-1, 5], SQUARE)).toBe(false);
    expect(pointInPolygon([11, 5], SQUARE)).toBe(false);
    expect(pointInPolygon([5, 20], SQUARE)).toBe(false);
  });

  it('境界は半開区間規約（min 側の辺・頂点は内部、max 側は外部）', () => {
    // レイキャスティングの標準規約。ヒット判定は hitTestPolygon の edgeRadius で吸収する。
    expect(pointInPolygon([0, 5], SQUARE)).toBe(true); // 左辺
    expect(pointInPolygon([5, 0], SQUARE)).toBe(true); // 上辺（y 最小）
    expect(pointInPolygon([0, 0], SQUARE)).toBe(true); // 左上頂点
    expect(pointInPolygon([10, 5], SQUARE)).toBe(false); // 右辺
    expect(pointInPolygon([5, 10], SQUARE)).toBe(false); // 下辺（y 最大）
    expect(pointInPolygon([10, 10], SQUARE)).toBe(false); // 右下頂点
  });

  it('凹形状（U 字）の窪みは外部・腕は内部', () => {
    expect(pointInPolygon([5, 12], U_SHAPE)).toBe(false); // 窪みの中
    expect(pointInPolygon([1, 12], U_SHAPE)).toBe(true); // 左腕
    expect(pointInPolygon([9, 12], U_SHAPE)).toBe(true); // 右腕
    expect(pointInPolygon([5, 2], U_SHAPE)).toBe(true); // 底
  });

  it('退化ポリゴン（2 点以下）は常に false', () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
    expect(
      pointInPolygon(
        [5, 0],
        [
          [0, 0],
          [10, 0],
        ]
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hitTestVertex / hitTestEdge / hitTestPolygon
// ---------------------------------------------------------------------------

describe('hitTestVertex', () => {
  it('半径内で最も近い頂点の index を返す', () => {
    expect(hitTestVertex([9, 1], SQUARE, 3)).toBe(1);
    expect(hitTestVertex([1, 9], SQUARE, 3)).toBe(3);
  });

  it('半径ちょうどはヒット・わずかに超えると -1', () => {
    const one: Pt[] = [[0, 0]];
    expect(hitTestVertex([5, 0], one, 5)).toBe(0);
    expect(hitTestVertex([5.0001, 0], one, 5)).toBe(-1);
  });

  it('等距離タイは後方の index が勝つ（<= 比較）', () => {
    const pair: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(hitTestVertex([5, 0], pair, 6)).toBe(1);
  });

  it('空配列・半径外は -1', () => {
    expect(hitTestVertex([0, 0], [], 10)).toBe(-1);
    expect(hitTestVertex([100, 100], SQUARE, 5)).toBe(-1);
  });
});

describe('hitTestEdge', () => {
  it('最近エッジの始点 index・t・最近点を返す', () => {
    const r = hitTestEdge([5, -1], SQUARE, 3);
    expect(r).not.toBeNull();
    expect(r?.index).toBe(0); // points[0] → points[1]
    expect(r?.t).toBeCloseTo(0.5, 9);
    expect(r?.closest).toEqual([5, 0]);
  });

  it('閉ループの最終エッジ（points[n-1] → points[0]）も対象', () => {
    const r = hitTestEdge([-1, 5], SQUARE, 3);
    expect(r?.index).toBe(3);
    expect(r?.closest).toEqual([0, 5]);
  });

  it('半径外は null', () => {
    expect(hitTestEdge([5, 20], SQUARE, 3)).toBeNull();
  });

  it('細長ポリゴンでも近い方の長辺を選ぶ', () => {
    const thin: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 2],
      [0, 2],
    ];
    expect(hitTestEdge([50, -1], thin, 3)?.index).toBe(0); // 上辺
    expect(hitTestEdge([50, 3], thin, 3)?.index).toBe(2); // 下辺
  });
});

describe('hitTestPolygon', () => {
  it('3 点未満は常に false', () => {
    expect(hitTestPolygon([0, 0], [], 5)).toBe(false);
    expect(
      hitTestPolygon(
        [5, 0],
        [
          [0, 0],
          [10, 0],
        ],
        5
      )
    ).toBe(false);
  });

  it('内部はヒット・外部は edgeRadius=0 ならヒットしない', () => {
    expect(hitTestPolygon([5, 5], SQUARE)).toBe(true);
    expect(hitTestPolygon([12, 5], SQUARE)).toBe(false);
    expect(hitTestPolygon([12, 5], SQUARE, 0)).toBe(false);
  });

  it('edgeRadius > 0 ならエッジ近傍の外側もヒット（細長ポリゴン対策）', () => {
    const sliver: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 1],
      [0, 1],
    ];
    expect(hitTestPolygon([50, 3], sliver)).toBe(false);
    expect(hitTestPolygon([50, 3], sliver, 4)).toBe(true);
    expect(hitTestPolygon([50, 3], sliver, 1)).toBe(false); // 半径不足
  });
});

// ---------------------------------------------------------------------------
// bbox ユーティリティ（追加分）
// ---------------------------------------------------------------------------

describe('normalizeBBox', () => {
  it('角点の順序に依らず同じ bbox（w,h >= 0）', () => {
    const expected: BBox = { x: 10, y: 20, w: 30, h: 40 };
    expect(normalizeBBox([10, 20], [40, 60])).toEqual(expected);
    expect(normalizeBBox([40, 60], [10, 20])).toEqual(expected);
    expect(normalizeBBox([40, 20], [10, 60])).toEqual(expected);
    expect(normalizeBBox([10, 60], [40, 20])).toEqual(expected);
  });

  it('同一点は零サイズ・負座標も扱える', () => {
    expect(normalizeBBox([5, 5], [5, 5])).toEqual({ x: 5, y: 5, w: 0, h: 0 });
    expect(normalizeBBox([-10, -5], [-2, -1])).toEqual({ x: -10, y: -5, w: 8, h: 4 });
  });
});

describe('clampBBoxToImage', () => {
  it('画像内に収まっていれば変化しない', () => {
    const box: BBox = { x: 10, y: 10, w: 30, h: 20 };
    expect(clampBBoxToImage(box, 100, 100)).toEqual(box);
  });

  it('はみ出しはまず位置をシフトして寸法を保つ', () => {
    // 右下はみ出し
    expect(clampBBoxToImage({ x: 95, y: 90, w: 20, h: 30 }, 100, 100)).toEqual({
      x: 80,
      y: 70,
      w: 20,
      h: 30,
    });
    // 左上はみ出し
    expect(clampBBoxToImage({ x: -20, y: -5, w: 20, h: 30 }, 100, 100)).toEqual({
      x: 0,
      y: 0,
      w: 20,
      h: 30,
    });
  });

  it('画像より大きい bbox は寸法を切り詰めて原点へ', () => {
    expect(clampBBoxToImage({ x: 30, y: -50, w: 150, h: 400 }, 100, 80)).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 80,
    });
  });

  it('非有限値（NaN / Infinity）は 0 か画像サイズに落ちる', () => {
    expect(clampBBoxToImage({ x: NaN, y: 5, w: 10, h: 10 }, 100, 100)).toEqual({
      x: 0,
      y: 5,
      w: 10,
      h: 10,
    });
    expect(clampBBoxToImage({ x: 5, y: NaN, w: NaN, h: 10 }, 100, 100)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 10,
    });
    // Infinity は Math.min で画像サイズに丸まる（非有限ガードには到達しない）
    expect(clampBBoxToImage({ x: 5, y: 5, w: Infinity, h: 10 }, 100, 100)).toEqual({
      x: 0,
      y: 5,
      w: 100,
      h: 10,
    });
  });

  it('負サイズは正規化されない（normalizeBBox が呼び出し側の責務）', () => {
    const r = clampBBoxToImage({ x: 5, y: 5, w: -10, h: 10 }, 100, 100);
    expect(r.w).toBe(-10);
    // 正規化してから通せば画像内に収まる
    const ok = clampBBoxToImage(normalizeBBox([5, 5], [-5, 15]), 100, 100);
    expect(ok).toEqual({ x: 0, y: 5, w: 10, h: 10 });
  });
});

describe('bboxContains', () => {
  const box: BBox = { x: 10, y: 20, w: 30, h: 40 };

  it('内部の点を含む / 外部の点を含まない', () => {
    expect(bboxContains(box, [25, 40])).toBe(true);
    expect(bboxContains(box, [9.9, 40])).toBe(false);
    expect(bboxContains(box, [40.1, 40])).toBe(false);
    expect(bboxContains(box, [25, 19.9])).toBe(false);
    expect(bboxContains(box, [25, 60.1])).toBe(false);
  });

  it('境界（4 辺・4 隅）は含む', () => {
    expect(bboxContains(box, [10, 40])).toBe(true);
    expect(bboxContains(box, [40, 40])).toBe(true);
    expect(bboxContains(box, [25, 20])).toBe(true);
    expect(bboxContains(box, [25, 60])).toBe(true);
    expect(bboxContains(box, [10, 20])).toBe(true);
    expect(bboxContains(box, [40, 60])).toBe(true);
  });

  it('零サイズ bbox は自身の点だけを含む', () => {
    const dot: BBox = { x: 5, y: 5, w: 0, h: 0 };
    expect(bboxContains(dot, [5, 5])).toBe(true);
    expect(bboxContains(dot, [5.001, 5])).toBe(false);
  });
});

describe('bboxOfPoints', () => {
  it('空配列は零矩形', () => {
    expect(bboxOfPoints([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('1 点は零サイズでその位置', () => {
    expect(bboxOfPoints([[7, -3]])).toEqual({ x: 7, y: -3, w: 0, h: 0 });
  });

  it('複数点（負座標含む）の外接矩形', () => {
    expect(
      bboxOfPoints([
        [10, 5],
        [-4, 20],
        [3, -2],
      ])
    ).toEqual({ x: -4, y: -2, w: 14, h: 22 });
  });
});

describe('bboxToPolygon', () => {
  it('左上から時計回りの 4 頂点（画面座標系 y 下向き）', () => {
    const poly = bboxToPolygon({ x: 1, y: 2, w: 3, h: 4 });
    expect(poly).toEqual([
      [1, 2],
      [4, 2],
      [4, 6],
      [1, 6],
    ]);
    expect(signedArea(poly)).toBeGreaterThan(0); // y 下向きでは正 = 時計回り
    expect(polygonArea(poly)).toBeCloseTo(12, 9);
  });

  it('bboxOfPoints とラウンドトリップする', () => {
    const box: BBox = { x: -5, y: 8, w: 20, h: 12 };
    expect(bboxOfPoints(bboxToPolygon(box))).toEqual(box);
  });
});
