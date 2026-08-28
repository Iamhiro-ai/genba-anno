// =============================================================================
// クラス ID のリマップ（プロジェクトの class id → 学習 ID 0..N-1）。
//
// **なぜリマップするのか**: プロジェクトのクラス id はユーザーがクラスを削除すると
// 歯抜けになる（例: 0,2,5）。YOLO の data.yaml は `nc` と `names` の並びが
// そのまま学習 ID になるため、歯抜けの id をそのままラベルに書くと
// 「nc=3 なのに class 5 が出てくる」壊れたデータセットになる（学習が落ちるか、
// 落ちずに別クラスとして学習される事故）。
// そこで **id 昇順に 0..N-1 へ連番リマップ**し、対応表を manifest に残す。
//
// 並び順は「プロジェクトのクラス定義（id 昇順）」であり、データに現れたクラスだけを
// 詰めることはしない（データ内容で学習 ID が動くと、追記エクスポートのたびに
// クラスの意味が入れ替わるため）。
// =============================================================================

import type { ClassDef } from '../types';
import type { ExportClassMapping } from './plan';

export interface ClassIdMap {
  /** source id 昇順（= export id 0..N-1 の順） */
  ordered: ExportClassMapping[];
  /** source id → export id */
  toExportId: Map<number, number>;
}

export function buildClassIdMap(classes: ClassDef[]): ClassIdMap {
  const seen = new Set<number>();
  const sorted = [...classes]
    .filter((c) => Number.isFinite(c.id))
    .sort((a, b) => a.id - b.id)
    .filter((c) => {
      // 同一 id の重複定義は先勝ち（後勝ちにすると学習 ID がずれる）
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

  const ordered: ExportClassMapping[] = sorted.map((c, i) => ({
    sourceId: c.id,
    exportId: i,
    name: c.name,
  }));
  return {
    ordered,
    toExportId: new Map(ordered.map((m) => [m.sourceId, m.exportId])),
  };
}
