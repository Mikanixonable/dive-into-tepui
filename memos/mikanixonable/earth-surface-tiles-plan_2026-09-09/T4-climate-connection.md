# T4: 月別気候を雲・雲影・大気へ接続する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

地表と同じETOPO/GSHHG由来の気候mapを、Earthの雲・雲影・大気へ接続する。

## 実装範囲

1. EarthSurfaceSource.climateMapUrlsからMonthlyClimateMapを生成し、当月と翌月だけを要求する。
2. ゲーム時刻をUTCの月とblendへ一度だけ変換し、雲場、雲影、大気へ同じ値を渡す。
   render-labは7月15日の固定時刻を使う。
3. 半軸付きの共通地理UVをEarthの地表、雲場、積雲、大気、雲影へ渡す。球面UVをEarth経路で直接使わない。
4. AのGSHHG陸地被覆率を使い、Bの標高から海陸を再推定しない。水域のBは実行時に0m、
   陸地の負標高は負値として扱う。
5. Earth実行経路からGEBCO、旧MODIS、旧earth-climate.png、旧smoothness.png参照を削除する。
   cloud-labや移行前fixtureの旧ClimateMap参照は、それ自体の移行まで残してよい。
6. 気候mapの世代変更で雲場と影を再生成し、12枚全てを同時GPU常駐させない。
7. 現行の雲構成に合わせ、cloud-atmosphere-renderer、cloud-shadow-renderer、CloudPresentation、
   atmosphere-layerなど実在する責務を対象にする。削除済みの旧パスを計画や実装対象にしない。

## 完了条件

- Earth、雲、雲影、大気が同じUTC月、blend、地理UVを使う。
- 赤道、60度、両極、経度±180度、海岸、負標高陸、海底で標識が一致する。
- 12月から1月の年周回と、気候map世代変更がテストされる。
- Earth実行時のGEBCO/旧気候画像参照が無い。legacy fixtureの参照は理由を記録する。

## 実装状況（2026-09-11）

UTC月時計、地表と気候mapの共有楕円体UV、雲場・雲影・大気への同一投影、GSHHG陸地被覆率による水域判定、
旧Earth気候画像経路の除去を実装済みである。実bundleにはERA5を焼いた12枚の本番気候mapが生成済みである。

残る受け入れ作業は、実ブラウザで気候mapを適用した状態の標識一致を確認することである。実データ生成未完了としては扱わない。
