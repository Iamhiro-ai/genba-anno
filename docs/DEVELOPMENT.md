# 開発者向けガイド

**対象**: GenbaAnno のコードを読む / 変更する / ビルドする方
**関連**: [実装設計書 DESIGN.md](DESIGN.md) / [データ形式 FORMATS.md](FORMATS.md) / [CONTRIBUTING.md](../CONTRIBUTING.md)

設計判断の根拠と「既知の罠」は [`docs/DESIGN.md`](DESIGN.md) にまとまっています。**コードを変更する前に必ず目を通してください。** この文書は、そこに書かれた設計を前提に、日々の開発作業（セットアップ・テスト・リリース）を進めるための手引きです。

---

## 1. アーキテクチャ概要

Electron + React + TypeScript（electron-vite）。バックエンドも DB もありません。永続化は画像フォルダ内の JSON サイドカーです。

```
                    ┌──────────────────────────────────────────┐
  レンダラ           │  pages/        App / WelcomeScreen /       │
  (Chromium)        │                EditorPage                 │
                    │  components/   AnnotationCanvas /          │
                    │                panels/*                   │
                    └───────┬──────────────────┬────────────────┘
                            │                  │
                    ┌───────▼────────┐  ┌──────▼──────────────┐
                    │  store/        │  │  adapters/          │
                    │  editorReducer │  │  types.ts（契約）   │
                    │  useAnnotation │  │  electronAdapter    │
                    │  Editor        │  │  mockAdapter        │
                    └───────┬────────┘  └──────┬──────────────┘
                            │                  │ IPC（shared/ipc.ts 契約）
                    ┌───────▼──────────────────┼──────────────┐
                    │  core/  ← 何にも依存しない純関数のみ      │
                    │  types.ts（契約） serialize livewire     │
                    │  lineShape geometry export/*             │
                    └──────────────────────────┼──────────────┘
                                               │
                    ┌──────────────────────────▼──────────────┐
  メインプロセス     │  electron/  main / preload / lib/*       │
  (Node)            │  fs 原子的書込 / anno:// / ffmpeg 抽出   │
                    └─────────────────────────────────────────┘
```

### 依存方向のルール（これ以外の import は禁止）

- `components` / `pages` → `store` → `core`
- `components` / `pages` → `adapters`（型は `adapters/types.ts`）
- `electron` → `shared/ipc.ts` + `core`
- **`core/` は何にも依存しません**（React も DOM も含まない）。Node・Electron main・ブラウザの 3 環境すべてで動くことが要件です。
- `adapters` は `core` の型だけを参照します。
- モジュール間の import は「契約ファイル + `core` の純関数」に限ります。コンポーネント同士を直接依存させたり、循環依存を作ったりしないでください。

### 契約ファイル（変更にはオーケストレーターの承認が必要）

| ファイル | 契約している内容 |
|---|---|
| `src/core/types.ts` | データモデル・`EditorState` / `EditorAction`・定数 |
| `src/shared/ipc.ts` | IPC チャネルとペイロード型・`anno://` スキーム名 |
| `src/adapters/types.ts` | `StorageAdapter` インターフェース |

### ディレクトリ

```
electron/            main / preload / IPC / anno:// プロトコル / 原子的書込 / 動画抽出
  lib/               純ロジック（ffmpegArgs / pathGuard / atomicWrite / naturalSort …）
src/
  shared/ipc.ts      契約: IPC
  core/              DOM 非依存の純関数のみ
    types.ts         契約: データモデル
    serialize.ts     ディスク JSON(snake_case) ⇔ 内部型(camelCase) の唯一の変換点
    livewire.ts      マグネットライン（最短経路探索・幅推定）
    lineShape.ts     中心線 → 可変幅リボン・分岐 union
    geometry.ts      幾何ユーティリティ・ヒット判定
    export/          planner / yoloDet / yoloSeg / coco / maskPng / split / manifest / exif
  store/             useReducer 単一ストア（undo/redo 100 段・gesture）
  adapters/          StorageAdapter 実装（electron / mock）
  components/        AnnotationCanvas（最重要）+ panels/
  pages/             App / WelcomeScreen / EditorPage / DevCanvasHarness
  export/runner.ts   レンダラ側の配管（fetch / createImageBitmap / OffscreenCanvas を使う唯一の場所）
  styles/            デジタル庁デザイントークン
scripts/             純関数の数値回帰検証（Node 実行）
tests/               vitest
docs/                ドキュメント
```

### Electron のセキュリティ方針

`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`、`webSecurity` は既定のまま。**これらを緩めてはいけません。**

- 画像は `file://` の直参照ではなく **`anno://` カスタムプロトコル**で配信します。パスは main 側で検証されます。
- レンダラへ渡すのは**相対ファイル名だけ**で、パス結合はすべて main 側で行います（Windows のドライブレター・予約名・`\` 区切り・日本語ファイル名を考慮）。
- フォルダアクセスは許可リスト方式です。`dialog` で明示的に選ばれたディレクトリと、`recent.json` に記録済み（＝過去に `dialog` を通った）ディレクトリのみを受け付けます。エクスポート／動画の出力先は `dialog` 由来のみ許可し、シンボリックリンクを一切辿らずに 1 段ずつ検証しながら書き込みます。

---

## 2. セットアップ

必要なもの: **Node.js `^22.13.0 || >=24`** と npm。

```bash
git clone <このリポジトリの URL>
cd genba-anno
npm ci
```

- 初回の `npm ci` では **Electron 本体のバイナリ（100MB 超）と ffmpeg-static のダウンロード**が走ります。ネットワーク環境によっては数分かかります。
- `package.json` の `allowScripts` は、postinstall スクリプトの実行を明示的に許可しているパッケージの一覧です（`electron` / `esbuild` / `ffmpeg-static` など）。バイナリを取得できないときはここを確認してください。

---

## 3. コマンド一覧

```bash
npm run dev          # Electron で開発起動（HMR）
npm run dev:web      # ブラウザだけで UI を起動（http://localhost:5199・MockAdapter）
npm run build        # electron-vite build（out/ に main / preload / renderer）

npm run typecheck    # tsc -p tsconfig.node.json + tsconfig.web.json（どちらも --noEmit）
npm run test         # vitest run
npm run lint         # eslint

npm run dist         # build + electron-builder（現在の OS 向けインストーラ → release/）
npm run dist:dir     # build + electron-builder --dir（インストーラなし・動作確認用）

node scripts/verify_livewire.mjs   # livewire の数値回帰検証
node scripts/verify_lineshape.mjs  # lineShape の数値回帰検証
```

補足:

- `npm run dev:web` は `window.genbaAnno` が存在しない環境になるため `adapters/mockAdapter.ts` が使われます。Canvas 生成のサンプル画像が内蔵されており、フォルダ選択なしで UI を触れます。保存内容はページを閉じると消えます。
- `?harness=canvas` を付けて開くと、キャンバス単体の検証ページ（`DevCanvasHarness`）が表示されます。
- 型検査が 2 つに分かれているのは、`electron/`（Node の lib）と `src/`（DOM の lib）で `lib` 設定が違うためです。`core/` は**両方で型が通る**必要があります。
- **macOS で `npm run dist` を実行すると、キーチェーンの署名 ID が自動検出されて意図せず署名されることがあります。** 署名なしにしたい場合は `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist` としてください（CI では設定済み）。

---

## 4. テスト

### vitest

```bash
npm run test
```

現在 **13 ファイル / 466 件**（`tests/`）。

| ファイル | 対象 |
|---|---|
| `core-geometry.test.ts` | 幾何ユーティリティ・ヒット判定 |
| `core-lineshape.test.ts` | 中心線 → リボン生成・分岐 union・切断 |
| `core-livewire.test.ts` | 経路探索・間引き・幅推定・フォールバック |
| `editor-reducer.test.ts` | リデューサ（undo/redo・gesture・draft・降格） |
| `serialize.test.ts` | サイドカー / project.json の相互変換・修復・lossy 判定 |
| `export-planner.test.ts` | 対象選択・負例判定・除外規則・名前衝突 |
| `export-yolo.test.ts` | `yolo_det` / `yolo_seg` のラベル行・`data.yaml` |
| `export-coco.test.ts` | COCO スキーマ・id 採番 |
| `export-mask.test.ts` | ラスタライザ（even-odd・union・ピクセル中心） |
| `export-split.test.ts` | SHA-1・ハッシュ分割の決定性と独立性 |
| `export-exif.test.ts` | JPEG orientation パーサ（破損耐性） |
| `electron-lib.test.ts` | `electron/lib/*`（ffmpeg 引数・パス検証・原子的書込 等） |
| `scaffold.test.ts` | 設定・構成の健全性 |

### 数値回帰検証スクリプト

```bash
node scripts/verify_livewire.mjs
node scripts/verify_lineshape.mjs
```

`src/core/livewire.ts` / `lineShape.ts` を esbuild で TS→JS 変換し、合成画像に対して**移植元（`reference/`）と同一の数値**が出ることを確認します。マグネットラインの較正定数を触ってしまったときに気付くための最後の砦です。

> `reference/` は移植元の参照実装で、`.gitignore` 済み・配布物にも含まれません。クローンした環境には存在しないことがあります。

### 品質基準（DESIGN.md §7）

1. `typecheck` / `test` / `lint` / `build` がすべて通ること
2. `verify_livewire.mjs` / `verify_lineshape.mjs` が合格すること
3. ブラウザモードで一連の E2E（読込 → 描画 → 編集 → undo/redo → 保存 → 再読込 → 完了 → エクスポート）が通ること
4. EXIF 回転付き JPEG で座標がずれないこと
5. キーボードだけで作業が完結し、フォーカスリングが常に見えること
6. 1000 枚フォルダで画像切替が体感即時であること

Canvas の見た目は DOM の読み取りだけでは検証できません。**スクリーンショットで実表示を確認**してください（DESIGN.md §6 罠 #8）。

---

## 5. 主要な設計判断（要約）

詳細と理由は [DESIGN.md](DESIGN.md) にあります。ここは索引です。

| 判断 | 要点 |
|---|---|
| **サイドカー方式** | DB を持たず、画像フォルダ内の `_anno/` に JSON を置く。破損・移行リスクが無く、フォルダごとコピーでデータが画像と一緒に動き、ML パイプラインから直接読める |
| **契約ファースト** | `core/types.ts` / `shared/ipc.ts` / `adapters/types.ts` を実装契約とし、モジュールはこれと `core` の純関数だけを共有する。並行開発でも結合部が壊れない |
| **エクスポートは純関数 + 薄い配管** | 「何を書くか」は `core/export/planner.ts` が DOM 無しで決め切り、I/O は `src/export/runner.ts` が流すだけ。出力の全ケースを単体テストできる |
| **livewire 移植の数値不変原則** | `HALF_FRAC=0.30` `SHRINK=0.82` などの較正定数は実画像で較正済み。**理屈で直さない。** 変更したら必ず `verify_*.mjs` を通す |
| **誤負例を作らない** | 「アノテーションが 0 件になった」理由を区別し、`done` で本当に 0 件のときだけ負例にする。それ以外は画像ごとスキップして manifest に理由を残す |
| **黙って消さない** | 除外・修復・破損はすべて manifest か消えない警告バナーに残す。トーストで流してよいのは無害な補正だけ |
| **原子的書込 + バックアップ** | tmp 書込 → fsync → rename。加えて直前 1 世代を `_anno/backups/` へ。壊れた原本・未来バージョンの原本は押し出されない名前で退避 |
| **ハッシュ分割** | train/val は画像単位の独立ハッシュ閾値。ソート方式は画像追加でリークするため禁止 |
| **UI は日本語・アクセシビリティ準拠** | デジタル庁デザインシステム（フォーカスリング可視・コントラスト AA・44px タッチターゲット・aria 属性）。キーボードだけで完結すること |

---

## 6. リリース手順

CI は `.github/workflows/build.yml`。

1. **`workflow_dispatch`（手動実行）** — typecheck / test / lint のあと Win / mac をビルドし、成果物を Actions の artifact に上げます。リリースは作りません。
2. **`v*` タグの push** — 上記に加えて **draft リリース**を作成し、成果物と `SHA256SUMS.txt`（全バイナリのチェックサム。未署名配布の真正性確認用）を添付します。
3. **公開は人間が手動で行います。** GitHub の Releases 画面で draft を確認してから publish してください。

セキュリティ上の設定（公開前監査で適用済み）:

- ワークフローの `uses:` は**全てコミット SHA に固定**（可変タグの差し替えによるサプライチェーン攻撃対策。更新時は SHA を検証して張り替える）
- 権限は既定 `contents: read`、`contents: write` は release ジョブのみ
- `.npmrc` の `strict-allow-scripts=true` により、install スクリプトは `package.json` の `allowScripts` に列挙したものだけが実行されます（npm 11.16+。依存を追加してスクリプトが必要な場合は allowScripts へ追記）
- Electron 側: 全 IPC ハンドラは送信元フレーム検証付き（`handleTrusted`）、新規ウィンドウ/外部リンクは全拒否

> **注意**: このリポジトリのルール上、**タグ作成・push・リリース公開にはユーザーの明示承認が必要**です。CI が自動で公開することはありません。

### ビルドマトリクス

| ランナー | 生成物 |
|---|---|
| `macos-latest`（Apple Silicon / arm64） | `release/*.dmg`, `release/*.zip` |
| `macos-13`（Intel / x64） | `release/*.dmg`, `release/*.zip` |
| `windows-latest` | `release/*.exe`（NSIS インストーラ + portable） |

**macOS を arm64 / x64 の別ランナーでビルドしている理由**: `ffmpeg-static` は `npm ci` を実行したホストのアーキテクチャ向けバイナリを 1 つしか持ちません。クロスアーキテクチャビルドをすると**別 arch の ffmpeg が混入**し、動画フレーム抽出が実行時に落ちます。そのため `electron-builder.yml` では `arch` を指定せず（＝ビルドしたマシンの arch のみ）、ランナーを分けています。

ビルドは `CSC_IDENTITY_AUTO_DISCOVERY: false` を設定して**署名なし**で行います。署名する場合は `CSC_LINK` / `CSC_KEY_PASSWORD` を secrets 経由で渡してください。

`publish: null`（`electron-builder.yml`）なので**自動更新は使いません**。利用者は Releases から手動でダウンロードします。

---

## 7. 既知の制限

| 制限 | 内容 |
|---|---|
| **未署名配布** | コード署名・公証を行っていないため、macOS では初回に右クリック →「開く」（それでも駄目なら `xattr -cr`）、Windows では SmartScreen の「詳細情報 → 実行」が必要です。署名するには Apple Developer Program / コードサイニング証明書が必要です |
| **サブフォルダを走査しない** | プロジェクトはフォルダ直下の画像だけを対象にします。再帰走査は v1 のスコープ外です |
| **AI 事前アノテーションなし** | v1 は全手入力前提です。マグネットラインは古典的画像処理による入力補助であり、機械学習は使っていません |
| **モデル出力のインポート未実装** | YOLO の txt などを読み込んで修正する機能はありません。データモデルには `source: "manual" \| "imported"` を用意してあり、v1.1 で追加できる構造にしてあります |
| **複数人の同時作業を想定していない** | 同じフォルダを複数プロセスから同時に編集することは想定外です |
| **画像の削除・回転などの編集機能なし** | ファイル操作は Finder / エクスプローラ側で行い、「フォルダ再走査」で取り込む方針です |
| **エクスポートの上限** | 画像 1 枚あたり 134,217,728 px（= 2^27）を超える寸法はスキップされます（壊れたサイドカーによるメモリ枯渇の防御） |

---

## 8. コードを変更するときの注意

- 変更前に [DESIGN.md §6「既知の罠」](DESIGN.md) を読んでください。参照実装で実際に踏んだ 13 項目が列挙されています（rAF の trailing timeout、Tab のゴーストキャッシュ消費、`getImageData` の CORS taint、`wheel` の passive、較正定数、ヒット判定のスクリーン座標固定、`blur()`、undo とジェスチャ、画像切替時の draft 処理、フォーム要素でのショートカット無効化、原子的書込、Windows のパス）。
- 契約ファイル（`core/types.ts` / `shared/ipc.ts` / `adapters/types.ts`）の変更は**オーケストレーター承認が必要**です。
- `reference/` は読んでよいですが**変更しないでください**（`.gitignore` 済み・非公開資産）。
- PR 前のチェックは [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。
