// =============================================================================
// core/livewire.ts の純関数テスト（M1 / MT）。
//
// scripts/verify_livewire.mjs の検証項目を vitest へ移植し、
// toGray の係数・findPath の端点/連結性・ROI 座標整合・スナップ閾値などを追加した。
//
// 方針: livewire.ts は実画像で較正済みの移植コード。較正定数の「値」は
// ハードコードでアサートせず（定数変更に脆いテストにしない）、
//   - export された定数を参照した相対計算
//   - 挙動（単調性・レンジ・向き）
// で検証する。合成画像は verify スクリプトと同じ makeImage/drawDarkSeg 方式。
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  FAR_CAP_RATIO_DEFAULT,
  MAX_WIDTH_FRAC_DEFAULT,
  SIMPLIFY_EPS_DEFAULT,
  SNAP_MIN_DROP_DEFAULT,
  WIDTH_HALF_FRAC_DEFAULT,
  WIDTH_SHRINK_DEFAULT,
  WIDTH_SMOOTH_Q_DEFAULT,
  WIDTH_SMOOTH_WIN_DEFAULT,
  buildCostMap,
  capWidthsByImagePosition,
  douglasPeucker,
  estimateCrackWidth,
  estimateWidthProfile,
  findPath,
  gaussian3,
  gaussian5,
  meanGrayAlongLine,
  snapToRidge,
  toGray,
  traceLivewire,
} from '../src/core/livewire';
import type { GrayImage, Point } from '../src/core/livewire';

// ---------------------------------------------------------------------------
// 合成画像ユーティリティ（verify_livewire.mjs と同じ生成方法）
// ---------------------------------------------------------------------------

/** 一様な明るい路面画像（既定 217 ≒ アスファルト明部） */
function makeImage(w: number, h: number, fillGray = 217): GrayImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fillGray;
    data[i * 4 + 1] = fillGray;
    data[i * 4 + 2] = fillGray;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

/** 暗い線分を描く（rad=1 で 3px 幅） */
function drawDarkSeg(
  img: GrayImage,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  val = 28,
  rad = 1
): void {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay)) * 2 + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(ax + (bx - ax) * t);
    const y = Math.round(ay + (by - ay) * t);
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
        const i = (yy * img.width + xx) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = val;
      }
    }
  }
}

/** 山型（上に凸）の暗い折れ線を持つ画像 */
function mountainImage(w = 80, h = 80): GrayImage {
  const img = makeImage(w, h);
  drawDarkSeg(img, 5, 40, 40, 10);
  drawDarkSeg(img, 40, 10, 75, 40);
  return img;
}

/** ROI 切り出し + 縮小（Canvas の drawImage 相当のブロック平均）。呼び出し側の前処理を模す。 */
function extractRoi(
  src: GrayImage,
  x0: number,
  y0: number,
  w: number,
  h: number,
  scale: number
): GrayImage {
  const rw = Math.round(w * scale);
  const rh = Math.round(h * scale);
  const inv = Math.round(1 / scale);
  const data = new Uint8ClampedArray(rw * rh * 4);
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      let acc = 0;
      let cnt = 0;
      for (let dy = 0; dy < inv; dy++) {
        for (let dx = 0; dx < inv; dx++) {
          const sx = x0 + rx * inv + dx;
          const sy = y0 + ry * inv + dy;
          if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
          acc += src.data[(sy * src.width + sx) * 4];
          cnt++;
        }
      }
      const v = cnt > 0 ? acc / cnt : 255;
      const i = (ry * rw + rx) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: rw, height: rh };
}

/** 点と折れ線の最短距離（ROI 座標整合の検証用） */
function distToPolyline(p: Point, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(Math.max(((p[0] - ax) * dx + (p[1] - ay) * dy) / len2, 0), 1) : 0;
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---------------------------------------------------------------------------
// 1) toGray
// ---------------------------------------------------------------------------

describe('toGray', () => {
  it('Rec.601 係数（0.299 / 0.587 / 0.114）で [0..1] に正規化する', () => {
    const img: GrayImage = {
      // R / G / B / 白 / 黒
      data: new Uint8ClampedArray([
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
      ]),
      width: 5,
      height: 1,
    };
    const g = toGray(img);
    expect(g[0]).toBeCloseTo(0.299, 6);
    expect(g[1]).toBeCloseTo(0.587, 6);
    expect(g[2]).toBeCloseTo(0.114, 6);
    expect(g[3]).toBeCloseTo(1, 6);
    expect(g[4]).toBeCloseTo(0, 6);
    // 係数の合計は 1（白が 1 になる）
    expect(g[0] + g[1] + g[2]).toBeCloseTo(1, 6);
  });

  it('GrayImage 互換入力（plain number[] の data）も同じ結果', () => {
    const rgba = [10, 20, 30, 255, 200, 210, 220, 255];
    const fromPlain = toGray({ data: rgba, width: 2, height: 1 });
    const fromTyped = toGray({ data: new Uint8ClampedArray(rgba), width: 2, height: 1 });
    expect(Array.from(fromPlain)).toEqual(Array.from(fromTyped));
    expect(fromPlain).toBeInstanceOf(Float32Array);
  });

  it('長さは width×height、アルファは輝度に影響しない', () => {
    const opaque = toGray({ data: [128, 128, 128, 255], width: 1, height: 1 });
    const transparent = toGray({ data: [128, 128, 128, 0], width: 1, height: 1 });
    expect(opaque[0]).toBeCloseTo(transparent[0], 9);
    expect(toGray(makeImage(7, 5))).toHaveLength(35);
  });
});

// ---------------------------------------------------------------------------
// 2) ガウス平滑
// ---------------------------------------------------------------------------

describe('gaussian3 / gaussian5', () => {
  it('カーネル総和 1: 一様画像は値が変わらず、端も clamp で保たれる', () => {
    const flat = toGray(makeImage(9, 7, 128));
    for (const blurred of [gaussian3(flat, 9, 7), gaussian5(flat, 9, 7)]) {
      expect(blurred).toHaveLength(63);
      for (const v of blurred) expect(v).toBeCloseTo(128 / 255, 5);
    }
  });

  it('インパルスを平滑し、5-tap の方が 3-tap より広く鈍る', () => {
    const w = 21;
    const h = 21;
    const src = new Float32Array(w * h); // 0 で埋め、中心だけ 1
    const c = 10 * w + 10;
    src[c] = 1;
    const g3 = gaussian3(src, w, h);
    const g5 = gaussian5(src, w, h);
    expect(g3[c]).toBeLessThan(1);
    expect(g5[c]).toBeLessThan(g3[c]); // より広いカーネル = ピークが低い
    // エネルギー（総和）は保存される
    const sum = (a: Float32Array) => a.reduce((x, y) => x + y, 0);
    expect(sum(g3)).toBeCloseTo(1, 4);
    expect(sum(g5)).toBeCloseTo(1, 4);
    // 2 画素離れた位置は 3-tap では届かないが 5-tap では滲む
    expect(g3[10 * w + 12]).toBeCloseTo(0, 6);
    expect(g5[10 * w + 12]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3) buildCostMap
// ---------------------------------------------------------------------------

describe('buildCostMap', () => {
  it('暗い線上のコストは背景より低い', () => {
    const w = 80;
    const h = 80;
    const img = mountainImage(w, h);
    const gray = toGray(img);
    const cost = buildCostMap(gray, w, h);
    const onLine = 10 * w + 40; // 山の頂点（暗線上）
    const onBg = 40 * w + 40; // 暗線から外れた背景
    expect(gray[onLine]).toBeLessThan(gray[onBg]);
    expect(cost[onLine]).toBeLessThan(cost[onBg]);
  });

  it('invert なし: 暗いほど低コスト（ridgeWeight=0 で baseCost + 平滑輝度）', () => {
    const dark = toGray(makeImage(8, 8, 50));
    const light = toGray(makeImage(8, 8, 200));
    const cDark = buildCostMap(dark, 8, 8, { ridgeWeight: 0, baseCost: 0.02 });
    const cLight = buildCostMap(light, 8, 8, { ridgeWeight: 0, baseCost: 0.02 });
    const i = 3 * 8 + 3;
    expect(cDark[i]).toBeLessThan(cLight[i]);
    // 一様画像では平滑後も同値 → cost = baseCost + gray（反転していないこと）
    expect(cDark[i]).toBeCloseTo(0.02 + 50 / 255, 5);
    expect(cLight[i]).toBeCloseTo(0.02 + 200 / 255, 5);
  });

  it('コストは [baseCost, 1] にクランプされる', () => {
    const white = buildCostMap(toGray(makeImage(8, 8, 255)), 8, 8, { baseCost: 0.02 });
    const black = buildCostMap(toGray(makeImage(8, 8, 0)), 8, 8, { baseCost: 0.02 });
    expect(white[27]).toBe(1);
    expect(black[27]).toBeCloseTo(0.02, 6);
    const mixed = buildCostMap(toGray(mountainImage()), 80, 80);
    for (const c of mixed) {
      expect(c).toBeGreaterThanOrEqual(0.02 - 1e-6);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('リッジ強調（DoG）は細い暗線のコストだけを下げ、平坦な背景は変えない', () => {
    const w = 40;
    const h = 40;
    const img = makeImage(w, h);
    drawDarkSeg(img, 20, 2, 20, 38, 28, 0); // 1px 幅の細い暗線
    const gray = toGray(img);
    const noRidge = buildCostMap(gray, w, h, { ridgeWeight: 0 });
    const ridge = buildCostMap(gray, w, h, { ridgeWeight: 0.5 });
    const onLine = 20 * w + 20;
    const onBg = 20 * w + 5;
    expect(ridge[onLine]).toBeLessThan(noRidge[onLine]);
    expect(ridge[onBg]).toBeCloseTo(noRidge[onBg], 6);
  });
});

// ---------------------------------------------------------------------------
// 4) findPath
// ---------------------------------------------------------------------------

describe('findPath', () => {
  const w = 80;
  const h = 80;
  const img = mountainImage(w, h);
  const gray = toGray(img);
  const cost = buildCostMap(gray, w, h);
  const start = 40 * w + 5; // (5,40)
  const end = 40 * w + 75; // (75,40)

  it('明背景 + 暗い折れ線で、経路の平均輝度が背景より十分暗い', () => {
    const r = findPath(cost, gray, w, h, start, end);
    expect(r.path).not.toBeNull();
    const bg = meanGrayAlongLine(gray, w, h, [5, 60], [75, 60]); // 線の無い帯
    expect(r.avgGray).toBeLessThan(bg - 0.3);
    // 経路の中央付近は山の頂点側（y が小さい）へ寄る
    const mid = r.path![Math.floor(r.path!.length / 2)];
    expect((mid / w) | 0).toBeLessThan(25);
  });

  it('端点は固定され、経路は 8 近傍で連結している', () => {
    const r = findPath(cost, gray, w, h, start, end);
    const path = r.path!;
    expect(path[0]).toBe(start);
    expect(path[path.length - 1]).toBe(end);
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs((path[i] % w) - (path[i - 1] % w));
      const dy = Math.abs(((path[i] / w) | 0) - ((path[i - 1] / w) | 0));
      expect(Math.max(dx, dy)).toBe(1);
    }
  });

  it('start === end は 1 点経路（avgGray はその画素）', () => {
    const r = findPath(cost, gray, w, h, start, start);
    expect(r.path).toEqual([start]);
    expect(r.avgGray).toBeCloseTo(gray[start], 6);
  });

  it('範囲外の index は path=null / avgGray=1', () => {
    expect(findPath(cost, gray, w, h, -1, end)).toEqual({ path: null, avgGray: 1 });
    expect(findPath(cost, gray, w, h, start, w * h)).toEqual({ path: null, avgGray: 1 });
  });
});

// ---------------------------------------------------------------------------
// 5) douglasPeucker
// ---------------------------------------------------------------------------

describe('douglasPeucker', () => {
  it('端点は厳密に固定される', () => {
    const pts: Point[] = [
      [0, 0],
      [3, 9],
      [6, 1],
      [9, 8],
      [12, 0],
    ];
    const out = douglasPeucker(pts, 2);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([12, 0]);
  });

  it('eps=0 では折れ点がすべて保持される', () => {
    const zigzag: Point[] = [
      [0, 0],
      [1, 1],
      [2, 0],
      [3, 1],
      [4, 0],
    ];
    expect(douglasPeucker(zigzag, 0)).toEqual(zigzag);
  });

  it('完全な共線点は eps=0 でも 2 点に落ちる（垂距 0 は eps 超過にならない）', () => {
    const collinear: Point[] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ];
    expect(douglasPeucker(collinear, 0)).toEqual([
      [0, 0],
      [4, 4],
    ]);
    expect(douglasPeucker(collinear, 0.5)).toHaveLength(2);
  });

  it('L 字コーナーは 3 点として保持される', () => {
    const corner: Point[] = [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 5],
      [10, 10],
    ];
    expect(douglasPeucker(corner, 0.5)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('eps を大きくすると頂点数は単調に減る', () => {
    const wavy: Point[] = [];
    for (let x = 0; x <= 60; x++) wavy.push([x, Math.round(10 * Math.sin(x / 4))]);
    const counts = [0.2, 1, 3, 8].map((eps) => douglasPeucker(wavy, eps).length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBeLessThan(counts[0]);
  });

  it('2 点以下は入力のコピーを返す（同一参照ではない）', () => {
    const two: Point[] = [
      [0, 0],
      [5, 5],
    ];
    const out = douglasPeucker(two, 1);
    expect(out).toEqual(two);
    expect(out).not.toBe(two);
    expect(douglasPeucker([], 1)).toEqual([]);
    expect(douglasPeucker([[1, 2]], 1)).toEqual([[1, 2]]);
  });
});

// ---------------------------------------------------------------------------
// 6) meanGrayAlongLine
// ---------------------------------------------------------------------------

describe('meanGrayAlongLine', () => {
  it('暗い筋を通る直線は背景を通る直線より暗い', () => {
    const w = 60;
    const h = 60;
    const img = makeImage(w, h);
    drawDarkSeg(img, 5, 30, 55, 30, 28, 1);
    const gray = toGray(img);
    expect(meanGrayAlongLine(gray, w, h, [5, 30], [55, 30])).toBeLessThan(
      meanGrayAlongLine(gray, w, h, [5, 50], [55, 50]) - 0.3
    );
  });

  it('画像外の端点は内側へクランプされる', () => {
    const gray = toGray(makeImage(20, 20, 255));
    expect(meanGrayAlongLine(gray, 20, 20, [-50, -50], [100, 100])).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// 7) traceLivewire
// ---------------------------------------------------------------------------

describe('traceLivewire', () => {
  it('山型の暗線に沿って湾曲追従し、端点はクリック位置に固定される', () => {
    const img = mountainImage();
    const res = traceLivewire(img, [5, 40], [75, 40]);
    expect(res.fellBack).toBe(false);
    expect(res.points.length).toBeGreaterThan(2);
    expect(Math.min(...res.points.map((p) => p[1]))).toBeLessThan(20); // 山側へ膨らむ
    expect(res.points[0]).toEqual([5, 40]);
    expect(res.points[res.points.length - 1]).toEqual([75, 40]);
  });

  it('暗い筋が無ければ直線 2 点 + fellBack=true（トースト通知の条件）', () => {
    const res = traceLivewire(makeImage(60, 60, 210), [5, 30], [55, 30]);
    expect(res.fellBack).toBe(true);
    expect(res.points).toEqual([
      [5, 30],
      [55, 30],
    ]);
  });

  it('ひびが直線状なら直線 2 点でも fellBack=false（誤通知しない）', () => {
    const img = makeImage(60, 60);
    drawDarkSeg(img, 5, 30, 55, 30, 28, 1);
    const res = traceLivewire(img, [5, 30], [55, 30]);
    expect(res.points).toHaveLength(2);
    expect(res.fellBack).toBe(false);
    expect(res.avgGray).toBeLessThan(0.5);
  });

  it('画像外の start/end は ROI 内へクランプされ、整数座標を返す', () => {
    const res = traceLivewire(makeImage(60, 60, 210), [-5, 30], [100, 30.7]);
    expect(res.points[0]).toEqual([0, 30]);
    expect(res.points[res.points.length - 1]).toEqual([59, 30]);
    for (const [x, y] of res.points) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(60);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(60);
    }
  });

  it('simplifyEps を半減すると折れ点が約 2 倍に増える（既定は SIMPLIFY_EPS_DEFAULT）', () => {
    const w = 200;
    const h = 200;
    const img = makeImage(w, h);
    // 実クラック相当: 低周波の蛇行 + 高周波の細かい揺れ
    const yAt = (x: number) => 100 + 25 * Math.sin((x - 10) / 20) + 3 * Math.sin((x - 10) / 3.1);
    let prev: Point | null = null;
    for (let x = 10; x <= 190; x += 1) {
      const y = yAt(x);
      if (prev) drawDarkSeg(img, prev[0], prev[1], x, y, 25, 1);
      prev = [x, y];
    }
    const s: Point = [10, Math.round(yAt(10))];
    const e: Point = [190, Math.round(yAt(190))];
    const coarse = traceLivewire(img, s, e, { simplifyEps: SIMPLIFY_EPS_DEFAULT * 2 });
    const fine = traceLivewire(img, s, e, { simplifyEps: SIMPLIFY_EPS_DEFAULT });
    const dflt = traceLivewire(img, s, e);
    expect(coarse.fellBack).toBe(false);
    expect(fine.fellBack).toBe(false);
    expect(dflt.points).toEqual(fine.points); // 既定 = SIMPLIFY_EPS_DEFAULT
    // verify_livewire.mjs は 1.5〜3.5 倍で判定（実測 1.52）。ここでは頂点数 ±1 の
    // 揺れ（Math.sin の実装差）を吸収するため下限だけ僅かに緩める。
    const ratio = fine.points.length / coarse.points.length;
    expect(fine.points.length).toBeGreaterThan(coarse.points.length);
    expect(ratio).toBeGreaterThanOrEqual(1.45);
    expect(ratio).toBeLessThanOrEqual(3.5);
  });

  it('ROI 縮小前提の座標整合: ROI 座標を画像座標へ戻すと元の暗線に乗る', () => {
    // 呼び出し側（Canvas）は ROI 切り出し + 縮小して渡す。ROI px → 画像 px の
    // 逆変換（offset + 1/scale）で、経路が元のひびの上に戻ることを確認する。
    const full = makeImage(240, 240);
    const crack: Point[] = [
      [20, 180],
      [120, 60],
      [220, 180],
    ];
    for (let i = 0; i < crack.length - 1; i++) {
      drawDarkSeg(full, crack[i][0], crack[i][1], crack[i + 1][0], crack[i + 1][1], 28, 2);
    }
    const x0 = 10;
    const y0 = 40;
    const scale = 0.5;
    const roi = extractRoi(full, x0, y0, 220, 160, scale);
    const toRoi = (p: Point): Point => [
      Math.round((p[0] - x0) * scale),
      Math.round((p[1] - y0) * scale),
    ];
    const toImage = (p: Point): Point => [x0 + p[0] / scale, y0 + p[1] / scale];

    const res = traceLivewire(roi, toRoi(crack[0]), toRoi(crack[2]));
    expect(res.fellBack).toBe(false);
    expect(res.points.length).toBeGreaterThan(2);
    // ROI 内に収まっている
    for (const [x, y] of res.points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(roi.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(roi.height);
    }
    // 画像座標へ戻すと元のひび（半幅 2.5px）から量子化誤差ぶんの範囲に収まる
    const mapped = res.points.map(toImage);
    const maxDev = Math.max(...mapped.map((p) => distToPolyline(p, crack)));
    expect(maxDev).toBeLessThan(8);
    expect(mapped[0]).toEqual(crack[0]);
    expect(mapped[mapped.length - 1]).toEqual(crack[2]);
  });
});

// ---------------------------------------------------------------------------
// 8) snapToRidge
// ---------------------------------------------------------------------------

describe('snapToRidge', () => {
  const w = 100;
  const h = 100;
  const lineImg = makeImage(w, h);
  drawDarkSeg(lineImg, 50, 5, 50, 95, 28, 1); // x=49..51 の暗い縦線
  const lineGray = toGray(lineImg);

  it('カーソル近傍の暗い画素へ吸着する', () => {
    const snapped = snapToRidge(lineGray, w, h, [45, 40], 10);
    expect(snapped[0]).toBeGreaterThanOrEqual(48);
    expect(snapped[0]).toBeLessThanOrEqual(52);
    expect(snapped[0]).not.toBe(45);
    expect(Number.isInteger(snapped[0])).toBe(true);
    expect(Number.isInteger(snapped[1])).toBe(true);
  });

  it('一様な明画像では吸着せず入力点をそのまま返す', () => {
    const blank = toGray(makeImage(w, h));
    expect(snapToRidge(blank, w, h, [30, 30], 10)).toEqual([30, 30]);
  });

  it('探索半径の外にある暗線には吸着しない', () => {
    expect(snapToRidge(lineGray, w, h, [30, 40], 8)).toEqual([30, 40]);
  });

  it('暗さ差が minDrop 未満なら吸着しない（下げれば吸着する）', () => {
    const shallow = makeImage(w, h, 217);
    drawDarkSeg(shallow, 30, 5, 30, 95, 214, 1); // 3/255 ≈ 0.012 の浅い筋
    const gray = toGray(shallow);
    const drop = gray[40 * w + 20] - gray[40 * w + 30];
    expect(drop).toBeGreaterThan(0);
    expect(drop).toBeLessThan(SNAP_MIN_DROP_DEFAULT); // 前提: 既定閾値より浅い
    // 距離ペナルティを切って「最暗点は見つかるが浅い」状況を作る
    expect(snapToRidge(gray, w, h, [28, 40], 10, { distPenalty: 0 })).toEqual([28, 40]);
    const forced = snapToRidge(gray, w, h, [28, 40], 10, { distPenalty: 0, minDrop: drop / 2 });
    expect(forced[0]).toBeGreaterThanOrEqual(29);
    expect(forced[0]).toBeLessThanOrEqual(31);
  });

  it('距離ペナルティを上げると遠い濃い筋より近い筋を選ぶ', () => {
    const two = makeImage(100, 60, 217);
    drawDarkSeg(two, 45, 0, 45, 59, 120, 0); // 近い（5px）ほどほどの暗さ
    drawDarkSeg(two, 58, 0, 58, 59, 20, 0); // 遠い（18px）非常に暗い
    const gray = toGray(two);
    expect(snapToRidge(gray, 100, 60, [40, 30], 20, { distPenalty: 0 })[0]).toBe(58);
    expect(snapToRidge(gray, 100, 60, [40, 30], 20, { distPenalty: 1 })[0]).toBe(45);
  });

  it('画像端でも範囲内の画素を返す', () => {
    const edge = makeImage(60, 60);
    drawDarkSeg(edge, 2, 0, 2, 59, 28, 1);
    const gray = toGray(edge);
    const snapped = snapToRidge(gray, 60, 60, [0, 0], 5);
    expect(snapped[0]).toBeGreaterThanOrEqual(0);
    expect(snapped[0]).toBeLessThan(60);
    expect(snapped[1]).toBeGreaterThanOrEqual(0);
    expect(snapped[1]).toBeLessThan(60);
  });
});

// ---------------------------------------------------------------------------
// 9) 幅推定（estimateCrackWidth / estimateWidthProfile）
// ---------------------------------------------------------------------------

/** 幅 (2*rad+1) px の縦の暗帯を持つ画像と、その上を通る経路 */
function bandImage(rad: number, w = 100, h = 120): { img: GrayImage; path: Point[] } {
  const img = makeImage(w, h);
  drawDarkSeg(img, 50, 10, 50, h - 10, 25, rad);
  const path: Point[] = [];
  for (let y = 20; y <= h - 20; y += 5) path.push([50, y]);
  return { img, path };
}

describe('estimateCrackWidth', () => {
  it('既知幅 5px の暗帯から妥当なレンジ（3..8px）で推定する', () => {
    const { img, path } = bandImage(2);
    const est = estimateCrackWidth(img, path);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThanOrEqual(3);
    expect(est!).toBeLessThanOrEqual(8);
  });

  it('コントラストの無い画像・点数不足の経路は null', () => {
    const { path } = bandImage(2);
    expect(estimateCrackWidth(makeImage(100, 120), path)).toBeNull();
    expect(estimateCrackWidth(bandImage(2).img, [[50, 50]])).toBeNull();
    expect(estimateCrackWidth(bandImage(2).img, [])).toBeNull();
  });

  it('実際の帯幅に対して単調増加する', () => {
    const est = [1, 2, 3, 4].map((rad) => {
      const { img, path } = bandImage(rad);
      return estimateCrackWidth(img, path)!;
    });
    for (let i = 1; i < est.length; i++) expect(est[i]).toBeGreaterThan(est[i - 1]);
  });

  it('shrink は推定幅に線形に効く', () => {
    const { img, path } = bandImage(3); // 幅 7px（ハードエッジ）
    const full = estimateCrackWidth(img, path, 12, { halfFrac: 0.5, shrink: 1 })!;
    const shrunk = estimateCrackWidth(img, path, 12, { halfFrac: 0.5, shrink: 0.8 })!;
    expect(shrunk).toBeCloseTo(full * 0.8, 1);
  });

  it('halfFrac を下げるほど暗い芯寄りに測って細くなる（ハロー除去の保守化）', () => {
    // 細く深い芯 + 広く浅いハロー（実ひびの影・ボケを模した合成）
    const w = 120;
    const h = 160;
    const img = makeImage(w, h, 217);
    const cx = 60;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = x - cx;
        const core = 120 * Math.exp(-(d * d) / (2 * 1.5 * 1.5));
        const halo = 70 * Math.exp(-(d * d) / (2 * 8 * 8));
        const v = Math.max(0, Math.round(217 - core - halo));
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      }
    }
    const path: Point[] = [];
    for (let y = 20; y <= 140; y += 5) path.push([cx, y]);
    const wide = estimateCrackWidth(img, path, 12, { halfFrac: 0.5, shrink: 1 })!;
    const mid = estimateCrackWidth(img, path, 12, { halfFrac: 0.35, shrink: 1 })!;
    const dflt = estimateCrackWidth(img, path)!;
    expect(wide).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(dflt); // 既定は halfFrac 深化 + shrink + 低分位
    expect(dflt).toBeLessThan(wide * 0.8); // ハロー由来の太りを明確に削る
  });
});

describe('estimateWidthProfile', () => {
  it('経路と同数の幅を返し、テーパー帯の局所幅に追従する', () => {
    const w = 120;
    const h = 160;
    const img = makeImage(w, h);
    // 上（y=10）rad=1（幅 3px）→ 下（y=150）rad=5（幅 11px）へ太くなる縦帯
    for (let y = 10; y <= 150; y++) {
      const t = (y - 10) / 140;
      drawDarkSeg(img, 60, y, 60, y, 25, Math.round(1 + 4 * t));
    }
    const path: Point[] = [];
    for (let y = 20; y <= 140; y += 5) path.push([60, y]);
    const prof = estimateWidthProfile(img, path);
    expect(prof).not.toBeNull();
    expect(prof!).toHaveLength(path.length);
    const head = mean(prof!.slice(0, 5));
    const tail = mean(prof!.slice(-5));
    expect(tail).toBeGreaterThan(head * 1.8);
    expect(head).toBeGreaterThanOrEqual(2);
    expect(head).toBeLessThanOrEqual(6);
    expect(tail).toBeGreaterThanOrEqual(8);
    expect(tail).toBeLessThanOrEqual(15);
    for (const v of prof!) expect(v).toBeGreaterThan(0);
  });

  it('低分位平滑は中央値以下で、局所ファットスポットを近傍へ伝播させない', () => {
    const w = 100;
    const h = 200;
    const img = makeImage(w, h);
    for (let y = 10; y <= 190; y++) drawDarkSeg(img, 50, y, 50, y, 25, 1); // 細い芯
    for (let y = 97; y <= 103; y++) drawDarkSeg(img, 50, y, 50, y, 25, 4); // 中央だけ太い塊
    const path: Point[] = [];
    for (let y = 20; y <= 180; y += 2) path.push([50, y]);
    const low = estimateWidthProfile(img, path)!;
    const median = estimateWidthProfile(img, path, 12, { smoothQ: 0.5 })!;
    expect(low.every((v, i) => v <= median[i] + 1e-9)).toBe(true);
    expect(mean(low)).toBeLessThan(mean(median));
    // 塊から離れた区間は芯の幅（<4px）のまま
    const blobIdx = path.findIndex((p) => p[1] >= 100);
    const far = low.filter((_, i) => Math.abs(i - blobIdx) >= 4);
    expect(Math.max(...far)).toBeLessThan(4);
  });

  it('平滑窓を広げると幅プロファイルが保守側（細い方）へ寄る', () => {
    const w = 100;
    const h = 200;
    const img = makeImage(w, h);
    for (let y = 10; y <= 190; y++) drawDarkSeg(img, 50, y, 50, y, 25, 1);
    for (let y = 97; y <= 103; y++) drawDarkSeg(img, 50, y, 50, y, 25, 4);
    const path: Point[] = [];
    for (let y = 20; y <= 180; y += 2) path.push([50, y]);
    const narrow = estimateWidthProfile(img, path, 12, { smoothWin: 0 })!;
    const wide = estimateWidthProfile(img, path, 12, { smoothWin: 4 })!;
    expect(mean(wide)).toBeLessThanOrEqual(mean(narrow));
  });

  it('既定引数は export 済みの較正定数と同じ結果になる', () => {
    const { img, path } = bandImage(2);
    const dflt = estimateWidthProfile(img, path)!;
    const explicit = estimateWidthProfile(img, path, 12, {
      halfFrac: WIDTH_HALF_FRAC_DEFAULT,
      shrink: WIDTH_SHRINK_DEFAULT,
      smoothQ: WIDTH_SMOOTH_Q_DEFAULT,
      smoothWin: WIDTH_SMOOTH_WIN_DEFAULT,
    })!;
    expect(dflt).toEqual(explicit);
  });

  it('コントラスト不足・2 点未満の経路は null', () => {
    const { path } = bandImage(2);
    expect(estimateWidthProfile(makeImage(100, 120), path)).toBeNull();
    expect(estimateWidthProfile(bandImage(2).img, [[50, 50]])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10) capWidthsByImagePosition
// ---------------------------------------------------------------------------

describe('capWidthsByImagePosition', () => {
  const H = 640;
  const fullCap = H * MAX_WIDTH_FRAC_DEFAULT;

  it('最下部（近傍）は画像高さ比のフルキャップ、最上部（遠方）はその farCapRatio 倍', () => {
    const capped = capWidthsByImagePosition([100, 100, 100], [0, H / 2, H], H);
    expect(capped[2]).toBeCloseTo(fullCap, 9);
    expect(capped[0]).toBeCloseTo(fullCap * FAR_CAP_RATIO_DEFAULT, 9);
    expect(capped[1]).toBeCloseTo(fullCap * (1 + FAR_CAP_RATIO_DEFAULT) * 0.5, 9);
  });

  it('y が下がるほどキャップが緩む（単調増加）', () => {
    const ys = [0, 160, 320, 480, 640];
    const capped = capWidthsByImagePosition(ys.map(() => 100), ys, H);
    for (let i = 1; i < capped.length; i++) expect(capped[i]).toBeGreaterThan(capped[i - 1]);
  });

  it('キャップより細い幅はどの y でもそのまま', () => {
    const thin = fullCap * FAR_CAP_RATIO_DEFAULT * 0.5;
    const capped = capWidthsByImagePosition([thin, thin, thin], [0, H / 2, H], H);
    for (const v of capped) expect(v).toBeCloseTo(thin, 9);
  });

  it('maxWidthFrac / farCapRatio を上書きできる', () => {
    const custom = capWidthsByImagePosition([100, 100], [0, H], H, {
      maxWidthFrac: 0.015,
      farCapRatio: 0.5,
    });
    expect(custom[1]).toBeCloseTo(H * 0.015, 9);
    expect(custom[0]).toBeCloseTo(H * 0.015 * 0.5, 9);
  });

  it('ys 不足は最下部扱い・y は 0..1 にクランプ・imageHeight=0 はキャップ無効', () => {
    const missing = capWidthsByImagePosition([100, 100], [0], H);
    expect(missing[1]).toBeCloseTo(fullCap, 9);
    const oob = capWidthsByImagePosition([100, 100], [-500, 9999], H);
    expect(oob[0]).toBeCloseTo(fullCap * FAR_CAP_RATIO_DEFAULT, 9);
    expect(oob[1]).toBeCloseTo(fullCap, 9);
    expect(capWidthsByImagePosition([100, 100], [0, 5], 0)).toEqual([100, 100]);
    expect(capWidthsByImagePosition([], [], H)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 11) 性能スモーク
// ---------------------------------------------------------------------------

describe('性能スモーク', () => {
  it('512x512 の traceLivewire が 300ms 未満', () => {
    const w = 512;
    const h = 512;
    const img = makeImage(w, h);
    drawDarkSeg(img, 20, 256, 256, 60);
    drawDarkSeg(img, 256, 60, 492, 256);
    const t0 = performance.now();
    const res = traceLivewire(img, [20, 256], [492, 256]);
    const dt = performance.now() - t0;
    expect(res.fellBack).toBe(false);
    expect(dt).toBeLessThan(300);
  });
});
