// =============================================================================
// M2: ディスク形式 ⇔ 内部型の変換テスト（core/serialize.ts）。
// 重点は「ラウンドトリップの同値性」と「壊れた JSON で全損しないこと」。
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { Annotation, LineAnnotation, PolygonAnnotation, Project } from '../src/core/types';
import {
  DEFAULT_CLASS_COLORS,
  LINE_WIDTH_MAX,
  LINE_WIDTH_MIN,
  PROJECT_SCHEMA_VERSION,
  SIDECAR_SCHEMA_VERSION,
} from '../src/core/types';
import {
  annotationsToSidecar,
  createDefaultProject,
  jsonToProject,
  projectToJson,
  sidecarToAnnotations,
} from '../src/core/serialize';

const IMAGE = { file: 'IMG_0001.jpg', width: 1000, height: 800 };

const BBOX: Annotation = {
  id: 'a-bbox',
  classId: 0,
  source: 'manual',
  kind: 'bbox',
  box: { x: 10.5, y: 20, w: 100, h: 50.25 },
};

const POLY: Annotation = {
  id: 'a-poly',
  classId: 1,
  source: 'imported',
  kind: 'polygon',
  points: [
    [10, 10],
    [200, 10],
    [100, 120.5],
  ],
};

const LINE: LineAnnotation = {
  id: 'a-line',
  classId: 0,
  source: 'manual',
  kind: 'line',
  points: [
    [100, 94],
    [300, 94],
    [300, 106],
    [100, 106],
  ],
  lineMeta: {
    branches: [
      [
        [100, 100],
        [300, 100],
      ],
      [
        [200, 100],
        [200, 250],
      ],
    ],
    width: 12,
    widths: [
      [10, 14],
      [12, 8],
    ],
  },
};

/** JSON.parse(JSON.stringify(x)) を通して「実際にディスクを往復した」状態にする */
function viaJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------

describe('annotationsToSidecar（内部型 → snake_case）', () => {
  it('schema_version / image / status / updated_at を付与する', () => {
    const s = annotationsToSidecar([], IMAGE, 'in_progress');
    expect(s.schema_version).toBe(SIDECAR_SCHEMA_VERSION);
    expect(s.image).toEqual(IMAGE);
    expect(s.status).toBe('in_progress');
    expect(s.annotations).toEqual([]);
    expect(Number.isNaN(Date.parse(s.updated_at))).toBe(false);
  });

  it('updated_at は明示指定できる（テスト・再現保存用）', () => {
    const s = annotationsToSidecar([], IMAGE, 'done', '2026-01-02T03:04:05.000Z');
    expect(s.updated_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('kind ごとに box / points / line_meta を snake_case で書き出す', () => {
    const s = annotationsToSidecar([BBOX, POLY, LINE], IMAGE, 'done');
    expect(s.annotations[0]).toEqual({
      id: 'a-bbox',
      class_id: 0,
      kind: 'bbox',
      source: 'manual',
      box: { x: 10.5, y: 20, w: 100, h: 50.25 },
    });
    expect(s.annotations[1]).toEqual({
      id: 'a-poly',
      class_id: 1,
      kind: 'polygon',
      source: 'imported',
      points: POLY.kind === 'polygon' ? POLY.points : [],
    });
    expect(s.annotations[2].line_meta).toEqual({
      branches: LINE.lineMeta.branches,
      width: 12,
      widths: LINE.lineMeta.widths,
    });
    expect(s.annotations[0].points).toBeUndefined();
    expect(s.annotations[1].line_meta).toBeUndefined();
  });

  it('一様幅（widths 無し）の line は widths を書かない（ペイロード最小・後方互換）', () => {
    const uniform: LineAnnotation = { ...LINE, lineMeta: { branches: LINE.lineMeta.branches, width: 12 } };
    const s = annotationsToSidecar([uniform], IMAGE, 'done');
    expect(s.annotations[0].line_meta?.widths).toBeUndefined();
  });

  it('書き出しは元データを共有せずコピーする（後の編集が保存済み JSON を汚さない）', () => {
    const s = annotationsToSidecar([LINE], IMAGE, 'done');
    expect(s.annotations[0].points).not.toBe(LINE.points);
    expect(s.annotations[0].line_meta?.branches[0]).not.toBe(LINE.lineMeta.branches[0]);
  });
});

describe('ラウンドトリップ', () => {
  it('annotations → sidecar → annotations で同値になる', () => {
    const original = [BBOX, POLY, LINE];
    const sidecar = viaJson(annotationsToSidecar(original, IMAGE, 'done'));
    const r = sidecarToAnnotations(sidecar);
    expect(r.warnings).toEqual([]);
    expect(r.status).toBe('done');
    expect(r.width).toBe(1000);
    expect(r.height).toBe(800);
    expect(r.annotations).toEqual(original);
  });

  it('0 件（負例候補）のサイドカーも警告なしで往復する', () => {
    const r = sidecarToAnnotations(viaJson(annotationsToSidecar([], IMAGE, 'done')));
    expect(r.annotations).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.status).toBe('done');
  });

  it('project → json → project で同値になる', () => {
    const project = createDefaultProject('現場A');
    const { project: back, warnings } = jsonToProject(viaJson(projectToJson(project)));
    expect(warnings).toEqual([]);
    expect(back).toEqual(project);
  });
});

describe('sidecarToAnnotations の耐性', () => {
  it('JSON オブジェクトでない入力でも例外を投げず空を返す', () => {
    for (const bad of [null, undefined, 42, 'x', [1, 2, 3], true]) {
      const r = sidecarToAnnotations(bad);
      expect(r.annotations).toEqual([]);
      expect(r.status).toBe('pending');
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });

  it('annotations が配列でなければ 0 件として警告する', () => {
    const r = sidecarToAnnotations({ schema_version: 1, image: IMAGE, annotations: { a: 1 } });
    expect(r.annotations).toEqual([]);
    expect(r.warnings.join()).toContain('annotations');
  });

  it('未知フィールドは無視して読める（前方互換）', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: { ...IMAGE, dpi: 300 },
      status: 'done',
      reviewer: 'unknown-field',
      annotations: [
        { id: 'x', class_id: 0, kind: 'bbox', source: 'manual', box: { x: 1, y: 2, w: 3, h: 4 }, confidence: 0.9 },
      ],
      updated_at: 'now',
    });
    expect(r.annotations).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });

  it('schema_version が新しければ警告しつつ読める', () => {
    const r = sidecarToAnnotations({
      schema_version: SIDECAR_SCHEMA_VERSION + 1,
      image: IMAGE,
      status: 'done',
      annotations: [{ id: 'x', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [10, 0], [10, 10]] }],
    });
    expect(r.annotations).toHaveLength(1);
    expect(r.warnings.join()).toContain('schema_version');
  });

  it('schema_version 欠損・status 不正はそれぞれ警告して既定値にする', () => {
    const r = sidecarToAnnotations({ image: IMAGE, status: 'DONE!', annotations: [] });
    expect(r.status).toBe('pending');
    expect(r.warnings).toHaveLength(2);
  });

  it('壊れたレコードだけを捨てて、健全なレコードは残す（全損させない）', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        null,
        'not an object',
        { id: 'ok1', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [10, 0], [10, 10]] },
        { id: 'bad-kind', class_id: 0, kind: 'circle', source: 'manual', points: [] },
        { id: 'nan', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [10, null], [10, 10]] },
        { id: 'few', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [10, 10]] },
        { id: 'ok2', class_id: 0, kind: 'bbox', source: 'manual', box: { x: 5, y: 5, w: 20, h: 20 } },
        { id: 'zero', class_id: 0, kind: 'bbox', source: 'manual', box: { x: 5, y: 5, w: 0, h: 20 } },
        { id: 'nobox', class_id: 0, kind: 'bbox', source: 'manual' },
      ],
      updated_at: 'x',
    });
    expect(r.annotations.map((a) => a.id)).toEqual(['ok1', 'ok2']);
    expect(r.warnings).toHaveLength(7);
  });

  it('bbox の座標は画像内にクランプされ、非有限値はレコードごと捨てる', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: { file: 'a.jpg', width: 100, height: 100 },
      status: 'done',
      annotations: [
        { id: 'clamped', class_id: 0, kind: 'bbox', source: 'manual', box: { x: -50, y: 90, w: 40, h: 40 } },
        { id: 'inf', class_id: 0, kind: 'bbox', source: 'manual', box: { x: 0, y: 0, w: 1e999, h: 10 } },
      ],
    });
    expect(r.annotations).toHaveLength(1);
    expect(r.annotations[0]).toMatchObject({ id: 'clamped', box: { x: 0, y: 60, w: 40, h: 40 } });
  });

  it('polygon / line_meta の座標も画像内にクランプされる', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: { file: 'a.jpg', width: 100, height: 100 },
      status: 'done',
      annotations: [
        {
          id: 'l',
          class_id: 0,
          kind: 'line',
          source: 'manual',
          points: [[-10, 50], [500, 50], [50, -80]],
          line_meta: { branches: [[[-20, 50], [900, 50]]], width: 12 },
        },
      ],
    });
    const line = r.annotations[0] as LineAnnotation;
    expect(line.points).toEqual([
      [0, 50],
      [100, 50],
      [50, 0],
    ]);
    expect(line.lineMeta.branches[0]).toEqual([
      [0, 50],
      [100, 50],
    ]);
  });

  it('画像サイズ不明ならクランプせず警告する（0 に潰さない）', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      status: 'done',
      annotations: [{ id: 'p', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [999, 0], [999, 999]] }],
    });
    expect(r.width).toBe(0);
    expect((r.annotations[0] as PolygonAnnotation).points[1]).toEqual([999, 0]);
    expect(r.warnings.join()).toContain('画像サイズ');
  });

  it('image.width/height が無ければ fallback（実画像の寸法）を使う', () => {
    const r = sidecarToAnnotations(
      {
        schema_version: 1,
        image: { file: 'a.jpg' },
        status: 'done',
        annotations: [{ id: 'p', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [999, 0], [999, 999]] }],
      },
      { fallbackWidth: 100, fallbackHeight: 100 }
    );
    expect(r.width).toBe(100);
    expect((r.annotations[0] as PolygonAnnotation).points[1]).toEqual([100, 0]);
  });

  it('line_meta が欠損・不正なら polygon に降格して警告する', () => {
    const rec = { id: 'l', class_id: 0, kind: 'line', source: 'manual', points: [[0, 0], [10, 0], [10, 10]] };
    for (const meta of [undefined, null, {}, { width: 12 }, { branches: 'x', width: 12 }, { branches: [[[0, 0]]], width: 12 }, { branches: [[[0, 0], [10, 0]]], width: 0 }]) {
      const r = sidecarToAnnotations({
        schema_version: 1,
        image: IMAGE,
        status: 'done',
        annotations: [{ ...rec, line_meta: meta }],
      });
      expect(r.annotations[0].kind).toBe('polygon');
      expect(r.warnings.join()).toContain('降格');
    }
  });

  it('line_meta.widths の形が合わなければ一様幅に劣化させて警告する（レコードは残す）', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        {
          id: 'l',
          class_id: 0,
          kind: 'line',
          source: 'manual',
          points: [[0, 0], [10, 0], [10, 10]],
          line_meta: { branches: [[[0, 0], [10, 0]]], width: 12, widths: [[10]] },
        },
      ],
    });
    const line = r.annotations[0] as LineAnnotation;
    expect(line.kind).toBe('line');
    expect(line.lineMeta.widths).toBeUndefined();
    expect(r.warnings.join()).toContain('widths');
  });

  it('line_meta.width は 4..200 に補正される', () => {
    const build = (width: number): unknown => ({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        {
          id: 'l',
          class_id: 0,
          kind: 'line',
          source: 'manual',
          points: [[0, 0], [10, 0], [10, 10]],
          line_meta: { branches: [[[0, 0], [10, 0]]], width },
        },
      ],
    });
    expect((sidecarToAnnotations(build(1)).annotations[0] as LineAnnotation).lineMeta.width).toBe(LINE_WIDTH_MIN);
    expect((sidecarToAnnotations(build(9999)).annotations[0] as LineAnnotation).lineMeta.width).toBe(LINE_WIDTH_MAX);
  });

  it('points が壊れていても line_meta が生きていればリボンを再生成して救う', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        {
          id: 'l',
          class_id: 0,
          kind: 'line',
          source: 'manual',
          line_meta: { branches: [[[100, 100], [300, 100]]], width: 12 },
        },
      ],
    });
    const line = r.annotations[0] as LineAnnotation;
    expect(line.kind).toBe('line');
    expect(line.points.length).toBeGreaterThanOrEqual(3);
    expect(r.warnings.join()).toContain('再生成');
  });

  it('id 欠損は採番し、重複は振り直して一意性を保つ', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        { class_id: 0, kind: 'bbox', source: 'manual', box: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'same', class_id: 0, kind: 'bbox', source: 'manual', box: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'same', class_id: 0, kind: 'bbox', source: 'manual', box: { x: 20, y: 20, w: 10, h: 10 } },
      ],
    });
    const ids = r.annotations.map((a) => a.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(/.+/);
    expect(ids[1]).toBe('same');
    expect(r.warnings.join()).toContain('重複');
  });

  it('class_id が不正なら 0 に補正して残す（形状は失わない）', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        { id: 'a', class_id: 'ひび', kind: 'bbox', source: 'manual', box: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'b', class_id: -3, kind: 'bbox', source: 'manual', box: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'c', class_id: 2.7, kind: 'bbox', source: 'manual', box: { x: 0, y: 0, w: 10, h: 10 } },
      ],
    });
    expect(r.annotations.map((a) => a.classId)).toEqual([0, 0, 2]);
    expect(r.warnings).toHaveLength(3);
  });

  // --- 修正バッチB 項目3: 画像寸法の検証強化 ---

  it('巨大な画像寸法は 65535 に丸め、annotations は読み込む', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: { file: 'a.jpg', width: 1e9, height: 2 ** 40 },
      status: 'done',
      annotations: [{ id: 'p', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [10, 0], [10, 10]] }],
    });
    expect(r.width).toBe(65535);
    expect(r.height).toBe(65535);
    expect(r.annotations).toHaveLength(1); // 全損させない
    expect(r.warnings.filter((w) => w.includes('65535'))).toHaveLength(2);
  });

  it('小数の画像寸法は整数に丸める（マスク生成のバッファ計算を壊さない）', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: { file: 'a.jpg', width: 1000.7, height: 800.2 },
      status: 'done',
      annotations: [],
    });
    expect(r.width).toBe(1000);
    expect(r.height).toBe(800);
    expect(r.warnings).toHaveLength(2);
  });

  it('丸めた寸法が座標クランプの基準になる', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: { file: 'a.jpg', width: 100.9, height: 100.9 },
      status: 'done',
      annotations: [{ id: 'p', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [500, 0], [500, 500]] }],
    });
    expect((r.annotations[0] as PolygonAnnotation).points[1]).toEqual([100, 0]);
  });

  it('fallback 寸法も同じ検証を通る', () => {
    const r = sidecarToAnnotations(
      { schema_version: 1, image: { file: 'a.jpg' }, status: 'done', annotations: [] },
      { fallbackWidth: 1e12, fallbackHeight: 0 }
    );
    expect(r.width).toBe(65535);
    expect(r.height).toBe(0);
  });

  it('負値・非有限の寸法は「不明」として扱いクランプを省略する', () => {
    for (const bad of [-100, 0, NaN, Infinity, 'x', null]) {
      const r = sidecarToAnnotations({
        schema_version: 1,
        image: { file: 'a.jpg', width: bad, height: bad },
        status: 'done',
        annotations: [{ id: 'p', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [9999, 0], [9999, 9999]] }],
      });
      expect(r.width).toBe(0);
      expect((r.annotations[0] as PolygonAnnotation).points[1]).toEqual([9999, 0]);
    }
  });

  // --- 修正バッチB 項目4: 局所幅は上限のみクランプ（下限クランプは意図的に不採用） ---

  it('ヘアライン相当の細い局所幅（1.5px 等）は破壊せずそのまま保持する', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        {
          id: 'l',
          class_id: 0,
          kind: 'line',
          source: 'manual',
          points: [[0, 0], [10, 0], [10, 10]],
          line_meta: { branches: [[[100, 100], [200, 100]]], width: 12, widths: [[1.5, 2.1]] },
        },
      ],
    });
    const line = r.annotations[0] as LineAnnotation;
    // LINE_WIDTH_MIN(4) への下限クランプをしない = マグネットの幅推定を壊さない
    expect(line.lineMeta.widths).toEqual([[1.5, 2.1]]);
    expect(r.warnings).toEqual([]);
  });

  it('異常に太い局所幅は LINE_WIDTH_MAX×4 に丸めて警告する（レコードは残す）', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        {
          id: 'l',
          class_id: 0,
          kind: 'line',
          source: 'manual',
          points: [[0, 0], [10, 0], [10, 10]],
          line_meta: { branches: [[[100, 100], [200, 100]]], width: 12, widths: [[1e9, 20]] },
        },
      ],
    });
    const line = r.annotations[0] as LineAnnotation;
    expect(line.kind).toBe('line');
    expect(line.lineMeta.widths).toEqual([[LINE_WIDTH_MAX * 4, 20]]);
    expect(r.warnings.join()).toContain('局所幅');
  });

  it('0 以下・非有限の局所幅は従来どおり一様幅に劣化させる', () => {
    for (const bad of [0, -5, NaN, 'x']) {
      const r = sidecarToAnnotations({
        schema_version: 1,
        image: IMAGE,
        status: 'done',
        annotations: [
          {
            id: 'l',
            class_id: 0,
            kind: 'line',
            source: 'manual',
            points: [[0, 0], [10, 0], [10, 10]],
            line_meta: { branches: [[[100, 100], [200, 100]]], width: 12, widths: [[bad, 20]] },
          },
        ],
      });
      expect((r.annotations[0] as LineAnnotation).lineMeta.widths).toBeUndefined();
    }
  });

  // --- 修正バッチB 項目5: 捨てたレコードが id を消費しない ---

  it('捨てられたレコードの id は消費されず、後続の正常レコードが再採番されない', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        // 同じ id を持つが 3 点未満で捨てられるレコード
        { id: 'keep-me', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [10, 10]] },
        // こちらは正常。上の捨てたレコードに id を奪われてはいけない
        { id: 'keep-me', class_id: 0, kind: 'polygon', source: 'manual', points: [[0, 0], [10, 0], [10, 10]] },
      ],
    });
    expect(r.annotations).toHaveLength(1);
    expect(r.annotations[0].id).toBe('keep-me');
    expect(r.warnings.filter((w) => w.includes('重複'))).toHaveLength(0);
  });

  it('採用されたレコード同士の id 重複は従来どおり振り直す', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        { id: 'dup', class_id: 0, kind: 'bbox', source: 'manual', box: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'dup', class_id: 0, kind: 'bbox', source: 'manual', box: { x: 20, y: 20, w: 10, h: 10 } },
      ],
    });
    expect(r.annotations[0].id).toBe('dup');
    expect(r.annotations[1].id).not.toBe('dup');
    expect(new Set(r.annotations.map((a) => a.id)).size).toBe(2);
  });

  it('source は manual / imported 以外を manual に正規化する', () => {
    const r = sidecarToAnnotations({
      schema_version: 1,
      image: IMAGE,
      status: 'done',
      annotations: [
        { id: 'a', class_id: 0, kind: 'bbox', source: 'ai_draft', box: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'b', class_id: 0, kind: 'bbox', source: 'imported', box: { x: 0, y: 0, w: 10, h: 10 } },
      ],
    });
    expect(r.annotations.map((a) => a.source)).toEqual(['manual', 'imported']);
  });
});

describe('project.json', () => {
  it('createDefaultProject は crack/ひび割れ 1 クラス・line 既定・幅12', () => {
    const p = createDefaultProject('現場A');
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(p.name).toBe('現場A');
    expect(p.classes).toEqual([
      { id: 0, name: 'crack', nameJa: 'ひび割れ', color: DEFAULT_CLASS_COLORS[0] },
    ]);
    expect(p.settings).toEqual({
      defaultTool: 'line',
      magnet: { enabled: true, invert: false },
      lineWidthDefault: 12,
    });
    expect(Number.isNaN(Date.parse(p.createdAt))).toBe(false);
    expect(p.updatedAt).toBe(p.createdAt);
  });

  it('projectToJson は snake_case キーと app 名を書き出す', () => {
    const json = projectToJson(createDefaultProject('現場A'));
    expect(json.app).toBe('genba-anno');
    expect(json.schema_version).toBe(PROJECT_SCHEMA_VERSION);
    expect(json.classes[0]).toEqual({ id: 0, name: 'crack', name_ja: 'ひび割れ', color: DEFAULT_CLASS_COLORS[0] });
    expect(json.settings).toEqual({
      default_tool: 'line',
      magnet: { enabled: true, invert: false },
      line_width_default: 12,
    });
  });

  it('壊れた入力でも既定プロジェクトを返す', () => {
    for (const bad of [null, 'x', 3, []]) {
      const { project, warnings } = jsonToProject(bad, '現場B');
      expect(project.name).toBe('現場B');
      expect(project.classes).toHaveLength(1);
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  it('空オブジェクトは settings とクラスを既定値で補完する', () => {
    const { project, warnings } = jsonToProject({});
    expect(project.settings).toEqual(createDefaultProject('x').settings);
    expect(project.classes).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('クラス id の重複・不正は最小の空き番号に振り直して警告する', () => {
    const { project, warnings } = jsonToProject({
      schema_version: 1,
      name: 'p',
      classes: [
        { id: 1, name: 'a', name_ja: 'あ', color: '#112233' },
        { id: 1, name: 'b', name_ja: 'い', color: '#112233' },
        { id: 'x', name: 'c', name_ja: 'う', color: '#112233' },
      ],
    });
    expect(project.classes.map((c) => c.id)).toEqual([1, 0, 2]);
    expect(new Set(project.classes.map((c) => c.id)).size).toBe(3);
    expect(warnings.filter((w) => w.includes('学習 ID'))).toHaveLength(2);
  });

  it('color は #RRGGBB を維持し、#RGB を展開し、不正は既定パレットにする', () => {
    const { project, warnings } = jsonToProject({
      classes: [
        { id: 0, name: 'a', name_ja: 'あ', color: '#aabbcc' },
        { id: 1, name: 'b', name_ja: 'い', color: '#f00' },
        { id: 2, name: 'c', name_ja: 'う', color: 'red' },
        { id: 3, name: 'd', name_ja: 'え', color: 42 },
      ],
    });
    expect(project.classes.map((c) => c.color)).toEqual([
      '#aabbcc',
      '#FF0000',
      DEFAULT_CLASS_COLORS[2],
      DEFAULT_CLASS_COLORS[3],
    ]);
    expect(warnings.filter((w) => w.includes('color'))).toHaveLength(2);
  });

  it('クラスの name / name_ja 欠損を補い、オブジェクトでない要素は捨てる', () => {
    const { project } = jsonToProject({
      classes: [null, { id: 5, color: '#112233' }, { id: 6, name: 'pothole', color: '#112233' }],
    });
    expect(project.classes).toEqual([
      { id: 5, name: 'class5', nameJa: 'class5', color: '#112233' },
      { id: 6, name: 'pothole', nameJa: 'pothole', color: '#112233' },
    ]);
  });

  it('settings は不正値を既定に戻し、line_width_default を 4..200 にクランプする', () => {
    const { project, warnings } = jsonToProject({
      settings: { default_tool: 'lasso', magnet: { enabled: 'yes' }, line_width_default: 9999 },
    });
    expect(project.settings.defaultTool).toBe('line');
    expect(project.settings.magnet).toEqual({ enabled: true, invert: false });
    expect(project.settings.lineWidthDefault).toBe(LINE_WIDTH_MAX);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('有効な settings はそのまま読む', () => {
    const { project, warnings } = jsonToProject({
      schema_version: 1,
      name: 'p',
      classes: [{ id: 0, name: 'crack', name_ja: 'ひび割れ', color: '#E6002D' }],
      settings: {
        default_tool: 'bbox',
        magnet: { enabled: false, invert: true },
        line_width_default: 30,
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
    });
    expect(warnings).toEqual([]);
    expect(project.settings).toEqual({
      defaultTool: 'bbox',
      magnet: { enabled: false, invert: true },
      lineWidthDefault: 30,
    });
    expect(project.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(project.updatedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('schema_version が新しければ警告しつつ読める', () => {
    const { project, warnings } = jsonToProject({
      schema_version: PROJECT_SCHEMA_VERSION + 1,
      name: 'p',
      classes: [{ id: 0, name: 'crack', name_ja: 'ひび割れ', color: '#E6002D' }],
      settings: { default_tool: 'line', magnet: { enabled: true, invert: false }, line_width_default: 12 },
      created_at: 'x',
      updated_at: 'y',
    });
    expect(project.classes).toHaveLength(1);
    expect(warnings.join()).toContain('schema_version');
  });

  it('updated_at 欠損は created_at を引き継ぐ', () => {
    const { project } = jsonToProject({
      classes: [{ id: 0, name: 'crack', name_ja: 'ひび割れ', color: '#E6002D' }],
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(project.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('Project 型に無いフィールドは読み捨てる（前方互換）', () => {
    const { project } = jsonToProject({
      app: 'genba-anno',
      name: 'p',
      classes: [{ id: 0, name: 'crack', name_ja: 'ひび割れ', color: '#E6002D', hotkey: '1' }],
      settings: { default_tool: 'line', magnet: { enabled: true, invert: false }, line_width_default: 12, future: 1 },
      created_at: 'x',
      updated_at: 'y',
      lastExport: { format: 'coco' },
    } satisfies Record<string, unknown>);
    const asRecord = project as unknown as Record<string, unknown>;
    expect(asRecord.lastExport).toBeUndefined();
    expect(project.classes[0]).toEqual({ id: 0, name: 'crack', nameJa: 'ひび割れ', color: '#E6002D' });
  });
});

describe('サイドカーとプロジェクトの型整合', () => {
  it('保存 → 読込 → 再保存で内容が安定する（多重保存で劣化しない）', () => {
    const first = annotationsToSidecar([BBOX, POLY, LINE], IMAGE, 'done', 'T1');
    const read = sidecarToAnnotations(viaJson(first));
    const second = annotationsToSidecar(read.annotations, IMAGE, read.status, 'T1');
    expect(viaJson(second)).toEqual(viaJson(first));
  });

  it('Project を往復させても classes の順序と学習 ID が変わらない', () => {
    const project: Project = {
      ...createDefaultProject('現場A'),
      classes: [
        { id: 0, name: 'crack', nameJa: 'ひび割れ', color: '#E6002D' },
        { id: 3, name: 'pothole', nameJa: 'ポットホール', color: '#0075C2' },
        { id: 1, name: 'patch', nameJa: 'パッチ', color: '#00A040' },
      ],
    };
    const { project: back, warnings } = jsonToProject(viaJson(projectToJson(project)));
    expect(warnings).toEqual([]);
    expect(back.classes).toEqual(project.classes);
  });
});
