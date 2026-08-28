// =============================================================================
// M6: COCO 出力の検証。
// スキーマは参照実装の build_coco() 互換（images / annotations / categories）。
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { CocoDataset } from '../src/core/export/coco';
import { buildExportPlan } from '../src/core/export/planner';
import type { ExportPlan } from '../src/core/export/plan';
import type {
  Annotation,
  AnnotationStatus,
  ClassDef,
  ExportImageInput,
  ExportParams,
  Pt,
} from '../src/core/types';

const CLASSES: ClassDef[] = [
  { id: 0, name: 'crack', nameJa: 'ひび割れ', color: '#E6002D' },
  { id: 4, name: 'pothole', nameJa: 'ポットホール', color: '#0075C2' },
];

function params(over: Partial<ExportParams> = {}): ExportParams {
  return {
    format: 'coco',
    scope: 'done',
    valRatio: 0,
    seed: 3,
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
function image(
  file: string,
  annotations: Annotation[],
  status: AnnotationStatus = 'done',
): ExportImageInput {
  return { file, width: 200, height: 100, status, annotations };
}
function coco(plan: ExportPlan, split: 'train' | 'val'): CocoDataset {
  const f = plan.textFiles.find((t) => t.relPath === `annotations/${split}.json`);
  expect(f, `annotations/${split}.json が無い`).toBeDefined();
  return JSON.parse(f?.content as string) as CocoDataset;
}

describe('COCO スキーマ', () => {
  const tri: Pt[] = [
    [10, 10],
    [50, 10],
    [10, 50],
  ];
  const plan = buildExportPlan(
    [image('a.jpg', [poly(0, tri), bbox(4, 100, 20, 40, 30)])],
    params(),
    CLASSES,
  );
  const ds = coco(plan, 'train');

  it('train / val の 2 本を必ず出す（val が空でも）', () => {
    expect(plan.textFiles.map((f) => f.relPath).sort()).toEqual([
      'annotations/train.json',
      'annotations/val.json',
    ]);
    const val = coco(plan, 'val');
    expect(val.images).toEqual([]);
    expect(val.annotations).toEqual([]);
    expect(val.categories).toHaveLength(2);
  });

  it('images は { id, file_name, width, height }（id は 1 始まり）', () => {
    expect(ds.images).toEqual([{ id: 1, file_name: 'a.jpg', width: 200, height: 100 }]);
  });

  it('categories は 0 始まり id + supercategory=genba-anno（リマップ後）', () => {
    expect(ds.categories).toEqual([
      { id: 0, name: 'crack', supercategory: 'genba-anno' },
      { id: 1, name: 'pothole', supercategory: 'genba-anno' },
    ]);
  });

  it('annotations のキーが揃っている', () => {
    expect(Object.keys(ds.annotations[0]).sort()).toEqual([
      'area',
      'bbox',
      'category_id',
      'id',
      'image_id',
      'iscrowd',
      'segmentation',
    ]);
    expect(ds.annotations.map((a) => a.id)).toEqual([1, 2]);
    expect(ds.annotations.every((a) => a.image_id === 1)).toBe(true);
    expect(ds.annotations.every((a) => a.iscrowd === 0)).toBe(true);
  });

  it('polygon: segmentation は flat 1 本・area は shoelace・bbox は外接矩形', () => {
    const a = ds.annotations[0];
    expect(a.category_id).toBe(0);
    expect(a.segmentation).toEqual([[10, 10, 50, 10, 10, 50]]);
    expect(a.bbox).toEqual([10, 10, 40, 40]);
    expect(a.area).toBe(800); // 40*40/2
  });

  it('bbox kind: segmentation は空・area は w*h', () => {
    const a = ds.annotations[1];
    expect(a.category_id).toBe(1); // class 4 → 1
    expect(a.segmentation).toEqual([]);
    expect(a.bbox).toEqual([100, 20, 40, 30]);
    expect(a.area).toBe(1200);
  });

  it('JSON として往復できる（余計な undefined を含まない）', () => {
    const f = plan.textFiles.find((t) => t.relPath === 'annotations/train.json');
    expect(typeof f?.content).toBe('string');
    expect(() => JSON.parse(f?.content as string)).not.toThrow();
    expect(f?.content as string).not.toContain('undefined');
  });
});

describe('COCO の id 採番と split', () => {
  it('image_id / annotation id は split ごとに 1 から振り直す', () => {
    const images = Array.from({ length: 20 }, (_, i) =>
      image(`IMG_${String(i).padStart(2, '0')}.jpg`, [bbox(0, 10, 10, 20, 20)]),
    );
    const plan = buildExportPlan(images, params({ valRatio: 0.4 }), CLASSES);
    for (const split of ['train', 'val'] as const) {
      const ds = coco(plan, split);
      expect(ds.images.map((i) => i.id)).toEqual(ds.images.map((_, i) => i + 1));
      expect(ds.annotations.map((a) => a.id)).toEqual(ds.annotations.map((_, i) => i + 1));
      for (const img of ds.images) expect(plan.manifest.split[img.file_name]).toBe(split);
    }
    const total = coco(plan, 'train').images.length + coco(plan, 'val').images.length;
    expect(total).toBe(20);
  });

  it('負例（done で 0 件）は images に載り annotations には載らない', () => {
    const plan = buildExportPlan(
      [image('neg.jpg', []), image('pos.jpg', [bbox(0, 10, 10, 20, 20)])],
      params(),
      CLASSES,
    );
    const ds = coco(plan, 'train');
    expect(ds.images.map((i) => i.file_name)).toEqual(['neg.jpg', 'pos.jpg']);
    expect(ds.annotations).toHaveLength(1);
    expect(ds.annotations[0].image_id).toBe(2);
  });

  it('座標は画像内にクランプされて出力される', () => {
    const plan = buildExportPlan(
      [
        image('a.jpg', [
          poly(0, [
            [-50, -50],
            [500, -50],
            [500, 500],
          ]),
        ]),
      ],
      params(),
      CLASSES,
    );
    const a = coco(plan, 'train').annotations[0];
    expect(a.segmentation).toEqual([[0, 0, 200, 0, 200, 100]]);
    expect(a.bbox).toEqual([0, 0, 200, 100]);
  });
});
