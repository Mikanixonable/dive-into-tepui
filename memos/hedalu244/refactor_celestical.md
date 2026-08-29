# celestial 再編 — ephemeris 解体の完遂

本文中のファイル:行の参照と依存の記述は **`14dd2a24` 時点のコードから引いたスナップショットで
あり、正本ではない。** 食い違ったらコードを信じる。

## 目的

1a1bc83e からの ephemeris 解体は「見た目と運動の二つの木構造が並列にあり、対応付けが脆弱」
という病気を直すためのものだったが、一元化が徹底されておらず、山の中腹で止まっている。
現状の問題は次の6群。

**P1. 木構造の二重化が残っている。** `src/physics/solar-system/`(Def + 運動の構築関数 +
`*Motions` named-field 型)と `src/game/celestial/solar-system/`(名前 + 測光 + entity 構築)が
並列に立ち、後者は写像型 `{ [K in keyof XxxMotions]: CelestialEntity }` で前者へ縛り付けられて
いる。系を1つ足すと2ファイルを書く。写像型はこの二重化の症状であって解ではない。

**P2. physics が太陽系固有データを抱えている(依存の逆流を含む)。**

- `physics/celestial-motion.ts:21-22` — 木の土台である Motion クラス群が
  `./solar-system/celestial-body-def`(汎用型なのに solar-system 下にある)と
  `./solar-system/constants`(`SIDEREAL_DAY`)を import している。`spinRateOf` の
  `'eciPole'` 分岐(celestial-motion.ts:63)は地球の恒星日を汎用機構へ焼き込んでいる。
- `physics/earth-reference-orbits.ts:7` — 地球定数4つを直 import し、内部で偽の地球
  CelestialBody を組む。
- 天体 Def・定数の正本が physics 側にあるため、render(`render/earth.ts:9`)や UI
  (`game/creative/orbit-form-fields.ts:5`、`object-placer-panel.ts:13`)まで physics/solar-system を
  直読みしている。

**P3. render が固有天体の組み立てとパラメータ直書きを持っている。**

- `render/earth.ts` — `EARTH_TEXTURES`(17-23行)、雲合成式、オーロラ4本の直書き(99-102行)、
  `EarthCoastline` の内部組み込み。全体が「地球」という概念の組み立て。
- `render/aurora.ts` — `R_EARTH`(112行)、オーロラオーバル緯度 66°(85行)、発光高度配列
  (97行)、酸素輝線の色ランプ(104-109行)が直書き。機構は汎用なのに地球専用。
- `render/stars.ts` — `SUN_SURFACE_RADIANCE`(17行)と `SUN_SURFACE_COLOR`(64行)を焼き込み。
  `game/celestial/sun.ts` は半径を def から正しく引いているのに、色だけ渡せない。
- `render/pipeline/sun-light.ts` — `SUN_RADIANT_INTENSITY`(18行)・`SUN_COLOR`(26行)。
  `SunLight` クラス自体は毎フレーム値を受ける正しい器で、値の置き場だけが間違っている。
- 対称性の破れ: 月の表面ライン(`moon-surface-markings.ts`)は game から注入されるのに、
  地球の海岸線(`earth-coastline.ts`)は render/earth.ts が内部で組む。

**P4. 「任意星系」の層に太陽系固有物が漏れている。** `game/celestial/earth.ts`(celestial 直下 =
任意星系の層に地球クラス)、`game/celestial/point-field.ts`(小惑星帯・トロヤ群 — `JUPITER` Def を
直読みする太陽系固有物)。celestial-system.ts:266 は `instanceof Earth` で地球を探している。

**P5. CelestialSystem の肥大(511行)。** 個別天体に下ろせる事象を系レベルが抱えている —
`referenceLineOpacityAt` とフェード定数群(42-63行)、大気候補の組み立て(421-438行)、
環影候補の Def 読み(380-407行)、点群ビューの生成(484-490行、太陽系固有物の直接保持)。

**P6. テストが解体前のデータ構造と密結合している。** physics 層 43 ファイル中 28 が
solar-system に依存し、うち 17 ファイル(173ケース)は `solarSystemParts()` 経由で木構造
そのものに縛られている。`solar-system.test.ts` は 95 天体の id 並び全件を deepEqual で固定して
いる — 正本がコード自身にしかないテスト(CODING-RULE 4.1 違反)。テストの形の維持を理由に
構造を変えない、が今の停滞の一因なので、**壊れるテストは削除し、新構造に合わせて再設計する。**

**修正後に期待される骨格**(層ごとの持ち分):

- `game/celestial/` 直下 — **一般化星系の木構造**(CelestialSystem / CelestialEntity と、その
  統括・同期)。太陽系固有の名前・値・id を持たない。オーロラ・マップ付随表示は
  CelestialEntity の null 許容フィールド。
- `physics/` — **一般化した天体の運動**(Motion クラス群・軌道力学・摂動のヘルパー)。
  どの天体が存在するかは知らない。
- `render/` — **一般化した見た目の部品**(テクスチャ球・環・大気・オーロラ)。型と機構だけを
  持ち、値は受け取る。
- `game/celestial/solar-system/` — **太陽系の一元化先**: 木構造の構築、太陽系天体固有の運動
  (定数と physics 呼び出し)、固有の見た目(テクスチャ・測光・オーロラのパラメータ)。

## 決めたこと

ユーザーが覆せるよう、根拠と、覆したときに変わる手順を併記する。

1. **一元化の向きは game/celestial/solar-system が正本。physics/solar-system は constants 込みで
   全廃する。** 根拠: 「どの天体が存在し、どんな値を持つか」はデータであり、physics は式と機構
   だけを持つべき(CODING-RULE 1.3 の精神)。`stage-debug-alt-system.ts` が既にこの形
   (physics/solar-system を通さず celestial-motion だけで星系を組む)の先例。
   ← 覆すと手順5・6が消える。
2. **`celestial-body-def.ts`(PoleModel / ShapeDef / RingSystemDef / Degree2GravityDef)は
   physics 直下へ引き上げる。** 任意天体の汎用語彙で、celestial-motion.ts が使う。
   ← game 側へ置くと physics→game の import 逆転が要るので不可。
3. **`'eciPole'` の PoleModel に自転角速度を明示させる**(`{ kind: 'eciPole', spinRate }`)。
   地球の恒星日は地球の Def が持つ。← 覆すと physics に SIDEREAL_DAY が残り、手順6が成立しない。
4. **構築の網羅性は、系ごとの明示の id union 型をアンカーにする。** 天体の識別子は既存の
   `def.id`(`'earth'` 等。セーブの `phaseOffsets`・フォーカス・`bodiesById` が既にこれで引く)で
   あり、静的な id 集合の既存慣習(`EphemerisProfileId`、`CatalogSystemId`)に合わせて
   `type EarthSystemBodyId = 'earth' | 'moon'` の形で系ファイルが宣言する。`*_NAMES` 表は
   `Record<XxxBodyId, string>`、構築関数の戻りは `Record<XxxBodyId, CelestialEntity>` — id に
   居る天体の entity を書き忘れれば型エラー、id に無い天体を足せば過剰プロパティエラーで、
   表示名の表は id 集合の消費者の1つに下がる。`SolarSystemId` は各系 id union + `'sun'` の
   union として存続する(save-browser.ts:193 が「星系を組まずに名前を引く」静的表を要求する
   ため、`SOLAR_SYSTEM_BODY_NAMES` / `solarSystemBodyName` も存続)。
   残る限界: 「record のキー = その Def の `id` 値」の一致は型では締まらず規約のまま
   (現行の `motion.id as SolarSystemId` キャスト(solar-system.ts:61)と同等以下の緩さで、
   このキャスト自体は構築の直列化で消える)。なお GameEntity の `id` は実行時採番
   (`'entity-'` 連番)で、静的宣言 id とは別物 — 慣習の衝突はない。
5. **エンティティ構築は DOM/GPU 資源を確保しない。** テクスチャ読み(celestial-surface.ts:59)と
   canvas グロー(billboard.ts:26 → glow-texture)を build()/addTo() 時へ遅延する。これにより
   node のテストが**本番と同じ構築経路**で星系を丸ごと組める(three/webgpu が node で読める
   ことは tests/render の実績で確認済み)。← 覆すとテスト再設計(手順4・5)の土台が消える。
6. **テストの仕分け規則**: (i) 機構の検証(合成・座標系・積分・窓)はローカルに組んだ架空
   フィクスチャ星系で tests/physics に残す。(ii) 実データの検証(公転周期・歳差・ラプラス面
   など、期待値の出典が実測)はデータの置き場と同じ tests/game へ移す。(iii) 木の写し
   (id 全列挙・階層の形の固定)は削除する。
7. **render は型と機構、値は game。** `celestial-textures.ts` の既存作法(「型は render・値は
   game/celestial/solar-system」)へ全部品を揃える。オーロラは光学・幾何パラメータの引数化、
   恒星の色・面輝度・放射強度は恒星エンティティ経由。海岸線は月の表面ラインと同じ注入形へ。
8. **今回見送り(検出済みバックログ)**: `render/scale-grid.ts` / `celestial-grid.ts` の月固有
   キー(HUD の設定型・view-options-panel まで波及し、木の一元化と独立)、
   `map-visibility.ts:129` の 'earth' 特例(編集上の判断で挙動変更になる)、
   `orbit-guide-lines.ts:342` の 'earth' 直結(ツンドラ等は地球専用ガイドという仕様)、
   `point-entity.ts:34` の `SUN_APPARENT_MAGNITUDE`(表示応答の校正値)、
   `CelestialSystem`/`EntityManager` の命名非対称(refactor_game.md 論点4)。
   ← どれかを今回へ入れるなら手順7〜9の後に追加手順として積む。

## 達成目標

全手順の実施後、以下を1つずつ判定する。

1. `src/physics/solar-system/` ディレクトリが存在しない。
2. `grep -rn "solar-system" src/physics/` が 0 件(physics から太陽系データへの依存が消滅)。
3. 写像型の二重表が消滅: `grep -rn "in keyof" src/game/celestial/` が 0 件。
4. `src/render/earth.ts` が存在しない。`grep -rln "EARTH_TEXTURES\|8k_clouds\|R_EARTH\|R_SUN\|SUN_SURFACE_COLOR\|SUN_COLOR" src/render/` が 0 件
   (データ資産モジュール earth-coastline.ts / moon-surface-markings.ts は残る。
   `SUN_IRRADIANCE_1AU` と `REFERENCE_STAR_RADIANT_INTENSITY` は**描画の放射照度の目盛りの
   定義**なので render に残す — 太陽の物理量ではなく単位系の基準点で、色だけが恒星ごとの値。
   `blackbody.ts` の `SUN_TEMPERATURE` / `SUN_SURFACE_VALUE` も同じ理由で白色点の定義として残す)。
5. `game/celestial/` 直下(solar-system/ を除く)から太陽系固有物が消滅: `earth.ts` が無く、
   `point-field*.ts` が `solar-system/` 下にあり、`grep -n "instanceof Earth" src/` が 0 件。
   (「決めたこと 8」の id 直書き3件は残ってよい。)
6. `src/game/celestial/celestial-system.ts` が 500 行以下。
7. `npm run typecheck` と `npm run test`(全層)が green。テスト総数の減少は仕分け規則6の
   結果として説明できる(削除したファイルと理由を報告に列挙できる)。
8. `npm run render-lab:shot` の地球・土星・大気ケースが再編前と同等の絵(目視)。
9. セーブの `phaseOffsets` / `earthSpinPhase0` の形が不変(serialize の出力キーが同じ)。

## 手順

**残りの実施順**: **6 → 9 → 10**(手順7・8は手順3の直後に済ませた — `render/earth.ts`
の `createEarth()` がテクスチャを構築時に読むため、解体するまで地球を含む星系を DOM 無しで
組めず、手順5のテストが本番の構築経路を使えないため)。

### 手順6. constants.ts の移動と全参照の張り替え

**目的**: physics/solar-system の残骸を消し、太陽系の物理定数をデータの置き場
(`game/celestial/solar-system/constants.ts`)へ移す(P2 完了)。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/solar-system/constants.ts` | `src/game/celestial/solar-system/constants.ts` へ移動し、ディレクトリを削除 |
| src 内の参照元(手順5・7で消える分を除く): `game/player/{player,player-fire}.ts`、`game/game-entity/enemy-sun-glare.ts`、`game/stages/stage-utils/wave-attack.ts`、`game/stages/spawner/enemy-generator.ts`、`game/creative/{orbit-form-fields,object-placer-panel}.ts`、`game/celestial/{earth,point-field}.ts`、`render/{aurora,stars,earth}.ts`(手順7・8で消えるまでの暫定張り替え) | import パスを新位置へ |
| `tools/render-lab/{lab,cases}.ts`、`tools/export-moon-features.mjs`(文字列パス) | 同上 |
| `tests/` で定数を参照する残り全ファイル(手順5でローカル化しなかった分) | 同上 |

**達成条件と検証**: `npm run typecheck`。`npm run test`。
`grep -rn "solar-system" src/physics/` が 0 件(達成目標2がここで立つ)。
`node tools/export-moon-features.mjs` が読み込みまで通る。

### 手順9. CelestialSystem の荷下ろし

**目的**: P5。個別天体に下ろせる事象を CelestialEntity へ移し、CelestialSystem を
「CelestialEntity の統括 + 系レベルの選択・配線」だけにする。**挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/celestial-entity.ts` | `referenceLineOpacityAt` とフェード定数群(celestial-system.ts:42-63)を entity 側へ(自分の kind でフェード距離を選び、カメラ位置から濃さまで決める)。大気候補(celestial-system.ts:421-438 のループ内 1 体分)を `atmosphereCandidateAt(...)` として entity へ。環影・遮蔽の候補材料(def.rings の掘り出し等)を entity の公開値へ — 複数体からの**選択**は系に残す |
| `src/game/celestial/celestial-system.ts` | 上記の移譲で `syncReferenceLines` / `atmosphereCandidates` / `syncRingShadow` を選択とループだけに縮める。`FutureCelestialBodyProvider` が構造適合で要求する `defs` / `celestialBodyAt` の名前は**変えない**(simulation/arc-bodies.ts:23-28) |
| `src/game/celestial/point-field.ts` / `point-field-view.ts` | `game/celestial/solar-system/` 下へ移動(太陽系固有物)。CelestialSystem の直接保持(118, 484-490行)をやめ、構築側(solar-system.ts)が注入する null 許容の星系付随ビューとして受ける |
| `tsconfig.test.json` | include の `src/game/celestial/point-field.ts` パスを更新 |
| `tests/game/point-field.test.ts` | import パス更新 |

**達成条件と検証**: `npm run typecheck`。`npm run test:game`。
`wc -l src/game/celestial/celestial-system.ts` が 500 以下(達成目標6)。
`npm run dev` のマップで参照軌道線のフェード・小惑星帯点群・土星の環影が従前どおり(目視)。

### 手順10. 総仕上げ

**目的**: 達成目標の全判定と、規約・コメントの一括点検。

- `/refactor` を通して CODING-RULE からの逸脱(旧名残骸・重複・たらい回し)を点検する。
  特に 1.10: `solarSystemMotions` / `createEarth` / `EARTH_TEXTURES` / `*Motions` などの旧名を
  `src` `tests` `DEVELOP` `CLAUDE.md` `.claude` `memos` から全文検索して 0 件にする
  (memos は指示があるまで書き換えない — 検出したら報告のみ)。
- `/comment-cleanup` で移動・統合したファイルのコメントを一括点検する。
- 達成目標 1〜9 を1つずつ判定し、リスク表を1つずつ当てる。
- 検証: `npm run typecheck` → `npm run test` → `npm run render-lab:shot`(地球・土星・太陽)。
  実行時確認が要る項目(セーブ互換・オーロラ・GEO 表示)は `/verify` + `npm run dev` 目視。

## 見積り

| 手順 | 規模の導出 |
| --- | --- |
| 1 | 型移動1ファイル + import 張り替え ~17ファイル×1行 + PoleModel 分岐 3箇所 |
| 2 | 82行モジュールの署名変更 5関数 + 呼び出し元 2ファイル |
| 3 | render 2ファイルの資源遅延 + entity 1 + テスト基盤 3ファイル(shim・フック・tsconfig) |
| 4 | (c)機構系 9ファイル・~120ケースの書き直し(**知的作業の山場。全体の 4 割**) |
| 5 | 系ファイル統合 9 + 補助 5 ファイルの移動(physics 側 ~1,700行の移設)+ src/tools 参照 ~8ファイル + テスト移設・張り替え ~20ファイル(**物量の山場。機械的**) |
| 6 | 定数移動 1 + 張り替え ~20ファイル(手順5でローカル化した分だけ減る)×1〜2行 + tools 3 |
| 7 | render 3(削除1・改造2)+ game 5(削除1・新規1・改造3)+ render-lab 1 |
| 8 | render 3 + game 3 + render-lab 1 |
| 9 | celestial-system.ts から ~100行の移譲 + entity 側 +~80行 + point-field 移動 2 + 設定 1 |
| 10 | 横断点検のみ(新規変更なし) |

合計: 変更 ~110ファイル、うち削除 ~14(physics/solar-system 12 + render/earth + game/celestial/earth)。
統合後の系ファイルは最大 ~550行(small-bodies: 425+127)で、超過分はほぼ Def データ表。
500行基準を超えるのはこの1ファイルだけの見込みで、分割はしない(データ表の分離は対応付けの
外部化になり CODING-RULE 1.6 に反する)。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| tools の `.mjs` が文字列パスでモジュールを指定しており、型検査に掛からない | export 系ツールが静かに壊れる | 手順5・6(パス書き換え後に node で読み込み実行。生成物は commit しない) |
| `compile-physics.mjs` 経由で THREE / 画像 import を含む game モジュールを読めない | export-lagrange-orbits 等が動かない | 手順5(読み込み確認。通らなければツール側に画像 shim を足す) |
| `all` の宣言順が変わり、重力源の加算順・一覧 UI の並びが変わる | 数値の微差・回帰テストの揺れ | 手順5(新旧 id 列の一時突き合わせ) |
| セーブ互換: `phaseOffsets` のキー(天体 id)や `earthSpinPhase0` の意味が変わる | 旧セーブの復元が狂う | 手順5・7(id 不変・eciPole 検索が同値であることを確認)、手順10(/verify で旧セーブ読込) |
| 資源遅延で、build 前に dispose される経路や二重 addTo が生まれる | GPU リーク・二重描画 | 手順3(構築→build→dispose の既存契約に沿うことを sphere/point/sun で確認) |
| Billboard の遅延生成を sync の輝点経路が踏む | 戦闘ビューで惑星輝点が消える/例外 | 手順3(dev 目視: 戦闘ビューで金星等の輝点) |
| オーロラをスケール群の下へ入れて地球半径倍に膨らむ(render/earth.ts:85-87 が明記する既知の罠) | 絵が壊れる | 手順7(render-lab:shot + dev 目視) |
| 雲影の uv オフセット・albedoScale・averageHue の写し間違い | 地球の測光・天体照が変わる | 手順7(値の一対一移設を diff で確認、render-lab 地球ケース目視) |
| 恒星の色・面輝度の引数化で露出・輝点の明るさが変わる | 画面全体の明るさが揺れる | 手順8(render-lab:shot の露出ケース比較) |
| `.jpg` require フックの登録が系モジュールの require より後になる | test が起動時に落ちる | 手順3・5(run.js の先頭で登録) |
| 系ファイル統合時の転記ミス(~100体の Def・測光値) | 特定天体の軌道・絵が静かに変わる | 手順5(値の書き換えを一切しない移設。diff で数値行が対で移ることを確認) |
| `FutureCelestialBodyProvider` の構造適合(`defs` / `celestialBodyAt`)を改名で壊す | predictor が型エラー | 手順9(名前を変えない) |
| `tsconfig.test.json` / `tests/perf` の個別パス列挙が移動に追随しない | test:build が落ちる/perf が壊れたまま残る | 手順5・6・9 |
| HUD guide-value-field が地球不在星系で SSO レンジを引けない | 架空星系でクラッシュ | 手順2(null 経路の確認。zephyrus ステージで dev 目視) |
| テスト削除で守られていた実データ検証(周期・歳差)を巻き添えで消す | 太陽系データの退行に気付けなくなる | 手順4・5(削除は「木の写し」だけ。移設一覧を報告で突き合わせ) |
