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

**揃っていないのは ephemeris 側だけ**だった。`OriginCenteredEphemeris` は ECI 原点天体を引いて
ECI へ落としていたので、恒星を引く形へ変えて `HelioEphemeris` へ改名し、**ECI への変換は
`CelestialMotion.eciStateAt` の1箇所へ引き上げた**(手順2 で実施済み)。

覆された場合(SSB を採る): 手順2 が成立しなくなり、暦パックの有効期間外を解析で埋める設計自体を
見直すことになる。

**根を経由すると丸めが入る。** いまパック経路は暦の中で `pack(天体) − pack(ECI原点)` を1回引いて
いる。根中心へ揃えると `[pack(天体) − pack(根)] − [pack(ECI原点) − pack(根)]` になり、代数的には
同じでも浮動小数では一致しない — 重心位置は外惑星で 1e12 m 規模、倍精度の相対精度 1e-16 なので
絶対 1e-4 m 程度の丸めが乗る。**これを避けるには供給源ごとに原点を変えたまま(パックは重心、解析は
恒星中心)差で打ち消す形にするしかなく、それでは「同じ問いに同じ形で答える1つのメソッド」に
ならない。** 丸めを受け入れて根中心へ揃える。**実測では位置の最大相対差 2.3e-16、速度 5.2e-16**
1 ulp)で、2058 状態のうち 1578(76.7%)はビット一致のまま。絶対差の最大は木星の衛星アナンケの
位置で 1.4e-4 m。

### 判断2. 供給源の混在規則を、暗黙から明示へ移す

**暦パックに入っているのは 11 天体だけ**(sun, mercury, venus, earth, moon, mars, jupiter, saturn,
uranus, neptune, pluto)で、登録されている天体は **98 体**ある。有効期間内でも大半は解析経路を通る。
実測では、パックの有無で t=0 の ECI 位置が変わるのは 98 体中 **54 体** — 収録 11 体より多いのは、
収録惑星の衛星が「パックの惑星 + 解析の惑星相対」で組まれるため。

いまは「自分がパックで引けるならパック経路(このとき原点天体もパックから引かれる)、引けないなら
両端とも解析」という規則が、手順2 の前は暦クラスの内側に隠れていた
(`stateOf` が本体と ECI 原点天体の両方をパックから引いていたため)。ECI 変換を引き上げると
**両端の供給源がばらける余地ができる** — パックにある地球から、解析にしかない小惑星を引く形になり、
その天体の ECI 位置が地球の解析モデル誤差ぶん動く。

**`eciStateAt` に「両端を同じ供給源から取る」規則を明示して残す。** これを守れば数値は変わらない。

覆された場合(混在を許す): 手順1・2 が「挙動不変」でなくなり、達成目標5 の数値一致は
「パック収録天体のみ一致」へ緩める。

### 判断3. 絶対時刻の軸は J2000 ET 秒。位相定数は軌道へ畳む

解析側が実際に使っている時刻は `t + epochOffsetSec` で、`epochOffsetSec` は
`SIM_EPOCH_ET`(`sim-epoch.ts:11`)という**全天体共通の定数**。位相 `phase` は
`phases[id] ?? 0` という**天体ごとの定数**。どちらも構築時に確定するので、**軌道の値へ畳める。**

- **`phase` の畳み込みは厳密。** いまの式は `orbit.l0 + phaseOffset + orbit.lRate * t` を左から評価する
  ので、`l0 + phase` を構築時に1回で計算しても演算列が変わらない — ビット一致する。
- **`epochOffsetSec` の畳み込みは厳密ではない。** `lRate * (t + off)` を
  `(l0 + lRate*off) + lRate*t` へ組み替えると結合則が変わる。off = SIM_EPOCH_ET = 5.7167e11 s、
  地球の lRate では折り返し前の平均黄経が **1.14e5 rad** まで積み上がっており、そこでの ulp は
  1.5e-11 rad = 地球軌道上で 2 m。**実測で最大 2.2 m ずれる**(畳み込みのみ)。2π で正規化して
  畳むと以降の中間値が 100 rad 規模へ落ちるので **精度は約 1000 倍良くなる**が、それでも今の値
  からは最大 1.2 m 動く。
- 時刻軸を ET 秒側へ揃えて暦に `J2000 + et/86400` を計算させる案も、同じ理由で
  `epochJdTdb + simTime/86400` とはビット一致しない(月で 0.1 m 規模)。
- **したがって、時刻軸を1つに揃える限り「挙動を変えない」は達成できない。**
  **2026-08-30、両方畳む(2π 正規化あり)を選択。** 実測: 天体位置は最大 4.5 m 動いたが、
  平均黄経の丸め雑音(等間隔 t での2階差分。真値は厳密に 0)は **2.18 m → 1.06 mm** へ
  2048 倍改善した。動いた 4.5 m はその雑音を取り除いたぶんの位相の付け替えである。

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

**案X を採る**(2026-08-30 決定)。実施後の構造を見てから案Y を再検討する。

### やらないこと

**`orbit-guide` / `orbit-catalog` は対象外。** これらが返すのは「時刻 t に置いた閉曲線」
(`GuideLoop`)であって、時刻 → 状態の写像ではない。`CatalogFamily.points` の各点が持つ `tFrac` は
周期を1とする相対位相で、絶対時刻の位相は最初から定義されていない。引数の `t` は曲線を実位置・
実姿勢へ載せるためだけに使われている。揃える対象ではない。

## 達成目標

1. 原点天体を引く処理が `CelestialMotion.eciStateAt` の1箇所だけになる —
   `grep -rn "origin" src/physics/absolute-ephemeris.ts` が 0 件。
2. `HelioEphemeris` が ECI 原点天体の id を知らない(コンストラクタが受け取らない)。
3. `keplerOrbitState` / `satelliteState` / `planetAngles` / `keplerOrbitRotation` /
   `keplerOrbitNormal` / `keplerOrbitMeanDirection` が位相の引数を取らない — `src/physics/` に
   `phaseOffset` が 0 件(`render/aurora.ts` の同名は無関係)。
4. `epochOffsetSec` が `CelestialMotion` へ渡らない。`game/celestial/` に残るのは
   `planetDefAtEpoch` / `satelliteDefAtEpoch` へ渡す配管だけ。
5. `OrbitalElements` が元期を持ち、`stateOnOrbitAt(el, t)` がある。参照軌道では null を返す。
6. **数値の動きが説明できる** — 下記のベースライン比較で、
   手順1・4 はビット一致、手順2 は 1 ulp(位置 2.3e-16 / 速度 5.2e-16)、手順3 は位相の
   付け替えぶんで最大 4.5 m(didymos、|r| = 2.6e11 m すなわち相対 1.7e-11)。
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

**全手順を実施済み**(2026-08-30)。手順5 は案X 採用により実施しない。

## 見積り

置換・追従の量から出す(`tests/dist/` を除いた実ファイルでの出現数)。

| 手順 | 触る箇所 | 根拠 |
| --- | --- | --- |
| ~~1~~ | 実測 33 行 | 実施済み |
| ~~2~~ | 実測 15 ファイル / +126 −77 行 | 実施済み。位置・速度の最大相対差 5.2e-16(1 ulp) |
| ~~3~~ | 実測 21 ファイル / 構築 99 箇所 | 実施済み。位置が最大 4.5 m 動く(下記) |
| ~~4~~ | 実測 4 ファイル / +52 −23 行 | 実施済み。ベースラインはビット一致 |
| ~~5~~ | — | 案X 採用により実施しない |

手順3 が量の大半だが、`epochOffsetSec` の 133 箇所は**引数の削除**であって置換ではないので、
機械的に消せる。手順2 が量は小さく、意味の変更としては最も大きい。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 本体と ECI 原点天体を**別の供給源**から引く | パック未収録の 87 天体の ECI 位置が、地球の解析モデル誤差ぶん動く。テストは緑のまま通りうる | 手順1・2。ベースライン比較を全 98 天体で取ること(収録 11 天体だけ見ると気付けない) |
| 根を経由する二重の減算で ECI 原点天体の状態が毎回引き直される | パック未収録も含む全天体ぶん、ECI 原点天体の Chebyshev 評価が余分に走る。いまは暦の中で時刻ごとに1回へ畳まれている | 手順2。`EciOrigin` 側に時刻キャッシュを置いて畳み直すこと |
| 暦パックが系の根の天体を収録していない | 手順2 のあと構築時に例外。現行パックは `sun` を収録しているので通るが、将来パックを絞ると落ちる | 手順2。構築条件をコンストラクタの表明で固定する |
| 恒星を持たない星系(`stage-debug-alt-system.ts:65` は `star = null`) | 「根中心」が恒星の位置ではなく仮想点になる。パックは null なので実害は無いが、`helioStateAt` の名前が実態(根中心)とずれる | 手順2。DEBUG(架空星系)ステージが起動することを確かめる |
| `epochOffsetSec` の畳み込みで、二次以上の項を持つ要素を一次で畳む | 位置が静かにずれる。`KeplerOrbit` は全要素が時刻の一次式なので厳密だが、`satellite-orbit.ts` の周期項は引数が線形なだけで振幅は定数 — 畳み込み後の引数が元と一致することを式で確かめること | 手順3。ベースライン比較 |
| `phase` を `l0` へ畳む際に、`planetAngles` が `l0 + phaseOffset` を使っている(`planet-orbit.ts:56`)ことを見落とす | 衛星モデルが見る太陽方向がずれ、月の位置が数百 km 動く | 手順3。月の ECI 位置をベースライン比較で確認 |
| `TimeRing` のキャッシュキーが `t`(simTime)である | 軌道側の時刻軸を ET 秒へ変えたとき、Motion 層のキャッシュキーまで ET 秒にするとヒット率は同じでも意味が変わる。キーは simTime のまま据え置くこと | 手順3 |
| ~~`OrbitalElements` の元期を必須にしてしまう~~ | 手順4 で `epoch: OrbitEpoch | null` にし、参照軌道は null にした | 済 |
| ~~元期 null の要素に `stateOnOrbitAt` を呼ぶ経路~~ | 戻り値が `| null` なので分岐漏れは typecheck が拾う | 済 |
| 案Y を採ると `PlanetMotion.computeHelioStateAt` の重心補正が `SatelliteMotion.relStateAt` に依存し続ける | 木が Orbit 層と Motion 層に二重化し、重心補正の置き場が曖昧になる | 案X を採ったので発生しない |
| `HelioEphemeris` の `helio` は、恒星を持たない星系では字義どおりでない | 架空星系では根が仮想点になる。`CelestialMotion.helioStateAt` が同じ語を同じ意味で使っているので、この frame の呼び名を変えるなら2つ一緒に動かす | 手順2 で `OriginCenteredEphemeris` から改名済み。呼び名を変えるなら rename-ephemeris.md 側で |
