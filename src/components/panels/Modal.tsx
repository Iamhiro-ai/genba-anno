// =============================================================================
// モーダルダイアログの共通シェル（M5）
//
// アクセシビリティ要件（CLAUDE.md 設計ルール6 / デジタル庁デザインシステム）:
//   - role="dialog" aria-modal="true" + aria-labelledby でタイトルと結びつける
//   - Esc で閉じる（ページ側のショートカットはモーダル表示中すべて無効になるため、
//     Esc の面倒はモーダル自身が見る）
//   - 開いたらダイアログ内の先頭要素へフォーカス、閉じたら元の要素へ戻す
//   - Tab はダイアログ内で循環させる（背面のキャンバスへフォーカスを漏らさない。
//     AnnotationCanvas の Tab ハンドラは shortcutsSuspended で止めてある）
// =============================================================================

import { useCallback, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconBtn } from './ui';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 'narrow' | 'wide'。既定は標準幅 */
  size?: 'narrow' | 'wide';
  /** 実行中など、閉じさせたくないとき true（Esc・オーバーレイ・×を無効化） */
  closeDisabled?: boolean;
  icon?: ReactNode;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size,
  closeDisabled,
  icon,
}: ModalProps): React.ReactElement | null {
  // 同時に複数のモーダルが DOM に居ても aria-labelledby が衝突しないようインスタンス固有 ID にする
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const closeDisabledRef = useRef(false);
  closeDisabledRef.current = closeDisabled === true;

  const requestClose = useCallback(() => {
    if (closeDisabledRef.current) return;
    onClose();
  }, [onClose]);

  // 開閉に伴うフォーカス移動（開いたら先頭要素へ / 閉じたら元の要素へ）
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    if (node) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [open]);

  // Esc で閉じる / Tab をダイアログ内で循環させる
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = dialogRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    // capture で拾い、ページ側の window keydown より先に処理する
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, requestClose]);

  if (!open) return null;

  const cls =
    size === 'wide' ? 'ga-modal ga-modal--wide' : size === 'narrow' ? 'ga-modal ga-modal--narrow' : 'ga-modal';

  return (
    <div
      className="ga-modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className={cls}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="ga-modal__head">
          {icon}
          <h2 className="ga-modal__title" id={titleId}>
            {title}
          </h2>
          <span className="ga-spacer" />
          <IconBtn label="閉じる" onClick={requestClose} disabled={closeDisabled}>
            <X size={18} aria-hidden="true" />
          </IconBtn>
        </div>
        <div className="ga-modal__body">{children}</div>
        {footer ? <div className="ga-modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
