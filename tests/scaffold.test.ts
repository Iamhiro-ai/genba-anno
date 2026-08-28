// =============================================================================
// M0 スキャフォールドのスモークテスト。
// 契約ファイル（src/core/types.ts / src/shared/ipc.ts）の定数が想定どおりに
// import できることだけを確認する（vitest が 0 件で落ちないための最低 1 本も兼ねる）。
//
// core の本格的なテストは M1 以降が tests/ または src/core/*.test.ts に追加する。
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  ANNO_DIR_NAME,
  BBOX_MIN_SIZE,
  DEFAULT_CLASS_COLORS,
  HISTORY_LIMIT,
  IMAGE_EXTENSIONS,
  LINE_WIDTH_MAX,
  LINE_WIDTH_MIN,
  PROJECT_SCHEMA_VERSION,
  SIDECAR_SCHEMA_VERSION,
} from '../src/core/types';
import { ANNO_PROTOCOL, IPC } from '../src/shared/ipc';

describe('core/types.ts の契約定数', () => {
  it('IMAGE_EXTENSIONS は小文字ドット付きの 5 拡張子', () => {
    expect(IMAGE_EXTENSIONS).toEqual(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
  });

  it('IMAGE_EXTENSIONS はすべて小文字・先頭ドット・重複なし', () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith('.')).toBe(true);
    }
    expect(new Set(IMAGE_EXTENSIONS).size).toBe(IMAGE_EXTENSIONS.length);
  });

  it('スキーマバージョンとフォルダ名', () => {
    expect(SIDECAR_SCHEMA_VERSION).toBe(1);
    expect(PROJECT_SCHEMA_VERSION).toBe(1);
    expect(ANNO_DIR_NAME).toBe('_anno');
  });

  it('線幅・bbox・履歴の境界値', () => {
    expect(LINE_WIDTH_MIN).toBeLessThan(LINE_WIDTH_MAX);
    expect(LINE_WIDTH_MIN).toBe(4);
    expect(LINE_WIDTH_MAX).toBe(200);
    expect(BBOX_MIN_SIZE).toBeGreaterThan(0);
    expect(HISTORY_LIMIT).toBe(100);
  });

  it('DEFAULT_CLASS_COLORS は 10 色の #RRGGBB で重複なし', () => {
    expect(DEFAULT_CLASS_COLORS).toHaveLength(10);
    for (const color of DEFAULT_CLASS_COLORS) {
      expect(color).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(new Set(DEFAULT_CLASS_COLORS).size).toBe(DEFAULT_CLASS_COLORS.length);
  });
});

describe('shared/ipc.ts の契約定数', () => {
  it('IPC チャネル名は一意', () => {
    const channels = Object.values(IPC);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('IPC チャネル名は "<domain>:<action>" 形式', () => {
    for (const channel of Object.values(IPC)) {
      expect(channel).toMatch(/^[a-z]+:[a-zA-Z]+$/);
    }
  });

  it('画像配信のカスタムプロトコル名', () => {
    expect(ANNO_PROTOCOL).toBe('anno');
  });
});
