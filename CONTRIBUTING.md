# コントリビューションガイド

GenbaAnno への変更を送っていただく前に、以下を確認してください。
セットアップ・アーキテクチャ・テストの詳細は [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)、設計判断と既知の罠は [`docs/DESIGN.md`](docs/DESIGN.md) にあります。

---

## PR を出す前のチェック

次の 3 つがすべて通ることを確認してください。

```bash
npm run typecheck   # tsc（electron/ と src/ の両方。core/ は両環境で型が通ること）
npm run test        # vitest
npm run lint        # eslint
```

`src/core/livewire.ts` または `src/core/lineShape.ts` に触れた場合は、数値回帰検証も必ず通してください。

```bash
node scripts/verify_livewire.mjs
node scripts/verify_lineshape.mjs
```

キャンバスの見た目に関わる変更は、DOM の読み取りだけでは検証できません。**実際にアプリを起動し、スクリーンショットで表示を確認**してください（`npm run dev`、または `npm run dev:web` でブラウザ確認）。

---

## 契約ファイルの変更ルール

次の 3 ファイルは**実装契約**であり、複数モジュールが同時に依存しています。

| ファイル | 契約内容 |
|---|---|
| `src/core/types.ts` | データモデル・`EditorState` / `EditorAction`・定数 |
| `src/shared/ipc.ts` | IPC チャネルとペイロード型 |
| `src/adapters/types.ts` | `StorageAdapter` インターフェース |

- **変更にはオーケストレーターの承認が必要です。** 独断で変更しないでください。
- 変更が必要だと考えた場合は、まず **なぜ既存の契約では実現できないのか** を Issue / PR の説明に書いてください。
- ディスク上の形式（`SidecarFile` / `ProjectFileJson`）を変える場合は、`schema_version` の扱い・後方互換の読み込み・[`docs/FORMATS.md`](docs/FORMATS.md) の更新をセットで行ってください。既存のサイドカーが読めなくなる変更は受け付けられません。

---

## コードの約束ごと

- **モジュールは独立させる。** import してよいのは「契約ファイル + `core/` の純関数」だけです。コンポーネント同士の直接依存・循環依存を作らないでください。
- **`core/` は DOM 非依存の純関数のみ。** Node・Electron main・ブラウザの 3 環境すべてで動く必要があります。React も DOM API も import しないでください。
- **ディスク上の JSON は snake_case、TypeScript 内部は camelCase。** 変換は `src/core/serialize.ts` の 1 箇所だけで行います。
- **移植コードの較正定数を「理屈で」直さない。** `livewire.ts` の `WIDTH_HALF_FRAC_DEFAULT = 0.3`、`WIDTH_SHRINK_DEFAULT = 0.82` などは実画像で較正済みの値です（DESIGN.md §6 罠 #5）。
- **Electron のセキュリティ設定を緩めない。** `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` / `webSecurity` 既定 は変更禁止です。
- **UI の文言は日本語。** アクセシビリティはデジタル庁デザインシステムに準拠します（フォーカスリング可視・コントラスト AA・44px タッチターゲット・aria 属性・キーボードのみで完結）。
- **黙って消さない。** データが除外・修復・破棄されるときは、必ず manifest か消えない警告として利用者に見えるようにしてください。

---

## `reference/` について

`reference/` は移植元の参照実装（別プロジェクトの非公開資産）です。

- **コミットしないでください。** `.gitignore` 済みで、配布物にも含まれません。
- 読むのは構いませんが、**変更・削除はしないでください。**
- `reference/` の内容（コード片・ドキュメント本文）を PR の説明や Issue に貼らないでください。

---

## やらないこと（明示承認が必要）

- `git push` / タグの作成 / GitHub リリースの公開
- `package.json` の `description` / `repository` などのメタ情報の変更
- 依存パッケージの追加（追加する場合は、なぜ必要か・バンドルサイズ・ライセンスを説明してください）

---

## ドキュメントの更新

機能を変えたら、対応するドキュメントも同じ PR で更新してください。

| 変更した箇所 | 更新するドキュメント |
|---|---|
| ショートカット・UI・操作フロー | `src/components/panels/ShortcutHelp.tsx` と [`docs/USAGE.md`](docs/USAGE.md) |
| サイドカー / project.json の形式、エクスポート仕様 | [`docs/FORMATS.md`](docs/FORMATS.md) |
| アーキテクチャ・コマンド・リリース手順 | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) |
| インストール手順・特徴 | [`README.md`](README.md) |

`docs/DESIGN.md` は当初の実装設計書として維持しているものです。実装が設計から意図的に外れた場合は、その差分を `docs/DEVELOPMENT.md` 側に書いてください。
