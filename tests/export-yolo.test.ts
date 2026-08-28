// =============================================================================
// M6: yolo_det / yolo_seg のラベル行と data.yaml の検証。
// 正規化・クランプ・6 桁固定は参照実装（_yolo_label_lines）と同じ挙動にする。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { buildExportPlan } from '../src/core/export/planner';
import type { ExportPlan } from '../src/core/export/plan';
import { buildDataYaml, norm } from '../src/core/export/yoloCommon';
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
  { id: 5, name: 'pothole', nameJa: 'ポットホール', color: '#0075C2' },
];

function params(over: Partial<ExportParams> = {}): ExportParams {
  return {
    format: 'yolo_det',
    scope: 'done',
    valRatio: 0,
    seed: 1,
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
  annotations: Annotation[],
  width = 100,
  height = 100,
  status: AnnotationStatus = 'done',
): ExportImageInput {
  return { file: 'a.jpg', width, height, status, annotations };
}
/** labels/train/a.txt の中身を行配列で返す */
function labelLines(plan: ExportPlan): string[] {
  const f = plan.textFiles.find((t) => t.relPath === 'labels/train/a.txt');
  const content = typeof f?.content === 'string' ? f.content : '';
  return content === '' ? [] : content.replace(/\n$/, '').split('\n');
}

describe('norm（正規化 + 6 桁）', () => {
  it('0..1 にクランプして 6 桁固定小数にする', () => {
    expect(norm(50, 100)).toBe('0.500000');
    expect(norm(-10, 100)).toBe('0.000000');
    expect(norm(150, 100)).toBe('1.000000');
    expect(norm(100 / 3, 100)).toBe('0.333333');
    expect(norm(Number.NaN, 100)).toBe('0.000000');
    expect(norm(10, 0)).toBe('0.000000');
    expect(norm(-0, 100)).toBe('0.000000'); // -0.000000 を出さない
  });
});

describe('yolo_det ラベル', () => {
  it('class cx cy w h（正規化・6 桁）を出力する', () => {
    const plan = buildExportPlan([image([bbox(0, 10, 20, 30, 40)])], params(), CLASSES);
    expect(labelLines(plan)).toEqual(['0 0.250000 0.400000 0.300000 0.400000']);
  });

  it('画像外へはみ出した bbox は画像端で切り詰める（平行移動しない）', () => {
    const plan = buildExportPlan([image([bbox(0, -10, -10, 30, 30)])], params(), CLASSES);
    // x,y ∈ [0,20] に切り詰め → cx=cy=0.1, w=h=0.2
    expect(labelLines(plan)).toEqual(['0 0.100000 0.100000 0.200000 0.200000']);
  });

  it('非正方形の画像でも幅と高さで別々に正規化する', () => {
    const plan = buildExportPlan([image([bbox(0, 100, 50, 200, 100)], 400, 200)], params(), CLASSES);
    expect(labelLines(plan)).toEqual(['0 0.500000 0.500000 0.500000 0.500000']);
  });

  it('includeDerivedBoxes=true なら polygon の外接矩形を出す', () => {
    const tri: Pt[] = [
      [10, 10],
      [50, 10],
      [30, 50],
    ];
    const on = buildExportPlan([image([poly(0, tri)])], params(), CLASSES);
    expect(labelLines(on)).toEqual(['0 0.300000 0.300000 0.400000 0.400000']);
    const off = buildExportPlan(
      [image([poly(0, tri), bbox(0, 0, 0, 10, 10)])],
      params({ includeDerivedBoxes: false }),
      CLASSES,
    );
    expect(labelLines(off)).toEqual(['0 0.050000 0.050000 0.100000 0.100000']);
  });

  it('リマップ後のクラス ID が行頭に出る（id 5 → 1）', () => {
    const plan = buildExportPlan([image([bbox(5, 10, 20, 30, 40)])], params(), CLASSES);
    expect(labelLines(plan)[0].startsWith('1 ')).toBe(true);
  });

  it('負例は 0 バイトのラベルファイル', () => {
    const plan = buildExportPlan([image([])], params(), CLASSES);
    const f = plan.textFiles.find((t) => t.relPath === 'labels/train/a.txt');
    expect(f?.content).toBe('');
  });

  it('ラベル行は末尾改行 1 つで終わる', () => {
    const plan = buildExportPlan([image([bbox(0, 10, 20, 30, 40)])], params(), CLASSES);
    const f = plan.textFiles.find((t) => t.relPath === 'labels/train/a.txt');
    expect(f?.content).toBe('0 0.250000 0.400000 0.300000 0.400000\n');
  });
});

describe('yolo_seg ラベル', () => {
  const segParams = (over: Partial<ExportParams> = {}) =>
    params({ format: 'yolo_seg', ...over });

  it('class x1 y1 x2 y2 ...（正規化・6 桁）を出力する', () => {
    const plan = buildExportPlan(
      [
        image([
          poly(0, [
            [10, 20],
            [30, 20],
            [30, 40],
            [10, 40],
          ]),
        ]),
      ],
      segParams(),
      CLASSES,
    );
    expect(labelLines(plan)).toEqual([
      '0 0.100000 0.200000 0.300000 0.200000 0.300000 0.400000 0.100000 0.400000',
    ]);
  });

  it('画像外の頂点は 0..1 にクランプされる', () => {
    const plan = buildExportPlan(
      [
        image([
          poly(0, [
            [-50, -50],
            [150, -50],
            [150, 150],
            [-50, 150],
          ]),
        ]),
      ],
      segParams(),
      CLASSES,
    );
    expect(labelLines(plan)).toEqual([
      '0 0.000000 0.000000 1.000000 0.000000 1.000000 1.000000 0.000000 1.000000',
    ]);
  });

  it('includeBBoxAsPolygon=true で bbox が矩形 4 点ポリゴンになる', () => {
    const plan = buildExportPlan(
      [image([bbox(0, 10, 20, 20, 20)])],
      segParams({ includeBBoxAsPolygon: true }),
      CLASSES,
    );
    // 左上→右上→右下→左下
    expect(labelLines(plan)).toEqual([
      '0 0.100000 0.200000 0.300000 0.200000 0.300000 0.400000 0.100000 0.400000',
    ]);
  });

  it('line（リボンポリゴン）も polygon と同じ形式で出る', () => {
    const ribbon: Pt[] = [
      [10, 10],
      [60, 10],
      [60, 20],
      [10, 20],
    ];
    const plan = buildExportPlan(
      [
        image([
          {
            id: 'L1',
            classId: 0,
            source: 'manual',
            kind: 'line',
            points: ribbon,
            lineMeta: { branches: [[[10, 15] as Pt, [60, 15] as Pt]], width: 10 },
          },
        ]),
      ],
      segParams(),
      CLASSES,
    );
    expect(labelLines(plan)).toEqual([
      '0 0.100000 0.100000 0.600000 0.100000 0.600000 0.200000 0.100000 0.200000',
    ]);
  });
});

describe('data.yaml', () => {
  it('path: キーを書かない（ultralytics の datasets_dir 解決の罠）', () => {
    const yaml = buildDataYaml(
      [
        { sourceId: 0, exportId: 0, name: 'crack' },
        { sourceId: 5, exportId: 1, name: 'pothole' },
      ],
      'yolo_det',
      true,
    );
    expect(yaml).not.toMatch(/^path:/m);
    expect(yaml).toContain('train: images/train');
    expect(yaml).toContain('val: images/val');
    expect(yaml).toContain('nc: 2');
    expect(yaml).toContain("names: ['crack', 'pothole']");
    expect(yaml.endsWith('\n')).toBe(true);
  });

  it('クラス名のシングルクォートを YAML 流にエスケープする', () => {
    const yaml = buildDataYaml([{ sourceId: 0, exportId: 0, name: "man's crack" }], 'yolo_seg', true);
    expect(yaml).toContain("names: ['man''s crack']");
  });

  it('クラス 0 件でも nc: 0 で壊れない', () => {
    const yaml = buildDataYaml([], 'yolo_det', false);
    expect(yaml).toContain('nc: 0');
    expect(yaml).toContain('names: []');
  });
});
