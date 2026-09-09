# T1: 実データから全球bundleを生成する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

BMNG、ETOPO、GSHHG、ERA5から、初回公開用の全世界z0〜z7 bundleを決定的に生成する。
16地域は生成器の制御点として使い、全球生成の一部だけを意味しない。

## 実装範囲

変更対象は assets-src/earth-surface、tools/earth-surface、必要なデータ生成テストとする。

1. source manifestへ製品版、変数、単位、期間、CRS、鉛直基準、NoData、再格子化、
   入力SHA-256、帰属、生成器バージョンを固定する。ETOPOはice-surface elevationとgeoidだけを登録する。
2. 取得器へ再開、Content-Length、SHA-256、HTML応答拒否、形式、CRS、寸法、NoDataの検査を実装する。
3. GDALのwindowed readとchunk処理を使う。全球配列を一度にメモリへ展開しない。
4. GSHHGの複数ring、穴、日付変更線、南極ice-frontを扱う。
5. ERA5の時間平均、単位変換、経度wrap、緯度順、12枚への再格子化を固定する。
6. 全世界z0〜z7を生成し、次の制御点を必ず検査する。
   赤道、60度、両極、経度±180度、海岸、青い陸、氷、負標高陸、海底、
   ヒマラヤ、グリーンランド、南極、カスピ海、死海。
7. 色JPEG、ESTN地形、法線、GSHHG陸地被覆率、12か月1024×512 RGBA気候map、
   iceUnknown範囲、生成ログを出す。
8. earth-surface.json、tile-index.json、attribution.json、base ESTBを生成する。
9. ESTB/ESTNのheader、payload長、little-endian、NoData、hash、z=0対応を検査する。
10. tile-indexには全世界の利用可能タイルを明示する。欠落は意図した疎なデータではなく生成失敗として扱う。

## 完了条件

- 同一入力manifestから同一hashの出力を再生成できる。
- 全世界z0〜z7のtile-index件数が生成ログと一致する。
- 16制御点で有限値、画素方向、海陸判定、経度wrap、極、負標高が確認できる。
- source/output hash、帰属、生成環境をmanifestとログに残す。
- 入力データが取得できない環境では、fixtureを成功扱いにせず、実データゲートを未達成として記録する。

## 受け入れ検証

Python unit test、npm run earth-surface:test、npm run earth-surface:check、入力/出力hash、
NoData数、有限値、制御点解析画像、生成容量、生成時間を確認する。

## 注意

BMNG/ETOPOは数十GB級、ERA5は取得条件に依存し、GSHHGはfixture JSONより複雑である。
生成用の入力・中間・出力容量を先に確保する。

## 実装状況（2026-09-10）

`300ff2e8` と `1fa593c9` でmanifest検査、全球キー列挙、staging writer、`--global`入口を追加した。
入力が無い場合は明示的に停止する。実ソースのwindow renderer、実データhash、全43690タイル生成は未完了で、fixtureを本番生成の代わりにはしない。
