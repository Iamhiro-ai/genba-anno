// =============================================================================
// M6 エクスポートモジュールの公開窓口。
// 呼び出し側（src/export/runner.ts・M5 の ExportDialog）はここだけを import する。
// =============================================================================

export { buildClassIdMap } from './classes';
export type { ClassIdMap } from './classes';
export {
  buildCoco,
  buildCocoCategories,
  cocoRelPath,
  serializeCoco,
} from './coco';
export type {
  CocoAnnotation,
  CocoCategory,
  CocoDataset,
  CocoImage,
} from './coco';
export { readJpegOrientation } from './exif';
export { buildManifest, createExcludedAccumulator, serializeManifest } from './manifest';
export type { ExcludedAccumulator } from './manifest';
export { encodeMaskPng, MASK_FOREGROUND, rasterizePolygons, renderMaskPng } from './maskPng';
export { EXPORT_MANIFEST_FILE, MAX_EXPORT_IMAGE_PIXELS } from './plan';
export type {
  ExportClassMapping,
  ExportItem,
  ExportMaskTarget,
  ExportPlan,
  ExportPlanFile,
  ExportPlanImage,
  GenbaExportManifest,
  PreparedImage,
  SplitName,
} from './plan';
export { buildExportPlan, clampPoints, fileStem } from './planner';
export type { BuildExportPlanOptions } from './planner';
export { assignSplit, sha1Hex } from './split';
export { yoloDetLabelFile, yoloDetLabelLines } from './yoloDet';
export { buildDataYaml, joinLabelLines, norm } from './yoloCommon';
export { yoloSegLabelFile, yoloSegLabelLines } from './yoloSeg';
