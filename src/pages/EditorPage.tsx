// =============================================================================
// エディタ画面のページ統括（M5）
//
// 移植元: reference/frontend/src/pages/AnnotationPage.tsx
//   PendingAction（draft を解決してから実行）・busyRef・loadGen レース対策・
//   自動保存リトライ・Backspace 多段・キーマップの意味論をそのまま持ってきている。
//
// 参照実装からの主な差分（GenbaAnno の事情による意図的な変更）:
//   1. サーバ API ではなく StorageAdapter（サイドカー JSON）。**status はページが持つ**
//      （M2 申し送り: エディタ状態は status を持たない）。保存時に pending → in_progress。
//   2. 画像の naturalWidth/Height を <img> のロードから取得してから load する
//      （サイドカーが無い画像はここでしか寸法が分からない）。
//   3. サイドカーの lossy / 寸法不一致は**消えない警告バナー**にする。
//      トーストで流すと「保存すると元データが消える」警告を見逃す。
//   4. スキップはディスク上のサイドカーの status だけを書き換える
//      （未保存の変更を「破棄」と言いながら保存してしまわないため）。
//   5. ガイド枠（G キー）・クラス自動選択は GenbaAnno に無いので削除。
//      代わりに R（bbox）・E（完了して次へ）・A/D（ナビ）・I（マグネット反転）を追加。
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageIcon, Loader2 } from 'lucide-react';
import { AnnotationCanvas, type LineEditAction } from '../components/AnnotationCanvas';
import { AnnotationListPanel } from '../components/panels/AnnotationListPanel';
import { BannerStack, ToastStack, type BannerItem, type ToastItem } from '../components/panels/Toast';
import { ClassEditorDialog } from '../components/panels/ClassEditorDialog';
import { ClassPalette } from '../components/panels/ClassPalette';
import { ExportDialog } from '../components/panels/ExportDialog';
import { ImageListPanel, type StatusFilter } from '../components/panels/ImageListPanel';
import { ShortcutHelp } from '../components/panels/ShortcutHelp';
import { StatusHeader } from '../components/panels/StatusHeader';
import { Toolbar } from '../components/panels/Toolbar';
import { IconBtn } from '../components/panels/ui';
import type { StorageAdapter } from '../adapters/types';
import { annotationsToSidecar, sidecarToAnnotations } from '../core/serialize';
import type {
  Annotation,
  AnnotationStatus,
  ClassDef,
  DrawTool,
  ImageEntry,
  Project,
  SidecarFile,
} from '../core/types';
import { AUTOSAVE_DEBOUNCE_MS, LINE_WIDTH_MAX, LINE_WIDTH_MIN } from '../core/types';
// window.genbaAnno（setDirtyState）の型を持ち込むための型のみの import
import type {} from '../shared/ipc';
import { useAnnotationEditor } from '../store/useAnnotationEditor';
import { HelpCircle } from 'lucide-react';

const LINE_WIDTH_STEP = 2;
const TOAST_MS = 4000;

/** draft の commit/cancel が reducer に反映された後に実行する操作（参照実装と同じ） */
type PendingAction = { kind: 'save' } | { kind: 'done' } | { kind: 'switch'; file: string };

let nextNoticeId = 1;

interface ImageSize {
  w: number;
  h: number;
}

/** <img> をロードして naturalWidth/Height（EXIF 適用後）を得る */
function probeImage(url: string): Promise<ImageSize> {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('画像 URL が空です'));
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = url;
  });
}

function isFormTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
}

export interface EditorPageProps {
  adapter: StorageAdapter;
  dir: string;
  project: Project;
  images: ImageEntry[];
  /** openProject が返した警告（消えないバナーで全件出す） */
  openWarnings: string[];
  corruptSidecars: string[];
  onCloseProject: () => void;
}

export function EditorPage({
  adapter,
  dir,
  project: initialProject,
  images: initialImages,
  openWarnings,
  corruptSidecars,
  onCloseProject,
}: EditorPageProps): React.ReactElement {
  const [project, setProject] = useState<Project>(initialProject);
  const [images, setImages] = useState<ImageEntry[]>(initialImages);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const editor = useAnnotationEditor({
    drawTool: initialProject.settings.defaultTool,
    lineWidth: initialProject.settings.lineWidthDefault,
    activeClassId: initialProject.classes[0]?.id ?? 0,
    mode: 'edit',
  });

  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<ImageSize | null>(null);
  const [currentStatus, setCurrentStatus] = useState<AnnotationStatus>('pending');
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [fitSignal, setFitSignal] = useState(0);
  const [magnetMode, setMagnetMode] = useState(initialProject.settings.magnet.enabled);
  const [magnetInvert, setMagnetInvert] = useState(initialProject.settings.magnet.invert);
  const [lineEditAction, setLineEditAction] = useState<LineEditAction>('none');

  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [classEditorOpen, setClassEditorOpen] = useState(false);

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [banners, setBanners] = useState<BannerItem[]>(() => {
    const list: BannerItem[] = [];
    if (openWarnings.length > 0) {
      list.push({
        id: nextNoticeId++,
        kind: 'warning',
        title: `プロジェクト設定の読み込みで ${openWarnings.length} 件の警告があります`,
        messages: openWarnings,
      });
    }
    if (corruptSidecars.length > 0) {
      list.push({
        id: nextNoticeId++,
        kind: 'error',
        title: `読み込めなかったアノテーションファイルが ${corruptSidecars.length} 件あります（該当画像は未着手として扱われます）`,
        messages: corruptSidecars,
      });
    }
    return list;
  });

  const magnetSegRef = useRef<number[]>([]);
  const loadGenRef = useRef(0);
  const busyRef = useRef(false);
  const resizeGestureRef = useRef(false);
  const preloadRef = useRef<HTMLImageElement[]>([]);
  /** 読込時に修復された（= 保存で情報が失われる）画像。最初の保存前に1回だけ確認する */
  const lossyPendingRef = useRef<Set<string>>(new Set());
  const toastTimersRef = useRef<number[]>([]);

  const currentFileRef = useRef<string | null>(null);
  currentFileRef.current = currentFile;

  // ---- 通知 ---------------------------------------------------------------

  const showToast = useCallback((kind: 'info' | 'error', message: string) => {
    const id = nextNoticeId++;
    setToasts((prev) => [...prev, { id, kind, message }]);
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_MS);
    toastTimersRef.current.push(timer);
  }, []);

  const addBanner = useCallback(
    (kind: BannerItem['kind'], title: string, messages: string[]) => {
      setBanners((prev) => [...prev, { id: nextNoticeId++, kind, title, messages }]);
    },
    []
  );

  useEffect(
    () => () => {
      toastTimersRef.current.forEach((t) => window.clearTimeout(t));
    },
    []
  );

  // ---- 派生値 -------------------------------------------------------------

  const st = editor.state;
  /** useReducer 由来で不変。コールバックの依存に入れても再生成を誘発しない */
  const { dispatch } = editor;
  const draftHasPoints = st.draft !== null && st.draft.points.length > 0;
  const compositeDirty = st.dirty || draftHasPoints;

  const selected = st.selectedId ? st.annotations.find((a) => a.id === st.selectedId) : undefined;
  const selectedLine =
    st.mode === 'edit' && selected && selected.kind === 'line' ? selected : undefined;

  const visibleImages = useMemo(
    () => (statusFilter === 'all' ? images : images.filter((it) => it.status === statusFilter)),
    [images, statusFilter]
  );
  const visibleImagesRef = useRef(visibleImages);
  visibleImagesRef.current = visibleImages;

  const doneCount = useMemo(() => images.filter((it) => it.status === 'done').length, [images]);
  const modalOpen = helpOpen || exportOpen || classEditorOpen;

  // draft が消えた/開始直後はマグネット区間の境界スタックをリセット（Backspace 整合）
  useEffect(() => {
    const d = editor.state.draft;
    if (!d || d.points.length <= 1) magnetSegRef.current = [];
  }, [editor.state.draft]);

  // 選択解除・画像切替でライン編集アームを解除（陳腐化防止）
  useEffect(() => {
    setLineEditAction('none');
  }, [editor.state.selectedId, currentFile]);

  // ---- 画像読み込み -------------------------------------------------------

  const warmNeighbors = useCallback(
    (file: string) => {
      const list = visibleImagesRef.current;
      const idx = list.findIndex((it) => it.file === file);
      const targets = [list[idx + 1]?.file, list[idx - 1]?.file].filter(
        (f): f is string => typeof f === 'string'
      );
      // 参照を保持しないと GC されてキャッシュが温まらない
      preloadRef.current = targets.map((f) => {
        const img = new Image();
        img.src = adapter.imageUrl(dir, f);
        return img;
      });
    },
    [adapter, dir]
  );

  const loadImage = useCallback(
    async (file: string): Promise<void> => {
      const gen = ++loadGenRef.current; // 連続クリックで遅い応答が勝つのを防ぐ
      setLoading(true);
      magnetSegRef.current = [];
      try {
        const url = adapter.imageUrl(dir, file);
        const size = await probeImage(url);
        if (gen !== loadGenRef.current) return;
        const raw = await adapter.loadSidecar(dir, file);
        if (gen !== loadGenRef.current) return;

        let annotations: Annotation[] = [];
        let status: AnnotationStatus = 'pending';

        if (raw) {
          const parsed = sidecarToAnnotations(raw, {
            fallbackWidth: size.w,
            fallbackHeight: size.h,
          });
          annotations = parsed.annotations;
          status = parsed.status;

          if (parsed.lossy) {
            lossyPendingRef.current.add(file);
            addBanner(
              'error',
              `${file}: このアノテーションは読込時に修復されました`,
              [
                '保存すると元データの一部が失われます。元のファイルを残したい場合は、保存する前に _anno/annotations/ の該当ファイルをコピーしてください。',
                ...parsed.warnings,
              ]
            );
          } else if (parsed.warnings.length > 0) {
            showToast('info', `読み込み時に ${parsed.warnings.length} 件の補正を行いました`);
          }

          // 画像差し替え・EXIF 事情の変化。座標は変換しない（DESIGN.md §2）
          if (
            parsed.width > 0 &&
            parsed.height > 0 &&
            (parsed.width !== size.w || parsed.height !== size.h)
          ) {
            addBanner('error', `${file}: 記録されている画像サイズが実際と一致しません`, [
              `記録: ${parsed.width} × ${parsed.height} / 実際: ${size.w} × ${size.h}`,
              '座標は変換していません（暗黙の変換は事故のもとです）。画像を差し替えた場合はアノテーションを付け直してください。',
            ]);
          }
        }

        setCurrentFile(file);
        setImgSize(size);
        setImageUrl(url);
        setCurrentStatus(status);
        dispatch({
          type: 'load',
          annotations,
          imageWidth: size.w,
          imageHeight: size.h,
        });
        setFitSignal((s) => s + 1);
        warmNeighbors(file);
      } catch {
        if (gen === loadGenRef.current) showToast('error', `画像を読み込めませんでした（${file}）`);
      } finally {
        if (gen === loadGenRef.current) setLoading(false);
      }
    },
    // dispatch は useReducer 由来で不変。editor 全体を入れると
    // 状態が変わるたび loadImage が作り直され、依存する effect が無駄に走る
    [adapter, dir, dispatch, addBanner, showToast, warmNeighbors]
  );

  // 初回: 先頭の画像を開く
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const first = initialImages[0];
    if (first) void loadImage(first.file);
  }, [initialImages, loadImage]);

  // ---- 保存 ---------------------------------------------------------------

  const performSave = useCallback(
    async (nextStatus?: AnnotationStatus): Promise<boolean> => {
      const file = currentFile;
      const size = imgSize;
      if (file === null || size === null) return true;

      // 修復済みサイドカーは、その画像の最初の保存前に 1 回だけ確認する
      if (lossyPendingRef.current.has(file)) {
        const ok = window.confirm(
          `「${file}」のアノテーションは読み込み時に修復されています。\n` +
            '保存すると、元のファイルにあった情報の一部が失われます。保存しますか？'
        );
        if (!ok) return false;
        lossyPendingRef.current.delete(file);
      }

      const gen = loadGenRef.current;
      // pending は保存で in_progress へ自動昇格（DESIGN.md §2 ステータス運用）
      const status: AnnotationStatus =
        nextStatus ?? (currentStatus === 'pending' ? 'in_progress' : currentStatus);

      busyRef.current = true;
      setSaving(true);
      try {
        const annotations = editor.state.annotations;
        const sidecar = annotationsToSidecar(
          annotations,
          { file, width: size.w, height: size.h },
          status
        );
        await adapter.saveSidecar(dir, file, sidecar);
        // 応答待ちの間に別画像へ切り替わっていたら、その画像の dirty を誤クリアしない
        if (currentFileRef.current === file && loadGenRef.current === gen) {
          editor.dispatch({ type: 'markSaved' });
          setCurrentStatus(status);
        }
        setImages((prev) =>
          prev.map((it) =>
            it.file === file ? { ...it, status, annotationCount: annotations.length } : it
          )
        );
        return true;
      } catch {
        showToast('error', '保存に失敗しました');
        return false;
      } finally {
        busyRef.current = false;
        setSaving(false);
      }
    },
    [adapter, dir, currentFile, currentStatus, imgSize, editor, showToast]
  );

  const performSaveRef = useRef(performSave);
  performSaveRef.current = performSave;

  // ---- draft 解決 → PendingAction（参照実装と同じ2段構え） -----------------

  const resolveDraft = useCallback((): boolean => {
    if (!draftHasPoints) return true;
    if (editor.canCommitDraft) {
      editor.dispatch({ type: 'commitDraft' });
      return true;
    }
    if (window.confirm('確定できない描画中の図形があります。破棄して続行しますか？')) {
      editor.dispatch({ type: 'cancelDraft' });
      return true;
    }
    return false;
  }, [draftHasPoints, editor]);

  const requestAction = useCallback(
    (action: PendingAction) => {
      if (!resolveDraft()) return;
      setPendingAction(action);
    },
    [resolveDraft]
  );

  const neighborFile = useCallback(
    (delta: 1 | -1): string | null => {
      const list = visibleImagesRef.current;
      if (list.length === 0) return null;
      const file = currentFileRef.current;
      if (file === null) return list[0].file;
      const idx = list.findIndex((it) => it.file === file);
      if (idx === -1) return list[0].file;
      const next = idx + delta;
      if (next < 0 || next >= list.length) return null;
      return list[next].file;
    },
    []
  );

  const executeAction = useCallback(
    async (action: PendingAction): Promise<void> => {
      if (action.kind === 'save') {
        await performSave();
        return;
      }
      if (action.kind === 'done') {
        const ok = await performSave('done');
        if (!ok) return;
        const next = neighborFile(1);
        if (next !== null) await loadImage(next);
        else showToast('info', '次の画像がありません（この画像は完了にしました）');
        return;
      }
      if (editor.state.dirty) {
        const ok = await performSave();
        if (!ok && !window.confirm('保存に失敗しました。変更を破棄して切り替えますか？')) return;
      }
      await loadImage(action.file);
    },
    [editor.state.dirty, loadImage, neighborFile, performSave, showToast]
  );

  // commit/cancel が state に反映された後（draft が空になった後）に実行する
  useEffect(() => {
    if (!pendingAction) return;
    if (editor.state.draft && editor.state.draft.points.length > 0) return;
    setPendingAction(null);
    void executeAction(pendingAction);
    // executeAction を依存に入れると毎レンダで再実行されるため意図的に外す（参照実装と同じ）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction, editor.state.draft]);

  // ---- 30秒デバウンス自動保存（失敗時は再試行） ----------------------------

  const [autosaveRetryTick, setAutosaveRetryTick] = useState(0);
  useEffect(() => {
    if (!editor.state.dirty || currentFile === null) return;
    const timer = window.setTimeout(() => {
      void performSaveRef.current().then((ok) => {
        if (!ok) setAutosaveRetryTick((t) => t + 1);
      });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [editor.state.dirty, editor.state.annotations, currentFile, autosaveRetryTick]);

  // ---- クローズ前の未保存警告（Electron / ブラウザ両方） -------------------

  const dirtyRef = useRef(false);
  dirtyRef.current = compositeDirty;

  useEffect(() => {
    window.genbaAnno?.setDirtyState(compositeDirty);
  }, [compositeDirty]);

  useEffect(
    () => () => {
      window.genbaAnno?.setDirtyState(false);
    },
    []
  );

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // ---- 操作ハンドラ -------------------------------------------------------

  const handleSave = useCallback(() => {
    if (busyRef.current) return;
    requestAction({ kind: 'save' });
  }, [requestAction]);

  const handleDone = useCallback(() => {
    if (currentFileRef.current === null || busyRef.current) return;
    requestAction({ kind: 'done' });
  }, [requestAction]);

  const handleSelectImage = useCallback(
    (file: string) => {
      if (file === currentFileRef.current || busyRef.current) return;
      requestAction({ kind: 'switch', file });
    },
    [requestAction]
  );

  const handleNav = useCallback(
    (delta: 1 | -1) => {
      if (busyRef.current) return;
      const file = neighborFile(delta);
      if (file === null || file === currentFileRef.current) return;
      requestAction({ kind: 'switch', file });
    },
    [neighborFile, requestAction]
  );

  const handleSkip = useCallback(async (): Promise<void> => {
    const file = currentFile;
    const size = imgSize;
    if (file === null || size === null || busyRef.current) return;
    if (compositeDirty && !window.confirm('未保存の変更があります。破棄してスキップしますか？')) {
      return;
    }
    busyRef.current = true;
    try {
      if (editor.state.draft) editor.dispatch({ type: 'cancelDraft' });
      // ディスク上の内容はそのままに status だけを skipped にする
      // （「破棄」と言いながら未保存の変更を書き込まないため）
      const raw = await adapter.loadSidecar(dir, file);
      const data: SidecarFile = raw
        ? { ...raw, status: 'skipped', updated_at: new Date().toISOString() }
        : annotationsToSidecar([], { file, width: size.w, height: size.h }, 'skipped');
      await adapter.saveSidecar(dir, file, data);
      setImages((prev) =>
        prev.map((it) =>
          it.file === file
            ? { ...it, status: 'skipped', annotationCount: data.annotations.length }
            : it
        )
      );
      setCurrentStatus('skipped');
      const next = neighborFile(1);
      busyRef.current = false;
      if (next !== null) {
        await loadImage(next);
      } else {
        showToast('info', '次の画像がありません（この画像はスキップにしました）');
        // 破棄した変更が残らないようディスクの内容へ戻す
        if (compositeDirty) await loadImage(file);
      }
    } catch {
      showToast('error', 'スキップに失敗しました');
    } finally {
      busyRef.current = false;
    }
  }, [
    adapter,
    compositeDirty,
    currentFile,
    dir,
    editor,
    imgSize,
    loadImage,
    neighborFile,
    showToast,
  ]);

  const handleRescan = useCallback(async (): Promise<void> => {
    setRescanning(true);
    try {
      const next = await adapter.relistImages(dir);
      setImages(next);
      showToast('info', `フォルダを再走査しました（${next.length} 枚）`);
    } catch {
      showToast('error', 'フォルダの再走査に失敗しました');
    } finally {
      setRescanning(false);
    }
  }, [adapter, dir, showToast]);

  const setTool = useCallback(
    (tool: DrawTool) => {
      editor.dispatch({ type: 'setDrawTool', tool });
      setLineEditAction('none');
    },
    [editor]
  );

  // 選択中ラインの幅変更は履歴を積まないので beginGesture/endGesture で囲む（M2 申し送り）
  const resizeSelectedLine = useCallback(
    (width: number) => {
      if (!selectedLine) return;
      if (!resizeGestureRef.current) {
        editor.dispatch({ type: 'beginGesture' });
        resizeGestureRef.current = true;
      }
      editor.dispatch({ type: 'resizeLine', id: selectedLine.id, width });
    },
    [editor, selectedLine]
  );

  const endResizeGesture = useCallback(() => {
    if (resizeGestureRef.current) {
      editor.dispatch({ type: 'endGesture' });
      resizeGestureRef.current = false;
    }
  }, [editor]);

  /** キー操作（[ ]）は 1 押下 = 1 ジェスチャ */
  const resizeSelectedLineByStep = useCallback(
    (delta: number) => {
      if (!selectedLine) return;
      editor.dispatch({ type: 'beginGesture' });
      editor.dispatch({
        type: 'resizeLine',
        id: selectedLine.id,
        width: Math.min(
          Math.max(selectedLine.lineMeta.width + delta, LINE_WIDTH_MIN),
          LINE_WIDTH_MAX
        ),
      });
      editor.dispatch({ type: 'endGesture' });
    },
    [editor, selectedLine]
  );

  const handleSaveClasses = useCallback(
    async (classes: ClassDef[]): Promise<boolean> => {
      const next: Project = {
        ...project,
        classes,
        updatedAt: new Date().toISOString(),
      };
      try {
        await adapter.saveProjectFile(dir, next);
        setProject(next);
        if (!classes.some((c) => c.id === editor.state.activeClassId)) {
          // 選択中アノテーションのクラスまで巻き添えで変えないよう、先に選択解除する
          editor.dispatch({ type: 'select', id: null });
          editor.dispatch({ type: 'setActiveClass', classId: classes[0].id });
        }
        showToast('info', 'クラス定義を保存しました');
        return true;
      } catch {
        return false;
      }
    },
    [adapter, dir, editor, project, showToast]
  );

  // マグネット設定は project.json に保存する（次回起動時の初期値）
  useEffect(() => {
    if (
      project.settings.magnet.enabled === magnetMode &&
      project.settings.magnet.invert === magnetInvert
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const next: Project = {
        ...project,
        settings: {
          ...project.settings,
          magnet: { enabled: magnetMode, invert: magnetInvert },
        },
        updatedAt: new Date().toISOString(),
      };
      setProject(next);
      void adapter.saveProjectFile(dir, next).catch(() => {
        showToast('error', 'マグネット設定の保存に失敗しました');
      });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [adapter, dir, magnetInvert, magnetMode, project, showToast]);

  // ---- キーボード（window listener・最新 state は ref 経由） ---------------

  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (e: KeyboardEvent) => {
    // IME 変換中は無視（Electron 罠#11 と同じ理由でフォーム系も無効）
    if (e.isComposing || e.keyCode === 229) return;
    if (isFormTarget(e.target)) return;
    // モーダル表示中はページ側のキーを全て止める（Esc はモーダル自身が処理する）
    if (modalOpen) return;

    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        handleSave();
      } else if (k === 'z') {
        e.preventDefault();
        editor.dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
      }
      return;
    }
    if (e.altKey) return;

    switch (e.key) {
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9': {
        const cls = project.classes[Number(e.key) - 1];
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
        // 優先順: ライン編集アーム → 描画破棄 → 選択解除 → 編集モード
        if (lineEditAction !== 'none') setLineEditAction('none');
        else if (st.draft) editor.dispatch({ type: 'cancelDraft' });
        else if (st.selectedId) editor.dispatch({ type: 'select', id: null });
        else editor.dispatch({ type: 'setMode', mode: 'edit' });
        return;
      case 'Backspace': {
        // 1つ戻す専任（全体削除は Delete）。マグネットは 1 区間分まとめて戻す
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
          showToast('info', 'アノテーションを削除しました（Ctrl+Z で元に戻せます）');
        }
        return;
      case 'ArrowLeft':
      case 'a':
      case 'A':
        e.preventDefault();
        handleNav(-1);
        return;
      case 'ArrowRight':
      case 'd':
      case 'D':
        e.preventDefault();
        handleNav(1);
        return;
      case 'e':
      case 'E':
        handleDone();
        return;
      case 'x':
      case 'X':
        void handleSkip();
        return;
      case '?':
      case 'h':
      case 'H':
        setHelpOpen((o) => !o);
        return;
      case ' ': {
        // Space パン用: ページスクロールとボタン再発火を止める（パンは canvas 側）
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag !== 'BUTTON' && tag !== 'INPUT') e.preventDefault();
        return;
      }
      default:
        return;
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => keyHandlerRef.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ---- 描画 ---------------------------------------------------------------

  const saveState = saving ? 'saving' : compositeDirty ? 'dirty' : 'saved';

  return (
    <div className="ga-app">
      <StatusHeader
        projectName={project.name}
        doneCount={doneCount}
        totalCount={images.length}
        saveState={saveState}
        currentFile={currentFile}
        currentStatus={currentFile ? currentStatus : null}
        busy={saving}
        onDone={handleDone}
        onSkip={() => void handleSkip()}
        onExport={() => setExportOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onReveal={() => void adapter.revealInFolder(dir)}
        onCloseProject={() => {
          if (compositeDirty && !window.confirm('未保存の変更があります。破棄して閉じますか？')) {
            return;
          }
          onCloseProject();
        }}
      />

      <BannerStack
        items={banners}
        onDismiss={(id) => setBanners((prev) => prev.filter((b) => b.id !== id))}
      />

      <div className="ga-app__body">
        <div className="ga-col">
          <ImageListPanel
            items={visibleImages}
            totalCount={images.length}
            selectedFile={currentFile}
            statusFilter={statusFilter}
            onFilterChange={setStatusFilter}
            onSelect={handleSelectImage}
            onRescan={() => void handleRescan()}
            rescanning={rescanning}
            imageUrl={(file) => adapter.imageUrl(dir, file)}
          />
        </div>

        <div className="ga-col">
          <Toolbar
            mode={st.mode}
            drawTool={st.drawTool}
            fillVisible={st.fillVisible}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            magnetMode={magnetMode}
            magnetInvert={magnetInvert}
            brightness={brightness}
            contrast={contrast}
            lineWidth={st.lineWidth}
            selectedLineWidth={selectedLine ? selectedLine.lineMeta.width : null}
            saving={saving}
            disabled={currentFile === null}
            lineEditAction={lineEditAction}
            onSetTool={setTool}
            onSetEditMode={() => {
              editor.dispatch({ type: 'setMode', mode: 'edit' });
              setLineEditAction('none');
            }}
            onToggleMagnet={() => setMagnetMode((v) => !v)}
            onToggleInvert={() => setMagnetInvert((v) => !v)}
            onLineWidthChange={(w) => {
              if (selectedLine) resizeSelectedLine(w);
              else editor.dispatch({ type: 'setLineWidth', width: w });
            }}
            onLineWidthCommit={endResizeGesture}
            onBrightness={setBrightness}
            onContrast={setContrast}
            onFit={() => setFitSignal((s) => s + 1)}
            onUndo={() => editor.dispatch({ type: 'undo' })}
            onRedo={() => editor.dispatch({ type: 'redo' })}
            onToggleFill={() => editor.dispatch({ type: 'toggleFill' })}
            onSave={handleSave}
            onSetLineEditAction={setLineEditAction}
          />

          <div className="ga-canvas-area">
            {currentFile && imgSize && imageUrl ? (
              <AnnotationCanvas
                className="ga-canvas-fill"
                imageUrl={imageUrl}
                imageWidth={imgSize.w}
                imageHeight={imgSize.h}
                editor={editor}
                classes={project.classes}
                brightness={brightness}
                contrast={contrast}
                fitSignal={fitSignal}
                magnetMode={magnetMode}
                magnetInvert={magnetInvert}
                magnetSegRef={magnetSegRef}
                lineEditAction={lineEditAction}
                onLineEditActionDone={() => setLineEditAction('none')}
                onMagnetFallback={() => showToast('info', '暗い筋が見つからず直線にしました')}
                onLineMetaDropped={() =>
                  showToast('info', '頂点を編集したためライン構造（幅変更・延長・短縮・分岐）を解除しました')
                }
                shortcutsSuspended={modalOpen}
              />
            ) : (
              <div className="ga-canvas-empty">
                <ImageIcon size={28} aria-hidden="true" />
                <p>
                  {images.length === 0
                    ? 'このフォルダに対応する画像がありません（jpg / jpeg / png / webp / bmp）'
                    : '左の一覧から画像を選んでください'}
                </p>
              </div>
            )}
            {loading && (
              <div className="ga-canvas-loading" role="status">
                <Loader2 size={28} aria-hidden="true" className="ga-spin" />
              </div>
            )}
          </div>

          <div className="ga-hintbar">
            {draftHasPoints ? (
              <>
                <span>
                  <kbd>Backspace</kbd> 1点戻る
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>Enter</kbd> 確定
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>Esc</kbd> すべて破棄
                </span>
                {st.drawTool === 'line' && magnetMode && (
                  <>
                    <span className="ga-hintbar__sep">/</span>
                    <span>
                      <kbd>Tab</kbd> ゴースト経路を確定
                    </span>
                  </>
                )}
              </>
            ) : selectedLine ? (
              <>
                <span>端点◻クリックで延長</span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>C</kbd> 短縮
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>B</kbd> 分岐
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>Backspace</kbd> 末尾1点削除
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>Delete</kbd> 全体削除
                </span>
              </>
            ) : (
              <>
                <span>
                  <kbd>L</kbd> ライン
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>R</kbd> 矩形
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>W</kbd> 多角形
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>A</kbd> <kbd>D</kbd> 前後の画像
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>E</kbd> 完了して次へ
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>?</kbd> ヘルプ
                </span>
              </>
            )}
            {lineEditAction !== 'none' && (
              <span className="ga-hintbar__arm">
                {lineEditAction === 'cut'
                  ? '中心線をクリック → 切断位置を指定'
                  : '中心線をクリック → 分岐を開始'}
              </span>
            )}
          </div>
        </div>

        <div className="ga-col ga-col--right">
          <ClassPalette
            classes={project.classes}
            activeClassId={st.activeClassId}
            onSelect={(classId) => editor.dispatch({ type: 'setActiveClass', classId })}
            onEdit={() => setClassEditorOpen(true)}
          />
          <AnnotationListPanel
            annotations={st.annotations}
            classes={project.classes}
            selectedId={st.selectedId}
            onSelect={(id) => editor.dispatch({ type: 'select', id })}
            onDelete={(id) => editor.dispatch({ type: 'deleteAnnotation', id })}
          />
          <section className="ga-panel" aria-labelledby="ga-guide-title">
            <div className="ga-panel__head">
              <h2 className="ga-panel__title" id="ga-guide-title">
                操作ガイド
              </h2>
              <span className="ga-spacer" />
              <IconBtn
                className="ga-icon-btn--sm"
                label="ショートカット一覧 (?)"
                onClick={() => setHelpOpen(true)}
              >
                <HelpCircle size={16} aria-hidden="true" />
              </IconBtn>
            </div>
            <div className="ga-panel__body">
              <ul className="ga-guide">
                <li>L でライン → ひびの始点と終点をクリック → Tab でゴーストどおり確定</li>
                <li>M: マグネット ON/OFF、I: 反転（白線を追う）、[ ]: 線幅</li>
                <li>R でドラッグして矩形、W でクリックして多角形</li>
                <li>Backspace は「1つ戻す」、Delete は選択したもの全体を削除</li>
                <li>ライン選択中: 端点◻=延長 / C=短縮 / B=分岐</li>
                <li>
                  <strong>損傷が無い画像も「完了」にすると負例（対象物なしの教師データ）になります。</strong>
                  未着手・スキップはエクスポートに含まれません。
                </li>
              </ul>
            </div>
          </section>
        </div>
      </div>

      <ToastStack items={toasts} />

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ClassEditorDialog
        open={classEditorOpen}
        classes={project.classes}
        onClose={() => setClassEditorOpen(false)}
        onSave={handleSaveClasses}
      />
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        adapter={adapter}
        projectDir={dir}
        project={project}
        classes={project.classes}
        onToast={showToast}
      />
    </div>
  );
}
