// =============================================================================
// エクスポートダイアログ（M5）
//
// 進捗フェーズの表示順は **scan → images → labels → masks → done**。
// M6 申し送り: runner は画像を先に書く（画像コピーに失敗した画像のラベルが残ると
// 「存在しない画像を指すデータセット」になるため）。UI の順序もそれに合わせる。
//
// 完了後は必ず manifest の除外内訳を見せる。
// 「黙って消えたアノテーション／黙って負例になった画像」がデータセット事故の温床なので、
// 1 件でもあれば警告一覧を出す（corrupt_sidecars は赤の強警告）。
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, FolderOpen, Loader2 } from 'lucide-react';
import type { StorageAdapter } from '../../adapters/types';
import type { GenbaExportManifest } from '../../core/export';
import type {
  ClassDef,
  ExportFormat,
  ExportParams,
  ExportProgress,
  ExportScope,
  Project,
} from '../../core/types';
import { runExport } from '../../export/runner';
import { Modal } from './Modal';
import { Btn } from './ui';

const FORMAT_OPTIONS: { value: ExportFormat; label: string; desc: string }[] = [
  {
    value: 'yolo_det',
    label: 'YOLO 物体検出（yolo_det）',
    desc: 'images/{train,val}/ + labels/*.txt（class cx cy w h）+ data.yaml。矩形の検出モデル用。',
  },
  {
    value: 'yolo_seg',
    label: 'YOLO セグメンテーション（yolo_seg）',
    desc: 'images/{train,val}/ + labels/*.txt（class x1 y1 x2 y2 …）+ data.yaml。ひび割れの形を学習させる場合。',
  },
  {
    value: 'coco',
    label: 'COCO',
    desc: 'annotations/{train,val}.json + images/。bbox と segmentation の両方を出力します。',
  },
  {
    value: 'mask_png',
    label: '二値マスク PNG（mask_png）',
    desc: 'images/ + masks/*.png（0/255 の単チャネル）。マスクを直接使う学習コード向け。',
  },
];

const SCOPE_OPTIONS: { value: ExportScope; label: string; desc: string }[] = [
  { value: 'done', label: '完了のみ', desc: 'status=done の画像だけ。負例（0件の完了画像）も含みます。' },
  {
    value: 'all',
    label: '完了 + 作業中',
    desc: '作業中はアノテーションが1件以上ある画像のみ。未着手・スキップは常に除外されます。',
  },
];

const PHASES: { key: ExportProgress['phase']; label: string }[] = [
  { key: 'scan', label: 'サイドカー読込' },
  { key: 'images', label: '画像の書き出し' },
  { key: 'labels', label: 'ラベルの書き出し' },
  { key: 'masks', label: 'マスクの書き出し' },
  { key: 'done', label: '完了' },
];

type RunState = 'idle' | 'running' | 'done' | 'error';

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  adapter: StorageAdapter;
  projectDir: string;
  project: Project;
  classes: ClassDef[];
  onToast: (kind: 'info' | 'error', message: string) => void;
}

/** 長い一覧は先頭だけ見せる（全件は export_manifest.json に残っている） */
function preview(list: string[], limit = 8): string[] {
  if (list.length <= limit) return list;
  return [...list.slice(0, limit), `… ほか ${list.length - limit} 件（export_manifest.json 参照）`];
}

export function ExportDialog({
  open,
  onClose,
  adapter,
  projectDir,
  project,
  classes,
  onToast,
}: ExportDialogProps): React.ReactElement | null {
  const [format, setFormat] = useState<ExportFormat>('yolo_seg');
  const [scope, setScope] = useState<ExportScope>('done');
  const [valRatio, setValRatio] = useState(0.2);
  const [seed, setSeed] = useState(42);
  const [classFilter, setClassFilter] = useState<number[]>(() => classes.map((c) => c.id));
  const [includeDerivedBoxes, setIncludeDerivedBoxes] = useState(true);
  const [includeBBoxAsPolygon, setIncludeBBoxAsPolygon] = useState(false);

  const [state, setState] = useState<RunState>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [manifest, setManifest] = useState<GenbaExportManifest | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setState('idle');
      setProgress(null);
      setManifest(null);
      setDestDir(null);
      setError(null);
      setClassFilter(classes.map((c) => c.id));
    }
  }, [open, classes]);

  const classFilterEmpty = format === 'mask_png' && classFilter.length === 0;

  const params: ExportParams = useMemo(
    () => ({
      format,
      scope,
      valRatio,
      seed,
      ...(format === 'mask_png' ? { classFilter: [...classFilter].sort((a, b) => a - b) } : {}),
      includeDerivedBoxes,
      includeBBoxAsPolygon,
    }),
    [format, scope, valRatio, seed, classFilter, includeDerivedBoxes, includeBBoxAsPolygon]
  );

  const handleRun = async (): Promise<void> => {
    const dest = await adapter.pickDirectory('エクスポート先フォルダを選択');
    if (!dest) return;
    setState('running');
    setError(null);
    setManifest(null);
    setProgress({ phase: 'scan', current: 0, total: 0 });
    try {
      const result = await runExport(adapter, projectDir, dest, project, params, (p) =>
        setProgress(p)
      );
      setManifest(result.manifest as GenbaExportManifest);
      setDestDir(result.destDir);
      setState('done');
      onToast('info', 'エクスポートが完了しました');
    } catch (e) {
      // beginExport の拒否（出力先が画像フォルダ内・_anno 内など）もここに来る
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  };

  const warnings = useMemo(() => {
    if (!manifest) return null;
    const ex = manifest.excluded;
    const extra = manifest.excluded_extra;
    const groups: { kind: 'error' | 'warning'; title: string; items: string[] }[] = [];

    if (extra.corrupt_sidecars.length > 0) {
      groups.push({
        kind: 'error',
        title: `読み込めなかったアノテーションファイル ${extra.corrupt_sidecars.length} 件（この画像は出力されていません）`,
        items: preview(extra.corrupt_sidecars),
      });
    }
    if (extra.invalid_dimensions.length > 0) {
      groups.push({
        kind: 'error',
        title: `画像サイズが不正で出力できなかった画像 ${extra.invalid_dimensions.length} 件`,
        items: preview(extra.invalid_dimensions),
      });
    }
    if (extra.unknown_class_annotations.length > 0) {
      groups.push({
        kind: 'warning',
        title: `クラス定義に無い class_id を持つアノテーション ${extra.unknown_class_annotations.length} 件（除外）`,
        items: preview(
          extra.unknown_class_annotations.map((u) => `${u.file} (class_id: ${u.class_id})`)
        ),
      });
    }
    if (ex.tiny_polygons.length > 0) {
      groups.push({
        kind: 'warning',
        title: `面積が小さすぎて除外したアノテーション ${ex.tiny_polygons.length} 件（${extra.min_annotation_area_px2}px² 未満）`,
        items: preview(ex.tiny_polygons.map((t) => `${t.file} (面積 ${t.area.toFixed(2)}px²)`)),
      });
    }
    if (ex.skipped_all_polygons_too_small.length > 0) {
      groups.push({
        kind: 'warning',
        title: `全アノテーションが小さすぎたためスキップした画像 ${ex.skipped_all_polygons_too_small.length} 件（誤って負例にしないため）`,
        items: preview(ex.skipped_all_polygons_too_small),
      });
    }
    if (ex.missing_files.length > 0) {
      groups.push({
        kind: 'error',
        title: `画像ファイルを書き出せなかった画像 ${ex.missing_files.length} 件`,
        items: preview(ex.missing_files),
      });
    }
    if (ex.name_collisions.length > 0) {
      groups.push({
        kind: 'warning',
        title: `出力ファイル名が衝突したためスキップした画像 ${ex.name_collisions.length} 件`,
        items: preview(ex.name_collisions),
      });
    }
    if (extra.skipped_in_progress_without_annotations.length > 0) {
      groups.push({
        kind: 'warning',
        title: `対象が 0 件になった作業中の画像 ${extra.skipped_in_progress_without_annotations.length} 件（負例にしないためスキップ）`,
        items: preview(extra.skipped_in_progress_without_annotations),
      });
    }
    if (extra.skipped_no_annotations_for_format.length > 0) {
      groups.push({
        kind: 'warning',
        title: `このフォーマットの対象アノテーションが無い画像 ${extra.skipped_no_annotations_for_format.length} 件（スキップ）`,
        items: preview(extra.skipped_no_annotations_for_format),
      });
    }
    if (extra.sidecar_warnings.length > 0) {
      groups.push({
        kind: 'warning',
        title: `読み込み時に修復されたアノテーションファイル ${extra.sidecar_warnings.length} 件`,
        items: preview(extra.sidecar_warnings.map((w) => `${w.file}: ${w.warnings[0] ?? ''}`)),
      });
    }
    return groups;
  }, [manifest]);

  const remapped =
    manifest !== null && manifest.class_id_map.some((m) => m.source_id !== m.export_id);

  const running = state === 'running';
  const phaseIndex = progress ? PHASES.findIndex((p) => p.key === progress.phase) : -1;

  return (
    <Modal
      open={open}
      title="エクスポート"
      onClose={onClose}
      size="wide"
      icon={<Download size={18} aria-hidden="true" />}
      closeDisabled={running}
      footer={
        state === 'done' ? (
          <>
            {destDir && (
              <Btn onClick={() => void adapter.revealInFolder(destDir)}>
                <FolderOpen size={15} aria-hidden="true" />
                出力フォルダを開く
              </Btn>
            )}
            <Btn className="ga-btn--primary" onClick={onClose}>
              閉じる
            </Btn>
          </>
        ) : (
          <>
            <Btn onClick={onClose} disabled={running}>
              キャンセル
            </Btn>
            <Btn
              className="ga-btn--primary"
              onClick={() => void handleRun()}
              disabled={running || classFilterEmpty}
            >
              {running ? (
                <>
                  <Loader2 size={15} aria-hidden="true" className="ga-spin" />
                  実行中…
                </>
              ) : (
                <>
                  <Download size={15} aria-hidden="true" />
                  出力先を選んで実行
                </>
              )}
            </Btn>
          </>
        )
      }
    >
      {state === 'idle' || state === 'error' ? (
        <>
          {error && (
            <div className="ga-banner ga-banner--error" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <span className="ga-banner__body">
                <span className="ga-banner__title">エクスポートに失敗しました</span>
                <br />
                {error}
              </span>
            </div>
          )}

          <fieldset className="ga-field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="ga-field__label">フォーマット</legend>
            <div className="ga-radio-list">
              {FORMAT_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={format === opt.value ? 'ga-choice ga-choice--on' : 'ga-choice'}
                >
                  <input
                    type="radio"
                    name="ga-export-format"
                    checked={format === opt.value}
                    onChange={() => setFormat(opt.value)}
                  />
                  <span>
                    <span className="ga-choice__label">{opt.label}</span>
                    <span className="ga-choice__desc">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {format === 'yolo_det' && (
            <label className="ga-checkline">
              <input
                type="checkbox"
                checked={includeDerivedBoxes}
                onChange={(e) => setIncludeDerivedBoxes(e.target.checked)}
              />
              ポリゴン・ラインから外接矩形を含める（既定 ON）
            </label>
          )}
          {format === 'yolo_seg' && (
            <label className="ga-checkline">
              <input
                type="checkbox"
                checked={includeBBoxAsPolygon}
                onChange={(e) => setIncludeBBoxAsPolygon(e.target.checked)}
              />
              バウンディングボックスを矩形ポリゴンとして含める（既定 OFF）
            </label>
          )}
          {format === 'mask_png' && (
            <fieldset className="ga-field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="ga-field__label">マスクに含めるクラス</legend>
              <div className="ga-row">
                {classes.map((c) => (
                  <label key={c.id} className="ga-checkline">
                    <input
                      type="checkbox"
                      checked={classFilter.includes(c.id)}
                      onChange={(e) =>
                        setClassFilter((prev) =>
                          e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)
                        )
                      }
                    />
                    <span
                      className="ga-swatch"
                      aria-hidden="true"
                      style={{ backgroundColor: c.color }}
                    />
                    {c.nameJa}
                  </label>
                ))}
              </div>
              {classFilterEmpty && (
                <p className="ga-field__hint" role="status">
                  クラスを1つ以上選んでください。
                </p>
              )}
            </fieldset>
          )}

          <fieldset className="ga-field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="ga-field__label">対象範囲</legend>
            <div className="ga-radio-list">
              {SCOPE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={scope === opt.value ? 'ga-choice ga-choice--on' : 'ga-choice'}
                >
                  <input
                    type="radio"
                    name="ga-export-scope"
                    checked={scope === opt.value}
                    onChange={() => setScope(opt.value)}
                  />
                  <span>
                    <span className="ga-choice__label">{opt.label}</span>
                    <span className="ga-choice__desc">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ga-grid2">
            <div className="ga-field">
              <label className="ga-field__label" htmlFor="ga-valratio">
                検証データ比率（val）: {valRatio.toFixed(2)}
              </label>
              <input
                id="ga-valratio"
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={valRatio}
                onChange={(e) => setValRatio(Number(e.target.value))}
              />
              <span className="ga-field__hint">
                ファイル名のハッシュで画像単位に振り分けます（画像を追加しても既存の割当は変わりません）。
              </span>
            </div>
            <div className="ga-field">
              <label className="ga-field__label" htmlFor="ga-seed">
                分割シード
              </label>
              <input
                id="ga-seed"
                className="ga-input"
                type="number"
                value={seed}
                onChange={(e) => setSeed(Math.floor(Number(e.target.value) || 0))}
              />
              <span className="ga-field__hint">同じシードなら毎回同じ train/val になります。</span>
            </div>
          </div>
        </>
      ) : null}

      {(running || state === 'done') && (
        <div className="ga-field">
          <span className="ga-field__label">進捗</span>
          {PHASES.map((p, i) => {
            const active = phaseIndex === i;
            const done = phaseIndex > i || state === 'done';
            return (
              <div className="ga-phase" key={p.key}>
                <span
                  className={
                    done
                      ? 'ga-phase__dot ga-phase__dot--done'
                      : active
                        ? 'ga-phase__dot ga-phase__dot--active'
                        : 'ga-phase__dot'
                  }
                  aria-hidden="true"
                />
                <span>{p.label}</span>
                {active && progress ? (
                  <span className="ga-slider__value">
                    {progress.current}/{progress.total}
                  </span>
                ) : null}
              </div>
            );
          })}
          {running && progress?.file ? <p className="ga-note">{progress.file}</p> : null}
        </div>
      )}

      {state === 'done' && manifest && (
        <>
          <div className="ga-banner ga-banner--info" role="status">
            <span className="ga-banner__body">
              <span className="ga-banner__title">エクスポートが完了しました</span>
              <br />
              {destDir}
            </span>
          </div>

          <dl className="ga-summary">
            <dt>学習用（train）</dt>
            <dd>{manifest.counts.images_train} 枚</dd>
            <dt>検証用（val）</dt>
            <dd>{manifest.counts.images_val} 枚</dd>
            <dt>負例（アノテーション 0 件の完了画像）</dt>
            <dd>{manifest.counts.negatives} 枚</dd>
            <dt>アノテーション</dt>
            <dd>{manifest.counts.annotations_exported} 件</dd>
            <dt>クラス</dt>
            <dd>{manifest.classes.map((c) => c.name).join(', ')}</dd>
          </dl>

          {remapped && (
            <div className="ga-field">
              <span className="ga-field__label">クラス ID の対応表（歯抜けを詰めました）</span>
              <span className="ga-field__hint">
                プロジェクトのクラス ID が連番でないため、学習 ID は 0 から詰め直されています。
                推論結果を元のクラスに戻すときはこの対応を使ってください（export_manifest.json
                の class_id_map にも記録済み）。
              </span>
              <pre className="ga-code">
                {manifest.class_id_map
                  .map((m) => `クラスID ${m.source_id} → 学習ID ${m.export_id}  (${m.name})`)
                  .join('\n')}
              </pre>
            </div>
          )}

          {warnings && warnings.length > 0
            ? warnings.map((g) => (
                <div
                  key={g.title}
                  className={g.kind === 'error' ? 'ga-banner ga-banner--error' : 'ga-banner'}
                  role={g.kind === 'error' ? 'alert' : 'status'}
                >
                  <AlertTriangle size={18} aria-hidden="true" />
                  <span className="ga-banner__body">
                    <span className="ga-banner__title">{g.title}</span>
                    <ul className="ga-banner__list">
                      {g.items.map((it) => (
                        <li key={it}>{it}</li>
                      ))}
                    </ul>
                  </span>
                </div>
              ))
            : null}
        </>
      )}
    </Modal>
  );
}
