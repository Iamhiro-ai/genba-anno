// =============================================================================
// 画像一覧パネル（M5）
//
// 参照実装 ImageListPanel からの差分（GenbaAnno の方式に合わせた意図的な変更）:
//   - **アップロード D&D / 削除ボタンを持たない**。本ツールは選択した画像フォルダを
//     直接読むので「アップロード」という概念が無く、ファイル削除も v1 では提供しない
//     （エクスプローラ/Finder で消すのが安全・取り返しがつく）。代わりに
//     「フォルダ再走査」ボタンで、外部で追加された画像を取り込む。
//   - 1000 枚フォルダでも固まらないよう**窓表示（可視範囲だけ描画）**にした
//     （DESIGN.md §7-6）。行高は固定 60px なのでスクロール位置から算出できる。
// =============================================================================

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FolderSync, ImageOff } from 'lucide-react';
import type { AnnotationStatus, ImageEntry } from '../../core/types';
import { Btn, StatusBadge } from './ui';

export type StatusFilter = AnnotationStatus | 'all';

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全て' },
  { value: 'pending', label: '未着手' },
  { value: 'in_progress', label: '作業中' },
  { value: 'done', label: '完了' },
  { value: 'skipped', label: 'スキップ' },
];

/** 1 行の高さ（px）。窓表示の位置計算に使うので CSS の .ga-imagerow と一致させること */
const ROW_H = 60;
/** 可視範囲の前後に余分に描く行数（スクロール時のちらつき防止） */
const OVERSCAN = 6;

export interface ImageListPanelProps {
  /** フィルタ適用後の並び（ナビゲーション順と同一） */
  items: ImageEntry[];
  /** フィルタ前の総数 */
  totalCount: number;
  selectedFile: string | null;
  statusFilter: StatusFilter;
  /**
   * フィルタ条件から外れているのに一覧へ残している画像（= 表示中の画像）。
   * 「フィルタ外」バッジを付けて、なぜここに居るのかを分かるようにする。
   */
  outOfFilterFile?: string | null;
  onFilterChange: (f: StatusFilter) => void;
  onSelect: (file: string) => void;
  onRescan: () => void;
  rescanning: boolean;
  /** 保存・切替などの操作中（再走査ボタンを止める） */
  busy?: boolean;
  imageUrl: (file: string) => string;
}

const Row = memo(function Row({
  item,
  top,
  active,
  outOfFilter,
  url,
  onSelect,
}: {
  item: ImageEntry;
  top: number;
  active: boolean;
  outOfFilter: boolean;
  url: string;
  onSelect: (file: string) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={active ? 'ga-imagerow ga-imagerow--on' : 'ga-imagerow'}
      style={{ top }}
      aria-current={active ? 'true' : undefined}
      onClick={(e) => {
        e.currentTarget.blur();
        onSelect(item.file);
      }}
    >
      {url ? (
        <img className="ga-imagerow__thumb" loading="lazy" src={url} alt="" />
      ) : (
        <span className="ga-imagerow__thumb" aria-hidden="true" />
      )}
      <span className="ga-imagerow__meta">
        {/* バッジはファイル名と同じ行に置く。一覧が狭い（最小 196px）ので、
            はみ出す場合は「元から省略表示のファイル名」側を削るのが一番害が少ない */}
        <span className="ga-imagerow__nameline">
          <span className="ga-imagerow__name" title={item.file}>
            {item.file}
          </span>
          {outOfFilter && (
            <span
              className="ga-badge ga-badge--filtered"
              title="表示中のため、フィルタ条件から外れていても一覧に残しています"
            >
              フィルタ外
            </span>
          )}
        </span>
        <span className="ga-imagerow__sub">
          <StatusBadge status={item.status} />
          <span className="ga-imagerow__count">{item.annotationCount}件</span>
        </span>
      </span>
    </button>
  );
});

export function ImageListPanel({
  items,
  totalCount,
  selectedFile,
  statusFilter,
  outOfFilterFile,
  onFilterChange,
  onSelect,
  onRescan,
  rescanning,
  busy,
  imageUrl,
}: ImageListPanelProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // 選択中の行が窓の外なら見える位置までスクロール（キーボードだけで前後移動するため必須）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || selectedFile === null) return;
    const index = items.findIndex((it) => it.file === selectedFile);
    if (index < 0) return;
    const top = index * ROW_H;
    const bottom = top + ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [selectedFile, items]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible = items.slice(start, end);

  return (
    <div className="ga-panel ga-panel--grow">
      <div className="ga-panel__head">
        <h2 className="ga-panel__title">画像</h2>
        <span className="ga-panel__count">
          {items.length} / {totalCount} 枚
        </span>
        <span className="ga-spacer" />
      </div>

      <div className="ga-filter" role="group" aria-label="ステータスで絞り込み">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={
              statusFilter === opt.value ? 'ga-filter__btn ga-filter__btn--on' : 'ga-filter__btn'
            }
            aria-pressed={statusFilter === opt.value}
            onClick={(e) => {
              e.currentTarget.blur();
              onFilterChange(opt.value);
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="ga-empty">
          <ImageOff size={20} aria-hidden="true" />
          <br />
          該当する画像がありません
        </p>
      ) : (
        <div className="ga-imagelist" ref={scrollRef} onScroll={onScroll}>
          <div className="ga-imagelist__inner" style={{ height: items.length * ROW_H }}>
            {visible.map((item, i) => (
              <Row
                key={item.file}
                item={item}
                top={(start + i) * ROW_H}
                active={item.file === selectedFile}
                outOfFilter={item.file === outOfFilterFile}
                url={imageUrl(item.file)}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}

      <div className="ga-panel__body">
        <Btn
          className="ga-btn--sm ga-btn--block"
          onClick={onRescan}
          disabled={rescanning || busy === true}
        >
          <FolderSync size={14} aria-hidden="true" className={rescanning ? 'ga-spin' : undefined} />
          {rescanning ? '再走査中…' : 'フォルダ再走査'}
        </Btn>
        <p className="ga-note" style={{ marginTop: 'var(--ga-space-2)' }}>
          画像の追加・削除はフォルダ側で行い、このボタンで取り込みます。
        </p>
      </div>
    </div>
  );
}
