# T4: 月別気候を雲・雲影・大気へ接続する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、このタスクを実装するときに読む作業単位である。共通の固定前提は親計画の§2、
依存関係は§3を参照する。実装済みの契約は`done/`ではなくコードを原本とする。


**変更対象**: `earth-system.ts`、`src/render/cloud/`、`src/render/cumulus-shell.ts`、
`src/render/pipeline/cloud-scattering.ts`、`src/render/pipeline/shadow/cumulus-shadow.ts`、`src/render/atmosphere.ts`。

1. 単月`ClimateMap`を`MonthlyClimateMap.fromDeferredUrls(EarthSurfaceSource.climateMapUrls)`へ置き換える。当月・翌月だけを要求する。
2. ゲーム時刻をUTCの月とblendへ一度だけ変換し、雲場・雲影・大気へ同じ値を渡す。render-labは7月15日固定とする。
3. 半軸付き`earthSurfaceUv`を地球の雲場、積雲殻、散乱、雲影、大気へ共有する。球面UVをEarth経路で直接使わない。
4. AのGSHHG陸地被覆率を使い、Bの標高から海陸を再推定しない。GEBCO、旧MODIS、旧`earth-climate.png`、旧`smoothness.png`のEarth実行時参照を削除する。
5. 気候mapの世代変更で雲場と影を再生成し、12枚全てを同時GPU常駐させない。

**検証**: `npm run test:render`、`npm run test:game`、気候復号fixture。赤道、60度、両極、±180度、海岸、負標高陸、海底で地表・雲場・雲影・大気の標識が一致することを確認する。
