// =============================================================================
// エディタ状態リデューサ（M2）
//
// 出自: reference/frontend/src/hooks/useAnnotationEditor.ts の reducer を忠実に移植。
// 契約: src/core/types.ts の EditorState / EditorAction（変更禁止）。
//
// 参照実装からの差分（意図的なものはこれだけ。それ以外は挙動を1:1で保存している）:
//   1. Polygon → Annotation 判別可能ユニオン（kind: 'bbox' | 'polygon' | 'line'）。
//      旧 `lineMeta` 付き Polygon = kind:'line' / 無し = kind:'polygon' に対応する。
//   2. アクション改名: movePolygon → moveAnnotation / deletePolygon → deleteAnnotation。
//   3. 追加アクション: addAnnotation（bbox 確定・将来のインポート）/ resizeBBox。
//   4. 非有限値（NaN/Infinity）が state に入らないよう入口で弾く（参照実装は素通ししていた）。
//   5. 平行移動・クランプは bbox では「箱を変形させず位置だけ動かす」（形状不変の原則を踏襲）。
//
// React 非依存の純関数。副作用は crypto.randomUUID() のみ（id 生成）。
// =============================================================================

import type {
  Annotation,
  BBox,
  DraftState,
  EditorAction,
  EditorState,
  LineAnnotation,
  LineMeta,
  PolygonAnnotation,
  Pt,
} from '../core/types';
import { BBOX_MIN_SIZE, HISTORY_LIMIT, LINE_WIDTH_MAX, LINE_WIDTH_MIN } from '../core/types';
import { clampBBoxToImage } from '../core/geometry';
import {
  connectedBranchIndices,
  normalizedWidths,
  regenLinePolygon,
  trimLineTail,
} from '../core/lineShape';

const DUP_EPS = 0.5; // 終端重複頂点の判定距離 [px]（参照実装と同値）
// 点ごとの局所幅の許容範囲（代表幅より細かく許す）。
// 参照実装 2026-07-15 FB: 2→1.5 でヘアライン芯に張り付く（Canvas の WIDTH_EST_MIN と一致）。
const LOCAL_WIDTH_MIN = 1.5;
const LOCAL_WIDTH_MAX = 200;

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/**
 * crypto.randomUUID()。未提供環境（古い Node 等）でも落ちないようフォールバックを持つ。
 * 型注釈 `Crypto` を使わないのは serialize.ts と同じ理由（DOM lib 依存を持ち込まないため）。
 */
function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 非有限値は lo に落としてから [lo,hi] にクランプ（NaN を state に入れない） */
function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

function clampPt(p: Pt, w: number, h: number): Pt {
  return [clampNum(p[0], 0, w), clampNum(p[1], 0, h)];
}

const clampLocalW = (w: number): number => clampNum(w, LOCAL_WIDTH_MIN, LOCAL_WIDTH_MAX);

const clampLineW = (w: number): number => clampNum(w, LINE_WIDTH_MIN, LINE_WIDTH_MAX);

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

/** points を持つ kind（bbox 以外）か */
function hasPoints(a: Annotation): a is PolygonAnnotation | LineAnnotation {
  return a.kind === 'polygon' || a.kind === 'line';
}

function isLine(a: Annotation | undefined): a is LineAnnotation {
  return a !== undefined && a.kind === 'line';
}

/** 頂点手編集による polygon への降格（lineMeta 破棄。参照実装の lineMeta: undefined と同義） */
function demoteToPolygon(a: PolygonAnnotation | LineAnnotation, points: Pt[]): PolygonAnnotation {
  return { id: a.id, classId: a.classId, source: a.source, kind: 'polygon', points };
}

function replaceById(list: Annotation[], id: string, next: Annotation): Annotation[] {
  return list.map((a) => (a.id === id ? next : a));
}

/** id を差し替えた同一アノテーション（kind ごとに narrow してユニオンの spread を避ける） */
function withId(a: Annotation, id: string): Annotation {
  if (a.id === id) return a;
  if (a.kind === 'bbox') return { ...a, id };
  if (a.kind === 'line') return { ...a, id };
  return { ...a, id };
}

/** draft.widths を points と同数に正規化（不足分は lineWidth で埋める） */
function draftWidths(draft: DraftState): number[] {
  const ws = draft.widths ?? [];
  const out: number[] = [];
  for (let i = 0; i < draft.points.length; i++) out.push(clampLocalW(ws[i] ?? draft.lineWidth));
  return out;
}

/**
 * widths が代表幅 rep の一様配列なら widths を省略した LineMeta を返す。
 * 旧データ・非マグネット線はスカラー width のまま＝ペイロード最小・完全後方互換。
 */
function packMeta(branches: Pt[][], widthsAll: number[][], rep: number): LineMeta {
  const uniform = widthsAll.every((ws) => ws.every((w) => Math.abs(w - rep) < 1e-9));
  return uniform ? { branches, width: rep } : { branches, width: rep, widths: widthsAll };
}

/** 連続する重複頂点（距離 < eps）を除去 */
function collapseDuplicates(points: Pt[], eps = DUP_EPS): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= eps) out.push(p);
  }
  return out;
}

/** collapseDuplicates の widths 平行版（点と幅の対応を保ったまま重複除去） */
function collapseDuplicatesWithWidths(
  points: Pt[],
  widths: number[],
  eps = DUP_EPS
): { pts: Pt[]; ws: number[] } {
  const pts: Pt[] = [];
  const ws: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= eps) {
      pts.push(p);
      ws.push(widths[i] ?? widths[widths.length - 1] ?? 0);
    }
  }
  return { pts, ws };
}

/** polygon 用: 連続重複 + 始点と重なる終端頂点（ダブルクリック確定分）を除去 */
export function effectivePolygonPoints(points: Pt[]): Pt[] {
  const out = collapseDuplicates(points);
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < DUP_EPS) out.pop();
    else break;
  }
  return out;
}

/** draft が commit 可能か（polygon: 終端重複除去後 ≥3点 / line: ≥2点） */
export function draftCommittable(draft: DraftState | null): boolean {
  if (!draft) return false;
  if (draft.tool === 'polygon') return effectivePolygonPoints(draft.points).length >= 3;
  return collapseDuplicates(draft.points).length >= 2;
}

function boxEqual(a: BBox, b: BBox): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function ptsEqual(a: Pt[], b: Pt[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

function metaEqual(a: LineMeta, b: LineMeta): boolean {
  if (a === b) return true;
  if (a.width !== b.width || a.branches.length !== b.branches.length) return false;
  for (let i = 0; i < a.branches.length; i++) {
    if (!ptsEqual(a.branches[i], b.branches[i])) return false;
    const wa = normalizedWidths(a, i);
    const wb = normalizedWidths(b, i);
    if (wa.length !== wb.length) return false;
    for (let j = 0; j < wa.length; j++) if (wa[j] !== wb[j]) return false;
  }
  return true;
}

/**
 * annotations スナップショット同士の深い等価判定（無変化ドラッグの検出用）。
 * 参照実装の polygonsEqual に bbox（box 比較）と lineMeta 比較を足したもの。
 * lineMeta まで見るのは「幅だけ変えて points が偶然一致」を無変化と誤判定しないため。
 */
export function annotationsEqual(a: Annotation[], b: Annotation[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    if (pa === pb) continue;
    if (pa.id !== pb.id || pa.classId !== pb.classId || pa.source !== pb.source) return false;
    if (pa.kind !== pb.kind) return false;
    if (pa.kind === 'bbox' && pb.kind === 'bbox') {
      if (!boxEqual(pa.box, pb.box)) return false;
      continue;
    }
    if (!hasPoints(pa) || !hasPoints(pb)) return false;
    if (!ptsEqual(pa.points, pb.points)) return false;
    if (pa.kind === 'line' && pb.kind === 'line' && !metaEqual(pa.lineMeta, pb.lineMeta)) {
      return false;
    }
  }
  return true;
}

/** undo 履歴に現在の annotations を積む（上限 HISTORY_LIMIT） */
function pushPast(state: EditorState): Annotation[][] {
  const past = [...state.past, state.annotations];
  return past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
}

// ---------------------------------------------------------------------------
// アノテーションの検証・クランプ（addAnnotation / load 用）
// ---------------------------------------------------------------------------

/** 負の w/h を正規化し、非有限なら null。画像内クランプは呼び出し側で行う */
function normalizeBox(box: BBox | undefined): BBox | null {
  if (!box || !isNum(box.x) || !isNum(box.y) || !isNum(box.w) || !isNum(box.h)) return null;
  return {
    x: Math.min(box.x, box.x + box.w),
    y: Math.min(box.y, box.y + box.h),
    w: Math.abs(box.w),
    h: Math.abs(box.h),
  };
}

function clampBranches(branches: Pt[][], w: number, h: number): Pt[][] {
  return branches.map((br) => br.map((p) => clampPt(p, w, h)));
}

/**
 * 外部から渡されたアノテーションを画像内にクランプして検証する（addAnnotation）。
 * - bbox: BBOX_MIN_SIZE 未満・非有限は null（＝確定しない。契約の BBOX_MIN_SIZE 注記どおり）
 * - polygon: 3点未満は null
 * - line: lineMeta が不正なら polygon に降格（頂点だけは残す＝全損させない）
 */
function sanitizeAnnotation(a: Annotation, imgW: number, imgH: number): Annotation | null {
  if (a.kind === 'bbox') {
    const norm = normalizeBox(a.box);
    if (!norm) return null;
    const box = clampBBoxToImage(norm, imgW, imgH);
    if (box.w < BBOX_MIN_SIZE || box.h < BBOX_MIN_SIZE) return null;
    return { id: a.id, classId: a.classId, source: a.source, kind: 'bbox', box };
  }
  if (!Array.isArray(a.points) || a.points.length < 3) return null;
  if (a.points.some((p) => !Array.isArray(p) || !isNum(p[0]) || !isNum(p[1]))) return null;
  const points = a.points.map((p) => clampPt(p, imgW, imgH));
  if (a.kind === 'line') {
    const meta = a.lineMeta;
    const ok =
      meta &&
      isNum(meta.width) &&
      meta.width > 0 &&
      Array.isArray(meta.branches) &&
      meta.branches.length > 0 &&
      meta.branches.every(
        (br) =>
          Array.isArray(br) && br.length >= 2 && br.every((p) => isNum(p[0]) && isNum(p[1]))
      );
    if (!ok) return demoteToPolygon(a, points);
    const lineMeta: LineMeta = {
      branches: clampBranches(meta.branches, imgW, imgH),
      width: clampLineW(meta.width),
      ...(meta.widths ? { widths: meta.widths.map((br) => br.slice()) } : {}),
    };
    return { id: a.id, classId: a.classId, source: a.source, kind: 'line', points, lineMeta };
  }
  return { id: a.id, classId: a.classId, source: a.source, kind: 'polygon', points };
}

/** load 用: 座標を画像内にクランプするだけ（レコードは落とさない。検証は serialize.ts の責務） */
function clampAnnotation(a: Annotation, imgW: number, imgH: number): Annotation {
  if (a.kind === 'bbox') {
    return { ...a, box: clampBBoxToImage(normalizeBox(a.box) ?? { x: 0, y: 0, w: 0, h: 0 }, imgW, imgH) };
  }
  const points = a.points.map((p) => clampPt(p, imgW, imgH));
  if (a.kind === 'line') {
    return {
      ...a,
      points,
      lineMeta: { ...a.lineMeta, branches: clampBranches(a.lineMeta.branches, imgW, imgH) },
    };
  }
  return { ...a, points };
}

// ---------------------------------------------------------------------------
// 初期状態
// ---------------------------------------------------------------------------

/**
 * エディタ初期状態のファクトリ。
 * drawTool/lineWidth の既定は docs/DESIGN.md の既定ツール（line）・
 * createDefaultProject の lineWidthDefault（12）に合わせてある。
 * プロジェクト設定を反映したい場合は overrides で上書きする。
 */
export function createInitialEditorState(overrides?: Partial<EditorState>): EditorState {
  return {
    annotations: [],
    selectedId: null,
    mode: 'edit',
    drawTool: 'line',
    activeClassId: 0,
    lineWidth: 12,
    draft: null,
    fillVisible: true,
    dirty: false,
    imageWidth: 0,
    imageHeight: 0,
    past: [],
    future: [],
    gestureActive: false,
    gestureDirtyBefore: false,
    savedAnnotations: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// リデューサ
// ---------------------------------------------------------------------------

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'load': {
      // ツール類（mode/drawTool/activeClass/lineWidth/fillVisible）は画像をまたいで維持
      const imgW = isNum(action.imageWidth) ? Math.max(action.imageWidth, 0) : 0;
      const imgH = isNum(action.imageHeight) ? Math.max(action.imageHeight, 0) : 0;
      const annotations = action.annotations.map((a) => clampAnnotation(a, imgW, imgH));
      return {
        ...state,
        annotations,
        // 読み込み直後＝ディスクと一致している状態なので、これが保存時点になる
        savedAnnotations: annotations,
        selectedId: null,
        draft: null,
        dirty: false,
        imageWidth: imgW,
        imageHeight: imgH,
        past: [],
        future: [],
        gestureActive: false,
      };
    }

    case 'setMode':
      return {
        ...state,
        mode: action.mode,
        draft: action.mode === 'edit' ? null : state.draft,
      };

    case 'setDrawTool':
      return {
        ...state,
        drawTool: action.tool,
        mode: 'draw',
        // bbox へ切り替えた場合は draft.tool と必ず一致しないので draft は破棄される
        draft: state.draft && state.draft.tool !== action.tool ? null : state.draft,
      };

    case 'setActiveClass': {
      const next = { ...state, activeClassId: action.classId };
      if (state.selectedId) {
        const target = state.annotations.find((a) => a.id === state.selectedId);
        if (target && target.classId !== action.classId) {
          return {
            ...next,
            annotations: state.annotations.map((a) =>
              a.id === state.selectedId ? { ...a, classId: action.classId } : a
            ),
            past: pushPast(state),
            future: [],
            dirty: true,
          };
        }
      }
      return next;
    }

    case 'setLineWidth': {
      const w = clampLineW(action.width);
      // draft の局所幅は「全体スケール」（形＝プロファイルを保ったまま太さを増減）
      let draft = state.draft;
      if (draft) {
        const old = draft.lineWidth;
        const factor = old > 0 ? w / old : 1;
        const widths = draft.widths?.map((x) => clampLocalW(x * factor));
        draft = { ...draft, lineWidth: w, ...(widths ? { widths } : {}) };
      }
      return { ...state, lineWidth: w, draft };
    }

    case 'startDraft': {
      if (action.target) {
        // 延長/分岐ドラフト: 対象ラインの幅で line 固定・選択維持
        const target = action.target;
        const line = state.annotations.find((a) => a.id === target.polygonId);
        if (!isLine(line)) return state;
        const meta = line.lineMeta;
        // 起点の局所幅: 延長=その端点の幅 / 分岐=代表幅（以降はマグネット推定が入る）
        let w0 = meta.width;
        if (target.attach !== 'branch') {
          const ws = normalizedWidths(meta, target.branchIndex);
          if (ws.length > 0) w0 = target.attach === 'start' ? ws[0] : ws[ws.length - 1];
        }
        return {
          ...state,
          mode: 'draw',
          drawTool: 'line',
          selectedId: line.id,
          draft: {
            tool: 'line',
            points: [clampPt(target.anchor, state.imageWidth, state.imageHeight)],
            lineWidth: meta.width,
            widths: [clampLocalW(w0)],
            target,
          },
        };
      }
      // bbox はドラッグ確定（addAnnotation）で扱うため draft を持たない
      if (state.drawTool === 'bbox') return state;
      return {
        ...state,
        selectedId: null,
        draft: {
          tool: state.drawTool,
          points: [clampPt(action.point, state.imageWidth, state.imageHeight)],
          lineWidth: state.lineWidth,
          widths: [state.lineWidth],
        },
      };
    }

    case 'addDraftPoint': {
      if (!state.draft) return state;
      const ws = draftWidths(state.draft);
      return {
        ...state,
        draft: {
          ...state.draft,
          points: [
            ...state.draft.points,
            clampPt(action.point, state.imageWidth, state.imageHeight),
          ],
          widths: [...ws, clampLocalW(action.width ?? state.draft.lineWidth)],
        },
      };
    }

    case 'popDraftPoint':
      if (!state.draft) return state;
      if (state.draft.points.length <= 1) return { ...state, draft: null };
      return {
        ...state,
        draft: {
          ...state.draft,
          points: state.draft.points.slice(0, -1),
          widths: state.draft.widths?.slice(0, -1),
        },
      };

    case 'commitDraft': {
      const draft = state.draft;
      if (!draft) return state;

      // 延長/分岐ドラフト: 対象ラインの lineMeta にマージして再生成（幅も併合）
      if (draft.target) {
        const t = draft.target;
        const line = state.annotations.find((a) => a.id === t.polygonId);
        const { pts: added, ws: addedWs } = collapseDuplicatesWithWidths(
          draft.points,
          draftWidths(draft)
        );
        if (!isLine(line) || added.length < 2) return state;
        const meta = line.lineMeta;
        const branches = meta.branches.map((b) => b.slice());
        const widthsAll = meta.branches.map((_, i) => normalizedWidths(meta, i));
        if (t.attach === 'branch') {
          branches.push(added);
          widthsAll.push(addedWs);
        } else {
          const bi = t.branchIndex;
          if (!branches[bi]) return state;
          if (t.attach === 'end') {
            branches[bi] = [...branches[bi], ...added.slice(1)];
            widthsAll[bi] = [...widthsAll[bi], ...addedWs.slice(1)];
          } else {
            branches[bi] = [...added.slice(1).reverse(), ...branches[bi]];
            widthsAll[bi] = [...addedWs.slice(1).reverse(), ...widthsAll[bi]];
          }
        }
        const rep = clampLineW(median(widthsAll.flat()));
        const lineMeta = packMeta(branches, widthsAll, rep);
        const points = regenLinePolygon(lineMeta, state.imageWidth, state.imageHeight);
        if (points.length < 3) return state;
        return {
          ...state,
          annotations: replaceById(state.annotations, line.id, { ...line, points, lineMeta }),
          past: pushPast(state),
          future: [],
          dirty: true,
          draft: null,
          mode: 'edit', // 追記後は編集モードに戻す（続けて延長するなら端点を再クリック）
          selectedId: line.id,
        };
      }

      let annotation: Annotation;
      if (draft.tool === 'polygon') {
        const pts = effectivePolygonPoints(draft.points);
        if (pts.length < 3) return state;
        annotation = {
          id: newId(),
          classId: state.activeClassId,
          source: 'manual',
          kind: 'polygon',
          points: pts,
        };
      } else {
        const { pts: line, ws } = collapseDuplicatesWithWidths(draft.points, draftWidths(draft));
        if (line.length < 2) return state;
        // ライン由来は中心線メタデータ（可変幅込み）を保持し、ポリゴンはそこから生成
        const rep = clampLineW(median(ws));
        const lineMeta = packMeta([line], [ws], rep);
        const pts = regenLinePolygon(lineMeta, state.imageWidth, state.imageHeight);
        if (pts.length < 3) return state;
        annotation = {
          id: newId(),
          classId: state.activeClassId,
          source: 'manual',
          kind: 'line',
          points: pts,
          lineMeta,
        };
      }
      // 確定後も draw モード・同ツール・activeClass を維持（連続描画のため）
      return {
        ...state,
        annotations: [...state.annotations, annotation],
        past: pushPast(state),
        future: [],
        dirty: true,
        draft: null,
      };
    }

    case 'cancelDraft':
      if (!state.draft) return state;
      // 延長/分岐ドラフトのキャンセルは編集モードへ戻す（選択は維持）
      return { ...state, draft: null, mode: state.draft.target ? 'edit' : state.mode };

    case 'addAnnotation': {
      // bbox 確定（ドラッグ完了）・将来のインポート用。クランプ・検証してから追加する
      const clean = sanitizeAnnotation(action.annotation, state.imageWidth, state.imageHeight);
      if (!clean) return state;
      // id の欠落・衝突は握り潰さず採番し直す（レコードを落とさない）
      const id =
        clean.id && !state.annotations.some((a) => a.id === clean.id) ? clean.id : newId();
      const added = withId(clean, id);
      return {
        ...state,
        annotations: [...state.annotations, added],
        selectedId: id,
        past: pushPast(state),
        future: [],
        dirty: true,
      };
    }

    case 'resizeBBox': {
      // ハンドルドラッグ中に連続で呼ばれる前提。履歴は beginGesture/endGesture が担う
      const target = state.annotations.find((a) => a.id === action.id);
      if (!target || target.kind !== 'bbox') return state;
      const norm = normalizeBox(action.box);
      if (!norm) return state;
      const box = clampBBoxToImage(
        { x: norm.x, y: norm.y, w: Math.max(norm.w, BBOX_MIN_SIZE), h: Math.max(norm.h, BBOX_MIN_SIZE) },
        state.imageWidth,
        state.imageHeight
      );
      if (boxEqual(box, target.box)) return state;
      return {
        ...state,
        annotations: replaceById(state.annotations, target.id, { ...target, box }),
        dirty: true,
      };
    }

    case 'select':
      return { ...state, selectedId: action.id };

    case 'beginGesture':
      // future をここで破棄しないのは意図的（無変化ドラッグで redo が消える不具合の対策）。
      // 「undo → ポリゴンをクリックして動かさず離す」だけで redo 履歴が失われていた。
      // ジェスチャ中は undo/redo とも gestureActive ガードで無視されるため future は
      // 到達不能であり、実際に変化した場合のみ endGesture で破棄すれば意味論は同じになる。
      // past も同様にジェスチャ中は積みっぱなし（canUndo/canRedo の扱いが past/future で対称になる）。
      return {
        ...state,
        past: pushPast(state),
        gestureActive: true,
        gestureDirtyBefore: state.dirty,
      };

    case 'endGesture': {
      if (!state.gestureActive) return state;
      // 無変化ドラッグなら beginGesture で積んだ履歴を破棄し dirty を復元（future も温存）
      const last = state.past[state.past.length - 1];
      if (last && annotationsEqual(state.annotations, last)) {
        return {
          ...state,
          past: state.past.slice(0, -1),
          dirty: state.gestureDirtyBefore,
          gestureActive: false,
        };
      }
      // 実際に変化した＝新しい分岐なので、ここで初めて redo 履歴を捨てる
      return { ...state, future: [], gestureActive: false };
    }

    case 'moveVertex': {
      const target = state.annotations.find((a) => a.id === action.id);
      if (!target || !hasPoints(target)) return state;
      if (action.index < 0 || action.index >= target.points.length) return state;
      const points = target.points.slice();
      points[action.index] = clampPt(action.point, state.imageWidth, state.imageHeight);
      // 頂点の手編集はライン構造（lineMeta）と矛盾するため解除（通常ポリゴンに降格）
      return {
        ...state,
        annotations: replaceById(state.annotations, target.id, demoteToPolygon(target, points)),
        dirty: true,
      };
    }

    case 'insertVertex': {
      const target = state.annotations.find((a) => a.id === action.id);
      if (!target || !hasPoints(target)) return state;
      if (action.index < 0 || action.index > target.points.length) return state;
      const points = target.points.slice();
      points.splice(action.index, 0, clampPt(action.point, state.imageWidth, state.imageHeight));
      return {
        ...state,
        annotations: replaceById(state.annotations, target.id, demoteToPolygon(target, points)),
        past: pushPast(state),
        future: [],
        dirty: true,
      };
    }

    case 'deleteVertex': {
      const target = state.annotations.find((a) => a.id === action.id);
      if (!target || !hasPoints(target)) return state;
      if (action.index < 0 || action.index >= target.points.length) return state;
      if (target.points.length <= 3) return state; // 3点なら無視
      const points = target.points.filter((_, i) => i !== action.index);
      return {
        ...state,
        annotations: replaceById(state.annotations, target.id, demoteToPolygon(target, points)),
        past: pushPast(state),
        future: [],
        dirty: true,
      };
    }

    case 'moveAnnotation': {
      const target = state.annotations.find((a) => a.id === action.id);
      if (!target) return state;
      if (!isNum(action.delta[0]) || !isNum(action.delta[1])) return state;

      if (target.kind === 'bbox') {
        // 箱は変形させない: polygon と同じ式で delta 自体を「はみ出さない範囲」にクランプ
        // （bbox の x..x+w が points の min..max に対応する）
        const { x, y, w, h } = target.box;
        const dx = Math.min(Math.max(action.delta[0], -x), state.imageWidth - (x + w));
        const dy = Math.min(Math.max(action.delta[1], -y), state.imageHeight - (y + h));
        if (dx === 0 && dy === 0) return state;
        return {
          ...state,
          annotations: replaceById(state.annotations, target.id, {
            ...target,
            box: { x: x + dx, y: y + dy, w, h },
          }),
          dirty: true,
        };
      }

      if (target.points.length === 0) return state;
      // 形状を保つため、はみ出さない範囲に delta 自体をクランプする
      const xs = target.points.map((p) => p[0]);
      const ys = target.points.map((p) => p[1]);
      const dx = Math.min(
        Math.max(action.delta[0], -Math.min(...xs)),
        state.imageWidth - Math.max(...xs)
      );
      const dy = Math.min(
        Math.max(action.delta[1], -Math.min(...ys)),
        state.imageHeight - Math.max(...ys)
      );
      if (dx === 0 && dy === 0) return state;
      const points: Pt[] = target.points.map((p) => [p[0] + dx, p[1] + dy]);
      if (target.kind === 'line') {
        // 平行移動は形状不変なので lineMeta も同じ量だけ移動して維持する（widths は不変）
        const lineMeta: LineMeta = {
          width: target.lineMeta.width,
          branches: target.lineMeta.branches.map((br) =>
            br.map((pt): Pt => [pt[0] + dx, pt[1] + dy])
          ),
          ...(target.lineMeta.widths ? { widths: target.lineMeta.widths } : {}),
        };
        return {
          ...state,
          annotations: replaceById(state.annotations, target.id, { ...target, points, lineMeta }),
          dirty: true,
        };
      }
      return {
        ...state,
        annotations: replaceById(state.annotations, target.id, { ...target, points }),
        dirty: true,
      };
    }

    case 'resizeLine': {
      // lineMeta の幅変更→再生成。履歴は beginGesture/endGesture が担う（連続変更対応）
      // widths がある場合は「全体スケール」（プロファイルの形を保ったまま太さを増減）
      const line = state.annotations.find((a) => a.id === action.id);
      if (!isLine(line)) return state;
      if (!isNum(action.width)) return state;
      const w = clampLineW(action.width);
      const old = line.lineMeta.width;
      if (w === old) return state;
      const factor = old > 0 ? w / old : 1;
      const widths = line.lineMeta.widths?.map((br) => br.map((x) => clampLocalW(x * factor)));
      const lineMeta: LineMeta = {
        branches: line.lineMeta.branches,
        width: w,
        ...(widths ? { widths } : {}),
      };
      const points = regenLinePolygon(lineMeta, state.imageWidth, state.imageHeight);
      if (points.length < 3) return state;
      return {
        ...state,
        annotations: replaceById(state.annotations, line.id, { ...line, points, lineMeta }),
        dirty: true,
      };
    }

    case 'popLinePoint': {
      // 点単位巻き戻し: 選択中ラインの末尾中心線点を1つ削除して再生成（Backspace）。
      // trimLineTail が widths 同期・枝ごと削除・孤立枝除去を担う純関数（DOM非依存・単体検証済み）。
      const line = state.annotations.find((a) => a.id === action.id);
      if (!isLine(line)) return state;
      const removeWhole = (): EditorState => ({
        ...state,
        annotations: state.annotations.filter((a) => a.id !== line.id),
        selectedId: state.selectedId === line.id ? null : state.selectedId,
        past: pushPast(state),
        future: [],
        dirty: true,
      });
      const { branches, widths } = trimLineTail(line.lineMeta);
      if (branches.length === 0) return removeWhole(); // 幹が退化 → ライン全体消滅
      const lineMeta = packMeta(branches, widths, line.lineMeta.width);
      const points = regenLinePolygon(lineMeta, state.imageWidth, state.imageHeight);
      if (points.length < 3) return removeWhole(); // 再生成不能（退化）→ 削除
      return {
        ...state,
        annotations: replaceById(state.annotations, line.id, { ...line, points, lineMeta }),
        past: pushPast(state),
        future: [],
        dirty: true,
      };
    }

    case 'cutLine': {
      // 短縮: 中心線上の点で切断し、指定側を残す。枝（branchIndex>0）は付け根側のみ残せる
      // widths も平行にカット（切断点の幅はセグメント両端の線形補間）
      const line = state.annotations.find((a) => a.id === action.id);
      if (!isLine(line)) return state;
      if (action.branchIndex > 0 && action.keep === 'end') return state;
      const meta = line.lineMeta;
      const br = meta.branches[action.branchIndex];
      if (!br || action.segIndex < 0 || action.segIndex >= br.length - 1) return state;
      const a = br[action.segIndex];
      const b = br[action.segIndex + 1];
      const t = clampNum(action.t, 0, 1);
      const cut: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const brWs = normalizedWidths(meta, action.branchIndex);
      const wCut = brWs[action.segIndex] + (brWs[action.segIndex + 1] - brWs[action.segIndex]) * t;
      let np: Pt[];
      let nw: number[];
      if (action.keep === 'start') {
        np = [...br.slice(0, action.segIndex + 1), cut];
        nw = [...brWs.slice(0, action.segIndex + 1), wCut];
      } else {
        np = [cut, ...br.slice(action.segIndex + 1)];
        nw = [wCut, ...brWs.slice(action.segIndex + 1)];
      }
      const collapsed = collapseDuplicatesWithWidths(np, nw);
      if (collapsed.pts.length < 2) return state;
      const newBranches = meta.branches.map((x, i) =>
        i === action.branchIndex ? collapsed.pts : x
      );
      const newWidthsAll = meta.branches.map((_, i) =>
        i === action.branchIndex ? collapsed.ws : normalizedWidths(meta, i)
      );
      // 幹の短縮で切り離された枝は除去（多段分岐にも対応・widths を index 同期でフィルタ）
      const keptIdx = connectedBranchIndices(newBranches, meta.width);
      const branches = keptIdx.map((i) => newBranches[i]);
      const widthsAll = keptIdx.map((i) => newWidthsAll[i]);
      const lineMeta = packMeta(branches, widthsAll, meta.width);
      const points = regenLinePolygon(lineMeta, state.imageWidth, state.imageHeight);
      if (points.length < 3) return state;
      return {
        ...state,
        annotations: replaceById(state.annotations, line.id, { ...line, points, lineMeta }),
        past: pushPast(state),
        future: [],
        dirty: true,
      };
    }

    case 'deleteBranch': {
      const line = state.annotations.find((a) => a.id === action.id);
      if (!isLine(line) || action.branchIndex < 1) return state;
      const meta = line.lineMeta;
      if (!meta.branches[action.branchIndex]) return state;
      const remBranches = meta.branches.filter((_, i) => i !== action.branchIndex);
      const remWidths = meta.branches
        .map((_, i) => normalizedWidths(meta, i))
        .filter((_, i) => i !== action.branchIndex);
      // ぶら下がり枝も除去（widths を index 同期でフィルタ）
      const keptIdx = connectedBranchIndices(remBranches, meta.width);
      const branches = keptIdx.map((i) => remBranches[i]);
      const widthsAll = keptIdx.map((i) => remWidths[i]);
      const lineMeta = packMeta(branches, widthsAll, meta.width);
      const points = regenLinePolygon(lineMeta, state.imageWidth, state.imageHeight);
      if (points.length < 3) return state;
      return {
        ...state,
        annotations: replaceById(state.annotations, line.id, { ...line, points, lineMeta }),
        past: pushPast(state),
        future: [],
        dirty: true,
      };
    }

    case 'deleteAnnotation': {
      if (!state.annotations.some((a) => a.id === action.id)) return state;
      return {
        ...state,
        annotations: state.annotations.filter((a) => a.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
        past: pushPast(state),
        future: [],
        dirty: true,
      };
    }

    case 'toggleFill':
      return { ...state, fillVisible: !state.fillVisible };

    case 'undo': {
      if (state.gestureActive) return state; // ドラッグ中の undo は不整合を生むため無視
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        ...state,
        annotations: prev,
        past: state.past.slice(0, -1),
        future: [state.annotations, ...state.future],
        selectedId: prev.some((a) => a.id === state.selectedId) ? state.selectedId : null,
        // 保存時点まで巻き戻ったら未保存ではない（契約の dirty 定義を満たす）
        dirty: !annotationsEqual(prev, state.savedAnnotations),
      };
    }

    case 'redo': {
      if (state.gestureActive) return state; // ドラッグ中の redo は不整合を生むため無視
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        ...state,
        annotations: next,
        past: pushPast(state),
        future: state.future.slice(1),
        selectedId: next.some((a) => a.id === state.selectedId) ? state.selectedId : null,
        dirty: !annotationsEqual(next, state.savedAnnotations),
      };
    }

    case 'markSaved':
      // 保存時点のスナップショットを更新（undo/redo の dirty 再計算の基準になる）
      return {
        ...state,
        dirty: false,
        gestureActive: false,
        savedAnnotations: state.annotations,
      };

    default: {
      // 網羅性チェック（EditorAction に追加があればコンパイルエラーで気づく）
      const exhaustive: never = action;
      void exhaustive;
      return state;
    }
  }
}
