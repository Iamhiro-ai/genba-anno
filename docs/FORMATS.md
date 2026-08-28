# データ形式・エクスポート仕様

**対象**: 学習パイプラインを組む方 / GenbaAnno の出力を直接読み書きする方
**関連**: [README](../README.md) / [操作マニュアル](USAGE.md) / [実装設計書](DESIGN.md)

GenbaAnno には DB もサーバもありません。すべてのデータは**画像フォルダの中の JSON ファイル**として置かれ、エクスポートは**フォルダへの直接書き出し**です。この文書は、それらを外部のスクリプトから読み書きするための仕様書です。

- ディスク上の JSON は **snake_case**、座標はすべて **画像ピクセル座標の float** です。
- 内部（TypeScript）の camelCase との相互変換は `src/core/serialize.ts` の 1 箇所だけで行われます。

---

## 目次

1. [`_anno/` のレイアウト](#1-_anno-のレイアウト)
2. [`project.json`](#2-projectjson)
3. [サイドカー JSON](#3-サイドカー-json)
4. [座標系と EXIF](#4-座標系と-exif)
5. [読み込み時の修復規則](#5-読み込み時の修復規則)
6. [エクスポート共通の規則](#6-エクスポート共通の規則)
7. [出力フォーマット別の仕様](#7-出力フォーマット別の仕様)
8. [`export_manifest.json` の読み方](#8-export_manifestjson-の読み方)

---

## 1. `_anno/` のレイアウト

選択した画像フォルダ（= 1 プロジェクト）は次の構造になります。

```
<画像フォルダ>/
  IMG_0001.jpg                       # 対応拡張子: .jpg .jpeg .png .webp .bmp
  IMG_0002.jpg                       # サブフォルダは走査しない
  …
  _anno/
    project.json                     # プロジェクト設定（クラス定義・ツール設定）
    annotations/
      IMG_0001.jpg.json              # 画像 1 枚のサイドカー（拡張子込みの名前 + .json）
      IMG_0002.jpg.json
    backups/                         # 保存直前の 1 世代（各ファイル 1 個）
      IMG_0001.jpg.json
      project.json.corrupt-<ISO8601> # 壊れた原本の退避（後述）
```

- サイドカーのファイル名は **`<画像ファイル名（拡張子込み）>.json`** です。`a.jpg` と `a.png` を同居させても衝突しません。
- サイドカーが存在しない画像は **未着手（`pending`）** として扱われます。
- 書き込みはすべて「一時ファイル → `rename` による原子的置換」で、書き込み中の中断で既存ファイルが壊れることはありません。
- `backups/` には**直前の 1 世代だけ**が残ります（2 回保存すると押し出されます）。ただし例外として、**JSON として壊れていた原本**と **`schema_version` がこのアプリより新しかった原本**は、押し出されない名前 `<元の名前>.corrupt-<ISO8601>` / `<元の名前>.newer-<ISO8601>` で退避されます。

---

## 2. `project.json`

```json
{
  "schema_version": 1,
  "app": "genba-anno",
  "name": "test-images",
  "classes": [
    { "id": 0, "name": "crack", "name_ja": "ひび割れ", "color": "#E6002D" }
  ],
  "settings": {
    "default_tool": "line",
    "magnet": { "enabled": true, "invert": false },
    "line_width_default": 12
  },
  "created_at": "2026-08-28T07:17:17.900Z",
  "updated_at": "2026-08-28T07:17:17.900Z"
}
```

| フィールド | 型 | 意味 |
|---|---|---|
| `schema_version` | number | 現行 `1` |
| `app` | `"genba-anno"` | 識別子 |
| `name` | string | プロジェクト名（既定はフォルダ名） |
| `classes[].id` | number | **クラス ID**。サイドカーの `class_id` はこれを指す。エクスポート時はこの ID の**昇順**に `0..N-1` へ振り直される（[6-4](#6-4-クラス-id-のリマップ)） |
| `classes[].name` | string | 学習データ上の名前（`data.yaml` の `names` / COCO の `categories[].name`） |
| `classes[].name_ja` | string | UI 表示名 |
| `classes[].color` | string | `#RRGGBB` |
| `settings.default_tool` | `"bbox" \| "polygon" \| "line"` | 起動時の既定ツール |
| `settings.magnet.enabled` | boolean | マグネットの既定 ON/OFF |
| `settings.magnet.invert` | boolean | `true` = 明るい線を追う反転モード |
| `settings.line_width_default` | number | 線幅の初期値（画像 px） |
| `created_at` / `updated_at` | string | ISO 8601 |

クラスの追加時、新しい `id` は「既存 `id` の最大値 + 1」になります。**削除で空いた番号は再利用しません**（古いサイドカーの `class_id` が別クラスに化けるのを防ぐため）。歯抜けはエクスポート時のリマップが吸収します。

---

## 3. サイドカー JSON

`_anno/annotations/<画像ファイル名>.json`。

```json
{
  "schema_version": 1,
  "image": { "file": "IMG_0001.jpg", "width": 1600, "height": 1200 },
  "status": "done",
  "annotations": [
    {
      "id": "44df5b45-44c7-4fcd-a93f-9a84389952c3",
      "class_id": 0,
      "source": "manual",
      "kind": "line",
      "points": [[1030.85, 704.62], [1033.34, 701.11], "…"],
      "line_meta": {
        "branches": [[[1030.85, 704.62], "…"]],
        "width": 4,
        "widths": [[3.1, 3.4, "…"]]
      }
    }
  ],
  "updated_at": "2026-08-28T07:19:52.086Z"
}
```

### トップレベル

| フィールド | 型 | 意味 |
|---|---|---|
| `schema_version` | number | 現行 `1` |
| `image.file` | string | 画像のファイル名（パス区切りを含まない） |
| `image.width` / `image.height` | number | **EXIF 回転適用後**の画像サイズ（[4 章](#4-座標系と-exif)） |
| `status` | `"pending" \| "in_progress" \| "done" \| "skipped"` | [7 章の状態](USAGE.md#7-ステータス運用完了スキップ負例)。エクスポート対象の判定に使う |
| `annotations` | array | 下記 |
| `updated_at` | string | ISO 8601 |

### `annotations[]` 共通

| フィールド | 型 | 意味 |
|---|---|---|
| `id` | string | UUID（アプリ内で一意。エクスポートの除外記録で参照される） |
| `class_id` | number | `project.json` の `classes[].id` |
| `source` | `"manual" \| "imported"` | 現状はすべて `"manual"`（モデル出力の取り込みは未実装） |
| `kind` | `"bbox" \| "polygon" \| "line"` | 種別。以下のフィールドはこれで決まる |

### `kind` ごとのフィールド

| `kind` | 追加フィールド | 内容 |
|---|---|---|
| `bbox` | `box: { x, y, w, h }` | 軸平行矩形。`x, y` は左上。すべて画像ピクセル float |
| `polygon` | `points: [[x, y], …]` | 3 点以上の閉ポリゴン。**終点に始点を重複させない** |
| `line` | `points: [[x, y], …]` + `line_meta` | `points` は `line_meta` から生成された**閉ポリゴン（可変幅リボン）**。`line_meta` が真実 |

### `line_meta`

| フィールド | 型 | 意味 |
|---|---|---|
| `branches` | `[[x, y], …][]` | 中心線のポリライン群。`branches[0]` が幹、`branches[1..]` が分岐（各枝の先頭点が幹または他の枝の上のアンカー） |
| `width` | number | 代表幅（画像 px）。UI のスライダー表示に使う。`widths` の中央値相当 |
| `widths` | `number[][]` \| null（省略可） | `branches` と同じ形の、**点ごとの局所幅**。省略時は `width` の一様幅とみなす |

`points`（リボン）は `line_meta` から再生成できる派生値です。外部ツールで形だけ使うなら `points` を、中心線として扱いたいなら `branches` を読んでください。

> アプリ内でラインの**頂点を直接編集**すると `line_meta` は破棄され、`kind` が `"polygon"` に降格します（形は保たれます）。

---

## 4. 座標系と EXIF

- 座標系の原点は画像の左上、単位は**ピクセル（float・丸めなし）**です。
- 基準となる向きは **EXIF orientation を適用したあとの向き**です。ブラウザ／macOS のプレビュー／Windows のフォトで見えるのと同じ向き、`naturalWidth` / `naturalHeight` と同じ寸法だと考えてください。
- したがって、**EXIF で回転している JPEG のファイル内ピクセル配置とは向きが一致しません。** そのままファイルをコピーして学習に使うと座標がずれます。

このずれはエクスポート時に解消されます（[6-6](#6-6-exif-正規化)）。ただし `_anno/` のサイドカーを**直接**読むスクリプトを書く場合は、画像側も EXIF 適用後の向きでデコードする必要があります（Pillow なら `ImageOps.exif_transpose()` 相当）。

正規化はエクスポート時にだけ行います。サイドカーに `0..1` の正規化座標を保存しない設計です（画像サイズを変えたときの丸め誤差の蓄積を避けるため）。

---

## 5. 読み込み時の修復規則

サイドカーは手で編集できてしまうため、読み込み側は「全損させない」方針で動きます。

- 未知のフィールドは無視して読み進めます（前方互換）。
- 不正なレコードは**そのレコードだけ**捨てて警告に記録します。ファイル全体は捨てません。
- 座標は `image.width` / `image.height` にクランプされます。寸法が不明なときはクランプしません（0 に潰さないため）。
- `kind: "line"` の `line_meta` が壊れている場合は `kind: "polygon"` に降格します（頂点は残ります）。
- 画像寸法は `1..65535` にクランプされます。
- 局所幅 `widths` は「有限の正数」であればそのまま採用し、上限（代表幅上限の 4 倍 = 800px）だけを適用します。細いひび割れのテーパー情報を壊さないため、下限クランプは意図的に入れていません。

警告のうち、**再保存すると元ファイルの情報が失われるもの**（レコードのスキップ / `line_meta` 破棄による降格 / `widths` の形不一致による一様幅化 / `schema_version` が現行より新しい）は「lossy」として区別され、UI では消えない警告バナーが出て、最初の保存前に確認が入ります。座標クランプや既定値の補正といった無害な修正は lossy に含めません。

---

## 6. エクスポート共通の規則

すべてのフォーマットに共通する判定です。実装は `src/core/export/planner.ts`（純関数）にあり、`tests/export-*.test.ts` で固定されています。

### 6-1. 対象画像の選択

| `scope` | 対象 |
|---|---|
| `done`（既定） | `status == "done"` の画像だけ |
| `all` | `status == "done"` の画像すべて + `status == "in_progress"` かつ**アノテーションが 1 件以上**ある画像 |

**`pending` と `skipped` はどの設定でも絶対に含まれません。**

### 6-2. 負例（空ラベル）になる条件

空ラベル（YOLO なら 0 バイトの `.txt`、mask_png なら全 0 の PNG、COCO なら annotation を 1 件も持たない image エントリ）として出力されるのは、**`status == "done"` かつ対象アノテーションが 0 件**の画像だけです。

「0 件になった」理由が下記のいずれかの場合は、**負例にせず画像ごとスキップ**します（黙って誤った負例を作らないための線引きです）。除外理由は manifest に必ず記録されます。

| 0 件になった理由 | 扱い | manifest の記録先 |
|---|---|---|
| 面積不足・未知クラスで全滅した | スキップ | `excluded.skipped_all_polygons_too_small` |
| そのフォーマットの対象 `kind` が 1 件も無い（例: `yolo_seg` で矩形しか無い） | スキップ | `excluded_extra.skipped_no_annotations_for_format` |
| `in_progress` で対象が 0 件になった | スキップ | `excluded_extra.skipped_in_progress_without_annotations` |
| `done` で元から 0 件 / クラスフィルタで 0 件 | **負例として出力** | `counts.negatives` に加算 |

### 6-3. アノテーション単位の除外

| 条件 | 扱い | manifest の記録先 |
|---|---|---|
| 面積が **2 px² 未満**（`polygon` / `line` は shoelace 面積、`bbox` は `w × h`。いずれも画像内へクランプ後） | 除外 | `excluded.tiny_polygons` |
| `class_id` が `project.json` の `classes` に無い | 除外 | `excluded_extra.unknown_class_annotations` |
| そのフォーマットの対象外の `kind` | 出力しない | （件数のみ 6-2 の判定に使用） |
| `mask_png` のクラスフィルタから外れている | 出力しない | （記録なし。「そのクラスが写っていない画像」は正しい負例のため） |

画像単位では次も除外されます。

| 条件 | manifest の記録先 |
|---|---|
| `image.width` / `height` が 0 以下・非整数・**134,217,728 px（= 2^27）超** | `excluded_extra.invalid_dimensions` |
| 出力先でファイル名が衝突する（先に現れた方を採用）<br>`yolo_det` / `yolo_seg` / `mask_png` は**拡張子を除いた名前**の小文字比較（`a.jpg` と `a.png` は衝突）、`coco` は**拡張子込み**の小文字比較 | `excluded.name_collisions` |
| 画像ファイルのコピーに失敗した（削除された等） | `excluded.missing_files` |
| サイドカーが JSON として読めなかった | `excluded_extra.corrupt_sidecars` |

画像のコピーは**ラベルより先**に実行され、欠損が出た場合はプランを作り直してからラベルを書きます。「存在しない画像を指すラベル」が残らないようにするためです。

### 6-4. クラス ID のリマップ

エクスポートでは、`project.json` の `classes` を **`id` の昇順に並べ、`0, 1, 2 …` の連番へ振り直して**学習 ID にします。

- 対象は「データに現れたクラス」ではなく **`project.json` のクラス定義すべて**です（データの中身で学習 ID が動かないようにするため）。
- `id` が重複している定義は先に現れた方だけを採用し、`id` が有限数でない定義は捨てます。
- 対応表は `data.yaml` の `names` の並び順と一致し、`export_manifest.json` の `class_id_map` にも記録されます。

なぜリマップするか: クラスを削除すると `project.json` の `id` は歯抜けになります（例: `0, 2, 5`）。YOLO の `data.yaml` は `nc` と `names` の並びがそのまま学習 ID なので、歯抜けの ID をラベルに書くと「`nc=3` なのに `class 5` が出てくる」壊れたデータセットになります。

### 6-5. train / val の分割

**画像 1 枚ごとに独立したハッシュ閾値**で決めます。

```
frac = int(sha1(file_name + str(seed))[0:8], 16) / 2**32
split = "val" if frac < val_ratio else "train"
```

- `file_name` は拡張子込みのファイル名、`seed` は 10 進文字列化した整数、`sha1` は UTF-8 バイト列に対する標準の SHA-1 です。
- `val_ratio <= 0` のときはすべて `train` です。
- **ソート順で分割してはいけない**という判断による方式です。ソート方式だと画像を 1 枚足しただけで既存画像の所属がずれ、以前 val だった画像が train に混入して評価が汚染されます。この方式では、ある画像の所属は他の画像の有無にまったく依存しません。
- 同じ `file_name` / `seed` / `val_ratio` なら常に同じ結果になります。確定した割り当ては `export_manifest.json` の `split` に全件記録されます。

### 6-6. EXIF 正規化

出力される画像は次のように処理されます。

| 入力 | 処理 |
|---|---|
| JPEG かつ EXIF `orientation != 1` | **EXIF 回転を適用したピクセルで再エンコード**（JPEG 品質 0.95） |
| JPEG かつ `orientation == 1` または EXIF 無し | **バイト単位で無変換コピー** |
| PNG / WebP / BMP | **バイト単位で無変換コピー** |

アノテーション座標は EXIF 適用後の向きで保存されているため（[4 章](#4-座標系と-exif)）、回転付き JPEG をそのままコピーすると学習側で座標がずれます。**ずれる画像だけを焼き直し、それ以外は劣化させない**方針です。

つまり、**エクスポートされたフォルダの中では、画像ファイルの中身と座標の向きが必ず一致しています。** 学習側で EXIF を気にする必要はありません。

---

## 7. 出力フォーマット別の仕様

出力先には常に `export_manifest.json` が書かれます。COCO 以外は `images/` を `train` / `val` に分けます。

### 7-1. `yolo_det`（YOLO 物体検出）

```
<出力先>/
  images/train/IMG_0001.jpg
  images/val/IMG_0002.jpg
  labels/train/IMG_0001.txt
  labels/val/IMG_0002.txt
  data.yaml
  export_manifest.json
```

- ラベル 1 行 = `class_id cx cy w h`。座標は画像サイズで正規化し、`0..1` にクランプして**小数 6 桁固定**で書きます。
- 対象 `kind`: `bbox` は常に。`polygon` / `line` は **`includeDerivedBoxes`（既定 ON）** のとき**外接矩形**として含めます。
- アノテーション 0 件の画像は **0 バイトのファイル**になります（＝負例）。

### 7-2. `yolo_seg`（YOLO セグメンテーション）

ディレクトリ構造は `yolo_det` と同じです。

- ラベル 1 行 = `class_id x1 y1 x2 y2 …`（正規化・小数 6 桁固定・`0..1` クランプ）。
- 対象 `kind`: `polygon` / `line` は常に。`bbox` は **`includeBBoxAsPolygon`（既定 OFF）** のとき矩形 4 点ポリゴンとして含めます。
- 頂点が 3 点未満になった図形は行として書きません。

### 7-3. `data.yaml`（`yolo_det` / `yolo_seg` 共通）

```yaml
# genba-anno export (yolo_seg)
# class id は元プロジェクトの id を昇順に 0..N-1 へ振り直したもの
# （対応表は export_manifest.json の class_id_map を参照）
train: images/train
val: images/val
nc: 1
names: ['crack']
```

- **`path:` キーは意図的に書きません。** ultralytics は `path` が無ければ yaml の親ディレクトリを基準に解決します。`path: .` を書くと設定の `datasets_dir` 基準で解決されてしまい「データが見つからない」になります。
- `val` に振られた画像が 0 枚のとき、`val:` は `images/train` を指し、その旨のコメントが入ります（`val` パスが存在しないと ultralytics が起動時に落ちるため）。

### 7-4. `coco`

```
<出力先>/
  images/train/IMG_0001.jpg
  images/val/IMG_0002.jpg
  annotations/train.json
  annotations/val.json
  export_manifest.json
```

`train.json` / `val.json` は**どちらも必ず生成されます**（中身が空でも）。スキーマ:

```jsonc
{
  "images": [
    { "id": 1, "file_name": "IMG_0001.jpg", "width": 1600, "height": 1200 }
  ],
  "annotations": [
    {
      "id": 1,
      "image_id": 1,
      "category_id": 0,
      "segmentation": [[x1, y1, x2, y2, "…"]],   // kind=bbox のときは []
      "bbox": [x, y, w, h],
      "area": 1234.5,
      "iscrowd": 0
    }
  ],
  "categories": [
    { "id": 0, "name": "crack", "supercategory": "genba-anno" }
  ]
}
```

注意点:

- **`file_name` はファイル名のみ**で、`images/train/` のようなディレクトリを含みません。読み込み側で `images/<split>/` と結合してください。
- **`category_id` は 0 始まり**です（リマップ後の学習 ID と一致させています）。1 始まりを前提とするツールに渡す場合は変換してください。
- `id` / `image_id` は **split ごとに 1 始まり**です。`train.json` と `val.json` で番号が重複します。
- `segmentation` はポリゴン 1 本の平坦配列を 1 要素だけ持ちます（RLE は使いません）。分岐を含むラインも 1 インスタンス 1 ポリゴンです。`kind: "bbox"` のアノテーションは輪郭を持たないため `[]` です。
- `area` は `polygon` / `line` は shoelace 面積、`bbox` は `w × h` です。
- 画像の並び順（したがって `id` の割り当て）は**ファイル名の昇順**で決定的です。

### 7-5. `mask_png`（二値マスク PNG）

```
<出力先>/
  images/train/IMG_0001.jpg
  images/val/IMG_0002.jpg
  masks/train/IMG_0001.png
  masks/val/IMG_0002.png
  export_manifest.json
```

- マスクは **8bit グレースケール 1 チャネル**、値は **0 または 255** のみ。サイズは元画像と同じです。
- **1 画像 1 マスク**です（クラス別マスクではありません）。含めるクラスはエクスポート時のフィルタで選びます。
- 対象 `kind`: `polygon` / `line`。`bbox` は輪郭を持たないため含まれません。
- ポリゴンは 1 枚ずつ同じバッファへ塗り重ねます（＝ union）。1 つのポリゴン内部は even-odd 規則（自己交差の内側は穴）です。
- 塗りの判定はピクセル中心（`x+0.5, y+0.5`）で、境界は半開区間です。例えば矩形 (2,2)-(6,6) は `x, y ∈ [2,5]` の 4×4 ピクセルになります。
- ファイル名は**拡張子を除いた名前 + `.png`** です。

---

## 8. `export_manifest.json` の読み方

出力先の直下に必ず書かれます。**「出力されなかったもの」を説明するためのファイル**です。黙って消えたアノテーションや、黙って負例になった画像はデータセット事故の温床なので、除外は必ず理由付きでここに残ります。

```jsonc
{
  "app": "genba-anno",
  "exported_at": "2026-08-28T07:22:15.638Z",
  "params": {
    "format": "yolo_seg",
    "scope": "done",
    "val_ratio": 0.2,
    "seed": 42,
    "include_bbox_as_polygon": false
    // format に応じて class_filter / include_derived_boxes も入る
  },
  "classes": [{ "id": 0, "name": "crack" }],      // id = 学習 ID。data.yaml の names と同じ並び
  "counts": {
    "images_train": 0,
    "images_val": 1,
    "negatives": 0,                               // 空ラベルで出力した done 画像の枚数
    "annotations_exported": 1
  },
  "excluded": {
    "tiny_polygons": [],                          // {file, annotation_id, area}
    "skipped_all_polygons_too_small": [],         // 全滅でスキップした画像
    "missing_files": [],                          // 画像を書き出せなかった
    "name_collisions": []                         // "b.png (collides with b.jpg)"
  },
  "split": { "IMG_0001.jpg": "val" },             // 出力した全画像の所属
  "class_id_map": [
    { "source_id": 0, "export_id": 0, "name": "crack" }
  ],
  "excluded_extra": {
    "min_annotation_area_px2": 2,
    "unknown_class_annotations": [],              // {file, annotation_id, class_id}
    "skipped_in_progress_without_annotations": [],
    "skipped_no_annotations_for_format": [],
    "invalid_dimensions": [],                     // "bad.jpg (invalid size: 0x100)"
    "corrupt_sidecars": [],
    "sidecar_warnings": []                        // {file, warnings[]}
  }
}
```

### 確認の順番（おすすめ）

1. **`excluded_extra.corrupt_sidecars`** — 空でなければ、その画像のアノテーションは**丸ごと失われています**。最優先で確認してください。
2. **`excluded.missing_files` / `excluded_extra.invalid_dimensions`** — 画像を書き出せなかったもの。データセットの枚数が想定と合わない原因になります。
3. **`counts.negatives`** — 負例の枚数。想定より極端に多い／少ない場合は、`done` にしていない画像がないかを確認してください。
4. **`excluded.skipped_all_polygons_too_small` / `excluded_extra.skipped_no_annotations_for_format`** — 「本当はアノテーションがあったのに 1 枚まるごと出力されなかった」画像です。誤負例化を避けるための意図的なスキップですが、想定外なら設定（フォーマットのオプション・クラスフィルタ）を見直してください。
5. **`class_id_map`** — `source_id != export_id` の行があれば、**推論結果を元のクラスに戻すときにこの対応表が必要**です。
6. **`split`** — 再学習や評価の再現に使えます。`file_name → "train" | "val"` の全件です。
7. **`excluded_extra.sidecar_warnings`** — 読み込みで修復が入ったファイル。データの品質確認に使えます。

### `class_id_map` の使い方

```python
import json

m = json.load(open("export_manifest.json"))
export_to_source = {r["export_id"]: r["source_id"] for r in m["class_id_map"]}
export_to_name   = {r["export_id"]: r["name"]      for r in m["class_id_map"]}

# 推論結果の class index（= export_id）→ 元のプロジェクトのクラス ID / 名前
print(export_to_source[0], export_to_name[0])
```

`params` にはエクスポート時の設定がそのまま残っているので、同じ `seed` と `val_ratio` を渡せば同一の train / val 分割を再現できます。
