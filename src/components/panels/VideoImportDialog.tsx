// =============================================================================
// 動画フレーム切り出しダイアログ（M5 / 機能は M7）
//
// M3 申し送り: **エラーは onProgress の error と Promise の reject の両方から来る**
//   （electronAdapter は done 付き進捗で failure を拾い、その後 throw する）。
//   同じ内容を 2 回出さないよう、先に受け取った方だけを表示する。
//
// ブラウザ実行（mockAdapter）では videoSupported=false なので、
// 呼び出し側（Welcome 画面）がボタンごと出さない。
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileVideo, Film, FolderOpen } from 'lucide-react';
import type { StorageAdapter } from '../../adapters/types';
import type { VideoExtractParams } from '../../core/types';
import { Modal } from './Modal';
import { Btn } from './ui';

type RunState = 'idle' | 'running' | 'done' | 'error';

export interface VideoImportDialogProps {
  open: boolean;
  onClose: () => void;
  adapter: StorageAdapter;
  /** 切り出したフォルダをそのままプロジェクトとして開く */
  onOpenDir: (dir: string) => void;
}

export function VideoImportDialog({
  open,
  onClose,
  adapter,
  onOpenDir,
}: VideoImportDialogProps): React.ReactElement | null {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [mode, setMode] = useState<'fps' | 'every_n'>('fps');
  const [value, setValue] = useState(1);
  const [format, setFormat] = useState<'jpg' | 'png'>('jpg');
  const [quality, setQuality] = useState(2);
  const [maxLongEdge, setMaxLongEdge] = useState<number | ''>('');

  const [state, setState] = useState<RunState>('idle');
  const [frames, setFrames] = useState(0);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** onProgress と reject の二重通知を 1 回に潰すためのフラグ */
  const errorSeenRef = useRef(false);

  useEffect(() => {
    if (open) {
      setVideoPath(null);
      setState('idle');
      setFrames(0);
      setDestDir(null);
      setError(null);
      errorSeenRef.current = false;
    }
  }, [open]);

  const reportError = (message: string): void => {
    if (errorSeenRef.current) return;
    errorSeenRef.current = true;
    setError(message);
    setState('error');
  };

  const handlePickVideo = async (): Promise<void> => {
    // ファイル選択も reject し得る。握り潰すと押しても無反応に見える
    try {
      const picked = await adapter.pickVideoFile();
      if (picked === null) return;
      setVideoPath(picked);
      setError(null);
      setState('idle');
      errorSeenRef.current = false;
    } catch (e) {
      errorSeenRef.current = false;
      reportError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRun = async (): Promise<void> => {
    if (!videoPath) return;
    try {
      const dest = await adapter.pickDirectory('切り出したフレームの保存先フォルダを選択');
      if (dest === null) return; // キャンセルは何も起きないのが正しい

      const params: VideoExtractParams = {
        videoPath,
        destDir: dest,
        mode,
        value,
        format,
        quality,
        ...(typeof maxLongEdge === 'number' && maxLongEdge > 0 ? { maxLongEdge } : {}),
      };

      setState('running');
      setFrames(0);
      setError(null);
      errorSeenRef.current = false;
      await adapter.extractFrames(params, (p) => {
        setFrames(p.framesWritten);
        if (p.error) reportError(p.error);
      });
      if (!errorSeenRef.current) {
        setDestDir(dest);
        setState('done');
      }
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
    }
  };

  const running = state === 'running';

  return (
    <Modal
      open={open}
      title="動画からフレームを切り出す"
      onClose={onClose}
      icon={<Film size={18} aria-hidden="true" />}
      closeDisabled={running}
      footer={
        state === 'done' && destDir ? (
          <>
            <Btn onClick={() => void adapter.revealInFolder(destDir)}>
              <FolderOpen size={15} aria-hidden="true" />
              フォルダを開く
            </Btn>
            <Btn
              className="ga-btn--primary"
              onClick={() => {
                onOpenDir(destDir);
                onClose();
              }}
            >
              このフォルダをプロジェクトとして開く
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
              disabled={running || !videoPath}
            >
              {running ? '切り出し中…' : '保存先を選んで実行'}
            </Btn>
          </>
        )
      }
    >
      {error && (
        <div className="ga-banner ga-banner--error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span className="ga-banner__body">
            <span className="ga-banner__title">フレーム切り出しに失敗しました</span>
            <br />
            {error}
          </span>
        </div>
      )}

      <div className="ga-field">
        <span className="ga-field__label">動画ファイル</span>
        <div className="ga-row">
          <Btn onClick={() => void handlePickVideo()} disabled={running}>
            <FileVideo size={15} aria-hidden="true" />
            動画を選択
          </Btn>
          <span className="ga-field__hint">{videoPath ?? '未選択'}</span>
        </div>
      </div>

      <div className="ga-grid2">
        <div className="ga-field">
          <label className="ga-field__label" htmlFor="ga-video-mode">
            切り出し間隔
          </label>
          <select
            id="ga-video-mode"
            className="ga-select"
            value={mode}
            disabled={running}
            onChange={(e) => setMode(e.target.value === 'every_n' ? 'every_n' : 'fps')}
          >
            <option value="fps">毎秒 n 枚（fps）</option>
            <option value="every_n">n フレームごと</option>
          </select>
        </div>
        <div className="ga-field">
          <label className="ga-field__label" htmlFor="ga-video-value">
            {mode === 'fps' ? '毎秒の枚数' : 'フレーム間隔'}
          </label>
          <input
            id="ga-video-value"
            className="ga-input"
            type="number"
            min={mode === 'fps' ? 0.1 : 1}
            step={mode === 'fps' ? 0.1 : 1}
            value={value}
            disabled={running}
            onChange={(e) => setValue(Number(e.target.value) || 1)}
          />
        </div>
      </div>

      <div className="ga-grid2">
        <div className="ga-field">
          <label className="ga-field__label" htmlFor="ga-video-format">
            画像形式
          </label>
          <select
            id="ga-video-format"
            className="ga-select"
            value={format}
            disabled={running}
            onChange={(e) => setFormat(e.target.value === 'png' ? 'png' : 'jpg')}
          >
            <option value="jpg">JPEG（容量が小さい・推奨）</option>
            <option value="png">PNG（劣化なし・容量大）</option>
          </select>
        </div>
        {format === 'jpg' && (
          <div className="ga-field">
            <label className="ga-field__label" htmlFor="ga-video-quality">
              JPEG 画質: {quality}（小さいほど高画質）
            </label>
            <input
              id="ga-video-quality"
              type="range"
              min={2}
              max={31}
              step={1}
              value={quality}
              disabled={running}
              onChange={(e) => setQuality(Number(e.target.value))}
            />
          </div>
        )}
      </div>

      <div className="ga-field">
        <label className="ga-field__label" htmlFor="ga-video-longedge">
          長辺の上限（px・空欄なら原寸）
        </label>
        <input
          id="ga-video-longedge"
          className="ga-input"
          type="number"
          min={0}
          placeholder="原寸のまま"
          value={maxLongEdge}
          disabled={running}
          onChange={(e) => setMaxLongEdge(e.target.value === '' ? '' : Number(e.target.value))}
        />
        <span className="ga-field__hint">
          4K 動画をそのまま切り出すと 1 枚が大きくなります。2000 前後にすると扱いやすくなります。
        </span>
      </div>

      {(running || state === 'done') && (
        <p className="ga-field__hint" role="status">
          切り出し済み: {frames} 枚{state === 'done' ? '（完了）' : '…'}
        </p>
      )}
    </Modal>
  );
}
