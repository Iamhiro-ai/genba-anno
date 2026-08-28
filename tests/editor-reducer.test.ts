// =============================================================================
// M2: エディタ状態リデューサのテスト。
// 参照実装（reference/frontend/src/hooks/useAnnotationEditor.ts）の履歴意味論を
// 保存できているかを主眼に、bbox 拡張・line 降格・枝削除カスケードまで検証する。
// =============================================================================

import { describe, expect, it } from 'vitest';
import type {
  Annotation,
  BBox,
  BBoxAnnotation,
  EditorAction,
  EditorState,
  LineAnnotation,
  PolygonAnnotation,
  Pt,
} from '../src/core/types';
import { BBOX_MIN_SIZE, HISTORY_LIMIT, LINE_WIDTH_MAX, LINE_WIDTH_MIN } from '../src/core/types';
import {
  createInitialEditorState,
  draftCommittable,
  editorReducer,
} from '../src/store/editorReducer';

const IMG_W = 1000;
const IMG_H = 800;

function apply(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

function base(annotations: Annotation[] = []): EditorState {
  return editorReducer(createInitialEditorState(), {
    type: 'load',
    annotations,
    imageWidth: IMG_W,
    imageHeight: IMG_H,
  });
}

function poly(id: string, points: Pt[], classId = 0): PolygonAnnotation {
  return { id, classId, source: 'manual', kind: 'polygon', points };
}

function box(id: string, b: BBox, classId = 0): BBoxAnnotation {
  return { id, classId, source: 'manual', kind: 'bbox', box: b };
}

const TRI: Pt[] = [
  [100, 100],
  [200, 100],
  [150, 200],
];

/** line ツールで中心線 pts を描いて確定する（lineMeta/points を実物と同じ経路で作る） */
function drawLine(state: EditorState, pts: Pt[], widths?: number[]): EditorState {
  let s = apply(
    state,
    { type: 'setDrawTool', tool: 'line' },
    { type: 'startDraft', point: pts[0] }
  );
  for (let i = 1; i < pts.length; i++) {
    s = editorReducer(s, {
      type: 'addDraftPoint',
      point: pts[i],
      ...(widths ? { width: widths[i] } : {}),
    });
  }
  return editorReducer(s, { type: 'commitDraft' });
}

function lastLine(s: EditorState): LineAnnotation {
  const a = s.annotations[s.annotations.length - 1];
  if (a.kind !== 'line') throw new Error(`expected line, got ${a.kind}`);
  return a;
}

// ---------------------------------------------------------------------------

describe('初期状態と load', () => {
  it('createInitialEditorState は DESIGN の既定（line ツール・幅12・edit モード）', () => {
    const s = createInitialEditorState();
    expect(s.annotations).toEqual([]);
    expect(s.mode).toBe('edit');
    expect(s.drawTool).toBe('line');
    expect(s.lineWidth).toBe(12);
    expect(s.dirty).toBe(false);
    expect(s.fillVisible).toBe(true);
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
  });

  it('createInitialEditorState は overrides で上書きできる', () => {
    const s = createInitialEditorState({ drawTool: 'bbox', lineWidth: 30, activeClassId: 2 });
    expect(s.drawTool).toBe('bbox');
    expect(s.lineWidth).toBe(30);
    expect(s.activeClassId).toBe(2);
    expect(s.mode).toBe('edit');
  });

  it('load は履歴・選択・draft をクリアし dirty を false にする', () => {
    const dirtied = apply(base(), { type: 'addAnnotation', annotation: box('b1', { x: 0, y: 0, w: 10, h: 10 }) });
    expect(dirtied.dirty).toBe(true);
    expect(dirtied.past).toHaveLength(1);

    const s = editorReducer(dirtied, {
      type: 'load',
      annotations: [poly('p1', TRI)],
      imageWidth: 640,
      imageHeight: 480,
    });
    expect(s.annotations).toHaveLength(1);
    expect(s.selectedId).toBeNull();
    expect(s.draft).toBeNull();
    expect(s.dirty).toBe(false);
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.imageWidth).toBe(640);
    expect(s.imageHeight).toBe(480);
  });

  it('load は座標を画像内にクランプする（polygon / bbox / lineMeta）', () => {
    const line: LineAnnotation = {
      id: 'l1',
      classId: 0,
      source: 'manual',
      kind: 'line',
      points: [
        [-10, -10],
        [500, 10],
        [500, -10],
      ],
      lineMeta: {
        branches: [
          [
            [-50, 50],
            [2000, 50],
          ],
        ],
        width: 12,
      },
    };
    const s = editorReducer(createInitialEditorState(), {
      type: 'load',
      annotations: [poly('p1', [[-5, -5], [2000, 50], [50, 5000]]), box('b1', { x: -20, y: -20, w: 100, h: 100 }), line],
      imageWidth: 100,
      imageHeight: 100,
    });
    const p = s.annotations[0] as PolygonAnnotation;
    expect(p.points).toEqual([
      [0, 0],
      [100, 50],
      [50, 100],
    ]);
    expect((s.annotations[1] as BBoxAnnotation).box).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect((s.annotations[2] as LineAnnotation).lineMeta.branches[0]).toEqual([
      [0, 50],
      [100, 50],
    ]);
  });
});

describe('モード・ツール・クラス・線幅', () => {
  it('setMode(edit) は draft を破棄し、setMode(draw) は維持する', () => {
    const s = apply(base(), { type: 'setDrawTool', tool: 'polygon' }, { type: 'startDraft', point: [10, 10] });
    expect(editorReducer(s, { type: 'setMode', mode: 'edit' }).draft).toBeNull();
    expect(editorReducer(s, { type: 'setMode', mode: 'draw' }).draft).not.toBeNull();
  });

  it('setDrawTool は draw モードにし、ツールが変わる場合のみ draft を破棄する', () => {
    const s = apply(base(), { type: 'setDrawTool', tool: 'polygon' }, { type: 'startDraft', point: [10, 10] });
    expect(s.mode).toBe('draw');
    expect(editorReducer(s, { type: 'setDrawTool', tool: 'polygon' }).draft).not.toBeNull();
    expect(editorReducer(s, { type: 'setDrawTool', tool: 'line' }).draft).toBeNull();
    expect(editorReducer(s, { type: 'setDrawTool', tool: 'bbox' }).draft).toBeNull();
  });

  it('bbox ツールでは startDraft は無視される（ドラッグ確定は addAnnotation）', () => {
    const s = apply(base(), { type: 'setDrawTool', tool: 'bbox' });
    expect(editorReducer(s, { type: 'startDraft', point: [10, 10] })).toBe(s);
  });

  it('setActiveClass は選択が無ければ履歴を積まない', () => {
    const s = editorReducer(base([poly('p1', TRI)]), { type: 'setActiveClass', classId: 3 });
    expect(s.activeClassId).toBe(3);
    expect(s.past).toEqual([]);
    expect(s.dirty).toBe(false);
  });

  it('setActiveClass は選択中アノテーション（bbox 含む）のクラスも変え、履歴に積む', () => {
    const s = apply(
      base([poly('p1', TRI), box('b1', { x: 0, y: 0, w: 50, h: 50 })]),
      { type: 'select', id: 'b1' },
      { type: 'setActiveClass', classId: 2 }
    );
    expect(s.annotations[1].classId).toBe(2);
    expect(s.annotations[0].classId).toBe(0);
    expect(s.past).toHaveLength(1);
    expect(s.dirty).toBe(true);
  });

  it('setActiveClass が同じクラスなら履歴を積まない', () => {
    const s = apply(base([poly('p1', TRI)]), { type: 'select', id: 'p1' }, { type: 'setActiveClass', classId: 0 });
    expect(s.past).toEqual([]);
    expect(s.dirty).toBe(false);
  });

  it('setLineWidth は 4..200 にクランプし、非有限値は最小値になる', () => {
    expect(editorReducer(base(), { type: 'setLineWidth', width: 1 }).lineWidth).toBe(LINE_WIDTH_MIN);
    expect(editorReducer(base(), { type: 'setLineWidth', width: 999 }).lineWidth).toBe(LINE_WIDTH_MAX);
    expect(editorReducer(base(), { type: 'setLineWidth', width: NaN }).lineWidth).toBe(LINE_WIDTH_MIN);
    expect(editorReducer(base(), { type: 'setLineWidth', width: 40 }).lineWidth).toBe(40);
  });

  it('setLineWidth は draft の局所幅を全体スケールする（プロファイルの形を保つ）', () => {
    const s = apply(
      base(),
      { type: 'setDrawTool', tool: 'line' },
      { type: 'setLineWidth', width: 10 },
      { type: 'startDraft', point: [10, 10] },
      { type: 'addDraftPoint', point: [50, 10], width: 20 },
      { type: 'setLineWidth', width: 20 }
    );
    expect(s.draft?.lineWidth).toBe(20);
    expect(s.draft?.widths).toEqual([20, 40]); // 2倍にスケール
  });
});

describe('draft（polygon）', () => {
  it('3点を確定すると polygon が追加され、draw モード・同ツールが維持される', () => {
    const s = apply(
      base(),
      { type: 'setDrawTool', tool: 'polygon' },
      { type: 'setActiveClass', classId: 1 },
      { type: 'startDraft', point: TRI[0] },
      { type: 'addDraftPoint', point: TRI[1] },
      { type: 'addDraftPoint', point: TRI[2] },
      { type: 'commitDraft' }
    );
    expect(s.annotations).toHaveLength(1);
    expect(s.annotations[0].kind).toBe('polygon');
    expect(s.annotations[0].classId).toBe(1);
    expect(s.annotations[0].source).toBe('manual');
    expect((s.annotations[0] as PolygonAnnotation).points).toEqual(TRI);
    expect(s.draft).toBeNull();
    expect(s.mode).toBe('draw');
    expect(s.drawTool).toBe('polygon');
    expect(s.past).toHaveLength(1);
    expect(s.dirty).toBe(true);
  });

  it('2点の polygon draft は commitDraft で無視される', () => {
    const s = apply(
      base(),
      { type: 'setDrawTool', tool: 'polygon' },
      { type: 'startDraft', point: TRI[0] },
      { type: 'addDraftPoint', point: TRI[1] }
    );
    expect(editorReducer(s, { type: 'commitDraft' })).toBe(s);
    expect(draftCommittable(s.draft)).toBe(false);
  });

  it('始点と重なる終端頂点（ダブルクリック確定分）は除去される', () => {
    const s = apply(
      base(),
      { type: 'setDrawTool', tool: 'polygon' },
      { type: 'startDraft', point: [100, 100] },
      { type: 'addDraftPoint', point: [200, 100] },
      { type: 'addDraftPoint', point: [150, 200] },
      { type: 'addDraftPoint', point: [100.2, 100.1] }, // 始点に重なる
      { type: 'commitDraft' }
    );
    expect((s.annotations[0] as PolygonAnnotation).points).toHaveLength(3);
  });

  it('popDraftPoint は末尾頂点を削り、1点まで減ると draft ごと消える', () => {
    let s = apply(
      base(),
      { type: 'setDrawTool', tool: 'polygon' },
      { type: 'startDraft', point: TRI[0] },
      { type: 'addDraftPoint', point: TRI[1] }
    );
    s = editorReducer(s, { type: 'popDraftPoint' });
    expect(s.draft?.points).toHaveLength(1);
    s = editorReducer(s, { type: 'popDraftPoint' });
    expect(s.draft).toBeNull();
    expect(editorReducer(s, { type: 'popDraftPoint' })).toBe(s);
  });

  it('cancelDraft は draft を捨てる（通常ドラフトはモード維持）', () => {
    const s = apply(
      base(),
      { type: 'setDrawTool', tool: 'polygon' },
      { type: 'startDraft', point: TRI[0] },
      { type: 'cancelDraft' }
    );
    expect(s.draft).toBeNull();
    expect(s.mode).toBe('draw');
  });

  it('draftCommittable は polygon≥3点 / line≥2点', () => {
    expect(draftCommittable(null)).toBe(false);
    expect(draftCommittable({ tool: 'polygon', points: [[0, 0], [1, 1]], lineWidth: 12 })).toBe(false);
    expect(draftCommittable({ tool: 'polygon', points: TRI, lineWidth: 12 })).toBe(true);
    expect(draftCommittable({ tool: 'line', points: [[0, 0]], lineWidth: 12 })).toBe(false);
    expect(draftCommittable({ tool: 'line', points: [[0, 0], [50, 0]], lineWidth: 12 })).toBe(true);
  });
});

describe('draft（line）とリボン生成', () => {
  it('2点で確定すると kind:line・points 非空・lineMeta を持つ', () => {
    const s = drawLine(base(), [
      [100, 100],
      [300, 100],
    ]);
    const line = lastLine(s);
    expect(line.points.length).toBeGreaterThanOrEqual(3);
    expect(line.lineMeta.branches).toHaveLength(1);
    expect(line.lineMeta.branches[0]).toEqual([
      [100, 100],
      [300, 100],
    ]);
    expect(line.lineMeta.width).toBe(12);
    expect(s.dirty).toBe(true);
    expect(s.past).toHaveLength(1);
  });

  it('1点だけの line draft は無視される', () => {
    const s = apply(base(), { type: 'setDrawTool', tool: 'line' }, { type: 'startDraft', point: [10, 10] });
    expect(editorReducer(s, { type: 'commitDraft' })).toBe(s);
  });

  it('重複頂点は除去され、実質1点になる line は確定しない', () => {
    const s = apply(
      base(),
      { type: 'setDrawTool', tool: 'line' },
      { type: 'startDraft', point: [10, 10] },
      { type: 'addDraftPoint', point: [10.1, 10.1] }
    );
    expect(editorReducer(s, { type: 'commitDraft' })).toBe(s);
  });

  it('マグネット推定の局所幅は widths として保持され、代表幅は中央値になる', () => {
    const s = drawLine(
      base(),
      [
        [100, 100],
        [200, 100],
        [300, 100],
      ],
      [0, 30, 60] // widths[0] は startDraft の lineWidth(12) が入る
    );
    const line = lastLine(s);
    expect(line.lineMeta.widths).toEqual([[12, 30, 60]]);
    expect(line.lineMeta.width).toBe(30);
  });

  it('延長ドラフト（attach=end）は幅を引き継ぎ、確定で幹が伸びて edit モードに戻る', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [200, 100],
    ]);
    const id = lastLine(s0).id;
    const started = editorReducer(s0, {
      type: 'startDraft',
      point: [200, 100],
      target: { polygonId: id, attach: 'end', branchIndex: 0, anchor: [200, 100] },
    });
    expect(started.draft?.tool).toBe('line');
    expect(started.draft?.lineWidth).toBe(12);
    expect(started.draft?.target?.attach).toBe('end');
    expect(started.selectedId).toBe(id);
    expect(started.mode).toBe('draw');

    const s = apply(started, { type: 'addDraftPoint', point: [300, 100] }, { type: 'commitDraft' });
    const line = lastLine(s);
    expect(line.lineMeta.branches[0]).toEqual([
      [100, 100],
      [200, 100],
      [300, 100],
    ]);
    expect(s.mode).toBe('edit');
    expect(s.selectedId).toBe(id);
    expect(s.annotations).toHaveLength(1);
  });

  it('延長ドラフト（attach=start）は先頭側に逆順で連結される', () => {
    const s0 = drawLine(base(), [
      [200, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const s = apply(
      s0,
      {
        type: 'startDraft',
        point: [200, 100],
        target: { polygonId: id, attach: 'start', branchIndex: 0, anchor: [200, 100] },
      },
      { type: 'addDraftPoint', point: [100, 100] },
      { type: 'commitDraft' }
    );
    expect(lastLine(s).lineMeta.branches[0]).toEqual([
      [100, 100],
      [200, 100],
      [300, 100],
    ]);
  });

  it('分岐ドラフト（attach=branch）は枝を1本増やす', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [200, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const s = apply(
      s0,
      {
        type: 'startDraft',
        point: [200, 100],
        target: { polygonId: id, attach: 'branch', branchIndex: -1, anchor: [200, 100] },
      },
      { type: 'addDraftPoint', point: [200, 200] },
      { type: 'commitDraft' }
    );
    const line = lastLine(s);
    expect(line.lineMeta.branches).toHaveLength(2);
    expect(line.lineMeta.branches[1]).toEqual([
      [200, 100],
      [200, 200],
    ]);
    expect(line.points.length).toBeGreaterThanOrEqual(3);
  });

  it('存在しない対象への延長ドラフトは無視される', () => {
    const s = base();
    expect(
      editorReducer(s, {
        type: 'startDraft',
        point: [10, 10],
        target: { polygonId: 'nope', attach: 'end', branchIndex: 0, anchor: [10, 10] },
      })
    ).toBe(s);
  });

  it('延長ドラフトの cancelDraft は edit モードに戻す', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [200, 100],
    ]);
    const id = lastLine(s0).id;
    const s = apply(
      s0,
      {
        type: 'startDraft',
        point: [200, 100],
        target: { polygonId: id, attach: 'end', branchIndex: 0, anchor: [200, 100] },
      },
      { type: 'cancelDraft' }
    );
    expect(s.draft).toBeNull();
    expect(s.mode).toBe('edit');
  });
});

describe('bbox', () => {
  it('addAnnotation は画像内にクランプして追加し、選択・履歴・dirty を更新する', () => {
    const s = editorReducer(base(), {
      type: 'addAnnotation',
      annotation: box('b1', { x: -50, y: -50, w: 100, h: 100 }),
    });
    expect(s.annotations).toHaveLength(1);
    expect((s.annotations[0] as BBoxAnnotation).box).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(s.selectedId).toBe('b1');
    expect(s.past).toHaveLength(1);
    expect(s.dirty).toBe(true);
  });

  it('addAnnotation は負の w/h を正規化する', () => {
    const s = editorReducer(base(), {
      type: 'addAnnotation',
      annotation: box('b1', { x: 300, y: 300, w: -100, h: -50 }),
    });
    expect((s.annotations[0] as BBoxAnnotation).box).toEqual({ x: 200, y: 250, w: 100, h: 50 });
  });

  it('addAnnotation は BBOX_MIN_SIZE 未満・非有限値の bbox を確定しない', () => {
    const s = base();
    expect(editorReducer(s, { type: 'addAnnotation', annotation: box('b1', { x: 10, y: 10, w: BBOX_MIN_SIZE - 1, h: 50 }) })).toBe(s);
    expect(editorReducer(s, { type: 'addAnnotation', annotation: box('b2', { x: NaN, y: 10, w: 50, h: 50 }) })).toBe(s);
  });

  it('addAnnotation は3点未満の polygon を弾き、id 衝突は採番し直す', () => {
    const s0 = base();
    expect(editorReducer(s0, { type: 'addAnnotation', annotation: poly('p1', [[0, 0], [10, 10]]) })).toBe(s0);

    const s = apply(
      s0,
      { type: 'addAnnotation', annotation: box('dup', { x: 0, y: 0, w: 20, h: 20 }) },
      { type: 'addAnnotation', annotation: box('dup', { x: 50, y: 50, w: 20, h: 20 }) }
    );
    expect(s.annotations).toHaveLength(2);
    expect(s.annotations[1].id).not.toBe('dup');
    expect(s.selectedId).toBe(s.annotations[1].id);
  });

  it('addAnnotation は lineMeta が壊れた line を polygon に降格して残す', () => {
    const broken = {
      id: 'l1',
      classId: 0,
      source: 'manual',
      kind: 'line',
      points: TRI,
      lineMeta: { branches: [], width: 12 },
    } as LineAnnotation;
    const s = editorReducer(base(), { type: 'addAnnotation', annotation: broken });
    expect(s.annotations[0].kind).toBe('polygon');
    expect((s.annotations[0] as PolygonAnnotation).points).toEqual(TRI);
  });

  it('resizeBBox は BBOX_MIN_SIZE 未満にせず、履歴を積まない', () => {
    const s0 = base([box('b1', { x: 10, y: 10, w: 100, h: 100 })]);
    const s = editorReducer(s0, { type: 'resizeBBox', id: 'b1', box: { x: 10, y: 10, w: 1, h: 0 } });
    expect((s.annotations[0] as BBoxAnnotation).box).toEqual({
      x: 10,
      y: 10,
      w: BBOX_MIN_SIZE,
      h: BBOX_MIN_SIZE,
    });
    expect(s.past).toEqual([]);
    expect(s.dirty).toBe(true);
  });

  it('resizeBBox は画像内にクランプし、無変化・非 bbox・不正値では state を変えない', () => {
    const s0 = base([box('b1', { x: 10, y: 10, w: 100, h: 100 }), poly('p1', TRI)]);
    const s = editorReducer(s0, { type: 'resizeBBox', id: 'b1', box: { x: 990, y: 790, w: 50, h: 50 } });
    expect((s.annotations[0] as BBoxAnnotation).box).toEqual({ x: 950, y: 750, w: 50, h: 50 });

    expect(editorReducer(s0, { type: 'resizeBBox', id: 'b1', box: { x: 10, y: 10, w: 100, h: 100 } })).toBe(s0);
    expect(editorReducer(s0, { type: 'resizeBBox', id: 'p1', box: { x: 0, y: 0, w: 10, h: 10 } })).toBe(s0);
    expect(editorReducer(s0, { type: 'resizeBBox', id: 'b1', box: { x: 0, y: 0, w: Infinity, h: 10 } })).toBe(s0);
  });

  it('moveAnnotation(bbox) は画像端で止まり、箱を変形させない', () => {
    const s0 = base([box('b1', { x: 900, y: 700, w: 80, h: 60 })]);
    const s = editorReducer(s0, { type: 'moveAnnotation', id: 'b1', delta: [200, 200] });
    expect((s.annotations[0] as BBoxAnnotation).box).toEqual({ x: 920, y: 740, w: 80, h: 60 });

    const back = editorReducer(s, { type: 'moveAnnotation', id: 'b1', delta: [-9999, -9999] });
    expect((back.annotations[0] as BBoxAnnotation).box).toEqual({ x: 0, y: 0, w: 80, h: 60 });
  });

  it('moveAnnotation は delta が 0・非有限なら state を変えない', () => {
    const s0 = base([box('b1', { x: 0, y: 0, w: 80, h: 60 })]);
    expect(editorReducer(s0, { type: 'moveAnnotation', id: 'b1', delta: [-5, -5] })).toBe(s0);
    expect(editorReducer(s0, { type: 'moveAnnotation', id: 'b1', delta: [NaN, 0] })).toBe(s0);
    expect(editorReducer(s0, { type: 'moveAnnotation', id: 'zzz', delta: [1, 1] })).toBe(s0);
  });
});

describe('平行移動と頂点編集（line 降格）', () => {
  it('moveAnnotation(polygon) は形状を保ったまま画像内に収まる分だけ動かす', () => {
    const s0 = base([poly('p1', TRI)]);
    const s = editorReducer(s0, { type: 'moveAnnotation', id: 'p1', delta: [-500, 0] });
    expect((s.annotations[0] as PolygonAnnotation).points).toEqual([
      [0, 100],
      [100, 100],
      [50, 200],
    ]);
    expect(s.dirty).toBe(true);
  });

  it('moveAnnotation(line) は lineMeta の中心線も同じ量だけ動かす', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const s = editorReducer(s0, { type: 'moveAnnotation', id, delta: [0, 50] });
    const line = lastLine(s);
    expect(line.lineMeta.branches[0]).toEqual([
      [100, 150],
      [300, 150],
    ]);
    expect(line.kind).toBe('line');
  });

  it('moveVertex は line を polygon に降格させ、履歴は積まない（gesture が担う）', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const pastBefore = s0.past.length;
    const s = editorReducer(s0, { type: 'moveVertex', id, index: 0, point: [120, 120] });
    const a = s.annotations[0];
    expect(a.kind).toBe('polygon');
    expect('lineMeta' in a).toBe(false);
    expect((a as PolygonAnnotation).points[0]).toEqual([120, 120]);
    expect(s.past).toHaveLength(pastBefore);
    expect(s.dirty).toBe(true);
  });

  it('moveVertex は座標をクランプし、範囲外 index / bbox は無視する', () => {
    const s0 = base([poly('p1', TRI), box('b1', { x: 0, y: 0, w: 10, h: 10 })]);
    const s = editorReducer(s0, { type: 'moveVertex', id: 'p1', index: 1, point: [5000, -20] });
    expect((s.annotations[0] as PolygonAnnotation).points[1]).toEqual([IMG_W, 0]);
    expect(editorReducer(s0, { type: 'moveVertex', id: 'p1', index: 9, point: [0, 0] })).toBe(s0);
    expect(editorReducer(s0, { type: 'moveVertex', id: 'b1', index: 0, point: [0, 0] })).toBe(s0);
  });

  it('insertVertex は履歴を積み、line を降格させる', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const before = s0.annotations[0] as LineAnnotation;
    const s = editorReducer(s0, { type: 'insertVertex', id, index: 1, point: [150, 150] });
    const a = s.annotations[0] as PolygonAnnotation;
    expect(a.kind).toBe('polygon');
    expect(a.points).toHaveLength(before.points.length + 1);
    expect(a.points[1]).toEqual([150, 150]);
    expect(s.past).toHaveLength(s0.past.length + 1);
  });

  it('deleteVertex は3点なら無視し、4点なら削除して降格させる', () => {
    const s3 = base([poly('p1', TRI)]);
    expect(editorReducer(s3, { type: 'deleteVertex', id: 'p1', index: 0 })).toBe(s3);

    const quad: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const s = editorReducer(base([poly('p1', quad)]), { type: 'deleteVertex', id: 'p1', index: 1 });
    const a = s.annotations[0] as PolygonAnnotation;
    expect(a.points).toEqual([
      [0, 0],
      [100, 100],
      [0, 100],
    ]);
    expect(s.past).toHaveLength(1);
  });
});

describe('ライン編集（幅・点単位巻き戻し・短縮・分岐削除）', () => {
  it('resizeLine は幅を変えて points を再生成し、履歴は積まない', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const before = lastLine(s0).points;
    const s = editorReducer(s0, { type: 'resizeLine', id, width: 40 });
    const line = lastLine(s);
    expect(line.lineMeta.width).toBe(40);
    expect(line.points).not.toEqual(before);
    expect(s.past).toHaveLength(s0.past.length);
    expect(s.dirty).toBe(true);

    // 同じ幅・非有限・非 line は無変化
    expect(editorReducer(s, { type: 'resizeLine', id, width: 40 })).toBe(s);
    expect(editorReducer(s, { type: 'resizeLine', id, width: NaN })).toBe(s);
  });

  it('popLinePoint は枝→幹の順に削り、枝が2点未満になれば枝ごと消える', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [200, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const branched = apply(
      s0,
      {
        type: 'startDraft',
        point: [200, 100],
        target: { polygonId: id, attach: 'branch', branchIndex: -1, anchor: [200, 100] },
      },
      { type: 'addDraftPoint', point: [200, 200] },
      { type: 'commitDraft' }
    );
    expect(lastLine(branched).lineMeta.branches).toHaveLength(2);

    // 1回目: 枝の末尾点を削ると2点未満 → 枝ごと削除
    const s1 = editorReducer(branched, { type: 'popLinePoint', id });
    expect(lastLine(s1).lineMeta.branches).toHaveLength(1);
    expect(s1.past).toHaveLength(branched.past.length + 1);

    // 2回目: 幹が 3→2 点
    const s2 = editorReducer(s1, { type: 'popLinePoint', id });
    expect(lastLine(s2).lineMeta.branches[0]).toEqual([
      [100, 100],
      [200, 100],
    ]);
  });

  it('popLinePoint で幹が退化するとアノテーションごと消え、選択も外れる', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const selected = editorReducer(s0, { type: 'select', id });
    const s = editorReducer(selected, { type: 'popLinePoint', id });
    expect(s.annotations).toHaveLength(0);
    expect(s.selectedId).toBeNull();
    expect(s.dirty).toBe(true);
    expect(s.past).toHaveLength(selected.past.length + 1);
  });

  it('popLinePoint は line 以外・存在しない id を無視する', () => {
    const s0 = base([poly('p1', TRI)]);
    expect(editorReducer(s0, { type: 'popLinePoint', id: 'p1' })).toBe(s0);
    expect(editorReducer(s0, { type: 'popLinePoint', id: 'zz' })).toBe(s0);
  });

  it('cutLine は指定側を残して短縮し、枝の end 側保持は拒否する', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [200, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const s = editorReducer(s0, {
      type: 'cutLine',
      id,
      branchIndex: 0,
      segIndex: 1,
      t: 0.5,
      keep: 'start',
    });
    expect(lastLine(s).lineMeta.branches[0]).toEqual([
      [100, 100],
      [200, 100],
      [250, 100],
    ]);
    expect(s.past).toHaveLength(s0.past.length + 1);

    expect(
      editorReducer(s0, { type: 'cutLine', id, branchIndex: 1, segIndex: 0, t: 0.5, keep: 'end' })
    ).toBe(s0);
    expect(
      editorReducer(s0, { type: 'cutLine', id, branchIndex: 0, segIndex: 9, t: 0.5, keep: 'start' })
    ).toBe(s0);
  });

  it('deleteBranch は分岐だけを消す（branchIndex<1 は無視）', () => {
    const s0 = drawLine(base(), [
      [100, 100],
      [200, 100],
      [300, 100],
    ]);
    const id = lastLine(s0).id;
    const branched = apply(
      s0,
      {
        type: 'startDraft',
        point: [200, 100],
        target: { polygonId: id, attach: 'branch', branchIndex: -1, anchor: [200, 100] },
      },
      { type: 'addDraftPoint', point: [200, 200] },
      { type: 'commitDraft' }
    );
    expect(editorReducer(branched, { type: 'deleteBranch', id, branchIndex: 0 })).toBe(branched);

    const s = editorReducer(branched, { type: 'deleteBranch', id, branchIndex: 1 });
    expect(lastLine(s).lineMeta.branches).toHaveLength(1);
    expect(s.past).toHaveLength(branched.past.length + 1);
  });
});

describe('削除・表示・保存', () => {
  it('deleteAnnotation は削除して選択を外し、存在しない id は無視する', () => {
    const s0 = apply(base([poly('p1', TRI)]), { type: 'select', id: 'p1' });
    const s = editorReducer(s0, { type: 'deleteAnnotation', id: 'p1' });
    expect(s.annotations).toEqual([]);
    expect(s.selectedId).toBeNull();
    expect(s.past).toHaveLength(1);
    expect(s.dirty).toBe(true);
    expect(editorReducer(s0, { type: 'deleteAnnotation', id: 'zz' })).toBe(s0);
  });

  it('toggleFill は表示だけを切り替え、markSaved は dirty と gesture を落とす', () => {
    const s = editorReducer(base(), { type: 'toggleFill' });
    expect(s.fillVisible).toBe(false);
    expect(s.dirty).toBe(false);

    const dirty = apply(
      base([poly('p1', TRI)]),
      { type: 'beginGesture' },
      { type: 'moveAnnotation', id: 'p1', delta: [10, 10] },
      { type: 'markSaved' }
    );
    expect(dirty.dirty).toBe(false);
    expect(dirty.gestureActive).toBe(false);
  });
});

describe('undo / redo と gesture の履歴意味論', () => {
  it('undo / redo が annotations を往復させる', () => {
    const s0 = base([poly('p1', TRI)]);
    const added = editorReducer(s0, {
      type: 'addAnnotation',
      annotation: box('b1', { x: 0, y: 0, w: 50, h: 50 }),
    });
    const undone = editorReducer(added, { type: 'undo' });
    expect(undone.annotations).toHaveLength(1);
    expect(undone.selectedId).toBeNull(); // 消えたアノテーションの選択は外れる
    expect(undone.future).toHaveLength(1);
    // load 直後の内容まで戻ったので未保存ではない（dirty の定義どおり）
    expect(undone.dirty).toBe(false);

    const redone = editorReducer(undone, { type: 'redo' });
    expect(redone.annotations).toHaveLength(2);
    expect(redone.future).toEqual([]);
    expect(redone.past).toHaveLength(1);
  });

  it('履歴が空なら undo / redo は無視される', () => {
    const s0 = base([poly('p1', TRI)]);
    expect(editorReducer(s0, { type: 'undo' })).toBe(s0);
    expect(editorReducer(s0, { type: 'redo' })).toBe(s0);
  });

  it('新しい操作は future を捨てる', () => {
    const s = apply(
      base(),
      { type: 'addAnnotation', annotation: box('b1', { x: 0, y: 0, w: 50, h: 50 }) },
      { type: 'undo' },
      { type: 'addAnnotation', annotation: box('b2', { x: 100, y: 100, w: 50, h: 50 }) }
    );
    expect(s.future).toEqual([]);
    expect(s.annotations).toHaveLength(1);
    expect(s.annotations[0].id).toBe('b2');
  });

  it('無変化ドラッグは beginGesture で積んだ履歴を破棄し dirty を復元する', () => {
    const s0 = base([poly('p1', TRI)]);
    expect(s0.dirty).toBe(false);
    const begun = editorReducer(s0, { type: 'beginGesture' });
    expect(begun.past).toHaveLength(1);
    expect(begun.gestureDirtyBefore).toBe(false);

    // 端に張り付いていて実際には動かないドラッグ
    const moved = editorReducer(begun, { type: 'moveAnnotation', id: 'p1', delta: [0, 0] });
    const ended = editorReducer(moved, { type: 'endGesture' });
    expect(ended.past).toEqual([]);
    expect(ended.dirty).toBe(false);
    expect(ended.gestureActive).toBe(false);
  });

  it('変化のあったドラッグは履歴を1つだけ残す（連続 move で増えない）', () => {
    const s = apply(
      base([poly('p1', TRI)]),
      { type: 'beginGesture' },
      { type: 'moveAnnotation', id: 'p1', delta: [10, 0] },
      { type: 'moveAnnotation', id: 'p1', delta: [10, 0] },
      { type: 'moveAnnotation', id: 'p1', delta: [10, 0] },
      { type: 'endGesture' }
    );
    expect(s.past).toHaveLength(1);
    expect(s.dirty).toBe(true);
    expect((s.annotations[0] as PolygonAnnotation).points[0]).toEqual([130, 100]);

    const undone = editorReducer(s, { type: 'undo' });
    expect((undone.annotations[0] as PolygonAnnotation).points).toEqual(TRI);
  });

  it('保存済みからの無変化ドラッグでも dirty が立たない（gestureDirtyBefore 復元）', () => {
    const s = apply(
      base([poly('p1', TRI)]),
      { type: 'moveAnnotation', id: 'p1', delta: [10, 10] },
      { type: 'markSaved' },
      { type: 'beginGesture' },
      { type: 'endGesture' }
    );
    expect(s.dirty).toBe(false);
    expect(s.past).toEqual([]);
  });

  it('ドラッグ中の undo / redo は無視される', () => {
    const moved = apply(
      base([poly('p1', TRI)]),
      { type: 'addAnnotation', annotation: box('b1', { x: 0, y: 0, w: 50, h: 50 }) },
      { type: 'beginGesture' },
      { type: 'moveAnnotation', id: 'p1', delta: [10, 10] }
    );
    expect(editorReducer(moved, { type: 'undo' })).toBe(moved);
    expect(editorReducer(moved, { type: 'redo' })).toBe(moved);
    // endGesture 後は効く
    const ended = editorReducer(moved, { type: 'endGesture' });
    expect(editorReducer(ended, { type: 'undo' }).annotations).toHaveLength(2);
  });

  it('gesture 外の endGesture は無視される', () => {
    const s0 = base([poly('p1', TRI)]);
    expect(editorReducer(s0, { type: 'endGesture' })).toBe(s0);
  });

  // --- 修正バッチB 項目1: 無変化ジェスチャで redo 履歴が消える回帰 ---

  it('undo 直後の「動かさずに離すだけ」のドラッグで redo が消えない', () => {
    const s0 = apply(
      base([poly('p1', TRI)]),
      { type: 'addAnnotation', annotation: box('b1', { x: 0, y: 0, w: 50, h: 50 }) },
      { type: 'undo' }
    );
    expect(s0.future).toHaveLength(1);

    // ポリゴンを掴んで動かさずに離す（クリックしただけ）
    const clicked = apply(
      s0,
      { type: 'beginGesture' },
      { type: 'moveAnnotation', id: 'p1', delta: [0, 0] },
      { type: 'endGesture' }
    );
    expect(clicked.future).toHaveLength(1); // redo が生き残る
    expect(clicked.past).toEqual([]);

    const redone = editorReducer(clicked, { type: 'redo' });
    expect(redone.annotations).toHaveLength(2);
  });

  it('変化のあったドラッグは redo 履歴を破棄する（新しい分岐なので正しい）', () => {
    const s0 = apply(
      base([poly('p1', TRI)]),
      { type: 'addAnnotation', annotation: box('b1', { x: 0, y: 0, w: 50, h: 50 }) },
      { type: 'undo' }
    );
    expect(s0.future).toHaveLength(1);

    const dragged = apply(
      s0,
      { type: 'beginGesture' },
      { type: 'moveAnnotation', id: 'p1', delta: [10, 10] },
      { type: 'endGesture' }
    );
    expect(dragged.future).toEqual([]);
    expect(editorReducer(dragged, { type: 'redo' })).toBe(dragged);
  });

  it('無変化ジェスチャを何度繰り返しても redo が保たれる', () => {
    let s = apply(
      base([poly('p1', TRI)]),
      { type: 'addAnnotation', annotation: box('b1', { x: 0, y: 0, w: 50, h: 50 }) },
      { type: 'undo' }
    );
    for (let i = 0; i < 5; i++) {
      s = apply(s, { type: 'beginGesture' }, { type: 'endGesture' });
    }
    expect(s.future).toHaveLength(1);
    expect(editorReducer(s, { type: 'redo' }).annotations).toHaveLength(2);
  });

  // --- 修正バッチB 項目2: undo で保存時点に戻ったら dirty を下ろす ---

  it('保存 → 編集 → undo で保存時点に戻ると dirty が false になる', () => {
    const saved = apply(base([poly('p1', TRI)]), { type: 'markSaved' });
    const edited = editorReducer(saved, {
      type: 'addAnnotation',
      annotation: box('b1', { x: 0, y: 0, w: 50, h: 50 }),
    });
    expect(edited.dirty).toBe(true);

    const undone = editorReducer(edited, { type: 'undo' });
    expect(undone.dirty).toBe(false);

    // redo で保存時点から離れれば再び dirty
    expect(editorReducer(undone, { type: 'redo' }).dirty).toBe(true);
  });

  it('保存時点が履歴の途中にあっても dirty を正しく判定する', () => {
    // 編集A → 保存 → 編集B → undo(=A に戻る=保存時点) → undo(=初期に戻る)
    const afterA = editorReducer(base([poly('p1', TRI)]), {
      type: 'addAnnotation',
      annotation: box('a', { x: 0, y: 0, w: 50, h: 50 }),
    });
    const saved = editorReducer(afterA, { type: 'markSaved' });
    const afterB = editorReducer(saved, {
      type: 'addAnnotation',
      annotation: box('b', { x: 100, y: 100, w: 50, h: 50 }),
    });
    expect(afterB.dirty).toBe(true);

    const backToA = editorReducer(afterB, { type: 'undo' });
    expect(backToA.annotations.map((x) => x.id)).toEqual(['p1', 'a']);
    expect(backToA.dirty).toBe(false); // 保存時点と一致

    const backToInitial = editorReducer(backToA, { type: 'undo' });
    expect(backToInitial.annotations.map((x) => x.id)).toEqual(['p1']);
    expect(backToInitial.dirty).toBe(true); // 保存時点より前＝未保存の変更あり
  });

  it('load 直後の状態も保存時点として扱われる（markSaved 不要）', () => {
    const s = apply(
      base([poly('p1', TRI)]),
      { type: 'deleteAnnotation', id: 'p1' },
      { type: 'undo' }
    );
    expect(s.annotations).toHaveLength(1);
    expect(s.dirty).toBe(false);
  });

  it('load は保存時点スナップショットを新しい画像のもので置き換える', () => {
    const dirtied = apply(
      base([poly('p1', TRI)]),
      { type: 'addAnnotation', annotation: box('b1', { x: 0, y: 0, w: 50, h: 50 }) },
      { type: 'markSaved' }
    );
    const reloaded = editorReducer(dirtied, {
      type: 'load',
      annotations: [poly('q1', TRI)],
      imageWidth: IMG_W,
      imageHeight: IMG_H,
    });
    expect(reloaded.savedAnnotations).toBe(reloaded.annotations);
    expect(reloaded.dirty).toBe(false);
  });

  it('保存時点とは別オブジェクトでも「値が同じ」なら dirty が下りる（参照比較ではない）', () => {
    // A(初期) → ドラッグで B → 逆方向ドラッグで C（値は A と同一だが別オブジェクト）→ C で保存。
    // ここから undo で A に戻ると、savedAnnotations(=C) とは別オブジェクトだが値が等しい。
    const a = base([poly('p1', TRI)]);
    const b = apply(
      a,
      { type: 'beginGesture' },
      { type: 'moveAnnotation', id: 'p1', delta: [10, 10] },
      { type: 'endGesture' }
    );
    const c = apply(
      b,
      { type: 'beginGesture' },
      { type: 'moveAnnotation', id: 'p1', delta: [-10, -10] },
      { type: 'endGesture' }
    );
    const saved = editorReducer(c, { type: 'markSaved' });
    expect(saved.dirty).toBe(false);
    expect(saved.savedAnnotations).not.toBe(a.annotations); // 別オブジェクト
    expect(saved.savedAnnotations).toEqual(a.annotations); // 値は同じ

    const backToB = editorReducer(saved, { type: 'undo' });
    expect(backToB.dirty).toBe(true); // B は保存時点と違う

    const backToA = editorReducer(backToB, { type: 'undo' });
    expect(backToA.annotations).toBe(a.annotations);
    expect(backToA.dirty).toBe(false); // 値が保存時点と一致するので未保存ではない
  });

  it('履歴は HISTORY_LIMIT 段で打ち切られる', () => {
    let s = base();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      s = editorReducer(s, {
        type: 'addAnnotation',
        annotation: box(`b${i}`, { x: i, y: 0, w: 20, h: 20 }),
      });
    }
    expect(s.annotations).toHaveLength(HISTORY_LIMIT + 5);
    expect(s.past).toHaveLength(HISTORY_LIMIT);
    // 最古のスナップショットは捨てられている（空配列ではなくなっている）
    expect(s.past[0].length).toBeGreaterThan(0);
  });
});
