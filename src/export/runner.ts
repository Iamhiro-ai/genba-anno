// =============================================================================
// エクスポート実行（レンダラ側の配管）。M6。
//
// **ここがブラウザ API（fetch / createImageBitmap / OffscreenCanvas）を使う唯一の場所**。
// 判断ロジックは全て src/core/export/planner.ts（純関数）にあり、この層は
//   サイドカー読込 → プラン生成 → 画像コピー/再エンコード → ファイル書込 → 進捗通知
// を順に流すだけに徹する（テストしにくい層を薄く保つ）。
//
// 処理順の判断: 参照実装と同様に **画像を先に書く**。
// 画像コピーに失敗した画像のラベル／COCO エントリが残ると
// 「存在しない画像を指すデータセット」になって学習が落ちるため、
// 欠損が出たらプランを作り直してからラベルを書く。
// =============================================================================

import type { ExportProgressHandler, ExportWriter, StorageAdapter } from '../adapters/types';
import { EXPORT_MANIFEST_FILE, buildExportPlan, renderMaskPng, serializeManifest } from '../core/export';
import type { ExportPlan, ExportPlanImage } from '../core/export';
import { readJpegOrientation } from '../core/export';
// M2（src/core/serialize.ts）との結合点。
// sidecarToAnnotations(json, opts?) => { annotations, status, width, height, warnings }
// width/height が 0（サイドカーに正しい寸法が無い）の画像は planner が
// excluded_extra.invalid_dimensions へ記録してスキップする（正規化できないため）。
import { sidecarToAnnotations } from '../core/serialize';
import type { ExportImageInput, ExportParams, ExportResult, Project } from '../core/types';

/** JPEG のみ EXIF orientation を見る必要がある（png/webp/bmp は常に無変換コピー） */
const JPEG_EXT = /\.jpe?g$/i;

/** 再エンコード時の JPEG 品質（docs/DESIGN.md §5: q95） */
const REENCODE_QUALITY = 0.95;

export async function runExport(
  adapter: StorageAdapter,
  projectDir: string,
  destDir: string,
  project: Project,
  params: ExportParams,
  onProgress: ExportProgressHandler,
): Promise<ExportResult> {
  const now = new Date().toISOString();

  // --- 1. サイドカー読込 → ExportImageInput ---------------------------------
  onProgress({ phase: 'scan', current: 0, total: 0 });
  const { sidecars, corrupt } = await adapter.loadAllSidecars(projectDir);
  const inputs: ExportImageInput[] = [];
  // 壊れて読めなかった／修復して読み込んだサイドカーは manifest に残す。
  // ここで捨てると「壊れた 1 枚が黙ってデータセットから消える」ことに誰も気付けない
  const sidecarWarnings: { file: string; warnings: string[] }[] = [];
  for (const entry of sidecars) {
    const parsed = sidecarToAnnotations(entry.data);
    if (parsed.warnings.length > 0) {
      sidecarWarnings.push({ file: entry.file, warnings: parsed.warnings });
    }
    inputs.push({
      file: entry.file,
      width: parsed.width,
      height: parsed.height,
      status: parsed.status,
      annotations: parsed.annotations,
    });
  }
  // 出力順を決定的にする（split はファイル名ハッシュなので順序に依存しないが、
  // COCO の image_id / annotation_id は並び順で決まるため差分を安定させる）
  inputs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  onProgress({ phase: 'scan', current: inputs.length, total: inputs.length });

  // 再プラン（画像欠損時）でも同じ記録を引き継ぐための共通オプション
  const planOptions = { now, corruptSidecars: corrupt, sidecarWarnings };
  let plan: ExportPlan = buildExportPlan(inputs, params, project.classes, planOptions);

  const writer = await adapter.beginExport(projectDir, destDir);
  try {
    // --- 2. 画像（欠損検出のため最初に処理する） -----------------------------
    const missing: string[] = [];
    for (let i = 0; i < plan.images.length; i++) {
      const img = plan.images[i];
      onProgress({ phase: 'images', current: i, total: plan.images.length, file: img.srcFile });
      try {
        await writeImage(adapter, writer, projectDir, img);
      } catch {
        // 1 枚の欠損・破損で全体を落とさない。manifest に残して続行する
        missing.push(img.srcFile);
      }
    }
    onProgress({ phase: 'images', current: plan.images.length, total: plan.images.length });

    if (missing.length > 0) {
      const gone = new Set(missing);
      plan = buildExportPlan(
        inputs.filter((input) => !gone.has(input.file)),
        params,
        project.classes,
        { ...planOptions, missingFiles: missing },
      );
    }

    // --- 3. ラベル / data.yaml / COCO json -----------------------------------
    for (let i = 0; i < plan.textFiles.length; i++) {
      const file = plan.textFiles[i];
      onProgress({
        phase: 'labels',
        current: i,
        total: plan.textFiles.length,
        file: file.srcFile,
      });
      await writer.writeFile(file.relPath, file.content);
    }
    onProgress({ phase: 'labels', current: plan.textFiles.length, total: plan.textFiles.length });

    // --- 4. マスク PNG（1 枚ずつ描いて書く。全枚数を同時に持たない） ----------
    const masks = plan.maskTargets ?? [];
    for (let i = 0; i < masks.length; i++) {
      const target = masks[i];
      onProgress({ phase: 'masks', current: i, total: masks.length, file: target.srcFile });
      await writer.writeFile(target.destRelPath, renderMaskPng(target));
    }
    if (masks.length > 0) {
      onProgress({ phase: 'masks', current: masks.length, total: masks.length });
    }

    // --- 5. マニフェスト（最後。ここまでの除外記録が全て入っている） ----------
    await writer.writeFile(EXPORT_MANIFEST_FILE, serializeManifest(plan.manifest));
    onProgress({ phase: 'done', current: 1, total: 1 });
    // 正常終了時の end() の失敗は握り潰さない（mock はここで結果を確定する）
    await writer.end();
  } catch (error) {
    // 失敗時はセッションを閉じるが、元の例外を優先して投げる
    await writer.end().catch(() => undefined);
    throw error;
  }

  return { destDir, manifest: plan.manifest };
}

/**
 * 画像 1 枚を出力する。
 * EXIF orientation が 1（または EXIF 無し・非 JPEG）なら **バイト無変換コピー**、
 * ≠1 なら表示と同じ向きへ正規化して再エンコードする。
 * アノテーション座標は「ブラウザ表示の向き（EXIF 適用後）」で保存されているため、
 * 回転付き JPEG をそのままコピーすると学習側で座標がズレる（docs/DESIGN.md §5）。
 */
async function writeImage(
  adapter: StorageAdapter,
  writer: ExportWriter,
  projectDir: string,
  img: ExportPlanImage,
): Promise<void> {
  if (!JPEG_EXT.test(img.srcFile)) {
    await writer.copyImage(img.srcFile, img.destRelPath);
    return;
  }

  // orientation を見るためだけに全バイトを読む（EXIF は先頭だが、anno:// の
  // Range 対応に依存したくない）。1 枚ずつ逐次処理なので常駐メモリは 1 枚分。
  const res = await fetch(adapter.imageUrl(projectDir, img.srcFile));
  if (!res.ok) throw new Error(`image fetch failed: ${img.srcFile} (${res.status})`);
  const buffer = await res.arrayBuffer();

  if (readJpegOrientation(new Uint8Array(buffer)) === 1) {
    await writer.copyImage(img.srcFile, img.destRelPath);
    return;
  }
  await writer.writeFile(img.destRelPath, await reencodeUpright(buffer));
}

/** EXIF 回転を適用したピクセルで JPEG を焼き直す（q95） */
async function reencodeUpright(bytes: ArrayBuffer): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
    imageOrientation: 'from-image',
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context を取得できません');
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: REENCODE_QUALITY });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
