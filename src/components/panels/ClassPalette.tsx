// =============================================================================
// クラスパレット（M5）— 一覧・選択・クラス編集ダイアログの起動。
// 数字キー 1〜9 は「表示順の位置」に対応する（クラス id ではない）。
// =============================================================================

import { Settings2 } from 'lucide-react';
import type { ClassDef } from '../../core/types';
import { Btn } from './ui';

export interface ClassPaletteProps {
  classes: ClassDef[];
  activeClassId: number;
  onSelect: (classId: number) => void;
  onEdit: () => void;
}

export function ClassPalette({
  classes,
  activeClassId,
  onSelect,
  onEdit,
}: ClassPaletteProps): React.ReactElement {
  return (
    <section className="ga-panel" aria-labelledby="ga-class-title">
      <div className="ga-panel__head">
        <h2 className="ga-panel__title" id="ga-class-title">
          クラス
        </h2>
        <span className="ga-panel__count">{classes.length}種</span>
      </div>
      <div className="ga-panel__body">
        <div className="ga-list">
          {classes.map((cls, idx) => {
            const active = cls.id === activeClassId;
            return (
              <button
                key={cls.id}
                type="button"
                className={active ? 'ga-listrow ga-listrow--on' : 'ga-listrow'}
                aria-pressed={active}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onSelect(cls.id);
                }}
              >
                <span
                  className="ga-swatch"
                  aria-hidden="true"
                  style={{ backgroundColor: cls.color }}
                />
                <span className="ga-listrow__label">{cls.nameJa}</span>
                <span className="ga-listrow__sub">{cls.name}</span>
                {idx < 9 ? <kbd className="ga-kbd">{idx + 1}</kbd> : null}
              </button>
            );
          })}
        </div>
        <Btn
          className="ga-btn--sm ga-btn--block"
          onClick={onEdit}
          style={{ marginTop: 'var(--ga-space-2)' }}
        >
          <Settings2 size={14} aria-hidden="true" />
          クラス編集
        </Btn>
      </div>
    </section>
  );
}
