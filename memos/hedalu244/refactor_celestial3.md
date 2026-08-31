# 天体まわりに残っている論点 — 現況

`2d55148b` 以降の再編で分散した6文書を畳んだもの。回収元は
`refactor_celestical.md` / `refactor_celestical2.md` / `refactor_celestical_cache.md` /
`refactor_frame_transform.md` / `refactor_orbit_ephemeris.md` / `rename-ephemeris.md`(すべて破棄)。

**回収時にすべての項目をコードで追い直した。**「見送り」「判断済み」とされていたものも含めて
現況を確かめ、以下は**現在形**で書いてある。行番号・件数は **`bccc9573`** 時点の
スナップショットであり、正本ではない — 食い違ったらコードを信じる。
(2節は `4fa32d78`〜`bccc9573` で実施済み。他の節は `9b9d88ca` 時点の調査のまま。)

再編の4軸(集合は `CelestialSystem` だけが扱う / `CelestialEntity` は自分のことだけ知る /
時間元期の統一 / 座標系を層ごとに統一)は**どれも到達済み**で、以下は**その外側に残ったもの**。

---

## 0. 一覧

| # | 論点 | 状態 | 次にやること |
| --- | --- | --- | --- |
| 1 | 命名体系(`ephemeris` / `orbit` / `pack` / 原点を名前に出す) | **未着手。ただし 2節 の作業で対象が減った** | 規範を CODING-RULE へ置いてから実施 |
| 2 | 暦側の層が6段 | **解消済み**(`bccc9573` まで)。7節へ | — |
| 3 | 回転基準系が2枝で食い違う | **未判断。未測定のまま** | ω の揺れを月で測る |
| 4 | μ=0 の惑星が系の重心不変条件を破る | **方針未決。テストは宣言済み** | 「μ 未測定」の扱いを決める |
| 5 | 恒星の無い星系で惑星の解析加速度が原点向き | **現存。コメントも無い** | 惑星を2体置くときに直す |
| 6 | `'primaryRel'` の中心が型に出ない | **現存。タグ説明には明記済み** | 実行時に中心が決まる経路がある以上、型では塞げない |
| 7 | `FrameAnchors.attractorOf` の文字列キー | **現存。当たらない経路が実在する** | 実測してから消す/差し替える |
| 8 | `CelestialBody`(凍結スナップショット)が要るのか | **現存。凍結の理由2つとも生きている** | 疑うなら要求の作り直しから |
| 9 | 一般化層に残る天体固有値4件 | **全件現存** | 個別に判断 |
| 10 | `render/` → `game/` の import 9件 | **現存(値 import 1件)** | 色の所有者を `render/` へ移す |
| 11 | `solar-system/` の置き場・`small-bodies.ts` の大きさ | **現状維持で妥当** | — |
| 12 | `memos/` の死んだパス | **現存。件数は当時の記録と合わない** | 触らない |
| 13 | 系全体の固定軸を黄道へ揃え直す | **未判断・優先度低** | 往復が実測で効くまで見合わない |

**閉じた項目は7節。**

---

## 1. 命名体系 — `rename-ephemeris.md` の回収

**計画は8手順すべて未実施。** ただし**前提の一部は再編が勝手に片付けた**ので、着手前に引き直す。

### 消えた前提(計画のまま実施すると空振りする)

| 計画が前提にしていたもの | いまの状態 |
| --- | --- |
| `HelioEphemeris` 型 | **存在しない。** 恒星中心の暦という層ごと無い |
| `CelestialMotion.precise`(src 20 行) | **存在しない**(`grep -rn "\bprecise\b" src/` が 0 件) |
| solar-system 9ファイルの引数 `pack`(117 箇所) | **存在しない**(`grep -rnE "\bpack\b" src/game/celestial/solar-system/` が 0 件) |
| `CelestialBodyWindows`(ECI 化の担い手) | **存在しない。** `EciTransform` + `CelestialEntity` + `CelestialSystem` の3者に分かれた |
| `helioStateAt` / `packedHelioStateAt` の非対称な対 | **解消済み。** `analyticStateAt` / `packedStateAt` の対で、どちらも有標 |
| `ChebyshevEphemeris.stateOf` / `.stateAtSeconds` の同義語 | **解消済み。** `stateAtSeconds` が消え `stateOf` だけが残った |
| `FrameTag` が `'helio'` を持つ | **持たない。** `'eci' \| 'analytic' \| 'primaryRel' \| 'packed' \| 'icrf'`(争点A のとおり供給源で切る形へ) |
| 無標 `stateAt` が windows / system / entity の**3層**に並ぶ | **2層**(`CelestialSystem` / `CelestialEntity`) |

### 残っている対象(現在の件数。`src` + `tests` + `tools`、`tests/dist` を除く)

| 手順 | 対象 | 件数 | 現況 |
| --- | --- | --- | --- |
| 1 | CODING-RULE への規範の記載 | — | **未着手。** `orbit` の定義は「解析的に解ける軌道」のまま(`CODING-RULE.md:462`)で、CR3BP 焼き込み族を排除してしまう。`ephemeris` / `pack` の節も、無標 `stateAt` が ECI を指す例外の明記も無い |
| 3 | `EphemerisSeries` → `PackSegment` | 4 | 現存。ワイヤのキー `series` は凍結(`cli.mjs:71,109` が読む) |
| 5 | `PackedAbsoluteEphemeris` → `ChebyshevBarycentricEphemeris` | 14 | 現存。**`ephemeris-catalog.ts` とその回帰テストの外へは出なくなった**ので、改名の波及は小さい |
| 5 | `loadPackedAbsoluteEphemeris` | 5 | 現存 |
| 6 | `EphemerisPackFormatError` → `PackFormatError` | 52 | 現存(量の大半) |
| 6 | `ChebyshevEphemerisPack` → `ChebyshevPack` | 9 | 現存 |
| 6 | `EphemerisManifest` → `PackManifest` | 7 | 現存 |
| 6 | `DecodedEphemerisPack` → `DecodedPack` | 6 | 現存 |
| 4 | `planet-orbit.ts` のファイル名 | — | 現存。`PlanetOrbit` 型は無く(`grep` 0 件)、中身は `AU` / `planetOrbit()` / `PlanetAngles` / `planetAngles()` |
| 8 | `OrbitLine` → `EllipseLine` | 51 | 現存 |
| 8 | `RelativeOrbitLine` → `TargetRelativeLine` | 4 | 現存(軌道ではなく2点を結ぶ直線) |

**規範(第2部)・代案(2.4)・リスク(3.4)の中身は、上の消えた前提に触れていない部分がそのまま
使える。** とくに「`ephemeris` / `orbit` を分ける2軸(共通原点か主天体相対か / 天体 id で引く表か
1本の経路か)」と、ワイヤキー `series` を触ると既存セーブが全部 incompatible になる罠は現行のまま。

**手順2(死にコードの削除)と、手順5・6 のうち `AbsoluteEphemeris` 族・
`CanonicalEvaluatorEphemerisPack` に当たるぶんは、2節の作業で消化済み。**
残りは純粋な改名で、**着手前に規範(手順1: CODING-RULE への記載)を先に置く。**

---

## 2. 暦側の層 — 解消済み(`4fa32d78`〜`bccc9573`)

**6段のうち2段が消え、1段が構築時限りになった。** 残るのは下の4つで、どれも別の仕事をしている。

| 段 | 何をするか | 寿命 |
| --- | --- | --- |
| `.epk` バイト列 → `DecodedEphemerisPack` | ヘッダ解析・canonical JSON 検査・payload 長の検査 | **構築時限り**(以後は保持しない) |
| → `ChebyshevEphemerisPack` | フラットな `series[]` を天体ごとに畳み、時刻軸を元期へ寄せる。**係数は payload へのビュー** | 評価器と同じ |
| `ChebyshevEphemeris` | セグメントの二分探索と Chebyshev 評価 | pack と同じ |
| `PointEphemeris` → `EphemerisPoints` | 1点ぶんの窓(id 固定・ICRF→ゲーム軸)と、その一覧 | 星系と同じ |

**消したもの**: `CanonicalEvaluatorEphemerisPack`(ワイヤ manifest が既に宣言・検証している
事実を下流の型で言い直していただけ)、`AbsoluteEphemeris`(本番実装1つ・構築時限りのカタログ)。
**`PointEphemeris` が表現の多態の継ぎ目として残った** — 暦パック以外の供給源(例えば TLE/SGP4)が
来るとしたら、`AbsoluteEphemeris` の2つめの実装ではなくこの interface の実装になる。

副産物として、**係数の複製2回と読まれない manifest の抱え込みが消え、保持量が
18.7 MB → 7.5 MB(係数 2.99 MB に対し 6.2x → 2.5x)、`stateAt` が 350.6 ns → 184.3 ns/call。**

**`game/` は暦パックの型を一切 import しなくなった** — `loadEphemerisPoints` が
`ReadonlyMap` を返し、`PackedAbsoluteEphemeris` は `ephemeris-catalog.ts` の内側に閉じている。

---

## 3. 回転基準系が2枝に分かれ、その2枝が食い違っている(要判断)

**`orbitFrameRotationAt`(`celestial-motion.ts:272`)と `orbitNormalAt`(`:286`)は、同じ量を
2通りに答える。** 再編後も構造はそのまま。

| 枝 | 条件 | 基底の作り方 |
| --- | --- | --- |
| パック枝 | `packedOrbitRelStateAt` が引ける(自分の軌道が乗る点と主天体の**両方が直接**収録され有効期間内) | **実状態**から `h = r × v`。周期項も全部入る |
| 解析枝 | それ以外 | `keplerOrbitRotation` / `keplerOrbitNormal` = **平均要素**。周期項を含まない |

解析枝が平均要素なのは**意図的で、理由が `satellite-orbit.ts:112-116` に記録されている**:
「混ぜると角速度が滑らかでなくなるため」で、その結果、衛星の実位置は回転系の x̂ 軸から最大 2.5°
ずれる。**無視された仕様違反ではなく、記録された設計判断。**

ただしその判断は**パック枝には適用されていない**ので、**暦パックの有効期間の端をまたぐと
回転基準系が最大 2.5° 飛ぶ**し、同じ天体の同じ量が時刻によって別の定義で答えられる。

| | 得る | 失う |
| --- | --- | --- |
| 実状態に統一 | 端の飛びが消える。定義が1つになる | 解析領域で ω に周期項ぶんの揺れが入る。カメラの回転系と軌道計画の描画が動く |
| 平均要素に統一 | 角速度が滑らかになる | パック領域の精度を捨てる。SPEC の「主天体→対象の方向を x̂」から 2.5° 離れたまま |
| 2枝のまま | 値が1つも動かない | 食い違いと不連続が残る |

**決める前に測ること: 実状態へ統一したときの ω の揺れの大きさ(月で数値化)。**
「混ぜると角速度が滑らかでなくなる」がどの程度かは、コメントに書かれているだけで**いまも未測定。**

**触るときの注意:** `packedOrbitRelStateAt`(`:377`)は `orbitPointPackedStateAt`(直接収録のみ)を
使っている。合成した `packedStateAt` へ替えると**解析枝が実位置基準へ変わって 2.5° 動く。**
これを拒む検査が `tests/physics/ephemeris-points.test.ts` にあるので、意図して統一するなら
その検査ごと書き換えることになる。**コード側にも `celestial-motion.ts:380` に同じ警告がある。**

---

## 4. μ=0 の惑星が系の重心不変条件を破る(方針未決)

`PlanetSystem.computeMembers`(`planet-system.ts:112`)は `this.body.def.mu <= 0` のとき重心補正を
せず、**本体を系重心に置いたまま**返す。該当は `orcus`(衛星 `vanth`)と `quaoar`(衛星 `weywot`)で、
逸脱は **9,000〜13,500 km**。本体の μ が未測定なので比が決まらない、という意図は正しく、
コメントもある。

**テストは既に例外として宣言している** — `tests/physics/celestial-motion.test.ts:150`
(「μ が未測定の惑星は本体を系重心に置き、不変条件を破る」)と
`tests/physics/equatorial-satellites.test.ts:128`。**黙って破れている状態ではなくなった。**

残るのは**方針そのもの**:「μ 未測定」を系質量 0 として数えるのか、系質量も未知として恒星の
畳み込みから外すのか。いまは `PlanetSystem.mu` が本体を数えないので、恒星の畳み込みへ渡る系質量が
実際の 1/30 程度になる(`w = μ_sys/μ_total = 4.4e-11` なので太陽系重心への影響は 0.4 mm で無害)。
**テストが宣言している以上、いつ着手しても壊れない。**

---

## 5. 恒星を持たない星系で惑星の解析加速度が原点向きになる

`PlanetMotion.analyticAccelAt`(`celestial-motion.ts:428-430`)は `star === null` のとき
`twoBodyAccel(自分の絶対位置, 自分の μ)` を返す — 太陽系重心という**何も無い点**へ引かれる
加速度になる。`stage-debug-alt-system.ts` では当の惑星が ECI 原点なので
`EciTransform.celestialBodyAt` の `sub(accel, origin.accel)` で厳密に消え、**発火する経路が無い。**

**恒星を持たない星系に惑星を2つ置いた時点で壊れる。** そうする時に直す。

**当時「コメントに書いて残す」と決めたが、コードにはその注記が無い** — `:425-426` のコメントは
主星相対を引く理由の説明で、`star === null` の枝には触れていない。

---

## 6. `'primaryRel'` は「何に対する相対か」を持たない

`addPrimaryRelative<F>(primary: KinematicState<F>, rel: KinematicState<'primaryRel'>)`
(`kinematic-state.ts:66`)は、**どの `'primaryRel'` を、どの絶対状態へでも足せる。**
`FrameTag` が守っているのは供給源(解析 vs パック)だけで、「相対の中心が誰か」は守っていない。

`'primaryRel'` を返すのは `keplerOrbitState` / `satelliteState` / `stateOnOrbitAt` /
`toPrimaryRelative` / `kepler-extrapolation` / `PlanetSystem.satelliteRelStateAt` /
`packedOrbitRelStateAt` の各系統で、中心はそれぞれ別。

**型では塞げない**(`stateOnOrbitAt` は実行時に `el.center` で中心が決まる)。
`addPrimaryRelative` の呼び出しは **5箇所**(`celestial-motion.ts:240,416,480` /
`planet-system.ts:65,113`)で、CODING-RULE のしきい値 3 を超えるので専用関数へは割れない。
**`kinematic-state.ts:17-18` のタグ説明に「中心が誰かは型に現れない」と明記済み。** 別作業。

---

## 7. `FrameAnchors.attractorOf` の文字列キー

`frame-anchors.ts:52-60` は `${frameIndex}|${id}|${t}` という**文字列キー**で直近1件を憶える。
**毎フレーム走る経路に文字列生成が入っている。**

**コードを追った結果、当たらない経路が実在する:**

| 呼び出し元 | t の引き方 | キャッシュ |
| --- | --- | --- |
| `reference-frames.ts:98`(`frameRotationAt`) ← `trajectory-line.ts:134` | 予測点列の**サンプルごとに違う t** | 毎回ミス。文字列生成だけが残る |
| 同 ← `nav-target.ts:198` / `equator-node-marker-pair.ts:80` | `toDisplay(r, t)` を点ごとに呼ぶ | 同上 |
| 同 ← `map-camera.ts`(6箇所)/ `focus-target.ts` | 同一フレームの `displayTime` | 当たる |
| `frame-controls.ts:59` | `FRAME_ROLES` を走査 | 役割ごとに違う id で当たらない |

ただし `attractorOf` が実際に呼ばれるのは `frameRotationAt` の中で
**`rotatingWith` が登録天体でない**(機体・役割トークン)ときだけ — 登録天体は
`orbitFrameRotationAt` へ行って `attractorOf` を通らない。

**まだ実測していない。** 効いていてなお重いならもっといい持ち方を探して差し替え、効いていなければ消す。

---

## 8. なぜ `CelestialBody`(凍結スナップショット)が要るのか

争点B は「スナップショットである」ことを前提に型の守り方を決めただけで、**そもそも凍結した値を
配る必要があるのか**は別の問い。ここから疑うと変更が大規模になる。

**凍結している理由2つは、どちらもいまも生きている:**

- **積分の各段で暦を引き直さないため。** `attractorAccel`(`celestial-body.ts:78`)は
  スナップショットの `state.t` と `accel` から `celestialBodyPositionAt`(`:54`)で**その段の
  時刻へ2次外挿**する。凍結をやめると「天体数 × RK4 の段数」だけ暦の評価が走る。
- **1サブステップぶん配るため。** `SubstepCelestialBodies`(`src/game/dynamic/substep-celestial-bodies.ts`)が
  重力源・表面・大気の3組を区間の中で1組だけ組み、多数の個体がそれを共有する。

つまりスナップショットは「1時刻で凍結し、近傍時刻へ安く外挿できる形」であって、
**天体1体が自分で答えられること**とは別の要求。**疑うなら、この2つの要求を別の形で満たせるかから始める。**

---

## 9. 一般化層に残る天体固有値(全件現存)

| 何 | 場所 | なぜ残っているか |
| --- | --- | --- |
| 月固有キー `moonOrbit` / `moonEquator` | `render/scale-grid.ts:13,14,209,210,215,216` / `render/celestial-grid.ts:22,23` | HUD の設定型(`navball.ts:20,21`)・`view-options-panel.ts:125,126`・`camera-frame-panel.ts:18`・**セーブの形**(`save-data.ts:315`)・`map-camera.ts` の `CameraReferencePlane` まで波及する。木の一元化とは独立した別件 |
| `'earth'` 特例(衛星軌道線を地球系だけ常時出す) | `map/visibility-policy.ts:172` | **編集上の判断**。外すと挙動が変わる。**コメントは無い** |
| `'earth'` 直結 | `orbit-guide/orbit-guide-lines.ts:351,361` | ツンドラ等は地球専用ガイドという**仕様どおり**。コメントに「地球専用の参照軌道は描かない」と明記済み |
| `SUN_APPARENT_MAGNITUDE = -26.74` | `celestial-entity/point-entity.ts:40,46` | 表示応答の校正値。太陽固有だが game 側 |
| `graphics.rings` を個体が読む | `celestial-entity/point-entity.ts:158` / `sphere-entity.ts:103` | 個体が自分の環メッシュを描くかを設定から決めているだけで、`graphics.lodBias` を個体が読むのと同じ種類。スロット本数との密結合という移設の動機が当たらない |

---

## 10. `render/` が `game/` を import している(9件)

`protein-*.ts` の8件は `import type` で実行時の依存が無い
(`protein-atom-view` / `protein-collision-ribbon` / `protein-enemy-ship` / `protein-ribbon-color` /
`protein-ribbon` ×3 / `protein-silhouette-view`)。

**値 import は `render/title-scene.ts:6` の1件だけ** — `game/theme` から
`ACCENT` / `ACCENT_SECONDARY` / `ACCENT_SOFT` / `BG` を引いている。
CODING-RULE 1.3 の層の向きに反するが、**色の所有者を `render/` 側へ移せば消える。**

逆向き(`celestial/` → `map/`)は `celestial-system.ts:45` の `import type` 1件だけで、
**実行時の依存は 0**。

---

## 11. 置き場(現状維持で妥当)

- **`solar-system/` は `celestial/` の下。** `celestial/` 直下・`celestial-entity/` ・`orbit-guide/`
  から `solar-system/` への import は **0 件**なので、**出そうと思えばいつでも出せる。**
  出しても `solar-system/` が `celestial-entity/` の全クラスを import する事実は変わらないため、
  依存は1本も減らない。
- **`small-bodies.ts` は 570 行。** ほぼ Def のデータ表で、分割すると対応付けが外部化する。
- **`CelestialSystem` / `DynamicSystem` の非対称は説明がつく。** `celestial/` に積分機構が
  無いのは天体の運動が時刻から決まるため、`dynamic/` に「組んで返すもの」が無いのは顔ぶれを
  決めるのが `game/stages/` であるため。**論点としては決着している。**
- **`game/celestial/` を `src/celestial/` へ出せるかは `refactor_game.md` 論点4 が持つ**
  (`game/camera/` `game/marker/` `game/lines/` `game/map/` への import が残るため不成立)。
  ここには回収しない。

---

## 12. `memos/` に残る死んだパス

**当時の記録(22種)と現況が合わない。** `memos/` 全体で参照されている
`src`/`tests`/`tools`/`DEVELOP` のファイルパス 443 種のうち **168 種が存在しない**
(`src/` に限れば 140 種)。`memos/hedalu244/` だけなら `src/**.ts` の死んだパスは 8 種で、
うち5種はこの6文書の破棄で消える。

**触らない方針は変わらない** — どれもこの再編より前に消えたファイルを指しており、書き換えると
「現役に見える死んだパス」が増える。

---

## 13. 系全体の固定軸を黄道へ揃え直す(未判断・優先度低)

**「ECI 軸が系全体の軸として残っている」のは層の漏れではない**(判断済み・変わらず)。
原点変換は時刻ごとに原点天体の状態を要るが、**軸変換は定数の回転で、どの天体の状態も要らない。**
`FrameTag`(`kinematic-state.ts:20`)は**供給源と原点の札**であって、軸は `icrf` を除く全タグで共通。

軸を系の内外で分けると、変換すべき量が位置・速度から `Degree2Gravity.pole` /
`Atmosphere.pole` / `BodyOrientation.axis` / `spinRotationAt().q` / `orbitNormalAt()` /
`orbitFrameRotationAt().q` へ一気に広がる。かつ **IAU の自転要素は ICRF 赤道基準**なので、
軸を移してもこの定数方向は残る。

**固定軸の選び直し**としてなら別の問い。得るのは `satelliteState` の `eciToEcl` → 補正 →
`eclToEci` の往復消滅と `keplerOrbitState` の `ECLIPTIC_BASIS` の恒等化。失うのは
「地球の自転軸が `(0,1,0)` そのもの」という前提で、SPEC/CELESTIAL.md 3節・4.2節・8節が明記する
「ECI の Y 軸そのもの」・星野・天球グリッド・大気の共回転・静止軌道まで引き直すことになる。
**往復が実測で効いていない限り見合わない。** 残っているのは実質**名前の問題**(1節)。

---

## 14. 参考 — いま誰がどの座標を持っているか

`9b9d88ca` 時点のスナップショット。**正本ではない。**

| 保持値 | 座標 | 持ち主 |
| --- | --- | --- |
| 恒星の状態 | 太陽系重心相対 | `StarMotion.analyticCache` |
| 系重心の状態 | 太陽系重心相対 | `PlanetSystem.analyticCache` |
| 惑星本体・衛星の状態 | 太陽系重心相対 | `PlanetSystem.membersCache`(`SystemMembers`) |
| 原点天体の一式 | 太陽系重心相対 ×2 + 加速度 | `EciTransform.originCache` |
| ECI 瞬間値 | ECI 原点天体 | `CelestialEntity.eciCache` |
| 天体の集合 | ECI | `CelestialSystem.allCache` |

**主星相対・惑星本体相対を保持している場所は 0。** 公開しているのは
`PlanetSystem.satelliteRelStateAt`(`planet-system.ts:89`)の1つだけで、**保持はせず、
呼ばれるたびに太陽系重心相対どうしを引き算して作る。**

**向きの量は原点に依らない** — 自転軸・軌道法線・2次重力場の極・大気の共回転軸・姿勢
クォータニオンは軸だけで決まるので、原点変換の対象ではない。

座標変換が起きる境界は4つだけ:
`EciTransform`(太陽系重心 → ECI、f64 の絶対分解能 33 µm → 1.5 nm)/
`FloatingOrigin`(ECI → 描画原点、f32 の桁落ち回避)/
`ReferenceFrames` + `frame.ts`(ECI → 参照フレーム相対)/
`icrfToGameEci`(`absolute-ephemeris.ts:22`、ICRF 軸 → ゲーム固定軸。**原点は動かさない**)。

---

## 15. 閉じた項目(監査の結果、いま問題ではない)

| 元の指摘 | いまの状態 |
| --- | --- |
| **暦パックの火星〜冥王星が「惑星系重心」で収録され「惑星本体」として消費されている**(冥王星で 2,128 km) | **直っている。** `EphemerisPointKind = 'body' \| 'systemBarycenter'`(`absolute-ephemeris.ts:9`)を manifest が宣言し(`bodyPoints`)、`pointKindOf` が結び先を分ける。系重心は `PlanetSystem.bindEphemeris` へ、本体は `CelestialMotion` へ。本体を収録していない系は `PlanetMotion.packedStateAt`(`:411`)が系重心から重心オフセットを差し引いて補う |
| `packedPrimaryRelStateAt` が巨大惑星で見る点(落とし穴) | **解けている。** `PlanetMotion.orbitPointPackedStateAt`(`:406`)が「惑星の軌道要素が乗っているのは本体ではなく系の重心」として系重心を返す。**軌道法線の入力が要素と整合した** |
| ヒットしえない集合キャッシュ `gravityCache` / `atmosphereCache` | **消滅**(`grep` 0 件) |
| `ChebyshevEphemeris.velocityOf` / `positionOf` / `evaluate` / `segmentOf` / `IndexedBody.starts`、`EphemerisProfile.orientationModelId` | **削除・private 化済み**(`4fa32d78`)。`starts` は 10054 要素を作って一度も読んでいなかった |
| `AbsoluteEphemeris` interface を畳むか / `PackedAbsoluteEphemeris` を `ChebyshevEphemeris` へ畳むか | **前者は畳んだ**(`bccc9573`、2節)。**後者は畳まない** — `types.ts` が「Julian date はこの binary 非依存のコアから外し、明示的なアダプタ境界へ置く」と宣言しており、元期の畳み込みと軸の付け替えはその境界の仕事。評価器へ押し込むと宣言が崩れる |
| `SatelliteMotion` の絶対位置にキャッシュを置くか(実測: 置かない) | **問い自体が消えた。** 衛星の絶対位置は `PlanetSystem.membersCache` が系まるごと1件で畳んでおり、`SatelliteMotion.analyticStateAt`(`:462`)はそれを引くだけ。**畳んでいるのは絶対のほうで、惑星本体相対は引き算で作る** — 当時検討した4案のどれとも違う形へ落ちた |
| `relStateAt` が public なのは責務漏洩か(実測: 漏洩していない) | **形が変わって決着。** `SatelliteMotion.relStateAt` は無く、`PlanetSystem.satelliteRelStateAt` が唯一の公開口。呼ぶのは `celestial-motion.ts:470`(解析加速度)と `:480`(暦パックの補完)の2箇所だけで、どちらも `PlanetSystem` の外に居るために public になっている |
| `PlanetSystem.starRelStateAt` は本当に主星相対か | **疑いは外れ。** そのメソッド自体が無くなり、主星相対の二体解は `StarMotion` の畳み込みが `receiveAnalyticState`(`planet-system.ts:70`)で太陽系重心相対にして配る形になった。**主星相対の値が外へ出ない** |
| `kinematic-state.ts` の `'analytic'` が「原点は恒星中心」と書いている等、名前・コメントと実態の不一致7件 | **直っている**(`b5168ebb` / `9b9d88ca`)。`'analytic'` は「原点は太陽系重心で、恒星もその重心のまわりを動く」、`'primaryRel'` は「何かを中心に測った相対量。中心が誰かは型に現れない」 |
| `equatorialSatelliteOrbit` が `G(M+m)` でなく `GM` で周期を作る | **理由がコードに残った**(`satellite-orbit-builders.ts:8-11`):「公表された a と周期の組はその丸め精度では GM 側と整合しており、衛星質量を足すと公表値から遠のく(トリトンで +12 ppm → −92 ppm)」。**直すと悪くなるので直さない** |
| `ChebyshevEphemeris.stateOf` / `.stateAtSeconds` の同義語 | **解消済み。** `stateAtSeconds` が消えた |
| `helioStateAt`(無標・解析)/ `packedHelioStateAt` の非対称 | **解消済み。** `analyticStateAt` / `packedStateAt` でどちらも有標 |
| `CelestialSystem` / `DynamicSystem` の命名非対称 | **決着済み**(11節) |
| ECI 軸が系全体の軸として残っている | **層の漏れではない**(13節)。判断は変わらず「残す」 |
| `applyBodyClassToggle` の移設 | 呼び出し元の無い死にコードだったので削除済み |
| `AMBIENT_STRONG` / `AMBIENT_WEAK` の export | `tools/render-lab/{lab,main}.ts` が引くので残す |

---

## 16. 触ると壊れるもの

- **`tests/physics/celestial-eci-baseline.test.ts`** — ECI 値をビット単位で押さえている。
  暦の合成順を変える変更は、演算順を保てばビット一致するが、保てなければ全期待値の取り直しになる。
- **`tests/physics/celestial-motion.test.ts`** — 系ごとの重心不変条件を 1 m / 1e-6 m/s で押さえる。
  μ=0 の逸脱は `:150` が例外として宣言している。
- **`tests/physics/absolute-ephemeris.test.ts:55`** — 「未収録の衛星の軌道法線には親からの補完を
  混ぜない」。3節を実状態へ統一するなら、この検査ごと書き換えることになる。
- **ワイヤ形式のキー `series` と `EPHEMERIS_PACK_VERSION` の値**(`format.ts:38`)— 触ると
  `EphemerisContext.packFormatVersion` が変わり、**既存セーブが全部 incompatible になる。**
- **`tools/ephemeris/cli.mjs:15`** が `src/physics/ephemeris-pack/format.ts` をハードコードして
  いる。ディレクトリを畳むと CLI だけが壊れ、**`npm run typecheck` も `npm run test` も通ってしまう。**
  検査は `node tools/ephemeris/cli.mjs verify src/assets/ephemeris/modern-2026-10y.epk`。
- **`npm run render-lab:shot` は毎回 `memos/mikanixonable/protein-motion-baseline.json` を
  無条件に書き換える。** 撮影のたびに `git checkout --` で戻す。
- **`node tools/export-lagrange-orbits.mjs` は 10 分以上かかり、途中で打ち切ると
  `src/assets/orbits/*.json` を部分的に書き換えたまま残す。再生成物は commit しない。**
