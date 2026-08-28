// =============================================================================
// core/lineShape.ts の純関数テスト（M1 / MT）。
//
// scripts/verify_lineshape.mjs の検証項目を vitest へ移植し、境界条件
// （空 branches・1 点枝・退化入力・幅の不整合）を追加した。
// 実装は較正済みの移植コードなので「実装の挙動が仕様」。ラスタ union の
// セル寸法など内部定数は直接アサートせず、面積比・包含関係で検証する。
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  connectedBranchIndices,
  filterConnectedBranches,
  lineEndpoints,
  lineTailTarget,
  nearestOnBranches,
  normalizedWidths,
  polylineToVariablePolygon,
  rasterUnionContour,
  regenLinePolygon,
  trimLineTail,
} from '../src/core/lineShape';
import { pointInPolygon, polygonArea, polylineToPolygon } from '../src/core/geometry';
import type { LineMeta, Pt } from '../src/core/types';

/** 2 つの点列が座標一致するか（浮動小数許容） */
function samePoints(a: Pt[], b: Pt[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-9 && Math.abs(p[1] - b[i][1]) < 1e-9)
  );
}

const TRUNK: Pt[] = [
  [100, 50],
  [100, 250],
];
const BRANCH: Pt[] = [
  [100, 150],
  [200, 150],
];

// ---------------------------------------------------------------------------
// polylineToVariablePolygon
// ---------------------------------------------------------------------------

describe('polylineToVariablePolygon', () => {
  const line: Pt[] = [
    [100, 100],
    [100, 200],
    [100, 300],
  ];

  it('点数 2 倍の閉リボンを返し、一様幅では polylineToPolygon と一致（後方互換）', () => {
    const uni = polylineToVariablePolygon(line, [12, 12, 12]);
    expect(uni).toHaveLength(line.length * 2);
    expect(samePoints(uni, polylineToPolygon(line, 12))).toBe(true);
  });

  it('テーパー幅が左右間隔に反映される（上端 4px・下端 16px）', () => {
    const taper = polylineToVariablePolygon(line, [4, 10, 16]);
    const n = line.length;
    const topW = Math.hypot(taper[0][0] - taper[2 * n - 1][0], taper[0][1] - taper[2 * n - 1][1]);
    const botW = Math.hypot(taper[n - 1][0] - taper[n][0], taper[n - 1][1] - taper[n][1]);
    expect(topW).toBeCloseTo(4, 9);
    expect(botW).toBeCloseTo(16, 9);
    // 中間点は中間幅
    const midW = Math.hypot(taper[1][0] - taper[2 * n - 2][0], taper[1][1] - taper[2 * n - 2][1]);
    expect(midW).toBeCloseTo(10, 9);
  });

  it('連続する同一点は除去され、widths が平行に維持される', () => {
    const dup: Pt[] = [
      [0, 0],
      [0, 0],
      [10, 0],
    ];
    const poly = polylineToVariablePolygon(dup, [4, 4, 4]);
    expect(poly).toHaveLength(4); // 一意点 2 × 2
    expect(
      samePoints(
        poly,
        polylineToPolygon(
          [
            [0, 0],
            [10, 0],
          ],
          4
        )
      )
    ).toBe(true);
  });

  it('退化入力（空・1 点・全点同一）は空配列', () => {
    expect(polylineToVariablePolygon([], [])).toEqual([]);
    expect(polylineToVariablePolygon([[5, 5]], [4])).toEqual([]);
    expect(
      polylineToVariablePolygon(
        [
          [5, 5],
          [5, 5],
          [5, 5],
        ],
        [4, 4, 4]
      )
    ).toEqual([]);
  });

  it('幅に 0 以下が混ざる場合は安全側で空配列', () => {
    const seg: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(polylineToVariablePolygon(seg, [0, 4])).toEqual([]);
    expect(polylineToVariablePolygon(seg, [-4, -4])).toEqual([]);
  });

  it('widths が点数より短い場合は末尾幅で補完される', () => {
    const three: Pt[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ];
    expect(samePoints(polylineToVariablePolygon(three, [6]), polylineToPolygon(three, 6))).toBe(
      true
    );
  });

  it('マイター長は点ごとの幅の 2 倍でクランプされる', () => {
    const width = 6;
    const spike: Pt[] = [
      [0, 0],
      [10, 0],
      [0, 0.5],
    ];
    const poly = polylineToVariablePolygon(spike, [width, width, width]);
    const apex = spike[1];
    const d = Math.hypot(poly[1][0] - apex[0], poly[1][1] - apex[1]);
    expect(d).toBeCloseTo(width * 2, 6);
    expect(d).toBeLessThanOrEqual(width * 2 + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// regenLinePolygon
// ---------------------------------------------------------------------------

describe('regenLinePolygon', () => {
  it('単一枝・一様幅（widths なし）は polylineToPolygon と座標一致', () => {
    const branches: Pt[][] = [
      [
        [50, 50],
        [50, 200],
        [80, 300],
      ],
    ];
    const meta: LineMeta = { branches, width: 10 };
    expect(samePoints(regenLinePolygon(meta, 640, 640), polylineToPolygon(branches[0], 10))).toBe(
      true
    );
  });

  it('単一枝・可変幅は widths を採用する（下側が太い）', () => {
    const line: Pt[] = [
      [100, 100],
      [100, 200],
      [100, 300],
    ];
    const meta: LineMeta = { branches: [line], width: 10, widths: [[4, 10, 16]] };
    const poly = regenLinePolygon(meta, 640, 640);
    expect(pointInPolygon([107, 295], poly)).toBe(true); // 下端は幅 16 → ±8
    expect(pointInPolygon([107, 105], poly)).toBe(false); // 上端は幅 4 → ±2
  });

  it('widths の点数が枝と不一致なら一様幅にフォールバック（後方互換ガード）', () => {
    const line: Pt[] = [
      [100, 100],
      [100, 200],
      [100, 300],
    ];
    const bad = regenLinePolygon({ branches: [line], width: 10, widths: [[4, 16]] }, 640, 640);
    expect(samePoints(bad, polylineToPolygon(line, 10))).toBe(true);
  });

  it('width <= 0 / 枝なし / 1 点枝のみ は空配列', () => {
    expect(regenLinePolygon({ branches: [TRUNK], width: 0 }, 640, 640)).toEqual([]);
    expect(regenLinePolygon({ branches: [], width: 10 }, 640, 640)).toEqual([]);
    expect(regenLinePolygon({ branches: [[[10, 10]]], width: 10 }, 640, 640)).toEqual([]);
  });

  it('生成頂点は画像内へクランプされる', () => {
    const meta: LineMeta = {
      branches: [
        [
          [-20, 50],
          [50, 50],
        ],
      ],
      width: 20,
    };
    const poly = regenLinePolygon(meta, 100, 100);
    expect(poly.length).toBeGreaterThanOrEqual(4);
    for (const [x, y] of poly) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('T 字分岐は単一の外周ポリゴンになり、面積が幹+枝の合計に近い', () => {
    const meta: LineMeta = { branches: [TRUNK, BRANCH], width: 12 };
    const poly = regenLinePolygon(meta, 640, 640);
    expect(poly.length).toBeGreaterThanOrEqual(8);
    // 単一の閉リング（COCO/yolo_seg の 1 インスタンス = 1 ポリゴンを維持）
    expect(Array.isArray(poly[0])).toBe(true);
    expect(typeof poly[0][0]).toBe('number');

    const areaUnion = polygonArea(poly);
    const areaTrunk = polygonArea(polylineToPolygon(TRUNK, 12));
    const areaBranch = polygonArea(polylineToPolygon(BRANCH, 12));
    expect(areaUnion).toBeGreaterThan(areaTrunk);
    expect(Math.abs(areaUnion - (areaTrunk + areaBranch))).toBeLessThan(
      0.2 * (areaTrunk + areaBranch)
    );
  });

  it('T 字分岐は両腕と接合部を包含する', () => {
    const poly = regenLinePolygon({ branches: [TRUNK, BRANCH], width: 12 }, 640, 640);
    expect(pointInPolygon([100, 60], poly)).toBe(true); // 幹の上端
    expect(pointInPolygon([100, 240], poly)).toBe(true); // 幹の下端
    expect(pointInPolygon([190, 150], poly)).toBe(true); // 枝の先端
    expect(pointInPolygon([105, 150], poly)).toBe(true); // 接合部
    expect(pointInPolygon([190, 100], poly)).toBe(false); // 何も無い領域
  });

  it('可変幅 union は太い幹・細い枝をそれぞれの半径で塗る', () => {
    const meta: LineMeta = {
      branches: [TRUNK, BRANCH],
      width: 10,
      widths: [
        [20, 20],
        [4, 4],
      ],
    };
    const poly = regenLinePolygon(meta, 640, 640);
    expect(poly.length).toBeGreaterThanOrEqual(8);
    expect(pointInPolygon([108, 100], poly)).toBe(true); // 幹は幅 20 → ±10
    expect(pointInPolygon([180, 150], poly)).toBe(true); // 枝の中心線上
    expect(pointInPolygon([180, 158], poly)).toBe(false); // 枝は幅 4 → ±2 なので届かない
  });
});

// ---------------------------------------------------------------------------
// rasterUnionContour
// ---------------------------------------------------------------------------

describe('rasterUnionContour', () => {
  it('T 字分岐で単一の外周リングを返す', () => {
    const contour = rasterUnionContour(
      [TRUNK, BRANCH],
      [
        [12, 12],
        [12, 12],
      ]
    );
    expect(contour).not.toBeNull();
    expect(contour!.length).toBeGreaterThanOrEqual(3);
    // 量子化誤差はセル寸法（bbox 長辺/768・下限 0.5px）以下。1px 程度の余裕で包含判定。
    expect(pointInPolygon([100, 150], contour!)).toBe(true);
    expect(pointInPolygon([195, 150], contour!)).toBe(true);
  });

  it('枝の合計面積に近い（±20%）', () => {
    const contour = rasterUnionContour(
      [TRUNK, BRANCH],
      [
        [12, 12],
        [12, 12],
      ]
    )!;
    const sum =
      polygonArea(polylineToPolygon(TRUNK, 12)) + polygonArea(polylineToPolygon(BRANCH, 12));
    expect(Math.abs(polygonArea(contour) - sum)).toBeLessThan(0.2 * sum);
  });

  it('空 branches・幅 0 は null', () => {
    expect(rasterUnionContour([], [])).toBeNull();
    expect(rasterUnionContour([TRUNK], [[0, 0]])).toBeNull();
    expect(rasterUnionContour([[[10, 10]]], [[8]])).toBeNull(); // 1 点枝はスタンプされない
  });

  it('非連結な枝は先頭ブロブの外周のみを返す（上流で孤立枝を除去する前提）', () => {
    // connectedBranchIndices が孤立枝を落とすため実運用では発生しない入力。
    // 「単一の外周ポリゴン」という契約側の制約をここで固定しておく。
    const far: Pt[][] = [
      [
        [10, 10],
        [60, 10],
      ],
      [
        [10, 200],
        [60, 200],
      ],
    ];
    const contour = rasterUnionContour(far, [
      [10, 10],
      [10, 10],
    ])!;
    expect(contour).not.toBeNull();
    expect(pointInPolygon([30, 10], contour)).toBe(true);
    expect(pointInPolygon([30, 200], contour)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizedWidths
// ---------------------------------------------------------------------------

describe('normalizedWidths', () => {
  const branches: Pt[][] = [
    [
      [0, 0],
      [1, 1],
    ],
  ];

  it('枝と同数・全て有限正の widths はそのまま採用（コピーを返す）', () => {
    const meta: LineMeta = { branches, width: 7, widths: [[3, 4]] };
    const ws = normalizedWidths(meta, 0);
    expect(ws).toEqual([3, 4]);
    expect(ws).not.toBe(meta.widths![0]); // 破壊防止のコピー
  });

  it('widths 未指定・点数不一致・非有限・0 以下は meta.width の一様配列', () => {
    expect(normalizedWidths({ branches, width: 7 }, 0)).toEqual([7, 7]);
    expect(normalizedWidths({ branches, width: 7, widths: [[3]] }, 0)).toEqual([7, 7]);
    expect(normalizedWidths({ branches, width: 7, widths: [[3, NaN]] }, 0)).toEqual([7, 7]);
    expect(normalizedWidths({ branches, width: 7, widths: [[3, Infinity]] }, 0)).toEqual([7, 7]);
    expect(normalizedWidths({ branches, width: 7, widths: [[3, 0]] }, 0)).toEqual([7, 7]);
    expect(normalizedWidths({ branches, width: 7, widths: [[3, -1]] }, 0)).toEqual([7, 7]);
  });

  it('存在しない枝 index は空配列', () => {
    expect(normalizedWidths({ branches, width: 7 }, 5)).toEqual([]);
    expect(normalizedWidths({ branches: [], width: 7 }, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lineEndpoints / lineTailTarget / trimLineTail
// ---------------------------------------------------------------------------

describe('lineEndpoints', () => {
  it('幹は両端・枝は自由端のみ（T 字で 3 個）', () => {
    const eps = lineEndpoints({ branches: [TRUNK, BRANCH], width: 10 });
    expect(eps).toHaveLength(3);
    expect(eps.filter((e) => e.branchIndex === 0)).toHaveLength(2);
    expect(eps.some((e) => e.branchIndex === 0 && e.attach === 'start')).toBe(true);
    expect(eps.some((e) => e.branchIndex === 1 && e.attach === 'end' && e.point[0] === 200)).toBe(
      true
    );
  });

  it('空 branches・1 点枝は端点を出さない', () => {
    expect(lineEndpoints({ branches: [], width: 10 })).toEqual([]);
    expect(lineEndpoints({ branches: [[[0, 0]]], width: 10 })).toEqual([]);
    expect(lineEndpoints({ branches: [TRUNK, [[100, 150]]], width: 10 })).toHaveLength(2);
  });
});

describe('lineTailTarget', () => {
  it('最も新しい（最大 index の）有効枝の末尾点を返す', () => {
    const three: Pt[] = [
      [100, 150],
      [200, 150],
      [280, 150],
    ];
    const t = lineTailTarget({ branches: [TRUNK, three], width: 12 });
    expect(t).not.toBeNull();
    expect(t!.branchIndex).toBe(1);
    expect(t!.point).toEqual([280, 150]);
  });

  it('単一枝では幹の末尾点', () => {
    const t = lineTailTarget({ branches: [TRUNK], width: 12 });
    expect(t!.branchIndex).toBe(0);
    expect(t!.point).toEqual([100, 250]);
  });

  it('有効枝（2 点以上）が無ければ null', () => {
    expect(lineTailTarget({ branches: [], width: 10 })).toBeNull();
    expect(lineTailTarget({ branches: [[[0, 0]]], width: 10 })).toBeNull();
  });

  it('末尾の枝が 1 点なら 1 つ前の有効枝が対象', () => {
    const t = lineTailTarget({ branches: [TRUNK, [[100, 150]]], width: 12 });
    expect(t!.branchIndex).toBe(0);
    expect(t!.point).toEqual([100, 250]);
  });
});

describe('trimLineTail', () => {
  it('単一枝・可変幅で末尾 1 点を削り widths も平行に縮む', () => {
    const line: Pt[] = [
      [100, 100],
      [100, 200],
      [100, 300],
      [100, 400],
    ];
    const meta: LineMeta = { branches: [line], width: 10, widths: [[6, 8, 12, 16]] };
    const r = trimLineTail(meta);
    expect(r.branches).toHaveLength(1);
    expect(r.branches[0]).toHaveLength(3);
    expect(r.widths[0]).toEqual([6, 8, 12]);
    // 元の meta は破壊されない
    expect(meta.branches[0]).toHaveLength(4);
    // 削った末尾はポリゴンに残らない
    const poly = regenLinePolygon(
      { branches: r.branches, width: 10, widths: r.widths },
      640,
      640
    );
    expect(poly.length).toBeGreaterThanOrEqual(3);
    expect(pointInPolygon([100, 400], poly)).toBe(false);
  });

  it('widths 未指定なら meta.width の一様配列が同期して返る', () => {
    const r = trimLineTail({
      branches: [
        [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      ],
      width: 8,
    });
    expect(r.branches[0]).toHaveLength(2);
    expect(r.widths[0]).toEqual([8, 8]);
  });

  it('分岐があるときは最新枝の末尾から削れる（幹は無傷）', () => {
    const three: Pt[] = [
      [100, 150],
      [200, 150],
      [280, 150],
    ];
    const r = trimLineTail({ branches: [TRUNK, three], width: 12 });
    expect(r.branches).toHaveLength(2);
    expect(r.branches[0]).toHaveLength(2);
    expect(r.branches[1]).toHaveLength(2);
    expect(r.branches[1][1]).toEqual([200, 150]);
  });

  it('2 点の枝は枝ごと削除され、幹は残る', () => {
    const r = trimLineTail({ branches: [TRUNK, BRANCH], width: 12 });
    expect(r.branches).toHaveLength(1);
    expect(r.branches[0]).toEqual(TRUNK);
    expect(r.widths).toHaveLength(1);
  });

  it('幹が 2 点未満になるとライン全体が消滅する', () => {
    const r = trimLineTail({ branches: [TRUNK], width: 10 });
    expect(r.branches).toEqual([]);
    expect(r.widths).toEqual([]);
  });

  it('有効枝が無い meta は空を返す', () => {
    expect(trimLineTail({ branches: [], width: 10 })).toEqual({ branches: [], widths: [] });
    expect(trimLineTail({ branches: [[[0, 0]]], width: 10 })).toEqual({ branches: [], widths: [] });
  });

  it('末尾削除で切り離された枝は index 同期で除去される（多段分岐）', () => {
    const trunk: Pt[] = [
      [0, 0],
      [100, 0],
    ];
    // index 1 は index 2 の下端にぶら下がる多段分岐
    const hanging: Pt[] = [
      [50, 95],
      [120, 95],
    ];
    const stem: Pt[] = [
      [50, 0],
      [50, 50],
      [50, 100],
    ];
    const meta: LineMeta = {
      branches: [trunk, hanging, stem],
      width: 10,
      widths: [
        [10, 10],
        [4, 4],
        [8, 8, 8],
      ],
    };
    // 削除対象は最大 index の stem 末尾。stem が y=50 までに縮むと hanging は宙に浮く
    expect(lineTailTarget(meta)!.branchIndex).toBe(2);
    const r = trimLineTail(meta);
    expect(r.branches).toHaveLength(2);
    expect(r.branches[0]).toEqual(trunk);
    expect(r.branches[1]).toEqual([
      [50, 0],
      [50, 50],
    ]);
    // widths も同じ index で同期して落ちる（hanging の [4,4] が消える）
    expect(r.widths).toEqual([
      [10, 10],
      [8, 8],
    ]);
  });
});

// ---------------------------------------------------------------------------
// connectedBranchIndices / filterConnectedBranches
// ---------------------------------------------------------------------------

describe('connectedBranchIndices', () => {
  const trunk: Pt[] = [
    [0, 0],
    [100, 0],
  ];

  it('孤立枝を除去し、多段（枝に付いた枝）は維持する', () => {
    const attached: Pt[] = [
      [50, 0],
      [50, 60],
    ];
    const orphan: Pt[] = [
      [300, 300],
      [350, 350],
    ];
    const multi: Pt[] = [
      [50, 55],
      [120, 55],
    ];
    const idx = connectedBranchIndices([trunk, attached, orphan, multi], 10);
    expect(idx).toEqual([0, 1, 3]); // 昇順・orphan(2) を除去
  });

  it('連結判定の許容距離は width に依存する', () => {
    // tol = max(width/2, 3) + 1
    const near: Pt[] = [
      [50, 5],
      [50, 60],
    ];
    expect(connectedBranchIndices([trunk, near], 10)).toEqual([0, 1]); // tol=6 > 5
    expect(connectedBranchIndices([trunk, near], 2)).toEqual([0]); // tol=4 < 5
    const far: Pt[] = [
      [50, 20],
      [50, 60],
    ];
    expect(connectedBranchIndices([trunk, far], 10)).toEqual([0]);
  });

  it('空・単一枝はそのまま全 index を返す', () => {
    expect(connectedBranchIndices([], 10)).toEqual([]);
    expect(connectedBranchIndices([trunk], 10)).toEqual([0]);
  });

  it('1 点しか無い枝は連結扱いにならない', () => {
    expect(connectedBranchIndices([trunk, [[50, 0]]], 10)).toEqual([0]);
  });

  it('filterConnectedBranches は index 版と同じ枝を返す', () => {
    const attached: Pt[] = [
      [50, 0],
      [50, 60],
    ];
    const orphan: Pt[] = [
      [300, 300],
      [350, 350],
    ];
    const branches = [trunk, attached, orphan];
    expect(filterConnectedBranches(branches, 10)).toEqual(
      connectedBranchIndices(branches, 10).map((i) => branches[i])
    );
    expect(filterConnectedBranches(branches, 10)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// nearestOnBranches
// ---------------------------------------------------------------------------

describe('nearestOnBranches', () => {
  const branches: Pt[][] = [
    [
      [0, 0],
      [100, 0],
    ],
    [
      [50, 0],
      [50, 80],
    ],
  ];

  it('最も近い枝・セグメント・最近点を返す', () => {
    const r = nearestOnBranches(branches, [52, 40]);
    expect(r).not.toBeNull();
    expect(r!.branchIndex).toBe(1);
    expect(r!.segIndex).toBe(0);
    expect(r!.point[0]).toBeCloseTo(50, 9);
    expect(r!.point[1]).toBeCloseTo(40, 9);
    expect(r!.dist).toBeCloseTo(2, 9);
    expect(r!.t).toBeCloseTo(0.5, 9);
  });

  it('幹に近い点では branchIndex=0 を返す', () => {
    const r = nearestOnBranches(branches, [10, 3]);
    expect(r!.branchIndex).toBe(0);
    expect(r!.dist).toBeCloseTo(3, 9);
  });

  it('セグメントの無い入力（空・1 点枝）は null', () => {
    expect(nearestOnBranches([], [0, 0])).toBeNull();
    expect(nearestOnBranches([[[0, 0]]], [5, 5])).toBeNull();
  });
});
