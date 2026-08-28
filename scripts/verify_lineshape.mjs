// lineShape.ts（ライン中心線→ポリゴン再生成・分岐union・連結判定）の単体検証。
// vitest 枠が無いため Node 実行の代替（要望4）。実行: cd frontend && node scripts/verify_lineshape.mjs

import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

// lineShape + 幾何ヘルパを1モジュールにバンドル（import 解決のため build API を使用）
const entry = join(here, '.lineshape.entry.ts');
writeFileSync(
  entry,
  `export * from '../src/core/lineShape';
export { polygonArea, pointInPolygon, polylineToPolygon } from '../src/core/geometry';
`
);
const out = join(here, '.lineshape.bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
const ls = await import(out);
try { unlinkSync(entry); } catch { /* ignore */ }
try { unlinkSync(out); } catch { /* ignore */ }

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}${extra ? '  (' + extra + ')' : ''}`);
  else {
    console.error(`  FAIL ${name}${extra ? '  (' + extra + ')' : ''}`);
    failures++;
  }
}

console.log('1) 単一枝: polylineToPolygon と完全一致（後方互換）');
{
  const branches = [[[50, 50], [50, 200], [80, 300]]];
  const meta = { branches, width: 10 };
  const regen = ls.regenLinePolygon(meta, 640, 640);
  const direct = ls.polylineToPolygon(branches[0], 10);
  check('same vertex count', regen.length === direct.length, `${regen.length} vs ${direct.length}`);
  let same = regen.length === direct.length;
  if (same) {
    for (let i = 0; i < regen.length; i++) {
      if (Math.abs(regen[i][0] - direct[i][0]) > 1e-9 || Math.abs(regen[i][1] - direct[i][1]) > 1e-9) { same = false; break; }
    }
  }
  check('identical coordinates', same);
}

console.log('2) T字分岐: union で単一ポリゴン・両腕を包含・面積は幹単体より大');
{
  const trunk = [[100, 50], [100, 250]];        // 縦の幹
  const branch = [[100, 150], [200, 150]];      // 中点から右へ分岐
  const meta = { branches: [trunk, branch], width: 12 };
  const poly = ls.regenLinePolygon(meta, 640, 640);
  check('polygon generated', poly.length >= 8, `n=${poly.length}`);
  const areaUnion = ls.polygonArea(poly);
  const areaTrunk = ls.polygonArea(ls.polylineToPolygon(trunk, 12));
  const areaBranch = ls.polygonArea(ls.polylineToPolygon(branch, 12));
  check('area > trunk alone', areaUnion > areaTrunk, `union=${areaUnion.toFixed(0)} trunk=${areaTrunk.toFixed(0)}`);
  check('area ~ trunk+branch (±20%)', Math.abs(areaUnion - (areaTrunk + areaBranch)) < 0.2 * (areaTrunk + areaBranch), `sum=${(areaTrunk + areaBranch).toFixed(0)}`);
  // 両腕の代表点を包含しているか
  check('contains trunk top', ls.pointInPolygon([100, 60], poly));
  check('contains trunk bottom', ls.pointInPolygon([100, 240], poly));
  check('contains branch tip', ls.pointInPolygon([190, 150], poly));
  check('junction merged (contains junction)', ls.pointInPolygon([105, 150], poly));
  // 単一の閉ポリゴン＝COCO/yolo_seg の1インスタンス1ポリゴンを維持
  check('single polygon (flat ring)', Array.isArray(poly[0]) && typeof poly[0][0] === 'number');
}

console.log('3) filterConnectedBranches: 孤立枝は除去・接続枝は維持');
{
  const trunk = [[0, 0], [100, 0]];
  const attached = [[50, 0], [50, 60]];      // 幹に付いている
  const orphan = [[300, 300], [350, 350]];   // 遠く離れている
  const multi = [[50, 55], [120, 55]];       // attached に付いている（多段）
  const kept = ls.filterConnectedBranches([trunk, attached, orphan, multi], 10);
  check('kept 3 of 4', kept.length === 3, `kept=${kept.length}`);
  check('orphan removed', !kept.some(b => b[0][0] === 300));
  check('multi-hop kept', kept.some(b => b[0][1] === 55));
}

console.log('4) nearestOnBranches / lineEndpoints');
{
  const branches = [[[0, 0], [100, 0]], [[50, 0], [50, 80]]];
  const near = ls.nearestOnBranches(branches, [52, 40]);
  check('nearest is branch 1', near.branchIndex === 1, `bi=${near.branchIndex} dist=${near.dist.toFixed(1)}`);
  check('closest point ~(50,40)', Math.abs(near.point[0] - 50) < 1e-6 && Math.abs(near.point[1] - 40) < 1e-6);
  const eps = ls.lineEndpoints({ branches, width: 10 });
  // 幹の両端 + 枝の先端 = 3
  check('3 endpoints (trunk x2 + branch tip)', eps.length === 3, `n=${eps.length}`);
  check('branch tip is (50,80)', eps.some(e => e.branchIndex === 1 && e.point[1] === 80));
}

console.log('5) 可変幅リボン（要望5）: 一様=旧関数とビット等価 / テーパー=端で幅が異なる');
{
  const line = [[100, 100], [100, 200], [100, 300]];
  // 一様 widths → polylineToPolygon と完全一致（後方互換）
  const uni = ls.polylineToVariablePolygon(line, [12, 12, 12]);
  const ref = ls.polylineToPolygon(line, 12);
  let same = uni.length === ref.length && uni.every((p, i) => Math.abs(p[0] - ref[i][0]) < 1e-9 && Math.abs(p[1] - ref[i][1]) < 1e-9);
  check('uniform variable == polylineToPolygon', same, `n=${uni.length}`);
  // テーパー: 上端幅4 / 下端幅16 → リボンの左右間隔が上4px・下16px
  const taper = ls.polylineToVariablePolygon(line, [4, 10, 16]);
  // left[0]と right(reversed)最後 = 上端の左右ペア。垂直線なので x 差 = 幅
  const n = 3;
  const topL = taper[0], topR = taper[2 * n - 1];
  const botL = taper[n - 1], botR = taper[n];
  const topW = Math.hypot(topL[0] - topR[0], topL[1] - topR[1]);
  const botW = Math.hypot(botL[0] - botR[0], botL[1] - botR[1]);
  check('top width == 4', Math.abs(topW - 4) < 1e-6, `topW=${topW.toFixed(2)}`);
  check('bottom width == 16', Math.abs(botW - 16) < 1e-6, `botW=${botW.toFixed(2)}`);
  // regenLinePolygon が widths を採用（単一枝・可変）
  const meta = { branches: [line], width: 10, widths: [[4, 10, 16]] };
  const poly = ls.regenLinePolygon(meta, 640, 640);
  check('regen uses widths (contains wide-bottom point)', ls.pointInPolygon([107, 295], poly) && !ls.pointInPolygon([107, 105], poly), `n=${poly.length}`);
  // 不整合 widths（点数違い）→ 一様幅にフォールバック（後方互換ガード）
  const bad = ls.regenLinePolygon({ branches: [line], width: 10, widths: [[4, 16]] }, 640, 640);
  const badRef = ls.polylineToPolygon(line, 10);
  check('mismatched widths falls back to uniform', bad.length === badRef.length, `n=${bad.length}`);
}

console.log('6) 可変幅union（要望5）: 太い幹+細い枝のカプセルスタンプ');
{
  const trunk = [[100, 50], [100, 250]];
  const branch = [[100, 150], [200, 150]];
  const meta = {
    branches: [trunk, branch],
    width: 10,
    widths: [[20, 20], [4, 4]], // 幹は太く・枝は細く
  };
  const poly = ls.regenLinePolygon(meta, 640, 640);
  check('variable union generated', poly.length >= 8, `n=${poly.length}`);
  check('wide trunk covered (x=108)', ls.pointInPolygon([108, 100], poly));
  check('thin branch does NOT cover y offset 6 (x=180,y=156.5)', !ls.pointInPolygon([180, 158], poly));
  check('thin branch covers its own line (x=180,y=150)', ls.pointInPolygon([180, 150], poly));
}

console.log('7) 性能: 300px 幹+2分岐の union 再生成（ウォーム後計測・60ms 未満）');
{
  const trunk = [[50, 50], [150, 200], [250, 350]];
  const b1 = [[150, 200], [260, 180]];
  const b2 = [[200, 275], [150, 340]];
  const widths = [[6, 8, 12], [8, 4], [10, 5]];
  // JIT ウォームアップ（実運用のブラウザでは数回目以降が定常値）
  for (let i = 0; i < 3; i++) {
    ls.regenLinePolygon({ branches: [trunk, b1, b2], width: 8 }, 640, 640);
    ls.regenLinePolygon({ branches: [trunk, b1, b2], width: 8, widths }, 640, 640);
  }
  let dt = Infinity, n = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const poly = ls.regenLinePolygon({ branches: [trunk, b1, b2], width: 8 }, 640, 640);
    dt = Math.min(dt, performance.now() - t0);
    n = poly.length;
  }
  check('uniform union < 60ms', dt < 60, `${dt.toFixed(1)}ms n=${n}`);
  let dt2 = Infinity, n2 = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const poly = ls.regenLinePolygon({ branches: [trunk, b1, b2], width: 8, widths }, 640, 640);
    dt2 = Math.min(dt2, performance.now() - t0);
    n2 = poly.length;
  }
  check('variable union < 60ms', dt2 < 60, `${dt2.toFixed(1)}ms n=${n2}`);
}

console.log('8) 点単位巻き戻し（Backspace）: lineTailTarget / trimLineTail（末尾1点削除+widths同期）');
{
  // (a) 単一枝・可変幅: 末尾点を1つ削除して branches と widths が平行に縮む
  const line = [[100, 100], [100, 200], [100, 300], [100, 400]];
  const meta = { branches: [line], width: 10, widths: [[6, 8, 12, 16]] };
  const tgt = ls.lineTailTarget(meta);
  check('tail target = trunk end (bi=0, last point)', tgt.branchIndex === 0 && tgt.point[1] === 400, `bi=${tgt.branchIndex} y=${tgt.point[1]}`);
  const t1 = ls.trimLineTail(meta);
  check('trim keeps 1 branch', t1.branches.length === 1, `n=${t1.branches.length}`);
  check('branch shrinks to 3 points', t1.branches[0].length === 3, `pts=${t1.branches[0].length}`);
  check('widths shrinks in parallel to 3', t1.widths[0].length === 3, `ws=${t1.widths[0].length}`);
  check('widths values are head slice [6,8,12]', t1.widths[0].join(',') === '6,8,12', t1.widths[0].join(','));
  // 再生成できる（>=3頂点）
  const poly1 = ls.regenLinePolygon({ branches: t1.branches, width: 10, widths: t1.widths }, 640, 640);
  check('trimmed line regenerates polygon', poly1.length >= 3, `n=${poly1.length}`);
  check('regen no longer contains removed tail (y=400)', !ls.pointInPolygon([100, 400], poly1));

  // (b) 分岐あり: 最も新しい枝（最大index）の末尾から削れる
  const trunk = [[100, 50], [100, 250]];
  const branch = [[100, 150], [200, 150], [280, 150]]; // 3点の枝
  const m2 = { branches: [trunk, branch], width: 12 };
  const tt = ls.lineTailTarget(m2);
  check('tail target = newest branch (bi=1)', tt.branchIndex === 1 && tt.point[0] === 280, `bi=${tt.branchIndex} x=${tt.point[0]}`);
  const r2 = ls.trimLineTail(m2);
  check('branch trimmed to 2 points, trunk intact', r2.branches.length === 2 && r2.branches[1].length === 2 && r2.branches[0].length === 2, `b0=${r2.branches[0].length} b1=${r2.branches[1].length}`);

  // (c) 2点の枝は枝ごと削除（幹は残る）
  const m3 = { branches: [trunk, [[100, 150], [200, 150]]], width: 12 };
  const r3 = ls.trimLineTail(m3);
  check('2-point branch removed entirely', r3.branches.length === 1, `n=${r3.branches.length}`);
  check('trunk survives after branch removal', r3.branches[0].length === 2 && r3.branches[0][0][1] === 50);

  // (d) 幹が2点→退化でライン全体消滅（branches:[]）
  const m4 = { branches: [[[100, 100], [100, 200]]], width: 10 };
  const r4 = ls.trimLineTail(m4);
  check('trunk down to <2 → whole line gone (branches empty)', r4.branches.length === 0, `n=${r4.branches.length}`);
  check('lineTailTarget null when no valid branch', ls.lineTailTarget({ branches: [[[0, 0]]], width: 10 }) === null);
}

console.log('');
if (failures === 0) {
  console.log('ALL LINESHAPE CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
