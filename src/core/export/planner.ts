// =============================================================================
// エクスポートプランナ（M6 の中心・純関数）。
// 「どのファイルに何を書くか」を全て決め切り、I/O は runner に任せる。
//
// 参照実装（reference/backend/app/services/annotation_export.py）の事故防止策を
// 全て踏襲する:
//  1. scope=done は done のみ / scope=all は done + 「アノテ 1 件以上の in_progress」。
//     pending / skipped は絶対に含めない
//  2. 空ラベル（負例）になれるのは status=done の画像だけ
//  3. 座標は [0,W]×[0,H] にクランプ、非有限は 0 へ
//  4. 面積 < TINY_POLYGON_AREA(2px²) は除外して manifest に記録。
//     除外の結果アノテが全滅した画像は **負例にせずスキップ**（黙った誤負例の防止）
//  5. train/val は画像単位の独立ハッシュ閾値方式（split.ts）
//
// GenbaAnno 固有の追加判断（いずれも「黙って誤負例を作らない」原則の延長）:
//  - クラス ID は id 昇順で 0..N-1 へリマップ（classes.ts に理由）
//  - フォーマット対象外の kind しか無くなった画像もスキップ
//    （例: yolo_seg 既定=bbox を含めない で bbox だけの画像 → 空ラベルは偽陰性教師）
//  - 面積フィルタは bbox にも適用（w*h。潰れた bbox は学習を壊す）
// =============================================================================

import { bboxOfPoints, bboxToPolygon, polygonArea } from '../geometry';
import { TINY_POLYGON_AREA } from '../types';
import type {
  Annotation,
  BBox,
  ClassDef,
  ExportImageInput,
  ExportParams,
  Pt,
} from '../types';
import { buildClassIdMap } from './classes';
import type { ClassIdMap } from './classes';
import { buildCoco, buildCocoCategories, cocoRelPath, serializeCoco } from './coco';
import { buildManifest, createExcludedAccumulator } from './manifest';
import type { ExcludedAccumulator } from './manifest';
import { MAX_EXPORT_IMAGE_PIXELS } from './plan';
import type {
  ExportItem,
  ExportMaskTarget,
  ExportPlan,
  ExportPlanFile,
  ExportPlanImage,
  PreparedImage,
} from './plan';
import { assignSplit } from './split';
import { yoloDetLabelFile } from './yoloDet';
import { buildDataYaml } from './yoloCommon';
import { yoloSegLabelFile } from './yoloSeg';

export interface BuildExportPlanOptions {
  /** 画像コピーに失敗したファイル名（runner が再プラン時に渡す。manifest に記録） */
  missingFiles?: string[];
  /**
   * 読み込めなかったサイドカーのファイル名（adapter.loadAllSidecars の corrupt）。
   * 対象から黙って消えるのを防ぐため manifest に残す。
   */
  corruptSidecars?: string[];
  /** サイドカー読込時の警告（serialize の warnings）。空のファイルは渡さないこと */
  sidecarWarnings?: { file: string; warnings: string[] }[];
  /** exported_at を固定する（テスト・再プランで同一値を使うため） */
  now?: string;
}

export function buildExportPlan(
  images: ExportImageInput[],
  params: ExportParams,
  classes: ClassDef[],
  options: BuildExportPlanOptions = {},
): ExportPlan {
  const now = options.now ?? new Date().toISOString();
  const classMap = buildClassIdMap(classes);
  const excluded = createExcludedAccumulator();
  excluded.missingFiles = [...(options.missingFiles ?? [])];
  excluded.corruptSidecars = [...(options.corruptSidecars ?? [])];
  excluded.sidecarWarnings = (options.sidecarWarnings ?? []).filter((w) => w.warnings.length > 0);

  const classFilter =
    params.format === 'mask_png' && params.classFilter && params.classFilter.length > 0
      ? new Set(params.classFilter)
      : null;

  // --- 1. scope による候補選択（pending / skipped は絶対除外） -----------------
  const candidates = images.filter((img) => {
    if (img.status === 'done') return true;
    if (params.scope === 'all' && img.status === 'in_progress') {
      return img.annotations.length > 0;
    }
    return false;
  });

  // --- 2. ファイル名衝突の検出（先に現れた方を採用し、後続はスキップ） ---------
  const accepted = rejectNameCollisions(candidates, params, excluded);

  // --- 3. 画像ごとの前処理（クランプ・クラス解決・面積フィルタ・負例判定） -----
  const prepared: PreparedImage[] = [];
  let negatives = 0;
  let annotationsExported = 0;

  for (const img of accepted) {
    const dimError = checkDimensions(img.width, img.height);
    if (dimError !== null) {
      // 正規化できない・巨大すぎる = ラベルもマスクも作れない。負例にもせずスキップする
      excluded.invalidDimensions.push(`${img.file} (${dimError})`);
      continue;
    }
    const items = prepareItems(img, params, classMap, classFilter, excluded);
    if (items === null) continue;
    if (items.length === 0) negatives += 1;
    annotationsExported += items.length;
    prepared.push({
      file: img.file,
      stem: fileStem(img.file),
      width: img.width,
      height: img.height,
      split: assignSplit(img.file, params.seed, params.valRatio),
      items,
    });
  }

  // --- 4. フォーマット別の出力ファイル ---------------------------------------
  const planImages: ExportPlanImage[] = prepared.map((img) => ({
    srcFile: img.file,
    destRelPath: `images/${img.split}/${img.file}`,
    split: img.split,
  }));
  const textFiles: ExportPlanFile[] = [];
  let maskTargets: ExportMaskTarget[] | undefined;

  if (params.format === 'yolo_det' || params.format === 'yolo_seg') {
    const toLabel = params.format === 'yolo_det' ? yoloDetLabelFile : yoloSegLabelFile;
    for (const img of prepared) {
      textFiles.push({
        relPath: `labels/${img.split}/${img.stem}.txt`,
        content: toLabel(img),
        srcFile: img.file,
      });
    }
    textFiles.push({
      relPath: 'data.yaml',
      content: buildDataYaml(
        classMap.ordered,
        params.format,
        prepared.some((img) => img.split === 'val'),
      ),
    });
  } else if (params.format === 'coco') {
    const categories = buildCocoCategories(classMap.ordered);
    for (const split of ['train', 'val'] as const) {
      textFiles.push({
        relPath: cocoRelPath(split),
        content: serializeCoco(
          buildCoco(
            prepared.filter((img) => img.split === split),
            categories,
          ),
        ),
      });
    }
  } else {
    maskTargets = prepared.map((img) => ({
      srcFile: img.file,
      destRelPath: `masks/${img.split}/${img.stem}.png`,
      width: img.width,
      height: img.height,
      polygons: img.items.map((item) => item.points),
    }));
  }

  const manifest = buildManifest({
    params,
    classes: classMap.ordered,
    images: prepared,
    negatives,
    annotationsExported,
    excluded,
    now,
  });

  return maskTargets
    ? { textFiles, images: planImages, maskTargets, manifest }
    : { textFiles, images: planImages, manifest };
}

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

/**
 * 画像寸法が扱えるか検査する。扱えない場合は manifest に残す理由文字列を返す。
 *
 * サイドカーは手で壊せる（エディタで書き換え・別ツールが生成）ため、
 * width/height を信用して `new Uint8Array(w*h)` すると RangeError や
 * 数 GB の確保でアプリが落ちる。M2 の serialize 側でもクランプされるが、
 * エクスポートは「壊れたデータが最後に通る場所」なので独立に自衛する。
 */
function checkDimensions(width: number, height: number): string | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return `invalid size: ${String(width)}x${String(height)}`;
  }
  if (width * height > MAX_EXPORT_IMAGE_PIXELS) {
    return `too large: ${width}x${height} > ${MAX_EXPORT_IMAGE_PIXELS}px`;
  }
  return null;
}

/**
 * 出力先で名前が衝突する画像を弾く。
 *  - yolo_det / yolo_seg / mask_png: ラベル名は `<stem>.txt` / `<stem>.png` になるため
 *    **拡張子を除いた名前**（小文字化）で衝突する（`a.jpg` と `a.png` も衝突）
 *  - coco: 画像ごとのファイルを作らないので、実際に衝突するのは
 *    大文字小文字違いの同名画像だけ（Windows/macOS は既定で大小非区別）
 * 先に現れた方を採用し、後続を manifest.excluded.name_collisions へ記録してスキップする。
 */
function rejectNameCollisions(
  candidates: ExportImageInput[],
  params: ExportParams,
  excluded: ExcludedAccumulator,
): ExportImageInput[] {
  const seen = new Map<string, string>();
  const accepted: ExportImageInput[] = [];
  for (const img of candidates) {
    const key =
      params.format === 'coco' ? img.file.toLowerCase() : fileStem(img.file).toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      excluded.nameCollisions.push(`${img.file} (collides with ${first})`);
      continue;
    }
    seen.set(key, img.file);
    accepted.push(img);
  }
  return accepted;
}

/**
 * 1 画像分のアノテーションを ExportItem 列へ落とす。
 * 出力してはいけない画像（誤負例になる画像）は null を返す。
 */
function prepareItems(
  img: ExportImageInput,
  params: ExportParams,
  classMap: ClassIdMap,
  classFilter: Set<number> | null,
  excluded: ExcludedAccumulator,
): ExportItem[] | null {
  const items: ExportItem[] = [];
  let removedByData = 0; // 面積不足・未知クラス（データ側の問題）
  let removedByKind = 0; // このフォーマットの対象外 kind
  // クラスフィルタだけで 0 件になった場合は「そのクラスが写っていない画像」＝
  // 正しい負例なので、件数を数えず下の status 判定へ落とす（参照実装と同じ）

  for (const ann of img.annotations) {
    if (!isKindIncluded(ann, params)) {
      removedByKind += 1;
      continue;
    }
    if (classFilter && !classFilter.has(ann.classId)) {
      continue;
    }
    const exportClassId = classMap.toExportId.get(ann.classId);
    if (exportClassId === undefined) {
      // プロジェクトのクラス定義に無い id。学習 ID に写像できないため落とす
      excluded.unknownClassAnnotations.push({
        file: img.file,
        annotation_id: ann.id,
        class_id: ann.classId,
      });
      removedByData += 1;
      continue;
    }

    const geom = toGeometry(ann, img.width, img.height);
    if (geom.area < TINY_POLYGON_AREA) {
      excluded.tinyPolygons.push({
        file: img.file,
        annotation_id: ann.id,
        area: Math.round(geom.area * 1000) / 1000,
      });
      removedByData += 1;
      continue;
    }
    items.push({
      annotationId: ann.id,
      sourceClassId: ann.classId,
      classId: exportClassId,
      kind: ann.kind,
      points: geom.points,
      box: geom.box,
      area: geom.area,
    });
  }

  if (items.length > 0) return items;

  // --- ここから「0 件になった画像をどう扱うか」= 誤負例化の防止線 ---
  if (removedByData > 0) {
    // アノテはあったのに面積不足／未知クラスで全滅 → 負例化せずスキップ
    excluded.skippedAllTooSmall.push(img.file);
    return null;
  }
  if (removedByKind > 0) {
    // 例: yolo_seg（bbox を含めない設定）で bbox しか無い画像。
    // 空ラベルにすると「物体が無い」と教えることになるためスキップ
    excluded.skippedNoAnnotationsForFormat.push(img.file);
    return null;
  }
  if (img.status !== 'done') {
    // 空ラベル負例になれるのは done のみ（クラスフィルタで空になった in_progress を含む）
    excluded.skippedInProgressWithoutAnnotations.push(img.file);
    return null;
  }
  // done かつ 0 件（元から 0 件 / クラスフィルタで 0 件）= 正しい負例
  return items;
}

/** そのフォーマットで、この kind を出力対象にするか */
function isKindIncluded(ann: Annotation, params: ExportParams): boolean {
  switch (params.format) {
    case 'yolo_det':
      // bbox は常に。polygon/line は外接矩形として含めるオプション次第
      return ann.kind === 'bbox' ? true : params.includeDerivedBoxes;
    case 'yolo_seg':
      // polygon/line は常に。bbox は矩形ポリゴン化オプション次第
      return ann.kind === 'bbox' ? params.includeBBoxAsPolygon : true;
    case 'coco':
      return true;
    case 'mask_png':
      // 塗れるのは輪郭を持つものだけ
      return ann.kind !== 'bbox';
  }
}

interface Geometry {
  points: Pt[];
  box: BBox;
  area: number;
}

/** クランプ済みのポリゴン・外接矩形・面積を作る */
function toGeometry(ann: Annotation, width: number, height: number): Geometry {
  if (ann.kind === 'bbox') {
    const box = clampBox(ann.box, width, height);
    return { points: bboxToPolygon(box), box, area: box.w * box.h };
  }
  const points = clampPoints(ann.points, width, height);
  return { points, box: bboxOfPoints(points), area: polygonArea(points) };
}

/** 参照実装 clamp_points 同等: [0,W]×[0,H] へクランプし、非有限は 0 にする */
export function clampPoints(points: Pt[], width: number, height: number): Pt[] {
  return points.map(([x, y]): Pt => [clamp(x, width), clamp(y, height)]);
}

/**
 * bbox を画像内へクランプする。
 * geometry.ts の clampBBoxToImage は「はみ出したら平行移動して収める」編集用の挙動で、
 * エクスポートでは位置がズレてしまう。ここでは画像端で切り詰める。
 */
function clampBox(box: BBox, width: number, height: number): BBox {
  const x1 = clamp(box.x, width);
  const y1 = clamp(box.y, height);
  const x2 = clamp(box.x + box.w, width);
  const y2 = clamp(box.y + box.h, height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function clamp(v: number, upper: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, 0), upper);
}

/** 拡張子を除いたファイル名（パス区切りが混ざっていても最後の要素を使う） */
export function fileStem(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
