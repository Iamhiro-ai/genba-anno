// =============================================================================
// キャンバス上部のツールバー（M5）
//
// 線幅スライダーの注意（M2 申し送り・DevCanvasHarness の resizeSelectedLineByStep 参照）:
//   確定済みラインの幅変更 `resizeLine` は履歴を積まない。
//   連続ドラッグを 1 手の undo にまとめるため **beginGesture → resizeLine… → endGesture**
//   で囲む必要がある。ここでは onLineWidthChange（変更のたび）と
//   onLineWidthCommit（pointerup / blur）に分けてページ側へ委ねている。
// =============================================================================

import {
  Contrast,
  GitBranch,
  Magnet,
  Maximize2,
  MousePointer2,
  PaintBucket,
  Redo2,
  Save,
  Scissors,
  Spline,
  Square,
  SquareDashed,
  Sun,
  Trash2,
  Undo2,
  Waves,
} from 'lucide-react';
import type { DrawTool, EditorMode } from '../../core/types';
import { LINE_WIDTH_MAX, LINE_WIDTH_MIN } from '../../core/types';
import type { LineEditAction } from '../AnnotationCanvas';
import { Btn, DELETE_ALL_KEY_LABEL, IconBtn, ToolBtn } from './ui';

export interface ToolbarProps {
  mode: EditorMode;
  drawTool: DrawTool;
  fillVisible: boolean;
  canUndo: boolean;
  canRedo: boolean;
  magnetMode: boolean;
  magnetInvert: boolean;
  /** ライン/多角形の外接ボックス表示（エクスポートの derived box プレビュー・表示のみ） */
  showDerivedBoxes: boolean;
  brightness: number;
  contrast: number;
  /** 描画中ツールの線幅（line ツール時） */
  lineWidth: number;
  /** 選択中ラインの幅（無選択なら null）。非 null ならスライダーはこちらを編集する */
  selectedLineWidth: number | null;
  /** 編集モードでアノテーションを選択中か（削除ボタンの表示条件） */
  hasSelection: boolean;
  saving: boolean;
  disabled: boolean;
  /** ページ側の実行中フラグ（保存・切替・完了など）。削除ボタンを無効化する */
  busy: boolean;
  lineEditAction: LineEditAction;
  onSetTool: (tool: DrawTool) => void;
  onSetEditMode: () => void;
  onToggleMagnet: () => void;
  onToggleInvert: () => void;
  onToggleDerivedBoxes: () => void;
  onLineWidthChange: (w: number) => void;
  onLineWidthCommit: () => void;
  onBrightness: (v: number) => void;
  onContrast: (v: number) => void;
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleFill: () => void;
  onSave: () => void;
  onSetLineEditAction: (a: LineEditAction) => void;
  /** 選択中アノテーションの全体削除（Delete / mod+Backspace と同じ動作） */
  onDeleteSelected: () => void;
}

export function Toolbar(props: ToolbarProps): React.ReactElement {
  const {
    mode,
    drawTool,
    fillVisible,
    canUndo,
    canRedo,
    magnetMode,
    magnetInvert,
    showDerivedBoxes,
    brightness,
    contrast,
    lineWidth,
    selectedLineWidth,
    hasSelection,
    saving,
    disabled,
    busy,
    lineEditAction,
  } = props;

  const drawing = mode === 'draw';
  const showWidth = (drawing && drawTool === 'line') || selectedLineWidth !== null;
  const widthValue = selectedLineWidth ?? lineWidth;

  return (
    <div className="ga-toolbar" role="toolbar" aria-label="描画ツール">
      <div className="ga-toolgroup">
        <ToolBtn
          active={mode === 'edit'}
          onClick={props.onSetEditMode}
          icon={<MousePointer2 size={15} aria-hidden="true" />}
          label="編集"
          keyHint="V"
          title="編集モード (V)"
          disabled={disabled}
        />
        <ToolBtn
          active={drawing && drawTool === 'bbox'}
          onClick={() => props.onSetTool('bbox')}
          icon={<Square size={15} aria-hidden="true" />}
          label="矩形"
          keyHint="R"
          title="バウンディングボックス描画 (R)"
          disabled={disabled}
        />
        <ToolBtn
          active={drawing && drawTool === 'polygon'}
          onClick={() => props.onSetTool('polygon')}
          icon={<Spline size={15} aria-hidden="true" />}
          label="多角形"
          keyHint="W"
          title="ポリゴン描画 (W)"
          disabled={disabled}
        />
        <ToolBtn
          active={drawing && drawTool === 'line'}
          onClick={() => props.onSetTool('line')}
          icon={<Waves size={15} aria-hidden="true" />}
          label="ライン"
          keyHint="L"
          title="マグネットライン描画 (L)"
          disabled={disabled}
        />
      </div>

      <div className="ga-toolgroup">
        <ToolBtn
          active={magnetMode}
          onClick={props.onToggleMagnet}
          icon={<Magnet size={15} aria-hidden="true" />}
          label={magnetMode ? 'マグネットON' : 'マグネットOFF'}
          keyHint="M"
          title="マグネットライン ON/OFF (M)"
          disabled={disabled}
        />
        <ToolBtn
          active={magnetInvert}
          onClick={props.onToggleInvert}
          icon={<Contrast size={15} aria-hidden="true" />}
          label="反転"
          keyHint="I"
          title="反転モード: 白線など明るい線を追う (I)"
          disabled={disabled || !magnetMode}
        />
        <ToolBtn
          active={showDerivedBoxes}
          onClick={props.onToggleDerivedBoxes}
          icon={<SquareDashed size={15} aria-hidden="true" />}
          label="外接枠"
          title="ライン/多角形の外接ボックスを表示（検出エクスポートで自動付与される枠のプレビュー。表示のみ）"
          disabled={disabled}
        />
      </div>

      {showWidth && (
        <div className="ga-toolgroup">
          <div className="ga-slider" title="線幅 ([ / ])">
            <label className="ga-slider__label" htmlFor="ga-linewidth">
              線幅
            </label>
            <input
              id="ga-linewidth"
              type="range"
              min={LINE_WIDTH_MIN}
              max={LINE_WIDTH_MAX}
              step={1}
              value={Math.round(widthValue)}
              disabled={disabled}
              onChange={(e) => props.onLineWidthChange(Number(e.target.value))}
              onPointerUp={props.onLineWidthCommit}
              onBlur={props.onLineWidthCommit}
              onKeyUp={props.onLineWidthCommit}
            />
            <output className="ga-slider__value">{Math.round(widthValue)}px</output>
          </div>
        </div>
      )}

      {selectedLineWidth !== null && (
        <div className="ga-toolgroup">
          <ToolBtn
            active={lineEditAction === 'cut'}
            onClick={() => props.onSetLineEditAction(lineEditAction === 'cut' ? 'none' : 'cut')}
            icon={<Scissors size={15} aria-hidden="true" />}
            label="短縮"
            keyHint="C"
            title="短縮: 中心線をクリックして切断 (C)"
            disabled={disabled}
          />
          <ToolBtn
            active={lineEditAction === 'branch'}
            onClick={() =>
              props.onSetLineEditAction(lineEditAction === 'branch' ? 'none' : 'branch')
            }
            icon={<GitBranch size={15} aria-hidden="true" />}
            label="分岐"
            keyHint="B"
            title="分岐: 中心線をクリックして枝を描く (B)"
            disabled={disabled}
          />
        </div>
      )}

      {/*
        MacBook には Forward Delete キーが無い（delete の実体は Backspace）ため、
        キーボードだけだと全体削除が fn+delete しか無く押しづらい。
        選択中だけ出るこのボタンと mod+Backspace が代替手段。
      */}
      {hasSelection && (
        <div className="ga-toolgroup">
          <Btn
            className="ga-btn--sm ga-btn--danger"
            aria-label={`選択中のアノテーションを削除（${DELETE_ALL_KEY_LABEL}）`}
            title={`選択中のアノテーションを削除 (Delete / ${DELETE_ALL_KEY_LABEL})`}
            onClick={props.onDeleteSelected}
            disabled={disabled || busy}
          >
            <Trash2 size={14} aria-hidden="true" />
            削除
          </Btn>
        </div>
      )}

      <div className="ga-toolgroup">
        <div className="ga-slider" title="明るさ（表示のみ・データは変わりません）">
          <label className="ga-slider__label" htmlFor="ga-brightness">
            <Sun size={13} aria-hidden="true" /> 明
          </label>
          <input
            id="ga-brightness"
            type="range"
            min={50}
            max={200}
            step={1}
            value={brightness}
            disabled={disabled}
            onChange={(e) => props.onBrightness(Number(e.target.value))}
          />
        </div>
        <div className="ga-slider" title="コントラスト（表示のみ・データは変わりません）">
          <label className="ga-slider__label" htmlFor="ga-contrast">
            <Contrast size={13} aria-hidden="true" /> コ
          </label>
          <input
            id="ga-contrast"
            type="range"
            min={50}
            max={200}
            step={1}
            value={contrast}
            disabled={disabled}
            onChange={(e) => props.onContrast(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="ga-toolgroup">
        <IconBtn label="画面にフィット (F)" onClick={props.onFit} disabled={disabled}>
          <Maximize2 size={17} aria-hidden="true" />
        </IconBtn>
        <IconBtn label="元に戻す (Ctrl+Z)" onClick={props.onUndo} disabled={disabled || !canUndo}>
          <Undo2 size={17} aria-hidden="true" />
        </IconBtn>
        <IconBtn
          label="やり直す (Ctrl+Shift+Z)"
          onClick={props.onRedo}
          disabled={disabled || !canRedo}
        >
          <Redo2 size={17} aria-hidden="true" />
        </IconBtn>
        <IconBtn
          className={fillVisible ? 'ga-icon-btn--on' : undefined}
          label="塗りつぶし表示の切替 (T)"
          onClick={props.onToggleFill}
          disabled={disabled}
        >
          <PaintBucket size={17} aria-hidden="true" />
        </IconBtn>
      </div>

      <span className="ga-spacer" />

      <Btn className="ga-btn--sm" onClick={props.onSave} disabled={disabled || saving}>
        <Save size={14} aria-hidden="true" />
        {saving ? '保存中…' : '保存'}
      </Btn>
    </div>
  );
}
