// =============================================================================
// App — M0 スキャフォールドの起動確認用の仮画面。
//
// !!! M5（画面統合）で本実装（Welcome / エディタ統合）に置き換えます。!!!
//   ここでは「Electron でもブラウザでも同じレンダラが起動する」ことだけを確認する。
// =============================================================================

import { useEffect, useState } from 'react';
// window.genbaAnno の型（GenbaAnnoIpc）を持ち込むための型のみの import
import type {} from '../shared/ipc';
import { DevCanvasHarness } from './DevCanvasHarness';

type RuntimeMode = 'electron' | 'browser';

function detectRuntimeMode(): RuntimeMode {
  return typeof window !== 'undefined' && window.genbaAnno ? 'electron' : 'browser';
}

/** M4 開発検証: `?harness=canvas` のときだけキャンバス検証ページを出す（M5 が本実装で置き換える） */
function isCanvasHarness(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('harness') === 'canvas';
}

const MODE_LABEL: Record<RuntimeMode, string> = {
  electron: 'Electron',
  browser: 'ブラウザ（Mock）',
};

export function App(): React.ReactElement {
  const mode = detectRuntimeMode();
  const [version, setVersion] = useState<string>('取得中…');

  useEffect(() => {
    const ipc = window.genbaAnno;
    if (!ipc) {
      // ブラウザ実行時は package.json の version をビルド時に埋め込む余地があるが、
      // M0 では固定表示に留める（M3 で mockAdapter が返す）。
      setVersion('0.1.0 (mock)');
      return;
    }

    let alive = true;
    ipc
      .appVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch((err: unknown) => {
        if (alive) setVersion(`取得失敗: ${String(err)}`);
      });

    return () => {
      alive = false;
    };
  }, []);

  // フックを全て呼んだ後に分岐する（Rules of Hooks 順守）
  if (isCanvasHarness()) return <DevCanvasHarness />;

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <h1 style={styles.title}>GenbaAnno</h1>
        <p style={styles.subtitle}>
          現場向け学習データ作成アノテーションツール（スキャフォールド起動確認画面）
        </p>

        <dl style={styles.list}>
          <div style={styles.row}>
            <dt style={styles.term}>実行モード</dt>
            <dd style={styles.desc}>
              <span style={mode === 'electron' ? styles.badgeElectron : styles.badgeBrowser}>
                {MODE_LABEL[mode]}
              </span>
            </dd>
          </div>
          <div style={styles.row}>
            <dt style={styles.term}>バージョン</dt>
            <dd style={styles.desc} data-numeric="">
              {version}
            </dd>
          </div>
        </dl>

        <p style={styles.note}>
          この画面は M0（土台構築）の動作確認用です。実際のエディタ画面は M4 / M5 で実装されます。
        </p>
      </div>
    </main>
  );
}

// M0 の仮画面のためインラインスタイル。M5 以降は CSS Modules / クラスへ移行する。
const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100%',
    display: 'grid',
    placeItems: 'center',
    padding: 'var(--ga-space-6)',
    backgroundColor: 'var(--ga-color-bg-subtle)',
  },
  card: {
    width: 'min(560px, 100%)',
    padding: 'var(--ga-space-6)',
    backgroundColor: 'var(--ga-color-bg)',
    border: 'var(--ga-border-width) solid var(--ga-color-border)',
    borderRadius: 'var(--ga-radius-lg)',
    boxShadow: 'var(--ga-shadow-md)',
  },
  title: {
    fontSize: 'var(--ga-font-size-3xl)',
    color: 'var(--ga-color-primary)',
    marginBottom: 'var(--ga-space-2)',
  },
  subtitle: {
    fontSize: 'var(--ga-font-size-sm)',
    color: 'var(--ga-color-text-muted)',
    marginBottom: 'var(--ga-space-5)',
  },
  list: {
    display: 'grid',
    gap: 'var(--ga-space-3)',
    margin: 0,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '8rem 1fr',
    alignItems: 'center',
    gap: 'var(--ga-space-3)',
  },
  term: {
    fontSize: 'var(--ga-font-size-sm)',
    fontWeight: 'var(--ga-font-weight-bold)' as React.CSSProperties['fontWeight'],
    color: 'var(--ga-color-text-muted)',
  },
  desc: {
    margin: 0,
    fontSize: 'var(--ga-font-size-md)',
  },
  badgeElectron: {
    display: 'inline-block',
    padding: 'var(--ga-space-1) var(--ga-space-3)',
    borderRadius: 'var(--ga-radius-full)',
    backgroundColor: 'var(--ga-color-primary-surface)',
    color: 'var(--ga-color-primary)',
    fontSize: 'var(--ga-font-size-sm)',
    fontWeight: 700,
  },
  badgeBrowser: {
    display: 'inline-block',
    padding: 'var(--ga-space-1) var(--ga-space-3)',
    borderRadius: 'var(--ga-radius-full)',
    backgroundColor: 'var(--ga-color-warning-surface)',
    color: 'var(--ga-color-warning-text)',
    fontSize: 'var(--ga-font-size-sm)',
    fontWeight: 700,
  },
  note: {
    marginTop: 'var(--ga-space-5)',
    paddingTop: 'var(--ga-space-4)',
    borderTop: 'var(--ga-border-width) solid var(--ga-color-border-subtle)',
    fontSize: 'var(--ga-font-size-xs)',
    color: 'var(--ga-color-text-subtle)',
  },
};
