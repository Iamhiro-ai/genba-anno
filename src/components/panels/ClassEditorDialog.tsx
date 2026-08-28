// =============================================================================
// クラス編集ダイアログ（M5）
//
// DESIGN.md §2: **クラス id はエクスポートの学習 ID**。
//   削除・並べ替えをすると、エクスポート時に振られる学習 ID（0..N-1 の連番）が
//   ずれて「既存のラベルが別クラスとして学習される」事故になる。
//   そのため、削除・並べ替えを行った瞬間に消えない警告を出す。
//
// 追加時の id は **既存 id の最大 + 1**（空き番号の再利用はしない）。
//   空きを詰めると、削除済みクラスを指す古いサイドカーの class_id が
//   新しいクラスに化けるため。歯抜けはエクスポート側（buildClassIdMap）が吸収する。
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Palette, Plus, Trash2 } from 'lucide-react';
import type { ClassDef } from '../../core/types';
import { DEFAULT_CLASS_COLORS } from '../../core/types';
import { Modal } from './Modal';
import { Btn, IconBtn } from './ui';

const ID_WARNING =
  'クラスの削除・並べ替えを行いました。エクスポート時の学習 ID（data.yaml の並び順）が変わります。'
  + '既に書き出したデータセットや学習済みモデルとはクラス対応がずれるので、書き出し直してください。';

export interface ClassEditorDialogProps {
  open: boolean;
  classes: ClassDef[];
  onClose: () => void;
  onSave: (classes: ClassDef[]) => Promise<boolean>;
}

export function ClassEditorDialog({
  open,
  classes,
  onClose,
  onSave,
}: ClassEditorDialogProps): React.ReactElement | null {
  const [draft, setDraft] = useState<ClassDef[]>(classes);
  const [idChanged, setIdChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 開くたびに現在のクラス定義から編集を始める
  useEffect(() => {
    if (open) {
      setDraft(classes);
      setIdChanged(false);
      setError(null);
      setSaving(false);
    }
  }, [open, classes]);

  const nextId = useMemo(
    () => draft.reduce((max, c) => Math.max(max, c.id), -1) + 1,
    [draft]
  );

  const update = (index: number, patch: Partial<ClassDef>): void => {
    setDraft((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const add = (): void => {
    setDraft((prev) => [
      ...prev,
      {
        id: prev.reduce((max, c) => Math.max(max, c.id), -1) + 1,
        name: `class${nextId}`,
        nameJa: `クラス${nextId}`,
        color: DEFAULT_CLASS_COLORS[prev.length % DEFAULT_CLASS_COLORS.length],
      },
    ]);
  };

  const remove = (index: number): void => {
    setDraft((prev) => prev.filter((_c, i) => i !== index));
    setIdChanged(true);
  };

  const move = (index: number, delta: -1 | 1): void => {
    setDraft((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(index, 1);
      next.splice(to, 0, item);
      return next;
    });
    setIdChanged(true);
  };

  const invalid =
    draft.length === 0 ||
    draft.some((c) => c.name.trim().length === 0 || c.nameJa.trim().length === 0);

  const handleSave = async (): Promise<void> => {
    if (invalid) return;
    setSaving(true);
    setError(null);
    const normalized = draft.map((c) => ({
      ...c,
      name: c.name.trim(),
      nameJa: c.nameJa.trim(),
    }));
    const ok = await onSave(normalized);
    setSaving(false);
    if (ok) onClose();
    else setError('クラス定義の保存に失敗しました。もう一度お試しください。');
  };

  return (
    <Modal
      open={open}
      title="クラス編集"
      onClose={onClose}
      size="wide"
      icon={<Palette size={18} aria-hidden="true" />}
      closeDisabled={saving}
      footer={
        <>
          <Btn onClick={onClose} disabled={saving}>
            キャンセル
          </Btn>
          <Btn
            className="ga-btn--primary"
            onClick={() => void handleSave()}
            disabled={saving || invalid}
          >
            {saving ? '保存中…' : '保存'}
          </Btn>
        </>
      }
    >
      {idChanged && (
        <div className="ga-banner" role="alert">
          <span className="ga-banner__body">
            <span className="ga-banner__title">学習 ID が変わります</span>
            <br />
            {ID_WARNING}
          </span>
        </div>
      )}
      {error && (
        <div className="ga-banner ga-banner--error" role="alert">
          <span className="ga-banner__body">{error}</span>
        </div>
      )}

      <div className="ga-classedit">
        {draft.map((cls, i) => (
          <div className="ga-classedit__row" key={cls.id}>
            <span className="ga-classedit__id">ID {cls.id}</span>
            <label className="ga-field">
              <span className="ga-field__hint">表示名（日本語）</span>
              <input
                className="ga-input"
                type="text"
                value={cls.nameJa}
                onChange={(e) => update(i, { nameJa: e.target.value })}
                aria-label={`クラス ${cls.id} の表示名`}
              />
            </label>
            <label className="ga-field">
              <span className="ga-field__hint">学習データ名（英数字）</span>
              <input
                className="ga-input"
                type="text"
                value={cls.name}
                onChange={(e) => update(i, { name: e.target.value })}
                aria-label={`クラス ${cls.id} の学習データ名`}
              />
            </label>
            <input
              className="ga-input"
              type="color"
              value={cls.color}
              onChange={(e) => update(i, { color: e.target.value.toUpperCase() })}
              aria-label={`クラス ${cls.id} の色`}
              title="表示色"
            />
            <span className="ga-classedit__order">
              <IconBtn
                className="ga-icon-btn--sm"
                label={`${cls.nameJa} を上へ`}
                onClick={() => move(i, -1)}
                disabled={i === 0}
              >
                <ArrowUp size={14} aria-hidden="true" />
              </IconBtn>
              <IconBtn
                className="ga-icon-btn--sm"
                label={`${cls.nameJa} を下へ`}
                onClick={() => move(i, 1)}
                disabled={i === draft.length - 1}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </IconBtn>
              <IconBtn
                className="ga-icon-btn--sm"
                label={`${cls.nameJa} を削除`}
                onClick={() => remove(i)}
                disabled={draft.length <= 1}
              >
                <Trash2 size={14} aria-hidden="true" />
              </IconBtn>
            </span>
          </div>
        ))}
      </div>

      <Btn onClick={add} disabled={saving}>
        <Plus size={15} aria-hidden="true" />
        クラスを追加
      </Btn>

      {invalid && (
        <p className="ga-field__hint" role="status">
          クラスは1つ以上必要です。名前は空にできません。
        </p>
      )}
      <p className="ga-note">
        クラス ID はエクスポート時の学習 ID の並び順を決めます（ID の小さい順に 0,1,2… を割り当て）。
        既存のアノテーションは ID で結びついているため、名前や色の変更は安全です。
      </p>
    </Modal>
  );
}
