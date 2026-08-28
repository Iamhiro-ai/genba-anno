// =============================================================================
// COCO: annotations/{train,val}.json。
// スキーマは reference の build_coco()（notebooks/crack_us/build_dataset.py 互換）
// と同一にする:
//   images      = { id, file_name, width, height }            id は split 内で 1 始まり
//   annotations = { id, image_id, category_id, segmentation, bbox, area, iscrowd }
//   categories  = { id, name, supercategory }                 id は 0 始まり
//
// GenbaAnno 追加分:
//   - category_id は「リマップ後の学習 ID」（0 始まり・categories の id と一致）
//   - kind=bbox のアノテーションは輪郭を持たないため segmentation: [] とし、
//     area は w*h（ポリゴンは shoelace 面積）
// =============================================================================

import type { ExportClassMapping, PreparedImage, SplitName } from './plan';

export interface CocoImage {
  id: number;
  file_name: string;
  width: number;
  height: number;
}

export interface CocoAnnotation {
  id: number;
  image_id: number;
  category_id: number;
  /** ポリゴンは [flat 1 本]、bbox kind は [] */
  segmentation: number[][];
  /** [x, y, w, h] */
  bbox: [number, number, number, number];
  area: number;
  iscrowd: 0;
}

export interface CocoCategory {
  id: number;
  name: string;
  supercategory: 'genba-anno';
}

export interface CocoDataset {
  images: CocoImage[];
  annotations: CocoAnnotation[];
  categories: CocoCategory[];
}

export function buildCocoCategories(classes: ExportClassMapping[]): CocoCategory[] {
  return classes.map((c) => ({ id: c.exportId, name: c.name, supercategory: 'genba-anno' }));
}

/** split 1 つ分の COCO データセットを組み立てる（画像 id / annotation id は 1 始まり） */
export function buildCoco(images: PreparedImage[], categories: CocoCategory[]): CocoDataset {
  const out: CocoDataset = { images: [], annotations: [], categories };
  let imgId = 0;
  let annId = 0;
  for (const img of images) {
    imgId += 1;
    out.images.push({ id: imgId, file_name: img.file, width: img.width, height: img.height });
    for (const item of img.items) {
      annId += 1;
      const { x, y, w, h } = item.box;
      out.annotations.push({
        id: annId,
        image_id: imgId,
        category_id: item.classId,
        segmentation:
          item.kind === 'bbox' ? [] : [item.points.flatMap(([px, py]) => [px, py])],
        bbox: [x, y, w, h],
        area: item.area,
        iscrowd: 0,
      });
    }
  }
  return out;
}

/** annotations/{split}.json の相対パス */
export function cocoRelPath(split: SplitName): string {
  return `annotations/${split}.json`;
}

export function serializeCoco(dataset: CocoDataset): string {
  return JSON.stringify(dataset);
}
