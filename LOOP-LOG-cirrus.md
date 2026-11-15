# 巻雲の大規模細長構造 — 計測ループ記録

目的: 100–1000 km の細長い巻雲構造(ジェット繊維・前線盾・WCB プルーム)の再現度を、
教師対比の評価軸を作ってから上げる。アドホックな視覚調整はしない。

## step 0: 評価軸の追加(2026-11-15)

変更: `cloud-components.mjs` に成分ごとの等価楕円長軸/短軸 [km](2 次モーメント、
長軸 = 4√λ)を追加。`cloud-detail-metrics.mjs` の shapes に `maxAxisKm`(最長成分の
長軸)と `elongatedShare`(長短比 ≥4 の成分の面積割合)を追加。`features` に
`maxAxis`(log)/`elongShare`(linear)を family 'shapes' で登録。封筒・型別距離へ自動配線。

根拠: EUMeTrain jet fibres(ジェット軸の反気旋側に沿う繊維・数百 km)、
Durran & Weber 1988(前線盾の鋭い極側境界)、WCB プルーム(帯長 ~650 km まで観測)。
型分離 F 値で maxAxis@4km = 16.35 — 判別力ありと確認。

## 基準計測(採点前の現状)

実写 cirrus(manifest 5 場面):
- 0.25km 段: maxAxis 7–38 km、elong 0.00–0.39
- 1km 段:   maxAxis 56–244 km、elong 0.02–0.10
- 4km 段:   maxAxis 242–441 km、elong 0.09–0.13(標本 3 場面のみ)

生成 cirrus 層(20 領域 × 3 時刻):
- 4km 段: maxAxis 62–1125 km と大きく分散。hl-land-12h 1125・norw-hl-6h 1017・
  peru-sc-12h 753・natl-trade-6h 694 と 1000 km 級に届く領域がある一方、
  sepac-open-12h 62・npac-jet-6h 114 のように 100 km 台の領域もある
- elong は 0.02–0.29

解釈: 「細長構造が全く無い」ではなく、**出る領域と出ない領域の差が実写より大きい
/環境との相関が弱い**のが本質らしい。次の一手は「どこに長い構造が出るべきか」の
環境条件(ジェット相対座標・上層湿度勾配・前線上昇)を生成側へ入れること。

次: 生成側へジェット相対のプルーム場を実装(設計:
dive-into-tepui2-data/cloud-prompts/p-cirrus-elongated.md、research memo 2026-11-15)。
採点は compare 再実行 + 型別距離 + 目視(montage)。
