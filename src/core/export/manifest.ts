// =============================================================================
// export_manifest.json の組み立て。
// 出自: reference の manifest（除外内訳を必ず残す設計）。
//
// マニフェストは「出力されなかったものを説明する」ためにある。
// 黙って消えたアノテーション／黙って負例になった画像はデータセット事故の温床なので、
// 除外は必ずここへ理由付きで残す。
// =============================================================================

import { TINY_POLYGON_AREA } from '../types';
import type { ExportParams } from '../types';
import type { ExportClassMapping, GenbaExportManifest, PreparedImage } from './plan';

/** planner が集計しながら詰めていく除外記録 */
export interface ExcludedAccumulator {
  tinyPolygons: { file: string; annotation_id: string; area: number }[];
  skippedAllTooSmall: string[];
  missingFiles: string[];
  nameCollisions: string[];
  unknownClassAnnotations: { file: string; annotation_id: string; class_id: number }[];
  skippedInProgressWithoutAnnotations: string[];
  skippedNoAnnotationsForFormat: string[];
  /** 理由付き（例: 'bad.jpg (invalid size: 0x100)'） */
  invalidDimensions: string[];
  /** adapter が読めなかったサイドカー（runner から渡る） */
  corruptSidecars: string[];
  /** serialize が出した警告（runner から渡る。警告が空のファイルは含めない） */
  sidecarWarnings: { file: string; warnings: string[] }[];
}

export function createExcludedAccumulator(): ExcludedAccumulator {
  return {
    tinyPolygons: [],
    skippedAllTooSmall: [],
    missingFiles: [],
    nameCollisions: [],
    unknownClassAnnotations: [],
    skippedInProgressWithoutAnnotations: [],
    skippedNoAnnotationsForFormat: [],
    invalidDimensions: [],
    corruptSidecars: [],
    sidecarWarnings: [],
  };
}

export interface BuildManifestInput {
  params: ExportParams;
  classes: ExportClassMapping[];
  /** 実際に出力される画像（split 確定済み） */
  images: PreparedImage[];
  negatives: number;
  annotationsExported: number;
  excluded: ExcludedAccumulator;
  /** ISO8601。テストで固定できるよう外から渡す */
  now: string;
}

export function buildManifest(input: BuildManifestInput): GenbaExportManifest {
  const { params, classes, images, excluded } = input;
  const split: Record<string, 'train' | 'val'> = {};
  let train = 0;
  let val = 0;
  for (const img of images) {
    split[img.file] = img.split;
    if (img.split === 'val') val += 1;
    else train += 1;
  }

  return {
    app: 'genba-anno',
    exported_at: input.now,
    params: {
      format: params.format,
      scope: params.scope,
      val_ratio: params.valRatio,
      seed: params.seed,
      // 空配列は「未指定 = 全クラス」として扱う（planner と一致させる）
      ...(params.format === 'mask_png' && params.classFilter && params.classFilter.length > 0
        ? { class_filter: [...params.classFilter].sort((a, b) => a - b) }
        : {}),
      ...(params.format === 'yolo_det' ? { include_derived_boxes: params.includeDerivedBoxes } : {}),
      ...(params.format === 'yolo_seg'
        ? { include_bbox_as_polygon: params.includeBBoxAsPolygon }
        : {}),
    },
    // 学習 ID（0..N-1）と名前。data.yaml の names 並びと一致する
    classes: classes.map((c) => ({ id: c.exportId, name: c.name })),
    counts: {
      images_train: train,
      images_val: val,
      negatives: input.negatives,
      annotations_exported: input.annotationsExported,
    },
    excluded: {
      tiny_polygons: excluded.tinyPolygons,
      skipped_all_polygons_too_small: excluded.skippedAllTooSmall,
      missing_files: excluded.missingFiles,
      name_collisions: excluded.nameCollisions,
    },
    split,
    class_id_map: classes.map((c) => ({
      source_id: c.sourceId,
      export_id: c.exportId,
      name: c.name,
    })),
    excluded_extra: {
      min_annotation_area_px2: TINY_POLYGON_AREA,
      unknown_class_annotations: excluded.unknownClassAnnotations,
      skipped_in_progress_without_annotations: excluded.skippedInProgressWithoutAnnotations,
      skipped_no_annotations_for_format: excluded.skippedNoAnnotationsForFormat,
      invalid_dimensions: excluded.invalidDimensions,
      corrupt_sidecars: excluded.corruptSidecars,
      sidecar_warnings: excluded.sidecarWarnings,
    },
  };
}

export function serializeManifest(manifest: GenbaExportManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
