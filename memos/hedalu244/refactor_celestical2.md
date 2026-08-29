# celestial / dynamic 再編 — 完了記録

`2d55148b`〜`afbb5ab4` の再編で残っていた**二重の非対称**を解消した。実施は
`3397d413`〜`HEAD`(13 commit)。以下は**達成した状態**と、**入れなかった項目**。

## 到達した骨格

```
src/game/celestial/               時刻を与えれば状態が決まる側(ゲームの進行に左右されない)
  celestial-entity/               個体1体とその派生・環・同期軌道リング
  celestial-system.ts             個体の集合 + 毎フレーム同期
  orbit-guide/                    ラグランジュ軌道ガイドとゼロ速度曲線
  solar-system/                   太陽系の組み立て(具体的な系)
  point-field.ts / point-field-view.ts / system-membership.ts / …

src/game/dynamic/                 数値積分で動く側(位置は積分で決まる)
  dynamic-entity/                 個体1体とその派生
  dynamic-system.ts               個体の集合 + 毎フレーム同期
  simulator / predictor / contact 系 / time-step …

src/game/map/                     マップ表示ポリシー(両族にまたがる)
  display-toggles.ts              表示トグルの表と操作
  visibility-policy.ts            category/icon/label/orbit/pickable の正本
```

**残した非対称は2つとも説明がつく。** `celestial/` に積分機構が無いのは、天体の運動が時刻から
決まり `physics/celestial-motion.ts` が持つため。`dynamic/` に「組んで返すもの」が
無いのは、顔ぶれを決めるのが `game/stages/` であるため。

## 命名の規則

族語は CODING-RULE 2.2 の語をそのまま使う — **`celestial`(時刻で状態が決まる)/
`dynamic`(数値積分で状態が進む)**。
`game` は置き場の名前であって族語ではないので型名から外した。役割語は **`Entity`(個体)/
`System`(集合 + 毎フレーム同期)** の2つ。`Manager` は使わない。

主な改名: `GameEntity`→`DynamicEntity`、`EntityManager`→`DynamicSystem`、
`CelestialSystem.bodies`→`.entities`、`.bodyOf`→`.entityOf`、`starBody`→`starEntity`、
`BodyClass`→`CelestialClass`、`BodyClassToggles`→`MapDisplayToggles`、
`MapEntityKind`→`DynamicEntityKind`、`MapVisibilityPolicy.body(id)/entity(kind)`→
`.celestial(id)/.dynamic(kind)`、`arc-bodies`→`arc-celestial-bodies`、
`substep-bodies`→`substep-celestial-bodies`。

## 描画予算の判断は render が持つ

game は「何があるか」を候補として渡し、**いくつ扱えるか・どれを選ぶか**は render が決める。
`render/atmosphere.ts` の `atmosphereDraws` と同じ形に揃えた。

| 判断 | 置き場 |
| --- | --- |
| どの天体を光源にするか | `render/pipeline/lighting/planet-light-select.ts` |
| いくつ遮蔽器を採るか・どの環の影を落とすか | `render/pipeline/sun-occlusion-select.ts` |
| 環境光を何割足すか | `render/pipeline/lighting/ambient-source.ts` |
| 星殻をどこまで拡げるか | `render/stars.ts` |
| 恒星を持たない星系に置く光源 | `render/pipeline/sun-light.ts` |

**呼出規約**: render の選定関数は ECI の値(`CelestialBody` / `Vec3`)を受け、選ばれた部分集合を
ECI のまま返す。描画座標への変換は `FloatingOrigin` を持つ game 側が、**選ばれたものだけ**に
対して行う(98 体の候補を全部変換しないため)。

## 達成目標の判定(13項目すべて達成)

| # | 目標 | 結果 |
| --- | --- | --- |
| 1 | `GameEntity` が消滅 | `src`/`tests`/`tools`/`DEVELOP`/`.claude`/`memos` で 0 件 |
| 2 | `EntityManager` が消滅 | 同上 0 件 |
| 3 | `game-entity/` と `simulation/` が消滅 | ディレクトリ消滅 |
| 4 | `dynamic/dynamic-entity/` と `dynamic-system.ts` が存在 | 存在 |
| 5 | `celestial/celestial-entity/` が存在 | 存在 |
| 6 | 一般化層が太陽系層を知らない | `grep solar-system src/game/celestial/*.ts` が 0 件 |
| 7 | `bodies`/`bodyOf`/`starBody` が消滅 | `celestial-system.ts` で 0 件 |
| 8 | 描画予算の判断が game に無い | 5 定数すべて `src/game/` で 0 件 |
| 9 | `celestial/planet-light.ts` が無い | ファイル消滅 |
| 10 | 死んだ二重呼出規約が消滅 | `new NearbySystemTracker` が 1 箇所(`map-pickables.ts`)だけ |
| 11 | 過剰 export の解消 | 104 個の export を外し、公開契約の 5 つだけ残した |
| 12 | 型と回帰テストが green | typecheck 通過・623/623 passed |
| 13 | 描画パスが不変 | render-lab 35 枚が着手前と**byte 一致**(手順4・5・8・10・13 の各時点で確認) |

`npm run smoke:browser` も通っており、マップビュー・戦闘ビューの両方で実行時例外が出ない。

## 検証で分かったこと

- **render-lab は `CelestialSystem` を1行も通らない。** 自前でシーンを組んで
  `SunOcclusion.setOccluders()` を直接呼ぶので、**「35 枚 byte 一致」は描画パスが不変である
  ことしか言えない。** 選定を render へ移した手順2・3 は、移動前の実装をテストへ写して
  出力が一致することを当てる**一時テスト**で確かめた(太陽系の 5 時刻 × 基準点3種、
  および 5 時刻 × カメラ4種 × 注視点2種。どちらも空同士の比較でないことを確認済み)。
  通した後にテストは消してある(正本がコード自身しかないため)。
- **`npm run render-lab:shot` は毎回 `memos/mikanixonable/protein-motion-baseline.json` を
  無条件に書き換える。** 撮影のたびに `git checkout --` で戻した。
- **`export-lagrange-orbits.mjs` は 10 分以上かかる。** 途中で打ち切ると
  `src/assets/orbits/*.json` を部分的に書き換えたまま残す。1 度これを commit に混ぜてしまい、
  `git checkout HEAD~1 --` で戻して amend した。**再生成物は commit しない。**
- **焼き込みツールはモジュール名とその export を文字列で動的に読む。** 手順12 で export を
  絞った後、`SUN`/`EARTH`/`MARS`/`JUPITER`/`SATURN`/`R_MOON`/`cr3bp` の 2 関数が残って
  いることを確認し、`export-moon-features.mjs` を実走させて通した。

## 計画から外した判断

- **`applyBodyClassToggle` は移設ではなく削除した** — 呼び出し元が1つも無い死にコードだった。
- **表示モードの操作関数は `celestialClass*` にしなかった。** `mapDisplayModeOf` /
  `nextMapDisplayMode` / `applyMapDisplayMode` は天体クラスと個体種別の**両方**を含む表を
  受けるので、`celestialClass` を冠すると嘘の名前になる。天体クラスだけを受ける
  `celestialClassVisible` / `celestialNameVisible` は計画どおり改名した。
- **`alwaysFullyVisibleIds` は `map/` へ移した。** 天体の木の問い合わせ側に残す想定だったが、
  実装が表示トグルで絞る処理を含み、残すと `celestial/` → `map/` の逆向き依存が生まれる。
  移した結果、**実行時の `celestial/` → `map/` 依存は 0**(残るのは `sync` の引数型としての
  `import type` 1件のみ)。
- **`AMBIENT_STRONG` / `AMBIENT_WEAK` は export のまま残した** —
  `tools/render-lab/{lab,main}.ts` が環境光を手で設定するために直接引いている。
- **`Game.entities` だけを `dynamicSystem` へ改めた。** `DynamicSystem` を受け取る他クラスの
  フィールド名は `entities` のまま — あれらは「渡された個体の集合」を指すローカルな名前で、
  `celestialSystem` と対で並ぶ文脈が無い。

## 今回入れなかった項目(検出済みバックログ)

- **`render/` が `game/` を import している 9 箇所。** `protein-*.ts` の 8 件は
  `import type`(実行時の依存は無い)、`render/title-scene.ts` の 1 件だけが `game/theme` の
  色定数を値として引いている。CODING-RULE 1.3 の層の向きに反するが、タンパク質表示と
  タイトル画面の話で天体・積分側の再編とは交わらない。**値 import の 1 件は、色の所有者を
  `render/` 側へ移せば消える。**
- **`point-entity.ts` / `sphere-entity.ts` の `graphics.rings` 2 箇所。** 個体が自分の環メッシュを
  描くかどうかを設定から決めているだけで、`graphics.lodBias` を個体が読むのと同じ種類のもの。
  スロット本数と密結合という移設の動機が当たらないので残した。
- **`render/scale-grid.ts` / `celestial-grid.ts` の月固有キー**(`moonOrbit` / `moonEquator`)。
  HUD の設定型・view-options-panel まで波及する別件。
- **`map/visibility-policy.ts` の `'earth'` 特例**と **`orbit-guide-lines.ts` の `'earth'` 直結**、
  **`point-entity.ts` の `SUN_APPARENT_MAGNITUDE`**。いずれも編集上・仕様上の判断。
- **`solar-system/` は `celestial/` の下に残した。** `celestial/` 直下から `solar-system/` への
  import が 0 になったので、**出そうと思えばいつでも出せる**状態にある。出しても
  `celestial-entity/` の全クラスを import する事実は変わらないため、依存は1本も減らない。
- **`memos/` に残る死んだパス 22 種**(`environment-scene.ts` `celestial-registry.ts`
  `simulation/contact.ts` など)。**どれもこの再編より前に消えたファイル**を指しており、
  書き換えると「現役に見える死んだパス」が増えるので触っていない。再編の途中では 38 種まで
  増えたが、新しい置き場が確定しているものはすべて直したので 22 種へ戻した。
  例外は `celestial/body-visibility.ts` — 2 ファイルへ分割したため単一の移動先が無く、
  残っている 5 箇所はいずれも**既に死んだ名前が並ぶ履歴文書**なので、そこだけ手を入れると
  かえって読みにくくなると判断して残した。

## `memos/` の書き換えについて

この再編に限り、ユーザーの明示的な許可を得て `memos/mikanixonable/` を含む 60 ファイルを
書き換えた(旧識別子と、新しい置き場が確定しているパス)。**この許可はこの作業1回限りで、
`memos/` は引き続き「指示があったときだけ書き換える」領域である。**
