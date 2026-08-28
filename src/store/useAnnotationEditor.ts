// =============================================================================
// エディタ状態フック（M2）— 契約 src/core/types.ts の AnnotationEditorApi を実装する。
//
// 出自: reference/frontend/src/hooks/useAnnotationEditor.ts。
// 参照実装との差分:
//   - リデューサ本体は editorReducer.ts に分離（React 非依存・単体テスト可能にするため）
//   - toSavePayload（API 送信用）は廃止。ディスク形式への変換は core/serialize.ts が唯一の窓口
//   - 初期状態を上書きできる init 引数を追加（プロジェクト設定の defaultTool /
//     lineWidthDefault を初期値に反映するため。省略時は createInitialEditorState() と同じ）
// =============================================================================

import { useMemo, useReducer } from 'react';
import type { AnnotationEditorApi, EditorState } from '../core/types';
import { createInitialEditorState, draftCommittable, editorReducer } from './editorReducer';

export function useAnnotationEditor(init?: Partial<EditorState>): AnnotationEditorApi {
  const [state, dispatch] = useReducer(editorReducer, init, createInitialEditorState);
  return useMemo(
    () => ({
      state,
      dispatch,
      canCommitDraft: draftCommittable(state.draft),
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
    }),
    [state]
  );
}
