// =============================================================================
// M6: JPEG EXIF orientation パーサの検証。
// 実 JPEG を置かずに済むよう、最小の APP1(Exif) セグメントを手組みして検証する。
// **壊れた入力で例外を投げないこと**が最重要（エクスポートは全画像を回すバッチ処理）。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { readJpegOrientation } from '../src/core/export/exif';

/** IFD0 に Orientation だけを持つ最小 JPEG を組み立てる */
function makeJpeg(options: {
  orientation: number;
  little: boolean;
  type?: number; // 3=SHORT（既定）/ 4=LONG
  withJfif?: boolean; // APP1 の前に APP0 を挟む（セグメント読み飛ばしの検証）
  tag?: number; // 既定 0x0112
}): Uint8Array {
  const { orientation, little, type = 3, withJfif = false, tag = 0x0112 } = options;
  const tiff: number[] = [];
  const u16 = (v: number) => (little ? tiff.push(v & 0xff, (v >> 8) & 0xff) : tiff.push((v >> 8) & 0xff, v & 0xff));
  const u32 = (v: number) =>
    little
      ? tiff.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
      : tiff.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);

  // TIFF ヘッダ
  tiff.push(little ? 0x49 : 0x4d, little ? 0x49 : 0x4d);
  u16(42);
  u32(8);
  // IFD0
  u16(1); // エントリ数
  u16(tag);
  u16(type);
  u32(1);
  if (type === 3) {
    u16(orientation);
    u16(0); // value フィールドの残り 2 バイト
  } else {
    u32(orientation);
  }
  u32(0); // 次 IFD 無し

  const app1Payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0" + TIFF
  const app1Len = app1Payload.length + 2;

  const bytes: number[] = [0xff, 0xd8];
  if (withJfif) {
    const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    bytes.push(0xff, 0xe0, ((jfif.length + 2) >> 8) & 0xff, (jfif.length + 2) & 0xff, ...jfif);
  }
  bytes.push(0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff, ...app1Payload);
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

describe('readJpegOrientation', () => {
  it('リトルエンディアン（II）の orientation を読む', () => {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(readJpegOrientation(makeJpeg({ orientation: o, little: true }))).toBe(o);
    }
  });

  it('ビッグエンディアン（MM）の orientation を読む', () => {
    for (const o of [1, 3, 6, 8]) {
      expect(readJpegOrientation(makeJpeg({ orientation: o, little: false }))).toBe(o);
    }
  });

  it('APP0(JFIF) が先にあっても APP1 まで読み飛ばす', () => {
    expect(readJpegOrientation(makeJpeg({ orientation: 6, little: true, withJfif: true }))).toBe(6);
    expect(readJpegOrientation(makeJpeg({ orientation: 8, little: false, withJfif: true }))).toBe(8);
  });

  it('LONG 型の orientation も読める', () => {
    expect(readJpegOrientation(makeJpeg({ orientation: 6, little: true, type: 4 }))).toBe(6);
  });

  it('範囲外（0 や 9）の値は 1 に丸める', () => {
    expect(readJpegOrientation(makeJpeg({ orientation: 9, little: true }))).toBe(1);
    expect(readJpegOrientation(makeJpeg({ orientation: 0, little: false }))).toBe(1);
  });

  it('Orientation タグが無ければ 1', () => {
    expect(readJpegOrientation(makeJpeg({ orientation: 6, little: true, tag: 0x011a }))).toBe(1);
  });

  it('EXIF の無い JPEG（SOI + APP0 + EOI）は 1', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    expect(readJpegOrientation(bytes)).toBe(1);
  });

  it('非 JPEG（PNG シグネチャ）は 1', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(readJpegOrientation(png)).toBe(1);
  });

  it('空・極端に短い入力でも例外を投げず 1', () => {
    expect(readJpegOrientation(new Uint8Array(0))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([0xff]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([0xff, 0xd8]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(1);
  });

  it('途中で切れた EXIF でも例外を投げず 1', () => {
    const full = makeJpeg({ orientation: 6, little: true });
    for (let cut = 2; cut < full.length; cut++) {
      expect(() => readJpegOrientation(full.slice(0, cut))).not.toThrow();
      const o = readJpegOrientation(full.slice(0, cut));
      expect(o === 1 || o === 6).toBe(true);
    }
  });

  it('セグメント長やタグを壊しても例外を投げない', () => {
    const base = makeJpeg({ orientation: 6, little: true, withJfif: true });
    for (let i = 0; i < base.length; i++) {
      const broken = base.slice();
      broken[i] = 0xff;
      expect(() => readJpegOrientation(broken)).not.toThrow();
      const broken2 = base.slice();
      broken2[i] = 0x00;
      expect(() => readJpegOrientation(broken2)).not.toThrow();
    }
  });

  it('ランダムなバイト列でも例外を投げない', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 256;
    };
    for (let n = 0; n < 200; n++) {
      const bytes = new Uint8Array(64);
      bytes[0] = 0xff;
      bytes[1] = 0xd8;
      for (let i = 2; i < bytes.length; i++) bytes[i] = rand();
      expect(() => readJpegOrientation(bytes)).not.toThrow();
      const o = readJpegOrientation(bytes);
      expect(o).toBeGreaterThanOrEqual(1);
      expect(o).toBeLessThanOrEqual(8);
    }
  });
});
