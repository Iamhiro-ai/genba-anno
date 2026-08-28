// =============================================================================
// ffmpeg 引数の組み立てと -progress 出力のパース（純ロジック・spawn 非依存）
//
// 同梱する ffmpeg は ffmpeg-static@5.3.0（ffmpeg 6.x）。実バイナリで挙動を検証済み:
//   - fps モード   : `-vf fps=<value>`                       … 毎秒 value 枚
//   - every_n モード: `-vf select=not(mod(n\,N)) -fps_mode vfr` … N フレームごと 1 枚
//     ※ -fps_mode vfr（旧 -vsync vfr）が無いと CFR 補間で重複フレームが大量に出る
//        （検証: 30 フレームの動画で N=5 → vfr 有 6 枚 / 無 29 枚）
//   - 長辺リサイズ  : `scale=w=if(gte(iw,ih),min(iw,L),-2):h=if(gte(iw,ih),-2,min(ih,L))`
//     アスペクト維持・拡大しない・-2 で偶数丸め（検証: 640x360→320x180 / 360x640→112x200）
//
// filtergraph 内のカンマ・コロンはフィルタ/オプション区切りなのでバックスラッシュで
// エスケープする（spawn は配列渡し = シェルは経由しないため、シェル用の引用符は付けない）。
// =============================================================================

import type { VideoExtractParams } from '../../src/core/types';

export const FPS_MIN = 0.01;
export const FPS_MAX = 120;
export const EVERY_N_MAX = 100_000;
export const QUALITY_MIN = 2;
export const QUALITY_MAX = 31;
export const MAX_LONG_EDGE_MIN = 16;
export const MAX_LONG_EDGE_MAX = 20_000;

/** 出力ファイル名パターン（image2 マルチプレクサに渡す連番） */
export const OUTPUT_PATTERN_BASE = 'frame_%06d';

/** filtergraph の値部分をエスケープする（`\` `,` `:` `'` `[` `]` `;`） */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[,:'[\];]/g, (c) => `\\${c}`);
}

/** 長辺 maxLongEdge に収める scale フィルタ（アスペクト維持・拡大なし・偶数丸め） */
export function buildScaleFilter(maxLongEdge: number): string {
  const l = Math.round(maxLongEdge);
  const w = escapeFilterValue(`if(gte(iw,ih),min(iw,${l}),-2)`);
  const h = escapeFilterValue(`if(gte(iw,ih),-2,min(ih,${l}))`);
  return `scale=w=${w}:h=${h}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** VideoExtractParams を検証・クランプした結果（不正値は例外） */
export interface NormalizedVideoParams {
  mode: 'fps' | 'every_n';
  value: number;
  format: 'jpg' | 'png';
  quality: number;
  maxLongEdge: number | null;
}

export function normalizeVideoParams(params: VideoExtractParams): NormalizedVideoParams {
  if (params.mode !== 'fps' && params.mode !== 'every_n') {
    throw new Error('抽出モードが不正です（fps / every_n のみ）');
  }
  if (!Number.isFinite(params.value) || params.value <= 0) {
    throw new Error('抽出間隔の値が不正です');
  }
  if (params.format !== 'jpg' && params.format !== 'png') {
    throw new Error('出力形式が不正です（jpg / png のみ）');
  }

  const value =
    params.mode === 'fps'
      ? clamp(params.value, FPS_MIN, FPS_MAX)
      : clamp(Math.round(params.value), 1, EVERY_N_MAX);

  const quality = Number.isFinite(params.quality)
    ? clamp(Math.round(params.quality), QUALITY_MIN, QUALITY_MAX)
    : QUALITY_MIN;

  let maxLongEdge: number | null = null;
  if (params.maxLongEdge != null) {
    if (!Number.isFinite(params.maxLongEdge) || params.maxLongEdge < MAX_LONG_EDGE_MIN) {
      throw new Error('長辺リサイズの値が不正です');
    }
    maxLongEdge = clamp(Math.round(params.maxLongEdge), MAX_LONG_EDGE_MIN, MAX_LONG_EDGE_MAX);
  }

  return { mode: params.mode, value, format: params.format, quality, maxLongEdge };
}

/** -vf に渡すフィルタチェーンを組み立てる */
export function buildVideoFilter(normalized: NormalizedVideoParams): string {
  const filters: string[] = [];
  if (normalized.mode === 'fps') {
    filters.push(`fps=${normalized.value}`);
  } else {
    filters.push(`select=${escapeFilterValue(`not(mod(n,${normalized.value}))`)}`);
  }
  if (normalized.maxLongEdge != null) {
    filters.push(buildScaleFilter(normalized.maxLongEdge));
  }
  return filters.join(',');
}

/**
 * ffmpeg の引数配列を組み立てる。
 * outputPattern は呼び出し側（main.ts）が path.join で作った絶対パス
 * （例: <destDir>/frame_%06d.jpg）。この関数自体は fs / path に依存しない。
 */
export function buildFfmpegArgs(
  params: VideoExtractParams,
  outputPattern: string,
): string[] {
  const normalized = normalizeVideoParams(params);
  if (typeof params.videoPath !== 'string' || params.videoPath.length === 0) {
    throw new Error('動画ファイルのパスが不正です');
  }

  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-progress',
    'pipe:1',
    '-i',
    params.videoPath,
    '-vf',
    buildVideoFilter(normalized),
  ];

  if (normalized.mode === 'every_n') {
    // select フィルタで間引いた分を CFR 補間で埋め戻させない
    args.push('-fps_mode', 'vfr');
  }
  if (normalized.format === 'jpg') {
    args.push('-qscale:v', String(normalized.quality));
  }

  args.push('-f', 'image2', outputPattern);
  return args;
}

// ---------------------------------------------------------------------------
// -progress pipe:1 のパース
//   `key=value` 行が連続し、区切りとして `progress=continue` / `progress=end` が来る。
//   stdout はチャンク分割されるため行の途中で切れる前提でバッファリングする。
// ---------------------------------------------------------------------------

export interface FfmpegProgressState {
  /** 行途中で切れた未処理分 */
  readonly partial: string;
  /** これまでに出力されたフレーム数 */
  readonly framesWritten: number;
  /** progress=end を受け取ったか */
  readonly ended: boolean;
}

export const INITIAL_PROGRESS_STATE: FfmpegProgressState = {
  partial: '',
  framesWritten: 0,
  ended: false,
};

/** stdout チャンクを 1 つ食わせて新しい状態を返す（純関数） */
export function feedFfmpegProgress(
  state: FfmpegProgressState,
  chunk: string,
): FfmpegProgressState {
  const text = state.partial + chunk;
  const lines = text.split(/\r?\n/);
  const partial = lines.pop() ?? '';

  let framesWritten = state.framesWritten;
  let ended = state.ended;

  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'frame') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) framesWritten = n;
    } else if (key === 'progress' && value === 'end') {
      ended = true;
    }
  }

  return { partial, framesWritten, ended };
}
