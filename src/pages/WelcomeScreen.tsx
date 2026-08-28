// =============================================================================
// Welcome 画面（M5）— プロジェクト（画像フォルダ）を開くまでの画面。
//
// 本ツールは「フォルダを選ぶだけ」が売り（DESIGN.md R1）なので、
// この画面ですることは実質 1 つ（フォルダを開く）に絞る。
// =============================================================================

import { AlertTriangle, Film, FolderOpen, History, Loader2, Sparkles } from 'lucide-react';
import type { RecentProject } from '../core/types';
import { Btn } from '../components/panels/ui';

export interface WelcomeScreenProps {
  /** mock（ブラウザ実行）なら true。サンプルボタンを出す */
  isMock: boolean;
  videoSupported: boolean;
  opening: boolean;
  error: string | null;
  recent: RecentProject[];
  onPickFolder: () => void;
  onOpenRecent: (dir: string) => void;
  onOpenSample: () => void;
  onOpenVideoImport: () => void;
  appVersion: string;
}

export function WelcomeScreen({
  isMock,
  videoSupported,
  opening,
  error,
  recent,
  onPickFolder,
  onOpenRecent,
  onOpenSample,
  onOpenVideoImport,
  appVersion,
}: WelcomeScreenProps): React.ReactElement {
  return (
    <main className="ga-welcome">
      <div className="ga-welcome__card">
        <div>
          <h1 className="ga-welcome__title">GenbaAnno（現場アノ）</h1>
          <p className="ga-welcome__lead">
            画像フォルダを選ぶだけで使える、現場向けの学習データ作成ツールです。
            バウンディングボックスと、ひび割れに吸着するマグネットラインで
            物体検出・セグメンテーションの教師データを作れます。
          </p>
        </div>

        {error && (
          <div className="ga-banner ga-banner--error" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span className="ga-banner__body">
              <span className="ga-banner__title">フォルダを開けませんでした</span>
              <br />
              {error}
            </span>
          </div>
        )}

        <div className="ga-welcome__box">
          <h2 className="ga-panel__title">はじめる</h2>
          <ol className="ga-welcome__steps">
            <li>撮影した画像を 1 つのフォルダにまとめる（サブフォルダは読みません）</li>
            <li>下のボタンでそのフォルダを開く</li>
            <li>
              アノテーションはフォルダ内の <code>_anno/</code> に保存されます
              （フォルダごとコピーすればデータも一緒に移動します）
            </li>
          </ol>
          <div className="ga-row">
            <Btn className="ga-btn--primary ga-btn--lg" onClick={onPickFolder} disabled={opening}>
              {opening ? (
                <Loader2 size={20} aria-hidden="true" className="ga-spin" />
              ) : (
                <FolderOpen size={20} aria-hidden="true" />
              )}
              {opening ? '読み込み中…' : '画像フォルダを開く'}
            </Btn>
            {isMock && (
              <Btn className="ga-btn--lg" onClick={onOpenSample} disabled={opening}>
                <Sparkles size={20} aria-hidden="true" />
                サンプルで試す
              </Btn>
            )}
            {videoSupported && (
              <Btn className="ga-btn--lg" onClick={onOpenVideoImport} disabled={opening}>
                <Film size={20} aria-hidden="true" />
                動画からフレームを切り出す
              </Btn>
            )}
          </div>
          {isMock && (
            <p className="ga-note">
              ブラウザ実行（Mock）モードです。生成したサンプル画像で操作を試せますが、
              保存内容はページを閉じると消えます。実際のフォルダを扱うにはデスクトップ版
              （Electron）を使ってください。
            </p>
          )}
        </div>

        {recent.length > 0 && (
          <div className="ga-welcome__box">
            <h2 className="ga-panel__title">
              <History size={15} aria-hidden="true" /> 最近使ったフォルダ
            </h2>
            <div className="ga-recent">
              {recent.map((r) => (
                <button
                  key={r.dir}
                  type="button"
                  className="ga-recent__btn"
                  disabled={opening}
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onOpenRecent(r.dir);
                  }}
                >
                  <span className="ga-recent__name">{r.name}</span>
                  <span className="ga-recent__dir">{r.dir}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="ga-note">GenbaAnno {appVersion}</p>
      </div>
    </main>
  );
}
