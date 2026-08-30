# 座標は誰が持ち、どこで変換されるのか

**争点だけを持つ。決めたことは「0. 方針」だけで、それ以外は未決。**
行番号のスナップショットは **`82fdcf6c`**。
`refactor_orbit_ephemeris.md` の論点2(キャッシュの持ち主)はここへ引き継いだ。

---

## 0. 方針(ここは決まっている)

- **天体1体が持つのは「自分がどこにいるか」であって、他天体との関係ではない。** 原点は
  恒星中心(衛星は主天体相対、暦パックは太陽系重心)。
- **ECI は game 側の都合。** `DynamicSystem` が ECI を採るのは数値精度のため —
  f64 の絶対分解能(`r × 2⁻⁵²`)は日心距離 1.5e11 m で **33 µm**、地心距離 6.8e6 m で
  **1.5 nm** と4桁以上違う。physics/celestial にこの都合を持ち込まない。
- したがって **ECI 変換は game/celestial(あるいはそこが physics/frame へ委譲する形)で行い、
  `CelestialMotion` は ECI も原点天体も知らない。**
- **全天体が自分の恒星中心状態をキャッシュしてよい。** ECI が要るときは「その天体の値」と
  「ECI 原点天体の値」を組み合わせる。**組み合わせるのは変換側の仕事で、天体側ではない。**

---

## 1. いま誰が何の座標を持っているか(調査結果)

| 持ち主 | 値 | 原点 | キャッシュ | 方針との関係 |
| --- | --- | --- | --- | --- |
| `StarMotion` | 位置・速度(定数 0) | 恒星中心 | 無し | ○ |
| `PlanetMotion` | 惑星本体の位置・速度 | 恒星中心 | `helioCache`(`celestial-motion.ts:407`) | ○ |
| `SatelliteMotion` | 惑星相対の位置・速度 | 主天体相対 | `relCache`(`:472`) | ○ **恒星中心値は毎回組み直している**(`:496`)— キャッシュが無い |
| `PlanetSystem` | 系の重心の位置・速度 | 恒星中心 | 無し(呼び手が畳む) | ○ |
| `CelestialMotion`(全体) | 暦パックの位置・速度 | 太陽系重心 | 無し | ○(→ 争点A) |
| `CelestialMotion`(全体) | **自分の ECI 瞬間値** | **ECI** | `eciCache`(`:122`) | **✕ 方針に反する** |
| `CelestialMotion`(全体) | **ECI 原点天体の一式** | 恒星中心 + 太陽系重心 | `eciOriginCache`(`:123`) | **✕ 他天体の値を全天体が持っている** |
| `CelestialSystem` | 天体の集合 | ECI | `allCache` ほか3本(`celestial-system.ts:84-86`) | game 側なので位置としては○(→ 争点F) |
| `DynamicEntity` | 機体の状態 | ECI | — | ○ |
| `FrameAnchors` | 1フレームぶんの天体配列 | ECI | フレーム単位 + 文字列キーの1件メモ(`frame-anchors.ts:31-32`) | 文字列キーは別件(→ 争点D) |
| `FloatingOrigin` | 描画原点 | ECI | フレーム単位 | ○ |

**向きの量は原点に依らない。** 自転軸・軌道法線・2次重力場の極・大気の共回転軸・姿勢
クォータニオンは、どれも軸だけで決まるので**原点変換の対象ではない**(軸そのものを系全体で
1つに固定する判断は `refactor_orbit_ephemeris.md` 論点3)。**変換が要るのは位置と速度、
そして加速度だけ。**

---

## 2. 争点

### 争点A. 暦パック経路は恒星中心ではない(太陽系重心)

`BodyEphemeris.stateAt` は `KinematicState<'barycentric'>` を答える。いまの ECI 化は
**「自分と原点を必ず同じ供給源から引く」**ことで成立していて、パックが引ける時刻は
両方を重心中心で、引けない時刻は両方を恒星中心で引いて差を取る。**この不変条件は本質的に
2天体にまたがる**ので、天体1体には持たせられない。

| | 得る | 失う |
| --- | --- | --- |
| **2系統のまま、変換器が供給源を揃える** | **ECI 値がビット単位で変わらない**。天体は「恒星中心」と「重心中心」の2つの口を持つだけ | 「日心で揃える」は達成されない。供給源を揃える責任が変換器へ移るだけ |
| **暦パック値も恒星中心へ正規化する** | 天体の口が1つになる。変換器は引き算だけ | 恒星のパック位置を引く分だけ**丸めが変わり、ECI 値がビット単位で動く** — `tests/physics/celestial-eci-baseline.test.ts` の固定値を書き換えることになる |

**どちらでも方針(天体が ECI を知らない)は満たせる。** 選ぶ基準は「口を1つにしたいか」
対「baseline を動かしたくないか」。

### 争点B. `CelestialBody` が型として ECI 固定

`CelestialBody.state` は無標の `KinematicState`(= `'eci'`)、`accel` は素の `Vec3`
(`celestial-body.ts:26-37`)。この型は physics の 17 ファイル・game/render の 55 ファイルが
使う。

**ただし physics の関数の大半は原点に依らない** — `strongestAttractor` /
`nearestAtmosphereBody` / `sunlitFactor` / `srpAccel` / `orbitalElementsOf` はすべて差だけを
見る。`attractorAccel`(`:78`)も「原点天体が原点に静止している系」でありさえすれば成り立つ
式で、恒星中心でもそのまま正しい。**ECI を要求しているのは型だけ。**

| | 得る | 失う |
| --- | --- | --- |
| **`CelestialBody<F>` へ型引数化**(効くのは `state` と `accel` だけ。向きの成分は原点に依らないので触らない) | 恒星中心の1体ぶんを同じ型で表せる。取り違えが型で止まる | 72 ファイルへ型引数が波及する。既定を `'eci'` にすれば書き換えは要らないが、**素通しできてしまうぶん守りは弱い** |
| **ECI 専用のまま、恒星中心の1体ぶんは別の型を立てる** | 波及しない | 同じ内容の型が2つ並ぶ |
| **現状維持(game が ECI で組む)** | 何も動かない | 型の上では「ECI の天体」しか存在しないままになる |

### 争点C. `ReferenceFrames` は ECI 化の下流にある

`transformAt` が返す `FrameTransform` の `origin` は、**呼び出し側が渡した ECI 値から
引き算される**(`frame.ts:67`, `:124`)。さらに `frameRotationAt`(`reference-frames.ts:96`)は
**機体の ECI 状態と天体の状態を直接引き算する** — 機体は ECI しか持たないので、天体側も
ECI で揃っている必要がある。

つまり `ReferenceFrames` は「天体→天体」だけを見ているのではなく、**ECI 化が済んだ後の世界を
前提にしている。** ユーザーの言う2段変換(非 ECI 原点天体 → ECI → 機体との相対)を素直に
実装すると、前段は `ReferenceFrames` の外で終わっていなければならない。

| | 得る | 失う |
| --- | --- | --- |
| **ECI 値の解決口を注入する**(`FrameAnchorSource` と同じ形。`(id, t) => KinematicState`) | `ReferenceFrames` は physics に残る | 口が1つ増える。既存の `FrameAnchorSource.bodies` は**1フレームの固定時刻スナップショット**で、任意の t に答えられないので流用できない(`frame-anchors.ts:47`) |
| **`ReferenceFrames` を game/celestial へ移す** | 口が増えない。ECI を知る層が game に揃う | physics から参照フレームが消える。`frame.ts`(純関数)との距離が開く |

### 争点D. 変換器は誰で、何をキャッシュするか

いまの `eciOriginCache` の中身 —「その時刻の ECI 原点天体の重心中心値・恒星中心値・加速度」と
「どちらの供給源か」— は、**天体ではなく変換器が1時刻ぶん持つのが自然**。争点は変換器の
正体と、天体1体ぶんの ECI 値(いまの `eciCache`)を残すかどうか。

- 変換器の候補: `CelestialSystem` が持つ値オブジェクト / `CelestialEntity` が結ぶもの /
  `ReferenceFrames` の `inertialFrame` に相当するもの。
- `eciCache` の実測(`refactor_orbit_ephemeris.md` 論点2): 積分パスでヒット率 **0.6%**、
  表示パスで **33%**。中身は引き算1回ではなく **1体あたり2回の姿勢評価**(`degree2At` と
  `atmosphereAt` がそれぞれ `orientationAt` を引く)を含む。
- `FrameAnchors.attractorCache*` の文字列キーはこの整理とは独立の別件。

### 争点E. branded type をどこまで広げるか

**`KinematicState<F>` は既に原点で branded されている**(`kinematic-state.ts:14`)ので、
「まず branded type で守る」の実質は**そこから漏れている部分**を塞ぐこと。漏れているのは:

- `CelestialBody.state`(`'eci'` 固定)と `CelestialBody.accel`(素の `Vec3`)
- `FrameTransform.origin` / `originVel`(素の `Vec3`。ECI 前提)
- 位置を素の `Vec3` で受ける physics の関数 — `attractorAccel(r, …)` /
  `strongestAttractor(r, …)` / `nearestAtmosphereBody(r, …)` / `localOrbitPeriod(r, …)` /
  `srpAccel(r, …)` / `sunlitFactor(r, …)` / `celestialBodyPositionAt` の戻り
- `FloatingOrigin.r`(`floating-origin.ts:18`)

**位置の `Vec3` 全部に札を付けるのか、`CelestialBody` の型引数化(争点B)だけで足りるのか**が
争点。`Vec3` 自体は `__tag: "Vec3"` を持つだけで原点は表していない。

### 争点F. 集合(`CelestialBody[]`)は誰が組むか

いまは `CelestialSystem`(game)が組んでいて、方針とは矛盾しない。ただし変換を
`CelestialEntity` へ引き上げると、**集合は「個体が変換した結果を集めたもの」になる** —
`CelestialSystem` が変換器を持って自分で組むのか、個体に組ませて集めるのかで、
変換器の配り先が変わる(争点D と連動)。

---

## 3. 変換が要る境界(棚卸し)

| 境界 | 何から何へ | なぜ |
| --- | --- | --- |
| `DynamicSystem`(数値積分) | 恒星中心 → ECI | f64 の絶対分解能(33 µm → 1.5 nm) |
| scene(描画) | ECI → フローティング原点 | f32 の桁落ち回避 |
| `ReferenceFrames` / HUD / マップ / 計画 | ECI → 参照フレーム相対 | 表示上の座標系(→ 争点C) |
| 暦パック | ICRF 軸 → ゲーム固定軸 | 軸の統一(`refactor_orbit_ephemeris.md` 論点3。原点変換とは別) |

**この4つ以外に ECI が必要な場所は無いはず** — 「無いはず」を確かめるのが整理の実質。

---

## 4. 手を付ける順序(案)

1. **争点E の棚卸しを確定させる。** どこが素の `Vec3` で原点を持っているかは調べ切ってあるので、
   守り方(争点B の選択)を決める。
2. **争点A を決める。** 天体が答える口を1つにするか2つにするかで、変換器の形が決まる。
3. **争点C・D を決めて、変換器を置く。** ここで `eciCache` / `eciOriginCache` が
   `CelestialMotion` から外れる。
4. **全天体に恒星中心のキャッシュを持たせる。** いま `SatelliteMotion` は恒星中心値を
   毎回組み直している(`celestial-motion.ts:496`)。変換器が恒星中心値を引く形になると、
   引かれる回数が増えるので、ここで畳む。
