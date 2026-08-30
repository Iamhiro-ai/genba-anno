// =============================================================================
// ディスク形式 ⇔ 内部型の変換（M2）
//
// docs/DESIGN.md §2 / 設計ルール5:
//   「ディスク上の JSON は snake_case、TS 内部は camelCase（境界は serialize.ts のみ）」
// このファイルが唯一の変換点。他のモジュールは snake_case を直接触らないこと。
//
// 読み込みの方針（DESIGN.md §2「読み込み時」）:
//   - 未知フィールドは無視して読み進める（前方互換）
//   - 不正レコードは**そのレコードだけ**捨てて warnings に記録する（全損させない）
//   - 座標はサイドカー記載の width/height にクランプ。width/height 不明時はクランプしない
//     （0 に潰すとデータが壊れるため。呼び出し側が不一致バナーを出す）
//   - kind:'line' の line_meta が壊れていたら kind:'polygon' に降格（頂点は残す）
//
// DOM 非依存の純関数のみ（Node / Electron main / ブラウザで動く）。
// =============================================================================

import type {
  Annotation,
  AnnotationSource,
  AnnotationStatus,
  BBox,
  ClassDef,
  DrawTool,
  LineMeta,
  Project,
  ProjectFileJson,
  ProjectSettings,
  Pt,
  SidecarAnnotation,
  SidecarFile,
} from './types';
import {
  DEFAULT_CLASS_COLORS,
  LINE_WIDTH_MAX,
  LINE_WIDTH_MIN,
  PROJECT_SCHEMA_VERSION,
  SIDECAR_SCHEMA_VERSION,
} from './types';
import { clampBBoxToImage } from './geometry';
import { regenLinePolygon } from './lineShape';

const STATUSES: AnnotationStatus[] = ['pending', 'in_progress', 'done', 'skipped'];
const DRAW_TOOLS: DrawTool[] = ['bbox', 'polygon', 'line'];
const DEFAULT_LINE_WIDTH = 12;

/**
 * 画像寸法の上限。座標クランプの基準になるだけでなく、mask_png エクスポートの
 * new Uint8Array(w*h) のサイズを決めるため、巨大値をそのまま通すと RangeError や
 * 数 GB の確保になる。65535 を超える実画像はまず無いので、超えていたら丸めて警告する。
 */
const MAX_IMAGE_DIM = 65535;

/**
 * 局所幅（line_meta.widths）の上限。LINE_WIDTH_MAX の 4 倍。
 *
 * 【下限クランプを入れない理由（意図的・レビュー指摘を棄却した箇所）】
 * 局所幅はマグネットの幅推定由来で、WIDTH_EST_MIN=1.5px のヘアラインひび割れが
 * 正当なデータとして入る（reference の LOCAL_WIDTH_MIN=1.5 と一致）。
 * ここで代表幅の下限 LINE_WIDTH_MIN=4 までクランプすると、細いひび割れの
 * テーパー情報を読み込み時に破壊してしまう（DESIGN.md 罠#5「較正定数を理屈で直さない」）。
 * よって下限は「有限の正数」のままとし、異常に太い値の上限だけを守る。
 */
const MAX_LOCAL_WIDTH = LINE_WIDTH_MAX * 4;
const DEFAULT_PROJECT_NAME = 'プロジェクト';
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;

// ---------------------------------------------------------------------------
// unknown を安全に読むための小道具
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

/**
 * crypto.randomUUID()。未提供環境でも落ちないようフォールバックを持つ。
 * 型注釈を書かないのは意図的: グローバル型 `Crypto` は DOM lib にしか無く、
 * Electron main（tsconfig.node.json = lib ES2023 + @types/node）から import すると
 * TS2749 になるため。core は Node / main / ブラウザの3環境で型が通る必要がある（DESIGN §3）。
 */
function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// サイドカー: 内部型 → ディスク形式
// ---------------------------------------------------------------------------

export interface SidecarImageInfo {
  file: string;
  width: number;
  height: number;
}

function toSidecarAnnotation(a: Annotation): SidecarAnnotation {
  const base = { id: a.id, class_id: a.classId, source: a.source };
  if (a.kind === 'bbox') {
    return { ...base, kind: 'bbox', box: { x: a.box.x, y: a.box.y, w: a.box.w, h: a.box.h } };
  }
  const points = a.points.map(([x, y]): [number, number] => [x, y]);
  if (a.kind === 'line') {
    return {
      ...base,
      kind: 'line',
      points,
      line_meta: {
        branches: a.lineMeta.branches.map((br) => br.map(([x, y]): [number, number] => [x, y])),
        width: a.lineMeta.width,
        ...(a.lineMeta.widths ? { widths: a.lineMeta.widths.map((ws) => ws.slice()) } : {}),
      },
    };
  }
  return { ...base, kind: 'polygon', points };
}

/**
 * 内部アノテーション列 → サイドカー JSON（snake_case）。
 * schema_version は常に現行版・updated_at は書き込み時刻を付与する
 * （テスト等で固定したい場合のみ updatedAt を明示）。座標は丸めない（float のまま）。
 */
export function annotationsToSidecar(
  annotations: Annotation[],
  image: SidecarImageInfo,
  status: AnnotationStatus,
  updatedAt?: string
): SidecarFile {
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    image: { file: image.file, width: image.width, height: image.height },
    status,
    annotations: annotations.map(toSidecarAnnotation),
    updated_at: updatedAt ?? nowIso(),
  };
}

// ---------------------------------------------------------------------------
// サイドカー: ディスク形式 → 内部型（検証・修復つき）
// ---------------------------------------------------------------------------

export interface SidecarParseOptions {
  /** サイドカーの image.width/height が無い・不正なときのフォールバック（実画像の naturalWidth 等） */
  fallbackWidth?: number;
  fallbackHeight?: number;
}

export interface SidecarParseResult {
  annotations: Annotation[];
  status: AnnotationStatus;
  /** クランプ基準に使った画像サイズ（0 = 不明。呼び出し側が実画像と突き合わせて警告を出す） */
  width: number;
  height: number;
  /** 人間向けの警告文（UI トースト・ログ用）。空なら完全に正常 */
  warnings: string[];
  /**
   * 「このまま再保存すると、元ファイルにあった情報が失われる」warning が1件以上あったか。
   * warnings は無害な正規化も含むため、UI の出し分け（トーストで流す／保存前に止める）は
   * この真偽値で判断すること。lossy=true の画像は保存前に警告バナーを出す想定。
   *
   * 【lossy = true にする基準】= レコードまたはメタデータそのものが消えるもの
   *   - 不正レコードのスキップ（annotations 配列が読めない場合・ファイル全体が読めない場合を含む）
   *   - line_meta 不正による polygon 降格（中心線メタが消える）
   *   - line_meta.widths の形不一致による一様幅への劣化（点ごとのテーパーが消える）
   *   - schema_version が現行より新しい（未知フィールドが消える可能性）
   *
   * 【lossy に含めないもの】= 値の微修正であってレコードは残るもの
   *   座標クランプ／画像寸法の丸め・上限／局所幅と代表幅の上限クランプ／
   *   class_id・status の既定値補正／id の採番・振り直し／schema_version 欠損。
   *   これらを含めると警告が常態化して、本当に危険なケースが埋もれるため意図的に除外している。
   */
  lossy: boolean;
}

/**
 * 警告の収集先。lossy() は「再保存で情報が失われる」警告専用
 * （判断基準は SidecarParseResult.lossy の doc を参照）。
 */
interface WarnCtx {
  warn: (m: string) => void;
  lossy: (m: string) => void;
}

/** 点列を検証して返す。非有限値・形不正が1つでもあれば null（レコードごと捨てる） */
function parsePoints(v: unknown): Pt[] | null {
  if (!Array.isArray(v)) return null;
  const out: Pt[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = asNum(p[0]);
    const y = asNum(p[1]);
    if (x === null || y === null) return null;
    out.push([x, y]);
  }
  return out;
}

function clampPt(p: Pt, w: number, h: number): Pt {
  return [w > 0 ? clampNum(p[0], 0, w) : p[0], h > 0 ? clampNum(p[1], 0, h) : p[1]];
}

/**
 * 画像寸法を「1..MAX_IMAGE_DIM の整数」に正規化する。0 = 不明（クランプを行わない）。
 * 巨大値・小数をそのまま通すと、座標クランプの基準とマスク生成のバッファ確保が壊れるため、
 * ここで必ず整数化・上限クランプする。範囲外でも annotations は読めるだけ読む（全損させない）。
 */
function parseDimension(v: unknown, label: string, warn: (m: string) => void): number {
  const n = asNum(v);
  if (n === null || n <= 0) return 0; // 不明扱い（呼び出し側が fallback を使う）
  if (n > MAX_IMAGE_DIM) {
    warn(`image.${label} ${n} が上限 ${MAX_IMAGE_DIM} を超えるため ${MAX_IMAGE_DIM} にしました`);
    return MAX_IMAGE_DIM;
  }
  const i = Math.floor(n);
  if (i !== n) warn(`image.${label} ${n} は整数でないため ${i} に丸めました`);
  return i;
}

/**
 * line_meta を検証して LineMeta を返す。復元不能なら null（呼び出し側が polygon へ降格）。
 * branches / widths の対応は index を保ったままフィルタする（参照実装 toPolygon と同じ方針）。
 */
function parseLineMeta(
  v: unknown,
  w: number,
  h: number,
  ctx: WarnCtx,
  label: string
): LineMeta | null {
  if (!isRecord(v)) return null;
  const width = asNum(v.width);
  if (width === null || width <= 0) return null;
  if (!Array.isArray(v.branches)) return null;

  const pairs: { br: Pt[]; i: number }[] = [];
  v.branches.forEach((raw, i) => {
    const br = parsePoints(raw);
    if (br && br.length >= 2) pairs.push({ br: br.map((p) => clampPt(p, w, h)), i });
  });
  if (pairs.length === 0) return null;

  const clamped = clampNum(width, LINE_WIDTH_MIN, LINE_WIDTH_MAX);
  if (clamped !== width) {
    // 値の補正であってメタ自体は残るので lossy ではない
    ctx.warn(`${label}: line_meta.width ${width} が範囲外のため ${clamped} に補正しました`);
  }
  const meta: LineMeta = { branches: pairs.map((p) => p.br), width: clamped };

  // 点ごと幅は「branches と形が一致し、全て有限の正数」のときだけ採用（不一致は一様幅に劣化）
  if (v.widths !== undefined && v.widths !== null) {
    let ok = Array.isArray(v.widths);
    let clampedAny = false;
    const widths: number[][] = [];
    if (ok) {
      const src = v.widths as unknown[];
      for (const { br, i } of pairs) {
        const ws = src[i];
        if (
          Array.isArray(ws) &&
          ws.length === br.length &&
          ws.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)
        ) {
          widths.push(
            (ws as number[]).map((x) => {
              if (x <= MAX_LOCAL_WIDTH) return x;
              clampedAny = true;
              return MAX_LOCAL_WIDTH;
            })
          );
        } else {
          ok = false;
          break;
        }
      }
    }
    if (ok && widths.length === pairs.length) {
      meta.widths = widths;
      if (clampedAny) {
        // 上限クランプは値の微修正なので lossy に含めない（仕様どおり）
        ctx.warn(
          `${label}: line_meta.widths に ${MAX_LOCAL_WIDTH}px を超える局所幅があったため丸めました`
        );
      }
    } else {
      // 点ごとのテーパー情報そのものが落ちるので lossy
      ctx.lossy(`${label}: line_meta.widths の形が branches と一致しないため一様幅にしました`);
    }
  }
  return meta;
}

/** id を差し替えた同一アノテーション（kind ごとに narrow してユニオンの spread を避ける） */
function withId(a: Annotation, id: string): Annotation {
  if (a.kind === 'bbox') return { ...a, id };
  if (a.kind === 'line') return { ...a, id };
  return { ...a, id };
}

/**
 * 1レコードを検証して内部型にする。復元不能なら null（そのレコードだけ捨てる）。
 * id はこの時点では生の値のまま（空文字なら欠損）。一意化は採用確定後に呼び出し側が行う。
 */
function parseAnnotation(
  raw: unknown,
  index: number,
  w: number,
  h: number,
  ctx: WarnCtx
): Annotation | null {
  const label = `annotations[${index}]`;
  // レコードを捨てる系は全て lossy（そのアノテーションが消える）
  if (!isRecord(raw)) {
    ctx.lossy(`${label}: オブジェクトではないため読み飛ばしました`);
    return null;
  }

  const kind = asStr(raw.kind);
  if (kind !== 'bbox' && kind !== 'polygon' && kind !== 'line') {
    ctx.lossy(`${label}: 未知の kind "${String(raw.kind)}" のため読み飛ばしました`);
    return null;
  }

  const id = asStr(raw.id);
  const classIdRaw = asNum(raw.class_id);
  let classId = 0;
  // class_id の補正は値の修正であってレコードは残るので lossy ではない
  if (classIdRaw === null) {
    ctx.warn(`${label}: class_id が不正なため 0 として読み込みました`);
  } else {
    classId = Math.max(Math.trunc(classIdRaw), 0);
    if (classId !== classIdRaw) {
      ctx.warn(`${label}: class_id ${classIdRaw} を ${classId} に補正しました`);
    }
  }
  const source: AnnotationSource = raw.source === 'imported' ? 'imported' : 'manual';
  const base = { id: id ?? '', classId, source };

  if (kind === 'bbox') {
    if (!isRecord(raw.box)) {
      ctx.lossy(`${label}: bbox の box がないため読み飛ばしました`);
      return null;
    }
    const x = asNum(raw.box.x);
    const y = asNum(raw.box.y);
    const bw = asNum(raw.box.w);
    const bh = asNum(raw.box.h);
    if (x === null || y === null || bw === null || bh === null) {
      ctx.lossy(`${label}: bbox の座標に非有限値があるため読み飛ばしました`);
      return null;
    }
    if (bw <= 0 || bh <= 0) {
      ctx.lossy(`${label}: サイズ 0 の bbox のため読み飛ばしました`);
      return null;
    }
    let box: BBox = { x, y, w: bw, h: bh };
    if (w > 0 && h > 0) box = clampBBoxToImage(box, w, h);
    if (box.w <= 0 || box.h <= 0) {
      ctx.lossy(`${label}: クランプ後にサイズ 0 になったため読み飛ばしました`);
      return null;
    }
    return { ...base, kind: 'bbox', box };
  }

  // polygon / line
  const rawPoints = raw.points === undefined || raw.points === null ? [] : parsePoints(raw.points);
  if (rawPoints === null) {
    ctx.lossy(`${label}: points に非有限値・形不正があるため読み飛ばしました`);
    return null;
  }
  const points = rawPoints.map((p) => clampPt(p, w, h));

  if (kind === 'line') {
    const meta = parseLineMeta(raw.line_meta, w, h, ctx, label);
    if (!meta) {
      if (points.length < 3) {
        ctx.lossy(`${label}: line_meta が不正で頂点も3点未満のため読み飛ばしました`);
        return null;
      }
      // 中心線メタが失われる（頂点は残るので UI 上は無事に見える＝特に気づきにくい）
      ctx.lossy(`${label}: line_meta が欠損/不正のため polygon に降格しました`);
      return { ...base, kind: 'polygon', points };
    }
    // 中心線が生きていれば、points が壊れていてもリボンを再生成して救う
    if (points.length < 3) {
      if (w <= 0 || h <= 0) {
        ctx.lossy(`${label}: points が3点未満で画像サイズ不明のため読み飛ばしました`);
        return null;
      }
      const regen = regenLinePolygon(meta, w, h);
      if (regen.length < 3) {
        ctx.lossy(`${label}: points が3点未満で line_meta からも再生成できないため読み飛ばしました`);
        return null;
      }
      // line_meta（真実）から完全に復元できたので情報は失われていない
      ctx.warn(`${label}: points が3点未満のため line_meta から再生成しました`);
      return { ...base, kind: 'line', points: regen, lineMeta: meta };
    }
    return { ...base, kind: 'line', points, lineMeta: meta };
  }

  if (points.length < 3) {
    ctx.lossy(`${label}: polygon の頂点が3点未満のため読み飛ばしました`);
    return null;
  }
  return { ...base, kind: 'polygon', points };
}

/**
 * サイドカー JSON（unknown）→ 内部アノテーション。壊れた入力でも例外を投げない。
 * 戻り値の width/height はクランプ基準に使った画像サイズ（0 = 不明）。
 */
export function sidecarToAnnotations(
  json: unknown,
  opts: SidecarParseOptions = {}
): SidecarParseResult {
  const warnings: string[] = [];
  let lossy = false;
  const warn = (m: string): void => {
    warnings.push(m);
  };
  const ctx: WarnCtx = {
    warn,
    lossy: (m: string): void => {
      warnings.push(m);
      lossy = true;
    },
  };

  const fbW = parseDimension(opts.fallbackWidth, 'width(fallback)', warn);
  const fbH = parseDimension(opts.fallbackHeight, 'height(fallback)', warn);

  if (!isRecord(json)) {
    // ファイルまるごと読めない = 中身が全部消える
    ctx.lossy('サイドカーが JSON オブジェクトではないため空として読み込みました');
    return { annotations: [], status: 'pending', width: fbW, height: fbH, warnings, lossy };
  }

  const ver = asNum(json.schema_version);
  if (ver === null) {
    warn('schema_version がないため v1 として読み込みました');
  } else if (ver > SIDECAR_SCHEMA_VERSION) {
    // 未知フィールドを保持できないので、上書き保存すると消える
    ctx.lossy(
      `schema_version ${ver} はこのアプリ（v${SIDECAR_SCHEMA_VERSION}）より新しいため、` +
        '読める範囲だけ読み込みました。保存すると新しい情報が失われる可能性があります'
    );
  }

  const image = isRecord(json.image) ? json.image : null;
  const imgW = parseDimension(image?.width, 'width', warn) || fbW;
  const imgH = parseDimension(image?.height, 'height', warn) || fbH;
  if (imgW <= 0 || imgH <= 0) {
    warn('画像サイズが不明なため座標クランプを省略しました');
  }

  const statusRaw = asStr(json.status);
  let status: AnnotationStatus = 'pending';
  if (statusRaw !== null && (STATUSES as string[]).includes(statusRaw)) {
    status = statusRaw as AnnotationStatus;
  } else if (json.status !== undefined) {
    warn(`status "${String(json.status)}" が不正なため pending として読み込みました`);
  }

  const annotations: Annotation[] = [];
  if (json.annotations === undefined || json.annotations === null) {
    // アノテーション 0 件（負例候補）は正常系。警告しない
  } else if (!Array.isArray(json.annotations)) {
    // 記録されていた注釈が全部読めない
    ctx.lossy('annotations が配列ではないため 0 件として読み込みました');
  } else {
    // id は欠損なら採番・重複なら振り直す（selectedId や履歴が壊れるため一意性は必須）。
    // 登録は「レコードの採用が確定してから」行う。検証前に登録すると、捨てられるレコードが
    // id を消費して、後続の正常なレコードが不要に採番し直されてしまう。
    const seen = new Set<string>();
    const resolveId = (rawId: string, label: string): string => {
      let id = rawId;
      if (id.length === 0) {
        id = newId();
      } else if (seen.has(id)) {
        warn(`${label}: id が重複しているため採番し直しました`);
        id = newId();
      }
      while (seen.has(id)) id = newId();
      seen.add(id);
      return id;
    };
    json.annotations.forEach((raw, i) => {
      const a = parseAnnotation(raw, i, imgW, imgH, ctx);
      if (!a) return; // 捨てたレコードは id を消費しない
      const id = resolveId(a.id, `annotations[${i}]`);
      annotations.push(a.id === id ? a : withId(a, id));
    });
  }

  return { annotations, status, width: imgW, height: imgH, warnings, lossy };
}

// ---------------------------------------------------------------------------
// project.json
// ---------------------------------------------------------------------------

export interface ProjectParseResult {
  project: Project;
  /** 人間向けの警告文（UI トースト・ログ用）。空なら完全に正常 */
  warnings: string[];
  /**
   * 「このまま再保存すると、元の project.json にあった情報が失われる」warning が1件以上あったか。
   * SidecarParseResult.lossy と同じ基準（消えるものは true / 値の微修正は false）。
   *
   * 【lossy = true】
   *   - クラス id の振り直し・再割り当て（学習 ID が変わり、既存サイドカーの class_id の
   *     指すクラスがずれる。DESIGN §2 が警告必須としているケース）
   *   - クラス定義が復元できず既定クラスで代替（json 自体が読めない場合を含む）
   *   - schema_version が現行より新しい（未知フィールドが消える可能性）
   *
   * 【lossy = false】
   *   schema_version 欠損／name・created_at・updated_at の補完／クラスの name・color の補完／
   *   settings の既定値・クランプ。いずれも既存アノテーションの意味を変えない。
   */
  lossy: boolean;
}

/** 既定プロジェクト（単一クラス crack / ひび割れ・マグネットライン既定 ON） */
export function createDefaultProject(name: string): Project {
  const now = nowIso();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: name.length > 0 ? name : DEFAULT_PROJECT_NAME,
    classes: [{ id: 0, name: 'crack', nameJa: 'ひび割れ', color: DEFAULT_CLASS_COLORS[0] }],
    settings: {
      defaultTool: 'line',
      magnet: { enabled: true, invert: false },
      lineWidthDefault: DEFAULT_LINE_WIDTH,
      showDerivedBoxes: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Project → project.json（snake_case）。純変換（updated_at は呼び出し側が更新する）。
 * schema_version は常に現行版を書く（このアプリが書くのは現行フォーマットのため）。
 */
export function projectToJson(project: Project): ProjectFileJson {
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    app: 'genba-anno',
    name: project.name,
    classes: project.classes.map((c) => ({
      id: c.id,
      name: c.name,
      name_ja: c.nameJa,
      color: c.color,
    })),
    settings: {
      default_tool: project.settings.defaultTool,
      magnet: {
        enabled: project.settings.magnet.enabled,
        invert: project.settings.magnet.invert,
      },
      line_width_default: project.settings.lineWidthDefault,
      show_derived_boxes: project.settings.showDerivedBoxes,
    },
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

/** '#RGB' は '#RRGGBB' に展開。'#RRGGBB' はそのまま（大文字小文字は変えない）。不正は null */
function normalizeColor(v: unknown): string | null {
  const s = asStr(v);
  if (s === null) return null;
  if (HEX6.test(s)) return s;
  if (HEX3.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase();
  return null;
}

function parseClasses(raw: unknown, ctx: WarnCtx): ClassDef[] {
  if (!Array.isArray(raw)) {
    // クラス定義そのものが失われる
    ctx.lossy('classes が配列ではないため既定クラスを使いました');
    return createDefaultProject('').classes;
  }
  const used = new Set<number>();
  /** 未使用の最小の非負整数 id（学習 ID は詰めておきたいので max+1 ではなく最小空き） */
  const nextFreeId = (): number => {
    let i = 0;
    while (used.has(i)) i++;
    return i;
  };

  const out: ClassDef[] = [];
  raw.forEach((r, i) => {
    if (!isRecord(r)) {
      // クラス定義が1つ丸ごと消える
      ctx.lossy(`classes[${i}]: オブジェクトではないため読み飛ばしました`);
      return;
    }
    const idRaw = asNum(r.id);
    let id: number;
    // クラス id はエクスポートの学習 ID であり、全サイドカーの class_id が参照する外部キー。
    // 振り直すと既存アノテーションのラベル対応が変わるため lossy 扱いにする
    // （アノテーションの id は不透明な UUID で外部参照が無いので lossy にしない。この非対称は意図的）。
    if (idRaw === null || idRaw < 0 || !Number.isInteger(idRaw)) {
      id = nextFreeId();
      ctx.lossy(`classes[${i}]: id が不正なため ${id} を割り当てました（学習 ID が変わります）`);
    } else if (used.has(idRaw)) {
      id = nextFreeId();
      ctx.lossy(
        `classes[${i}]: id ${idRaw} が重複しているため ${id} に振り直しました（学習 ID が変わります）`
      );
    } else {
      id = idRaw;
    }
    used.add(id);

    // name / color は表示・ラベル名の補完であって既存アノテーションの意味は変わらない
    const nameRaw = asStr(r.name);
    const name = nameRaw && nameRaw.length > 0 ? nameRaw : `class${id}`;
    if (name !== nameRaw) ctx.warn(`classes[${i}]: name が不正なため "${name}" にしました`);
    const nameJaRaw = asStr(r.name_ja);
    const nameJa = nameJaRaw && nameJaRaw.length > 0 ? nameJaRaw : name;
    const color = normalizeColor(r.color);
    if (color === null) {
      ctx.warn(`classes[${i}]: color "${String(r.color)}" が #RRGGBB 形式でないため既定色にしました`);
    }
    out.push({
      id,
      name,
      nameJa,
      color: color ?? DEFAULT_CLASS_COLORS[out.length % DEFAULT_CLASS_COLORS.length],
    });
  });

  if (out.length === 0) {
    ctx.lossy('有効なクラスが1つも無いため既定クラスを使いました');
    return createDefaultProject('').classes;
  }
  return out;
}

function parseSettings(raw: unknown, warn: (m: string) => void): ProjectSettings {
  const def = createDefaultProject('').settings;
  if (!isRecord(raw)) {
    // 設定値の既定化は既存アノテーションの意味を変えないので lossy ではない
    if (raw !== undefined) warn('settings が不正なため既定値を使いました');
    return def;
  }
  const tool = asStr(raw.default_tool);
  let defaultTool = def.defaultTool;
  if (tool !== null && (DRAW_TOOLS as string[]).includes(tool)) {
    defaultTool = tool as DrawTool;
  } else if (raw.default_tool !== undefined) {
    warn(`settings.default_tool "${String(raw.default_tool)}" が不正なため ${def.defaultTool} にしました`);
  }

  const magnetRaw = isRecord(raw.magnet) ? raw.magnet : null;
  const magnet = {
    enabled: typeof magnetRaw?.enabled === 'boolean' ? magnetRaw.enabled : def.magnet.enabled,
    invert: typeof magnetRaw?.invert === 'boolean' ? magnetRaw.invert : def.magnet.invert,
  };

  const lwRaw = asNum(raw.line_width_default);
  let lineWidthDefault = def.lineWidthDefault;
  if (lwRaw !== null) {
    lineWidthDefault = clampNum(lwRaw, LINE_WIDTH_MIN, LINE_WIDTH_MAX);
    if (lineWidthDefault !== lwRaw) {
      warn(`settings.line_width_default ${lwRaw} が範囲外のため ${lineWidthDefault} に補正しました`);
    }
  } else if (raw.line_width_default !== undefined) {
    warn(`settings.line_width_default が不正なため ${def.lineWidthDefault} にしました`);
  }

  // 外接ボックス表示は後から追加したフィールド。**キーが無い既存 project.json は正常系**なので
  // 警告を出さずに既定（true）で補完する（v1 で書かれたファイルを開くたびに警告が出てしまうため）。
  // 値が入っているのに boolean でない場合だけ、他の設定と同じく既定値 + 警告にする。
  let showDerivedBoxes = def.showDerivedBoxes;
  if (typeof raw.show_derived_boxes === 'boolean') {
    showDerivedBoxes = raw.show_derived_boxes;
  } else if (raw.show_derived_boxes !== undefined) {
    warn(`settings.show_derived_boxes が不正なため ${def.showDerivedBoxes} にしました`);
  }

  return { defaultTool, magnet, lineWidthDefault, showDerivedBoxes };
}

/**
 * project.json（unknown）→ Project。壊れた入力でも例外を投げず、既定値で補完して返す。
 * クラス id の重複・color 形式不正は検出して修復する（学習 ID が変わる場合は警告に明記）。
 */
export function jsonToProject(
  json: unknown,
  fallbackName: string = DEFAULT_PROJECT_NAME
): ProjectParseResult {
  const warnings: string[] = [];
  let lossy = false;
  const warn = (m: string): void => {
    warnings.push(m);
  };
  const ctx: WarnCtx = {
    warn,
    lossy: (m: string): void => {
      warnings.push(m);
      lossy = true;
    },
  };

  if (!isRecord(json)) {
    // クラス定義ごと既定値で差し替わる
    ctx.lossy('project.json が JSON オブジェクトではないため既定設定を使いました');
    return { project: createDefaultProject(fallbackName), warnings, lossy };
  }

  const ver = asNum(json.schema_version);
  if (ver === null) {
    warn('schema_version がないため v1 として読み込みました');
  } else if (ver > PROJECT_SCHEMA_VERSION) {
    // 未知フィールドを保持できないので、上書き保存すると消える
    ctx.lossy(
      `schema_version ${ver} はこのアプリ（v${PROJECT_SCHEMA_VERSION}）より新しいため、` +
        '読める範囲だけ読み込みました'
    );
  }

  const nameRaw = asStr(json.name);
  const name = nameRaw && nameRaw.length > 0 ? nameRaw : fallbackName;
  const createdAt = asStr(json.created_at) ?? nowIso();
  const updatedAt = asStr(json.updated_at) ?? createdAt;

  return {
    project: {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name,
      classes: parseClasses(json.classes, ctx),
      settings: parseSettings(json.settings, warn),
      createdAt,
      updatedAt,
    },
    warnings,
    lossy,
  };
}
