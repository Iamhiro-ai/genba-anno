// =============================================================================
// M6: train/val 分割と SHA-1 の検証。
// 分割方式のリグレッションは「val リーク」という気付きにくい事故になるため、
// 「画像を追加しても既存画像の所属が変わらない」ことを最重要テストとして固定する。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { assignSplit, sha1Hex } from '../src/core/export/split';

describe('sha1Hex（純 TS SHA-1）', () => {
  it('FIPS 180-1 の既知テストベクタと一致する', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    // 56 バイト = パディングが 2 ブロック目へ溢れる境界
    expect(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    );
    expect(sha1Hex('The quick brown fox jumps over the lazy dog')).toBe(
      '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
    );
    expect(sha1Hex('The quick brown fox jumps over the lazy cog')).toBe(
      'de9f2c7fd25e1b3afad3e85a0bd17d9b100db4b3',
    );
  });

  it('64 バイト境界（55/56/64 バイト）でも既知値と一致する', () => {
    expect(sha1Hex('a'.repeat(55))).toBe('c1c8bbdc22796e28c0e15163d20899b65621d65a');
    expect(sha1Hex('a'.repeat(56))).toBe('c2db330f6083854c99d4b5bfb6e8f29f201be699');
    expect(sha1Hex('a'.repeat(64))).toBe('0098ba824b5c16427bd7a1122a5a442a25ec644d');
  });

  it('100 万文字（複数ブロック）の既知テストベクタと一致する', () => {
    expect(sha1Hex('a'.repeat(1_000_000))).toBe('34aa973cd4c4daa4f61eeb2bdbad27316534016f');
  });

  it('Uint8Array 入力は同じ内容の string 入力と一致する（UTF-8）', () => {
    const bytes = new TextEncoder().encode('日本語 IMG_0001.jpg');
    expect(sha1Hex(bytes)).toBe(sha1Hex('日本語 IMG_0001.jpg'));
    expect(sha1Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha1Hex('abc'));
  });

  it('非 ASCII を含むファイル名でも 40 桁 hex を返す', () => {
    const d = sha1Hex('現場写真_０１.jpg42');
    expect(d).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('assignSplit', () => {
  const files = Array.from({ length: 400 }, (_, i) => `IMG_${String(i).padStart(4, '0')}.jpg`);

  it('決定的（同じ入力なら常に同じ所属）', () => {
    for (const f of files.slice(0, 20)) {
      const first = assignSplit(f, 42, 0.2);
      for (let i = 0; i < 5; i++) expect(assignSplit(f, 42, 0.2)).toBe(first);
    }
  });

  it('valRatio=0 は全て train', () => {
    for (const f of files) expect(assignSplit(f, 42, 0)).toBe('train');
    // 負値・NaN も安全側（train）へ倒す
    expect(assignSplit('a.jpg', 42, -1)).toBe('train');
    expect(assignSplit('a.jpg', 42, Number.NaN)).toBe('train');
  });

  it('valRatio=0.9 では大半が val になる（境界の上限）', () => {
    const val = files.filter((f) => assignSplit(f, 42, 0.9) === 'val').length;
    expect(val / files.length).toBeGreaterThan(0.8);
    expect(val / files.length).toBeLessThanOrEqual(1);
  });

  it('valRatio=0.2 で val 比率がおおよそ 20%（±8pt）', () => {
    const val = files.filter((f) => assignSplit(f, 42, 0.2) === 'val').length;
    expect(val / files.length).toBeGreaterThan(0.12);
    expect(val / files.length).toBeLessThan(0.28);
  });

  it('**画像を追加しても既存画像の所属が変わらない**（val リーク防止の核）', () => {
    const before = new Map(files.map((f) => [f, assignSplit(f, 42, 0.2)]));
    // 200 枚追加した後に既存 400 枚を再評価する
    const added = Array.from({ length: 200 }, (_, i) => `NEW_${i}.jpg`);
    for (const f of added) assignSplit(f, 42, 0.2);
    for (const f of files) expect(assignSplit(f, 42, 0.2)).toBe(before.get(f));
  });

  it('valRatio を上げても train→val の一方向にしか動かない（閾値方式の単調性）', () => {
    for (const f of files) {
      if (assignSplit(f, 42, 0.2) === 'val') expect(assignSplit(f, 42, 0.5)).toBe('val');
    }
  });

  it('seed を変えると分割が変わる', () => {
    const a = files.map((f) => assignSplit(f, 42, 0.2)).join('');
    const b = files.map((f) => assignSplit(f, 7, 0.2)).join('');
    expect(a).not.toBe(b);
  });

  it('参照実装と同じ「先頭 8 hex を [0,1) に写像」で判定している', () => {
    const file = 'IMG_0001.jpg';
    const seed = 42;
    const frac = parseInt(sha1Hex(file + String(seed)).slice(0, 8), 16) / 0x1_0000_0000;
    expect(assignSplit(file, seed, frac + 1e-9)).toBe('val');
    expect(assignSplit(file, seed, frac)).toBe('train'); // 閾値は「未満」
  });
});
