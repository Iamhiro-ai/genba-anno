// =============================================================================
// StorageAdapter のブラウザ単体実行用モック（M3）
//
// `npm run dev:web` で Electron 無しに UI を動かすためのアダプタ。
//   - サンプル画像 8 枚を Canvas で生成（シード固定 = 毎回同じ絵）。
//     明るめのアスファルト風グレーノイズ + 暗い不規則な折れ線（ひび割れ 2〜4 本）
//     + 一部に白線。マグネットライン（暗い線を追う）の動作確認に使える。
//   - project.json / サイドカーはメモリ上の Map。保存 → 再読込の E2E が成立する。
//   - エクスポートはメモリに収集し window.__gaMockExport で検査できる。
//   - 動画フレーム抽出は非対応（videoSupported = false）。
// =============================================================================

import type {
  ImageEntry,
  Project,
  RecentProject,
  SidecarFile,
  VideoExtractParams,
  VideoExtractProgress,
} from '../core/types';
import type { ExportWriter, OpenProjectResult, StorageAdapter } from './types';

declare global {
  interface Window {
    /** E2E 検証用: mock のエクスポート結果（beginExport のたびに差し替わる） */
    __gaMockExport?: {
      projectDir: string;
      destDir: string;
      files: Map<string, Uint8Array | string>;
      ended: boolean;
    };
  }
}

/** pickImageDirectory が返す固定の仮想フォルダ ID */
export const MOCK_PROJECT_DIR = '/mock/sample';
/** pickDirectory が返す固定の仮想出力先 */
export const MOCK_EXPORT_DIR = '/mock/export';

const SAMPLE_COUNT = 8;
const SAMPLE_WIDTH = 1280;
const SAMPLE_HEIGHT = 960;
/** シード（変えるとサンプル画像の絵柄が変わる） */
const SAMPLE_BASE_SEED = 20260828;

// ---------------------------------------------------------------------------
// 決定的な擬似乱数（mulberry32）
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// サンプル画像生成
// ---------------------------------------------------------------------------

/** 低周波ノイズ（32px グリッドをバイリニア補間）。アスファルトのムラを作る */
function makeBlotchSampler(
  rand: () => number,
  width: number,
  height: number,
  cell: number,
): (x: number, y: number) => number {
  const cols = Math.ceil(width / cell) + 2;
  const rows = Math.ceil(height / cell) + 2;
  const grid = new Float32Array(cols * rows);
  for (let i = 0; i < grid.length; i += 1) grid[i] = rand() * 2 - 1;

  return (x: number, y: number): number => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    const i00 = y0 * cols + x0;
    const v00 = grid[i00];
    const v10 = grid[i00 + 1];
    const v01 = grid[i00 + cols];
    const v11 = grid[i00 + cols + 1];
    const top = v00 + (v10 - v00) * tx;
    const bottom = v01 + (v11 - v01) * tx;
    return top + (bottom - top) * ty;
  };
}

/** アスファルト風の下地を ImageData で描く */
function paintAsphalt(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  width: number,
  height: number,
): void {
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const coarse = makeBlotchSampler(rand, width, height, 48);
  const medium = makeBlotchSampler(rand, width, height, 12);
  const base = 146 + rand() * 14; // 画像ごとに明るさを少し変える

  let p = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value =
        base + coarse(x, y) * 16 + medium(x, y) * 9 + (rand() * 2 - 1) * 11;
      const v = value < 0 ? 0 : value > 255 ? 255 : value;
      // 灰色に僅かな色味を載せる（完全な無彩色より写真らしい）
      data[p] = v;
      data[p + 1] = v * 0.99;
      data[p + 2] = v * 0.96;
      data[p + 3] = 255;
      p += 4;
    }
  }
  ctx.putImageData(image, 0, 0);
}

interface CrackPoint {
  x: number;
  y: number;
}

/** 端から端へ蛇行する折れ線（ひび割れの中心線）を作る */
function makeCrackPath(
  rand: () => number,
  width: number,
  height: number,
): CrackPoint[] {
  const fromLeft = rand() < 0.55;
  let x = fromLeft ? -20 + rand() * 60 : rand() * width;
  let y = fromLeft ? rand() * height : -20 + rand() * 60;
  let angle = fromLeft
    ? (rand() - 0.5) * 0.9 // ほぼ右向き
    : Math.PI / 2 + (rand() - 0.5) * 0.9; // ほぼ下向き

  const points: CrackPoint[] = [{ x, y }];
  const steps = 40 + Math.floor(rand() * 40);
  for (let i = 0; i < steps; i += 1) {
    // 大きく折れる点をたまに混ぜて「不規則な折れ線」らしくする
    const jitter = rand() < 0.12 ? (rand() - 0.5) * 1.1 : (rand() - 0.5) * 0.42;
    angle += jitter;
    const step = 14 + rand() * 26;
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
    points.push({ x, y });
    if (x < -60 || x > width + 60 || y < -60 || y > height + 60) break;
  }
  return points;
}

/** 幅を揺らしながら折れ線を描く（濃淡ムラも入れる） */
function strokeCrack(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  points: CrackPoint[],
  baseWidth: number,
): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const w = Math.max(1.6, baseWidth * (0.55 + rand() * 0.9));
    const darkness = 28 + rand() * 26;
    ctx.strokeStyle = `rgba(${darkness}, ${darkness - 2}, ${darkness - 4}, ${0.72 + rand() * 0.26})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

/** 路面標示のような白線 */
function strokeWhiteLine(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  width: number,
  height: number,
): void {
  const vertical = rand() < 0.5;
  const thickness = 26 + rand() * 22;
  const offset = 0.2 + rand() * 0.6;
  const skew = (rand() - 0.5) * 0.18;

  ctx.save();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = `rgba(232, 231, 226, ${0.72 + rand() * 0.2})`;
  ctx.lineWidth = thickness;
  ctx.beginPath();
  if (vertical) {
    const x = width * offset;
    ctx.moveTo(x - height * skew, -20);
    ctx.lineTo(x + height * skew, height + 20);
  } else {
    const y = height * offset;
    ctx.moveTo(-20, y - width * skew);
    ctx.lineTo(width + 20, y + width * skew);
  }
  ctx.stroke();
  ctx.restore();
}

function renderSample(index: number): HTMLCanvasElement {
  if (typeof document === 'undefined') {
    throw new Error('[GenbaAnno] mockAdapter のサンプル画像生成にはブラウザ環境が必要です');
  }
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('[GenbaAnno] Canvas 2D コンテキストを取得できませんでした');
  }

  const rand = mulberry32(SAMPLE_BASE_SEED + index * 7919);
  paintAsphalt(ctx, rand, SAMPLE_WIDTH, SAMPLE_HEIGHT);

  // 一部の画像に白線（マグネットの invert モード確認用）
  if (index % 3 === 0) {
    strokeWhiteLine(ctx, rand, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  }

  const crackCount = 2 + Math.floor(rand() * 3); // 2〜4 本
  for (let i = 0; i < crackCount; i += 1) {
    const path = makeCrackPath(rand, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const baseWidth = 3.5 + rand() * 6;
    strokeCrack(ctx, rand, path, baseWidth);

    // 分岐を 0〜2 本生やす
    const branches = Math.floor(rand() * 3);
    for (let b = 0; b < branches; b += 1) {
      const anchorIndex = Math.floor(rand() * (path.length - 2)) + 1;
      const anchor = path[anchorIndex];
      const branch: CrackPoint[] = [{ ...anchor }];
      let angle = rand() * Math.PI * 2;
      let { x, y } = anchor;
      const steps = 6 + Math.floor(rand() * 14);
      for (let s = 0; s < steps; s += 1) {
        angle += (rand() - 0.5) * 0.5;
        const step = 10 + rand() * 18;
        x += Math.cos(angle) * step;
        y += Math.sin(angle) * step;
        branch.push({ x, y });
      }
      strokeCrack(ctx, rand, branch, baseWidth * 0.6);
    }
  }

  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('[GenbaAnno] サンプル画像の生成に失敗しました'));
      },
      'image/jpeg',
      0.9,
    );
  });
}

function sampleFileName(index: number): string {
  return `sample_${String(index + 1).padStart(3, '0')}.jpg`;
}

// ---------------------------------------------------------------------------
// アダプタ本体
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

export function createMockAdapter(): StorageAdapter {
  /** dir → project.json */
  const projects = new Map<string, Project>();
  /** dir → (画像ファイル名 → サイドカー) */
  const sidecars = new Map<string, Map<string, SidecarFile>>();
  /** 画像ファイル名 → blob URL */
  const imageUrls = new Map<string, string>();
  let samplesReady: Promise<void> | null = null;

  function sidecarsOf(dir: string): Map<string, SidecarFile> {
    let map = sidecars.get(dir);
    if (!map) {
      map = new Map<string, SidecarFile>();
      sidecars.set(dir, map);
    }
    return map;
  }

  async function ensureSamples(): Promise<void> {
    if (!samplesReady) {
      samplesReady = (async () => {
        for (let i = 0; i < SAMPLE_COUNT; i += 1) {
          const blob = await canvasToBlob(renderSample(i));
          imageUrls.set(sampleFileName(i), URL.createObjectURL(blob));
          // 生成の間に UI へ制御を戻す（8 枚 × 1280x960 のノイズ生成は重い）
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
        }
      })();
    }
    return samplesReady;
  }

  function listEntries(dir: string): ImageEntry[] {
    const stored = sidecarsOf(dir);
    return Array.from({ length: SAMPLE_COUNT }, (_unused, i) => {
      const file = sampleFileName(i);
      const sidecar = stored.get(file);
      return {
        file,
        status: sidecar?.status ?? 'pending',
        annotationCount: sidecar?.annotations?.length ?? 0,
      };
    });
  }

  return {
    kind: 'mock',

    // --- プロジェクト -----------------------------------------------------
    async pickImageDirectory(): Promise<string | null> {
      return MOCK_PROJECT_DIR;
    },

    async openProject(dir: string): Promise<OpenProjectResult> {
      await ensureSamples();
      return {
        dir,
        project: projects.has(dir) ? clone(projects.get(dir)!) : null,
        images: listEntries(dir),
        corruptSidecars: [],
        // メモリ保存なので壊れたファイル・修復・情報欠落は発生しない
        warnings: [],
        lossy: false,
      };
    },

    async relistImages(dir: string): Promise<ImageEntry[]> {
      await ensureSamples();
      return listEntries(dir);
    },

    async listRecent(): Promise<RecentProject[]> {
      return [];
    },

    async saveProjectFile(dir: string, project: Project): Promise<void> {
      projects.set(dir, clone(project));
    },

    // --- 画像・サイドカー -------------------------------------------------
    imageUrl(_dir: string, file: string): string {
      return imageUrls.get(file) ?? '';
    },

    async loadSidecar(dir: string, file: string): Promise<SidecarFile | null> {
      const found = sidecarsOf(dir).get(file);
      return found ? clone(found) : null;
    },

    async saveSidecar(dir: string, file: string, data: SidecarFile): Promise<void> {
      sidecarsOf(dir).set(file, clone(data));
    },

    async loadAllSidecars(dir: string): Promise<{
      sidecars: { file: string; data: SidecarFile }[];
      corrupt: string[];
    }> {
      const stored = sidecarsOf(dir);
      return {
        sidecars: [...stored.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([file, data]) => ({ file, data: clone(data) })),
        corrupt: [],
      };
    },

    // --- エクスポート -----------------------------------------------------
    async pickDirectory(_title: string): Promise<string | null> {
      return MOCK_EXPORT_DIR;
    },

    async beginExport(projectDir: string, destDir: string): Promise<ExportWriter> {
      const files = new Map<string, Uint8Array | string>();
      const record = { projectDir, destDir, files, ended: false };
      if (typeof window !== 'undefined') {
        window.__gaMockExport = record;
      }
      return {
        async copyImage(srcFile: string, destRelPath: string): Promise<void> {
          const url = imageUrls.get(srcFile);
          if (!url) {
            files.set(destRelPath, `mock-missing-image:${srcFile}`);
            return;
          }
          try {
            const response = await fetch(url);
            files.set(destRelPath, new Uint8Array(await response.arrayBuffer()));
          } catch {
            // blob URL を読めない環境でも「どの画像がコピーされたか」は検査できるようにする
            files.set(destRelPath, `mock-image:${srcFile}`);
          }
        },
        async writeFile(destRelPath: string, data: Uint8Array | string): Promise<void> {
          files.set(destRelPath, typeof data === 'string' ? data : new Uint8Array(data));
        },
        async end(): Promise<void> {
          record.ended = true;
        },
      };
    },

    // --- 動画フレーム抽出（非対応） ---------------------------------------
    videoSupported: false,

    async pickVideoFile(): Promise<string | null> {
      return null;
    },

    async extractFrames(
      _params: VideoExtractParams,
      onProgress: (p: VideoExtractProgress) => void,
    ): Promise<void> {
      const message = 'ブラウザ実行では動画フレーム抽出を利用できません（Electron 版を使ってください）';
      onProgress({ framesWritten: 0, done: true, error: message });
      throw new Error(message);
    },

    // --- その他 -----------------------------------------------------------
    async revealInFolder(absPath: string): Promise<void> {
      console.info('[GenbaAnno mock] revealInFolder:', absPath);
    },

    async appVersion(): Promise<string> {
      return '0.1.0-mock';
    },
  };
}
