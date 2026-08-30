# GenbaAnno（現場アノ）

**画像フォルダを選ぶだけで使える、現場向けのローカル完結アノテーションツールです。**

<!--
  リンクについて: GitHub 上では `../../releases` のような相対リンクが
  「このリポジトリの Releases」に解決されるため、リポジトリの URL を直書きしていません。
  絶対 URL にしたい場合は `../../releases` を
  `https://github.com/<アカウント名>/<リポジトリ名>/releases` に置き換えてください。
-->

GenbaAnno ("genba" = the field/job site) is a local-first annotation desktop app for building object-detection and segmentation training data from photos taken on site. You point it at a folder of images and start drawing — there is no server, no database, and no upload: annotations are written as JSON sidecar files into an `_anno/` folder next to your images, so copying the folder moves the data with it. Its main feature is the **magnet line**: click once, move the cursor, and a ghost path snaps along the dark streak of a crack; press `Tab` and the shape is committed. The snapping is classical image processing (a livewire / shortest-path search over pixel intensity) — **no machine learning is involved and nothing is annotated automatically for you**. Exports go straight into a folder as YOLO detection, YOLO segmentation, COCO, or binary mask PNG datasets. Windows and macOS, built with Electron. UI and documentation are in Japanese.

![エディタ画面の全景。左が画像一覧、中央がキャンバス、右がクラス・アノテーション一覧・操作ガイド](docs/images/shot2-editor.png)

<p align="center">
  <img src="docs/images/shot3-ghost.png" width="49%" alt="マグネットラインのゴーストガイド表示。カーソル脇に Tab 確定のチップが出ている">
  <img src="docs/images/shot6-exportdialog.png" width="49%" alt="エクスポートダイアログ。フォーマットと対象範囲を選ぶ">
</p>

---

## 特徴

- **マグネットライン** — ひび割れの始点をクリックしてカーソルを動かすと、暗い筋に沿った経路が半透明のゴーストで先読み表示されます。`Tab` を押すとその形のまま確定します（1 クリック + カーソル移動 + `Tab` で 1 本）。これは画像処理による入力補助（古典手法・機械学習は使っていません）で、勝手にアノテーションが付くわけではありません。
- **フォルダを選ぶだけ** — アップロードもインポートも不要です。撮影した画像を 1 つのフォルダにまとめて開くだけで始められます。
- **ローカル完結・データが外に出ない** — サーバも DB も使いません。アノテーションは画像フォルダ内の `_anno/` に JSON で保存され、ネットワークには一切送信されません。オフラインの現場でも動きます。
- **Windows / macOS 対応** — インストーラをダウンロードするだけで使えます。
- **3 つの描画ツール** — バウンディングボックス（矩形）・多角形・マグネットライン。ライン確定後も延長・短縮・分岐・線幅変更ができます。ライン・多角形には、検出用エクスポートで自動付与される**外接ボックスを破線でプレビュー表示**します（ツールバーの「外接枠」で切替・既定 ON）。
- **学習データ形式で直接書き出し** — YOLO 物体検出 / YOLO セグメンテーション / COCO / 二値マスク PNG。ZIP ではなくフォルダにそのまま出力するので、学習スクリプトからすぐ読めます。
- **動画からフレーム切り出し** — 撮影した動画から一定間隔で画像を切り出し、そのフォルダをそのままプロジェクトとして開けます（ffmpeg 同梱・別途インストール不要）。

---

## インストール

### 1. ダウンロード

[**Releases ページ**](../../releases) を開き、最新版の中から自分の OS のファイルをダウンロードします。

| OS | ダウンロードするファイル |
|---|---|
| macOS（Apple シリコン: M1 / M2 / M3 …） | `GenbaAnno-<バージョン>-arm64.dmg` |
| macOS（Intel） | `GenbaAnno-<バージョン>-x64.dmg` |
| Windows（64bit） | `GenbaAnno-<バージョン>-setup.exe` |
| Windows（インストールせずに使いたい場合） | `GenbaAnno-<バージョン>-portable.exe` |

> お使いの Mac がどちらか分からない場合は、画面左上のアップルマーク →「このMacについて」で確認できます。「チップ」に Apple M… と書かれていれば arm64、「プロセッサ」に Intel と書かれていれば x64 です。

> **ダウンロードしたファイルが本物か確認する（推奨）**
> 各リリースには `SHA256SUMS.txt`（ファイルの指紋の一覧）が添付されています。署名のないアプリを実行する前に、
> ダウンロードしたファイルの指紋が一覧と一致することを確認してください。
>
> ```bash
> # macOS: ダウンロードフォルダで実行し、SHA256SUMS.txt の該当行と同じ値になれば OK
> shasum -a 256 GenbaAnno-*.dmg
> ```
>
> ```powershell
> # Windows (PowerShell)
> Get-FileHash .\GenbaAnno-*-setup.exe -Algorithm SHA256
> ```

### 2. macOS の場合

1. ダウンロードした `.dmg` をダブルクリックして開きます。
2. 表示された **GenbaAnno** のアイコンを、右側の **アプリケーション** フォルダへドラッグします。
3. アプリケーションフォルダの GenbaAnno を **右クリック（または control キーを押しながらクリック）→「開く」** を選び、確認ダイアログでもう一度「開く」を押します。

> **なぜ右クリックが必要なのか**
> このアプリは Apple の有料署名（コード署名・公証）を行っていない**未署名アプリ**です。そのため、普通にダブルクリックすると
> 「開発元を確認できないため開けません」「壊れているため開けません」といった警告が出ます。
> **初回だけ右クリック →「開く」** で起動すれば、2 回目以降は通常どおりダブルクリックで開けます。

それでも「壊れているため開けません」と表示されて起動できない場合の**最終手段**として、ターミナル（アプリケーション → ユーティリティ → ターミナル）で次の 1 行を実行してから、もう一度起動してください。ダウンロード時に付く隔離属性（Gatekeeper の検査対象マーク）を取り除くコマンドです。

```bash
xattr -cr /Applications/GenbaAnno.app
```

> **注意**: このコマンドは macOS の保護を一部外す操作です。実行してよいのは、
> ①ダウンロード元がこのリポジトリの Releases ページであること、②上記の SHA-256 の指紋が一致していること、
> の 2 点を確認できた場合だけにしてください。対象のパス（`/Applications/GenbaAnno.app`）以外に使わないでください。

### 3. Windows の場合

1. ダウンロードした `GenbaAnno-<バージョン>-setup.exe` をダブルクリックします。
2. 「**Windows によって PC が保護されました**」という青い画面（SmartScreen）が出たら、
   **「詳細情報」→「実行」** の順にクリックします。
3. インストール先を選んでインストールします（管理者権限は不要です）。

> こちらも署名をしていないための警告です。ダウンロード元が [Releases ページ](../../releases) であることを確認してから実行してください。
> インストールしたくない場合は `GenbaAnno-<バージョン>-portable.exe` をそのまま実行すれば、インストールなしで起動できます。

---

## クイックスタート

1. **画像を 1 つのフォルダにまとめます。** 対応形式は `.jpg` `.jpeg` `.png` `.webp` `.bmp` です。**サブフォルダの中は読み込みません**（フォルダ直下の画像だけが対象です）。
2. **GenbaAnno を起動し、「画像フォルダを開く」** を押してそのフォルダを選びます。1 枚目の画像が自動で開きます。
3. **`L` キーを押します**（ライン＝マグネットラインツール。最初から選ばれています）。
4. **ひび割れの始点をクリック**し、そのまま**カーソルを終点あたりへ動かします**。暗い筋に沿った赤い経路（ゴースト）が表示されます。
5. **`Tab` を押します。** ゴーストどおりの形でラインが 1 本確定します。うまく沿わなかったときは `Backspace` で 1 区間ずつ戻せます。
6. **`E` を押します。** その画像が保存され「完了」になり、次の画像へ進みます。
   **損傷が写っていない画像も `E` で「完了」にしてください。** アノテーション 0 件の完了画像は、学習で重要な**負例**（対象物が写っていない教師データ）として書き出されます。
7. 全部終わったら、画面右上の **「エクスポート」** から形式を選び、出力先フォルダを指定して実行します。

詳しい操作は [**docs/USAGE.md（操作マニュアル）**](docs/USAGE.md) を参照してください。

---

## 主なショートカット

よく使うものだけの抜粋です。全一覧はアプリ内の `?` キー、または [docs/USAGE.md](docs/USAGE.md#8-ショートカット一覧) にあります。

| キー | 動作 |
|---|---|
| `L` | ラインツール（マグネットライン） |
| `R` | 矩形（バウンディングボックス）ツール |
| `W` / `N` | 多角形ツール |
| `V` | 編集モード（選択・頂点編集） |
| `Tab` | 表示中のゴースト経路のまま確定する（マグネット描画中） |
| `Enter` | 描画中の図形を確定する |
| `Backspace` | 1 つ戻す（マグネットは 1 区間ずつ） |
| `Delete`、または `Ctrl` / `Cmd` + `Backspace` | 選択中のアノテーションを丸ごと削除（MacBook は `⌘` + `delete`。ツールバーの「削除」ボタンでも同じ） |
| `Esc` | 描画を破棄 → 選択解除 → 編集モード |
| `M` | マグネット ON / OFF |
| `[` `]` | 線幅を細く / 太く |
| `←` `→`（または `A` `D`） | 前 / 次の画像へ（未保存なら自動保存） |
| `E` | 保存して「完了」にし次へ |
| `X` | 「スキップ」にして次へ（エクスポート対象外） |
| `Ctrl` / `Cmd` + `S` | 保存 |
| `Ctrl` / `Cmd` + `Z` | 元に戻す（`Shift` を足すとやり直し） |
| `?` / `H` | ショートカット一覧を開く |

---

## データの保存場所

アノテーションは、**選んだ画像フォルダの中**に作られる `_anno/` フォルダへ保存されます。

```
<選んだ画像フォルダ>/
  IMG_0001.jpg
  IMG_0002.jpg
  …
  _anno/
    project.json                  … クラス定義・ツール設定
    annotations/
      IMG_0001.jpg.json           … 画像 1 枚ぶんのアノテーション
      IMG_0002.jpg.json
    backups/                      … 保存前の 1 世代前（事故復旧用）
```

- 画像とアノテーションが同じ場所にあるので、**フォルダごとコピー／移動すればデータも一緒に移動します。** バックアップも「フォルダをコピーするだけ」です。
- 保存は「一時ファイルに書いてから置き換える」方式（原子的置換）で、書き込み中に電源が落ちても既存ファイルが壊れません。加えて直前の 1 世代が `_anno/backups/` に残ります。
- 30 秒ごとの自動保存と、画像を切り替えるときの自動保存があります。
- ファイル形式の詳細は [docs/FORMATS.md](docs/FORMATS.md) を参照してください。

---

## エクスポート形式

出力先フォルダを選ぶと、そのフォルダへ直接書き出します（ZIP にはしません）。

| 形式 | 出力されるもの | 対象になるアノテーション |
|---|---|---|
| **YOLO 物体検出**（`yolo_det`） | `images/{train,val}/` + `labels/{train,val}/*.txt`（`class cx cy w h`）+ `data.yaml` | 矩形。多角形・ラインは外接矩形として含める（既定 ON・切替可） |
| **YOLO セグメンテーション**（`yolo_seg`） | `images/{train,val}/` + `labels/{train,val}/*.txt`（`class x1 y1 x2 y2 …`）+ `data.yaml` | 多角形・ライン。矩形は矩形ポリゴンとして含める（既定 OFF・切替可） |
| **COCO** | `annotations/{train,val}.json` + `images/{train,val}/` | すべて（`bbox` と `segmentation` の両方を出力） |
| **二値マスク PNG**（`mask_png`） | `images/{train,val}/` + `masks/{train,val}/*.png`（0/255 の 1 チャネル） | 多角形・ライン（クラスで絞り込み可） |

共通の仕様:

- **対象範囲**は「完了のみ」（既定）か「完了 + 作業中」。**未着手・スキップは絶対に含まれません。**
- **負例**（アノテーション 0 件の空ラベル）として出力されるのは「完了」にした画像だけです。
- train / val の分割は**ファイル名のハッシュ**で 1 枚ずつ独立に決めるため、**あとから画像を追加しても既存画像の所属は変わりません**（再学習時のリーク防止）。
- 出力フォルダの `export_manifest.json` に、分割結果・除外されたアノテーションとその理由・クラス ID の対応表が記録されます。

各形式の正確なディレクトリ構造・ラベル仕様・除外規則は [docs/FORMATS.md](docs/FORMATS.md) にまとめてあります。

---

## ソースからビルドする

必要なもの: **Node.js 22.13 以上の 22 系、または 24 以上**（`package.json` の `engines` は `^22.13.0 || >=24`）と npm。

```bash
git clone <このリポジトリの URL>
cd genba-anno

npm ci                # 依存を導入
npm run dev           # Electron で開発起動
npm run dev:web       # ブラウザだけで UI を起動（http://localhost:5199・ダミーデータ）

npm run typecheck     # 型検査（electron/ と src/ の両方）
npm run test          # vitest
npm run lint          # eslint

npm run dist          # 実行中の OS 向けにインストーラを作る（release/ に出力）
npm run dist:dir      # インストーラを作らずパッケージだけ（動作確認用）
```

補足:

- **初回の `npm ci` では Electron 本体のバイナリ（100MB 超）のダウンロードが走ります。** ネットワーク環境によっては数分かかります。
- **macOS で `npm run dist` を実行すると、キーチェーンにある署名 ID（個人の Apple Development 証明書など）が自動検出され、意図せずそれで署名されることがあります。** 配布物を署名なしにしたい場合は次のように実行してください（GitHub Actions では設定済みです）。

  ```bash
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
  ```

- `npm run dist` は**実行したマシンの CPU アーキテクチャ向けだけ**をビルドします（同梱の ffmpeg がホストの arch 用バイナリ 1 つしか持たないため）。macOS の arm64 版と x64 版は別々のマシン（CI では別ランナー）でビルドします。

---

## ドキュメント

| ドキュメント | 内容 | 想定読者 |
|---|---|---|
| [docs/USAGE.md](docs/USAGE.md) | 操作マニュアル（画面構成・ツールの使い方・ショートカット全一覧・トラブルシューティング） | 現場でアノテーションを付ける方 |
| [docs/FORMATS.md](docs/FORMATS.md) | 保存ファイルとエクスポートの仕様（JSON スキーマ・ラベル形式・split 規則・manifest） | 学習パイプラインを組む方 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | アーキテクチャ・開発環境・テスト・リリース手順・既知の制限 | 開発者 |
| [docs/DESIGN.md](docs/DESIGN.md) | 実装設計書（設計判断と既知の罠） | 開発者 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 変更を送る前のチェック | 開発者 |

---

## ライセンス

MIT License — [LICENSE](LICENSE) を参照してください。
