// =============================================================================
// DevCanvasHarness — AnnotationCanvas（M4）の開発検証ページ。
//
// `npm run dev:web` → http://localhost:5199/?harness=canvas で開く。
// mockAdapter でプロジェクトを開き、1枚目の画像に対して useAnnotationEditor +
// AnnotationCanvas を組み、最小限のコントロールとページ側ショートカットを載せてある。
//
// ここで実装しているキーボード処理は **M5（AnnotationPage）の先行検証** を兼ねる。
// 本番のページ実装ではトースト・自動保存・画像切替などを足したうえで同じ意味論にすること。
// このファイルは開発検証専用（配布 UI からは参照されない）。
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnnotationCanvas, type LineEditAction } from '../components/AnnotationCanvas';
import { getAdapter } from '../adapters';
import { annotationsToSidecar, sidecarToAnnotations } from '../core/serialize';
import { useAnnotationEditor } from '../store/useAnnotationEditor';
import type { ClassDef, DrawTool } from '../core/types';
import { DEFAULT_CLASS_COLORS, LINE_WIDTH_MAX, LINE_WIDTH_MIN } from '../core/types';

/** 検証用の 2 クラス（クラス切替 1/2 の確認用） */
const CLASSES: ClassDef[] = [
  { id: 0, name: 'crack', nameJa: 'ひび割れ', color: DEFAULT_CLASS_COLORS[0] },
  { id: 1, name: 'patch', nameJa: '補修跡', color: DEFAULT_CLASS_COLORS[1] },
];

const LINE_WIDTH_STEP = 2;

/** フォーム入力中か（contenteditable 含む。DESIGN §6 罠#11） */
function isFormTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  return el.isContentEditable === true;
}

/** IME 変換中のキーイベントか（変換確定の Enter/Backspace を拾わない） */
function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/** クリック後に blur するボタン（DESIGN §6 罠#7: Space パンでボタン再発火を防ぐ） */
function Btn({
  onClick,
  active,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      style={active ? { ...styles.btn, ...styles.btnActive } : styles.btn}
      onClick={(e) => {
        onClick();
        e.currentTarget.blur();
      }}
    >
      {children}
    </button>
  );
}

export function DevCanvasHarness(): React.ReactElement {
  const adapter = useMemo(() => getAdapter(), []);
  const editor = useAnnotationEditor({ drawTool: 'line', lineWidth: 12, mode: 'edit' });
  const magnetSegRef = useRef<number[]>([]);

  const [dir, setDir] = useState('');
  const [images, setImages] = useState<string[]>([]); // フォルダ内の画像ファイル名
  const [index, setIndex] = useState(0);
  const [file, setFile] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [magnetMode, setMagnetMode] = useState(true);
  const [magnetInvert, setMagnetInvert] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [lineEditAction, setLineEditAction] = useState<LineEditAction>('none');
  const [message, setMessage] = useState('読み込み中…');

  // ---- mock プロジェクトを開いて画像一覧を得る ----
  useEffect(() => {
    let alive = true;
    void (async () => {
      const picked = await adapter.pickImageDirectory();
      if (!picked) return;
      const opened = await adapter.openProject(picked);
      if (!alive || opened.images.length === 0) return;
      setDir(opened.dir);
      setImages(opened.images.map((e) => e.file));
    })();
    return () => {
      alive = false;
    };
  }, [adapter]);

  // ---- 現在の画像を読み込む（naturalWidth/Height を取ってから canvas に渡す） ----
  useEffect(() => {
    if (!dir || images.length === 0) return;
    const target = images[index % images.length];
    const url = adapter.imageUrl(dir, target);
    let alive = true;
    const probe = new Image();
    probe.onload = () => {
      if (!alive) return;
      setFile(target);
      setImageUrl(url);
      setImgSize({ w: probe.naturalWidth, h: probe.naturalHeight });
      setMessage(`${target}（${probe.naturalWidth}×${probe.naturalHeight}）`);
    };
    probe.onerror = () => {
      if (alive) setMessage('画像の読み込みに失敗しました');
    };
    probe.src = url;
    return () => {
      alive = false;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [adapter, dir, images, index]);

  // ---- 画像が確定したらサイドカーを読んで load（M5 も同じ流れになる） ----
  const dispatch = editor.dispatch; // useReducer 由来で不変。effect の依存を安定させる
  useEffect(() => {
    if (!dir || !file || !imgSize) return;
    let alive = true;
    void (async () => {
      const raw = await adapter.loadSidecar(dir, file);
      if (!alive) return;
      const parsed = raw
        ? sidecarToAnnotations(raw, { fallbackWidth: imgSize.w, fallbackHeight: imgSize.h })
        : null;
      dispatch({
        type: 'load',
        annotations: parsed?.annotations ?? [],
        imageWidth: imgSize.w,
        imageHeight: imgSize.h,
      });
      magnetSegRef.current = [];
    })();
    return () => {
      alive = false;
    };
  }, [adapter, dir, file, imgSize, dispatch]);

  // E2E 検証用に現在の状態を公開する（開発ハーネス専用）
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__gaCanvasHarness = {
      state: editor.state,
      dispatch: editor.dispatch, // E2E から任意アクションを流し込むため（未知 class_id の検証等）
      imageUrl,
      file,
      // E2E から「ドラッグ中に画像を切り替える」を再現するためのフック
      nextImage: () => setIndex((i) => i + 1),
      magnetMode,
      magnetInvert,
      lineEditAction,
      magnetSegs: magnetSegRef.current,
    };
  }, [editor.state, editor.dispatch, imageUrl, file, magnetMode, magnetInvert, lineEditAction]);

  const st = editor.state;
  const selected = st.selectedId ? st.annotations.find((a) => a.id === st.selectedId) : undefined;
  const selectedLine = selected && selected.kind === 'line' ? selected : undefined;

  const setTool = useCallback(
    (tool: DrawTool) => {
      editor.dispatch({ type: 'setDrawTool', tool });
      setLineEditAction('none');
    },
    [editor]
  );

  const resizeSelectedLineByStep = useCallback(
    (delta: number) => {
      if (!selectedLine) return;
      // resizeLine は履歴を積まないので gesture で囲む（M2 申し送り）
      editor.dispatch({ type: 'beginGesture' });
      editor.dispatch({
        type: 'resizeLine',
        id: selectedLine.id,
        width: Math.min(Math.max(selectedLine.lineMeta.width + delta, LINE_WIDTH_MIN), LINE_WIDTH_MAX),
      });
      editor.dispatch({ type: 'endGesture' });
    },
    [editor, selectedLine]
  );

  // ---- 保存 → 再読込（サイドカー往復の復元検証） ----
  const save = useCallback(async () => {
    if (!imgSize || !dir || !file) return;
    const sidecar = annotationsToSidecar(
      st.annotations,
      { file, width: imgSize.w, height: imgSize.h },
      st.annotations.length > 0 ? 'in_progress' : 'pending'
    );
    await adapter.saveSidecar(dir, file, sidecar);
    editor.dispatch({ type: 'markSaved' });
    setMessage(`保存しました（${sidecar.annotations.length} 件）`);
  }, [adapter, dir, file, imgSize, st.annotations, editor]);

  const reload = useCallback(async () => {
    if (!imgSize || !dir || !file) return;
    const raw = await adapter.loadSidecar(dir, file);
    const parsed = sidecarToAnnotations(raw, {
      fallbackWidth: imgSize.w,
      fallbackHeight: imgSize.h,
    });
    editor.dispatch({
      type: 'load',
      annotations: parsed.annotations,
      imageWidth: imgSize.w,
      imageHeight: imgSize.h,
    });
    magnetSegRef.current = [];
    setMessage(
      `再読込しました（${parsed.annotations.length} 件${
        parsed.warnings.length > 0 ? ` / 警告 ${parsed.warnings.length}` : ''
      }）`
    );
  }, [adapter, dir, file, imgSize, editor]);

  // ---- ページ側ショートカット（M5 の先行検証・最小限） ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isImeComposing(e)) return; // IME 変換中は無視（M5 でも同じガードを入れること）
      if (isFormTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod) {
        const k = e.key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          editor.dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
        } else if (k === 's') {
          e.preventDefault();
          void save();
        }
        return;
      }
      if (e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault(); // ページスクロール抑止（パンは canvas 側が拾う）
        return;
      }
      switch (e.key) {
        case '1':
        case '2': {
          const cls = CLASSES[Number(e.key) - 1];
          if (cls) editor.dispatch({ type: 'setActiveClass', classId: cls.id });
          return;
        }
        case 'r':
        case 'R':
          setTool('bbox');
          return;
        case 'w':
        case 'W':
        case 'n':
        case 'N':
          setTool('polygon');
          return;
        case 'l':
        case 'L':
          setTool('line');
          return;
        case 'v':
        case 'V':
          editor.dispatch({ type: 'setMode', mode: 'edit' });
          setLineEditAction('none');
          return;
        case 'm':
        case 'M':
          setMagnetMode((v) => !v);
          return;
        case 'i':
        case 'I':
          setMagnetInvert((v) => !v);
          return;
        case 'f':
        case 'F':
          setFitSignal((s) => s + 1);
          return;
        case 't':
        case 'T':
          editor.dispatch({ type: 'toggleFill' });
          return;
        case 'c':
        case 'C':
          if (selectedLine) setLineEditAction((a) => (a === 'cut' ? 'none' : 'cut'));
          return;
        case 'b':
        case 'B':
          if (selectedLine) setLineEditAction((a) => (a === 'branch' ? 'none' : 'branch'));
          return;
        case '[':
          if (selectedLine) resizeSelectedLineByStep(-LINE_WIDTH_STEP);
          else if (st.drawTool === 'line') {
            editor.dispatch({ type: 'setLineWidth', width: st.lineWidth - LINE_WIDTH_STEP });
          }
          return;
        case ']':
          if (selectedLine) resizeSelectedLineByStep(LINE_WIDTH_STEP);
          else if (st.drawTool === 'line') {
            editor.dispatch({ type: 'setLineWidth', width: st.lineWidth + LINE_WIDTH_STEP });
          }
          return;
        case 'Enter':
          if (editor.canCommitDraft) editor.dispatch({ type: 'commitDraft' });
          return;
        case 'Escape':
          if (lineEditAction !== 'none') setLineEditAction('none');
          else if (st.draft) editor.dispatch({ type: 'cancelDraft' });
          else if (st.selectedId) editor.dispatch({ type: 'select', id: null });
          else editor.dispatch({ type: 'setMode', mode: 'edit' });
          return;
        case 'Backspace': {
          // 点単位巻き戻し（参照実装 AnnotationPage.tsx:574-601 と同一ロジック）
          e.preventDefault();
          if (st.draft && st.draft.points.length > 0) {
            const segs = magnetSegRef.current;
            const dlen = st.draft.points.length;
            if (st.drawTool === 'line' && segs.length > 0) {
              const boundary = segs[segs.length - 1];
              if (boundary < dlen) {
                for (let i = 0; i < dlen - boundary; i++) {
                  editor.dispatch({ type: 'popDraftPoint' });
                }
                segs.pop();
                return;
              }
              segs.pop(); // 陳腐化した境界は捨てて通常 pop へ
            }
            editor.dispatch({ type: 'popDraftPoint' });
          } else if (st.selectedId && selected) {
            if (selected.kind === 'line') {
              editor.dispatch({ type: 'popLinePoint', id: selected.id });
            } else if (selected.kind === 'polygon' && selected.points.length > 3) {
              editor.dispatch({
                type: 'deleteVertex',
                id: selected.id,
                index: selected.points.length - 1,
              });
            }
          }
          return;
        }
        case 'Delete':
          if (st.selectedId) {
            editor.dispatch({ type: 'deleteAnnotation', id: st.selectedId });
            setMessage('アノテーションを削除しました（Ctrl+Z で元に戻せます）');
          }
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, lineEditAction, resizeSelectedLineByStep, save, selected, selectedLine, setTool, st]);

  const counts = st.annotations.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={styles.page}>
      <div style={styles.bar}>
        <span style={styles.groupLabel}>ツール</span>
        <Btn active={st.mode === 'edit'} onClick={() => editor.dispatch({ type: 'setMode', mode: 'edit' })}>
          V 編集
        </Btn>
        <Btn active={st.mode === 'draw' && st.drawTool === 'bbox'} onClick={() => setTool('bbox')}>
          R 矩形
        </Btn>
        <Btn active={st.mode === 'draw' && st.drawTool === 'polygon'} onClick={() => setTool('polygon')}>
          W 多角形
        </Btn>
        <Btn active={st.mode === 'draw' && st.drawTool === 'line'} onClick={() => setTool('line')}>
          L ライン
        </Btn>
        <span style={styles.sep} />
        <Btn active={magnetMode} onClick={() => setMagnetMode((v) => !v)}>
          M マグネット {magnetMode ? 'ON' : 'OFF'}
        </Btn>
        <Btn active={magnetInvert} onClick={() => setMagnetInvert((v) => !v)}>
          I 反転 {magnetInvert ? 'ON' : 'OFF'}
        </Btn>
        <span style={styles.sep} />
        <Btn active={st.activeClassId === 0} onClick={() => editor.dispatch({ type: 'setActiveClass', classId: 0 })}>
          1 ひび割れ
        </Btn>
        <Btn active={st.activeClassId === 1} onClick={() => editor.dispatch({ type: 'setActiveClass', classId: 1 })}>
          2 補修跡
        </Btn>
        <span style={styles.sep} />
        <Btn onClick={() => editor.dispatch({ type: 'undo' })}>元に戻す</Btn>
        <Btn onClick={() => editor.dispatch({ type: 'redo' })}>やり直す</Btn>
        <Btn onClick={() => setFitSignal((s) => s + 1)}>F フィット</Btn>
        <Btn active={st.fillVisible} onClick={() => editor.dispatch({ type: 'toggleFill' })}>
          T 塗り
        </Btn>
        <span style={styles.sep} />
        <Btn onClick={() => void save()}>保存</Btn>
        <Btn onClick={() => void reload()}>再読込</Btn>
        <Btn onClick={() => setIndex((i) => i + 1)}>次の画像</Btn>
      </div>

      <div style={styles.bar}>
        <span style={styles.groupLabel}>明るさ</span>
        <input
          type="range"
          min={50}
          max={200}
          value={brightness}
          onChange={(e) => setBrightness(Number(e.target.value))}
        />
        <span style={styles.groupLabel}>コントラスト</span>
        <input
          type="range"
          min={50}
          max={200}
          value={contrast}
          onChange={(e) => setContrast(Number(e.target.value))}
        />
        <span style={styles.status} id="ga-harness-status">
          mode={st.mode} tool={st.drawTool} 件数={st.annotations.length}
          {' ('}bbox={counts.bbox ?? 0} poly={counts.polygon ?? 0} line={counts.line ?? 0}
          {') '}
          draft={st.draft ? st.draft.points.length : '-'} 選択={selected ? selected.kind : '-'} 幅=
          {st.lineWidth} dirty={String(st.dirty)} undo={String(editor.canUndo)} redo=
          {String(editor.canRedo)} lineEdit={lineEditAction}
        </span>
        <span style={styles.message} id="ga-harness-message">
          {message}
        </span>
      </div>

      <div style={styles.canvasWrap}>
        {imageUrl && imgSize ? (
          <AnnotationCanvas
            className="ga-canvas-fill"
            imageUrl={imageUrl}
            imageWidth={imgSize.w}
            imageHeight={imgSize.h}
            editor={editor}
            classes={CLASSES}
            brightness={brightness}
            contrast={contrast}
            fitSignal={fitSignal}
            magnetMode={magnetMode}
            magnetInvert={magnetInvert}
            showDerivedBoxes
            magnetSegRef={magnetSegRef}
            lineEditAction={lineEditAction}
            onLineEditActionDone={() => setLineEditAction('none')}
            onMagnetFallback={() => setMessage('暗い筋が見つからないため直線で入力しました')}
            onLineMetaDropped={() => setMessage('頂点を編集したためライン構造を解除しました')}
          />
        ) : (
          <p style={styles.loading}>サンプル画像を生成中…</p>
        )}
      </div>
    </div>
  );
}

// 開発検証専用ページのためインラインスタイル（本番 UI は M5 が CSS で作る）
const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: 'var(--ga-color-bg)',
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 'var(--ga-space-1)',
    padding: 'var(--ga-space-2)',
    borderBottom: 'var(--ga-border-width) solid var(--ga-color-border)',
  },
  groupLabel: {
    fontSize: 'var(--ga-font-size-xs)',
    color: 'var(--ga-color-text-muted)',
    padding: '0 var(--ga-space-1)',
  },
  sep: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: 'var(--ga-color-border-subtle)',
    margin: '0 var(--ga-space-2)',
  },
  btn: {
    minHeight: 32,
    padding: '4px 10px',
    borderRadius: 'var(--ga-radius-sm)',
    // border は使わず個別指定（btnActive が borderColor だけ上書きするため。
    // shorthand と longhand を混ぜると React が再レンダ時に警告を出す）
    borderWidth: 'var(--ga-border-width)',
    borderStyle: 'solid',
    borderColor: 'var(--ga-color-border)',
    backgroundColor: 'var(--ga-color-bg)',
    color: 'var(--ga-color-text)',
    fontFamily: 'inherit',
    fontSize: 'var(--ga-font-size-xs)',
    cursor: 'pointer',
  },
  btnActive: {
    backgroundColor: 'var(--ga-color-primary-surface)',
    borderColor: 'var(--ga-color-primary)',
    color: 'var(--ga-color-primary)',
    fontWeight: 700,
  },
  status: {
    fontSize: 'var(--ga-font-size-xs)',
    fontFamily: 'var(--ga-font-family-mono)',
    color: 'var(--ga-color-text-muted)',
    marginLeft: 'var(--ga-space-3)',
  },
  message: {
    fontSize: 'var(--ga-font-size-xs)',
    color: 'var(--ga-color-text)',
    marginLeft: 'var(--ga-space-3)',
  },
  canvasWrap: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    backgroundColor: 'var(--ga-color-canvas-bg)',
  },
  loading: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    color: 'var(--ga-color-text-inverse)',
    fontSize: 'var(--ga-font-size-sm)',
  },
};
