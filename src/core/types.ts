// =============================================================================
// GenbaAnno データモデル・エディタ状態の型定義（実装契約）
// 管理: オーケストレーター。変更にはオーケストレーター承認が必要。
// 設計書: docs/DESIGN.md
//
// 出自: reference/frontend/src/types/annotation.ts（路面診断アプリ）を基に、
//   - bbox（バウンディングボックス）を判別可能ユニオンとして追加
//   - API 型（サーバ通信）を撤去し、ディスク上サイドカー型（snake_case）を追加
//   - Polygon → Annotation へ改名（kind 判別）
// LineMeta / DraftTarget / エディタアクションの意味論は参照実装と同一に保つこと。
// =============================================================================

// ---------------------------------------------------------------------------
// 基本型
// ---------------------------------------------------------------------------

/** 画像ピクセル座標の点 [x, y]（EXIF 回転適用後の naturalWidth/Height 基準） */
export type Pt = [number, number];

export type AnnotationStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

/** クラス定義（プロジェクト設定で編集可能。id はエクスポートの学習 ID） */
export interface ClassDef {
  id: number;
  name: string; // 学習データに出る英語名（例: 'crack'）
  nameJa: string; // UI 表示名（例: 'ひび割れ'）
  color: string; // '#RRGGBB'
}

// ---------------------------------------------------------------------------
// アノテーション（判別可能ユニオン）
// ---------------------------------------------------------------------------

/** ライン由来ポリゴンの中心線メタデータ（参照実装 v3 と同一構造）。 */
export interface LineMeta {
  /** 中心線ポリライン群。[0]=幹、[1..]=分岐（先頭点が幹/他枝上のアンカー） */
  branches: Pt[][];
  /** 代表幅（画像px・widths の中央値。スライダー表示と旧データの一様幅を兼ねる） */
  width: number;
  /** 枝ごと・点ごとの局所幅（branches と同形状）。無ければ width の一様幅 */
  widths?: number[][];
}

/** 軸平行バウンディングボックス（x,y = 左上、画像ピクセル座標） */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotationKind = 'bbox' | 'polygon' | 'line';
export type AnnotationSource = 'manual' | 'imported';

interface AnnotationBase {
  id: string; // crypto.randomUUID()
  classId: number;
  source: AnnotationSource;
}

export interface BBoxAnnotation extends AnnotationBase {
  kind: 'bbox';
  box: BBox;
}

export interface PolygonAnnotation extends AnnotationBase {
  kind: 'polygon';
  points: Pt[]; // 3点以上の閉ポリゴン（終点=始点の重複は持たない）
}

/**
 * マグネットライン由来のアノテーション。
 * points は lineMeta から生成された閉ポリゴン（可変幅リボン）。lineMeta が真実。
 * 頂点を手編集すると PolygonAnnotation に降格する（lineMeta 破棄・トースト通知）。
 */
export interface LineAnnotation extends AnnotationBase {
  kind: 'line';
  points: Pt[];
  lineMeta: LineMeta;
}

export type Annotation = BBoxAnnotation | PolygonAnnotation | LineAnnotation;

// ---------------------------------------------------------------------------
// エディタ状態（useReducer 単一ストア）
// ---------------------------------------------------------------------------

export type EditorMode = 'edit' | 'draw';

/** 描画ツール。bbox はドラッグ描画のため draft を使わず、確定時に addAnnotation を発行する */
export type DrawTool = 'bbox' | 'polygon' | 'line';

/** 既存ライン（lineMeta 保持）への追記ターゲット（延長/分岐。参照実装 v2 と同一）。 */
export interface DraftTarget {
  polygonId: string; // 対象 LineAnnotation の id
  attach: 'start' | 'end' | 'branch'; // start/end=幹・枝端の延長、branch=中心線上から新枝
  branchIndex: number; // attach='branch' のときは -1（新枝を push）
  anchor: Pt; // 追記の起点（画像座標）。draft.points[0] と一致
}

/** polygon / line ツールのドラフト（bbox は canvas ローカルのドラッグ状態で扱う） */
export interface DraftState {
  tool: 'polygon' | 'line';
  points: Pt[]; // polygon: 確定頂点列 / line: 中心線の頂点列
  lineWidth: number; // line の代表幅（画像px）
  target?: DraftTarget; // 延長/分岐ドラフト。無ければ新規
  widths?: number[]; // points と同数の局所幅（マグネット推定・line のみ）
}

export interface EditorState {
  annotations: Annotation[];
  selectedId: string | null;
  mode: EditorMode;
  drawTool: DrawTool;
  activeClassId: number;
  lineWidth: number; // line ツールの現在の線幅（画像px）。4..200 にクランプ
  draft: DraftState | null;
  fillVisible: boolean;
  dirty: boolean; // annotations が最終保存から変化したか（draft は含まない。ページ側で合成判定）
  imageWidth: number; // load で設定。クランプに使用
  imageHeight: number;
  past: Annotation[][];
  future: Annotation[][];
  gestureActive: boolean; // ドラッグジェスチャ進行中（undo/redo は無視される）
  gestureDirtyBefore: boolean; // beginGesture 直前の dirty（無変化ドラッグ時の復元用）
  /**
   * 内部管理用: 最終保存時点（markSaved / load）の annotations スナップショット。
   * undo/redo で保存時点の内容に戻ったとき dirty を false に戻すために使う
   * （dirty の定義「annotations が最終保存から変化したか」を満たすため）。
   * UI から直接参照しないこと。
   */
  savedAnnotations: Annotation[];
}

export type EditorAction =
  | { type: 'load'; annotations: Annotation[]; imageWidth: number; imageHeight: number }
  | { type: 'setMode'; mode: EditorMode }
  | { type: 'setDrawTool'; tool: DrawTool } // draw モードにも切り替える
  | { type: 'setActiveClass'; classId: number } // 選択中アノテーションがあればそのクラスも変更（履歴に積む）
  | { type: 'setLineWidth'; width: number } // 4..200 クランプ。draft があれば widths を全体スケール
  | { type: 'startDraft'; point: Pt; target?: DraftTarget } // polygon/line のみ（target 付き=延長/分岐）
  | { type: 'addDraftPoint'; point: Pt; width?: number } // width=マグネット推定の局所幅
  | { type: 'popDraftPoint' } // 最後の頂点を削除。0 点になったら draft を null に
  | { type: 'commitDraft' } // polygon: ≥3点(終端重複除去後) / line: ≥2点→リボン生成。target 付きは対象へマージ
  | { type: 'cancelDraft' } // target 付きの場合は edit モードへ戻る
  | { type: 'addAnnotation'; annotation: Annotation } // bbox 確定・将来のインポート用（履歴に積む・クランプ）
  | { type: 'resizeBBox'; id: string; box: BBox } // ハンドルドラッグ中（beginGesture/endGesture で囲む）
  | { type: 'resizeLine'; id: string; width: number } // lineMeta の幅変更→リボン再生成（gesture で囲む）
  | { type: 'popLinePoint'; id: string } // 確定済みライン: 末尾の中心線点を1つ削除→再生成
  | { type: 'cutLine'; id: string; branchIndex: number; segIndex: number; t: number; keep: 'start' | 'end' }
  | { type: 'deleteBranch'; id: string; branchIndex: number } // 分岐削除（branchIndex>=1）
  | { type: 'select'; id: string | null }
  | { type: 'beginGesture' } // ドラッグ開始時に1回だけ履歴を積む
  | { type: 'endGesture' } // 無変化なら履歴を破棄し dirty を復元
  | { type: 'moveVertex'; id: string; index: number; point: Pt } // polygon/line（line は降格）
  | { type: 'insertVertex'; id: string; index: number; point: Pt } // points[index] の直前に挿入（降格）
  | { type: 'deleteVertex'; id: string; index: number } // 3点なら無視（降格）
  | { type: 'moveAnnotation'; id: string; delta: Pt } // 全体平行移動（クランプ・全 kind 対応）
  | { type: 'deleteAnnotation'; id: string }
  | { type: 'toggleFill' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'markSaved' }; // dirty = false

export interface AnnotationEditorApi {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
  /** draft が commit 可能か（polygon≥3点 / line≥2点） */
  canCommitDraft: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

// ---------------------------------------------------------------------------
// プロジェクト設定
// ---------------------------------------------------------------------------

export interface MagnetSettings {
  enabled: boolean; // マグネットモード既定 ON
  invert: boolean; // true = 明るい線（白線等）を追う反転モード
}

export interface ProjectSettings {
  defaultTool: DrawTool;
  magnet: MagnetSettings;
  lineWidthDefault: number;
}

/** プロジェクト（= 選択した画像フォルダ）の設定。_anno/project.json に永続化 */
export interface Project {
  schemaVersion: number;
  name: string;
  classes: ClassDef[];
  settings: ProjectSettings;
  createdAt: string; // ISO8601
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// ディスク上のサイドカー形式（snake_case。境界変換は core/serialize.ts のみ）
// ---------------------------------------------------------------------------

export interface SidecarLineMeta {
  branches: [number, number][][];
  width: number;
  widths?: number[][] | null;
}

export interface SidecarAnnotation {
  id: string;
  class_id: number;
  kind: AnnotationKind;
  source: AnnotationSource;
  box?: { x: number; y: number; w: number; h: number }; // kind=bbox
  points?: [number, number][]; // kind=polygon | line
  line_meta?: SidecarLineMeta | null; // kind=line
}

export interface SidecarFile {
  schema_version: number;
  image: { file: string; width: number; height: number };
  status: AnnotationStatus;
  annotations: SidecarAnnotation[];
  updated_at: string;
}

export interface ProjectFileJson {
  schema_version: number;
  app: 'genba-anno';
  name: string;
  classes: { id: number; name: string; name_ja: string; color: string }[];
  settings: {
    default_tool: DrawTool;
    magnet: { enabled: boolean; invert: boolean };
    line_width_default: number;
  };
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// 画像一覧・プロジェクト読込
// ---------------------------------------------------------------------------

/** 一覧表示用の画像エントリ（main がサイドカーを走査して要約を返す） */
export interface ImageEntry {
  file: string; // フォルダ直下のファイル名（パス区切りを含まない）
  status: AnnotationStatus; // サイドカー無しは 'pending'
  annotationCount: number;
}

export interface RecentProject {
  dir: string; // 絶対パス（mock では仮想 ID）
  name: string;
  lastOpenedAt: string;
}

// ---------------------------------------------------------------------------
// エクスポート
// ---------------------------------------------------------------------------

export type ExportFormat = 'yolo_det' | 'yolo_seg' | 'coco' | 'mask_png';
export type ExportScope = 'done' | 'all';

export interface ExportParams {
  format: ExportFormat;
  scope: ExportScope;
  valRatio: number; // 0..0.9（0 なら全 train）
  seed: number;
  /** mask_png のみ: 対象クラス ID（未指定は全クラス） */
  classFilter?: number[];
  /** yolo_det: polygon/line の外接矩形も bbox として含める（既定 true） */
  includeDerivedBoxes: boolean;
  /** yolo_seg: bbox を矩形ポリゴンとして含める（既定 false） */
  includeBBoxAsPolygon: boolean;
}

/** エクスポート対象1画像分の入力（生成器は純関数でこれを受け取る） */
export interface ExportImageInput {
  file: string;
  width: number;
  height: number;
  status: AnnotationStatus;
  annotations: Annotation[];
}

export interface ExportManifest {
  app: 'genba-anno';
  exported_at: string;
  params: {
    format: ExportFormat;
    scope: ExportScope;
    val_ratio: number;
    seed: number;
    class_filter?: number[];
    include_derived_boxes?: boolean;
    include_bbox_as_polygon?: boolean;
  };
  classes: { id: number; name: string }[];
  counts: {
    images_train: number;
    images_val: number;
    negatives: number; // done かつ 0件で出力された負例数
    annotations_exported: number;
  };
  excluded: {
    tiny_polygons: { file: string; annotation_id: string; area: number }[];
    skipped_all_polygons_too_small: string[]; // 全滅で除外した画像
    missing_files: string[];
    name_collisions: string[];
  };
  split: Record<string, 'train' | 'val'>; // ファイル名 → 所属
}

export interface ExportProgress {
  phase: 'scan' | 'labels' | 'images' | 'masks' | 'done';
  current: number;
  total: number;
  file?: string;
}

export interface ExportResult {
  destDir: string;
  manifest: ExportManifest;
}

// ---------------------------------------------------------------------------
// 動画フレーム抽出（M7）
// ---------------------------------------------------------------------------

export interface VideoExtractParams {
  videoPath: string;
  destDir: string; // 出力フォルダ（新規プロジェクトとして開ける）
  /** 抽出間隔: 'fps' なら毎秒 n 枚、'every_n' なら n フレームごと */
  mode: 'fps' | 'every_n';
  value: number;
  format: 'jpg' | 'png';
  quality: number; // jpg のみ 2..31（ffmpeg qscale。小さいほど高画質。既定 2）
  maxLongEdge?: number; // 長辺リサイズ（未指定は原寸）
}

export interface VideoExtractProgress {
  framesWritten: number;
  done: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

export const SIDECAR_SCHEMA_VERSION = 1;
export const PROJECT_SCHEMA_VERSION = 1;

/** 対応画像拡張子（小文字比較） */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'] as const;

/** プロジェクトデータフォルダ名（選択フォルダ直下） */
export const ANNO_DIR_NAME = '_anno';

export const LINE_WIDTH_MIN = 4;
export const LINE_WIDTH_MAX = 200;
export const BBOX_MIN_SIZE = 3; // 画像px。これ未満の bbox は確定しない
export const HISTORY_LIMIT = 100;
export const AUTOSAVE_DEBOUNCE_MS = 30_000;
export const TINY_POLYGON_AREA = 2; // px²。エクスポート時にこれ未満を除外

/** クラス追加時に順に割り当てるデフォルトパレット（視認性の高い順） */
export const DEFAULT_CLASS_COLORS = [
  '#E6002D', // 赤
  '#0075C2', // 青
  '#00A040', // 緑
  '#F39800', // 橙
  '#9B26B6', // 紫
  '#00B5AD', // 青緑
  '#E85298', // 桃
  '#8F76D6', // 藤
  '#B28850', // 茶
  '#5F6B77', // 灰青
] as const;
