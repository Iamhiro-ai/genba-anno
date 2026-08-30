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
import { DELETE_ALL_KEY_LABEL, IconBtn } from '../components/panels/ui';
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
/** pendingAction が解決されないまま固まるのを防ぐ保険（通常は張られた直後に解除される） */
const PENDING_ACTION_TIMEOUT_MS = 5000;

/** draft の commit/cancel が reducer に反映された後に実行する操作（参照実装と同じ） */
type PendingAction =
  | { kind: 'save' }
  | { kind: 'done' }
  | { kind: 'switch'; file: string }
  | { kind: 'export' };

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
  /** ライン/多角形の外接ボックス表示（エクスポートの derived box プレビュー・表示のみ） */
  const [showDerivedBoxes, setShowDerivedBoxes] = useState(
    initialProject.settings.showDerivedBoxes
  );
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

  /** 保存・完了・切替・スキップ・エクスポートの実行中フラグ（表示用。実体は busyRef） */
  const [actionBusy, setActionBusy] = useState(false);

  const magnetSegRef = useRef<number[]>([]);
  const loadGenRef = useRef(0);
  /**
   * ユーザー操作（保存/完了/切替/スキップ/エクスポート）が解決するまで次の要求を受け付けないための
   * **同期**フラグ。async 関数の中で立てると、キーの連打が await の前に全部通り抜けて
   * pendingAction を上書きし合う（= 完了とナビが混ざる）ので、要求を受理した瞬間に立てる。
   */
  const busyRef = useRef(false);
  const resizeGestureRef = useRef(false);
  const preloadRef = useRef<HTMLImageElement[]>([]);
  /** 読込時に修復された（= 保存で情報が失われる）画像。最初の保存前に1回だけ確認する */
  const lossyPendingRef = useRef<Set<string>>(new Set());
  const toastTimersRef = useRef<number[]>([]);

  const currentFileRef = useRef<string | null>(null);
  currentFileRef.current = currentFile;

  /**
   * 最新のエディタ状態。await をまたいだ後の比較に使う
   * （クロージャが捕まえた state は古いので、応答待ち中の編集を検出できない）。
   */
  const stateRef = useRef(editor.state);
  stateRef.current = editor.state;

  const busy = actionBusy || saving;

  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setActionBusy(value);
  }, []);

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
  /** 編集モードで選択中のアノテーション（削除ボタン・ヒントバーの表示条件） */
  const selectedInEdit = st.mode === 'edit' ? selected : undefined;
  const selectedLine = selectedInEdit && selectedInEdit.kind === 'line' ? selectedInEdit : undefined;

  /**
   * フィルタ適用後の一覧（= ナビゲーション順）。
   * **表示中の画像がフィルタ条件から外れても一覧に残す**（「フィルタ外」バッジ付き）。
   * 一覧から消すと ←/→ の起点を失い、暗黙に先頭へ飛ぶ実装になって
   * 「フィルタを変えたら知らない画像に飛んだ」事故になるため。
   */
  const visibleImages = useMemo(() => {
    const base =
      statusFilter === 'all' ? images : images.filter((it) => it.status === statusFilter);
    if (currentFile === null || base.some((it) => it.file === currentFile)) return base;
    const current = images.find((it) => it.file === currentFile);
    if (!current) return base;
    // 元の並び順を保ったまま差し込む（base は images の順序を保っている）
    const order = new Map(images.map((it, i) => [it.file, i]));
    const currentIndex = order.get(currentFile) ?? 0;
    const at = base.findIndex((it) => (order.get(it.file) ?? 0) > currentIndex);
    return at < 0 ? [...base, current] : [...base.slice(0, at), current, ...base.slice(at)];
  }, [images, statusFilter, currentFile]);

  /** 一覧に残してはいるが、フィルタ条件には合っていない画像（バッジ表示用） */
  const outOfFilterFile =
    currentFile !== null &&
    statusFilter !== 'all' &&
    images.some((it) => it.file === currentFile && it.status !== statusFilter)
      ? currentFile
      : null;

  const visibleImagesRef = useRef(visibleImages);
  visibleImagesRef.current = visibleImages;

  /** draft を含む未保存判定。全ゲート（切替/完了/終了/エクスポート）はこれを見る */
  const compositeDirtyRef = useRef(false);
  compositeDirtyRef.current = compositeDirty;

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

  /**
   * 表示中の画像を空にする（フォルダから消えた画像を開いていたとき用）。
   * エディタも空で load し直す。放置すると「消えた画像のアノテーションが残り続け、
   * 保存も切替もできない」孤立状態になる（参照実装 handleDeleteImage と同じ理由）。
   */
  const clearCurrentImage = useCallback(() => {
    loadGenRef.current += 1; // 進行中の読込結果を破棄する
    setCurrentFile(null);
    setImgSize(null);
    setImageUrl('');
    setCurrentStatus('pending');
    dispatch({ type: 'load', annotations: [], imageWidth: 0, imageHeight: 0 });
  }, [dispatch]);

  // 初回: 先頭の画像を開く
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const first = initialImages[0];
    if (first) void loadImage(first.file);
  }, [initialImages, loadImage]);

  // ---- 保存 ---------------------------------------------------------------

  /**
   * 実際に 1 回分の保存を行う。呼び出しは必ず performSave 経由（直列化のため）。
   *
   * **保存応答待ちの間に加えられた編集を消さないこと**が最重要。
   * reducer はイミュータブルなので、書き込んだ annotations 配列の**参照**を捕捉しておき、
   * 完了時にまだ同じ参照なら「その間 1 度も編集されていない」と言い切れる。
   * 参照が変わっていたら markSaved しない（dirty を維持 → 自動保存が次を書く）。
   */
  const runSave = useCallback(
    async (nextStatus?: AnnotationStatus): Promise<boolean> => {
      // file / size / status は同じレンダのクロージャから取る（3つが必ず同じ画像を指す）。
      // runSaveRef は毎レンダ差し替えるので、鎖で後回しになった保存も最新の画像を見る
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
      // 「これから書き込む内容」そのものを捕捉する（完了時の同一性判定に使う）
      const revision = stateRef.current.annotations;

      setSaving(true);
      try {
        const sidecar = annotationsToSidecar(
          revision,
          { file, width: size.w, height: size.h },
          status
        );
        await adapter.saveSidecar(dir, file, sidecar);

        // 応答待ちの間に別画像へ切り替わっていたら、その画像の dirty を誤クリアしない
        if (currentFileRef.current === file && loadGenRef.current === gen) {
          if (stateRef.current.annotations === revision) {
            dispatch({ type: 'markSaved' });
          }
          // 参照が変わっている = 保存中に編集された。markSaved は撃たず未保存のままにする
          setCurrentStatus(status);
        }
        setImages((prev) =>
          prev.map((it) =>
            it.file === file ? { ...it, status, annotationCount: revision.length } : it
          )
        );
        return true;
      } catch {
        showToast('error', '保存に失敗しました');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [adapter, dir, currentFile, currentStatus, imgSize, dispatch, showToast]
  );

  const runSaveRef = useRef(runSave);
  runSaveRef.current = runSave;

  /** 進行中の保存（同一要求の相乗り用） */
  const saveInFlightRef = useRef<{
    status: AnnotationStatus | undefined;
    promise: Promise<boolean>;
  } | null>(null);
  /** 直列化の鎖。saveSidecar を絶対に重ねない（後発が先に着地して取り違えるのを防ぐ） */
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * 保存の唯一の入口。
   *   - 同じステータス指定の重複要求（自動保存と Ctrl+S の重なり等）は進行中のものに相乗り
   *   - それ以外は前の保存の完了を待ってから直列に実行
   */
  const performSave = useCallback((nextStatus?: AnnotationStatus): Promise<boolean> => {
    const inflight = saveInFlightRef.current;
    if (inflight && inflight.status === nextStatus) return inflight.promise;

    const promise = saveChainRef.current
      .catch(() => undefined)
      .then(() => runSaveRef.current(nextStatus));
    const entry = { status: nextStatus, promise };
    saveInFlightRef.current = entry;
    saveChainRef.current = promise.catch(() => undefined);
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (saveInFlightRef.current === entry) saveInFlightRef.current = null;
      });
    return promise;
  }, []);

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

  /**
   * 操作要求の受付。**受理した瞬間に同期で busy を立てる**のが肝。
   * async の中で立てると、キー連打が await 前に全部通り抜けて pendingAction を
   * 上書きし合い、「完了」と「次へ」が混ざる。解決は pendingAction の effect が行う。
   */
  const requestAction = useCallback(
    (action: PendingAction) => {
      if (busyRef.current) return;
      setBusy(true);
      if (!resolveDraft()) {
        setBusy(false);
        return;
      }
      setPendingAction(action);
    },
    [resolveDraft, setBusy]
  );

  const neighborFile = useCallback((delta: 1 | -1): string | null => {
    const list = visibleImagesRef.current;
    if (list.length === 0) return null;
    const file = currentFileRef.current;
    if (file === null) return list[0].file;
    const idx = list.findIndex((it) => it.file === file);
    // 一覧に居ない = 呼び出し側が整合を取るべき状態。暗黙に先頭へ飛ばさない
    if (idx === -1) return null;
    const next = idx + delta;
    if (next < 0 || next >= list.length) return null;
    return list[next].file;
  }, []);

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
      if (action.kind === 'export') {
        // 未保存のままエクスポートすると「画面の内容と出力が違う」事故になる
        if (currentFileRef.current !== null && compositeDirtyRef.current) {
          const ok = await performSave();
          if (
            !ok &&
            !window.confirm(
              '保存に失敗しました。未保存の変更を含めずにエクスポートを続けますか？'
            )
          ) {
            return;
          }
        }
        setExportOpen(true);
        return;
      }
      // switch: 判定は compositeDirty ベース（draft は resolveDraft で解決済み）
      if (compositeDirtyRef.current) {
        const ok = await performSave();
        if (!ok && !window.confirm('保存に失敗しました。変更を破棄して切り替えますか？')) return;
      }
      await loadImage(action.file);
    },
    [loadImage, neighborFile, performSave, showToast]
  );

  // commit/cancel が state に反映された後（draft が空になった後）に実行する
  useEffect(() => {
    if (!pendingAction) return;
    if (editor.state.draft && editor.state.draft.points.length > 0) return;
    setPendingAction(null);
    void executeAction(pendingAction).finally(() => {
      // 解決するまで次の要求を受け付けない（requestAction の同期ガードの解除点）
      setBusy(false);
    });
    // executeAction を依存に入れると毎レンダで再実行されるため意図的に外す（参照実装と同じ）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction, editor.state.draft]);

  // 保険: draft が解決されず pendingAction が宙に浮いたら、要求を捨てて busy を解放する。
  // requestAction は同期で busy を立てるので、ここが無いと操作不能のまま固まってしまう。
  // 正常系では上の effect が同じレンダで pendingAction を null にするため、
  // このタイマーは張られた直後にクリーンアップで消える。
  useEffect(() => {
    if (!pendingAction) return;
    const timer = window.setTimeout(() => {
      setPendingAction(null);
      setBusy(false);
      showToast('error', '操作を完了できませんでした。もう一度お試しください');
    }, PENDING_ACTION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pendingAction, setBusy, showToast]);

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
      if (compositeDirtyRef.current) {
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

  /** エクスポートは「draft 解決 → 保存」を済ませてからダイアログを開く */
  const handleExport = useCallback(() => {
    if (busyRef.current) return;
    requestAction({ kind: 'export' });
  }, [requestAction]);

  /**
   * 選択アノテーションの全体削除。Delete / mod+Backspace / ツールバーの削除ボタンの共通実装。
   * 最新の選択は stateRef から取る（キーハンドラとボタンで同じ関数を使い回すため）。
   */
  const handleDeleteSelected = useCallback(() => {
    const id = stateRef.current.selectedId;
    if (!id) return;
    dispatch({ type: 'deleteAnnotation', id });
    showToast('info', 'アノテーションを削除しました（Ctrl+Z で元に戻せます）');
  }, [dispatch, showToast]);

  const handleSkip = useCallback(async (): Promise<void> => {
    const file = currentFile;
    const size = imgSize;
    if (file === null || size === null || busyRef.current) return;
    const wasDirty = compositeDirtyRef.current;
    if (wasDirty && !window.confirm('未保存の変更があります。破棄してスキップしますか？')) {
      return;
    }
    setBusy(true);
    // 確認した時点の内容を捕捉する。ここから先の await の間に加えられた編集は
    // 「破棄してよい」と言われていないので、黙って捨てずにもう一度確認する
    const revision = stateRef.current.annotations;
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

      const editedDuringSkip =
        currentFileRef.current === file &&
        (stateRef.current.annotations !== revision ||
          (stateRef.current.draft !== null && stateRef.current.draft.points.length > 0));
      if (
        editedDuringSkip &&
        !window.confirm(
          'スキップの処理中に加えた変更があります。\n破棄して次の画像へ進みますか？'
        )
      ) {
        showToast('info', 'この画像はスキップにしました（変更は未保存のままです）');
        return;
      }

      const next = neighborFile(1);
      if (next !== null) {
        await loadImage(next);
      } else {
        showToast('info', '次の画像がありません（この画像はスキップにしました）');
        // 破棄した変更が画面に残らないようディスクの内容へ戻す
        if (wasDirty || editedDuringSkip) await loadImage(file);
      }
    } catch {
      showToast('error', 'スキップに失敗しました');
    } finally {
      setBusy(false);
    }
  }, [adapter, currentFile, dir, editor, imgSize, loadImage, neighborFile, setBusy, showToast]);

  const handleRescan = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    setRescanning(true);
    try {
      const next = await adapter.relistImages(dir);
      setImages(next);
      showToast('info', `フォルダを再走査しました（${next.length} 枚）`);

      // 表示中の画像がフォルダから消えていたら整合を取る。
      // 放置すると保存も切替もできない孤立状態になる
      const file = currentFileRef.current;
      if (file !== null && !next.some((it) => it.file === file)) {
        const keepEdits =
          compositeDirtyRef.current &&
          !window.confirm(
            `表示中の「${file}」がフォルダに見つかりません。\n` +
              '未保存の変更を破棄して別の画像へ移動しますか？\n' +
              '（キャンセルするとこの画像を表示したままにします）'
          );
        if (keepEdits) {
          addBanner('error', `${file} がフォルダに見つかりません`, [
            '画像が移動・削除された可能性があります。保存してもアノテーションだけが残ります。',
            'フォルダに画像を戻すか、別の画像へ切り替えてください。',
          ]);
        } else {
          const fallback = next[0]?.file ?? null;
          if (fallback !== null) await loadImage(fallback);
          else clearCurrentImage();
          showToast('info', `「${file}」が見つからないため表示を切り替えました`);
        }
      }
    } catch {
      showToast('error', 'フォルダの再走査に失敗しました');
    } finally {
      setRescanning(false);
    }
  }, [adapter, addBanner, clearCurrentImage, dir, loadImage, showToast]);

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

  // ツールバーの表示設定（マグネット・反転・外接枠）は project.json に保存する
  // （次回起動時の初期値）。連打で書き込みが増えないよう 1.2 秒デバウンスで1本にまとめる。
  useEffect(() => {
    if (
      project.settings.magnet.enabled === magnetMode &&
      project.settings.magnet.invert === magnetInvert &&
      project.settings.showDerivedBoxes === showDerivedBoxes
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const next: Project = {
        ...project,
        settings: {
          ...project.settings,
          magnet: { enabled: magnetMode, invert: magnetInvert },
          showDerivedBoxes,
        },
        updatedAt: new Date().toISOString(),
      };
      setProject(next);
      void adapter.saveProjectFile(dir, next).catch(() => {
        showToast('error', 'ツール設定の保存に失敗しました');
      });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [adapter, dir, magnetInvert, magnetMode, showDerivedBoxes, project, showToast]);

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
      } else if (k === 'backspace') {
        // MacBook には Forward Delete キーが無い（delete の実体は Backspace）ため、
        // Delete と等価な全体削除を mod+Backspace にも割り当てる。
        // preventDefault は必須（ブラウザでは「戻る」等に化ける環境がある）。
        e.preventDefault();
        // 描画中は何もしない。draft の破棄は Esc の役割のままにする（誤爆防止）
        if (st.draft && st.draft.points.length > 0) return;
        handleDeleteSelected();
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
        // 修飾なしは 1つ戻す専任（全体削除は Delete / mod+Backspace）。
        // マグネットは 1 区間分まとめて戻す
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
        handleDeleteSelected();
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
        busy={busy}
        onDone={handleDone}
        onSkip={() => void handleSkip()}
        onExport={handleExport}
        onHelp={() => setHelpOpen(true)}
        onReveal={() => void adapter.revealInFolder(dir)}
        onCloseProject={() => {
          if (busyRef.current) return;
          if (
            compositeDirtyRef.current &&
            !window.confirm('未保存の変更があります。破棄して閉じますか？')
          ) {
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
            outOfFilterFile={outOfFilterFile}
            onFilterChange={setStatusFilter}
            onSelect={handleSelectImage}
            onRescan={() => void handleRescan()}
            rescanning={rescanning}
            busy={busy}
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
            showDerivedBoxes={showDerivedBoxes}
            brightness={brightness}
            contrast={contrast}
            lineWidth={st.lineWidth}
            selectedLineWidth={selectedLine ? selectedLine.lineMeta.width : null}
            hasSelection={selectedInEdit !== undefined}
            saving={saving}
            disabled={currentFile === null}
            busy={busy}
            lineEditAction={lineEditAction}
            onSetTool={setTool}
            onSetEditMode={() => {
              editor.dispatch({ type: 'setMode', mode: 'edit' });
              setLineEditAction('none');
            }}
            onToggleMagnet={() => setMagnetMode((v) => !v)}
            onToggleInvert={() => setMagnetInvert((v) => !v)}
            onToggleDerivedBoxes={() => setShowDerivedBoxes((v) => !v)}
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
            onDeleteSelected={handleDeleteSelected}
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
                showDerivedBoxes={showDerivedBoxes}
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
                  <kbd>Delete</kbd> <kbd>{DELETE_ALL_KEY_LABEL}</kbd> 全体削除
                </span>
              </>
            ) : selectedInEdit ? (
              <>
                <span>
                  <kbd>Delete</kbd> <kbd>{DELETE_ALL_KEY_LABEL}</kbd> 削除
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>1</kbd>〜<kbd>9</kbd> クラス変更
                </span>
                <span className="ga-hintbar__sep">/</span>
                <span>
                  <kbd>Esc</kbd> 選択解除
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
                <li>
                  Backspace は「1つ戻す」、Delete または {DELETE_ALL_KEY_LABEL} で選択したもの全体を削除
                </li>
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
