// =============================================================================
// トースト（4秒で消える通知）と警告バナー（消えない・閉じるボタン付き）（M5）
//
// 使い分け（M5 の設計判断）:
//   - トースト: 見逃しても実害が無い操作結果（保存しました・直線にしました 等）
//   - バナー: 見逃すとデータ事故になる警告（サイドカー修復・寸法不一致・壊れたファイル）。
//     参照実装はトーストで流していたが、GenbaAnno は「保存すると元データが失われる」系の
//     警告を扱うため、ユーザーが自分で閉じるまで残す。
// =============================================================================

import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { IconBtn } from './ui';

export type ToastKind = 'info' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export function ToastStack({ items }: { items: ToastItem[] }): React.ReactElement {
  return (
    <div className="ga-toasts" aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div key={t.id} className={t.kind === 'error' ? 'ga-toast ga-toast--error' : 'ga-toast'}>
          {t.kind === 'error' ? (
            <AlertTriangle size={16} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={16} aria-hidden="true" />
          )}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export type BannerKind = 'warning' | 'error' | 'info';

export interface BannerItem {
  id: number;
  kind: BannerKind;
  title: string;
  /** 詳細（0件ならタイトルのみ表示） */
  messages: string[];
}

export function BannerStack({
  items,
  onDismiss,
}: {
  items: BannerItem[];
  onDismiss: (id: number) => void;
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="ga-banners">
      {items.map((b) => (
        <div
          key={b.id}
          className={
            b.kind === 'error'
              ? 'ga-banner ga-banner--error'
              : b.kind === 'info'
                ? 'ga-banner ga-banner--info'
                : 'ga-banner'
          }
          role={b.kind === 'error' ? 'alert' : 'status'}
        >
          {b.kind === 'info' ? (
            <Info size={18} aria-hidden="true" />
          ) : (
            <AlertTriangle size={18} aria-hidden="true" />
          )}
          <div className="ga-banner__body">
            <p className="ga-banner__title">{b.title}</p>
            {b.messages.length > 0 && (
              <ul className="ga-banner__list">
                {b.messages.map((m, i) => (
                  <li key={`${b.id}-${String(i)}`}>{m}</li>
                ))}
              </ul>
            )}
          </div>
          <IconBtn
            className="ga-icon-btn--sm"
            label="この警告を閉じる"
            onClick={() => onDismiss(b.id)}
          >
            <X size={16} aria-hidden="true" />
          </IconBtn>
        </div>
      ))}
    </div>
  );
}
