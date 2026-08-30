# 軌道・暦まわりの構造リファクタリング

第1部(判断材料)のスナップショットは **`c849c988`**。第1部は「いまどうなっているか」の使い捨て
記録で、**維持しない** — 計画を実施し終えたら第1部ごと消す。

---

# 第1部 判断材料

**問題意識は2つ。**

- **層が多い。** `KeplerOrbit` から `CelestialBody` まで、値が5回持ち替えられる。
- **誰がどの座標を扱うのかが揃っていない。** 原点が5種・時刻軸が3種・軸が2種あるのに、
  名前に出ているのは一部だけ。

## 1. 登場人物

```
[値・宣言]                      [評価]                        [窓口]
KeplerOrbit ──────────┐
PlanetOrbit(=別名)     ├─→ keplerOrbitState/Rotation/Normal/MeanDirection
SatelliteOrbit ───────┘   satelliteState(orbit, planetAngles, t)
      │
PlanetDef / SatelliteDef / StarDef
      │
      └──────────────────→ CelestialMotion ─────────────────→ CelestialBody(瞬間値)
                             StarMotion                          │
                             OrbitingMotion                      ├→ CelestialBodyWindows
                               PlanetMotion                      ├→ ReferenceFrames/frame.ts
                               SatelliteMotion                   └→ CelestialEntity(表示)
                                   ▲
ChebyshevEphemeris(評価器)          │
  ← ChebyshevPack ← DecodedPack ← .epk
      │
AbsoluteEphemeris(interface)
  └ PackedAbsoluteEphemeris ──→ HelioEphemeris ──┘
                                  ▲
EphemerisProfile ─→ ephemeris-catalog(fetch + 検証)
```

## 2. 座標の一覧 — ここが揃っていない

| 何 | **原点** | **軸** | **時刻軸** | 名前に原点が出ているか |
| --- | --- | --- | --- | --- |
| `ChebyshevEphemeris.stateAtSeconds` | 太陽系重心 | ICRF | J2000 ET 秒 | ✗ |
| `AbsoluteEphemeris.barycentricStateOf` | 太陽系重心 | ICRF | JD_TDB | ✓ |
| `HelioEphemeris.stateOf` | **恒星** | **ゲーム ECI** | **simTime** | ✗(型名にはある) |
| `keplerOrbitState(orbit, t)` | 中心天体(**誰かは知らない**) | ゲーム ECI | simTime | ✗ |
| `PlanetOrbit` 経由の値 | 恒星 | ECI | simTime | — (※答えるのは**系重心**) |
| `SatelliteOrbit` 経由の値 | 惑星 | ECI | simTime | — |
| `CelestialMotion.helioStateAt` | 恒星 | ECI | simTime | ✓ |
| `SatelliteMotion.relStateAt` | 惑星 | ECI | simTime | △(`rel` が何相対か出ない) |
| `CelestialMotion.at` / `stateAt` | **ECI 原点天体** | ECI | simTime | ✗ |
| `CelestialBody.state` | ECI 原点天体 | ECI | simTime | ✗ |
| `FrameAnchorSource.stateOf` | ECI 原点天体 | ECI | simTime | ✗ |
| `OrbitalElements` + `positionOnOrbit` | `el.center` | ECI | simTime(`epoch`) | ✗ |
| `FrameKinematicState`(`frame.ts`) | 任意の座標系 | その座標系 | simTime | ✓(branded type) |

**原点5種・軸2種・時刻軸3種。** 型で守られているのは最下段の `frame.ts` だけで、上の12段は
すべて素の `KinematicState` / `Vec3` を返す。**取り違えても型が通る。**

## 3. 各モジュールの責務

### 3.1 `physics/kepler-orbit.ts` — 軌道の数学

`KeplerOrbit` = 基準面の回転 `basisToEci` + 6要素 + **6つの永年変化率**。純粋二体は
「変化率が 0」という特殊ケースであって、別の型ではない。

供給する関数は4つ: `keplerOrbitState` / `keplerOrbitRotation` / `keplerOrbitNormal` /
`keplerOrbitMeanDirection`、および元期を畳む `keplerOrbitAtEpoch`。

**中心天体が誰かを知らない。** 恒星/惑星/衛星の別も知らない。**この層は正しく切れている。**

### 3.2 `physics/planet-orbit.ts` — 単位変換 + 親の位相

`PlanetOrbit = KeplerOrbit`(**完全な型別名**)。足しているのは:

- `planetOrbit(p)` — 度/世紀・au/世紀 → rad/秒 のコンストラクタ
- `planetAngles(orbit, t)` — 平均黄経・平均近点角とその変化率。**衛星が太陽方向を得るための口**

**「惑星の軌道」という型は実在しない。** 型が約束しているのは「中心が恒星」「答えるのは
**惑星-衛星系の重心**」の2つだが、どちらもコメントだけで、型は何も強制していない。

### 3.3 `physics/satellite-orbit.ts` — 二体 + 摂動、ただし自己完結しない

`SatelliteOrbit = { kepler: KeplerOrbit, lonTerms, latTerms, distTerms }`。**合成であって別名では
ない。**

```ts
satelliteState(orbit, planetAngles, t)   // ← 第2引数が要る
```

**`(orbit, t)` だけでは評価できない。** 周期項の引数に太陽方向が要り、それは
`sunL = planetAngles.meanLongitude + π` として親の軌道位相から導かれる。

回転基準系と法線は `.kepler`(平均要素)だけから組み、**周期項を含まない** — 混ぜると角速度が
滑らかでなくなるため。結果、衛星の実位置は回転系の x̂ 軸から**最大 2.5°ずれる。**

### 3.4 `physics/celestial-body-def.ts` + `celestial-motion.ts` の Def 群 — 宣言

```ts
type SatelliteDef = Omit<PlanetDef, 'orbit'> & { readonly orbit: SatelliteOrbit };
```

**宣言のレベルでは、惑星と衛星は「orbit の型が違うだけの同じもの」。** `mu`/`radius`/`pole`/
`degree2`/`shape`/`atmosphere`/`rings`/`lagrangeLabels` はすべて共通。

`planetDefAtEpoch` / `satelliteDefAtEpoch` が位相と元期オフセットを `orbit` と `pole` へ畳む。
**これを通した宣言だけが `CelestialMotion` へ渡ってよい。**

### 3.5 `physics/celestial-motion.ts` — 実質ここに全部ある(576 行)

| クラス | 持つもの |
| --- | --- |
| `EciOrigin` | ECI 中心天体への遅延参照 + パック状態の時刻キャッシュ |
| `CelestialMotion`(abstract) | 供給源の切り替え・**ECI 化**・`bodyCache`・自転基準系 |
| `StarMotion` | 抽象5メソッドを自明値(0/静止/null×3)で埋めるだけ |
| `OrbitingMotion`(abstract) | `keplerOrbit` 抽象の導入 + 自転3分岐 + 軌道由来の量 + ラグランジュ点 |
| `PlanetMotion` | 恒星参照・`moons`・`helioCache`・**重心補正** |
| `SatelliteMotion` | 惑星参照・`relCache`・**親からの位相取得**・`packedStateAt` の override |

**抽象メソッドは「恒星中心で答えること」だけを要求する** — ECI 化と切り替えは基底が持つ。
`OrbitingMotion` が `keplerOrbit` という抽象ゲッターを1つ足して、`PlanetOrbit` と
`SatelliteOrbit` の型差を1点に吸収している(`def.orbit` / `def.orbit.kepler`)。

**`override` キーワードが付くのはファイル全体で1箇所**(`SatelliteMotion.packedStateAt`)。
残りは全部「抽象の穴を埋める」型の継承。

### 3.6 暦側 — 3層

| 層 | 責務 |
| --- | --- |
| `ephemeris-pack/format.ts` | `.epk` のワイヤ形式。ヘッダ + 正規化 JSON manifest + Float64 連続列。妥当性検査 |
| `ephemeris-pack/evaluator.ts` `ChebyshevEphemeris` | 区間の二分探索 + Chebyshev 評価(位置と、その微分としての速度) |
| `packed-absolute-ephemeris.ts` | ET 秒 ⇄ JD_TDB の変換 + SHA-256 検証。`AbsoluteEphemeris` の実装 |
| `absolute-ephemeris.ts` `HelioEphemeris` | **恒星の重心位置を引く** + `icrfToGameEci` で軸を付け替える |
| `ephemeris-profile.ts` | どの年代をどの根拠データで扱うかの宣言。有効期間・`packId` |
| `ephemeris-catalog.ts` | fetch + 進捗 + `packId` 照合 + 期間照合 |

### 3.7 上位 — 消費側

| 層 | 責務 |
| --- | --- |
| `celestial-body.ts` | `CelestialBody`(瞬間値)+ 2次で外挿する `celestialBodyStateAt` + 重力の計算 |
| `celestial-body-windows.ts` | 同一時刻の全天体配列を3種(全部/重力源/大気持ち)メモ化 |
| `reference-frames.ts` + `frame.ts` | 表示座標系の集合と剛体運動。**branded type で座標系相対を型で守る唯一の層** |
| `game/celestial/celestial-entity/` | 表示。`motion` から位置・姿勢を引いてメッシュへ同期 |
| `game/celestial/solar-system/` | 天体宣言の束(11 ファイル)。`*DefAtEpoch` を通して `*Motion` を `new` する |

## 4. 依存の要点

### 4.1 `Motion` と `Orbit` は2〜3段離れている

```
PlanetMotion ─def→ PlanetDef ─orbit→ PlanetOrbit(= KeplerOrbit)          … 2段
SatelliteMotion ─def→ SatelliteDef ─orbit→ SatelliteOrbit ─kepler→ KeplerOrbit  … 3段
```

`Planet*` / `Satellite*` の接頭辞が3層に等しく付いていて縦に並んで見えるが、**実際に兄弟なのは
`Def` 層だけ。** `Orbit` 層は型の形が違い(別名 vs 合成)、`Motion` 層は責務の量が違う。

### 4.2 2つの `Motion` は互いを読むが循環しない

```
SatelliteMotion.computeRelStateAt  →  planetAngles(this.planet.def.orbit, t)   ← 親の「軌道」
PlanetMotion.computeHelioStateAt   →  moon.relStateAt(t)                        ← 子の「状態」
```

**衛星が読むのは親の状態ではなく親の軌道(要素と t だけの純関数)なので、再帰が止まる。**
これは `PlanetOrbit` が「系重心の軌道」であることに依存している — 本体の軌道に変えると
`moon.relStateAt` が `planet.helioStateAt` を要求し、相互再帰になる。

### 4.3 供給源の切り替えは3箇所にあり、**ゲートが違う**

| 場所 | ゲート | 落ち先 |
| --- | --- | --- |
| `eciStateAt`(:218) | 自分 **と ECI 原点天体**の両方をパックが答えられるか | `analyticEciStateAt` |
| `orbitFrameRotationAt`(:304)/ `orbitNormalAt`(:319) | 自分 **と主天体**(原点天体は無関係) | `keplerOrbitRotation/Normal` |
| `SatelliteMotion.packedStateAt`(:561) | 自分が収録されているか | **切り替えでなく混合**(パックの親 + 解析の相対) |

**切り替えのための抽象(Strategy 的な型)は存在せず、`??` と `if (x !== null)` の直書き。**

### 4.4 外から使われている面は、宣言されている面よりずっと薄い

`celestial-motion.ts` の外から呼ばれているもの:

```
stateAt(22) / at / def / kind / id / primary / orientationAt(7) / spinRate / spinRotationAt
orbitNormalAt(2) / orbitFrameRotationAt(1) / lagrangeAt(2) / lagrangeStateAt(1)
hasUsableCollinearPoints(1) / hasStableTriangularPoints(1) / cacheStats(1) / spinPhase0(1)
```

**外部からの呼び出しが 0 のもの**(= ファイル内部の実装詳細が public になっている):

```
keplerOrbit / helioStateAt / helioAccelAt / relStateAt / packedHelioStateAt / satellites
```

`keplerOrbit` は `OrbitingMotion` の**抽象ゲッターなのに、外部消費者がいない。** 型差を吸収する
ためだけの内部インターフェイスが public API に露出している。

### 4.5 時刻キャッシュが8箇所に散っている

`CelestialMotion.bodyCache` / `PlanetMotion.helioCache` / `SatelliteMotion.relCache` /
`EciOrigin.packedCache` / `CelestialBodyWindows` の3本 / `HelioEphemeris.lastStarState`(1件) /
`FrameAnchors.attractorCache`(1件) / `ReferenceFrames.frameCache`(参照同一性)。

前4つは `TimeRing`(32段の線形走査、キー生成もハッシュも無い)、`HelioEphemeris` と
`FrameAnchors` は手書きの1件メモ。**「同一 t には同一参照」という不変条件が層をまたいで
暗黙に効いている。**

## 5. 見えている歪み

### 5.1 「重心 ⇄ 本体」の変換が2箇所にある

| どこ | 何を | 誰が持つ知識 |
| --- | --- | --- |
| `PlanetMotion.computeHelioStateAt` | 系重心 → 惑星本体 | `moons` の一覧と質量比 |
| `SatelliteMotion.helioStateAt` | 惑星本体 + 相対 → 衛星の日心 | 親への参照 |

`PlanetOrbit` が答えるのは重心、`PlanetMotion` が答えるのは本体。**この段差が型に出ていない** —
どちらも `KinematicState` を返す。

### 5.2 座標変換が2ファイルに分かれている

- **軸**(ICRF → ゲーム ECI): `absolute-ephemeris.ts` の `icrfToGameEci`
- **原点**(恒星 → ECI 原点天体): `celestial-motion.ts` の `eciStateAt`

**`Eci` を名前に持つのは前者なのに、実際に ECI にしているのは後者。**

### 5.3 `CelestialMotion` が2つの仕事を兼ねている

| 仕事 | 中身 |
| --- | --- |
| **並進の合成** | 供給源の切り替え・重心補正・恒星中心の積み上げ・ECI 化・加速度 |
| **天体の属性の時刻解決** | 自転姿勢・2次重力場・大気・ラグランジュ点・回転基準系 |

後者は Orbit とも Ephemeris とも関係が薄い(姿勢に依存するので同居しているだけ)。

### 5.4 `SatelliteOrbit` だけ自己完結しない

`(orbit, t)` で閉じないのは `SatelliteOrbit` だけ。**呼び出し規約が兄弟と違う**ので、
「軌道」を一様に扱う口から見ると特別扱いが要る。

### 5.5 加速度と自転にはパック経路が無い

`CelestialBody.accel` は**常に解析**。同期回転衛星の自転位相も**常に `keplerOrbit` 経由**。
**`CelestialBody` という1つの値の中で供給源が混ざっている。**

### 5.6 `OrbitalElements` と `KeplerOrbit` が別系統のまま並んでいる

| | `KeplerOrbit` | `OrbitalElements` |
| --- | --- | --- |
| 中心 | 知らない(`basisToEci` だけ) | `center: CelestialBody` を**持つ** |
| 位相 | `l0` + `lRate`(必ず持つ) | `epoch: OrbitEpoch \| null`(**持たないこともある**) |
| 永年変化 | 6要素すべてに `*Rate` | **無い** |
| 双曲線 | 表せない | 表せる(`a < 0`) |
| 出どころ | 宣言(手で書いた要素) | 状態ベクトルからの逆算 |

---

# 第2部 計画

## 目的

第1部の歪みのうち、**名前ではなく構造に由来するもの**を直す。直す対象は4つ。

- 位置・速度を返す 13 の口が原点を型で区別しておらず、**取り違えが型検査を通る**(2節)。
- `PlanetOrbit` が答える「系重心」と `PlanetMotion` が答える「惑星本体」の段差が、型にも名前にも
  出ていない(5.1)。地球なら 4,673 km の差で、絵では気付けない。
- 惑星⇄衛星が互いを読む参照になっていて、**循環しないことがコメントでしか保証されていない**
  (4.2)。`PlanetOrbit` が系重心の軌道であることに暗黙に依存している。
- ECI 原点という**系レベルの選択**を、天体1体ごとの `CelestialMotion` が知っている
  (`EciOrigin` を 104 の構築点へ配っている)。原点を要求しているのは LEO の座標精度が要る
  dynamic 側であって、天体側の都合ではない。

**挙動は一切変えない。** 全手順を通して、天体の ECI 位置・速度がビット単位で変わらないことを
検証する。

## 決めたこと

### やること(この順)

| 手順 | 何を |
| --- | --- |

### 前提: 挙動不変の物差し

`tests/physics/celestial-eci-baseline.test.ts` が、`c849c988` 時点の ECI 位置・速度を固定値で
押さえている(12 ケース)。解析暦のみの構成で 7 天体、暦パック構成で 4 天体を 4 時刻ずつ、
位置・速度とも `deepEqual` で比較する。暦パック構成は**月と木星をわざと収録外にしてあり**、
「収録済みの親 + 解析の相対」「両端とも解析」の経路も通る。重心補正(約 4,360 km)も 2 時刻で
押さえてある。**以降の手順はすべて、このテストを1文字も書き換えずに通すこと。**

### 前提: 原点タグ

`KinematicState<F extends FrameTag = 'eci'>` が原点を型引数で持つ(`kinematic-state.ts`)。
`FrameTag` は `'eci' | 'helio' | 'primaryRel' | 'barycentric'` で、**既定が `'eci'` なので ECI を
扱う側は型引数を書かない。** 原点をまたぐ変換は3つの関数だけを通す:

- `toEci(t, body, origin)` — 天体と ECI 原点天体は**同じ原点・同じ供給源**でなければならない
- `toPrimaryRelative(t, body, primary)` — 主天体を原点に置き直す
- `addPrimaryRelative(primary, rel)` — 主天体相対を恒星中心へ足し戻す

`kinematicState(...)` に型引数を書き忘れると暗黙に ECI を名乗るので、**非 ECI を組むときは
必ず `kinematicState<'helio'>(...)` のように明示する。** 原点の読み替え(主天体相対 → 恒星中心)
が起きるのは `PlanetMotion.baryHelioStateAt` の1箇所だけ。

### 前提: ECI 化の場所

`CelestialBodyWindows`(`physics/celestial-body-windows.ts`)が **ECI 化を行う唯一の場所**。
構築時に ECI 原点天体を受け取り、時刻ごとに原点の恒星中心状態を暦経路・解析経路の両方で1回だけ
引いて、各天体は**自分と同じ経路の原点**を引いて差し引く。天体ごとの `CelestialBody` の
メモもここが持つ。口は `celestialBodiesAt` / `gravityAttractorsAt` /
`atmosphereCelestialBodiesAt` / `bodyAt(id, t)` / `stateAt(id, pivot, t)`。

`CelestialMotion` は恒星中心までしか答えない(`helioStateAt` / `packedHelioStateAt` /
`helioAccelAt`)。`CelestialEntity` は `CelestialSystem` が構築直後に差し込む窓を通じて
`stateAt(t)` / `bodyAt(t)` を答えるので、**どの天体が原点かを知らない。**

CR3BP の量は `SecondaryFrame`(`physics/lagrange.ts`)を受け取る自由関数で、
`physics/halo.ts` と `physics/orbit-guide.ts` は motion も窓も知らない。

### 前提: 惑星-衛星系のノード

`PlanetSystem`(`physics/planet-system.ts`)が系の重心の軌道と、その系の惑星本体・衛星を持つ。
組む口は `planetSystem(def, star, ephemeris, origin, spinPhase0?)` ただ1つで、系と本体を結んだ
状態で返る。衛星を持たない惑星も同じ形で作り、本体は `.body` で取り出す。

評価の依存は一方向: `system.helioStateAt`(軌道だけ)→ `satellite.relStateAt`
(`system.anglesAt` から太陽方向)→ `planet.helioStateAt`(重心 − 衛星ぶん)→
`satellite.helioStateAt`。**衛星が惑星本体の位置を読む経路は無い。**

### 順序の根拠


### やらないこと

| 何 | 反対理由 |
| --- | --- |
| **供給源(暦/解析)を1つの型へ括る** | 手順5 で切り替えが `CelestialBodyWindows` の1箇所へ集まるので、抽象を足す動機の大半が消える。残る2箇所(`orbitFrameRotationAt` / `orbitNormalAt`)は**ゲートが違う**(主天体 vs ECI 原点天体)ので、同じ型へ押し込むと条件が引数へ溢れる。**手順5 の後にもう一度見る。** |
| **`CelestialMotion` を並進と属性で割る** | カッシーニ自転が `keplerOrbit` を要るので、割っても属性→軌道の片方向依存が残る。かつ `CelestialBody` を組み立てる場所が1つ増える。手順4・5 で `CelestialMotion` から並進の合成が痩せるので、**割る動機自体が弱まる。** |
| **キャッシュの完全な一元化** | 狙っている2つの問題(ECI 原点の同時刻引き / 惑星系重心の解決順)は、手順5・4 で**構造的に消える** — 前者は windows が1回引くようになり、後者は登録先が1つになる。残るのは性能だが、`TimeRing` は32段の数値比較だけでキー生成もハッシュも無い。一元化すると (天体, 量, t) の複合キーが要り、**RK4 の各段 × 天体数**というホットパスに Map 参照が入る。手順6 は「残ったものを数えて、要らなくなったものを消す」に縮小する。 |
| **衛星の恒星中心化をさらに下層へ** | 惑星相対 → 恒星中心の変換を `satelliteState` の中まで下げると、`SatelliteOrbit` が親を知る必要が出る。いま `SatelliteOrbit` が親を知らないことは、軌道線や軌道ガイドが軌道を一様に扱える理由でもある。**`SatelliteMotion.helioStateAt` を最下層とする。** |
| **`orbitalElementsFromState` の引数を主天体相対タグで締める** | game 側が ECI の差分を手で組んで渡しているので、ここを締めるとタグ付けの範囲が `game/` 全域へ広がる。手順2 では `KinematicState<FrameTag>`(どのタグでも通る)にとどめ、**積み残しとする。** |

覆された場合: 「手順4 を先」が覆ると
手順4・5 が入れ替わり、104 の構築点への最後の編集が「削除」ではなく「差し替え」になる。
「キャッシュを一元化しない」が覆ると手順6 が別計画に化ける(規模が手順5 に匹敵する)。

## 達成目標

全手順の実施後、以下がすべて満たされること。

1. `grep -rn "EciOrigin" src/ tests/` が 0 件。
2. `grep -rn "PlanetOrbit" src/ tests/` が 0 件。
3. `grep -rniE "\beci\b" src/physics/celestial-motion.ts` が 0 件(ECI を知るのは windows だけ)。
4. `grep -rn "this.planet.def.orbit\|baryHelioStateAt" src/` が 0 件。`addSatellite` は
   `PlanetSystem` の定義と `SatelliteMotion` の登録の2件だけで、**惑星本体を書き換える登録が
   無い**(当初は `addSatellite` ごと 0 件と書いたが、登録先を系へ移す設計にしたので改めた)。
5. `KinematicState<'helio'>` を `KinematicState`(= `<'eci'>`)へ代入するコードが**型エラーに
   なる** — 検査用に1行書いて `npm run typecheck` が落ちることを確かめ、消す。
6. `new PlanetMotion`(50)/ `new SatelliteMotion`(52)/ `new StarMotion`(2)の引数から
   `origin` が消えている。
7. `tests/physics/celestial-eci-baseline.test.ts` が焼き込んだ **期待値が1つも変わらない**
   (`git diff` に数値の行が出ない)。ECI を引く口が移った手順では呼び出し行だけが変わる。
8. `npm run typecheck` と `npm run test`(全層)が通る。
9. `npm run smoke:browser` が通り、マップビューで地球周回の楕円・月の公転楕円・ラグランジュ点
   ラベル・静止軌道リングが従来どおり出る。

## 手順

## 実施の記録

**全手順を実施済み。** `c849c988` → `HEAD` で 67 ファイル・+1828/−809 行。

| 手順 | commit | 実測 |
| --- | --- | --- |
| 固定値テストを置く | `f3d771c9` | 新規1ファイル 200 行(12 ケース) |
| `KinematicState` に原点タグ | `55462c00` | 11 ファイル・+116/−81 |
| `PlanetOrbit` を消す | `c9201d28` | 5 ファイル・13 箇所 |
| 惑星系重心をノードに | `493d48df` | 新規 `planet-system.ts` + 構築点 103 |
| CR3BP の量を自由関数へ | `96fc4c45` | 13 ファイル・+189/−136 |
| ECI 化を窓へ引き上げ | `a22fe016` | 47 ファイル |
| キャッシュの棚卸し | `78b8ff1e` | 3 ファイル・コメントのみ |

`src/physics/celestial-motion.ts` は 576 → 455 行(CODING-RULE のモジュール 500 行基準内)。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 天体と ECI 原点天体を**別の供給源**から引く | 暦パックと解析暦は同じ天体に別の位置を答えるので、差がそのまま相対位置の誤りになる。地球周回の軌道が静かにずれる | **確認済み**: 固定値テストの暦パック構成(地球・月・火星・木星の4経路)が期待値どおり通る |
| 原点天体自身の ECI が厳密に 0 にならない | 地球が原点に静止しなくなり、ECI の定義が崩れる | **確認済み**: 「地球は ECI 原点に厳密に静止する」が通り、固定値も全 0 |
| 惑星本体と系重心を取り違える | 地球なら 4,673 km ずれる。**絵では気付けない** | **確認済み**: 固定値テストの重心補正(約 4,360 km)と重心不変条件のテストが通る |
| `keplerOrbitState` の戻り値タグを `'helio'` にしてしまう | 惑星では中心が恒星なので**たまたま正しく、衛星では間違う。型検査は通る** | **確認済み**: `keplerOrbitState` は `'primaryRel'` を返し、恒星中心への読み替えは `PlanetSystem.helioStateAt` の1箇所だけ |
| タグの既定を `'eci'` にしたことで、タグを**書き忘れた**関数が暗黙に ECI を名乗る | 取り違えが検出されないまま残り、以降の手順が無防備になる | **確認済み**: 2節の表の 13 段すべてにタグが付いた(`barycentricStateOf` は `BarycentricState` 型、`FrameKinematicState` は別の branded type で元から区別されている) |
| `hermiteInterpolate` を総称化するとき両端のタグを縛り忘れる | 原点の違う2状態を補間して無意味な値になる | **確認済み**: `hermiteInterpolate<F>(a: KS<F>, b: KS<F>): KS<F>` で両端を縛った |
| `PlanetSystem.satellites` が揃う前に惑星本体を評価する | 重心補正が抜けた位置がキャッシュへ入り、以後その時刻だけ間違い続ける | 手順4。`solarSystem()` が全 entity を返すまで評価が起きないことを確かめる |
| `system.anglesAt` を平均要素ではなく周期項込みで組む | 回転基準系の角速度が滑らかでなくなり、回転系のカメラが震える | **確認済み**: `anglesAt` は `orbit` だけから組んでいる |
| `*AtEpoch` を通す位置がずれる | `keplerOrbitAtEpoch` は角を畳んでいる。畳む前の値を `PlanetSystem` へ渡すと、18,000 年規模のオフセットで丸めが支配し、地球軌道上でメートル規模の誤差になる | **確認済み**: `planetSystem()` が受け取る def は `planetDefAtEpoch` を通したもので、`PlanetSystem` はその `def.orbit` をそのまま持つ |
| `motion.stateAt(pivot, t)` の2引数を1引数へ潰す | 外挿の基準時刻が変わり、積分1歩ぶんの誤差が静かに入る | 手順5。`windows.stateAt(id, pivot, t)` でも2引数を保つ |
| `CelestialEntity.sync` へ ECI を渡す形にしたとき、天体ごとに違う時刻で同期していた箇所が1時刻へ揃う(あるいは逆) | 表示だけがずれる | **解消**: sync へ値を渡す形をやめ、個体へ窓を差し込む形にしたので、各所が従来と同じ時刻で引く |
| 104 の構築点を2度触るので、片方だけ直した状態で commit する | 型が通らない中途半端な commit が残る | 手順4・5。各手順の中で全ファイルを揃えてから typecheck を通す |
| `celestialBodiesAt` が返す配列の**要素の同一性**が崩れる | 「同一 t には同一参照」に依存している呼び出し側(`trajectory-line.ts` の再描画判定など)が毎フレーム焼き直しになり、静かに重くなる | **確認済み**: 「同一 t の celestialBodiesAt は同一配列参照を返す」「gravityAttractorsAt の要素は同一 t の celestialBodiesAt と厳密に一致する」が通る |
| `.epk` のワイヤ形式・`EPHEMERIS_PACK_VERSION` に触る | 既存セーブが全部 incompatible になる | **確認済み**: `ephemeris-pack/` の差分は型引数の4行だけで、ワイヤ形式・定数に触れていない |

## この計画と改名計画の関係

改名の計画(`memos/hedalu244/rename-ephemeris.md`)は**いまの層の切り方を前提に名前だけを直す**
もので、この計画は前提そのものを動かす。**先に実施するのはこちら。**

この計画の実施後、改名計画は次の影響を受ける。

- **`precise` / `pack` の統一(改名計画 手順4)** — `packedHelioStateAt` などの名前が手順5 で
  windows へ移るか消えるので、対象が減る。`solar-system` 9ファイルの引数 `pack` 117 箇所は残る。
- **`AbsoluteEphemeris` / `PackedAbsoluteEphemeris` の改名(同 手順5)** — 影響なし。そのまま
  実施できる。
- **`ephemeris` / `orbit` の規範(同 2.2 節)** — 「`orbit` は主天体相対」が `PlanetSystem` の
  導入で明確になるので、**規範を弱める必要はなく、むしろ根拠が増える。**
- **`OrbitLine` / `RelativeOrbitLine` の改名(同 手順8)** — 影響なし。独立に実施できる。
