# GenbaAnno 実装設計書

**作成日**: 2026-08-28（オーケストレーター作成・実装契約）
**移植元**: `reference/`（路面診断アプリのアノテーションモジュール。マグネットライン実証済み実装）

> **注**: 本書は実装前の設計判断の記録。エクスポートのディレクトリ構造・manifest 等の
> **ディスク上の最終仕様は docs/FORMATS.md が正**（実装検証済み。本書 §5 と一部詳細が異なる）。

---

## 0. 要件（ユーザー要求の整理）

| # | 要件 | 対応 |
|---|---|---|
| R1 | 画像フォルダを選択するだけで取り込める | ネイティブフォルダ選択 → フォルダ内画像を直接列挙（アップロード不要） |
| R2 | フレームごとに素早く切り替えて修正できる | `←`/`→`・フィルムストリップ・隣接画像プリロード |
| R3 | バウンディングボックス + ひび割れに沿うセグメンテーション | bbox / polygon / line（マグネットライン）の3ツール |
| R4 | ボックス・頂点の追加/削除/編集がしやすい | 8ハンドルリサイズ・頂点D&D・エッジダブルクリック挿入・右クリック削除・undo/redo |
| R5 | Windows / macOS 両対応、GitHub からDLしてすぐ使える | Electron + electron-builder + GitHub Actions（dmg/zip/exe） |
| R6 | モデル事前アノテーション無し（全手入力）前提の操作性 | マグネットライン（ゴースト+Tab確定）を主力に、手入力効率を最優先 |
| R7 | デジタル庁デザインシステム準拠のアクセシブルUI | デザイントークン・フォーカス可視・AA コントラスト・キーボード完結 |
| R8 | 他人が導入しやすい（解説込み） | README / USAGE / FORMATS / 動画→フレーム切り出し機能・サンプル画像 |
| R9 | 動画からの学習データ作成を効率化 | ffmpeg 同梱のフレーム抽出機能（M7） |

**スコープ外（v1）**: モデル出力(YOLO txt等)のインポート修正・複数人同時作業・AI事前アノテーション。
データモデルは `source: 'manual' | 'imported'` を持ち、インポートは v1.1 で追加可能な構造にしておく。

---

## 1. アーキテクチャ決定

| 項目 | 決定 | 理由 |
|---|---|---|
| アプリ形態 | **Electron**（バックエンド・DBなし） | ①フォルダ選択→fs直接読込が自然 ②GitHub Releases で Win/mac 配布 ③参照実装の Canvas/livewire は Chromium で実証済み → WebView 差異リスクゼロ ④現場オフラインで動作 |
| ビルド | electron-vite + React + TS | 参照実装（React+TS+Vite）をほぼそのまま移植できる |
| 永続化 | 画像フォルダ内 `_anno/` に **JSONサイドカー** | DBなし=破損・移行リスクなし。フォルダごとコピーでデータが画像と一緒に移動。ML パイプラインから直接読める |
| 描画 | HTML Canvas 直接描画 | 参照実装踏襲。ライブラリ追加なし |
| マグネットライン | `reference/frontend/src/utils/livewire.ts` / `lineShape.ts` を**数値挙動を変えずに移植** | 実運用で効率実証済み。検証スクリプト同梱で回帰確認 |
| エクスポート | レンダラ主導で生成（純関数）+ main が fs 書込 | 生成ロジックを純関数で単体テスト可能に。EXIF 正規化はレンダラの createImageBitmap で行う（main に画像デコーダ native 依存を持たない） |
| ブラウザ実行 | `npm run dev:web` で MockAdapter により UI が単体動作 | E2E 検証容易化 + 将来の File System Access API 版への布石 |
| Electron セキュリティ | contextIsolation: true / nodeIntegration: false / sandbox: true。画像は `anno://` カスタムプロトコル配信（パス検証付き） | file:// 直参照や webSecurity 無効化をしない |

---

## 2. データ形式（ディスク上・snake_case）

選択フォルダ（= プロジェクト）の構造:

```
<画像フォルダ>/
  IMG_0001.jpg  IMG_0002.jpg ...     # 対応: jpg/jpeg/png/webp/bmp（サブフォルダは v1 では走査しない）
  _anno/
    project.json                     # プロジェクト設定（クラス定義・ツール設定）
    annotations/
      IMG_0001.jpg.json              # 画像ごとのサイドカー（拡張子込み名 + .json で衝突回避）
    backups/                         # 保存時の直前世代（各ファイル1世代・事故復旧用）
```

### project.json

```json
{
  "schema_version": 1,
  "app": "genba-anno",
  "name": "フォルダ名",
  "classes": [
    { "id": 0, "name": "crack", "name_ja": "ひび割れ", "color": "#E60012" }
  ],
  "settings": {
    "default_tool": "line",
    "magnet": { "enabled": true, "invert": false },
    "line_width_default": 12
  },
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

- クラス id はエクスポートの学習 ID。**UI で並べ替え・削除時に「学習IDが変わる」警告を出す**（参照実装の設計判断踏襲）
- `magnet.invert`: 明るい線（白線等）を追う反転モード（gray 反転）

### annotations/<image>.json（サイドカー）

```json
{
  "schema_version": 1,
  "image": { "file": "IMG_0001.jpg", "width": 4000, "height": 3000 },
  "status": "pending | in_progress | done | skipped",
  "annotations": [
    { "id": "uuid", "class_id": 0, "kind": "bbox", "source": "manual",
      "box": { "x": 10.5, "y": 20.0, "w": 100.0, "h": 50.0 } },
    { "id": "uuid", "class_id": 0, "kind": "polygon", "source": "manual",
      "points": [[x, y], ...] },
    { "id": "uuid", "class_id": 0, "kind": "line", "source": "manual",
      "points": [[x, y], ...],
      "line_meta": { "branches": [[[x,y],...], ...], "width": 12.0, "widths": [[...], ...] } }
  ],
  "updated_at": "ISO8601"
}
```

- 座標は**画像ピクセル座標 float**（EXIF 回転適用後 = ブラウザ表示と同じ向き。naturalWidth/Height 基準）。正規化はエクスポート時のみ（丸め誤差蓄積防止・参照実装踏襲）
- `line` の `points` は中心線から生成された閉ポリゴン（リボン）。`line_meta` が中心線の真実。頂点を手編集すると `kind: "polygon"` に降格（meta 破棄）
- 読み込み時: 座標クランプ・非有限値除去・不正レコードはスキップして警告カウント（全損させない）
- **width/height 不一致検出**: 読み込んだ画像の naturalWidth/Height とサイドカーの width/height が異なる場合（画像差し替え・EXIF 事情の変化）、警告バナーを出し座標は**スケール変換せずそのまま**表示（暗黙変換は事故のもと）

### ステータス運用（参照実装踏襲・負例事故防止）

- `pending`(未着手) → 保存で自動 `in_progress` → 「完了」ボタン/`E` で `done`、`X` で `skipped`
- **負例（アノテーション0件の教師画像）になれるのは status=done のみ**。pending/skipped はエクスポートに絶対含めない

---

## 3. モジュール構成と担当

```
genba-anno/
  electron/            # M3: main / preload / IPC / anno:// プロトコル / 原子的書込 / video抽出
  src/
    shared/ipc.ts      # 契約: IPC チャネル・ペイロード型（オーケストレーター管理）
    core/
      types.ts         # 契約: データモデル・EditorState/Action（オーケストレーター管理）
      livewire.ts      # M1: マグネット純関数（reference から数値不変で移植）
      lineShape.ts     # M1: 可変幅リボン・raster union（同上）
      geometry.ts      # M1: annotationGeometry 移植 + bbox ヒット/正規化ユーティリティ追加
      serialize.ts     # M2: サイドカー/project.json ⇔ 内部型（検証・クランプ・後方互換）
      export/          # M6: yoloDet / yoloSeg / coco / maskPng(純ラスタライザ) / split / manifest
    store/
      editorReducer.ts # M2: リデューサ（undo/redo/gesture・bbox 拡張）
      useAnnotationEditor.ts # M2: フック（AnnotationEditorApi 実装）
    adapters/
      types.ts         # 契約: StorageAdapter インターフェース（オーケストレーター管理）
      electronAdapter.ts # M3: IPC ラッパ
      mockAdapter.ts   # M3: ブラウザ用（Canvas 生成のサンプル画像内蔵）
    components/
      AnnotationCanvas.tsx # M4: キャンバスエディタ（最重要・reference 移植 + bbox 追加）
      panels/…         # M5: ImageListPanel / ClassPalette / AnnotationListPanel / Toolbar /
                       #     ShortcutHelp / ExportDialog / ClassEditorDialog / VideoImportDialog(M7)
    pages/App.tsx      # M5: 統合（キーボード・自動保存・画像切替・トースト・Welcome画面）
    styles/tokens.css  # M0/M5: デジタル庁デザイントークン
  scripts/verify_livewire.mjs / verify_lineshape.mjs  # M1: 数値回帰検証
  .github/workflows/build.yml  # M0: Win/mac ビルド CI（release は tag 手動）
  docs/ + README.md    # M8
```

**依存方向**（これ以外の import 禁止）:
components/pages → store → core、components/pages → adapters(types) 、electron → shared/ipc + core。
core は何にも依存しない（React 含む）。adapters は core の型のみ参照。

---

## 4. UX 仕様（キーボード完結・参照実装踏襲 + bbox 追加）

### ツール
- `R`: **bbox**（ドラッグで描画。8ハンドルリサイズ・内部ドラッグ移動・最小 3px）
- `W`/`N`: polygon（クリックで頂点追加、始点クリック/ダブルクリック/Enter 確定）
- `L`: line（マグネットライン。既定ツール）。`M` でマグネット ON/OFF
- `V`: 編集モード。ツールキーで draw モードへ
- マグネット描画中: ゴーストガイド表示 → **`Tab` でゴーストどおり確定**（1クリック+カーソル+Tab で1本完成）
- `Backspace` 多段: 描画中=直前1点（マグネットは1区間）/ ライン選択中=末尾点1つ / 編集中=末尾頂点1つ
- `Esc`: 描画全破棄 → 選択解除 → edit モード
- ライン編集: 端点◻クリック=延長 / `C`=短縮 / `B`=分岐 / `[` `]`=線幅
- `Delete`: 選択アノテーション削除

### ナビゲーション・ファイル
- `←`/`→` または `A`/`D`: 前後の画像（dirty なら自動保存してから切替。失敗時は confirm）
- `E`: 保存して完了(done)→次へ / `X`: スキップ→次へ
- `Ctrl/Cmd+S`: 保存（preventDefault）/ 30秒デバウンス自動保存 / ウィンドウを閉じる時 dirty 警告
- `Ctrl/Cmd+Z` / `+Shift+Z`: undo/redo / `F`: フィット / `T`: 塗りトグル / `1`〜`9`: クラス選択
- `?` / `H`: ショートカットヘルプ

### 表示
- ズーム: Ctrl/Cmd+ホイール・Mac ピンチ（カーソル中心・fitScale×0.25〜32）
- パン: ホイール / Space+ドラッグ / 中ボタン
- 明るさ・コントラストスライダー（薄いひび用・データ非破壊）
- ヘッダ: 進捗 done/total・保存状態インジケータ

---

## 5. エクスポート仕様（M6・参照実装のポリシー踏襲）

出力先フォルダを選び**直接書き込む**（ZIP 不要。フォルダがそのまま学習に使える）。

| format | 内容 | 対象アノテーション |
|---|---|---|
| `yolo_det` | `images/{train,val}/` + `labels/*.txt`（`class cx cy w h` 正規化6桁）+ `data.yaml` | bbox + オプションで polygon/line の外接矩形を含める（既定 ON） |
| `yolo_seg` | 同上、labels は `class x1 y1 x2 y2 ...` | polygon + line。オプションで bbox を矩形ポリゴンとして含める（既定 OFF） |
| `coco` | `annotations/{train,val}.json` + `images/`（bbox + segmentation 両方出力） | 全 kind |
| `mask_png` | `images/` + `masks/*.png`（0/255 単チャネル・クラスフィルタ可） | polygon + line |

共通ルール（参照実装の事故防止策を全て踏襲）:
- scope: `done`（既定）/ `all`（done + アノテーション1件以上の in_progress。pending/skipped は絶対除外）
- **負例出力は「done かつ 0件」のみ**
- train/val 分割: **画像単位の独立ハッシュ閾値方式** `sha1(ファイル名+seed) → [0,1) < val_ratio なら val`。ソート方式禁止（画像追加で既存 split が動くとリークする）
- 面積 < 2px² のポリゴンは除外し `export_manifest.json` に記録。全ポリゴンが消えた画像は負例化せずスキップ記録
- data.yaml に `path:` キーは書かない（ultralytics の datasets_dir 解決の罠）
- 出力画像: EXIF orientation ≠ 1 の JPEG はレンダラで正規化再エンコード（q95）。orientation 1/なしはバイト無変更コピー
- ファイル名衝突（大文字小文字違い等）は manifest に記録してスキップ

---

## 6. 既知の罠（参照実装で実際に踏んだもの・レビュー時チェックリスト）

1. ゴーストの rAF スロットルは **trailing timeout 必須**（最後の pointermove が窓内で止まるとゴーストがカーソルとズレる）
2. **Tab 確定はゴーストキャッシュ消費方式**（再トレースすると表示と確定結果が食い違う WYSIWYG 違反）。draft 末尾点とキャッシュ anchor の一致検査 + 状態変化時 clearGhost() の二重防御
3. `getImageData` は CORS taint で例外 → サンプリング専用 Image を分離し、失敗時は直線入力へ静かにフォールバック（anno:// プロトコルでも防御は残す）
4. wheel は React onWheel でなく `addEventListener('wheel', {passive:false})` + preventDefault（Mac ピンチがページズームに化ける）。canvas に `touchAction:'none'`
5. 幅推定の較正定数（HALF_FRAC=0.30, SHRINK=0.82, MAX_WIDTH_FRAC=0.0125 等）は実画像較正済み。**理屈で直さない**
6. ヒット判定はスクリーン座標系固定 px（頂点8px・エッジ6px）でズーム非依存
7. ボタン click 後は `blur()`（Space パンでボタン再発火→「完了」誤爆防止）
8. Canvas の見た目検証は DOM 読み取りだけでは不十分。**スクリーンショットで実表示確認**
9. undo 履歴はドラッグ中に積まない（beginGesture/endGesture。無変化なら履歴破棄）
10. 画像切替時に draft が確定可能なら自動 commit、不能なら confirm で破棄確認（全損防止）
11. Electron: `Backspace`/`Tab` 等のショートカットは input/textarea/select/contenteditable フォーカス時に無効化
12. サイドカー書込は **tmp 書込 → rename の原子的置換** + 直前世代バックアップ（電源断・クラッシュ対策）
13. Windows のパス（`\` 区切り・ドライブレター・予約名）と日本語ファイル名を全 IPC で考慮。パス結合は main 側のみで行い、レンダラには相対名のみ渡す

---

## 7. 品質基準

1. `npm run typecheck` / `npm run test` / `npm run lint` / `npm run build` が通る
2. `verify_livewire.mjs` / `verify_lineshape.mjs` が参照実装と同一の数値検証に合格
3. ブラウザモード E2E: フォルダ読込（Mock）→ bbox/polygon/line 描画 → 頂点編集 → undo/redo → 保存 → 再読込復元 → 完了 → エクスポート内容検証
4. EXIF 回転付き JPEG で座標がズレない（テスト画像で確認）
5. キーボードのみで一連の作業が完結する・フォーカスリングが常に視認できる
6. 1000枚フォルダで画像切替が体感即時（隣接プリロード・一覧仮想化）
