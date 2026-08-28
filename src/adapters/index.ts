// =============================================================================
// StorageAdapter の選択（M3）
//
// Electron 実行時は preload が window.genbaAnno を生やしているので electronAdapter、
// ブラウザ単体実行（npm run dev:web）では mockAdapter を使う。
// レンダラ側は必ずこの getAdapter() 経由でストレージへアクセスすること。
// =============================================================================

import { createElectronAdapter, isElectronRuntime } from './electronAdapter';
import { createMockAdapter } from './mockAdapter';
import type { StorageAdapter } from './types';

let cached: StorageAdapter | null = null;

/** プロセス内で 1 つだけ生成されるアダプタ（mock の生成画像を使い回すため必須） */
export function getAdapter(): StorageAdapter {
  if (!cached) {
    cached = isElectronRuntime() ? createElectronAdapter() : createMockAdapter();
  }
  return cached;
}

/** テスト用: キャッシュを捨てて次回 getAdapter() で作り直す */
export function resetAdapter(): void {
  cached = null;
}

export { createElectronAdapter, isElectronRuntime } from './electronAdapter';
export { createMockAdapter, MOCK_EXPORT_DIR, MOCK_PROJECT_DIR } from './mockAdapter';
export type {
  ExportProgressHandler,
  ExportWriter,
  OpenProjectResult,
  StorageAdapter,
} from './types';
