# GenbaAnno（現場アノ）

ローカル画像フォルダを選ぶだけで使える、現場向け学習データ作成アノテーションツール。
バウンディングボックス + ひび割れ吸着セグメンテーション（マグネットライン）対応。Windows / macOS 両対応の Electron アプリ。

## 目的

- 撮影した動画・画像から物体検出／セグメンテーションの学習データを効率よく作成する
- GitHub からダウンロードした人が**すぐ現場で使える**こと（導入の容易さ・ドキュメント込みで完成品）
- モデルの事前アノテーションは v1 では無し（全手入力を前提に操作性を最優先）

## 技術スタック

- Electron + React + TypeScript + Vite（electron-vite）
- 描画: HTML Canvas 直接描画（描画ライブラリなし）
- 状態: useReducer 単一ストア（undo/redo 100段）
- テスト: vitest / 純関数の Node 検証スクリプト（scripts/）
- 配布: electron-builder（GitHub Actions で Win/mac ビルド）
- バックエンド・DBなし。アノテーションは画像フォルダ内 `_anno/` に JSON サイドカー保存

## 設計ルール（必読: docs/DESIGN.md）

1. **契約ファースト**: `src/core/types.ts`（データモデル）と `src/shared/ipc.ts`（IPC契約）と
   `src/adapters/types.ts`（StorageAdapter契約）が実装契約。**変更は必ずオーケストレーター承認**
2. **モジュール独立**: モジュール間の import は「契約ファイル + core の純関数」のみ許可。
   コンポーネント間の直接依存・循環依存を作らない
3. **core/ は DOM 非依存の純関数のみ**（livewire / lineShape / geometry / export 生成 / serialize）。
   Node でも Electron main でもブラウザでも動くこと
4. **移植コードの較正定数を「理屈で」直さない**（livewire.ts の HALF_FRAC=0.30, SHRINK=0.82 等は
   実画像で較正済み。docs/DESIGN.md「既知の罠」参照）
5. ディスク上の JSON は snake_case、TS 内部は camelCase（境界は serialize.ts のみ）
6. UI 文言は日本語。アクセシビリティはデジタル庁デザインシステム準拠
   （フォーカスリング可視・コントラスト AA・44px タッチターゲット・aria 属性）
7. `reference/` は移植元の参照実装（gitignore 済み・配布物に含めない）。読んでよいが変更しない

## コマンド

```bash
npm install          # 依存導入
npm run dev          # Electron 開発起動
npm run dev:web      # ブラウザのみ起動（MockAdapter・UI検証用）
npm run test         # vitest
npm run typecheck    # tsc -b
npm run lint         # eslint
npm run build        # 本番ビルド + electron-builder（現OS向け）
node scripts/verify_livewire.mjs   # livewire 数値回帰検証
node scripts/verify_lineshape.mjs  # lineShape 数値回帰検証
```

## 禁止事項

- git push / タグ作成 / GitHub リリース操作（ユーザー明示承認が必要）
- `reference/` の削除・変更
- 契約ファイル（types.ts / ipc.ts / adapters/types.ts）の独断変更
- Electron のセキュリティ設定緩和（nodeIntegration 有効化・contextIsolation 無効化・webSecurity 無効化）
