# GenbaAnno（現場アノ）

ローカルの画像フォルダを選ぶだけで使える、現場向けの学習データ作成アノテーションツールです。
バウンディングボックス・ポリゴン・ひび割れに吸着するマグネットラインに対応した
Windows / macOS 向けデスクトップアプリ（Electron）。サーバも DB も不要で、
アノテーションは画像フォルダ内の `_anno/` に JSON サイドカーとして保存されます。

**ドキュメントは整備中です。**（使い方・データ形式・エクスポート仕様は M8 で `docs/` に追加予定）

## 開発

```bash
npm install
npm run dev       # Electron で起動
npm run dev:web   # ブラウザのみで UI を起動（http://localhost:5199）
npm run test      # vitest
npm run typecheck # tsc（electron/ と src/ の両方）
npm run lint      # eslint
npm run dist:dir  # 現 OS 向けにパッケージのみ生成（release/）
```

設計方針は [`CLAUDE.md`](./CLAUDE.md) と [`docs/DESIGN.md`](./docs/DESIGN.md) を参照してください。

## ライセンス

MIT License — [`LICENSE`](./LICENSE) を参照。
