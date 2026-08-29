# celestial 再編 — 完了記録

ephemeris 解体後に残っていた「見た目と運動の二重木」を解消し、太陽系のデータを game 側へ
一元化した。実施は `fcc5ba15`〜`e874bb7a`。以下は**達成した状態**と、**今回入れなかった項目**。

## 到達した骨格

- `game/celestial/` 直下 — 一般化星系の木構造(CelestialSystem / CelestialEntity)。太陽系固有の
  名前・値・id を持たない。オーロラ・同期軌道リング・表面ラインは CelestialEntity の null 許容
  フィールド。
- `physics/` — 一般化した天体の運動と軌道力学。**どの天体が存在するかを知らない。**
- `render/` — 一般化した見た目の部品(テクスチャ球・環・大気・オーロラ・恒星球)。型と機構
  だけを持ち、値は受け取る。
- `game/celestial/solar-system/` — 太陽系の木構造の構築、天体固有の運動(定数と physics 呼出)、
  固有の見た目(テクスチャ・測光・オーロラのパラメータ)、小天体の点群。

## 達成目標の判定(すべて達成)

| # | 目標 | 結果 |
| --- | --- | --- |
| 1 | `src/physics/solar-system/` が存在しない | ディレクトリ消滅 |
| 2 | `grep -rn "solar-system" src/physics/` が 0 件 | 0 件(コメント内の旧パス参照も除去) |
| 3 | 写像型の二重表が消滅(`grep -rn "in keyof" src/game/celestial/`) | 0 件 |
| 4 | `src/render/earth.ts` が無く、render に天体固有値が残らない | ファイル消滅・grep 0 件 |
| 5 | `game/celestial/` 直下から太陽系固有物が消滅 | `earth.ts` 消滅、`point-field*` は `solar-system/` 下、`instanceof Earth` 0 件 |
| 6 | `celestial-system.ts` が 500 行以下 | 485 行(再編前 521 行) |
| 7 | typecheck と全層テストが green | 623/623 passed(削除は id 並びの固定 1 件のみ) |
| 8 | 描画が再編前と同等 | render-lab 35 ケース全部が**再編前と byte 一致** |
| 9 | セーブの形が不変 | `serialize` の出力キー・`src/game/save/` とも無変更 |

**構築の網羅性**は系ごとの id union 型(`EarthSystemBodyId` など)がアンカー。`*_NAMES` と
構築関数の戻りが `Record<XxxBodyId, …>` なので、天体の書き忘れも余分も型エラーになる。
天体の宣言順(98体)は再編前と一致することを一時テストで確認済み。

## 検証で分かった、環境依存の注意

`node tools/export-lagrange-orbits.mjs` を再実行すると、焼き込み済みアセットの一部に 1e-13
規模(面外成分の丸め)の差が出る。焼き込みが読む `physics/cr3bp.ts` `halo.ts` `lagrange.ts`
`orbit-catalog.ts` と主天体半径5個は**再編の前後で byte 一致**しているので、この差は再編に
由来しない(既存アセットを焼いた時点との実行環境の違い)。**再生成物は commit しない。**

## 今回入れなかった項目(検出済みバックログ)

- `render/scale-grid.ts` / `celestial-grid.ts` の月固有キー(`moonOrbit` / `moonEquator`)。
  HUD の設定型・view-options-panel まで波及し、木の一元化とは独立した別件。
- `map-visibility.ts` の `'earth'` 特例(衛星軌道線を地球系だけ常時出す)。編集上の判断なので、
  外すと挙動が変わる。
- `orbit-guide-lines.ts` の `'earth'` 直結。ツンドラ等は地球専用ガイドという仕様どおり。
- `point-entity.ts` の `SUN_APPARENT_MAGNITUDE`(表示応答の校正値。太陽固有だが game 側)。
- `CelestialSystem` / `DynamicSystem` の命名非対称(`refactor_game.md` 論点4)。
- `small-bodies.ts` は 571 行。ほぼ Def のデータ表で、分割すると対応付けが外部化するため
  意図的に分けていない。
