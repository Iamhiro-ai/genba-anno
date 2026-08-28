// =============================================================================
// 現在画像のアノテーション一覧（M5）
//
// M2/M3 申し送り: **プロジェクトのクラス定義に無い class_id が入ってくることがある**
//   （クラスを削除した後の既存サイドカー・他ツールが書いた JSON）。
//   ここで落ちると「開いた瞬間にアプリが白くなる」ので、未知 class_id は
//   「未知のクラス(ID:n)」+ フォールバック色で必ず描く（AnnotationCanvas と同じ扱い）。
// =============================================================================

import { Layers, Minus, Spline, Square, Trash2 } from 'lucide-react';
import type { Annotation, ClassDef } from '../../core/types';
import { IconBtn } from './ui';

/** AnnotationCanvas の FALLBACK_CLASS_COLOR と同じ値（未知クラスの表示色） */
const FALLBACK_CLASS_COLOR = '#5F6B77';

const KIND_LABEL: Record<Annotation['kind'], string> = {
  bbox: '矩形',
  polygon: '多角形',
  line: 'ライン',
};

function kindIcon(kind: Annotation['kind']): React.ReactElement {
  if (kind === 'bbox') return <Square size={14} aria-hidden="true" />;
  if (kind === 'polygon') return <Spline size={14} aria-hidden="true" />;
  return <Minus size={14} aria-hidden="true" />;
}

export interface AnnotationListPanelProps {
  annotations: Annotation[];
  classes: ClassDef[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function AnnotationListPanel({
  annotations,
  classes,
  selectedId,
  onSelect,
  onDelete,
}: AnnotationListPanelProps): React.ReactElement {
  const classMap = new Map(classes.map((c) => [c.id, c]));

  return (
    <section className="ga-panel" aria-labelledby="ga-anno-title">
      <div className="ga-panel__head">
        <Layers size={15} aria-hidden="true" />
        <h2 className="ga-panel__title" id="ga-anno-title">
          アノテーション
        </h2>
        <span className="ga-panel__count">{annotations.length}件</span>
      </div>
      <div className="ga-panel__body">
        {annotations.length === 0 ? (
          <p className="ga-empty">まだアノテーションがありません</p>
        ) : (
          <div className="ga-list">
            {annotations.map((a, idx) => {
              const cls = classMap.get(a.classId);
              const label = cls ? cls.nameJa : `未知のクラス(ID:${a.classId})`;
              const color = cls ? cls.color : FALLBACK_CLASS_COLOR;
              const active = a.id === selectedId;
              const points = a.kind === 'bbox' ? null : a.points.length;
              return (
                <div key={a.id} className={active ? 'ga-listrow ga-listrow--on' : 'ga-listrow'}>
                  <button
                    type="button"
                    className="ga-annorow"
                    aria-pressed={active}
                    onClick={(e) => {
                      e.currentTarget.blur();
                      onSelect(a.id);
                    }}
                  >
                    <span
                      className="ga-swatch"
                      aria-hidden="true"
                      style={{ backgroundColor: color }}
                    />
                    <span className="ga-annorow__kind" title={KIND_LABEL[a.kind]}>
                      {kindIcon(a.kind)}
                    </span>
                    <span className="ga-listrow__label">
                      #{idx + 1} {label}
                    </span>
                    <span className="ga-listrow__sub">
                      {points === null ? KIND_LABEL[a.kind] : `${points}点`}
                    </span>
                  </button>
                  <IconBtn
                    className="ga-icon-btn--sm"
                    label={`#${idx + 1} ${label} を削除`}
                    onClick={() => onDelete(a.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </IconBtn>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
