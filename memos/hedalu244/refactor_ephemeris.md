# orbit と ephemeris のインターフェイスを揃える

## 目的

天体の並進状態には供給源が2つある — 収録データを引く `ephemeris` と、閉じた式で解く `orbit`。
**この2つは、いま「誰に対する位置を返すか」も「絶対時刻を引数に取るか」も揃っていない。**

| | いまの `ephemeris` | いまの `orbit` |
| --- | --- | --- |
| 返す位置の原点 | 原点天体中心(ECI 変換済み) | 主天体相対 / 恒星中心(層による) |
| 時刻の引数 | 絶対時刻(JD_TDB / simTime) | 位相(真近点角・平均黄経)+ 別引数の位相定数 |

揃っていないまま名前だけを直しても、2つの供給源の対応が識別子から読めるようにならない。
**改名(`rename-ephemeris.md`)の前に、この2軸を揃える。**

## 決めたこと

覆されたときにどの手順が変わるかを各項に書く。

### 判断1. 共通の原点は「系の根」に取る。太陽系重心には**できない**

太陽系重心(SSB)を共通原点にすると、**解析側が表現できない。** 解析軌道は恒星を原点とした
ケプラー要素で書かれていて、恒星の SSB からのずれを知る手段が暦パックしかない。パックの有効期間
外ではそのずれが得られないので、SSB は「両方の供給源が表せる原点」にならない。

一方、**恒星中心はすでに解析側で揃っている。** `CelestialMotion.helioStateAt` は star / planet /
satellite のどの kind でも恒星中心を返し、`SatelliteMotion.helioStateAt`
(`celestial-motion.ts:495-500`)は惑星の恒星中心状態に惑星相対状態を足して返している —
「`SatelliteOrbit` は主天体を足し込んだものを答える」は **Motion 層では実施済み**である。

したがって共通原点は恒星中心を採る。ただし恒星を持たない星系が存在する
(`stage-debug-alt-system.ts:65` は `PlanetMotion(ZEPHYRUS, null, …)`)ため、正確には
**「階層の根の座標原点」**であり、太陽系ではそれが恒星の中心にあたる。

**揃っていないのは ephemeris 側だけ。** `OriginCenteredEphemeris`(`absolute-ephemeris.ts:33-75`)が
原点天体を引いて ECI へ落としているので、これを根(恒星)を引く形に変え、**ECI への変換は
`CelestialMotion.eciStateAt` の1箇所へ引き上げる。**

覆された場合(SSB を採る): 手順2 が成立しなくなり、暦パックの有効期間外を解析で埋める設計自体を
見直すことになる。

### 判断2. 供給源の混在規則を、暗黙から明示へ移す

**暦パックに入っているのは 11 天体だけ**(sun, mercury, venus, earth, moon, mars, jupiter, saturn,
uranus, neptune, pluto)で、登録されている天体は **98 体**ある。有効期間内でも大半は解析経路を通る。
実測では、パックの有無で t=0 の ECI 位置が変わるのは 98 体中 **54 体** — 収録 11 体より多いのは、
収録惑星の衛星が「パックの惑星 + 解析の惑星相対」で組まれるため。

いまは「自分がパックで引けるならパック経路(このとき原点天体もパックから引かれる)、引けないなら
両端とも解析」という規則が `OriginCenteredEphemeris` の内側に隠れている
(`OriginCenteredEphemeris.stateOf` が本体と原点の両方をパックから引くため)。ECI 変換を引き上げると
**両端の供給源がばらける余地ができる** — パックにある地球から、解析にしかない小惑星を引く形になり、
その天体の ECI 位置が地球の解析モデル誤差ぶん動く。

**`eciStateAt` に「両端を同じ供給源から取る」規則を明示して残す。** これを守れば数値は変わらない。

覆された場合(混在を許す): 手順1・2 が「挙動不変」でなくなり、達成目標5 の数値一致は
「パック収録天体のみ一致」へ緩める。

### 判断3. 絶対時刻の軸は J2000 ET 秒。位相定数は軌道へ畳む

解析側が実際に使っている時刻は `t + epochOffsetSec` で、`epochOffsetSec` は
`SIM_EPOCH_ET`(`sim-epoch.ts:11`)という**全天体共通の定数**。位相 `phase` は
`phases[id] ?? 0` という**天体ごとの定数**。どちらも構築時に確定するので、**軌道の値へ畳める。**

- `epochOffsetSec` は要素の永年変化が時刻の一次式なので、`a / e / inc / raan0 / lonPeri0 / l0` へ
  それぞれの rate × offset を加えるだけで厳密に畳める。
- `phase` は平均黄経の定数オフセットなので `l0` へ加えるだけで畳める。

畳めば `keplerOrbitState(orbit, t)` / `satelliteState(orbit, t)` は **純粋な t → 状態の写像**になり、
ephemeris の `stateOf(id, t)` と同じ形になる。`phaseOffsets` はセーブに残り
(`save-data.ts:335`)構築時に渡され続けるので、**セーブ形式は変わらない。**

覆された場合: 手順3 を落とす。判断1 と独立なので手順2 には影響しない。

### 判断4. `OrbitalElements` に元期を持たせる

`OrbitalElements`(`elements.ts:8-18`)は `a / e / p / incDeg / period / pHat / qHat / hHat / center`
だけを持ち、**位相の基準時刻を持たない。** 周期は知っているのに元期が無いので、絶対時刻から状態を
出せない — これが「周期から位相への変換を中に下ろす」ために埋める穴。

唯一の実質的な構築点 `orbitalElementsOf`(`celestial-body.ts:139-142`)は `KinematicState` を
受けており **`s.t` を持っているのに捨てている。** ここを通せば元期は無償で手に入る。

ただし `orbitalElementsFromClassical`(`elements.ts:171`)で組まれる参照軌道
(`earth-reference-orbits.ts:31,76`、`geostationary-overlay.ts:89`)は**位相を持たない形そのもの**で、
元期を与えられない。**元期は null 許容にし、`stateAt` は元期を持つ要素でだけ答える。**

覆された場合(元期を必須にする): 参照軌道側に意味のない元期を作らせることになるので、
手順4 は「参照軌道用の型を分ける」形へ変わる。

### 判断5. `SatelliteOrbit` の日心化は**やらない**(推奨)。選択肢を2つ出す

**案X(推奨) — Orbit 層は主天体相対のまま、日心化は Motion 層が担う(現状どおり)。**
`satelliteState` が日心を返すには `SatelliteOrbit` が `PlanetOrbit` への参照を持つ必要があり、
`CelestialMotion` が既に持っている木を Orbit 層にもう一つ作ることになる。`satelliteState` は既に
`planetAngles(planet.def.orbit, …)` を引数で受けており、木を持たずに済んでいる。

**案Y — `SatelliteOrbit` に `primary: PlanetOrbit` を持たせ、`satelliteState(orbit, t)` が日心を
返す。** 判断1・3 と合わせると、`orbit` と `ephemeris` が**完全に同じ契約**(id または軌道値 +
絶対時刻 → 根中心の状態)になり、両者を1つのインターフェイスの裏に隠せる。**欠点**: 惑星の重心補正
(`PlanetMotion.computeHelioStateAt` が全衛星の質量比で重心を戻す処理)が Orbit 層と Motion 層に
またがるため、木が二重化するだけでなく重心補正の置き場が曖昧になる。

案X なら手順5 は不要。案Y を採る場合だけ手順5 を実施する。

### やらないこと

**`orbit-guide` / `orbit-catalog` は対象外。** これらが返すのは「時刻 t に置いた閉曲線」
(`GuideLoop`)であって、時刻 → 状態の写像ではない。`CatalogFamily.points` の各点が持つ `tFrac` は
周期を1とする相対位相で、絶対時刻の位相は最初から定義されていない。引数の `t` は曲線を実位置・
実姿勢へ載せるためだけに使われている。揃える対象ではない。

## 達成目標

1. 原点天体を引く処理が `CelestialMotion.eciStateAt` の1箇所だけになる —
   `grep -rn "origin" src/physics/absolute-ephemeris.ts` が `OriginCenteredEphemeris` の
   クラス名以外を返さない。
2. `OriginCenteredEphemeris` が ECI 原点天体の id を知らない(コンストラクタが受け取らない)。
3. `keplerOrbitState` / `satelliteState` / `planetAngles` から `phaseOffset` 引数が消える —
   `grep -rn "phaseOffset" src/` が 0 件。
4. `epochOffsetSec` が `physics/` と `game/celestial/solar-system/` の引数から消える —
   `grep -rn "epochOffsetSec" src/game/celestial/` が 0 件。
5. `OrbitalElements` が元期を持ち、`stateAt(el, t)` がある。参照軌道では null を返す。
6. **数値が変わらない** — 下記のベースライン比較で、全 98 天体・全サンプル時刻の位置・速度が
   変更前と一致する(相対誤差 0)。
7. `npm run typecheck` と `npm run test`(全層)が通る。

### ベースライン比較の手順(達成目標6 の測り方)

着手前に、現行ツリーで次を走らせて基準値を採る。同じスクリプトを各手順の後に走らせて突き合わせる。

```
tests/physics/_baseline.ts(一時ファイル。*.test.ts にしないこと — run.ts は *.test.js だけ登録する)
  先頭で import '../repo-assets'(アセット require のスタブ)が要る
  solarSystemParts(phases, epochOffsetSec, absoluteSource, epochJdTdb) を3構成で組む:
    far-future(ゲーム既定): far-future-20115-10y.epk / SIM_EPOCH_ET / SIM_EPOCH_JD_TDB
    modern-de440:          modern-2026-10y.epk / 820497600 / 2461041.5
    パック無し:            null / SIM_EPOCH_ET / SIM_EPOCH_JD_TDB
サンプル時刻: パック有効期間の内側 5 点(0, 1e6, 5e7, 1.5e8, 3.1e8 秒)と外側 2 点(-1e8, 5e8 秒)
出力: 全 98 天体 × 7 時刻の stateAt(t) の r・v(計 12,348 値)を JSON へ
```

**パック収録の 11 天体だけでなく全 98 天体を出すこと** — 判断2 の混在規則が壊れると、
壊れるのは収録されていない 87 天体のほうである。

## 手順

### 手順2. ephemeris の原点を根へ移し、ECI 変換を `eciStateAt` へ集約する

**目的.** 2つの供給源が返す位置の原点を「階層の根(太陽系では恒星の中心)」へ揃える。
ECI 原点天体を引く処理を1箇所にする。**数値は変わらない**(判断2 の規則を守る限り)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/absolute-ephemeris.ts:33-75` | `OriginCenteredEphemeris` のコンストラクタが受け取る id を、ECI 原点天体から**系の根の天体**へ変える。`stateOf` は根中心・ゲーム ECI 軸の状態を返す(軸変換 `icrfToGameEci` はここに残す — 解析側が最初からゲーム ECI 軸なので、比較可能にするために必要) |
| `src/physics/celestial-motion.ts:180-196` | `eciStateAt` が、選んだ供給源から本体と ECI 原点天体の**根中心状態**を引き、その差を返す形にする。解析経路の `helio - originHelio` と同じ1つの式に合流する |
| `src/physics/celestial-motion.ts:381-390` | `packedPrimaryRelStateAt` は差分のままなので原点が変わっても不変。根中心になったことをコメントへ反映 |
| `src/game/celestial/solar-system/solar-system.ts:56-58` | `new OriginCenteredEphemeris(absoluteSource, originId, epochJdTdb)` の第2引数を恒星の id へ変える。**パックが根の天体を収録していることが構築条件**になる(現行パックは `sun` を収録済み) |
| `tests/physics/absolute-ephemeris.test.ts` | 原点の意味が変わるので期待値を作り直す |
| `tests/physics/celestial-motion.test.ts:410-` | `mockPrecise` の期待値を追従 |
| `tests/physics/packed-absolute-ephemeris.test.ts` | 影響があれば追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)。
ベースライン比較が全 98 天体 × 7 時刻で完全一致。
`grep -n "originId" src/game/celestial/solar-system/solar-system.ts` が ECI 原点の用途だけを返す
(暦の構築には現れない)。

### 手順3. 位相定数と元期オフセットを軌道へ畳む

**目的.** 解析側の時刻引数を、ephemeris と同じ「絶対時刻1つ」に揃える。位相を別引数で持ち回る
形をやめる。**この時点で挙動は変えない**(畳み込みは厳密)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/kepler-orbit.ts:67-173` | `orbitAngles` / `keplerOrbitState` / `keplerOrbitRotation` / `keplerOrbitNormal` / `keplerOrbitMeanDirection` から `phaseOffset` 引数を落とす |
| `src/physics/kepler-orbit.ts:29-43` | `KeplerOrbit` へ位相と元期オフセットを畳む関数を足す(`l0 += phase + lRate*offset` ほか、各要素へ rate × offset を加える) |
| `src/physics/planet-orbit.ts:54-63` | `planetAngles` から `phaseOffset` 引数を落とす |
| `src/physics/satellite-orbit.ts:117-122` | `satelliteState` から `phaseOffset` 引数を落とす。周期項の引数も畳み込み済みの `t` で組む |
| `src/physics/celestial-motion.ts:103-115` | コンストラクタから `phase` / `epochOffsetSec` を落とし、構築側で畳んだ軌道を受け取る。`readonly phase` を参照している箇所(`:256-274`, `:337-344`, `:379-390`, `:462-466`, `:524-529`)を追従 |
| `src/game/celestial/solar-system/solar-system.ts` と系ファイル9本 | `phases` / `epochOffsetSec` を各 Motion へ渡すのをやめ、`Def` の軌道値を畳んでから渡す。`epochOffsetSec` の引き回し 133 箇所が消える |
| `src/game/stages/stage-debug-alt-system.ts:63-68` | 同じ形へ追従 |
| `tests/physics/test-helpers.ts:24-31` | `solarSystemParts` の引数を追従 |
| `tests/physics/{celestial-motion,kepler-orbit,satellite-orbit,irregular-satellites,laplace-satellites,small-bodies}.test.ts` | `phaseOffset` を渡している呼び出しを追従(この6本が該当) |

**`phaseOffsets` はセーブに残す** — `CelestialSystem.serialize()`(`celestial-system.ts:182`)と
`save-data.ts:335` はそのまま。畳むのは構築時であって、保存される値ではない。

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)。
`grep -rn "phaseOffset" src/` が 0 件、`grep -rn "epochOffsetSec" src/game/celestial/` が 0 件。
ベースライン比較が全 98 天体 × 7 時刻で完全一致。

### 手順4. `OrbitalElements` に元期を持たせ、`stateAt` を足す

**目的.** 軌道要素からも絶対時刻で状態を引けるようにする。周期は既に持っているので、足りないのは
位相の基準時刻だけ。**この時点で既存の呼び出しの挙動は変えない**(追加のみ)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/elements.ts:8-18` | `OrbitalElements` へ元期を足す(`t0: number` と `nu0: number`、または近点通過時刻 `tPeri: number \| null`)。参照軌道では null |
| `src/physics/elements.ts:36` | `orbitalElementsFromState` が `rel.t` から元期を埋める。いま捨てている値をそのまま使う |
| `src/physics/elements.ts:171-178` | `orbitalElementsFromClassical` は元期 null で組む |
| `src/physics/elements.ts`(新規) | `stateAt(el, t)`: 元期があれば `timeSincePeriapsis` / `trueAnomalyFromMean` の逆をたどって ν を出し `positionOnOrbit` / `velocityOnOrbit` を通す。元期が null なら null を返す。双曲線は既存の双曲線ケプラー方程式(`:121-137`)を使う |
| `src/physics/celestial-body.ts:139-142` | `orbitalElementsOf` は変更不要(`s.t` を既に渡している) |
| `tests/physics/elements.test.ts` | 元期を持つ要素の往復と、`stateAt` が `stateFromOrbitalElements` と一致することの表明を足す |

**達成条件と検証.** `npm run typecheck` / `npm run test:physics`。
新しい表明: 楕円・双曲線の両方で `stateAt(el, el.t0) === (元の状態)` が機械精度で成り立つ。
ベースライン比較が全 98 天体 × 7 時刻で完全一致(追加のみなので当然一致すべき)。

### 手順5.(案Y を採る場合のみ)`SatelliteOrbit` を日心にする

**目的.** `orbit` と `ephemeris` の契約を完全に一致させる。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/satellite-orbit.ts:33-38` | `SatelliteOrbit` へ `primary: PlanetOrbit` を足す |
| `src/physics/satellite-orbit.ts:117-122` | `satelliteState(orbit, t)` が `planetAngles` を自分で組み、惑星の状態を足した根中心状態を返す |
| `src/physics/celestial-motion.ts:488-500, 524-529` | `SatelliteMotion.relStateAt` / `helioStateAt` / `computeRelStateAt` を、日心を返す軌道の上に組み直す。`relStateAt` は惑星相対が要る箇所(重心補正・`packedStateAt` の補完)向けに残す |
| `src/physics/celestial-motion.ts:438-461` | `PlanetMotion.computeHelioStateAt` の重心補正が `relStateAt` に依存し続けることを確認する |
| `src/game/celestial/solar-system/satellite-orbit-builders.ts` | `primary` を渡すよう構築を追従 |
| `tests/physics/{satellite-orbit,laplace-satellites,irregular-satellites}.test.ts` | 追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)。
ベースライン比較が全 98 天体 × 7 時刻で完全一致。

## 見積り

置換・追従の量から出す(`tests/dist/` を除いた実ファイルでの出現数)。

| 手順 | 触る箇所 | 根拠 |
| --- | --- | --- |
| ~~1~~ | 実測 33 行 | 実施済み |
| 2 | 約 60 | `OriginCenteredEphemeris` 32 + `eciStateAt` 周辺 15 + テスト 3ファイル |
| 3 | 約 200 | `epochOffsetSec` 133 + `phaseOffset` 19 + `keplerOrbitState` 36 + `planetAngles` 19 の一部 |
| 4 | 約 25 | `OrbitalElements` の構築点 2 + `stateAt` 新規 + テスト |
| 5 | 約 40 | `satelliteState` 21 + `relStateAt` / `helioStateAt` の組み直し |

手順3 が量の大半だが、`epochOffsetSec` の 133 箇所は**引数の削除**であって置換ではないので、
機械的に消せる。手順2 が量は小さく、意味の変更としては最も大きい。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 本体と ECI 原点天体を**別の供給源**から引く | パック未収録の 94 天体の ECI 位置が、地球の解析モデル誤差ぶん動く。テストは緑のまま通りうる | 手順1・2。ベースライン比較を全 105 天体で取ること(収録 11 天体だけ見ると気付けない) |
| 暦パックが系の根の天体を収録していない | 手順2 のあと構築時に例外。現行パックは `sun` を収録しているので通るが、将来パックを絞ると落ちる | 手順2。構築条件をコンストラクタの表明で固定する |
| 恒星を持たない星系(`stage-debug-alt-system.ts:65` は `star = null`) | 「根中心」が恒星の位置ではなく仮想点になる。パックは null なので実害は無いが、`helioStateAt` の名前が実態(根中心)とずれる | 手順2。DEBUG(架空星系)ステージが起動することを確かめる |
| `epochOffsetSec` の畳み込みで、二次以上の項を持つ要素を一次で畳む | 位置が静かにずれる。`KeplerOrbit` は全要素が時刻の一次式なので厳密だが、`satellite-orbit.ts` の周期項は引数が線形なだけで振幅は定数 — 畳み込み後の引数が元と一致することを式で確かめること | 手順3。ベースライン比較 |
| `phase` を `l0` へ畳む際に、`planetAngles` が `l0 + phaseOffset` を使っている(`planet-orbit.ts:56`)ことを見落とす | 衛星モデルが見る太陽方向がずれ、月の位置が数百 km 動く | 手順3。月の ECI 位置をベースライン比較で確認 |
| `TimeRing` のキャッシュキーが `t`(simTime)である | 軌道側の時刻軸を ET 秒へ変えたとき、Motion 層のキャッシュキーまで ET 秒にするとヒット率は同じでも意味が変わる。キーは simTime のまま据え置くこと | 手順3 |
| `OrbitalElements` の元期を必須にしてしまう | 参照軌道(`earth-reference-orbits.ts`、`geostationary-overlay.ts`)が意味のない元期を持つ | 手順4 |
| 元期 null の要素に `stateAt` を呼ぶ経路が実行時にだけ現れる | 軌道ガイドの線が消える。型で null を返すので、呼び出し側の分岐漏れは typecheck が拾う | 手順4 |
| 案Y を採ると `PlanetMotion.computeHelioStateAt` の重心補正が `SatelliteMotion.relStateAt` に依存し続ける | 木が Orbit 層と Motion 層に二重化し、重心補正の置き場が曖昧になる | 手順5。案X を採るなら発生しない |
| 手順2 のあと `OriginCenteredEphemeris` という名前が実態(根中心)とずれる | `rename-ephemeris.md` の改名表で「据置」としている1行が変わる — `StarCenteredEphemeris` などへ | 手順2 完了時に `rename-ephemeris.md` を1行更新する |
