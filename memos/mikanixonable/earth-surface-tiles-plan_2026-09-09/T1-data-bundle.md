# T1: 実データを読み、小領域bundleを生成する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、このタスクを実装するときに読む作業単位である。共通の固定前提は親計画の§2、
依存関係は§3を参照する。実装済みの契約は`done/`ではなくコードを原本とする。


**変更対象**: `assets-src/earth-surface/sources.json`、`tools/earth-surface/fetch-source.py`、`bake.py`、
`requirements.txt`、`contract.mjs`、関連Python/Nodeテスト。

1. ソースmanifestへ製品版、変数、単位、期間、CRS、NoData、再格子化、入力SHA-256、帰属を固定する。
   ETOPOはsurface/geoidだけを登録する。
2. 取得器へ再開、Content-Length、SHA-256、HTML応答拒否、形式・CRS・寸法・NoData検査を実装する。
3. GDAL windowed read、GSHHGの複数ring/穴/日付変更線/南極ice-front、ERA5の時間平均・単位変換・再格子化を追加する。
   全球をPythonの巨大配列へ展開せずchunkで処理する。
4. ヒマラヤ、太平洋、カスピ海、死海、南極、グリーンランド、海岸、経度±180度を含む16領域を生成する。
   色JPEG、ESTN地形、法線、GSHHG被覆率、12か月RGBA、`iceUnknown`範囲、生成ログを出す。
5. `earth-surface.json`、`tile-index.json`、`attribution.json`を生成し、base ESTBのheader、payload長、hash、z=0対応も検査する。

**検証**: Python unit test、`npm run earth-surface:test`、`npm run earth-surface:check`、入力/出力hash、NoData数、
有限値、画素方向、解析画像。実入力が無い場合は決定的fixtureを完了形とし、全球生成を成功扱いにしない。

**困難点**: BMNG/ETOPOは数十GB級、ERA5は実ファイル形式と認証に依存し、GSHHGはfixture JSONより複雑である。
