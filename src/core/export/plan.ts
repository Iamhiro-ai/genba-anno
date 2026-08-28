// =============================================================================
// エクスポートプラン（planner の出力）の型定義。
// M6: DOM 非依存の純 TS。ここには型と定数のみを置く（ロジックは planner/各生成器）。
//
// 設計意図: 「何を書くか」を純関数で決め切り、実際の I/O（fs 書込・画像取得・
// 再エンコード）は src/export/runner.ts が配管として実行する。これにより
// 出力内容の全ケースを DOM 無しで単体テストできる（docs/DESIGN.md §5）。
// =============================================================================

import type { AnnotationKind, BBox, ExportManifest, Pt } from '../types';

/** 出力するテキスト/バイナリファイル1件（ラベル・data.yaml・COCO json 等） */
export interface ExportPlanFile {
  /** 出力先フォルダからの相対パス（'/' 区切り。パス結合は main 側の責務） */
  relPath: string;
  content: string | Uint8Array;
  /**
   * 由来画像のファイル名（画像1枚に対応するラベルのみ設定）。
   * 画像コピーに失敗した場合に「そのラベルだけを落とす」判断へ使う。
   */
  srcFile?: string;
}

/** プロジェクト内の画像をデータセットへコピー（または再エンコード）する対象 */
export interface ExportPlanImage {
  /** プロジェクトフォルダ直下のファイル名 */
  srcFile: string;
  /** 出力先相対パス（images/{train,val}/<file>） */
  destRelPath: string;
  split: SplitName;
}

/** mask_png のマスク1枚分。ラスタライズは runner が1枚ずつ実行する（メモリ節約） */
export interface ExportMaskTarget {
  srcFile: string;
  /** masks/{train,val}/<stem>.png */
  destRelPath: string;
  width: number;
  height: number;
  /** 画像ピクセル座標・クランプ済み。空配列 = 全 0 の負例マスク */
  polygons: Pt[][];
}

export type SplitName = 'train' | 'val';

/** クラス ID リマップ表の1行（source_id 昇順に export_id 0..N-1 を振る） */
export interface ExportClassMapping {
  sourceId: number;
  exportId: number;
  name: string;
}

/**
 * 契約 ExportManifest（src/core/types.ts）へ **追加のみ** した拡張マニフェスト。
 * 契約側のフィールドは一切変更していないため ExportManifest として扱える。
 *
 * 追加理由:
 *  - class_id_map: 学習 ID をリマップする以上、対応表が無いと推論結果を元クラスへ戻せない
 *  - excluded_extra: 契約 excluded に無い「除外の理由」を潰さずに残す（誤負例化調査用）
 */
export interface GenbaExportManifest extends ExportManifest {
  /** プロジェクトのクラス id → 学習 ID（0..N-1）の対応表 */
  class_id_map: { source_id: number; export_id: number; name: string }[];
  excluded_extra: {
    /** 面積閾値（px²） */
    min_annotation_area_px2: number;
    /** プロジェクトのクラス定義に無い class_id を持っていたアノテーション */
    unknown_class_annotations: { file: string; annotation_id: string; class_id: number }[];
    /** クラスフィルタ等で対象が 0 件になった in_progress 画像（負例にしてはいけない） */
    skipped_in_progress_without_annotations: string[];
    /** そのフォーマットの対象 kind が 1 件も無くなった画像（誤負例化防止でスキップ） */
    skipped_no_annotations_for_format: string[];
    /**
     * width/height が不正で扱えなかった画像（理由付き）。
     * <=0・非有限・非安全整数・巨大すぎ（MAX_EXPORT_IMAGE_PIXELS 超）。
     */
    invalid_dimensions: string[];
    /**
     * 読み込めずスキップされたサイドカー（adapter が JSON パースに失敗したもの）。
     * これを残さないと「壊れた 1 枚が黙ってエクスポートから消える」ことに気付けない。
     */
    corrupt_sidecars: string[];
    /** 読み込めたが修復・切り捨てが発生したサイドカーの警告（serialize の warnings） */
    sidecar_warnings: { file: string; warnings: string[] }[];
  };
}

export interface ExportPlan {
  /** ラベル・data.yaml・COCO json など。manifest は含まない（runner が最後に書く） */
  textFiles: ExportPlanFile[];
  images: ExportPlanImage[];
  /** mask_png のときのみ */
  maskTargets?: ExportMaskTarget[];
  manifest: GenbaExportManifest;
}

/**
 * フォーマット非依存に前処理済みのアノテーション1件。
 * planner が「クランプ → クラス解決 → 面積フィルタ」まで済ませ、
 * 各フォーマット生成器は座標を並べ替えるだけで済むようにする。
 */
export interface ExportItem {
  annotationId: string;
  /** 元のクラス ID（プロジェクト定義） */
  sourceClassId: number;
  /** リマップ後の学習 ID（0..N-1） */
  classId: number;
  /** 元の kind（COCO の segmentation 有無の判定に使う） */
  kind: AnnotationKind;
  /** クランプ済みポリゴン（kind=bbox は矩形4点） */
  points: Pt[];
  /** クランプ済み外接矩形（kind=bbox はその box そのもの） */
  box: BBox;
  /** 面積 px²（polygon/line は shoelace・bbox は w*h） */
  area: number;
}

/** 1画像分の前処理結果（planner 内部 → 各フォーマット生成器へ渡す） */
export interface PreparedImage {
  file: string;
  /** 拡張子を除いた名前（ラベル・マスクのファイル名に使う） */
  stem: string;
  width: number;
  height: number;
  split: SplitName;
  items: ExportItem[];
}

/** マニフェストのファイル名（出力先直下） */
export const EXPORT_MANIFEST_FILE = 'export_manifest.json';

/**
 * エクスポートが受け付ける画像の最大画素数（width × height）= 2^27 px。
 *
 * 壊れたサイドカーの width/height（例: 1e9）をそのまま信じると、
 * マスク生成の `new Uint8Array(w*h)` が RangeError または数 GB の確保になり
 * アプリごと落ちる。実在する画像（8K = 約 3,300 万px）の 4 倍を上限として、
 * これを超える寸法は「サイドカーが壊れている」と判断してスキップする。
 * 多層防御: planner が該当画像を除外し、maskPng も同じ上限で自衛する。
 */
export const MAX_EXPORT_IMAGE_PIXELS = 1 << 27; // 134,217,728 px
