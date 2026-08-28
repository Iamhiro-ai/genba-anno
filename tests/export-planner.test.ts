// =============================================================================
// M6: エクスポートプランナ（scope / 負例 / 面積フィルタ / クラス ID リマップ /
// 名前衝突）の検証。参照実装の事故防止策がそのまま効いているかを固定する。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { buildExportPlan, fileStem } from '../src/core/export/planner';
import { MAX_EXPORT_IMAGE_PIXELS } from '../src/core/export/plan';
import type { ExportPlan } from '../src/core/export/plan';
import type {
  Annotation,
  AnnotationStatus,
  ClassDef,
  ExportImageInput,
  ExportParams,
  Pt,
} from '../src/core/types';

// --- フィクスチャ -----------------------------------------------------------

/** id に歯抜けがあるクラス定義（リマップ検証用） */
const CLASSES: ClassDef[] = [
  { id: 0, name: 'crack', nameJa: 'ひび割れ', color: '#E6002D' },
  { id: 3, name: 'pothole', nameJa: 'ポットホール', color: '#0075C2' },
  { id: 7, name: 'patch', nameJa: '補修跡', color: '#00A040' },
];

function params(over: Partial<ExportParams> = {}): ExportParams {
  return {
    format: 'yolo_det',
    scope: 'done',
    valRatio: 0,
    seed: 42,
    includeDerivedBoxes: true,
    includeBBoxAsPolygon: false,
    ...over,
  };
}

let seq = 0;
function bbox(classId: number, x: number, y: number, w: number, h: number): Annotation {
  return { id: `a${++seq}`, classId, source: 'manual', kind: 'bbox', box: { x, y, w, h } };
}
function poly(classId: number, points: Pt[]): Annotation {
  return { id: `a${++seq}`, classId, source: 'manual', kind: 'polygon', points };
}
function line(classId: number, points: Pt[]): Annotation {
  return {
    id: `a${++seq}`,
    classId,
    source: 'manual',
    kind: 'line',
    points,
    lineMeta: { branches: [[points[0], points[1]]], width: 10 },
  };
}
function square(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}
function image(
  file: string,
  status: AnnotationStatus,
  annotations: Annotation[],
  width = 100,
  height = 100,
): ExportImageInput {
  return { file, width, height, status, annotations };
}

function labelOf(plan: ExportPlan, relPath: string): string | undefined {
  const f = plan.textFiles.find((t) => t.relPath === relPath);
  return typeof f?.content === 'string' ? f.content : undefined;
}
function outputFiles(plan: ExportPlan): string[] {
  return plan.images.map((i) => i.srcFile);
}

// --- scope ------------------------------------------------------------------

describe('scope による対象選択', () => {
  const images = [
    image('done.jpg', 'done', [bbox(0, 10, 10, 20, 20)]),
    image('inprog_with.jpg', 'in_progress', [bbox(0, 10, 10, 20, 20)]),
    image('inprog_empty.jpg', 'in_progress', []),
    image('pending.jpg', 'pending', [bbox(0, 10, 10, 20, 20)]),
    image('skipped.jpg', 'skipped', [bbox(0, 10, 10, 20, 20)]),
  ];

  it("scope='done' は done のみ", () => {
    const plan = buildExportPlan(images, params({ scope: 'done' }), CLASSES);
    expect(outputFiles(plan)).toEqual(['done.jpg']);
  });

  it("scope='all' は done + アノテ 1 件以上の in_progress", () => {
    const plan = buildExportPlan(images, params({ scope: 'all' }), CLASSES);
    expect(outputFiles(plan).sort()).toEqual(['done.jpg', 'inprog_with.jpg']);
  });

  it('pending / skipped はどの scope でも絶対に含まれない', () => {
    for (const scope of ['done', 'all'] as const) {
      const plan = buildExportPlan(images, params({ scope }), CLASSES);
      expect(outputFiles(plan)).not.toContain('pending.jpg');
      expect(outputFiles(plan)).not.toContain('skipped.jpg');
      expect(Object.keys(plan.manifest.split)).not.toContain('pending.jpg');
    }
  });

  it('アノテ 0 件の in_progress は scope=all でも出力しない（誤負例の防止）', () => {
    const plan = buildExportPlan(images, params({ scope: 'all' }), CLASSES);
    expect(outputFiles(plan)).not.toContain('inprog_empty.jpg');
  });
});

// --- 負例 -------------------------------------------------------------------

describe('負例（空ラベル）の扱い', () => {
  it('done かつ 0 件は負例として出力される（空ラベル）', () => {
    const plan = buildExportPlan([image('neg.jpg', 'done', [])], params(), CLASSES);
    expect(outputFiles(plan)).toEqual(['neg.jpg']);
    expect(labelOf(plan, 'labels/train/neg.txt')).toBe('');
    expect(plan.manifest.counts.negatives).toBe(1);
    expect(plan.manifest.counts.annotations_exported).toBe(0);
  });

  it('in_progress は負例になれない', () => {
    const plan = buildExportPlan(
      [image('a.jpg', 'in_progress', [])],
      params({ scope: 'all' }),
      CLASSES,
    );
    expect(plan.images).toHaveLength(0);
    expect(plan.manifest.counts.negatives).toBe(0);
  });

  it('クラスフィルタだけで 0 件になった done は正しい負例（mask_png）', () => {
    const plan = buildExportPlan(
      [image('a.jpg', 'done', [poly(3, square(10, 10, 40, 40))])],
      params({ format: 'mask_png', classFilter: [0] }),
      CLASSES,
    );
    expect(outputFiles(plan)).toEqual(['a.jpg']);
    expect(plan.maskTargets?.[0].polygons).toEqual([]);
    expect(plan.manifest.counts.negatives).toBe(1);
    expect(plan.manifest.excluded.skipped_all_polygons_too_small).toEqual([]);
  });

  it('クラスフィルタで 0 件になった in_progress はスキップ（負例化しない）', () => {
    const plan = buildExportPlan(
      [image('a.jpg', 'in_progress', [poly(3, square(10, 10, 40, 40))])],
      params({ format: 'mask_png', scope: 'all', classFilter: [0] }),
      CLASSES,
    );
    expect(plan.images).toHaveLength(0);
    expect(plan.manifest.excluded_extra.skipped_in_progress_without_annotations).toEqual([
      'a.jpg',
    ]);
  });
});

// --- 面積フィルタ -----------------------------------------------------------

describe('面積 < 2px² の除外と全滅スキップ', () => {
  it('極小ポリゴンだけを除外し manifest に記録する', () => {
    const tiny = poly(0, [
      [1, 1],
      [2, 1],
      [1, 2],
    ]); // 面積 0.5px²
    const big = poly(0, square(10, 10, 40, 40));
    const plan = buildExportPlan([image('a.jpg', 'done', [tiny, big])], params(), CLASSES);
    expect(outputFiles(plan)).toEqual(['a.jpg']);
    expect(plan.manifest.counts.annotations_exported).toBe(1);
    expect(plan.manifest.excluded.tiny_polygons).toEqual([
      { file: 'a.jpg', annotation_id: tiny.id, area: 0.5 },
    ]);
  });

  it('**全滅した画像は負例にせずスキップする**（黙った誤負例の防止）', () => {
    const tiny = poly(0, [
      [1, 1],
      [2, 1],
      [1, 2],
    ]);
    const plan = buildExportPlan([image('a.jpg', 'done', [tiny])], params(), CLASSES);
    expect(plan.images).toHaveLength(0);
    expect(plan.textFiles.map((f) => f.relPath)).toEqual(['data.yaml']);
    expect(plan.manifest.excluded.skipped_all_polygons_too_small).toEqual(['a.jpg']);
    expect(plan.manifest.counts.negatives).toBe(0);
    expect(plan.manifest.split).toEqual({});
  });

  it('潰れた bbox（面積 0）も除外対象', () => {
    const flat = bbox(0, 10, 10, 0, 50);
    const plan = buildExportPlan([image('a.jpg', 'done', [flat])], params(), CLASSES);
    expect(plan.images).toHaveLength(0);
    expect(plan.manifest.excluded.tiny_polygons[0].annotation_id).toBe(flat.id);
  });

  it('クランプで画像外へ出た結果 0 面積になったものも除外', () => {
    const outside = bbox(0, 200, 200, 50, 50); // 100x100 画像の外
    const plan = buildExportPlan([image('a.jpg', 'done', [outside])], params(), CLASSES);
    expect(plan.images).toHaveLength(0);
    expect(plan.manifest.excluded.tiny_polygons).toHaveLength(1);
  });
});

// --- クラス ID リマップ -----------------------------------------------------

describe('クラス ID リマップ（歯抜け id → 0..N-1）', () => {
  it('id 昇順に 0..N-1 を振り、対応表を manifest に残す', () => {
    const plan = buildExportPlan(
      [image('a.jpg', 'done', [bbox(7, 10, 10, 20, 20), bbox(3, 50, 50, 20, 20)])],
      params(),
      CLASSES,
    );
    expect(plan.manifest.class_id_map).toEqual([
      { source_id: 0, export_id: 0, name: 'crack' },
      { source_id: 3, export_id: 1, name: 'pothole' },
      { source_id: 7, export_id: 2, name: 'patch' },
    ]);
    expect(plan.manifest.classes).toEqual([
      { id: 0, name: 'crack' },
      { id: 1, name: 'pothole' },
      { id: 2, name: 'patch' },
    ]);
    const label = labelOf(plan, 'labels/train/a.txt') ?? '';
    const ids = label.trim().split('\n').map((l) => l.split(' ')[0]);
    expect(ids).toEqual(['2', '1']); // class 7→2, class 3→1
  });

  it('data.yaml の nc / names はリマップ後の並びと一致する', () => {
    const plan = buildExportPlan([image('a.jpg', 'done', [])], params(), CLASSES);
    const yaml = labelOf(plan, 'data.yaml') ?? '';
    expect(yaml).toContain('nc: 3');
    expect(yaml).toContain("names: ['crack', 'pothole', 'patch']");
  });

  it('クラス定義に無い class_id のアノテーションは落として記録する', () => {
    const unknown = bbox(99, 10, 10, 20, 20);
    const known = bbox(0, 50, 50, 20, 20);
    const plan = buildExportPlan([image('a.jpg', 'done', [unknown, known])], params(), CLASSES);
    expect(plan.manifest.counts.annotations_exported).toBe(1);
    expect(plan.manifest.excluded_extra.unknown_class_annotations).toEqual([
      { file: 'a.jpg', annotation_id: unknown.id, class_id: 99 },
    ]);
  });

  it('未知クラスで全滅した画像も負例にせずスキップ', () => {
    const plan = buildExportPlan(
      [image('a.jpg', 'done', [bbox(99, 10, 10, 20, 20)])],
      params(),
      CLASSES,
    );
    expect(plan.images).toHaveLength(0);
    expect(plan.manifest.excluded.skipped_all_polygons_too_small).toEqual(['a.jpg']);
  });
});

// --- kind フィルタ ----------------------------------------------------------

describe('フォーマット別の kind 選択', () => {
  const mixed = [bbox(0, 10, 10, 20, 20), poly(0, square(50, 50, 80, 80))];

  it('yolo_det: includeDerivedBoxes=true なら polygon の外接矩形も出す', () => {
    const on = buildExportPlan(
      [image('a.jpg', 'done', mixed)],
      params({ includeDerivedBoxes: true }),
      CLASSES,
    );
    expect(on.manifest.counts.annotations_exported).toBe(2);
    const off = buildExportPlan(
      [image('a.jpg', 'done', mixed)],
      params({ includeDerivedBoxes: false }),
      CLASSES,
    );
    expect(off.manifest.counts.annotations_exported).toBe(1);
  });

  it('yolo_seg: includeBBoxAsPolygon=false なら bbox を出さない', () => {
    const off = buildExportPlan(
      [image('a.jpg', 'done', mixed)],
      params({ format: 'yolo_seg', includeBBoxAsPolygon: false }),
      CLASSES,
    );
    expect(off.manifest.counts.annotations_exported).toBe(1);
    const on = buildExportPlan(
      [image('a.jpg', 'done', mixed)],
      params({ format: 'yolo_seg', includeBBoxAsPolygon: true }),
      CLASSES,
    );
    expect(on.manifest.counts.annotations_exported).toBe(2);
  });

  it('**対象 kind が 1 件も無くなった画像はスキップ**（空ラベル＝偽陰性教師を作らない）', () => {
    const plan = buildExportPlan(
      [image('boxonly.jpg', 'done', [bbox(0, 10, 10, 20, 20)])],
      params({ format: 'yolo_seg', includeBBoxAsPolygon: false }),
      CLASSES,
    );
    expect(plan.images).toHaveLength(0);
    expect(plan.manifest.counts.negatives).toBe(0);
    expect(plan.manifest.excluded_extra.skipped_no_annotations_for_format).toEqual([
      'boxonly.jpg',
    ]);
  });

  it('classFilter=[] は「未指定 = 全クラス」として扱う', () => {
    const plan = buildExportPlan(
      [image('a.jpg', 'done', [poly(3, square(10, 10, 40, 40))])],
      params({ format: 'mask_png', classFilter: [] }),
      CLASSES,
    );
    expect(plan.maskTargets?.[0].polygons).toHaveLength(1);
    expect(plan.manifest.params.class_filter).toBeUndefined();
  });

  it('マスクのポリゴンは画像内へクランプ済みで渡る', () => {
    const plan = buildExportPlan(
      [
        image('a.jpg', 'done', [
          poly(0, [
            [-20, -20],
            [500, -20],
            [500, 500],
          ]),
        ]),
      ],
      params({ format: 'mask_png' }),
      CLASSES,
    );
    expect(plan.maskTargets?.[0].polygons[0]).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
  });

  it('mask_png は bbox を塗らない（line/polygon のみ）', () => {
    const plan = buildExportPlan(
      [image('a.jpg', 'done', [poly(0, square(10, 10, 40, 40)), line(0, square(50, 50, 80, 80))])],
      params({ format: 'mask_png' }),
      CLASSES,
    );
    expect(plan.maskTargets).toHaveLength(1);
    expect(plan.maskTargets?.[0].polygons).toHaveLength(2);
    expect(plan.maskTargets?.[0].destRelPath).toBe('masks/train/a.png');
  });
});

// --- 名前衝突 ---------------------------------------------------------------

describe('ファイル名の衝突検出', () => {
  it('大文字小文字だけ違う画像は後勝ちさせずスキップして記録する', () => {
    const plan = buildExportPlan(
      [
        image('IMG_1.jpg', 'done', [bbox(0, 10, 10, 20, 20)]),
        image('img_1.JPG', 'done', [bbox(0, 10, 10, 20, 20)]),
      ],
      params(),
      CLASSES,
    );
    expect(outputFiles(plan)).toEqual(['IMG_1.jpg']);
    expect(plan.manifest.excluded.name_collisions).toEqual([
      'img_1.JPG (collides with IMG_1.jpg)',
    ]);
  });

  it('拡張子違いの同名（ラベル名が衝突する）もスキップする', () => {
    const plan = buildExportPlan(
      [
        image('a.jpg', 'done', [bbox(0, 10, 10, 20, 20)]),
        image('a.png', 'done', [bbox(0, 10, 10, 20, 20)]),
      ],
      params(),
      CLASSES,
    );
    expect(outputFiles(plan)).toEqual(['a.jpg']);
    expect(plan.manifest.excluded.name_collisions).toEqual(['a.png (collides with a.jpg)']);
    // ラベルファイルも 1 本だけ（上書きが起きない）
    expect(plan.textFiles.filter((f) => f.relPath.endsWith('.txt'))).toHaveLength(1);
  });

  it('coco は画像ごとのラベルを作らないので拡張子違いは衝突しない', () => {
    const plan = buildExportPlan(
      [
        image('a.jpg', 'done', [bbox(0, 10, 10, 20, 20)]),
        image('a.png', 'done', [bbox(0, 10, 10, 20, 20)]),
        image('A.JPG', 'done', [bbox(0, 10, 10, 20, 20)]),
      ],
      params({ format: 'coco' }),
      CLASSES,
    );
    expect(outputFiles(plan)).toEqual(['a.jpg', 'a.png']);
    expect(plan.manifest.excluded.name_collisions).toEqual(['A.JPG (collides with a.jpg)']);
  });
});

// --- split / manifest -------------------------------------------------------

describe('split と manifest', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    image(`IMG_${String(i).padStart(3, '0')}.jpg`, 'done', [bbox(0, 10, 10, 20, 20)]),
  );

  it('全出力画像の所属が manifest.split に載り、counts と一致する', () => {
    const plan = buildExportPlan(many, params({ valRatio: 0.3 }), CLASSES);
    expect(Object.keys(plan.manifest.split).sort()).toEqual(outputFiles(plan).sort());
    const train = Object.values(plan.manifest.split).filter((s) => s === 'train').length;
    const val = Object.values(plan.manifest.split).filter((s) => s === 'val').length;
    expect(plan.manifest.counts.images_train).toBe(train);
    expect(plan.manifest.counts.images_val).toBe(val);
    expect(train + val).toBe(40);
    expect(val).toBeGreaterThan(0);
  });

  it('画像とラベルの出力先が split と一致する', () => {
    const plan = buildExportPlan(many, params({ valRatio: 0.3 }), CLASSES);
    for (const img of plan.images) {
      expect(img.destRelPath).toBe(`images/${plan.manifest.split[img.srcFile]}/${img.srcFile}`);
      const stem = fileStem(img.srcFile);
      expect(plan.textFiles.some((f) => f.relPath === `labels/${img.split}/${stem}.txt`)).toBe(
        true,
      );
    }
  });

  it('val が 0 枚のときは data.yaml の val を train に向ける（学習が落ちないように）', () => {
    const zero = buildExportPlan(many, params({ valRatio: 0 }), CLASSES);
    expect(labelOf(zero, 'data.yaml')).toContain('val: images/train');
    const some = buildExportPlan(many, params({ valRatio: 0.3 }), CLASSES);
    expect(labelOf(some, 'data.yaml')).toContain('val: images/val');
  });

  it('manifest.params にエクスポート条件が残る', () => {
    const plan = buildExportPlan(many, params({ valRatio: 0.25, seed: 7 }), CLASSES, {
      now: '2026-08-28T00:00:00.000Z',
    });
    expect(plan.manifest.app).toBe('genba-anno');
    expect(plan.manifest.exported_at).toBe('2026-08-28T00:00:00.000Z');
    expect(plan.manifest.params).toMatchObject({
      format: 'yolo_det',
      scope: 'done',
      val_ratio: 0.25,
      seed: 7,
      include_derived_boxes: true,
    });
  });

  it('mask_png のときだけ class_filter が params に載る', () => {
    const plan = buildExportPlan(
      [image('a.jpg', 'done', [poly(0, square(10, 10, 40, 40))])],
      params({ format: 'mask_png', classFilter: [7, 0] }),
      CLASSES,
    );
    expect(plan.manifest.params.class_filter).toEqual([0, 7]);
  });

  it('missingFiles オプションが manifest に記録される（runner の再プラン用）', () => {
    const plan = buildExportPlan(many.slice(0, 3), params(), CLASSES, {
      missingFiles: ['gone.jpg'],
    });
    expect(plan.manifest.excluded.missing_files).toEqual(['gone.jpg']);
  });

  it('width/height が不正な画像は出力せず、理由付きで記録する', () => {
    const bad = image('bad.jpg', 'done', [bbox(0, 10, 10, 20, 20)], 0, 100);
    const plan = buildExportPlan([bad], params(), CLASSES);
    expect(plan.images).toHaveLength(0);
    expect(plan.manifest.excluded_extra.invalid_dimensions).toEqual([
      'bad.jpg (invalid size: 0x100)',
    ]);
  });

  it('壊れたサイドカーとサイドカー警告が manifest に残る', () => {
    const plan = buildExportPlan([image('ok.jpg', 'done', [])], params(), CLASSES, {
      corruptSidecars: ['broken.jpg.json', 'trunc.jpg.json'],
      sidecarWarnings: [
        { file: 'ok.jpg', warnings: ['points が不正なレコードを 1 件捨てました'] },
        { file: 'quiet.jpg', warnings: [] }, // 警告が空のものは載せない
      ],
    });
    expect(plan.manifest.excluded_extra.corrupt_sidecars).toEqual([
      'broken.jpg.json',
      'trunc.jpg.json',
    ]);
    expect(plan.manifest.excluded_extra.sidecar_warnings).toEqual([
      { file: 'ok.jpg', warnings: ['points が不正なレコードを 1 件捨てました'] },
    ]);
  });

  it('壊れサイドカー記録は再プラン（画像欠損）でも引き継げる', () => {
    const opts = { corruptSidecars: ['broken.jpg.json'], sidecarWarnings: [] };
    const plan = buildExportPlan([image('ok.jpg', 'done', [])], params(), CLASSES, {
      ...opts,
      missingFiles: ['gone.jpg'],
    });
    expect(plan.manifest.excluded_extra.corrupt_sidecars).toEqual(['broken.jpg.json']);
    expect(plan.manifest.excluded.missing_files).toEqual(['gone.jpg']);
  });

  it('指定が無ければ corrupt_sidecars / sidecar_warnings は空配列', () => {
    const plan = buildExportPlan([image('ok.jpg', 'done', [])], params(), CLASSES);
    expect(plan.manifest.excluded_extra.corrupt_sidecars).toEqual([]);
    expect(plan.manifest.excluded_extra.sidecar_warnings).toEqual([]);
  });

  it('巨大すぎる寸法（壊れたサイドカー）はスキップして記録する', () => {
    const huge = image('huge.jpg', 'done', [bbox(0, 10, 10, 20, 20)], 1_000_000, 1_000_000);
    const plan = buildExportPlan([huge], params({ format: 'mask_png' }), CLASSES);
    expect(plan.images).toHaveLength(0);
    expect(plan.maskTargets).toEqual([]);
    expect(plan.manifest.excluded_extra.invalid_dimensions).toEqual([
      `huge.jpg (too large: 1000000x1000000 > ${MAX_EXPORT_IMAGE_PIXELS}px)`,
    ]);
    expect(plan.manifest.counts.negatives).toBe(0);
  });

  it('上限ちょうど（2^27 px）は通す', () => {
    const edge = image('edge.jpg', 'done', [bbox(0, 10, 10, 20, 20)], 1 << 14, 1 << 13);
    expect(edge.width * edge.height).toBe(MAX_EXPORT_IMAGE_PIXELS);
    const plan = buildExportPlan([edge], params(), CLASSES);
    expect(plan.images).toHaveLength(1);
    expect(plan.manifest.excluded_extra.invalid_dimensions).toEqual([]);
  });

  it('非整数・非有限の寸法もスキップする（NaN / Infinity / 小数）', () => {
    const cases: [string, number, number][] = [
      ['nan.jpg', Number.NaN, 100],
      ['inf.jpg', Number.POSITIVE_INFINITY, 100],
      ['frac.jpg', 100.5, 100],
      ['neg.jpg', -100, 100],
    ];
    for (const [file, w, h] of cases) {
      const plan = buildExportPlan(
        [image(file, 'done', [bbox(0, 10, 10, 20, 20)], w, h)],
        params(),
        CLASSES,
      );
      expect(plan.images, file).toHaveLength(0);
      expect(plan.manifest.excluded_extra.invalid_dimensions[0]).toContain(file);
    }
  });

  it('同じ入力なら何度呼んでも同じプランになる（決定性）', () => {
    const a = buildExportPlan(many, params({ valRatio: 0.3 }), CLASSES, { now: 'T' });
    const b = buildExportPlan(many, params({ valRatio: 0.3 }), CLASSES, { now: 'T' });
    expect(JSON.stringify(b.manifest)).toBe(JSON.stringify(a.manifest));
    expect(b.textFiles).toEqual(a.textFiles);
  });
});

// --- 出力レイアウト全体 -----------------------------------------------------

describe('フォーマット別の出力レイアウト', () => {
  const images = [
    image('IMG_A.jpg', 'done', [bbox(0, 10, 10, 30, 30), poly(3, square(40, 40, 70, 70))]),
    image('IMG_B.jpg', 'done', [line(0, square(10, 10, 60, 20))]),
  ];
  /** 実際に出力されるパス一覧（画像・テキスト・マスク・マニフェスト） */
  function layout(over: Partial<ExportParams>): string[] {
    const plan = buildExportPlan(images, params(over), CLASSES);
    return [
      ...plan.images.map((i) => i.destRelPath),
      ...plan.textFiles.map((f) => f.relPath),
      ...(plan.maskTargets ?? []).map((m) => m.destRelPath),
      'export_manifest.json', // runner が最後に書く
    ].sort();
  }

  it('yolo_det: images/ + labels/ + data.yaml', () => {
    expect(layout({ format: 'yolo_det' })).toEqual([
      'data.yaml',
      'export_manifest.json',
      'images/train/IMG_A.jpg',
      'images/train/IMG_B.jpg',
      'labels/train/IMG_A.txt',
      'labels/train/IMG_B.txt',
    ]);
  });

  it('yolo_seg: 同じ構成（ラベルの中身だけが違う）', () => {
    expect(layout({ format: 'yolo_seg' })).toEqual([
      'data.yaml',
      'export_manifest.json',
      'images/train/IMG_A.jpg',
      'images/train/IMG_B.jpg',
      'labels/train/IMG_A.txt',
      'labels/train/IMG_B.txt',
    ]);
  });

  it('coco: images/ + annotations/{train,val}.json', () => {
    expect(layout({ format: 'coco' })).toEqual([
      'annotations/train.json',
      'annotations/val.json',
      'export_manifest.json',
      'images/train/IMG_A.jpg',
      'images/train/IMG_B.jpg',
    ]);
  });

  it('mask_png: images/ + masks/（data.yaml は出さない）', () => {
    expect(layout({ format: 'mask_png' })).toEqual([
      'export_manifest.json',
      'images/train/IMG_A.jpg',
      'images/train/IMG_B.jpg',
      'masks/train/IMG_A.png',
      'masks/train/IMG_B.png',
    ]);
  });

  it('val 分割があると train/val 両方のフォルダへ振り分ける', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      image(`IMG_${String(i).padStart(2, '0')}.jpg`, 'done', [bbox(0, 10, 10, 20, 20)]),
    );
    const plan = buildExportPlan(many, params({ valRatio: 0.5 }), CLASSES);
    const dirs = new Set(plan.images.map((i) => i.destRelPath.split('/').slice(0, 2).join('/')));
    expect([...dirs].sort()).toEqual(['images/train', 'images/val']);
    const labelDirs = new Set(
      plan.textFiles
        .filter((f) => f.relPath.endsWith('.txt'))
        .map((f) => f.relPath.split('/').slice(0, 2).join('/')),
    );
    expect([...labelDirs].sort()).toEqual(['labels/train', 'labels/val']);
  });
});

describe('fileStem', () => {
  it('拡張子だけを落とす', () => {
    expect(fileStem('IMG_0001.jpg')).toBe('IMG_0001');
    expect(fileStem('a.b.c.png')).toBe('a.b.c');
    expect(fileStem('noext')).toBe('noext');
    expect(fileStem('.hidden')).toBe('.hidden');
    expect(fileStem('現場_01.JPEG')).toBe('現場_01');
  });
});
