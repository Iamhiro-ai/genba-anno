// =============================================================================
// M6: mask_png（純 TS スキャンライン塗り + fast-png エンコード）の検証。
// 既知形状を塗って fast-png の decode でピクセルを直接確認する。
// =============================================================================

import { decode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import type { Pt } from '../src/core/types';
import {
  MASK_FOREGROUND,
  encodeMaskPng,
  rasterizePolygons,
  renderMaskPng,
} from '../src/core/export/maskPng';

const square = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

function countForeground(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) if (v === MASK_FOREGROUND) n++;
  return n;
}

function at(mask: Uint8Array, w: number, x: number, y: number): number {
  return mask[y * w + x];
}

describe('rasterizePolygons', () => {
  it('正方形はピクセル中心サンプリングの半開区間で塗られる', () => {
    const mask = rasterizePolygons([square(2, 2, 6, 6)], 10, 10);
    // (2,2)-(6,6) → x,y ∈ [2,5] の 4×4
    expect(countForeground(mask)).toBe(16);
    expect(at(mask, 10, 2, 2)).toBe(255);
    expect(at(mask, 10, 5, 5)).toBe(255);
    expect(at(mask, 10, 1, 2)).toBe(0);
    expect(at(mask, 10, 6, 6)).toBe(0);
    expect(at(mask, 10, 2, 1)).toBe(0);
  });

  it('直角三角形が段階状に塗られる', () => {
    const tri: Pt[] = [
      [0, 0],
      [8, 0],
      [0, 8],
    ];
    const mask = rasterizePolygons([tri], 8, 8);
    // 行 y の塗り幅は 7-y（y=0..6）、y=7 は 0 → 合計 28
    for (let y = 0; y <= 6; y++) {
      let n = 0;
      for (let x = 0; x < 8; x++) if (at(mask, 8, x, y) === 255) n++;
      expect(n).toBe(7 - y);
    }
    expect(countForeground(mask)).toBe(28);
    expect(at(mask, 8, 0, 0)).toBe(255);
    expect(at(mask, 8, 7, 0)).toBe(0); // 斜辺の外側
    expect(at(mask, 8, 7, 7)).toBe(0);
  });

  it('複数ポリゴンは union（重なりが打ち消されない）', () => {
    const a = square(0, 0, 6, 6); // x,y ∈ [0,5] = 36px
    const b = square(3, 3, 9, 9); // x,y ∈ [3,8] = 36px
    const mask = rasterizePolygons([a, b], 10, 10);
    // 重なり x,y ∈ [3,5] = 9px → union = 36 + 36 - 9 = 63
    expect(countForeground(mask)).toBe(63);
    // even-odd を連結して1回で塗ると重なりが穴になる。ここは必ず前景
    expect(at(mask, 10, 4, 4)).toBe(255);
    expect(at(mask, 10, 0, 0)).toBe(255);
    expect(at(mask, 10, 8, 8)).toBe(255);
    expect(at(mask, 10, 9, 9)).toBe(0);
  });

  it('画像外へはみ出したポリゴンはクリップされる', () => {
    const mask = rasterizePolygons([square(-5, -5, 3, 3)], 6, 6);
    expect(countForeground(mask)).toBe(9); // x,y ∈ [0,2]
    expect(at(mask, 6, 0, 0)).toBe(255);
    expect(at(mask, 6, 3, 3)).toBe(0);
  });

  it('完全に画像外・退化・非有限は何も塗らない（例外も出さない）', () => {
    expect(countForeground(rasterizePolygons([square(20, 20, 30, 30)], 10, 10))).toBe(0);
    expect(countForeground(rasterizePolygons([[[1, 1] as Pt, [5, 5] as Pt]], 10, 10))).toBe(0);
    expect(countForeground(rasterizePolygons([], 10, 10))).toBe(0);
    expect(
      countForeground(rasterizePolygons([[[0, 0], [Number.NaN, 5], [5, 5]] as Pt[]], 10, 10)),
    ).toBe(0);
  });

  it('巨大な寸法は確保せず throw する（壊れたサイドカーへの多層防御）', () => {
    // 黙って空マスクを返すと「真っ黒 = 物体なし」の誤った教師になるため、必ず throw
    expect(() => rasterizePolygons([], 1_000_000, 1_000_000)).toThrow(/上限/);
    expect(() => rasterizePolygons([], Number.POSITIVE_INFINITY, 10)).toThrow(/上限/);
    expect(() => rasterizePolygons([], Number.NaN, 10)).toThrow(/上限/);
    // 上限ちょうどは確保できる（2^27 = 128MiB のバッファ）
    expect(() => rasterizePolygons([], 1 << 14, 1 << 13)).not.toThrow();
  });

  it('マスクは 0 か 255 の二値のみ', () => {
    const mask = rasterizePolygons([square(1, 1, 8, 8), square(4, 4, 9, 9)], 10, 10);
    for (const v of mask) expect(v === 0 || v === 255).toBe(true);
  });
});

describe('encodeMaskPng / renderMaskPng', () => {
  it('8bit グレースケール 1 チャネル PNG になり、デコードで同じピクセルが戻る', () => {
    const w = 12;
    const h = 9;
    const mask = rasterizePolygons([square(2, 2, 6, 6)], w, h);
    const png = encodeMaskPng(mask, w, h);
    // PNG シグネチャ
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const decoded = decode(png);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(decoded.channels).toBe(1);
    expect(decoded.depth).toBe(8);
    expect(Array.from(decoded.data)).toEqual(Array.from(mask));
    expect(countForeground(new Uint8Array(decoded.data))).toBe(16);
  });

  it('renderMaskPng は maskTargets 1 件分をそのまま描く', () => {
    const png = renderMaskPng({
      srcFile: 'IMG_0001.jpg',
      destRelPath: 'masks/train/IMG_0001.png',
      width: 8,
      height: 8,
      polygons: [square(0, 0, 4, 4)],
    });
    const decoded = decode(png);
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(8);
    expect(countForeground(new Uint8Array(decoded.data))).toBe(16);
  });

  it('polygons が空なら全 0（done の負例マスク）', () => {
    const png = renderMaskPng({
      srcFile: 'IMG_0002.jpg',
      destRelPath: 'masks/train/IMG_0002.png',
      width: 5,
      height: 4,
      polygons: [],
    });
    const decoded = decode(png);
    expect(decoded.width).toBe(5);
    expect(decoded.height).toBe(4);
    expect(countForeground(new Uint8Array(decoded.data))).toBe(0);
    expect(decoded.data).toHaveLength(20);
  });
});
