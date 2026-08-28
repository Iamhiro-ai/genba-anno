// =============================================================================
// ショートカット一覧オーバーレイ（M5）
// docs/DESIGN.md §4 の全ショートカット + GenbaAnno で追加したもの（R / E / A・D / I）。
// =============================================================================

import { Keyboard } from 'lucide-react';
import { Modal } from './Modal';
import { Btn, DELETE_ALL_KEY_LABEL, IS_MAC } from './ui';
import { DONE_HELP_TEXT } from './StatusHeader';

interface Row {
  keys: string;
  desc: string;
}

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: 'ツール',
    rows: [
      { keys: 'R', desc: 'バウンディングボックス（ドラッグで描画・8ハンドルでリサイズ）' },
      { keys: 'W / N', desc: 'ポリゴン（クリックで頂点追加・始点クリック / Enter で確定）' },
      { keys: 'L', desc: 'ライン（マグネットライン。既定ツール）' },
      { keys: 'V', desc: '編集モード' },
      { keys: 'M', desc: 'マグネット ON/OFF（暗い筋に吸着）' },
      { keys: 'I', desc: '反転モード ON/OFF（白線など明るい線を追う）' },
      { keys: '1〜9', desc: 'クラス選択（選択中アノテーションのクラスも変わる）' },
    ],
  },
  {
    title: '描画中',
    rows: [
      { keys: 'Tab', desc: 'マグネットのゴースト経路をそのまま確定（1クリック+カーソル+Tab で1本）' },
      { keys: 'Enter', desc: 'ドラフトを確定' },
      { keys: 'Backspace', desc: '1つ戻す（マグネットは1区間ずつ）' },
      { keys: 'Esc', desc: '描画を破棄 → 選択解除 → 編集モード（この順に効く）' },
    ],
  },
  {
    title: '選択中',
    rows: [
      { keys: '端点◻クリック', desc: 'ラインを延長（続きを描いて Enter）' },
      { keys: 'C', desc: 'ラインの短縮（中心線をクリックして切断位置を指定）' },
      { keys: 'B', desc: 'ラインの分岐（中心線をクリックして枝を描く）' },
      { keys: '[ / ]', desc: '線幅 − / ＋（テーパー形状を保ったまま全体スケール）' },
      { keys: 'Backspace', desc: 'ライン=末尾の中心線点 / 多角形=末尾頂点を1つ削除' },
      {
        keys: `Delete または ${DELETE_ALL_KEY_LABEL}`,
        desc:
          '選択中のアノテーションを全体削除（Ctrl+Z で戻せます）' +
          // MacBook のキーボードには Forward Delete が無く、delete の実体は Backspace
          (IS_MAC ? '。MacBook では ⌘ + delete で押せます' : ''),
      },
    ],
  },
  {
    title: '画像・保存',
    rows: [
      { keys: '← / → , A / D', desc: '前 / 次の画像（未保存なら自動保存してから切替）' },
      { keys: 'E', desc: `保存して完了(done)にし次へ。${DONE_HELP_TEXT}` },
      { keys: 'X', desc: 'スキップ(skipped)にして次へ（エクスポート対象外）' },
      { keys: 'Ctrl / Cmd + S', desc: '保存（30秒ごとの自動保存もあります）' },
      { keys: 'Ctrl / Cmd + Z', desc: '元に戻す（+ Shift でやり直し）' },
    ],
  },
  {
    title: '表示',
    rows: [
      { keys: 'F', desc: '画面にフィット' },
      { keys: 'T', desc: '塗りつぶし表示の切替' },
      { keys: 'Ctrl / Cmd + ホイール', desc: 'ズーム（カーソル中心）' },
      { keys: 'Space + ドラッグ / 中ボタン / ホイール', desc: 'パン' },
      { keys: '? / H', desc: 'このヘルプを開閉' },
    ],
  },
];

export function ShortcutHelp({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  return (
    <Modal
      open={open}
      title="キーボードショートカット"
      onClose={onClose}
      icon={<Keyboard size={18} aria-hidden="true" />}
      footer={
        <Btn className="ga-btn--primary" onClick={onClose}>
          閉じる
        </Btn>
      }
    >
      <div className="ga-shortcuts">
        {SECTIONS.map((sec) => (
          <div key={sec.title} style={{ display: 'contents' }}>
            <h3 className="ga-section__title">{sec.title}</h3>
            {sec.rows.map((r) => (
              <div key={r.keys} style={{ display: 'contents' }}>
                <kbd className="ga-kbd">{r.keys}</kbd>
                <span className="ga-shortcuts__desc">{r.desc}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="ga-note">
        入力欄（テキストボックス等）にフォーカスがあるときは、これらのショートカットは無効になります。
      </p>
    </Modal>
  );
}
