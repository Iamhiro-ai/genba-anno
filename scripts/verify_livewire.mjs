// マグネットライン純関数の単体検証（vitest 枠が無いため Node 実行の代替・機能B5）。
// 実行: cd frontend && node scripts/verify_livewire.mjs
// livewire.ts を esbuild で TS→JS 変換し、合成画像で経路探索/間引き/フォールバックを検証する。

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = readFileSync(join(here, '../src/core/livewire.ts'), 'utf8');
const js = transformSync(tsSrc, { loader: 'ts', format: 'esm' }).code;
const tmp = join(here, '.livewire.compiled.mjs');
writeFileSync(tmp, js);
const lw = await import('./.livewire.compiled.mjs');
try { unlinkSync(tmp); } catch { /* 一時ファイル削除失敗は無視 */ }

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok   ${name}${extra ? '  (' + extra + ')' : ''}`);
  } else {
    console.error(`  FAIL ${name}${extra ? '  (' + extra + ')' : ''}`);
    failures++;
  }
}

// --- 合成画像ユーティリティ ---
function makeImage(w, h, fillGray = 217) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fillGray;
    data[i * 4 + 1] = fillGray;
    data[i * 4 + 2] = fillGray;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}
function drawDarkSeg(img, ax, ay, bx, by, val = 28, rad = 1) {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay)) * 2 + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(ax + (bx - ax) * t);
    const y = Math.round(ay + (by - ay) * t);
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
        const i = (yy * img.width + xx) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = val;
      }
    }
  }
}

console.log('1) toGray / buildCostMap: 暗い筋は背景より低コスト');
{
  const w = 80, h = 80;
  const img = makeImage(w, h);
  // 上に凸の折れ線（山型）: (5,40)->(40,10)->(75,40)
  drawDarkSeg(img, 5, 40, 40, 10);
  drawDarkSeg(img, 40, 10, 75, 40);
  const gray = lw.toGray(img);
  const cost = lw.buildCostMap(gray, w, h);
  const idxDark = 10 * w + 40;   // 山の頂点 (x=40,y=10) は暗線上
  const idxBg = 40 * w + 40;     // (x=40,y=40) は暗線から外れた背景
  check('dark gray < bg gray', gray[idxDark] < gray[idxBg], `dark=${gray[idxDark].toFixed(3)} bg=${gray[idxBg].toFixed(3)}`);
  check('dark cost < bg cost', cost[idxDark] < cost[idxBg], `dark=${cost[idxDark].toFixed(3)} bg=${cost[idxBg].toFixed(3)}`);
}

console.log('2) traceLivewire: 山型の暗線に沿って湾曲追従（直線チョードから逸れる）');
{
  const w = 80, h = 80;
  const img = makeImage(w, h);
  drawDarkSeg(img, 5, 40, 40, 10);
  drawDarkSeg(img, 40, 10, 75, 40);
  const res = lw.traceLivewire(img, [5, 40], [75, 40]);
  const minY = Math.min(...res.points.map((p) => p[1]));
  check('did not fall back', res.fellBack === false, `avgGray=${res.avgGray.toFixed(3)}`);
  check('path has >2 vertices (実形状)', res.points.length > 2, `n=${res.points.length}`);
  check('path bows up toward dark line (minY<20)', minY < 20, `minY=${minY}`);
  check('endpoints preserved', res.points[0][0] === 5 && res.points[0][1] === 40 && res.points[res.points.length - 1][0] === 75, `start=${res.points[0]} end=${res.points[res.points.length - 1]}`);
}

console.log('3) フォールバック: 暗い筋の無い一様画像は直線化＋fellBack');
{
  const w = 60, h = 60;
  const img = makeImage(w, h, 210); // 一様に明るい
  const res = lw.traceLivewire(img, [5, 30], [55, 30]);
  check('fellBack true on blank', res.fellBack === true, `avgGray=${res.avgGray.toFixed(3)}`);
  check('straight 2 points', res.points.length === 2, `n=${res.points.length}`);
}

console.log('4) douglasPeucker: 直線は2点/コーナーは保持');
{
  const collinear = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];
  const dp1 = lw.douglasPeucker(collinear, 0.5);
  check('collinear → 2 points', dp1.length === 2, `n=${dp1.length}`);
  const corner = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
  const dp2 = lw.douglasPeucker(corner, 0.5);
  check('L-corner kept (3 points)', dp2.length === 3, `n=${dp2.length}`);
}

console.log('4.5) estimateCrackWidth: 既知幅の暗帯から実幅を推定（要望3）');
{
  const w = 100, h = 100;
  const img = makeImage(w, h);
  // 幅 5px（rad=2 → 2*2+1）の縦の暗帯 x=50
  drawDarkSeg(img, 50, 10, 50, 90, 25, 2);
  const path = [];
  for (let y = 15; y <= 85; y += 5) path.push([50, y]);
  const est = lw.estimateCrackWidth(img, path);
  check('estimate not null', est !== null);
  check('width ≈ 5px (3..8)', est !== null && est >= 3 && est <= 8, `est=${est?.toFixed(1)}`);
  // コントラストの無い一様画像では null
  const blank = makeImage(w, h);
  const est2 = lw.estimateCrackWidth(blank, path);
  check('null on blank image', est2 === null, `est=${est2}`);
}

console.log('4.6) estimateWidthProfile: テーパー暗帯の局所幅に追従（要望5）');
{
  const w = 120, h = 160;
  const img = makeImage(w, h);
  // 上（y=10）rad=1（幅3px）→ 下（y=150）rad=5（幅11px）へ太くなる縦帯
  for (let y = 10; y <= 150; y++) {
    const t = (y - 10) / 140;
    const rad = Math.round(1 + 4 * t);
    drawDarkSeg(img, 60, y, 60, y, 25, rad);
  }
  const path = [];
  for (let y = 20; y <= 140; y += 5) path.push([60, y]);
  const prof = lw.estimateWidthProfile(img, path);
  check('profile not null', prof !== null);
  if (prof) {
    check('profile length == path length', prof.length === path.length, `n=${prof.length}`);
    const head = prof.slice(0, 5).reduce((a, b) => a + b, 0) / 5;   // 上（細い）
    const tail = prof.slice(-5).reduce((a, b) => a + b, 0) / 5;     // 下（太い）
    check('tail (wide) > head (thin) x1.8+', tail > head * 1.8, `head=${head.toFixed(1)}px tail=${tail.toFixed(1)}px`);
    check('head ≈ 3px (2..6)', head >= 2 && head <= 6, `head=${head.toFixed(1)}`);
    check('tail ≈ 11px (8..15)', tail >= 8 && tail <= 15, `tail=${tail.toFixed(1)}`);
  }
}

console.log('4.7) 折れ点密度: eps 0.8 で 1.6 の約2倍（要望6・実クラック相当のギザギザ曲線）');
{
  const w = 200, h = 200;
  const img = makeImage(w, h);
  // 実クラックはギザギザ（高周波成分）を含む。低周波の蛇行 + 高周波の細かい揺れ。
  // 参考実測: 実クラックROI(003533) で eps1.6=9点 → eps0.8=16点（1.78倍）
  let prev = null;
  const yAt = (x) => 100 + 25 * Math.sin((x - 10) / 20) + 3 * Math.sin((x - 10) / 3.1);
  for (let x = 10; x <= 190; x += 1) {
    const y = yAt(x);
    if (prev) drawDarkSeg(img, prev[0], prev[1], x, y, 25, 1);
    prev = [x, y];
  }
  const r16 = lw.traceLivewire(img, [10, Math.round(yAt(10))], [190, Math.round(yAt(190))], { simplifyEps: 1.6 });
  const r08 = lw.traceLivewire(img, [10, Math.round(yAt(10))], [190, Math.round(yAt(190))], { simplifyEps: 0.8 });
  const ratio = r08.points.length / r16.points.length;
  check('default eps is 0.8', lw.SIMPLIFY_EPS_DEFAULT === 0.8);
  check('both traced (not fallback)', !r16.fellBack && !r08.fellBack);
  check('vertex count ~2x (1.5..3.5)', ratio >= 1.5 && ratio <= 3.5, `eps1.6=${r16.points.length}点 eps0.8=${r08.points.length}点 ratio=${ratio.toFixed(2)}`);
}

console.log('4.8) 保守化: 影/ボケ由来のハローを持つ暗線は、しきい深化で幅が縮む（2026-07-15 FB）');
{
  // 実ひびの再現: 細い深い芯 + 広い浅いハロー（半値FWHMだとハローまで幅に含み太る）。
  const w = 120, h = 160;
  const img = makeImage(w, h, 217);
  const cx = 60;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = x - cx;
      // 芯（σ=1.5・深さ120）+ ハロー（σ=8・深さ70）を背景 217 から差し引く
      const core = 120 * Math.exp(-(d * d) / (2 * 1.5 * 1.5));
      const halo = 70 * Math.exp(-(d * d) / (2 * 8 * 8));
      const v = Math.max(0, Math.round(217 - core - halo));
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }
  const path = [];
  for (let y = 20; y <= 140; y += 5) path.push([cx, y]);
  const wFWHM = lw.estimateCrackWidth(img, path, 12, { halfFrac: 0.5, shrink: 1 }); // 従来
  const wDeep = lw.estimateCrackWidth(img, path, 12, { halfFrac: 0.35, shrink: 1 }); // 深化のみ
  const wDef = lw.estimateCrackWidth(img, path); // 既定（0.30 + shrink0.82 + plow0.35）
  // 実画像(002074)では 0.5=10.5px→既定=3.3px(1/3)。合成では低分位+平滑で圧縮され差は緩むが方向は同じ。
  check('default halfFrac is 0.30 (2026-07-15 保守化)', lw.WIDTH_HALF_FRAC_DEFAULT === 0.3, `=${lw.WIDTH_HALF_FRAC_DEFAULT}`);
  check('FWHM(0.5) is wide (halo込み)', wFWHM !== null && wFWHM > 5, `wFWHM=${wFWHM?.toFixed(1)}`);
  check('deeper thresh narrows (0.35<0.5)', wDeep !== null && wDeep < wFWHM, `wDeep=${wDeep?.toFixed(1)} < wFWHM=${wFWHM?.toFixed(1)}`);
  check('default (0.30+shrink+plow) narrower still', wDef !== null && wDef < wDeep, `wDef=${wDef?.toFixed(1)} < wDeep=${wDeep?.toFixed(1)}`);
  check('default cuts halo width ≥30%', wDef !== null && wDef <= wFWHM * 0.7, `ratio=${(wDef / wFWHM).toFixed(2)}`);
}

console.log('4.87) 低分位平滑: 局所ファットスポットが近傍へ伝播しない（2026-07-15 FB項目4）');
{
  // 細い芯（rad=1・幅3px相当）に、中央だけ太い塊（rad=4・幅9px）を局所付与。
  const w = 100, h = 200;
  const img = makeImage(w, h);
  for (let y = 10; y <= 190; y++) drawDarkSeg(img, 50, y, 50, y, 25, 1); // 細い縦芯
  for (let y = 97; y <= 103; y++) drawDarkSeg(img, 50, y, 50, y, 25, 4); // 中央7px区間だけ太い塊
  const path = [];
  for (let y = 20; y <= 180; y += 2) path.push([50, y]);
  const profDef = lw.estimateWidthProfile(img, path); // 既定 = 低分位 q=0.35（min寄り）
  const profMed = lw.estimateWidthProfile(img, path, 12, { smoothQ: 0.5 }); // 従来の中央値相当
  check('smoothQ default is 0.35 (min寄り)', lw.WIDTH_SMOOTH_Q_DEFAULT === 0.35, `=${lw.WIDTH_SMOOTH_Q_DEFAULT}`);
  check('both profiles not null', profDef !== null && profMed !== null);
  if (profDef && profMed) {
    // 各点で低分位≤中央値（保守側）。全体和も低分位の方が小さい＝太点の横漏れが少ない。
    const everyLE = profDef.every((v, i) => v <= profMed[i] + 1e-9);
    const sumDef = profDef.reduce((a, b) => a + b, 0);
    const sumMed = profMed.reduce((a, b) => a + b, 0);
    check('lowerQuantile ≤ median everywhere', everyLE);
    check('lowerQuantile suppresses spread (sum smaller)', sumDef < sumMed, `sumDef=${sumDef.toFixed(1)} < sumMed=${sumMed.toFixed(1)}`);
    // 塊から2点以上離れた「細い区間」は芯幅（≲4px）に収まる＝伝播していない。
    const blobIdx = path.findIndex((p) => p[1] >= 100);
    const farThin = profDef.filter((_, i) => Math.abs(i - blobIdx) >= 4);
    const maxFar = Math.max(...farThin);
    check('thin sections stay thin away from blob (<4px)', maxFar < 4, `maxFar=${maxFar.toFixed(1)}px`);
  }
}

console.log('4.85) 縮小係数 shrink は幅に線形（要望1: 推定値の縮小）');
{
  const w = 100, h = 100;
  const img = makeImage(w, h);
  drawDarkSeg(img, 50, 10, 50, 90, 25, 3); // 幅7px の縦帯（ハードエッジ→しきい非依存）
  const path = [];
  for (let y = 15; y <= 85; y += 5) path.push([50, y]);
  const w10 = lw.estimateCrackWidth(img, path, 12, { halfFrac: 0.5, shrink: 1.0 });
  const w08 = lw.estimateCrackWidth(img, path, 12, { halfFrac: 0.5, shrink: 0.8 });
  check('shrink 0.8 ≈ 0.8× of 1.0', w10 !== null && w08 !== null && Math.abs(w08 - w10 * 0.8) < 0.6, `w1.0=${w10?.toFixed(1)} w0.8=${w08?.toFixed(1)}`);
}

console.log('4.9) capWidthsByImagePosition: 画像高さ比の最大幅＋y位置依存（遠方縮小）（要望2/3）');
{
  const H = 640; // 640高 → fullCap = 640*0.0125 = 8px
  // 広すぎる幅 10px を上端/中央/下端に置く
  const capped = lw.capWidthsByImagePosition([10, 10, 10], [0, H / 2, H], H);
  check('bottom (near) = fullCap 8px', Math.abs(capped[2] - 8) < 1e-6, `bottom=${capped[2].toFixed(2)}`);
  check('top (far) = 40% of full (3.2px)', Math.abs(capped[0] - 3.2) < 1e-6, `top=${capped[0].toFixed(2)}`);
  check('monotonic top<mid<bottom', capped[0] < capped[1] && capped[1] < capped[2], `[${capped.map((v) => v.toFixed(1)).join(', ')}]`);
  // 細い幅（2px）はどのy位置でもキャップ対象外（そのまま）
  const thin = lw.capWidthsByImagePosition([2, 2, 2], [0, H / 2, H], H);
  check('thin width uncapped at all y', thin.every((v) => Math.abs(v - 2) < 1e-6), `[${thin.map((v) => v.toFixed(1)).join(', ')}]`);
  // 係数上書き（maxWidthFrac 0.015 → fullCap 9.6・farCapRatio 0.5）
  const custom = lw.capWidthsByImagePosition([20, 20], [0, H], H, { maxWidthFrac: 0.015, farCapRatio: 0.5 });
  check('opts override: bottom=9.6 top=4.8', Math.abs(custom[1] - 9.6) < 1e-6 && Math.abs(custom[0] - 4.8) < 1e-6, `top=${custom[0].toFixed(2)} bottom=${custom[1].toFixed(2)}`);
}

console.log('4.95) snapToRidge: 近傍の暗い筋へ吸着 / 一様画像・半径外は非吸着（ゴーストガイド）');
{
  const w = 100, h = 100;
  const img = makeImage(w, h);            // 明背景 217
  drawDarkSeg(img, 50, 5, 50, 95, 28, 1); // 幅3px（x=49..51）の縦の暗線
  const gray = lw.toGray(img);
  // (a) 線から数px外したカーソル → 線上（x≈49..51）へ吸着し、入力から動く
  const snapped = lw.snapToRidge(gray, w, h, [45, 40], 10);
  check('snaps onto dark line (x in 48..52)', snapped[0] >= 48 && snapped[0] <= 52, `snapped=[${snapped[0]},${snapped[1]}]`);
  check('snapped moved from cursor x=45', snapped[0] !== 45, `x=${snapped[0]}`);
  // (b) 一様な明画像は吸着せず入力点をそのまま返す
  const blank = lw.toGray(makeImage(w, h));
  const s2 = lw.snapToRidge(blank, w, h, [30, 30], 10);
  check('no snap on blank (returns input)', s2[0] === 30 && s2[1] === 30, `s2=[${s2[0]},${s2[1]}]`);
  // (c) 半径外の暗線には吸着しない（線まで約20px・半径8）
  const s3 = lw.snapToRidge(gray, w, h, [30, 40], 8);
  check('no snap when line out of radius', s3[0] === 30 && s3[1] === 40, `s3=[${s3[0]},${s3[1]}]`);
  // 既定定数の健全性
  check('SNAP_DIST_PENALTY_DEFAULT = 0.15', lw.SNAP_DIST_PENALTY_DEFAULT === 0.15, `=${lw.SNAP_DIST_PENALTY_DEFAULT}`);
  check('SNAP_MIN_DROP_DEFAULT = 0.03', lw.SNAP_MIN_DROP_DEFAULT === 0.03, `=${lw.SNAP_MIN_DROP_DEFAULT}`);
}

console.log('5) 性能: 512x512 の trace が 100ms 級');
{
  const w = 512, h = 512;
  const img = makeImage(w, h);
  drawDarkSeg(img, 20, 256, 256, 60);
  drawDarkSeg(img, 256, 60, 492, 256);
  const t0 = performance.now();
  const res = lw.traceLivewire(img, [20, 256], [492, 256]);
  const dt = performance.now() - t0;
  check('512x512 trace < 300ms', dt < 300, `${dt.toFixed(1)}ms, n=${res.points.length}, fellBack=${res.fellBack}`);
}

console.log('');
if (failures === 0) {
  console.log('ALL LIVEWIRE CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
