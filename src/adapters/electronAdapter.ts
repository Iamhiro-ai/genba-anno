// =============================================================================
// StorageAdapter の Electron 実装（M3）
//
// preload が公開する window.genbaAnno（src/shared/ipc.ts の GenbaAnnoIpc）を
// src/adapters/types.ts の StorageAdapter へ写像するだけの薄い層。
// パス結合・検証は一切ここで行わない（すべて main プロセスの責務）。
// =============================================================================

import type {
  ImageEntry,
  Project,
  RecentProject,
  SidecarFile,
  VideoExtractParams,
  VideoExtractProgress,
} from '../core/types';
import type { GenbaAnnoIpc } from '../shared/ipc';
import type { ExportWriter, OpenProjectResult, StorageAdapter } from './types';

function requireIpc(): GenbaAnnoIpc {
  const ipc = typeof window === 'undefined' ? undefined : window.genbaAnno;
  if (!ipc) {
    throw new Error(
      '[GenbaAnno] Electron の API が見つかりません（ブラウザで実行している場合は mockAdapter を使ってください）',
    );
  }
  return ipc;
}

/** window.genbaAnno が存在するか（getAdapter のアダプタ選択に使う） */
export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && window.genbaAnno != null;
}

/**
 * videoExtract の invoke が解決してから done 進捗を待つ猶予（ms）。
 * main は「最終進捗を send → invoke を解決」の順で処理するため通常は即座に届くが、
 * 万一取りこぼしてもここでハングしないようにする。
 */
const FINAL_PROGRESS_GRACE_MS = 1000;

export function createElectronAdapter(): StorageAdapter {
  return {
    kind: 'electron',

    // --- プロジェクト -----------------------------------------------------
    pickImageDirectory(): Promise<string | null> {
      return requireIpc().pickImageDir();
    },

    async openProject(dir: string): Promise<OpenProjectResult> {
      const result = await requireIpc().projectOpen(dir);
      return {
        dir: result.dir,
        project: result.project,
        images: result.images,
        corruptSidecars: result.corruptSidecars,
        // main が組み立てた日本語の警告をそのまま透過する（UI でトースト表示する想定）
        warnings: result.warnings ?? [],
      };
    },

    relistImages(dir: string): Promise<ImageEntry[]> {
      return requireIpc().projectRelist(dir);
    },

    listRecent(): Promise<RecentProject[]> {
      return requireIpc().projectListRecent();
    },

    saveProjectFile(dir: string, project: Project): Promise<void> {
      return requireIpc().projectSaveFile(dir, project);
    },

    // --- 画像・サイドカー -------------------------------------------------
    imageUrl(dir: string, file: string): string {
      return requireIpc().imageUrl(dir, file);
    },

    loadSidecar(dir: string, file: string): Promise<SidecarFile | null> {
      return requireIpc().sidecarLoad(dir, file);
    },

    saveSidecar(dir: string, file: string, data: SidecarFile): Promise<void> {
      return requireIpc().sidecarSave(dir, file, data);
    },

    loadAllSidecars(dir: string): Promise<{
      sidecars: { file: string; data: SidecarFile }[];
      corrupt: string[];
    }> {
      return requireIpc().sidecarLoadAll(dir);
    },

    // --- エクスポート -----------------------------------------------------
    pickDirectory(title: string): Promise<string | null> {
      return requireIpc().pickDir(title);
    },

    async beginExport(projectDir: string, destDir: string): Promise<ExportWriter> {
      const ipc = requireIpc();
      const session = await ipc.exportBegin(projectDir, destDir);
      let ended = false;
      return {
        async copyImage(srcFile: string, destRelPath: string): Promise<void> {
          if (ended) throw new Error('エクスポートセッションは終了しています');
          await ipc.exportCopyImage(session.sessionId, srcFile, destRelPath);
        },
        async writeFile(destRelPath: string, data: Uint8Array | string): Promise<void> {
          if (ended) throw new Error('エクスポートセッションは終了しています');
          await ipc.exportWriteFile(session.sessionId, destRelPath, data);
        },
        async end(): Promise<void> {
          if (ended) return;
          ended = true;
          await ipc.exportEnd(session.sessionId);
        },
      };
    },

    // --- 動画フレーム抽出 -------------------------------------------------
    videoSupported: true,

    pickVideoFile(): Promise<string | null> {
      return requireIpc().pickVideo();
    },

    async extractFrames(
      params: VideoExtractParams,
      onProgress: (p: VideoExtractProgress) => void,
    ): Promise<void> {
      const ipc = requireIpc();
      let failure: string | null = null;
      let resolveFinal: (() => void) | null = null;
      const finalProgress = new Promise<void>((resolve) => {
        resolveFinal = resolve;
      });

      const unsubscribe = ipc.onVideoExtractProgress((progress) => {
        onProgress(progress);
        if (progress.done) {
          if (progress.error) failure = progress.error;
          resolveFinal?.();
        }
      });

      try {
        // main は成功・失敗にかかわらず解決し、失敗内容は done 付き進捗で通知する
        await ipc.videoExtract(params);
        await Promise.race([
          finalProgress,
          new Promise<void>((resolve) => setTimeout(resolve, FINAL_PROGRESS_GRACE_MS)),
        ]);
      } finally {
        unsubscribe();
      }

      if (failure) throw new Error(failure);
    },

    // --- その他 -----------------------------------------------------------
    revealInFolder(absPath: string): Promise<void> {
      return requireIpc().shellReveal(absPath);
    },

    appVersion(): Promise<string> {
      return requireIpc().appVersion();
    },
  };
}
