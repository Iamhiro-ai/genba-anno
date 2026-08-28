// マグネットライン（livewire / intelligent scissors）の純関数群。
// 機能B・設計: docs/ROUND4_ANNOTATION_GUIDE.md / ANNOTATION_SYSTEM_DESIGN §5(将来拡張→本実装)
//
// 方針（トラックA商用純度・古典手法のみ / ML 不使用）:
//   暗い筋（ひび割れ）に沿う最小コスト経路を Dijkstra/A* で探索する。
//   コスト = 輝度の暗さ（暗いほど低コスト）＋ 弱いガウス平滑 ＋ 簡易リッジ（DoG）強調。
//   経路が暗い筋に乗れない（平均輝度が高い）場合は呼び出し側が直線フォールバックする。
//
// すべて DOM 非依存（plain array / typed array で完結）。ROI 縮小は呼び出し側（Canvas）担当。
// 単体検証: frontend/scripts/verify_livewire.mjs（vitest 枠が無いため Node 実行の代替）。

/** ImageData 互換の最小インターフェース（Node 検証で plain object も渡せるように）。 */
export interface GrayImage {
  data: Uint8ClampedArray | number[]; // RGBA 連続（length = width*height*4）
  width: number;
  height: number;
}

/**
 * Douglas-Peucker 間引きの既定許容誤差 [縮小ROI px]。
 * 2026-07-14 要望6: 1.6 → 0.8 に半減し、折れ点密度を約2倍へ（曲がりへの追従を細かく）。
 * 調整はこの定数1箇所（LivewireOptions.simplifyEps で呼び出し側上書きも可）。
 */
export const SIMPLIFY_EPS_DEFAULT = 0.8;

// --------------------------------------------------------------------------
// 幅推定の保守化キャップ（2026-07-15 FB: リボンが実ひびより太い／遠方で太りすぎ）
// 調整は以下4定数（+ WidthEstOptions / WidthCapOptions で呼び出し側上書きも可）に集約。
// --------------------------------------------------------------------------

/**
 * 幅推定の半値しきい値（谷の深さに対する割合）。0.50 = 従来の FWHM（半値全幅）。
 * FB診断: 半値だと影・ボケ由来の「暗いハロー」まで幅に含み実ひびより太る
 *   （実測 002074: 半値=10.5px → 0.40=3.5px・芯に近い側で測ると 1/3）。
 * 2026-07-15 再FB（黒芯の1.5〜2倍が残る）: 実画像3枚(000875/002544/002074)で較正し
 *   0.40→0.30（谷の 70% 深さ位置＝ほぼ黒芯のみ）へ深化。0.40 のロングテール(点最大6〜7.4px)が
 *   0.30 で 3.7〜4.1px へ激減し、黒芯外の背景画素を塗らなくなることをズーム実測で確認。
 *   0.25 まで下げるとコントラスト低いヘアライン芯を取り零す恐れがあり 0.30 を採用。小さいほど細い。
 */
export const WIDTH_HALF_FRAC_DEFAULT = 0.3;
/**
 * 幅推定への縮小係数。リボンをひびの内側へ収める側に一律で寄せる。既定 0.82。
 * 2026-07-15 較正: しきい深化(0.40→0.30)後に 0.82 で過剰縮小にならないか実画像で確認。
 *   黒芯へぴったり張り付き（本物の太いひび 002074 poly7 は max6.2px を維持＝潰れない）
 *   を確認したため 0.82 を据え置き（これ以上下げると本物のひびが痩せる）。
 */
export const WIDTH_SHRINK_DEFAULT = 0.82;
/**
 * 幅プロファイル平滑の移動窓半径（片側点数）。既定 2（5点窓）。
 */
export const WIDTH_SMOOTH_WIN_DEFAULT = 2;
/**
 * 幅プロファイル平滑の分位点（0=窓内最小 / 0.5=中央）。既定 0.35（min寄り）。
 * 2026-07-15 FB項目4（太い1点が近傍へ伝播）: 移動「中央値」は連続した太点の run を拾い
 *   近傍まで太らせていた。min寄りの低分位点にして「迷ったら細く（黒芯側）」へ寄せ、
 *   ファットスポットの横漏れを抑える（p90 2.05→1.56・実画像プール実測）。小さいほど細い。
 */
export const WIDTH_SMOOTH_Q_DEFAULT = 0.35;
/**
 * 自動推定幅の最大キャップ = 画像高さに対する割合（絶対 px でなく解像度比例）。
 * 既定 0.0125（640高 → 8px 前後）。手動スケール（[ ]・数値入力）はこの制限を受けない。
 */
export const MAX_WIDTH_FRAC_DEFAULT = 0.0125;
/**
 * y 位置キャップの最上部係数（最下部 y=H で 1.0・最上部 y=0 でこの値）。
 * 車載画像は上 = 遠方のため、上ほど自動幅の上限を farCapRatio 倍まで線形に絞る。既定 0.4。
 */
export const FAR_CAP_RATIO_DEFAULT = 0.4;

export interface LivewireOptions {
  /** リッジ（DoG）強調の重み。0 で無効。既定 0.5 */
  ridgeWeight?: number;
  /** 経路長ペナルティ兼コスト下限（0 に近いほど暗所へ強く吸着）。既定 0.02 */
  baseCost?: number;
  /** Douglas-Peucker 間引き許容誤差 [縮小ROI px]。既定 SIMPLIFY_EPS_DEFAULT (0.8・要望6) */
  simplifyEps?: number;
  /**
   * 追従した経路が直線チョードより平均輝度[0..1]でこれ以上暗ければ「暗い筋を掴んだ」
   * とみなし曲線を採用する（相対判定。路面明度の個体差に強い）。既定 0.04
   */
  minDrop?: number;
  /**
   * 直線チョード自体がこれより明るく、かつ相対低下も無い場合のみ「暗い筋なし」と
   * みなして直線フォールバック＋トースト通知する。既定 0.5
   */
  fallbackGray?: number;
}

const DEFAULTS: Required<LivewireOptions> = {
  ridgeWeight: 0.5,
  baseCost: 0.02,
  simplifyEps: SIMPLIFY_EPS_DEFAULT,
  minDrop: 0.04,
  fallbackGray: 0.5,
};

export type Point = [number, number];

// --------------------------------------------------------------------------
// 1) 輝度化
// --------------------------------------------------------------------------

/** RGBA → グレースケール [0..1]（0=黒/暗いひび, 1=白/明るい路面）。Rec.601 加重。 */
export function toGray(img: GrayImage): Float32Array {
  const { data, width, height } = img;
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    out[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  return out;
}

// --------------------------------------------------------------------------
// 2) 分離型ガウス平滑（3-tap / 5-tap）
// --------------------------------------------------------------------------

function convolveSeparable(
  src: Float32Array,
  width: number,
  height: number,
  kernel: number[]
): Float32Array {
  const k = kernel.length;
  const half = (k - 1) >> 1;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  // 横方向
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let t = 0; t < k; t++) {
        let xx = x + t - half;
        if (xx < 0) xx = 0;
        else if (xx >= width) xx = width - 1; // clamp 端
        acc += src[row + xx] * kernel[t];
      }
      tmp[row + x] = acc;
    }
  }
  // 縦方向
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let t = 0; t < k; t++) {
        let yy = y + t - half;
        if (yy < 0) yy = 0;
        else if (yy >= height) yy = height - 1;
        acc += tmp[yy * width + x] * kernel[t];
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

const GAUSS3 = [0.25, 0.5, 0.25];
const GAUSS5 = [0.0625, 0.25, 0.375, 0.25, 0.0625];

export function gaussian3(src: Float32Array, w: number, h: number): Float32Array {
  return convolveSeparable(src, w, h, GAUSS3);
}
export function gaussian5(src: Float32Array, w: number, h: number): Float32Array {
  return convolveSeparable(src, w, h, GAUSS5);
}

// --------------------------------------------------------------------------
// 3) コスト画像
// --------------------------------------------------------------------------

/**
 * コスト画像を作る。暗い画素ほど低コスト。
 * cost = clamp( baseCost + grayBlur - ridgeWeight*ridge , baseCost, 1 )
 *   grayBlur = gauss3(gray)（ノイズ低減）
 *   ridge    = clamp(gauss5(gray) - gauss3(gray), 0, 1)（細い暗線 = DoG で正）
 * 返り値の各要素は 1 画素の「通過コスト（暗さの逆＝明るさ寄り）」。
 */
export function buildCostMap(
  gray: Float32Array,
  width: number,
  height: number,
  opts: LivewireOptions = {}
): Float32Array {
  const o = { ...DEFAULTS, ...opts };
  const grayBlur = gaussian3(gray, width, height);
  const wide = o.ridgeWeight > 0 ? gaussian5(gray, width, height) : null;
  const n = width * height;
  const cost = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let c = o.baseCost + grayBlur[i];
    if (wide) {
      const ridge = wide[i] - grayBlur[i]; // >0 なら暗い筋
      if (ridge > 0) c -= o.ridgeWeight * ridge;
    }
    cost[i] = c < o.baseCost ? o.baseCost : c > 1 ? 1 : c;
  }
  return cost;
}

// --------------------------------------------------------------------------
// 4) A*（8近傍・許容ヒューリスティック）
// --------------------------------------------------------------------------

/** 二分ヒープ（min） key=priority, val=node index。lazy deletion 対応。 */
class MinHeap {
  private pr: number[] = [];
  private val: number[] = [];
  get size(): number {
    return this.pr.length;
  }
  push(priority: number, value: number): void {
    this.pr.push(priority);
    this.val.push(value);
    let i = this.pr.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.pr[p] <= this.pr[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): { priority: number; value: number } {
    const priority = this.pr[0];
    const value = this.val[0];
    const last = this.pr.length - 1;
    this.pr[0] = this.pr[last];
    this.val[0] = this.val[last];
    this.pr.pop();
    this.val.pop();
    const size = this.pr.length;
    let i = 0;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let s = i;
      if (l < size && this.pr[l] < this.pr[s]) s = l;
      if (r < size && this.pr[r] < this.pr[s]) s = r;
      if (s === i) break;
      this.swap(i, s);
      i = s;
    }
    return { priority, value };
  }
  private swap(a: number, b: number): void {
    const tp = this.pr[a];
    this.pr[a] = this.pr[b];
    this.pr[b] = tp;
    const tv = this.val[a];
    this.val[a] = this.val[b];
    this.val[b] = tv;
  }
}

export interface PathResult {
  /** 経路の画素 index 列（start→end）。到達不能なら null。 */
  path: number[] | null;
  /** 経路上グレースケール平均 [0..1]（フォールバック判定用）。 */
  avgGray: number;
}

const SQRT2 = Math.SQRT2;

/**
 * cost 画像上で start→end の最小コスト経路を A* で求める。
 * エッジ重み = cost(v) * stepLen（v=遷移先, 直交1/斜めsqrt2）。
 * ヒューリスティック = baseCost * 直線距離（許容的）。
 */
export function findPath(
  cost: Float32Array,
  gray: Float32Array,
  width: number,
  height: number,
  start: number,
  end: number,
  baseCost = DEFAULTS.baseCost
): PathResult {
  const n = width * height;
  if (start < 0 || start >= n || end < 0 || end >= n) return { path: null, avgGray: 1 };
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const ex = end % width;
  const ey = (end / width) | 0;
  const heap = new MinHeap();
  dist[start] = 0;
  heap.push(0, start);

  while (heap.size > 0) {
    const { value: u } = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === end) break;
    const ux = u % width;
    const uy = (u / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const vy = uy + dy;
      if (vy < 0 || vy >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const vx = ux + dx;
        if (vx < 0 || vx >= width) continue;
        const v = vy * width + vx;
        if (done[v]) continue;
        const step = dx !== 0 && dy !== 0 ? SQRT2 : 1;
        const nd = dist[u] + cost[v] * step;
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          // A* ヒューリスティック（許容的: 1歩の最小コスト = baseCost * stepLen）
          const hx = Math.abs(vx - ex);
          const hy = Math.abs(vy - ey);
          const h = baseCost * Math.hypot(hx, hy);
          heap.push(nd + h, v);
        }
      }
    }
  }

  if (prev[end] === -1 && start !== end) return { path: null, avgGray: 1 };
  // 経路復元
  const path: number[] = [];
  let cur = end;
  let guard = 0;
  const maxLen = n + 1;
  while (cur !== -1 && guard++ < maxLen) {
    path.push(cur);
    if (cur === start) break;
    cur = prev[cur];
  }
  path.reverse();
  let sum = 0;
  for (const p of path) sum += gray[p];
  return { path, avgGray: path.length ? sum / path.length : 1 };
}

// --------------------------------------------------------------------------
// 5) Douglas-Peucker 間引き
// --------------------------------------------------------------------------

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/** 直線 start→end 上をサンプルした平均グレースケール [0..1]（相対フォールバック判定用）。 */
export function meanGrayAlongLine(
  gray: Float32Array,
  width: number,
  height: number,
  start: Point,
  end: Point
): number {
  const steps = Math.max(2, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1])));
  let sum = 0;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    let x = Math.round(start[0] + (end[0] - start[0]) * t);
    let y = Math.round(start[1] + (end[1] - start[1]) * t);
    if (x < 0) x = 0;
    else if (x >= width) x = width - 1;
    if (y < 0) y = 0;
    else if (y >= height) y = height - 1;
    sum += gray[y * width + x];
  }
  return sum / (steps + 1);
}

/** Douglas-Peucker で頂点を間引く（端点は保持）。 */
export function douglasPeucker(points: Point[], eps: number): Point[] {
  if (points.length <= 2) return points.slice();
  let maxD = 0;
  let idx = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    const left = douglasPeucker(points.slice(0, idx + 1), eps);
    const right = douglasPeucker(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

// --------------------------------------------------------------------------
// 6) 高レベル: ROI 画像 + start/end（ROI画素座標）→ 経路（ROI画素座標）
// --------------------------------------------------------------------------

export interface TraceResult {
  /** ROI 画素座標の経路頂点列（start→end）。フォールバック時は [start,end]。 */
  points: Point[];
  /** 暗い筋が見つからず直線化したか。 */
  fellBack: boolean;
  /** 経路上グレースケール平均 [0..1]。 */
  avgGray: number;
}

/**
 * ROI ImageData 上で start→end を livewire トレースする。
 * start/end は ROI 画素座標 [x,y]（呼び出し側で ROI 縮小・座標変換済み）。
 */
export function traceLivewire(
  img: GrayImage,
  start: Point,
  end: Point,
  opts: LivewireOptions = {}
): TraceResult {
  const o = { ...DEFAULTS, ...opts };
  const { width, height } = img;
  const clampX = (x: number) => (x < 0 ? 0 : x >= width ? width - 1 : x) | 0;
  const clampY = (y: number) => (y < 0 ? 0 : y >= height ? height - 1 : y) | 0;
  const sx = clampX(start[0]);
  const sy = clampY(start[1]);
  const exi = clampX(end[0]);
  const eyi = clampY(end[1]);
  const straight: Point[] = [
    [sx, sy],
    [exi, eyi],
  ];

  const gray = toGray(img);
  const cost = buildCostMap(gray, width, height, o);
  const startIdx = sy * width + sx;
  const endIdx = eyi * width + exi;
  const { path, avgGray } = findPath(cost, gray, width, height, startIdx, endIdx, o.baseCost);

  // 相対判定: 追従経路が直線チョードより minDrop 以上暗ければ「暗い筋を掴んだ」＝曲線採用。
  // 路面の絶対明度は撮影ごとに大きく変わるため、絶対閾値ではなくチョード比較で頑健化する。
  const straightAvg = meanGrayAlongLine(gray, width, height, [sx, sy], [exi, eyi]);
  const grabbedDark = !!path && straightAvg - avgGray >= o.minDrop;

  if (!grabbedDark) {
    // 直線化。直線チョードも明るい（暗い筋が全く無い）ときだけ fellBack=true でトースト。
    // 直線チョードが暗い＝ひびが直線状 → その直線が正しいトレースなので通知しない。
    const noDarkCrack = straightAvg > o.fallbackGray;
    return { points: straight, fellBack: noDarkCrack, avgGray: straightAvg };
  }
  const pts: Point[] = path!.map((idx) => [idx % width, (idx / width) | 0]);
  const simplified = douglasPeucker(pts, o.simplifyEps);
  // 端点は元の start/end に固定（クリック位置を厳密に尊重）
  simplified[0] = [sx, sy];
  simplified[simplified.length - 1] = [exi, eyi];
  return { points: simplified, fellBack: false, avgGray };
}

// --------------------------------------------------------------------------
// 7) ひび実幅の推定（要望3・自動初期幅）
// --------------------------------------------------------------------------

/** 幅推定の保守化オプション（谷の深さ割合・縮小係数・平滑分位）。 */
export interface WidthEstOptions {
  /** 半値しきい割合。既定 WIDTH_HALF_FRAC_DEFAULT (0.30)。小さいほど暗い芯寄り＝細い。 */
  halfFrac?: number;
  /** 推定幅への縮小係数。既定 WIDTH_SHRINK_DEFAULT (0.82)。 */
  shrink?: number;
  /** 平滑の分位点。既定 WIDTH_SMOOTH_Q_DEFAULT (0.35・min寄り)。0=窓内最小 0.5=中央。 */
  smoothQ?: number;
  /** 平滑移動窓の片側点数。既定 WIDTH_SMOOTH_WIN_DEFAULT (2)。 */
  smoothWin?: number;
}

/**
 * トレース経路に直交する輝度プロファイルから、暗い筋（ひび）の実幅を推定する。
 * 各サンプル点で: 中心の最暗値 g0・プロファイル両端の背景中央値 bg を取り、
 * しきい値（g0 + (bg-g0)*halfFrac）を跨ぐ左右の交点間距離 ×shrink を幅とする。
 * halfFrac=0.30（既定）はハロー除去のため半値(0.50)より暗い芯寄り（谷70%深さ）で測る＝保守化。
 * 有効サンプル（十分なコントラスト bg-g0 ≥ 0.08）の中央値を返す。
 *
 * @param img  ROI 画像（RGBA）
 * @param path トレース経路（ROI 画素座標。traceLivewire の points）
 * @param maxHalf プロファイル片側長 [px]（既定 12 → 最大幅 24px 相当）
 * @param opts 保守化パラメータ（halfFrac・shrink）
 * @returns 推定幅 [ROI px]。有効サンプル 3 未満なら null
 */
export function estimateCrackWidth(
  img: GrayImage,
  path: Point[],
  maxHalf = 12,
  opts: WidthEstOptions = {}
): number | null {
  const prof = estimateWidthProfile(img, path, maxHalf, opts);
  if (!prof) return null;
  const s = [...prof].sort((x, y) => x - y);
  return s[s.length >> 1];
}

/** path[idx] における直交プロファイルのしきい幅 [px]（コントラスト不足なら null）。 */
function widthAtPoint(
  gray: Float32Array,
  w: number,
  h: number,
  path: Point[],
  idx: number,
  maxHalf: number,
  halfFrac: number,
  shrink: number
): number | null {
  const sample = (x: number, y: number): number => {
    let xi = Math.round(x);
    let yi = Math.round(y);
    if (xi < 0) xi = 0;
    else if (xi >= w) xi = w - 1;
    if (yi < 0) yi = 0;
    else if (yi >= h) yi = h - 1;
    return gray[yi * w + xi];
  };
  const p = path[idx];
  const a = path[Math.max(0, idx - 2)];
  const b = path[Math.min(path.length - 1, idx + 2)];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const nx = -dy / len;
  const ny = dx / len;

  const step = 0.5;
  const n = Math.round((2 * maxHalf) / step) + 1;
  const mid = (n - 1) >> 1;
  // 直交プロファイル
  const prof: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = -maxHalf + i * step;
    prof.push(sample(p[0] + nx * s, p[1] + ny * s));
  }
  // 中心の再センタリング（経路が数px ずれていても最暗点に合わせる）
  let c = mid;
  for (let i = mid - 4; i <= mid + 4; i++) {
    if (i >= 0 && i < n && prof[i] < prof[c]) c = i;
  }
  const g0 = prof[c];
  // 背景 = プロファイル両端 4 サンプルずつの中央値
  const tails = [...prof.slice(0, 4), ...prof.slice(-4)].sort((x, y) => x - y);
  const bg = tails[tails.length >> 1];
  if (bg - g0 < 0.08) return null; // コントラスト不足（ひびでない）
  const th = g0 + (bg - g0) * halfFrac; // 既定0.30=谷の70%深さ（暗い芯寄り＝保守化）
  let iPos = c;
  while (iPos < n - 1 && prof[iPos] < th) iPos++;
  let iNeg = c;
  while (iNeg > 0 && prof[iNeg] < th) iNeg--;
  return (iPos - iNeg) * step * shrink;
}

/**
 * 要望5: 経路の**各中心線点**でひびの局所実幅を推定する（テーパー/遠近対応）。
 * - 各点で直交 FWHM を測定（コントラスト不足の点は無効）
 * - 有効点が 3 未満 または全体の 30% 未満なら null（呼び出し側は一様幅にフォールバック）
 * - 無効点は最近傍の有効点から線形補間で充填
 * - 外れ値対策として経路に沿った移動「低分位点」（窓 5 点・既定 q=0.35）で平滑化。
 *   中央値だと連続した太点 run を近傍へ広げるため、min寄りにして黒芯側へ寄せる（FB項目4）。
 *
 * @returns path と同数の幅配列 [ROI px]。推定不能なら null
 */
export function estimateWidthProfile(
  img: GrayImage,
  path: Point[],
  maxHalf = 12,
  opts: WidthEstOptions = {}
): number[] | null {
  if (path.length < 2) return null;
  const halfFrac = opts.halfFrac ?? WIDTH_HALF_FRAC_DEFAULT;
  const shrink = opts.shrink ?? WIDTH_SHRINK_DEFAULT;
  const smoothQ = opts.smoothQ ?? WIDTH_SMOOTH_Q_DEFAULT;
  const smoothWin = opts.smoothWin ?? WIDTH_SMOOTH_WIN_DEFAULT;
  const { width, height } = img;
  const gray = toGray(img);

  const raw: (number | null)[] = path.map((_, i) =>
    widthAtPoint(gray, width, height, path, i, maxHalf, halfFrac, shrink)
  );
  const validCount = raw.filter((v) => v !== null).length;
  if (validCount < 3 || validCount < path.length * 0.3) return null;

  // 無効点を線形補間で充填（両端は最近傍の有効値）
  const filled: number[] = new Array(path.length);
  let prevIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== null) {
      filled[i] = raw[i] as number;
      if (prevIdx === -1) {
        for (let j = 0; j < i; j++) filled[j] = raw[i] as number; // 先頭側は nearest
      } else if (prevIdx < i - 1) {
        const a = raw[prevIdx] as number;
        const b = raw[i] as number;
        for (let j = prevIdx + 1; j < i; j++) {
          filled[j] = a + ((b - a) * (j - prevIdx)) / (i - prevIdx);
        }
      }
      prevIdx = i;
    }
  }
  for (let j = prevIdx + 1; j < raw.length; j++) filled[j] = filled[prevIdx]; // 末尾側 nearest

  // 移動「低分位点」（窓 2*smoothWin+1・端は窓縮小・既定 q=0.35 で min寄り）で
  // 外れ値を平滑化しつつ黒芯側へ寄せる（太点の近傍伝播を抑制・FB項目4）。
  const smoothed: number[] = new Array(filled.length);
  for (let i = 0; i < filled.length; i++) {
    const lo = Math.max(0, i - smoothWin);
    const hi = Math.min(filled.length - 1, i + smoothWin);
    const win = filled.slice(lo, hi + 1).sort((x, y) => x - y);
    smoothed[i] = lowerQuantile(win, smoothQ);
  }
  return smoothed;
}

/**
 * 昇順ソート済み配列の分位点 q [0..1] を線形補間で返す（q=0 で最小・0.5 で中央・1 で最大）。
 * 幅プロファイル平滑を min寄りにするための下側統計量（WIDTH_SMOOTH_Q_DEFAULT）。
 */
function lowerQuantile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const qq = q < 0 ? 0 : q > 1 ? 1 : q;
  const pos = qq * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

// --------------------------------------------------------------------------
// 8) 自動推定幅のキャップ（要望2: 画像サイズ比例の最大幅 / 要望3: y位置依存の遠方縮小）
// --------------------------------------------------------------------------

/** 幅キャップのオプション（画像高さ比の最大幅・最上部係数）。 */
export interface WidthCapOptions {
  /** 最大幅 = 画像高さ×この割合。既定 MAX_WIDTH_FRAC_DEFAULT (0.0125・640高→8px)。 */
  maxWidthFrac?: number;
  /** y位置キャップ最上部係数。既定 FAR_CAP_RATIO_DEFAULT (0.4)。 */
  farCapRatio?: number;
}

/**
 * 自動推定した点ごと幅に「画像サイズ比例の最大幅」と「y位置依存（遠方＝上ほど細く）」の
 * キャップを掛ける（要望2/3）。車載画像は上=遠方のため、上端に近い点ほど上限を
 * farCapRatio 倍まで線形に絞る。フルキャップ（画像高さ比）は最下部（近傍）で適用。
 * 手動スケール（[ ]・数値入力）はこのキャップを通さない（意図的操作は尊重）。
 *
 * @param widths 点ごと幅 [画像px]
 * @param ys     点ごとの画像y座標 [画像px]（0=上端/遠方, imageHeight=下端/近傍）
 * @param imageHeight 画像高さ [px]
 * @param opts   maxWidthFrac / farCapRatio（省略時は既定定数）
 * @returns キャップ後の点ごと幅 [画像px]（入力と同数）
 */
export function capWidthsByImagePosition(
  widths: number[],
  ys: number[],
  imageHeight: number,
  opts: WidthCapOptions = {}
): number[] {
  const maxWidthFrac = opts.maxWidthFrac ?? MAX_WIDTH_FRAC_DEFAULT;
  const farCapRatio = opts.farCapRatio ?? FAR_CAP_RATIO_DEFAULT;
  const fullCap = imageHeight > 0 ? imageHeight * maxWidthFrac : Infinity;
  return widths.map((w, i) => {
    const y = ys[i] ?? imageHeight;
    const t = imageHeight > 0 ? Math.min(Math.max(y / imageHeight, 0), 1) : 1; // 0=上端 1=下端
    const cap = fullCap * (farCapRatio + (1 - farCapRatio) * t);
    return w < cap ? w : cap;
  });
}

// --------------------------------------------------------------------------
// 9) リッジスナップ（ゴーストガイド: カーソル近傍の暗い筋への吸着）
// --------------------------------------------------------------------------
//
// ゴーストガイド（AI補完風・Tab確定）の核となる純関数。ユーザーがひびの真上に正確に
// カーソルを置かなくても、カーソル近傍の暗い筋（芯）へ終点を自動吸着する。これにより
// 「カーソルの向きと長さ」だけで範囲を示せ、精密な位置合わせが不要になる。
// 呼び出し側（AnnotationCanvas.magnetTrace）は ROI の gray を渡し、返った終点でトレースする。

/**
 * スナップ探索の距離ペナルティ係数。コスト = gray + coef×(距離/半径) を円内で最小化する。
 * 大きいほど「より近い暗点」を優先＝カーソル追従が安定するが遠いひびを拾いにくい。
 * 既定 0.15（半径端の暗点に +0.15 の下駄。中程度の暗さ差なら近い側を選ぶ落とし所）。
 */
export const SNAP_DIST_PENALTY_DEFAULT = 0.15;
/**
 * スナップ発動に必要な暗さ差（カーソル画素 gray − 吸着先画素 gray）。
 * これ未満＝ひびが無い/浅い（路面ノイズ程度）とみなし、吸着せずカーソル位置を返す。
 * 既定 0.03（8bit で約8階調ぶん・撮影ノイズより十分大きく、薄いひびは拾える下限）。
 */
export const SNAP_MIN_DROP_DEFAULT = 0.03;

export interface SnapOptions {
  /** 距離ペナルティ係数。既定 SNAP_DIST_PENALTY_DEFAULT (0.15)。 */
  distPenalty?: number;
  /** スナップ発動の最小暗さ差。既定 SNAP_MIN_DROP_DEFAULT (0.03)。 */
  minDrop?: number;
}

/**
 * gray 画像上で点 p の近傍（半径 radius px の円内）から暗い筋の芯へ吸着した点を返す。
 * 円内各画素のコスト = gray[画素] + distPenalty×(p からの距離/radius) を最小化し、
 * その画素が p の画素より minDrop 以上暗いときだけ吸着する（それ以外は p をそのまま返す）。
 * DOM 非依存の純関数（gray は toGray 出力。ROI／画像いずれの座標系でも radius を合わせれば可）。
 *
 * @param gray   グレースケール [0..1]（0=暗いひび, 1=明るい路面）
 * @param width  gray の横幅
 * @param height gray の高さ
 * @param p      カーソル点 [x,y]（座標系は gray に合わせる）
 * @param radius 探索半径 [px]（呼び出し側で clamp 済み）
 * @param opts   distPenalty / minDrop（省略時は既定定数）
 * @returns 吸着先 [x,y]（整数画素）／吸着しない場合は入力 p をそのまま
 */
export function snapToRidge(
  gray: Float32Array,
  width: number,
  height: number,
  p: Point,
  radius: number,
  opts: SnapOptions = {}
): Point {
  const distPenalty = opts.distPenalty ?? SNAP_DIST_PENALTY_DEFAULT;
  const minDrop = opts.minDrop ?? SNAP_MIN_DROP_DEFAULT;
  const r = Math.max(1, Math.round(radius));
  const cx = Math.round(p[0]);
  const cy = Math.round(p[1]);
  const clampX = (x: number) => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const clampY = (y: number) => (y < 0 ? 0 : y >= height ? height - 1 : y);
  const cursorGray = gray[clampY(cy) * width + clampX(cx)];
  const r2 = r * r;
  let bestCost = Infinity;
  let bx = clampX(cx);
  let by = clampY(cy);
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue; // 円内のみ探索
      const x = cx + dx;
      if (x < 0 || x >= width) continue;
      const cost = gray[y * width + x] + distPenalty * (Math.sqrt(d2) / r);
      if (cost < bestCost) {
        bestCost = cost;
        bx = x;
        by = y;
      }
    }
  }
  // 有意に暗い場合のみ吸着（路面ノイズ・一様路面への誤吸着を防ぐ）
  if (cursorGray - gray[by * width + bx] >= minDrop) return [bx, by];
  return p;
}
