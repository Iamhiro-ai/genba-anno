// =============================================================================
// App（M5 統合）— Welcome 画面とエディタ画面の 2 画面構成。
//
// ここが受け持つのは「プロジェクト（画像フォルダ）を開くまで」だけ。
// 開いた後の統括ロジックは EditorPage が持つ（画像ごとの状態を dir 単位で
// 作り直せるよう key={dir} でマウントし直す）。
//
// M3 申し送り: adapter は getAdapter() のシングルトンを使う。
//   mock は openProject の解決後でないと imageUrl が空文字を返す（サンプル生成が非同期）。
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAdapter } from '../adapters';
import { VideoImportDialog } from '../components/panels/VideoImportDialog';
import { createDefaultProject } from '../core/serialize';
import type { ImageEntry, Project, RecentProject } from '../core/types';
// window.genbaAnno の型（GenbaAnnoIpc）を持ち込むための型のみの import
import type {} from '../shared/ipc';
import '../styles/app.css';
import { DevCanvasHarness } from './DevCanvasHarness';
import { EditorPage } from './EditorPage';
import { WelcomeScreen } from './WelcomeScreen';

/** M4 開発検証: `?harness=canvas` のときだけキャンバス検証ページを出す */
function isCanvasHarness(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('harness') === 'canvas';
}

/** 絶対パスの末尾セグメント（Windows の `\` 区切りにも対応）。プロジェクト名の既定値 */
function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? dir;
}

interface Session {
  dir: string;
  project: Project;
  images: ImageEntry[];
  warnings: string[];
  corruptSidecars: string[];
}

export function App(): React.ReactElement {
  const adapter = useMemo(() => getAdapter(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  /** openProject の世代。遅れて解決した古い応答でセッションを差し替えないため */
  const openGenRef = useRef(0);
  /** フォルダ選択〜オープン完了までの同期フラグ（起動系操作の二重実行防止） */
  const openingRef = useRef(false);

  const refreshRecent = useCallback(() => {
    adapter
      .listRecent()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [adapter]);

  useEffect(() => {
    refreshRecent();
    adapter
      .appVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(''));
  }, [adapter, refreshRecent]);

  const openDir = useCallback(
    async (dir: string): Promise<void> => {
      // 起動系操作の二重実行を止める（フォルダ選択・最近使ったフォルダ・動画取り込みの同時押し）
      if (openingRef.current) return;
      openingRef.current = true;
      // 世代管理: 遅れて解決した古い open がセッションを上書きしないようにする
      const gen = ++openGenRef.current;
      setOpening(true);
      setOpenError(null);
      try {
        const result = await adapter.openProject(dir);
        if (gen !== openGenRef.current) return;
        const warnings = [...result.warnings];
        let project = result.project;

        if (!project) {
          // ここがクラス定義（= エクスポートの学習 ID）を置き換える瞬間。
          // 壊れた原本を退避した直後なら、黙って上書きせず必ず確認する（M3 申し送り）。
          if (result.lossy) {
            const ok = window.confirm(
              '元の設定ファイル（project.json）が壊れていたため退避しました。\n' +
                'デフォルト設定で続行しますか？\n\n' +
                '※ クラス定義（エクスポート時の学習 ID の並び）が既定のものに置き換わります。'
            );
            if (!ok) return;
          }
          const created = createDefaultProject(folderName(result.dir));
          await adapter.saveProjectFile(result.dir, created);
          if (gen !== openGenRef.current) return;
          project = created;
          warnings.push(
            'project.json が無かったため、デフォルト設定（クラス: ひび割れ）で新規作成しました。'
          );
        }

        setSession({
          dir: result.dir,
          project,
          images: result.images,
          warnings,
          corruptSidecars: result.corruptSidecars,
        });
        refreshRecent();
      } catch (e) {
        if (gen === openGenRef.current) {
          setOpenError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        openingRef.current = false;
        if (gen === openGenRef.current) setOpening(false);
      }
    },
    [adapter, refreshRecent]
  );

  const handlePickFolder = useCallback(() => {
    // ネイティブのフォルダ選択ダイアログを出している間もボタンを止める
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setOpenError(null);
    void (async () => {
      let picked: string | null = null;
      try {
        picked = await adapter.pickImageDirectory();
      } catch (e) {
        setOpenError(e instanceof Error ? e.message : String(e));
      } finally {
        // openDir が自分でフラグを立て直すので、ここでは必ず解放する
        openingRef.current = false;
        setOpening(false);
      }
      if (picked !== null) await openDir(picked);
    })();
  }, [adapter, openDir]);

  // フックを全て呼んだ後に分岐する（Rules of Hooks 順守）
  if (isCanvasHarness()) return <DevCanvasHarness />;

  if (session) {
    return (
      <EditorPage
        key={session.dir}
        adapter={adapter}
        dir={session.dir}
        project={session.project}
        images={session.images}
        openWarnings={session.warnings}
        corruptSidecars={session.corruptSidecars}
        onCloseProject={() => setSession(null)}
      />
    );
  }

  return (
    <>
      <WelcomeScreen
        isMock={adapter.kind === 'mock'}
        videoSupported={adapter.videoSupported}
        opening={opening}
        error={openError}
        recent={recent}
        appVersion={appVersion}
        onPickFolder={handlePickFolder}
        onOpenRecent={(dir) => void openDir(dir)}
        onOpenSample={handlePickFolder}
        onOpenVideoImport={() => setVideoOpen(true)}
      />
      {adapter.videoSupported && (
        <VideoImportDialog
          open={videoOpen}
          onClose={() => setVideoOpen(false)}
          adapter={adapter}
          onOpenDir={(dir) => void openDir(dir)}
        />
      )}
    </>
  );
}
