// =============================================================================
// AnnotationCanvas — キャンバスエディタ本体（M4・本プロジェクトの最重要モジュール）
//
// 出自: reference/frontend/src/components/annotation/AnnotationCanvas.tsx を忠実に移植。
//   ビュー変換 / DPR / ズーム・パン / ネイティブ wheel / Space パン / 描画順 / ドラフト描画 /
//   ゴーストガイド（Tab 確定）/ マグネットトレース / ライン編集（延長・短縮・分岐）/
//   カーソル管理 / フォーカス喪失時リセット / suppressClickUntil / cutPending UI は全て保存。
//
// 参照実装からの意図的な差分（これ以外は 1:1）:
//   1. 型の適応: st.polygons → st.annotations（Annotation 判別可能ユニオン）。
//      `poly.lineMeta` の有無判定 → `a.kind === 'line'`。movePolygon → moveAnnotation。
//      削除（deletePolygon）は canvas からは行わない（ページ側の責務）。
//   2. bbox ツール（DrawTool 'bbox'）の新規実装。draft は使わず canvas ローカルの
//      ドラッグ状態でラバー矩形 → pointerup で addAnnotation（契約 types.ts の注記どおり）。
//      編集は 8 ハンドル（四隅 + 四辺中点）+ 内部ドラッグ移動。
//   3. マグネット反転モード（magnetInvert）: ROI の ImageData を取得直後に画素反転してから
//      livewire に渡す（明るい線を追う）。livewire 本体は不変。
//   4. 削除: ガイド枠（guides / guideVisible / round4 / singleClass / onAutoClass）。
//      Tailwind → annotationCanvas.css。lucide アイコン依存なし。
//   5. 未知の classId でもクラッシュしない（フォールバック色）。
//
// 重要（M2 からの申し送り）: resizeBBox / moveVertex / moveAnnotation / resizeLine は
//   自身で履歴を積まない。全ドラッグ操作を beginGesture / endGesture で囲むこと。
// 較正定数・ヒット判定・スロットル定数は参照実装の値をそのまま使う（理屈で変えない）。
// =============================================================================

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import type {
  Annotation,
  AnnotationEditorApi,
  BBox,
  ClassDef,
  LineAnnotation,
  PolygonAnnotation,
  Pt,
} from '../core/types';
import { BBOX_MIN_SIZE } from '../core/types';
import {
  bboxContains,
  bboxOfPoints,
  clampBBoxToImage,
  hitTestEdge,
  hitTestPolygon,
  hitTestVertex,
  normalizeBBox,
} from '../core/geometry';
import {
  capWidthsByImagePosition,
  estimateWidthProfile,
  gaussian3,
  snapToRidge,
  toGray,
  traceLivewire,
} from '../core/livewire';
import { lineEndpoints, lineTailTarget, nearestOnBranches } from '../core/lineShape';
import './annotationCanvas.css';

/** ライン編集の一発アーム: 'cut'=次のクリックで短縮、'branch'=次のクリックで分岐開始 */
export type LineEditAction = 'none' | 'cut' | 'branch';

export interface AnnotationCanvasProps {
  imageUrl: string;
  /** naturalWidth（EXIF 適用後）。座標系の基準 */
  imageWidth: number;
  imageHeight: number;
  editor: AnnotationEditorApi;
  classes: ClassDef[];
  /** 明るさ（100 = 等倍 %）。データ非破壊の表示フィルタ */
  brightness: number;
  contrast: number;
  /** インクリメントでフィット実行 */
  fitSignal: number;
  /** マグネットモード ON/OFF（M キー） */
  magnetMode: boolean;
  /** true = 明るい線（白線等）を追う反転モード */
  magnetInvert: boolean;
  /**
   * ライン/多角形の外接ボックス（derived box）を重ねて表示する。
   * yolo_det エクスポートが自動付与する外接矩形のプレビューで、**表示専用**。
   * ヒット判定・保存データには一切影響しない。
   */
  showDerivedBoxes: boolean;
  /** マグネット1区間の draft 頂点数境界スタック（ページ側 Backspace が参照） */
  magnetSegRef: RefObject<number[]>;
  /** ライン編集アーム状態（短縮/分岐は次の中心線クリック1回で実行） */
  lineEditAction: LineEditAction;
  /** アーム済みクリックを消費したらページ側の状態を解除する */
  onLineEditActionDone: () => void;
  /** 暗い筋が無く直線フォールバックしたときの通知（トースト） */
  onMagnetFallback: () => void;
  /** 頂点手編集でライン構造（lineMeta）を解除したときの通知（トースト） */
  onLineMetaDropped: () => void;
  /**
   * モーダル（ヘルプ/エクスポート等）表示中は true。
   * canvas 側 window Tab ハンドラを止め（モーダル内フォーカス移動での背面ドラフト誤確定防止）、
   * ゴーストの計算予約も止めてキャッシュを破棄する。
   */
  shortcutsSuspended?: boolean;
  className?: string;
}

// ---- 参照実装と同一の定数（実画像で較正済み・理屈で変えない） ----
const MAGNET_ROI_MAX = 512; // ROI 長辺の上限 px（縮小して 100ms 級を担保）
const MAGNET_MIN_CHORD_PX = 3; // これ未満のクリックは trace せず通常の点追加
const WIDTH_EST_MIN = 1.5; // 局所幅推定の下限（画像px・editorReducer の LOCAL_WIDTH_MIN と一致）

const VERTEX_HIT_PX = 8; // 頂点ヒット半径（スクリーンpx・ズーム非依存）
const EDGE_HIT_PX = 6; // エッジヒット半径
const SNAP_PX = 10; // draft 始点スナップ半径
const ENDPOINT_HIT_PX = 9; // ライン端点ハンドル（延長）のヒット半径
const CENTERLINE_HIT_PX = 10; // 短縮/分岐アーム時の中心線ヒット半径
const ZOOM_MAX = 32;
const ZOOM_MIN_FIT_RATIO = 0.25;
const DRAG_START_PX = 2; // ここまで動いたら移動ジェスチャ開始（クリック選択と区別）

// ゴーストガイド（マグネット補完プレビュー・Tab確定）の定数
const GHOST_MIN_SCREEN_PX = 12; // アンカーとカーソルがこのスクリーン距離以上でゴースト発動
const GHOST_MIN_INTERVAL_MS = 80; // 再トレースの最小間隔（rAF 上で時間ゲート）
const GHOST_MIN_MOVE_PX = 2; // 前回計算位置から画像座標でこの距離以上動いたら再計算
const GHOST_RIBBON_ALPHA = 0.15; // ゴーストリボンのプレビュー不透明度
const GHOST_SNAP_CHORD_FRAC = 0.2; // スナップ半径 = コード長×この係数（下限/上限でclamp・画像px）
const GHOST_SNAP_MIN_PX = 4;
const GHOST_SNAP_MAX_PX = 28;

// ---- 外接ボックス（derived box）プレビュー ----
// エクスポート（yolo_det）が自動付与する外接矩形と同じものを、細い破線で重ねるだけの表示。
// 選択中だけ少し濃く・太くして、どのアノテーション由来の枠か分かるようにする。
const DERIVED_BOX_DASH = [5, 4];
const DERIVED_BOX_LINE_WIDTH = 1.5;
const DERIVED_BOX_LINE_WIDTH_SELECTED = 2;
const DERIVED_BOX_ALPHA = 0.75;
const DERIVED_BOX_ALPHA_SELECTED = 0.95;

// ---- bbox（M4 追加分） ----
const BBOX_HANDLE_PX = 8; // ハンドルの一辺（スクリーンpx）
const BBOX_HANDLE_HIT_PX = 8; // ハンドルのヒット半径（スクリーンpx・ズーム非依存）
const BBOX_DRAFT_FILL_ALPHA = 0.12; // ドラッグ中ラバー矩形の塗り

/** 未知の class_id・不正な色コードのフォールバック（M2/M3 申し送り: 未知 class_id は通ってくる） */
const FALLBACK_CLASS_COLOR = '#5F6B77';

/** ゴースト計算結果のキャッシュ（描画・Tab確定で共有／陳腐化検査に anchor を保持）。 */
interface GhostCache {
  anchor: Pt; // 計算時のアンカー（draft 末尾点。消費時に現在のアンカーと一致検査）
  cursor: Pt; // 計算時のカーソル（画像座標）
  pointsToAdd: Pt[]; // anchor を除く追加頂点列（末尾＝スナップ先ターゲット）
  widthsToAdd: number[] | null; // pointsToAdd と平行な点ごと局所幅（無ければ一様）
  estWidth: number | null; // 区間の代表幅（最初の区間で自動初期幅に使う）
  fellBack: boolean; // 暗い筋が無く直線化したか（リボン無しの直線破線で描く）
  sampled: boolean; // 画素読取に成功したか（fellBack && sampled でトースト）
}

interface ViewState {
  scale: number; // 画像px → スクリーンpx
  offsetX: number;
  offsetY: number;
}

/** bbox の 8 ハンドル（四隅 + 四辺中点） */
type BBoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const BBOX_HANDLES: BBoxHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const BBOX_HANDLE_CURSOR: Record<BBoxHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};
/** ハンドルごとに「動く辺」。動かない辺が固定側（対角/辺のアンカー）になる */
const BBOX_HANDLE_EDGES: Record<
  BBoxHandle,
  { left: boolean; right: boolean; top: boolean; bottom: boolean }
> = {
  nw: { left: true, right: false, top: true, bottom: false },
  n: { left: false, right: false, top: true, bottom: false },
  ne: { left: false, right: true, top: true, bottom: false },
  e: { left: false, right: true, top: false, bottom: false },
  se: { left: false, right: true, top: false, bottom: true },
  s: { left: false, right: false, top: false, bottom: true },
  sw: { left: true, right: false, top: false, bottom: true },
  w: { left: true, right: false, top: false, bottom: false },
};

type DragState =
  | { kind: 'pan'; lastX: number; lastY: number }
  | {
      kind: 'vertex';
      id: string;
      index: number;
      startImg: Pt; // DRAG_START_PX 判定用（微小揺れで履歴を積まない）
      started: boolean;
      hadLineMeta: boolean;
    }
  // 参照実装の kind:'polygon'（全体移動）。bbox も動かすため 'move' に改名しただけで意味論は同一
  | { kind: 'move'; id: string; startImg: Pt; lastImg: Pt; started: boolean }
  // bbox 描画（store の draft は使わない・pointer capture 中のみ存続）
  | { kind: 'bboxDraw'; startImg: Pt; canceled: boolean }
  // bbox の 8 ハンドルリサイズ。
  //   box    = 直前に確定した箱（固定辺の基準。反転時はここも入れ替えて固定辺を保つ）
  //   handle = 現在ドラッグ中の辺の方角（反対辺を越えたら反転後の方角に更新される）
  | {
      kind: 'bboxHandle';
      id: string;
      handle: BBoxHandle;
      box: BBox;
      startImg: Pt;
      started: boolean;
    };

/** 短縮の確定待ち状態（残す側の選択 UI 表示中） */
interface CutPending {
  polygonId: string;
  branchIndex: number;
  segIndex: number;
  t: number;
  point: Pt; // 画像座標（オーバーレイ位置）
}

const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

/** '#RRGGBB' → rgba()。不正な色は落とさずフォールバック色に置き換える（クラッシュ防止） */
function hexToRgba(hex: string, alpha: number): string {
  const src = HEX6_RE.test(hex) ? hex : FALLBACK_CLASS_COLOR;
  const v = parseInt(src.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

/**
 * フォーム入力中か（ショートカットを無効化する対象）。
 * contenteditable も含める（DESIGN §6 罠#11: Backspace/Tab 等の誤爆防止）。
 */
function isFormTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  return el.isContentEditable === true;
}

/** IME 変換中のキーイベントか（変換確定の Enter/Backspace でショートカットを誤爆させない） */
function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/** points を持つ kind（bbox 以外）か */
function hasPoints(a: Annotation | undefined): a is PolygonAnnotation | LineAnnotation {
  return a !== undefined && (a.kind === 'polygon' || a.kind === 'line');
}

function isLine(a: Annotation | undefined): a is LineAnnotation {
  return a !== undefined && a.kind === 'line';
}

/** bbox の 4 隅（画像座標・左上から時計回り） */
function bboxCorners(box: BBox): Pt[] {
  return [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ];
}

/** ハンドルの中心（画像座標） */
function bboxHandlePoint(box: BBox, h: BBoxHandle): Pt {
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  switch (h) {
    case 'nw':
      return [x0, y0];
    case 'n':
      return [cx, y0];
    case 'ne':
      return [x1, y0];
    case 'e':
      return [x1, cy];
    case 'se':
      return [x1, y1];
    case 's':
      return [cx, y1];
    case 'sw':
      return [x0, y1];
    case 'w':
      return [x0, cy];
  }
}

/**
 * ハンドルドラッグ後の箱。動く辺だけをカーソル位置に置き換え、normalizeBBox で正規化する。
 * 右端を左端より左へ引くと min/max が入れ替わる＝アンカーが自然に切り替わる（反転操作の許容）。
 */
function resizedBBox(start: BBox, h: BBoxHandle, cur: Pt): BBox {
  const e = BBOX_HANDLE_EDGES[h];
  const x0 = e.left ? cur[0] : start.x;
  const x1 = e.right ? cur[0] : start.x + start.w;
  const y0 = e.top ? cur[1] : start.y;
  const y1 = e.bottom ? cur[1] : start.y + start.h;
  return normalizeBBox([x0, y0], [x1, y1]);
}

/** 左右／上下を鏡写しにしたハンドル（反転追従用） */
const BBOX_HANDLE_MIRROR_X: Record<BBoxHandle, BBoxHandle> = {
  nw: 'ne', ne: 'nw', sw: 'se', se: 'sw', w: 'e', e: 'w', n: 'n', s: 's',
};
const BBOX_HANDLE_MIRROR_Y: Record<BBoxHandle, BBoxHandle> = {
  nw: 'sw', sw: 'nw', ne: 'se', se: 'ne', n: 's', s: 'n', e: 'e', w: 'w',
};

/**
 * 可動辺が固定辺を越えたら、反転後に「実際に掴んでいる辺」の方角へハンドルを付け替える。
 * これをしないと、右辺を左辺より左へ引いたあとも drag.handle が 'e' のままになり、
 * カーソル形状が実態と食い違う／以降の固定辺の判定がズレる。
 */
function flippedHandle(base: BBox, h: BBoxHandle, cur: Pt): BBoxHandle {
  const e = BBOX_HANDLE_EDGES[h];
  let next = h;
  // 可動辺が left なら固定辺は right（= base.x + base.w）。その逆も同様。
  if ((e.left && cur[0] > base.x + base.w) || (e.right && cur[0] < base.x)) {
    next = BBOX_HANDLE_MIRROR_X[next];
  }
  if ((e.top && cur[1] > base.y + base.h) || (e.bottom && cur[1] < base.y)) {
    next = BBOX_HANDLE_MIRROR_Y[next];
  }
  return next;
}

/**
 * 固定辺を動かさずに最小サイズ（BBOX_MIN_SIZE）を満たす箱にする。
 * reducer は `Math.max(w, MIN)` で x を据え置くため、可動辺が固定辺に寄り切ると
 * 「固定側の辺が最大 2px 跳ねる」。ここで可動辺側だけを押し戻してから dispatch する
 * （reducer 側の防御はそのまま残す）。
 */
function enforceMinBBox(box: BBox, h: BBoxHandle): BBox {
  const e = BBOX_HANDLE_EDGES[h];
  let { x, y, w, h: hgt } = box;
  if (w < BBOX_MIN_SIZE) {
    // 可動辺が left のときだけ左へ伸ばす（右辺＝固定辺を据え置く）
    if (e.left) x = x + w - BBOX_MIN_SIZE;
    w = BBOX_MIN_SIZE;
  }
  if (hgt < BBOX_MIN_SIZE) {
    if (e.top) y = y + hgt - BBOX_MIN_SIZE;
    hgt = BBOX_MIN_SIZE;
  }
  return { x, y, w, h: hgt };
}

/** crypto.randomUUID()。未提供環境でも落ちないフォールバック付き（reducer が採番し直す余地あり） */
function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function AnnotationCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  editor,
  classes,
  brightness,
  contrast,
  fitSignal,
  magnetMode,
  magnetInvert,
  showDerivedBoxes,
  magnetSegRef,
  lineEditAction,
  onLineEditActionDone,
  onMagnetFallback,
  onLineMetaDropped,
  shortcutsSuspended = false,
  className,
}: AnnotationCanvasProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageElRef = useRef<HTMLImageElement | null>(null);
  const samplingImgRef = useRef<HTMLImageElement | null>(null); // 画素読取用（CORS）
  const offscreenRef = useRef<HTMLCanvasElement | null>(null); // ROI 切出しバッファ
  const bufSizeRef = useRef({ w: 0, h: 0 });
  const dragRef = useRef<DragState | null>(null);
  const dragPointerIdRef = useRef<number | null>(null); // capture 解放用（中断時に明示解放する）
  const spaceRef = useRef(false);
  const userMovedRef = useRef(false); // 操作前はコンテナ実寸の確定に追従して再フィット
  const suppressClickUntilRef = useRef(0); // 確定直後のクリックで新 draft が始まる誤爆防止
  const taintWarnedRef = useRef(false); // 画素読取失敗の警告は画像ごとに1回だけ出す
  // ---- ゴーストガイド（マグネット補完プレビュー・Tab確定） ----
  const ghostRef = useRef<GhostCache | null>(null); // 直近計算のゴースト（描画・Tab確定で共有）
  const ghostRafRef = useRef<number | null>(null); // スロットル用の予約 rAF
  const ghostTimeoutRef = useRef<number | null>(null); // trailing 予約の setTimeout
  const ghostPendingCursorRef = useRef<Pt | null>(null); // rAF/timeout 実行時に読む最新カーソル
  const ghostLastComputeRef = useRef({ t: 0, x: -1e9, y: -1e9 }); // 前回計算の時刻・カーソル

  const [view, setView] = useState<ViewState | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const [imgTick, setImgTick] = useState(0); // 画像ロード完了で再描画を起こす
  const [imgError, setImgError] = useState(false); // 画像ロード失敗表示
  const [dprTick, setDprTick] = useState(0); // DPR 変化で再描画を起こす
  const [mousePos, setMousePos] = useState<Pt | null>(null); // 画像座標（ラバーバンド用）
  // ゴースト計算/破棄で再描画を起こす兼、ヒントチップ表示条件（render で ref を読まないための state）
  const [ghostAnchor, setGhostAnchor] = useState<Pt | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [hoverCursor, setHoverCursor] = useState('default');
  const [cutPending, setCutPending] = useState<CutPending | null>(null); // 短縮の選択UI
  // bbox ドラッグ描画中のラバー矩形（画像座標。store には入れない）
  const [bboxRect, setBboxRect] = useState<{ a: Pt; b: Pt } | null>(null);

  // 画像切替・選択変更で短縮UIを閉じる（陳腐化防止）
  useEffect(() => {
    setCutPending(null);
  }, [imageUrl, editor.state.selectedId]);

  /**
   * 進行中のドラッグを「確定させずに」畳む共通処理。
   * 画像切替・アンマウント・フォーカス喪失・タブ非表示で必ず通す。
   *   - 開始済みジェスチャは endGesture（gestureActive の残留＝undo/redo が効かない状態を防ぐ）
   *   - bbox 描画は破棄（切替直前に始めたドラッグが新しい画像の上で確定するのを防ぐ）
   *   - pointer capture を明示解放（capture を握ったまま要素が消えるのを防ぐ）
   */
  const abortDrag = useCallback(() => {
    const drag = dragRef.current;
    const pid = dragPointerIdRef.current;
    dragRef.current = null;
    dragPointerIdRef.current = null;
    const canvas = canvasRef.current;
    if (canvas && pid !== null && canvas.hasPointerCapture(pid)) {
      canvas.releasePointerCapture(pid);
    }
    if (!drag) return;
    if (drag.kind === 'bboxDraw') {
      setBboxRect(null);
      return;
    }
    if (
      (drag.kind === 'vertex' || drag.kind === 'move' || drag.kind === 'bboxHandle') &&
      drag.started
    ) {
      editor.dispatch({ type: 'endGesture' });
    }
    // dispatch は useReducer 由来で不変（editor 全体を依存にすると毎 state 更新で再生成される）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.dispatch]);

  // ---- 座標変換 ----
  const toScreenPt = (p: Pt): Pt =>
    view ? [p[0] * view.scale + view.offsetX, p[1] * view.scale + view.offsetY] : p;
  const toImagePt = (sx: number, sy: number): Pt =>
    view ? [(sx - view.offsetX) / view.scale, (sy - view.offsetY) / view.scale] : [sx, sy];
  const clampToImage = (p: Pt): Pt => [
    Math.min(Math.max(p[0], 0), imageWidth),
    Math.min(Math.max(p[1], 0), imageHeight),
  ];

  // ---- 画像ロード ----
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imageElRef.current = img;
      setImgTick((t) => t + 1);
    };
    img.onerror = () => {
      imageElRef.current = null;
      setImgError(true);
    };
    img.src = imageUrl;
    imageElRef.current = null;
    setImgError(false); // imageUrl 変更でエラー表示をクリア
    setImgTick((t) => t + 1); // 旧画像を即消す
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [imageUrl]);

  // ---- 画素読取用の CORS 画像（マグネットの ROI サンプリング） ----
  // 表示用 img（非CORS）とは別インスタンスにする。表示画像には一切触れないため
  // CORS/画素読取が失敗してもマグネットが直線化するだけで、画像表示は絶対に壊れない。
  //
  // 参照実装はキャッシュキーを分けるため `?cors=1` を付けていたが、GenbaAnno では**付けない**。
  // 付けると本アプリの両アダプタでサンプリング画像のロード自体が失敗し、マグネットが
  // 無言で直線に落ちるため（E2E で実際に踏んだ）:
  //   - mock: `blob:` URL にクエリを足すと blob ストア照合に失敗して onerror
  //   - electron: `anno://` は electron/lib/pathGuard.ts の parseAnnoImageUrl が
  //     `url.search !== ''` を 400 で弾く（クエリ付き URL は配信されない）
  // 素の URL で問題ない理由: anno:// は `Access-Control-Allow-Origin: *` と
  // `Cache-Control: no-cache` を返し（electron/main.ts）、mock の blob: は same-origin なので
  // どちらも taint しない。万一 taint しても getImageData の try/catch で直線入力へ静かに
  // フォールバックする防御（DESIGN §6 罠#3）はそのまま残している。
  useEffect(() => {
    samplingImgRef.current = null;
    taintWarnedRef.current = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      samplingImgRef.current = img;
    };
    img.onerror = () => {
      samplingImgRef.current = null;
      // ユーザーには出さない（DESIGN §6 罠#3 のとおり静かに直線へフォールバックする）。
      // ただし「マグネットが効かないが動いてはいる」は気づきにくい壊れ方なので、
      // 開発コンソールにだけ理由を残す（Electron 実機での切り分け用）。
      console.warn(
        '[GenbaAnno] マグネット用サンプリング画像を読み込めませんでした。' +
          'マグネットは直線入力にフォールバックします:',
        imageUrl
      );
    };
    img.src = imageUrl;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [imageUrl]);

  // ---- DPR 変化（別モニタ移動・ブラウザズーム）でバッファ再確保+再描画 ----
  useEffect(() => {
    // 変化のたびに現在の DPR でリスナーを張り直す（dprTick 依存で再実行）
    const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = (): void => setDprTick((t) => t + 1);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [dprTick]);

  // ---- コンテナサイズ追従（DPR 対応はバッファ確保側で行う） ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setCanvasSize({ w: Math.max(r.width, 50), h: Math.max(r.height, 50) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ---- fit / zoom ----
  const fitScale =
    imageWidth > 0 && imageHeight > 0
      ? Math.min(canvasSize.w / imageWidth, canvasSize.h / imageHeight)
      : 1;

  const fitViewState = useCallback((): ViewState => {
    return {
      scale: fitScale,
      offsetX: (canvasSize.w - imageWidth * fitScale) / 2,
      offsetY: (canvasSize.h - imageHeight * fitScale) / 2,
    };
  }, [fitScale, canvasSize, imageWidth, imageHeight]);

  // 画像切替でビューを破棄。進行中のドラッグも必ず畳む（新しい画像の上で pointerup を
  // 受けて bbox が確定する／gestureActive が残ったままになるのを防ぐ）
  useEffect(() => {
    userMovedRef.current = false;
    abortDrag();
    setView(null);
  }, [imageUrl, abortDrag]);
  // 初回・ユーザー操作前はサイズ確定に追従して再フィット。
  // imageUrl も依存に入れるのは必須: 直前の effect が view=null にしたあと、
  // 次の画像が「同じ寸法・同じコンテナサイズ」だと fitViewState の識別子が変わらず
  // この effect が再実行されない＝view が null のままキャンバスが固まる
  // （同一機種で撮った同寸法の連番画像＝現場の通常ケースで必ず踏む。E2E で実際に踏んだ）。
  useEffect(() => {
    setView((v) => (v === null || !userMovedRef.current ? fitViewState() : v));
  }, [fitViewState, imageUrl]);
  // fitSignal のインクリメントでフィット実行
  const fitSignalRef = useRef(fitSignal);
  useEffect(() => {
    if (fitSignal !== fitSignalRef.current) {
      fitSignalRef.current = fitSignal;
      userMovedRef.current = false;
      setView(fitViewState());
    }
  }, [fitSignal, fitViewState]);

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      userMovedRef.current = true;
      setView((v) => {
        if (!v) return v;
        const minScale = Math.min(fitScale * ZOOM_MIN_FIT_RATIO, ZOOM_MAX);
        const newScale = Math.min(Math.max(v.scale * factor, minScale), ZOOM_MAX);
        // カーソル位置の画像座標を固定してズーム
        const ix = (px - v.offsetX) / v.scale;
        const iy = (py - v.offsetY) / v.scale;
        return {
          scale: newScale,
          offsetX: px - ix * newScale,
          offsetY: py - iy * newScale,
        };
      });
    },
    [fitScale]
  );

  // wheel はページスクロール/Mac ピンチのページズームを止める必要があるため、
  // React 合成イベントではなくネイティブリスナーを {passive:false} で登録する（DESIGN §6 罠#4）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        // Mac ピンチは ctrlKey=true で入る。カーソル中心ズーム
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        userMovedRef.current = true;
        setView((v) =>
          v ? { ...v, offsetX: v.offsetX - e.deltaX, offsetY: v.offsetY - e.deltaY } : v
        );
      }
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [zoomAt]);

  // ---- Space キー（パン用。preventDefault はページ側が担当） ----
  // 併せて bbox ドラッグ中の Esc をキャンセルとして拾う（canvas ローカル・stopPropagation はしない）
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (isImeComposing(e)) return; // IME 変換中は無視
      if (e.code === 'Space' && !isFormTarget(e.target)) {
        spaceRef.current = true;
        setSpaceHeld(true);
        return;
      }
      if (e.key === 'Escape') {
        const drag = dragRef.current;
        if (drag && drag.kind === 'bboxDraw') {
          drag.canceled = true; // pointerup 時に確定しない
          setBboxRect(null);
        }
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ---- フォーカス喪失・タブ非表示で Space パン固着と進行中ドラッグをリセット ----
  useEffect(() => {
    const reset = (): void => {
      spaceRef.current = false;
      setSpaceHeld(false);
      abortDrag();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') reset();
    };
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [abortDrag]);

  // ---- ポインタ操作 ----
  const screenPos = (e: ReactMouseEvent<HTMLCanvasElement>): Pt => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  /** アノテーションのヒット判定（bbox は内部 or 枠線近傍 EDGE_HIT_PX、それ以外は参照実装どおり） */
  const hitAnnotation = (a: Annotation, screenPt: Pt, imgPt: Pt): boolean => {
    if (a.kind === 'bbox') {
      if (bboxContains(a.box, imgPt)) return true;
      return hitTestEdge(screenPt, bboxCorners(a.box).map(toScreenPt), EDGE_HIT_PX) !== null;
    }
    return hitTestPolygon(screenPt, a.points.map(toScreenPt), EDGE_HIT_PX);
  };

  /** 選択中 bbox のハンドルヒット（最も近いもの・スクリーン座標固定 px） */
  const hitBBoxHandle = (screenPt: Pt, box: BBox): BBoxHandle | null => {
    let best: BBoxHandle | null = null;
    let bestD = BBOX_HANDLE_HIT_PX;
    for (const h of BBOX_HANDLES) {
      const [hx, hy] = toScreenPt(bboxHandlePoint(box, h));
      const d = Math.hypot(screenPt[0] - hx, screenPt[1] - hy);
      if (d <= bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  };

  // ---- マグネット経路トレース（image 座標の anchor→target） ----
  // 返り値 pointsToAdd は anchor を除いた追加頂点列（末尾＝target）。
  // sampled=false は画素読取不可（CORS未了/taint/ROI過小）で通常の直線点追加にフォールバック。
  // snapTarget=true（ゴーストガイド専用）: targetImg を ROI 内で近傍リッジへスナップしてから
  //   トレースする（クリック消費側は false 既定でこの分岐を通らず、従来挙動と完全一致）。
  const magnetTrace = (
    anchorImg: Pt,
    targetImg: Pt,
    snapTarget = false
  ): {
    pointsToAdd: Pt[];
    fellBack: boolean;
    sampled: boolean;
    estWidth: number | null;
    widthsToAdd: number[] | null;
  } => {
    const single = {
      pointsToAdd: [targetImg] as Pt[],
      fellBack: false,
      sampled: false,
      estWidth: null,
      widthsToAdd: null,
    };
    const img = samplingImgRef.current;
    if (!img || !img.complete || img.naturalWidth === 0) return single;

    const chord = Math.hypot(targetImg[0] - anchorImg[0], targetImg[1] - anchorImg[1]);
    const margin = Math.min(Math.max(chord * 0.3, 16), 96);
    const x0 = Math.max(0, Math.floor(Math.min(anchorImg[0], targetImg[0]) - margin));
    const y0 = Math.max(0, Math.floor(Math.min(anchorImg[1], targetImg[1]) - margin));
    const x1 = Math.min(imageWidth, Math.ceil(Math.max(anchorImg[0], targetImg[0]) + margin));
    const y1 = Math.min(imageHeight, Math.ceil(Math.max(anchorImg[1], targetImg[1]) + margin));
    const roiW = x1 - x0;
    const roiH = y1 - y0;
    if (roiW < 2 || roiH < 2) return single;

    const scale = Math.min(1, MAGNET_ROI_MAX / Math.max(roiW, roiH));
    const outW = Math.max(2, Math.round(roiW * scale));
    const outH = Math.max(2, Math.round(roiH * scale));

    const off = offscreenRef.current ?? (offscreenRef.current = document.createElement('canvas'));
    off.width = outW;
    off.height = outH;
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return single;
    let imageData: ImageData;
    try {
      octx.clearRect(0, 0, outW, outH);
      octx.drawImage(img, x0, y0, roiW, roiH, 0, 0, outW, outH);
      imageData = octx.getImageData(0, 0, outW, outH); // taint 時は SecurityError
    } catch (err) {
      // CORS taint → 直線（ユーザーには出さない。DESIGN §6 罠#3）。
      // 静かに劣化するため切り分けが難しい。開発コンソールにだけ画像ごとに1回残す。
      if (!taintWarnedRef.current) {
        taintWarnedRef.current = true;
        console.warn(
          '[GenbaAnno] 画素読取（getImageData）に失敗したためマグネットを直線入力に' +
            'フォールバックします（CORS taint の可能性）:',
          err
        );
      }
      return single;
    }
    // 反転モード（明るい線を追う）: livewire に渡す直前に画素を反転する（livewire 本体は不変）。
    // 遅延実行（ゴーストの rAF/trailing timeout）は magnetInvert 変化時に必ず clearGhost で
    // 破棄されるため、ここで prop を直接読んでも陳腐化した設定でトレースされることはない。
    if (magnetInvert) {
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
    }

    const toRoi = (p: Pt): [number, number] => [
      (p[0] - x0) * (outW / roiW),
      (p[1] - y0) * (outH / roiH),
    ];
    const toImg = (p: [number, number]): Pt => [
      x0 + p[0] * (roiW / outW),
      y0 + p[1] * (roiH / outH),
    ];
    // ゴーストガイド: ターゲット（カーソル）を ROI 内で近傍の暗い筋へスナップする。
    // スナップ半径は画像px で clamp(コード長×0.2, 4, 28)、ROI 縮小率を掛けて ROI px に換算。
    // 暗い筋が無ければ snapToRidge はカーソル位置をそのまま返す（＝直線プレビューになる）。
    let effTargetImg = targetImg;
    if (snapTarget) {
      const grayRoi = gaussian3(toGray(imageData), outW, outH); // 軽い平滑で吸着ぶれを抑える
      const snapRadiusImg = Math.min(
        Math.max(chord * GHOST_SNAP_CHORD_FRAC, GHOST_SNAP_MIN_PX),
        GHOST_SNAP_MAX_PX
      );
      const snapRadiusRoi = snapRadiusImg * (outW / roiW);
      const snapped = snapToRidge(grayRoi, outW, outH, toRoi(targetImg), snapRadiusRoi);
      effTargetImg = toImg(snapped);
    }
    const res = traceLivewire(imageData, toRoi(anchorImg), toRoi(effTargetImg));
    const mapped = res.points.map(toImg);
    // 端点をクリック/スナップ位置に厳密固定（縮小丸め誤差の吸収）
    if (mapped.length >= 1) mapped[mapped.length - 1] = effTargetImg;
    let pointsToAdd = mapped.slice(1); // 先頭は anchor（既に draft にある）
    // 退化時（経路1点）の防御はスナップ後ターゲットで埋める（snapTarget=false 時は targetImg と同一
    // ＝クリックパス不変。ゴースト時に非スナップ点が混入して表示と確定がズレるのを防ぐ）
    if (pointsToAdd.length === 0) pointsToAdd = [effTargetImg];

    // 経路の各点で局所幅を推定（テーパー/遠近対応・ROI px → 画像 px 変換）。
    // 推定は保守化済み（半値しきい深化＋縮小係数, livewire.ts）。ここでは
    // 下限(WIDTH_EST_MIN)を掛け、画像サイズ比例＋y位置依存の上限でキャップする。
    let estWidth: number | null = null;
    let widthsToAdd: number[] | null = null;
    if (!res.fellBack) {
      const prof = estimateWidthProfile(imageData, res.points);
      if (prof !== null) {
        const floored = prof.map((w) => Math.max(w * (roiW / outW), WIDTH_EST_MIN));
        // 各点の画像y座標（上=遠方）で遠方キャップを掛ける
        const ys = res.points.map((p) => toImg(p)[1]);
        const imgProf = capWidthsByImagePosition(floored, ys, imageHeight);
        // pointsToAdd（= res.points の先頭 anchor を除いた列）と平行に幅を並べる
        widthsToAdd = imgProf.slice(1);
        if (widthsToAdd.length !== pointsToAdd.length) widthsToAdd = null; // 整合しない場合は不使用
        const s = [...imgProf].sort((a, b) => a - b);
        estWidth = Math.round(s[s.length >> 1]);
      }
    }
    return { pointsToAdd, fellBack: res.fellBack, sampled: true, estWidth, widthsToAdd };
  };

  // ---- ゴーストガイド: キャッシュ破棄（陳腐化ゴーストの Tab 確定事故を防ぐ第一の砦） ----
  // 予約中の rAF と trailing timeout の両方を必ずキャンセルする（破棄後の遅延計算リーク防止）。
  const clearGhost = useCallback(() => {
    if (ghostRafRef.current !== null) {
      cancelAnimationFrame(ghostRafRef.current);
      ghostRafRef.current = null;
    }
    if (ghostTimeoutRef.current !== null) {
      window.clearTimeout(ghostTimeoutRef.current);
      ghostTimeoutRef.current = null;
    }
    ghostPendingCursorRef.current = null;
    if (ghostRef.current !== null) {
      ghostRef.current = null;
      setGhostAnchor(null); // ゴーストを消すため再描画
    }
  }, []);

  // ---- ゴースト計算（rAF/trailing timeout 上で1回・発動条件を満たさなければキャッシュ破棄） ----
  // 発動: 非suspended + draw + line + magnetMode + draft≥1点 + 非ドラッグ
  //       + カーソル-アンカーのスクリーン距離≥12px。
  const computeGhost = (cursorImg: Pt): void => {
    ghostLastComputeRef.current = { t: performance.now(), x: cursorImg[0], y: cursorImg[1] };
    const st = editor.state;
    const d = st.draft;
    if (
      shortcutsSuspended || // モーダル表示中は計算しない（予約遅延で届いた分の防御）
      !view ||
      st.mode !== 'draw' ||
      !d ||
      d.tool !== 'line' ||
      !magnetMode ||
      d.points.length < 1 ||
      dragRef.current
    ) {
      clearGhost();
      return;
    }
    const anchor = d.points[d.points.length - 1];
    const [ax, ay] = toScreenPt(anchor);
    const [cxs, cys] = toScreenPt(cursorImg);
    if (Math.hypot(cxs - ax, cys - ay) < GHOST_MIN_SCREEN_PX) {
      clearGhost();
      return;
    }
    const { pointsToAdd, fellBack, sampled, estWidth, widthsToAdd } = magnetTrace(
      anchor,
      cursorImg,
      true
    );
    ghostRef.current = {
      anchor: [anchor[0], anchor[1]],
      cursor: cursorImg,
      pointsToAdd,
      widthsToAdd,
      estWidth,
      fellBack,
      sampled,
    };
    setGhostAnchor([anchor[0], anchor[1]]); // 新しい配列＝再描画トリガ（チップ条件も更新）
  };

  // ---- ゴースト計算のスロットル（rAF + 最小間隔80ms + 前回計算から2px以上移動・trailing 対応） ----
  // DESIGN §6 罠#1: 最後の pointermove が80ms窓内で止まると再計算が走らずゴーストがズレる。
  // 間隔未達のときは破棄せず「残り時間後の setTimeout」で trailing 予約し、最新 pending へ追いつく。
  const consumePendingGhost = (): void => {
    const cur = ghostPendingCursorRef.current;
    if (!cur) return;
    const last = ghostLastComputeRef.current;
    if (Math.hypot(cur[0] - last.x, cur[1] - last.y) < GHOST_MIN_MOVE_PX) return; // 微小移動はスキップ
    const wait = GHOST_MIN_INTERVAL_MS - (performance.now() - last.t);
    if (wait > 0) {
      // trailing: 残り時間後に最新の pending カーソルを消費（カーソルが静止していても1回で追いつく）
      ghostTimeoutRef.current = window.setTimeout(() => {
        ghostTimeoutRef.current = null;
        const cur2 = ghostPendingCursorRef.current;
        if (!cur2) return;
        const last2 = ghostLastComputeRef.current;
        if (Math.hypot(cur2[0] - last2.x, cur2[1] - last2.y) < GHOST_MIN_MOVE_PX) return;
        computeGhost(cur2);
      }, wait);
      return;
    }
    computeGhost(cur);
  };
  const scheduleGhost = (cursorImg: Pt): void => {
    if (shortcutsSuspended) return; // モーダル表示中は予約自体しない
    ghostPendingCursorRef.current = cursorImg;
    if (ghostRafRef.current !== null || ghostTimeoutRef.current !== null) return; // 予約済み
    ghostRafRef.current = requestAnimationFrame(() => {
      ghostRafRef.current = null;
      consumePendingGhost();
    });
  };

  /** ドラッグ開始の共通処理（pointerId を控えて capture を張る。中断時の解放は abortDrag） */
  const beginDrag = (e: ReactPointerEvent<HTMLCanvasElement>, drag: DragState): void => {
    dragRef.current = drag;
    dragPointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!view) return;
    const [sx, sy] = screenPos(e);
    // パン: 中ボタン or Space+左ドラッグ
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      if (e.button === 1) e.preventDefault(); // Chrome の中ボタンオートスクロール抑止
      beginDrag(e, { kind: 'pan', lastX: e.clientX, lastY: e.clientY });
      return;
    }
    const st = editor.state;
    if (e.button === 2) {
      // 頂点右クリック削除（ハンドル表示中＝選択中ポリゴン/ラインのみ。bbox は頂点を持たない）
      if (st.mode === 'edit' && st.selectedId) {
        const target = st.annotations.find((a) => a.id === st.selectedId);
        if (hasPoints(target)) {
          const vi = hitTestVertex([sx, sy], target.points.map(toScreenPt), VERTEX_HIT_PX);
          if (vi >= 0) {
            if (target.kind === 'line' && target.points.length > 3) onLineMetaDropped();
            editor.dispatch({ type: 'deleteVertex', id: target.id, index: vi });
          }
        }
      }
      return;
    }
    if (e.button !== 0) return;

    const rawImg = toImagePt(sx, sy);
    const ip = clampToImage(rawImg);
    if (st.mode === 'draw') {
      if (performance.now() < suppressClickUntilRef.current) return;
      // bbox: draft を使わず canvas ローカルのドラッグでラバー矩形を描く（契約どおり）
      if (st.drawTool === 'bbox') {
        beginDrag(e, { kind: 'bboxDraw', startImg: ip, canceled: false });
        setBboxRect({ a: ip, b: ip });
        return;
      }
      if (!st.draft) {
        editor.dispatch({ type: 'startDraft', point: ip });
        return;
      }
      const draft = st.draft;
      if (draft.tool === 'polygon' && draft.points.length >= 3) {
        // 始点クリック（半径10px）で確定
        const [fx, fy] = toScreenPt(draft.points[0]);
        if (Math.hypot(sx - fx, sy - fy) <= SNAP_PX) {
          editor.dispatch({ type: 'commitDraft' });
          suppressClickUntilRef.current = performance.now() + 350;
          return;
        }
      }
      // マグネット（line ツール + magnetMode + 2点目以降）は暗い筋に沿う経路を挿入
      if (draft.tool === 'line' && magnetMode && draft.points.length >= 1) {
        const anchor = draft.points[draft.points.length - 1];
        const [ax, ay] = toScreenPt(anchor);
        if (Math.hypot(sx - ax, sy - ay) >= MAGNET_MIN_CHORD_PX) {
          const { pointsToAdd, fellBack, sampled, estWidth, widthsToAdd } = magnetTrace(anchor, ip);
          // 最初のマグネット区間で代表幅を自動初期値に（延長/分岐は対象の幅を維持）
          if (estWidth !== null && draft.points.length === 1 && !draft.target) {
            editor.dispatch({ type: 'setLineWidth', width: estWidth });
          }
          magnetSegRef.current.push(draft.points.length); // 区間境界（追加前の draft 長）
          // 点ごとの局所幅を付与（テーパー/遠近に追従。延長・分岐区間も同様）
          pointsToAdd.forEach((p, i) => {
            editor.dispatch({ type: 'addDraftPoint', point: p, width: widthsToAdd?.[i] });
          });
          if (fellBack && sampled) onMagnetFallback();
          return;
        }
      }
      editor.dispatch({ type: 'addDraftPoint', point: ip });
      return;
    }

    // edit モード
    if (cutPending) {
      setCutPending(null); // 選択UIの外をクリック → キャンセル
      return;
    }
    const selected = st.selectedId
      ? st.annotations.find((a) => a.id === st.selectedId)
      : undefined;

    // アーム済みの短縮/分岐（選択中ラインの中心線クリック1回で実行）
    if (isLine(selected) && lineEditAction !== 'none') {
      const near = nearestOnBranches(selected.lineMeta.branches, ip);
      if (near && near.dist * view.scale <= CENTERLINE_HIT_PX) {
        if (lineEditAction === 'cut') {
          setCutPending({
            polygonId: selected.id,
            branchIndex: near.branchIndex,
            segIndex: near.segIndex,
            t: near.t,
            point: near.point,
          });
        } else {
          // 分岐: 中心線上のアンカーからマグネット区間を開始
          editor.dispatch({
            type: 'startDraft',
            point: near.point,
            target: {
              polygonId: selected.id,
              attach: 'branch',
              branchIndex: -1,
              anchor: near.point,
            },
          });
        }
      }
      onLineEditActionDone(); // ヒットの成否に関わらずアーム解除（一発方式）
      return;
    }

    if (selected) {
      if (selected.kind === 'bbox') {
        // 8ハンドル（四隅+四辺中点）を内部ヒットより優先
        const h = hitBBoxHandle([sx, sy], selected.box);
        if (h) {
          beginDrag(e, {
            kind: 'bboxHandle',
            id: selected.id,
            handle: h,
            box: { ...selected.box },
            startImg: ip,
            started: false,
          });
          return;
        }
        if (hitAnnotation(selected, [sx, sy], rawImg)) {
          beginDrag(e, {
            kind: 'move',
            id: selected.id,
            startImg: ip,
            lastImg: ip,
            started: false,
          });
          return;
        }
      } else {
        // ライン端点ハンドル（延長）を頂点より優先ヒット
        if (selected.kind === 'line') {
          for (const ep of lineEndpoints(selected.lineMeta)) {
            const [ex, ey] = toScreenPt(ep.point);
            if (Math.hypot(sx - ex, sy - ey) <= ENDPOINT_HIT_PX) {
              editor.dispatch({
                type: 'startDraft',
                point: ep.point,
                target: {
                  polygonId: selected.id,
                  attach: ep.attach,
                  branchIndex: ep.branchIndex,
                  anchor: ep.point,
                },
              });
              return;
            }
          }
        }
        const spts = selected.points.map(toScreenPt);
        const vi = hitTestVertex([sx, sy], spts, VERTEX_HIT_PX);
        if (vi >= 0) {
          beginDrag(e, {
            kind: 'vertex',
            id: selected.id,
            index: vi,
            startImg: ip,
            started: false,
            hadLineMeta: selected.kind === 'line',
          });
          return;
        }
        // 内部またはエッジ掴みで全体移動
        if (hitTestPolygon([sx, sy], spts, EDGE_HIT_PX)) {
          beginDrag(e, {
            kind: 'move',
            id: selected.id,
            startImg: ip,
            lastImg: ip,
            started: false,
          });
          return;
        }
      }
    }
    // 他アノテーションの選択（後に描いたもの＝上のものを優先）
    for (let i = st.annotations.length - 1; i >= 0; i--) {
      const a = st.annotations[i];
      if (a.id === st.selectedId) continue;
      if (hitAnnotation(a, [sx, sy], rawImg)) {
        editor.dispatch({ type: 'select', id: a.id });
        beginDrag(e, {
          kind: 'move',
          id: a.id,
          startImg: ip,
          lastImg: ip,
          started: false,
        });
        return;
      }
    }
    editor.dispatch({ type: 'select', id: null });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!view) return;
    const [sx, sy] = screenPos(e);
    const drag = dragRef.current;
    if (drag) {
      if (drag.kind === 'pan') {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        userMovedRef.current = true;
        setView((v) => (v ? { ...v, offsetX: v.offsetX + dx, offsetY: v.offsetY + dy } : v));
        return;
      }
      if (drag.kind === 'bboxDraw') {
        if (drag.canceled) return;
        setBboxRect({ a: drag.startImg, b: clampToImage(toImagePt(sx, sy)) });
        return;
      }
      if (drag.kind === 'bboxHandle') {
        const cur = clampToImage(toImagePt(sx, sy));
        // 微小揺れで履歴を積まない（全体移動と同じ 2px 閾値）
        if (!drag.started) {
          const movedPx =
            Math.hypot(cur[0] - drag.startImg[0], cur[1] - drag.startImg[1]) * view.scale;
          if (movedPx < DRAG_START_PX) return;
          // ドラッグ開始時に1回だけ履歴を積む（resizeBBox は履歴を積まない）
          editor.dispatch({ type: 'beginGesture' });
          drag.started = true;
        }
        // 可動辺が固定辺を越えたらハンドルの方角を付け替える（カーソルもここで追従する）。
        // 併せて drag.box を今回の箱で更新することで、反転後も固定辺の値が保たれる。
        const next = flippedHandle(drag.box, drag.handle, cur);
        // 最小サイズは固定辺を動かさずに満たす（reducer の Math.max だと固定辺が跳ねる）
        const box = enforceMinBBox(resizedBBox(drag.box, drag.handle, cur), next);
        if (next !== drag.handle) {
          drag.handle = next;
          setHoverCursor(BBOX_HANDLE_CURSOR[next]);
        }
        drag.box = box;
        editor.dispatch({ type: 'resizeBBox', id: drag.id, box });
        return;
      }
      if (drag.kind === 'vertex') {
        const cur = clampToImage(toImagePt(sx, sy));
        if (!drag.started) {
          const movedPx =
            Math.hypot(cur[0] - drag.startImg[0], cur[1] - drag.startImg[1]) * view.scale;
          if (movedPx < DRAG_START_PX) return;
          // ドラッグ開始時に1回だけ履歴を積む
          editor.dispatch({ type: 'beginGesture' });
          drag.started = true;
          // 頂点手編集はライン構造を解除する（reducer 側で実施）。1回だけ通知
          if (drag.hadLineMeta) onLineMetaDropped();
        }
        editor.dispatch({
          type: 'moveVertex',
          id: drag.id,
          index: drag.index,
          point: cur,
        });
        return;
      }
      // 全体移動（クリック選択と区別するため閾値を超えてから開始）
      const ip = toImagePt(sx, sy);
      if (!drag.started) {
        const movedPx =
          Math.hypot(ip[0] - drag.startImg[0], ip[1] - drag.startImg[1]) * view.scale;
        if (movedPx < DRAG_START_PX) return;
        editor.dispatch({ type: 'beginGesture' });
        drag.started = true;
      }
      editor.dispatch({
        type: 'moveAnnotation',
        id: drag.id,
        delta: [ip[0] - drag.lastImg[0], ip[1] - drag.lastImg[1]],
      });
      drag.lastImg = ip;
      return;
    }

    // ホバー: draft ラバーバンド + カーソル形状
    const st = editor.state;
    if (st.draft) {
      const ip = clampToImage(toImagePt(sx, sy));
      setMousePos(ip);
      // ゴーストガイド: マグネットライン描画中のみカーソル追従で経路プレビューをスロットル計算
      if (
        st.mode === 'draw' &&
        st.draft.tool === 'line' &&
        magnetMode &&
        st.draft.points.length >= 1
      ) {
        scheduleGhost(ip);
      } else if (ghostRef.current) {
        clearGhost();
      }
    }
    if (st.mode === 'edit') {
      let c = 'default';
      const rawImg = toImagePt(sx, sy);
      const selected = st.selectedId
        ? st.annotations.find((a) => a.id === st.selectedId)
        : undefined;
      if (selected) {
        if (selected.kind === 'bbox') {
          const h = hitBBoxHandle([sx, sy], selected.box);
          if (h) c = BBOX_HANDLE_CURSOR[h];
          else if (hitAnnotation(selected, [sx, sy], rawImg)) c = 'move';
        } else {
          const spts = selected.points.map(toScreenPt);
          if (
            hitTestVertex([sx, sy], spts, VERTEX_HIT_PX) >= 0 ||
            hitTestPolygon([sx, sy], spts, EDGE_HIT_PX)
          ) {
            c = 'move';
          }
        }
      }
      if (c === 'default') {
        for (let i = st.annotations.length - 1; i >= 0; i--) {
          if (st.annotations[i].id === st.selectedId) continue;
          if (hitAnnotation(st.annotations[i], [sx, sy], rawImg)) {
            c = 'pointer';
            break;
          }
        }
      }
      setHoverCursor(c);
    }
  };

  /** bbox ドラッグの確定（正規化 → 画像クランプ → 最小サイズ検査 → addAnnotation） */
  const commitBBoxDraw = (drag: { startImg: Pt; canceled: boolean }, cur: Pt): void => {
    if (drag.canceled) return;
    const box = clampBBoxToImage(
      normalizeBBox(drag.startImg, clampToImage(cur)),
      imageWidth,
      imageHeight
    );
    // BBOX_MIN_SIZE 未満はクリック扱い（ユーザーに見せず何もしない）
    if (box.w < BBOX_MIN_SIZE || box.h < BBOX_MIN_SIZE) return;
    editor.dispatch({
      type: 'addAnnotation',
      annotation: {
        id: newId(),
        classId: editor.state.activeClassId,
        source: 'manual',
        kind: 'bbox',
        box,
      },
    });
  };

  // ドラッグ終了はすべて abortDrag（＝開始済みジェスチャの endGesture・bbox 描画の破棄・
  // capture 解放）を通す。bbox の確定だけは pointerup で abortDrag の前に位置を取り出して行う
  // （確定は pointer capture 中の pointerup のみ＝契約どおり）。
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const cur = drag.kind === 'bboxDraw' ? toImagePt(...screenPos(e)) : null;
    abortDrag();
    if (drag.kind === 'bboxDraw' && cur) commitBBoxDraw(drag, cur);
  };

  const onPointerCancel = (): void => {
    abortDrag();
  };

  const onPointerLeave = (): void => {
    abortDrag(); // キャプチャ喪失等でドラッグが中断された場合の後始末
    setMousePos(null);
    setHoverCursor('default');
    clearGhost(); // カーソルが外れたらゴーストも消す
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>): void => {
    if (!view) return;
    const st = editor.state;
    if (st.mode === 'draw') {
      if (st.draft) {
        // dblclick 直前の click 2回で同位置に2頂点入るため1つ除去
        // （3点以下は pop すると確定不能になるためしない）
        if (st.draft.points.length > 3) editor.dispatch({ type: 'popDraftPoint' });
        editor.dispatch({ type: 'commitDraft' });
        suppressClickUntilRef.current = performance.now() + 350;
      }
      return;
    }
    // edit: エッジをダブルクリックで頂点挿入（bbox は頂点を持たないので対象外）
    if (!st.selectedId) return;
    const target = st.annotations.find((a) => a.id === st.selectedId);
    if (!hasPoints(target)) return;
    const [sx, sy] = screenPos(e);
    const spts = target.points.map(toScreenPt);
    // 頂点上のダブルクリックは挿入しない（重複頂点防止）
    if (hitTestVertex([sx, sy], spts, VERTEX_HIT_PX) >= 0) return;
    const edge = hitTestEdge([sx, sy], spts, EDGE_HIT_PX);
    if (edge) {
      if (target.kind === 'line') onLineMetaDropped(); // 頂点手編集でライン構造解除の通知
      editor.dispatch({
        type: 'insertVertex',
        id: target.id,
        index: edge.index + 1,
        point: clampToImage(toImagePt(edge.closest[0], edge.closest[1])),
      });
    }
  };

  // ---- Tab: ゴースト表示中に「見えている経路」をそのまま確定する ----
  // クリック消費側（onPointerDown のマグネット分岐）と同一パイプラインを再現する。再トレースせず
  // 直前表示のキャッシュ（ghostRef）を消費（WYSIWYG・DESIGN §6 罠#2）。
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // モーダル表示中は素通し（preventDefault もしない）
      if (shortcutsSuspended) return;
      if (isImeComposing(e)) return; // IME 変換中の Tab は変換候補操作なので触らない
      if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isFormTarget(e.target)) return; // フォーム要素フォーカス中は無視
      const st = editor.state;
      const d = st.draft;
      const gc = ghostRef.current;
      if (
        !view ||
        st.mode !== 'draw' ||
        !d ||
        d.tool !== 'line' ||
        !magnetMode ||
        d.points.length < 1 ||
        dragRef.current ||
        !gc ||
        gc.pointsToAdd.length === 0
      ) {
        return; // ゴースト非表示時は Tab を素通し（preventDefault しない）
      }
      const anchor = d.points[d.points.length - 1];
      // 陳腐化検査: キャッシュ計算時のアンカーと現在のアンカーが一致する場合のみ消費（第二の砦）
      if (gc.anchor[0] !== anchor[0] || gc.anchor[1] !== anchor[1]) return;
      e.preventDefault(); // ここまで来たら確定するのでフォーカス移動を抑止
      // (a) 最初のマグネット区間なら代表幅を自動初期値に（延長/分岐は対象の幅を維持）
      if (gc.estWidth !== null && d.points.length === 1 && !d.target) {
        editor.dispatch({ type: 'setLineWidth', width: gc.estWidth });
      }
      // (b) 区間境界（追加前の draft 長）を積む（ページ側 Backspace の整合）
      magnetSegRef.current.push(d.points.length);
      // (c) キャッシュ済み経路を点ごと局所幅つきで追加
      gc.pointsToAdd.forEach((p, i) => {
        editor.dispatch({ type: 'addDraftPoint', point: p, width: gc.widthsToAdd?.[i] });
      });
      // (d) 直線化していれば通知（クリック時と同条件）
      if (gc.fellBack && gc.sampled) onMagnetFallback();
      // (e) そのまま確定 →(f) 確定直後の誤クリック防止（クリック確定と同じ）
      editor.dispatch({ type: 'commitDraft' });
      suppressClickUntilRef.current = performance.now() + 350;
      clearGhost();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view, editor, magnetMode, magnetSegRef, onMagnetFallback, clearGhost, shortcutsSuspended]);

  // ゴースト無効化: draft 点数/ツール/モード・マグネット切替/反転切替・画像切替でキャッシュ破棄し、
  // 次の mousemove で新アンカー向けに即再計算できるようスロットル時刻もリセットする。
  useEffect(() => {
    clearGhost();
    ghostLastComputeRef.current = { t: 0, x: -1e9, y: -1e9 };
  }, [
    clearGhost,
    imageUrl,
    magnetMode,
    magnetInvert,
    editor.state.mode,
    editor.state.drawTool,
    editor.state.draft?.points.length,
    editor.state.draft?.target,
  ]);

  // モーダルが開いたらゴーストを即破棄する（Tab ハンドラの suspended 素通しと二重の防御）
  useEffect(() => {
    if (shortcutsSuspended) clearGhost();
  }, [shortcutsSuspended, clearGhost]);

  // アンマウント時に予約 rAF / trailing timeout と進行中ドラッグを後始末
  // （ドラッグ中に画面が切り替わっても gestureActive が残らないようにする）
  useEffect(
    () => () => {
      if (ghostRafRef.current !== null) cancelAnimationFrame(ghostRafRef.current);
      if (ghostTimeoutRef.current !== null) window.clearTimeout(ghostTimeoutRef.current);
      abortDrag();
    },
    [abortDrag]
  );

  // ---- 描画（state 変化時のみ。常時 rAF ループは使わない） ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view) return;
    const dpr = window.devicePixelRatio || 1;
    // バッファ再確保はサイズ変更時のみ（width 代入はフルクリア+再確保になるため）
    const bw = Math.round(canvasSize.w * dpr);
    const bh = Math.round(canvasSize.h * dpr);
    if (bufSizeRef.current.w !== bw || bufSizeRef.current.h !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      bufSizeRef.current = { w: bw, h: bh };
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#2b3138'; // --ga-color-canvas-bg
    ctx.fillRect(0, 0, canvasSize.w, canvasSize.h);

    const toS = (p: Pt): Pt => [
      p[0] * view.scale + view.offsetX,
      p[1] * view.scale + view.offsetY,
    ];
    const tracePath = (pts: Pt[], close: boolean): void => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      if (close) ctx.closePath();
    };

    // 1) 画像（明るさ・コントラストは ctx.filter で適用）
    const img = imageElRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save();
      ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
      ctx.imageSmoothingEnabled = view.scale < 4; // 高倍率はピクセルを見やすく
      ctx.drawImage(
        img,
        view.offsetX,
        view.offsetY,
        imageWidth * view.scale,
        imageHeight * view.scale
      );
      ctx.restore();
    }

    const st = editor.state;
    // 未知の class_id・不正な色でもクラッシュせずフォールバック色で描く
    const colorOf = (classId: number): string => {
      const c = classes.find((x) => x.id === classId)?.color;
      return c && HEX6_RE.test(c) ? c : FALLBACK_CLASS_COLOR;
    };

    // 2) 確定アノテーション（bbox / polygon / line）
    for (const a of st.annotations) {
      const color = colorOf(a.classId);
      const selected = a.id === st.selectedId;
      if (a.kind === 'bbox') {
        const [bx, by] = toS([a.box.x, a.box.y]);
        const bw2 = a.box.w * view.scale;
        const bh2 = a.box.h * view.scale;
        if (st.fillVisible) {
          ctx.fillStyle = hexToRgba(color, selected ? 0.35 : 0.25);
          ctx.fillRect(bx, by, bw2, bh2);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 3 : 2;
        ctx.lineJoin = 'round';
        ctx.strokeRect(bx, by, bw2, bh2);
        // 8ハンドル（編集モードで選択中のときのみ）
        if (selected && st.mode === 'edit') {
          const hs = BBOX_HANDLE_PX;
          for (const h of BBOX_HANDLES) {
            const [hx, hy] = toS(bboxHandlePoint(a.box, h));
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
          }
        }
        continue;
      }
      if (a.points.length < 2) continue;
      const pts = a.points.map(toS);
      tracePath(pts, true);
      if (st.fillVisible) {
        ctx.fillStyle = hexToRgba(color, selected ? 0.35 : 0.25);
        ctx.fill();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 3 : 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (selected) {
        // 頂点ハンドル
        for (const [x, y] of pts) {
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // 2.5) ライン/多角形の外接ボックス（derived box）プレビュー
    // yolo_det エクスポートが polygon/line に自動付与する外接矩形と**同一の導出**
    // （core/geometry の bboxOfPoints。export/planner.ts と同じ関数）を細い破線で重ねる。
    // 表示専用: 塗らない・ハンドルを出さない・ヒット判定には一切登場しない（非インタラクティブ）。
    // bbox はそれ自体が矩形なので描かない。draft は確定前なので描かない。
    if (showDerivedBoxes) {
      ctx.save();
      ctx.setLineDash(DERIVED_BOX_DASH);
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
      for (const a of st.annotations) {
        if (a.kind !== 'polygon' && a.kind !== 'line') continue;
        if (a.points.length < 2) continue;
        const box = bboxOfPoints(a.points);
        if (box.w <= 0 && box.h <= 0) continue; // 退化（全点同一）は描かない
        const selected = a.id === st.selectedId;
        const [bx, by] = toS([box.x, box.y]);
        ctx.strokeStyle = hexToRgba(
          colorOf(a.classId),
          selected ? DERIVED_BOX_ALPHA_SELECTED : DERIVED_BOX_ALPHA
        );
        ctx.lineWidth = selected ? DERIVED_BOX_LINE_WIDTH_SELECTED : DERIVED_BOX_LINE_WIDTH;
        ctx.strokeRect(bx, by, box.w * view.scale, box.h * view.scale);
      }
      ctx.restore();
    }

    // 2.6) 選択中ラインの中心線 + 端点ハンドル（編集モードのみ）
    // 端点◻をクリック=延長。短縮/分岐アーム中は中心線が操作対象になる。
    if (st.mode === 'edit' && st.selectedId) {
      const sel = st.annotations.find((a) => a.id === st.selectedId);
      if (isLine(sel)) {
        const color = colorOf(sel.classId);
        ctx.save();
        // 中心線（枝ごと）
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = lineEditAction !== 'none' ? 2.5 : 1.5;
        ctx.strokeStyle =
          lineEditAction !== 'none' ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.7)';
        for (const br of sel.lineMeta.branches) {
          if (br.length < 2) continue;
          tracePath(br.map(toS), false);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        // 端点ハンドル（四角・延長の起点）
        for (const ep of lineEndpoints(sel.lineMeta)) {
          const [x, y] = toS(ep.point);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x - 4.5, y - 4.5, 9, 9);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
        }
        // 点単位巻き戻し（Backspace）の対象＝末尾点をアンバーで強調（次に消える1点を明示）
        const tail = lineTailTarget(sel.lineMeta);
        if (tail) {
          const [tx, ty] = toS(tail.point);
          ctx.fillStyle = '#f59e0b'; // amber-500
          ctx.fillRect(tx - 5, ty - 5, 10, 10);
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(tx - 5, ty - 5, 10, 10);
          ctx.beginPath();
          ctx.arc(tx, ty, 9, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(245,158,11,0.9)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        // 短縮の確定待ち位置マーカー
        if (cutPending && cutPending.polygonId === sel.id) {
          const [cx, cy] = toS(cutPending.point);
          ctx.beginPath();
          ctx.arc(cx, cy, 6, 0, Math.PI * 2);
          ctx.strokeStyle = '#f87171';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 3) ドラフト（延長/分岐ドラフトは対象アノテーションのクラス色で描く）
    if (st.draft && st.draft.points.length > 0) {
      const targetAnno = st.draft.target
        ? st.annotations.find((a) => a.id === st.draft!.target!.polygonId)
        : undefined;
      const color = colorOf(targetAnno ? targetAnno.classId : st.activeClassId);
      const pts = st.draft.points.map(toS);
      const mouse = mousePos ? toS(mousePos) : null;
      if (st.draft.tool === 'line') {
        // 線幅プレビュー（点ごとの局所幅でセグメント別に描く＝テーパーの見た目）
        const dws = st.draft.widths;
        const wAt = (i: number): number => (dws?.[i] ?? st.draft!.lineWidth) * view.scale;
        // ゴーストガイド: マグネット補完プレビューを出すか（陳腐化検査＝アンカー値の一致）
        const gc = ghostRef.current;
        const anchorPt = st.draft.points[st.draft.points.length - 1];
        const ghostValid =
          !!gc &&
          magnetMode &&
          !dragRef.current &&
          gc.pointsToAdd.length > 0 &&
          gc.anchor[0] === anchorPt[0] &&
          gc.anchor[1] === anchorPt[1];
        // 実トレース経路が得られたゴースト（sampled かつ非フォールバック）はリボン付きで描く。
        // フォールバック／サンプル不可は従来どおり直線ラバーバンド（リボン無し）に落とす。
        const showGhostRibbon = ghostValid && gc!.sampled && !gc!.fellBack;

        ctx.strokeStyle = hexToRgba(color, 0.3);
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        for (let i = 0; i < pts.length - 1; i++) {
          tracePath([pts[i], pts[i + 1]], false);
          ctx.lineWidth = (wAt(i) + wAt(i + 1)) / 2;
          ctx.stroke();
        }
        if (mouse && !showGhostRibbon) {
          // ラバーバンド区間は最後の局所幅でプレビュー（従来動作・ゴースト非表示時）
          tracePath([pts[pts.length - 1], mouse], false);
          ctx.lineWidth = wAt(pts.length - 1);
          ctx.stroke();
        }
        // 中心線（確定済み）
        if (pts.length >= 2) {
          tracePath(pts, false);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.lineCap = 'butt';
          ctx.stroke();
        }
        if (showGhostRibbon) {
          // --- ゴースト経路（補完プレビュー）---
          // 可変幅リボン（低アルファ）＋ クラス色・太め破線の中心線（白ハロー下地）
          // ＋ 終点マーカー（スナップ先を明示）。
          const gpts = [anchorPt, ...gc!.pointsToAdd].map(toS);
          const anchorW = dws?.[pts.length - 1] ?? st.draft.lineWidth;
          const gWImg = [
            anchorW,
            ...(gc!.widthsToAdd ??
              gc!.pointsToAdd.map(() => gc!.estWidth ?? st.draft!.lineWidth)),
          ];
          const gWAt = (i: number): number => gWImg[i] * view.scale;
          // 可変幅リボン
          ctx.strokeStyle = hexToRgba(color, GHOST_RIBBON_ALPHA);
          ctx.lineCap = 'butt';
          ctx.lineJoin = 'round';
          for (let i = 0; i < gpts.length - 1; i++) {
            tracePath([gpts[i], gpts[i + 1]], false);
            ctx.lineWidth = (gWAt(i) + gWAt(i + 1)) / 2;
            ctx.stroke();
          }
          // 破線中心線（白ハロー下地＋クラス色・太め）
          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          tracePath(gpts, false);
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 3.5;
          ctx.stroke();
          tracePath(gpts, false);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
          // 終点マーカー（スナップ先）
          const gEnd = gpts[gpts.length - 1];
          ctx.beginPath();
          ctx.arc(gEnd[0], gEnd[1], 5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (mouse) {
          // 従来の直線ラバーバンド（fellBack／サンプル不可はここ＝直線破線のみ）
          ctx.setLineDash([4, 4]);
          tracePath([pts[pts.length - 1], mouse], false);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        // polygon: 確定済み頂点列 + ラバーバンド
        if (pts.length >= 2) {
          tracePath(pts, false);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
        if (mouse) {
          ctx.setLineDash([4, 4]);
          tracePath([pts[pts.length - 1], mouse, pts[0]], false);
          ctx.strokeStyle = hexToRgba(color, 0.8);
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // 始点スナップ表示（≥3点で確定可能なとき）
        if (mouse && pts.length >= 3) {
          const d = Math.hypot(mouse[0] - pts[0][0], mouse[1] - pts[0][1]);
          if (d <= SNAP_PX) {
            ctx.beginPath();
            ctx.arc(pts[0][0], pts[0][1], SNAP_PX, 0, Math.PI * 2);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      }
      // ドラフト頂点マーカー（始点はやや大きく）
      pts.forEach(([x, y], i) => {
        ctx.beginPath();
        ctx.arc(x, y, i === 0 ? 4 : 3, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#ffffff' : color;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    }

    // 4) bbox ドラッグ描画中のラバー矩形（塗り α0.12 + 実線2px・クラス色）
    if (bboxRect) {
      const color = colorOf(st.activeClassId);
      const [ax, ay] = toS(bboxRect.a);
      const [bx2, by2] = toS(bboxRect.b);
      const rx = Math.min(ax, bx2);
      const ry = Math.min(ay, by2);
      const rw = Math.abs(bx2 - ax);
      const rh = Math.abs(by2 - ay);
      ctx.setLineDash([]);
      ctx.fillStyle = hexToRgba(color, BBOX_DRAFT_FILL_ALPHA);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'miter';
      ctx.strokeRect(rx, ry, rw, rh);
    }
  }, [
    view,
    canvasSize,
    editor.state,
    mousePos,
    classes,
    brightness,
    contrast,
    imgTick,
    dprTick,
    imageWidth,
    imageHeight,
    lineEditAction,
    cutPending,
    magnetMode,
    showDerivedBoxes,
    ghostAnchor,
    bboxRect,
  ]);

  const cursor =
    dragRef.current?.kind === 'pan'
      ? 'grabbing'
      : spaceHeld
        ? 'grab'
        : editor.state.mode === 'draw' || lineEditAction !== 'none'
          ? 'crosshair'
          : hoverCursor;

  return (
    <div ref={containerRef} className={`ga-canvas-root ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        className="ga-canvas-surface"
        style={{ width: canvasSize.w, height: canvasSize.h, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      {imgError && (
        <div className="ga-canvas-error" role="status">
          <p className="ga-canvas-error-text">画像の読み込みに失敗しました</p>
        </div>
      )}
      {/* 短縮の「残す側」選択UI（中心線クリック位置の近くに表示） */}
      {cutPending &&
        view &&
        (() => {
          const [ox, oy] = toScreenPt(cutPending.point);
          const left = Math.min(Math.max(ox + 10, 4), canvasSize.w - 200);
          const top = Math.min(Math.max(oy + 10, 4), canvasSize.h - 44);
          const doCut = (keep: 'start' | 'end'): void => {
            editor.dispatch({
              type: 'cutLine',
              id: cutPending.polygonId,
              branchIndex: cutPending.branchIndex,
              segIndex: cutPending.segIndex,
              t: cutPending.t,
              keep,
            });
            setCutPending(null);
          };
          return (
            <div className="ga-canvas-cut" style={{ left, top }}>
              {cutPending.branchIndex === 0 ? (
                <>
                  <button type="button" className="ga-canvas-cut-btn" onClick={() => doCut('start')}>
                    始点側を残す
                  </button>
                  <button type="button" className="ga-canvas-cut-btn" onClick={() => doCut('end')}>
                    終点側を残す
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="ga-canvas-cut-btn" onClick={() => doCut('start')}>
                    付け根側を残す
                  </button>
                  <button
                    type="button"
                    className="ga-canvas-cut-btn"
                    onClick={() => {
                      editor.dispatch({
                        type: 'deleteBranch',
                        id: cutPending.polygonId,
                        branchIndex: cutPending.branchIndex,
                      });
                      setCutPending(null);
                    }}
                  >
                    分岐を削除
                  </button>
                </>
              )}
              <button
                type="button"
                className="ga-canvas-cut-close"
                onClick={() => setCutPending(null)}
                aria-label="キャンセル"
              >
                ×
              </button>
            </div>
          );
        })()}
      {/* ゴーストガイド: 「Tab 確定」ヒントチップ（カーソル近傍・キャンバス内にクランプ）。
          表示条件は state の ghostAnchor で判定（render で ref を読まない）。 */}
      {(() => {
        const d = editor.state.draft;
        if (!view || !mousePos || !ghostAnchor || !magnetMode) return null;
        if (editor.state.mode !== 'draw' || !d || d.tool !== 'line' || d.points.length < 1) {
          return null;
        }
        const anchor = d.points[d.points.length - 1];
        if (ghostAnchor[0] !== anchor[0] || ghostAnchor[1] !== anchor[1]) return null;
        const [mx, my] = toScreenPt(mousePos);
        const left = Math.min(Math.max(mx + 12, 4), canvasSize.w - 110);
        const top = Math.min(Math.max(my + 14, 4), canvasSize.h - 30);
        return (
          <div className="ga-canvas-chip" style={{ left, top }}>
            <kbd className="ga-canvas-chip-key">Tab</kbd>
            <span className="ga-canvas-chip-label">ガイド確定</span>
          </div>
        );
      })()}
    </div>
  );
}
