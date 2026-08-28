// =============================================================================
// アプリヘッダ（M5）— プロジェクト名・進捗・保存状態・完了/スキップ・エクスポート。
//
// 「完了」の説明文は事故防止のため title にも入れる（DESIGN.md §2 ステータス運用）:
//   損傷が無い画像も「完了」にすると **負例（教師データ）** になる。
//   pending / skipped はエクスポートに一切含まれない。
// =============================================================================

import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  FolderOpen,
  HelpCircle,
  Loader2,
  LogOut,
  SkipForward,
} from 'lucide-react';
import type { AnnotationStatus } from '../../core/types';
import { Btn, IconBtn, StatusBadge } from './ui';

export type SaveState = 'saved' | 'dirty' | 'saving';

export const DONE_HELP_TEXT =
  '保存して「完了」にします (E)。損傷が無い画像も「完了」にすると負例（対象物なしの教師データ）として学習に使われます。未着手・スキップはエクスポートに含まれません。';

export interface StatusHeaderProps {
  projectName: string;
  doneCount: number;
  totalCount: number;
  saveState: SaveState;
  currentFile: string | null;
  currentStatus: AnnotationStatus | null;
  busy: boolean;
  onDone: () => void;
  onSkip: () => void;
  onExport: () => void;
  onHelp: () => void;
  onReveal: () => void;
  onCloseProject: () => void;
}

export function StatusHeader({
  projectName,
  doneCount,
  totalCount,
  saveState,
  currentFile,
  currentStatus,
  busy,
  onDone,
  onSkip,
  onExport,
  onHelp,
  onReveal,
  onCloseProject,
}: StatusHeaderProps): React.ReactElement {
  const ratio = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <header className="ga-header">
      <div className="ga-header__brand">
        <span className="ga-header__app">GenbaAnno</span>
        <span className="ga-header__project" title={projectName}>
          {projectName}
        </span>
      </div>

      {currentFile ? (
        <div className="ga-header__progress">
          <span className="ga-header__project" title={currentFile}>
            {currentFile}
          </span>
          {currentStatus ? <StatusBadge status={currentStatus} /> : null}
        </div>
      ) : null}

      <span className="ga-spacer" />

      <div className="ga-header__progress">
        <span>
          完了 {doneCount} / {totalCount}
        </span>
        <span
          className="ga-progressbar"
          role="progressbar"
          aria-valuenow={ratio}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="完了率"
        >
          <span className="ga-progressbar__fill" style={{ width: `${ratio}%` }} />
        </span>
      </div>

      {saveState === 'saving' ? (
        <span className="ga-savestate ga-savestate--saving">
          <Loader2 size={14} aria-hidden="true" className="ga-spin" /> 保存中
        </span>
      ) : saveState === 'dirty' ? (
        <span className="ga-savestate ga-savestate--dirty">
          <AlertCircle size={14} aria-hidden="true" /> 未保存
        </span>
      ) : (
        <span className="ga-savestate ga-savestate--saved">
          <CheckCircle2 size={14} aria-hidden="true" /> 保存済み
        </span>
      )}

      <div className="ga-header__actions">
        <Btn
          className="ga-btn--sm ga-btn--success"
          onClick={onDone}
          disabled={busy || currentFile === null}
          title={DONE_HELP_TEXT}
        >
          <Check size={14} aria-hidden="true" />
          完了して次へ (E)
        </Btn>
        <Btn
          className="ga-btn--sm"
          onClick={onSkip}
          disabled={busy || currentFile === null}
          title="この画像をスキップして次へ (X)。スキップした画像はエクスポートに含まれません"
        >
          <SkipForward size={14} aria-hidden="true" />
          スキップ (X)
        </Btn>
        <Btn className="ga-btn--sm" onClick={onExport} disabled={busy}>
          <Download size={14} aria-hidden="true" />
          エクスポート
        </Btn>
        <IconBtn label="ショートカット一覧 (?)" onClick={onHelp}>
          <HelpCircle size={18} aria-hidden="true" />
        </IconBtn>
        <IconBtn label="画像フォルダを開く" onClick={onReveal}>
          <FolderOpen size={18} aria-hidden="true" />
        </IconBtn>
        <IconBtn label="プロジェクトを閉じる" onClick={onCloseProject}>
          <LogOut size={18} aria-hidden="true" />
        </IconBtn>
      </div>
    </header>
  );
}
