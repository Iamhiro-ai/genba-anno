// =============================================================================
// サイドカー JSON の一覧用サマリ抽出（純ロジック）
//
// 一覧（ImageEntry）に必要なのは status と annotationCount だけなので、
// ここでは中身の完全検証はしない（座標の検証・クランプは M2 の serialize.ts が
// レンダラ側で行う）。壊れた値でも一覧が全損しないことを最優先にする。
// =============================================================================

import type { AnnotationStatus } from '../../src/core/types';

const STATUSES: readonly AnnotationStatus[] = ['pending', 'in_progress', 'done', 'skipped'];

export interface SidecarSummary {
  status: AnnotationStatus;
  annotationCount: number;
}

/** サイドカー未作成 / 壊れている場合の既定 */
export const EMPTY_SIDECAR_SUMMARY: SidecarSummary = {
  status: 'pending',
  annotationCount: 0,
};

export function summarizeSidecar(raw: unknown): SidecarSummary {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return EMPTY_SIDECAR_SUMMARY;
  }
  const record = raw as Record<string, unknown>;
  const status = STATUSES.includes(record.status as AnnotationStatus)
    ? (record.status as AnnotationStatus)
    : 'pending';
  const annotationCount = Array.isArray(record.annotations) ? record.annotations.length : 0;
  return { status, annotationCount };
}
