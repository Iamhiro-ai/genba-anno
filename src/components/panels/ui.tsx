// =============================================================================
// パネル共通の小さな UI 部品（M5）
//
// ここに置くのは「どのパネルからも使う純粋な見た目の部品」だけ。
// 状態を持つもの・アダプタに触れるものは各パネル側に置くこと。
//
// DESIGN.md §6 罠#7: ボタンは click 後に必ず blur() する。
//   Space をパン操作に使うため、フォーカスが残ったボタンが Space で再発火して
//   「完了」等を誤爆させる事故が参照実装で実際に起きている。
// =============================================================================

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { AnnotationStatus } from '../../core/types';

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type'>;

/**
 * Mac 判定。**表記の出し分けにしか使わない**（キー自体は全 OS で有効にすること）。
 * navigator.platform は非推奨だが、ここでは「⌘ と書くか Ctrl と書くか」だけの用途なので
 * 誤判定してもキー操作は壊れない。SSR / Node（vitest）でも落ちないようガードする。
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform ?? '');

/** 修飾キーの表示名（⌘ / Ctrl） */
export const MOD_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl';

/**
 * 「選択アノテーションの全体削除」の修飾キー表記。
 * MacBook には Forward Delete キーが無い（delete の実体は Backspace）ため、
 * Delete と等価な代替として mod+Backspace を用意している。
 */
export const DELETE_ALL_KEY_LABEL = `${MOD_KEY_LABEL}+Backspace`;

export interface BtnProps extends NativeButtonProps {
  onClick: () => void;
  children: ReactNode;
  /** 追加クラス（ga-btn--primary 等） */
  className?: string;
}

/** click 後に blur するテキストボタン */
export function Btn({ onClick, children, className, ...rest }: BtnProps): React.ReactElement {
  return (
    <button
      type="button"
      className={className ? `ga-btn ${className}` : 'ga-btn'}
      onClick={(e) => {
        e.currentTarget.blur();
        onClick();
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface IconBtnProps extends NativeButtonProps {
  onClick: () => void;
  children: ReactNode;
  /** アイコンボタンには必須（読み上げ用） */
  label: string;
  className?: string;
}

/** click 後に blur するアイコンボタン（aria-label 必須） */
export function IconBtn({
  onClick,
  children,
  label,
  className,
  title,
  ...rest
}: IconBtnProps): React.ReactElement {
  return (
    <button
      type="button"
      className={className ? `ga-icon-btn ${className}` : 'ga-icon-btn'}
      aria-label={label}
      title={title ?? label}
      onClick={(e) => {
        e.currentTarget.blur();
        onClick();
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** ツールバー用のトグルボタン（アイコン + ラベル + キー表示） */
export function ToolBtn({
  active,
  onClick,
  icon,
  label,
  keyHint,
  title,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  keyHint?: string;
  title: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={active ? 'ga-toolbtn ga-toolbtn--on' : 'ga-toolbtn'}
      title={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={(e) => {
        e.currentTarget.blur();
        onClick();
      }}
    >
      {icon}
      <span>{label}</span>
      {keyHint ? <span className="ga-toolbtn__key">{keyHint}</span> : null}
    </button>
  );
}

export const STATUS_LABEL: Record<AnnotationStatus, string> = {
  pending: '未着手',
  in_progress: '作業中',
  done: '完了',
  skipped: 'スキップ',
};

export function StatusBadge({ status }: { status: AnnotationStatus }): React.ReactElement {
  return <span className={`ga-badge ga-badge--${status}`}>{STATUS_LABEL[status]}</span>;
}
