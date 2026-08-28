// =============================================================================
// train/val 分割（画像単位の独立ハッシュ閾値方式）と、その土台の SHA-1。
//
// 出自: reference/backend/app/services/annotation_export.py の assign_split()。
//   参照実装は画像の sha256 をキーにしていたが、GenbaAnno はサイドカー方式で
//   画像ハッシュを持たないためファイル名をキーにする（同一フォルダ内で一意）。
//
// **ソート方式で分割してはいけない**: 画像を1枚追加しただけで既存画像の所属が
// ずれ、train/val リーク（過去に val だった画像が train に混入）が起きる。
// 独立ハッシュ閾値方式なら、ある画像の所属は他の画像の有無に一切依存しない。
//
// Node crypto は使わない（レンダラ/ブラウザでも同一結果が要る）。純 TS 実装。
// =============================================================================

import type { SplitName } from './plan';

const UTF8 = new TextEncoder();

/**
 * SHA-1（FIPS 180-1）。同期・純 TS。string は UTF-8 として符号化する。
 * 返り値は小文字 40 桁の hex。
 */
export function sha1Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? UTF8.encode(input) : input;
  const len = bytes.length;

  // パディング: 0x80 → 0x00... → 64bit ビッグエンディアンのビット長
  const blocks = Math.floor((len + 8) / 64) + 1;
  const total = blocks * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bitLen = len * 8;
  view.setUint32(total - 8, Math.floor(bitLen / 0x1_0000_0000));
  view.setUint32(total - 4, bitLen % 0x1_0000_0000);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);

  for (let offset = 0; offset < total; offset += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(offset + t * 4);
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      // FIPS 180-1 の入替（右辺は全て入替前の値）: e=d, d=c, c=rotl30(b), b=a, a=temp
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return hex8(h0) + hex8(h1) + hex8(h2) + hex8(h3) + hex8(h4);
}

function hex8(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0');
}

/**
 * 画像1枚の train/val 所属を決める。
 * `sha1(file + String(seed))` の先頭 8 hex（上位 32bit）を [0,1) に写像し、
 * `< valRatio` なら val。
 *
 * 性質（テストで固定）:
 *  - 決定的（同じ file/seed/valRatio なら常に同じ）
 *  - 他の画像の有無に依存しない（画像追加で既存所属が変わらない）
 *  - valRatio <= 0 は全 train
 */
export function assignSplit(file: string, seed: number, valRatio: number): SplitName {
  if (!(valRatio > 0)) return 'train';
  const digest = sha1Hex(file + String(seed));
  const frac = parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000;
  return frac < valRatio ? 'val' : 'train';
}
