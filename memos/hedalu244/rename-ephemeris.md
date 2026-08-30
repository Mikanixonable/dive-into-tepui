# ephemeris / orbit / pack の命名体系を規範化する

## 目的

`src/**/*.ts` に `ephemeris` を含む行が 210 行あるが、**語が層ごとに違うものを指していて、同じ値が
境界をまたぐたびに別名になっている。** `HelioEphemeris` は保持側で `precise`、渡す側で `pack` と
呼ばれ、`.epk` の器も、それを読む口も、どちらも `pack` と呼ばれている。加えて **位置・速度を答える
口のほとんどが無標の `stateAt` / `stateOf` で、原点(ECI か恒星中心か主天体相対か)が名前に出ない。**

CODING-RULE 2.2 は `celestial` / `dynamic` を対として固定し `ephemeris` をその軸から外したが、
**`ephemeris` 自身の意味はまだ規範化されていない。** この計画で `ephemeris` / `orbit` / `pack` の
使い分けと「原点を名前に出す」規則を規範として確定し、そこから外れた識別子を直す。
**挙動は一切変えない。**

---

# 第1部 現況

以下はすべて `c849c988` 時点のコードから読み取ったもの。**維持しない** — 手順を実施したら、この部は
役目を終える。

## 1.1 天体1体について、何が何を答えているか

天体1体の運動は `CelestialMotion`(`src/physics/celestial-motion.ts`)が唯一の窓口で、並進(位置・
速度・加速度)・自転姿勢・2次重力場・大気をすべて答える。**供給源が2系統あるのは並進の位置・速度
だけ。**

| 問い | 供給源 | 実体 |
| --- | --- | --- |
| 並進の位置・速度(表引き) | `.epk` の Chebyshev 位置係数 | `HelioEphemeris` |
| 並進の位置・速度(閉じた式) | ケプラー要素 + 摂動項 | `PlanetOrbit` / `SatelliteOrbit` |
| 並進の加速度 | **常に解析**(主天体まわりの二体近似) | `helioAccelAt` |
| 自転 | **常に解析**(IAU 極モデル / カッシーニ / ECI 極) | `PoleModel`(`physics/celestial-body-def.ts`) |
| 2次重力場・大気・形状 | **常に解析**(宣言そのもの) | `Degree2GravityDef` / `AtmosphereDef` / `ShapeDef` |

**したがって `ephemeris` が答えるのは並進の位置・速度だけで、`CelestialMotion` の下請けの一方でしか
ない。** `celestial` と同じ次元の分類ではない(CODING-RULE 2.2 で確定済み)。

## 1.2 恒星中心 → ECI の変換は誰がやっているか

**`src/physics/celestial-motion.ts` の1ファイルだけ。** `helio` を含む識別子は `src/` 全体で、この
ファイルと `HelioEphemeris` の型注釈にしか現れない。変換は2経路あり、どちらも「自分の恒星中心状態
− ECI 原点天体の恒星中心状態」の1減算で終わる。

```
CelestialMotion.eciStateAt(t)            ← private。ECI 化の唯一の場所(:219)
├ packedEciStateAt(t)                    暦パック経路。両端を引けたときだけ非 null(:223)
│ ├ this.packedHelioStateAt(t)           自分(パック)(:237)
│ └ EciOrigin.packedHelioStateAt(t)      原点天体(パック。時刻ごとに1回へ畳む)(:123)
└ analyticEciStateAt(t)                  解析経路。片端でも欠けたらこちら(:231)
  ├ this.helioStateAt(t)                 自分(解析。Star/Planet/Satellite で実装が別)
  └ origin.motion.helioStateAt(t)        原点天体(解析)
```

**軸の付け替え(ICRF → ゲーム ECI 軸)はここではなく `icrfToGameEci`(`absolute-ephemeris.ts:27`)**
で、`HelioEphemeris.stateOf` が重心差を取った直後に通す。つまり「ECI **軸**にする」と「ECI **原点**に
する」は別のファイルで起きていて、**前者だけが名前に `Eci` を持っている。**

加速度は経路が分かれない。`eciAccelAt` は常に `helioAccelAt` の差なので、**パックが引ける期間でも
`CelestialBody.accel` は解析値。**

## 1.3 ECI を答えられるのは誰か

| 口 | 何を答えるか | 原点 | 供給 |
| --- | --- | --- | --- |
| `CelestialMotion.at(pivot)` → `CelestialBody.state` | 登録天体の厳密な位置・速度 | **ECI** | `eciStateAt` |
| `CelestialMotion.stateAt(pivot, t)` | 上を pivot から t へ2次外挿した値 | **ECI** | 同上 + `celestialBodyStateAt` |
| `CelestialBodyWindows` の3口 | 全登録天体の配列 | **ECI** | `motion.at(t)` |
| `OrbitingMotion.lagrangeAt` / `lagrangeStateAt` | ラグランジュ点の位置・状態 | **ECI** | `stateAt` + 回転基準系 |
| `FrameAnchorSource.stateOf(id, t)`(実体 `FrameAnchors`) | 非登録基準(機体・役割トークン・生存中の重力天体) | **ECI** | エンティティ側 |
| `entityStateAt(entity, t, centerMotion)` | dynamic エンティティ | **ECI** | 積分・内挿・ケプラー外挿 |
| `ReferenceFrames.transformAt(frame, t, source)` | 座標系の剛体運動 | **ECI** | 上2つ |
| `orbit-guide.ts` の `GuideLoop.shape` | ガイド線の曲線 [m] | **ECI** | カタログ + 天体位置 |
| `HelioEphemeris.stateOf(id, simTime)` | 位置・速度 | 恒星 | パック |
| `CelestialMotion.helioStateAt(t)` | 位置・速度 | 恒星 | 解析 |
| `SatelliteMotion.relStateAt(t)` | 位置・速度 | 惑星 | 解析 |
| `OrbitalElements` + `positionOnOrbit` / `stateOnOrbitAt` | 位置・状態 | `el.center` | 要素 |
| `AbsoluteEphemeris.barycentricStateOf(id, jdTdb)` | 位置・速度 | 太陽系重心 | パック |

**`Eci` を名前に持つのは `eciStateAt` / `eciAccelAt` / `icrfToGameEci` / `EciOrigin` の4つだけで、
実際に ECI を答える口はどれも無標の `stateAt` / `stateOf`。** しかも下5行(恒星中心・惑星相対・
中心天体相対・重心)も同じ `*StateAt` / `*StateOf` 語族に入っている。

## 1.4 epk 由来の精密暦は何を答えられるのか

**答えられるのは、11 個の id の位置・速度だけ。**

- 収録 id は `sun, mercury, venus, earth, moon, mars, jupiter, saturn, uranus, neptune, pluto`
  (`tools/ephemeris/generate.py:37`)。
- 座標は ICRF/J2000・太陽系重心原点、時刻は J2000 ET 秒(TDB)。`.epk` に入るのは**位置の Chebyshev
   係数だけ**で、速度は係数の微分から出す。
- 有効期間は同梱パックが実際に覆う 10 年ずつの2枠(`EPHEMERIS_PROFILES`)。

**答えられないもの:**

| 何を | なぜ | 代わりに誰が |
| --- | --- | --- |
| 自転・2次重力場・大気・形状 | パックは位置係数しか持たない | `PoleModel` / `Degree2GravityDef` / `AtmosphereDef` |
| 加速度 | 同上 | `helioAccelAt`(常に解析の二体近似) |
| 主天体相対 | 共通原点しか持たない | `packedPrimaryRelStateAt` が2回引いて差を取る(`:429`) |
| 11 個に無い天体 | 収録外 | `SatelliteMotion.packedStateAt` が「収録済みの惑星 + 解析の惑星相対」で補う(`:561`) |

同期回転衛星(カッシーニ)の自転位相は `keplerOrbit` から出るため、**パックが引ける期間でも自転は
解析軌道を経由する。** `EphemerisProfile.orientationModelId` は自転モデルを名乗る宣言だが、`src/`
`tests/` `tools/` のどこからも読まれない — **パックが自転を答えないという事実を、この宣言が名前だけ
で否定している。**

## 1.5 語の突き合わせ — いま何が残っているか

### A. 完全な同義語(同じ概念に二つの名前)→ 統一する

| 何と何 | 同じであることの根拠 | 手順 |
| --- | --- | --- |
| `ChebyshevEphemeris.stateOf` / `.stateAtSeconds` | 後者が前者を呼ぶだけ(`evaluator.ts:279,285`)。コメントも "Explicit synonym" | 3 |
| `CelestialMotion.precise`(21行)/ solar-system 9ファイルの引数 `pack`(117箇所) | どちらも同じ1個の `HelioEphemeris` を指す | 4 |
| `CanonicalEvaluatorEphemerisPack` / `ChebyshevEphemerisPack` | 前者は後者の manifest 2フィールドを必須にしただけ | 6 |
| `ReferenceFrames.frameFor(id)` / `frameOf(id, null)` | コメントで「別名」と明記 | **触らない**(1.6) |

### B. 同じ契約の実装違い → 語族を統一し、区別がつく命名に

| 契約 | 実装 | いまの名前の何が悪いか | 手順 |
| --- | --- | --- | --- |
| 絶対時刻 → 重心状態(`AbsoluteEphemeris`) | `PackedAbsoluteEphemeris` / テストの閉じた式実装(`tests/physics/absolute-ephemeris.test.ts:10-21`) | `Packed` は器を指し中身(Chebyshev)を隠す。`Absolute` は原点を言っていない | 5 |
| simTime → 恒星中心状態 | `helioStateAt`(解析)/ `packedHelioStateAt`(パック) | **片方だけが無標。** 解析であることが名前に出ず、対比が非対称 | 4 |
| simTime → ECI 状態 | `analyticEciStateAt` / `packedEciStateAt` | ここは対になっているが、区別語 `analytic`/`packed` が直上の対と揃わない | 4 |
| 主天体相対の回転基準系・法線 | `orbitFrameRotationAt` / `orbitNormalAt` が内部でパック経路と `keplerOrbit*` を切り替える | **名前は `orbit` のままでよい**(答えているのは orbit の量、供給源が ephemeris というだけ)。ローカル変数 `packed` だけ揃える | 4 |
| 1天体・1区間の係数 | `EphemerisSeries`(ワイヤ manifest の記述)/ `ChebyshevSegmentInput`(生成入力)/ `ChebyshevSegment`(評価器の実体) | 同じものを series / segment の2語で呼ぶ | 3 |

### C. 似ているが異なる契約 → 区別の本質が分かる命名に

| 何と何 | 違いの本質 | 名前から分かるか | 手順 |
| --- | --- | --- | --- |
| `HelioEphemeris.stateOf(id, simTime)` / `AbsoluteEphemeris.barycentricStateOf(id, jdTdb)` | 原点(恒星/重心)・軸(ゲーム ECI/ICRF)・時刻軸(simTime/JD_TDB)の3つが違う | 原点は片方だけ。軸と時刻軸はどちらも出ない | 3・5 |
| `stateAt(pivot, t)` / `helioStateAt(t)` / `relStateAt(t)` / `packedHelioStateAt(t)` | 原点が ECI / 恒星 / 惑星の3種。さらに `stateAt` **だけが外挿(近似)** で他は厳密 | **無標の `stateAt` が、いちばん強い契約(ECI かつ近似)を持っている** | 1・4 |
| `stateAt(pivot, t)` の2引数 / 他の `*StateAt(t)` の1引数 | 第1引数が「厳密に引く時刻」と「答える時刻」で意味が違う | 同じ語族なのに引数の意味が違う | 1 |
| `icrfToGameEci` | 軸の付け替えだけで原点は動かさない | 名前は `Eci` だが、返るのは恒星中心の値 | 5 |
| `EphemerisProfile.validStart/EndJdTdb` / `HelioEphemeris.isValidAt(simTime)` | 同じ有効期間を JD_TDB と simTime の2軸で表す | `isValidAt` の引数が simTime であることが出ない | 5 |
| `epochJdTdb` / `epochOffsetSec` / `OrbitEpoch.t` / `*AtEpoch` | 時刻軸が3種、うえに `*AtEpoch` は「元期における」ではなく「元期を畳んだ」 | `epoch` 1語で全部呼んでいる | **触らない**(1.6) |
| `EphemerisProfile` / `EphemerisContext` / `ephemeris-catalog` / `ephemerisSeconds` | 年代の宣言 / セーブの互換キー / ロード口 / 時刻の定訳 | 供給源の型と族語を共有し、grep で混ざる | 7 |
| ファイル `absolute-ephemeris.ts` | `AbsoluteEphemeris`(重心)と `HelioEphemeris`(恒星中心)が同居 | ファイル名が中身の半分しか覆っていない | 7 |

### D. 全く別の概念に同じ名前 → 全く別の名前に

| 名前 | 別々に指しているもの | 手順 |
| --- | --- | --- |
| `pack` | ①`.epk` の器(`DecodedEphemerisPack` / `ChebyshevEphemerisPack` / `packId` / `packFormatVersion`)②`stage.ts:110` のローカル = **`AbsoluteEphemeris`**(重心・JD_TDB)③`solar-system.ts:56` のローカルと9系ファイルの引数 = **`HelioEphemeris`**(恒星中心・simTime)。**②と③は型が違うのに同名で、`solar-system` の境界で中身がすり替わる。** | 4・6 |
| `stateOf` | ①`HelioEphemeris.stateOf`(恒星中心・ゲーム ECI 軸・simTime)②`ChebyshevEphemeris.stateOf`(ICRF 重心・ET 秒)③`FrameAnchorSource.stateOf`(ECI・null 可)。**3つとも `(string, number)` で、取り違えても型が通る。** | 3・5(③は触らない) |
| `positionOf` | ①`ChebyshevEphemeris.positionOf`(ICRF 重心)②`tests/physics/test-helpers.ts:49`(ECI) | 3 |
| `series` | ①`.epk` manifest の Chebyshev 区間 ②HUD のチャート系列 | 3(ワイヤキーは凍結) |
| `analytic` | ①解析暦(`analyticEciStateAt`)②閉じた式で書ける形(`GuideShape.kind === 'analytic'`) | **触らない**(1.6) |
| `orbit` | ①要素の束(`KeplerOrbit` / `PlanetOrbit` / `SatelliteOrbit`)②状態から求めた瞬間の要素(`OrbitalElements`)③CR3BP の焼き込み点列(`orbit-catalog`)④ECI 曲線(`orbit-guide`)⑤描画物(`OrbitLine`)⑥**軌道ですらない直線**(`RelativeOrbitLine`) | 8 |
| 天体 id `mars`〜`pluto` | パックでは系の重心、解析暦では惑星本体 | **別件**(1.6) |

## 1.6 この計画では触らないもの

| 何 | なぜ外すか |
| --- | --- |
| `FrameAnchorSource.stateOf` / `FrameAnchors.stateOf` の改名 | ECI を答える口だが、影響が `game/` 全域(`frame.ts` / `frame-anchors.ts` / `reference-frames.ts` / `focus-target` / テスト4本)。ephemeris 族の `stateOf` が消えれば衝突の実害は減る。改名するなら独立した計画で |
| `ReferenceFrames.frameFor` / `frameOf(id, null)` の重複 | 座標系の話で、ephemeris/orbit の語族と無関係 |
| `epoch` の3時刻軸(`epochJdTdb` / `epochOffsetSec` / `OrbitEpoch.t`) | `665f4e9b` で入ったばかりで、時刻軸の語彙は `physics/time/` の branded type ごと考える話。別計画 |
| `GuideShape.kind === 'analytic'` | `orbit-guide` の内部語彙。`analyticEciStateAt` と衝突するが、両者が同じファイルに現れることはない |
| 天体 id `mars`〜`pluto` の重心/本体の食い違い | **命名ではなく値の問題。** パックは SPK コード 4〜9 をそのまま引くので系の重心(`generate.py:74-88`)、解析経路の同じ id は `PlanetMotion.computeHelioStateAt` が衛星ぶんの重心補正を差し引いた惑星本体。冥王星はカロンとの質量比 1:8 で重心が本体の外に出るため、食い違いが天体半径を超えうる(**未計測**)。バグとして別立てで扱う |

---

# 第2部 決めたこと

覆されたときにどの手順が変わるかを各項に書く。

## 2.1 `ephemeris` と `orbit` を分ける軸(改訂)

**「表引きか閉じた式か」は軸ではない。** 両方向に反例がある — `AbsoluteEphemeris` は
`tests/physics/absolute-ephemeris.test.ts:10-21` で閉じた式として実装されており
(`absolute-ephemeris.ts:2` の冒頭コメントも解析解を実装の選択肢に数えている)、逆に
`orbit-catalog.ts` の CR3BP 族は焼き込んだ点列である。表現の選択は族の境界ではない。

**~~軸1 — 絶対時刻を引数に取るか。~~ この軸は成立しない。** `bce7edc9` で `OrbitalElements` が
`epoch: OrbitEpoch | null`(`elements.ts:10,21`)を持ち、`stateOnOrbitAt(el, t)`(`elements.ts:163`)が
絶対時刻から状態を答えるようになった。`KeplerOrbit` も `keplerOrbitAtEpoch` が simTime の原点を
畳み込むので、`keplerOrbitState(orbit, t)` の t は simTime そのもの。**いまや orbit も絶対時刻から
状態を答える。**

**軸2 — 誰に対する位置か。** `orbit` は主天体相対で、主天体が変われば別の軌道になる。`ephemeris` は
系で共通の1原点(恒星 = 系の階層の根)に対する位置で、天体ごとに原点は変わらない。
`OrbitingMotion.packedPrimaryRelStateAt`(`celestial-motion.ts:429-437`)が主天体相対を得るために
**ephemeris を2回引いて差を取っている**のは、ephemeris が主天体相対を直接は答えられないため。
`13f59089` でパック側も恒星中心へ揃ったので、この対比は前より鮮明になった。

**軸3 — 天体を id として知っているか。** `ephemeris` は **天体 id で引く表**で
(`stateOf(id, t)` / `hasBody(id)` / `bodyIds()`)、天体を id 文字列としてしか知らない。`orbit` は
**1本の経路そのもの**で、どの天体のものかを知らない — `KeplerOrbit` にも `OrbitalElements` にも
id フィールドは無い(`OrbitalElements.center` が持つのは中心天体であって自分ではない)。

**この2軸で両者は直交する。** 同じ ECI 位置を共通原点から引いても主天体相対を積み上げても出せる
ので、`CelestialMotion.eciStateAt` が両方を持って切り替えられる。`orbitFrameRotationAt` /
`orbitNormalAt` が ephemeris を2回引いて軌道面法線を組むのも同じ理由で、答えているのは orbit の量、
供給源が ephemeris というだけなので**名前は `orbit` のままでよい。**

## 2.2 規範

1. **`ephemeris`** — **天体 id を引数に、系で共通の1つの原点に対する並進状態(位置・速度)を答える
   表**、およびその素性。天体を id 文字列としてしか知らない。自転・重力場・大気・**加速度**を
   含まない。表引きか閉じた式かは問わない。
2. **`orbit`** — **主天体に対する、繰り返される1本の経路そのもの。** どの天体のものかを知らない。
   形と、その上の位相(真近点角・弧長・周期比)で表す。**位相の基準(`OrbitEpoch`・`*AtEpoch` で
   畳んだ元期)を持てば絶対時刻でも引けるが、それは orbit を ephemeris にしない。** 現行
   CODING-RULE の「解析的に解ける軌道」は実装に合っていない(CR3BP 焼き込み族を排除してしまう)。
3. **`pack`** — `.epk` という**器**だけを指す。表を読む口を `pack` と呼ばない。
4. **供給源の区別語** — 型は `<区別語>Ephemeris`、素性側は `Ephemeris<区別語>`。区別語には
   「**どの座標原点か・どの表現か**」という軸そのものを置き、`precise` / `absolute` のような
   優劣・程度の語を置かない。
5. **位置・速度を答える口は、原点を名前に出す。** `eci*` / `helio*` / `primaryRel*` /
   `barycentric*` のいずれかを名前に含める。**無標の `*StateAt` / `*StateOf` を新設しない。**
   既存の `CelestialMotion.stateAt` は「ECI かつ pivot からの外挿」という最も強い契約を無標のまま
   持っているが、呼び出し箇所が広いので**改名せず、CODING-RULE と冒頭コメントで無標が ECI を指す
   ことを明記する**(この1語だけを規約上の例外として固定する)。
6. **供給源が分岐する対は、両方を有標にする。** 片方だけ無標にしない —
   `analytic<原点>StateAt` / `ephemeris<原点>StateAt` の対で揃える。
7. **`ephemerisSeconds` / `EphemerisScale`**(`physics/time/`)は天文の定訳 "ephemeris time" として
   例外にする。`OrbitalElements` と同じ扱いで、CODING-RULE に明記して迷いを断つ。

覆された場合: 1 が覆ると手順1・4・5・6 が、2 が覆ると手順1・8 が、3 が覆ると手順4・6 が、
5・6 が覆ると手順1・4 が変わる。

## 2.3 適用後の名前

| いま | あと | 区別しているもの |
| --- | --- | --- |
| `AbsoluteEphemeris` | `BarycentricEphemeris` | 座標原点 = 太陽系重心、時刻軸 = JD_TDB |
| `PackedAbsoluteEphemeris` | `ChebyshevBarycentricEphemeris` | 上の実装が Chebyshev 係数であること |
| ~~`OriginCenteredEphemeris`~~ | `HelioEphemeris`(改名済み) | 座標原点 = 恒星(系の根)、時刻軸 = simTime |
| `loadAbsoluteEphemeris` | `loadBarycentricEphemeris` | |
| `loadPackedAbsoluteEphemeris` | `loadChebyshevBarycentricEphemeris` | |
| `CelestialMotion.precise` | `.ephemeris` | 供給源そのもの |
| solar-system 9ファイル + `stage.ts` の `pack` | `ephemeris` | 同上 |
| `CelestialMotion.helioStateAt` | `analyticHelioStateAt` | 解析経路であることを有標に(規範6) |
| `CelestialMotion.packedHelioStateAt` | `ephemerisHelioStateAt` | 上との対 |
| `CelestialMotion.packedEciStateAt` | `ephemerisEciStateAt` | `analyticEciStateAt` との対 |
| `CelestialMotion.packedStateAt` | `ephemerisStateAt` | 供給源から自分の恒星中心状態を引く下請け |
| `OrbitingMotion.packedPrimaryRelStateAt` | `ephemerisPrimaryRelStateAt` | 同上 |
| `EciOrigin.packedHelioStateAt` / `packedCache` | `ephemerisHelioStateAt` / `ephemerisCache` | 同上 |
| `EphemerisSeries`(TS 型) | `PackSegment` | evaluator 側 `ChebyshevSegment` と同一概念 |
| `EphemerisManifest` / `EphemerisManifestBase` | `PackManifest` / `PackManifestBase` | `.epk` の器の宣言 |
| `EphemerisPackFormatError` | `PackFormatError` | モジュール名が既に `ephemeris-pack` |
| `DecodedEphemerisPack` | `DecodedPack` | 同上 |
| `ChebyshevEphemerisPack` | `ChebyshevPack` | 同上 |
| `ChebyshevEphemeris.stateOf` | 削除(`stateAtSeconds` へ一本化) | 時刻軸が秒であることを名前で示す |
| `CanonicalEvaluatorEphemerisPack` | 解消 | |
| `OrbitLine` | `EllipseLine` | 閉じた楕円しか描けない |
| `RelativeOrbitLine` | `TargetRelativeLine` | 軌道ではなく2点を結ぶ直線 |

**据置** — `CelestialMotion.stateAt` / `at`(規範5 の例外)、`analyticEciStateAt`(既に有標)、
`orbitFrameRotationAt` / `orbitNormalAt`(答えているのは orbit の量)、`OrbitPickKind` の
`'orbit-body'` / `'orbit-ship'` / `'orbit-guide'`(線の種類ではなく「何の軌道か」の分類)、
ワイヤ形式のキー `series` / `EPHEMERIS_PACK_VERSION` / `packId` / `packFormatVersion`(凍結)。

## 2.4 他の選択肢

**代案A — `ephemeris` を捨て、表引き側を `table` / `tabulated` にする。** 天文学の ephemeris は
解析暦も含む「位置表」全般を指すので、コード内の日本語コメントの「暦」(解析暦・精密暦の両方を
含む)とのズレが残り続ける。`PositionTable` などへ寄せれば、`CelestialMotion` 全体を「暦」と呼ぶ
日本語と衝突しなくなる。**欠点**: 定訳を捨てるので外部知識が効かず、`.epk`(= ephemeris pack)・
`EphemerisProfile`・`EphemerisContext`・セーブの JSON キー `ephemerisContext` まで巻き込む。
セーブのキー変更は互換判定に触るので範囲が跳ね上がる。

**代案B — CODING-RULE の当初定義(「時刻から天体の位置を答える仕組み」)を守り、`CelestialMotion`
を `BodyEphemeris` へ改名する。** 語の定義とコードは一致するが、`CelestialMotion` は自転・2次重力場・
大気まで持つので `ephemeris` では狭すぎる。かつ `celestial` / `dynamic` の対から天体運動の中心
クラスが抜ける。**却下を推奨。**

**代案C — `Barycentric` の代わりに `Ssb`(Solar System Barycenter)を使う。** `SsbEphemeris` は短く
原点が一意。`Barycentric` は「どの重心か」を言っていないぶん曖昧だが、この系では太陽系重心しかない。
略語1語の識別子は「略語は1単語として扱う」規則には収まるが、読み手を選ぶ。

**代案D — `stateAt` も有標にする**(`eciStateAt` を public にして `stateAt` を廃す)。規範5 の例外を
作らずに済み、「無標 = ECI」という暗黙を消せる。**欠点**: `stateAt` は `src/` の広範囲から呼ばれる
うえ、`at(pivot)` との対で読まれている。**改名の総量がこの計画の残り全部を超えるので却下**し、
規約上の例外として明記する側を採る。

**代案E — `helioStateAt` を無標のまま残す**(`packedHelioStateAt` だけを `ephemerisHelioStateAt` へ)。
差分は小さいが、`analyticEciStateAt` / `ephemerisEciStateAt` の対とだけ揃って恒星中心の対が非対称に
残る。**規範6 と衝突するので却下。**

**代案F — `OrbitLine` は `KeplerLine`。** CR3BP 焼き込み族(`orbit-guide`)との対比は出るが、
`elements.ts` は双曲線も表せる = **ケプラー軌道でも `OrbitLine` では描けないものがある**ので、
実装の限定を正確に写すのは `Ellipse` のほう。`KeplerLine` を採るなら「二体解析解の線」の意で、
楕円限定であることは別途コメントで担保する。

**代案G — 語順を族語前置で全部揃える**(`EphemerisBarycentric` / `EphemerisHelio`)。
`EphemerisProfile` / `EphemerisContext` と語順が揃い、grep で族が一箇所に集まる。**欠点**: 英語の
語順として不自然で、`HelioEphemeris`(src 28 + tests 6)を含む既存の読みやすさを落とす。

---

# 第3部 実施

## 3.1 達成目標

全手順の実施後、以下がすべて満たされること。

1. `grep -rn "precise" src/` が 0 件。
2. `grep -rnE "\bpack\b" src/game/celestial/solar-system/` が 0 件(`.epk` の器を指す用例はこの層に
   無い)。`src/game/save/` の 4 件と `stage.ts` の `packId` 系は据置。
3. `grep -n "packed" src/physics/celestial-motion.ts` が 0 件。
4. `stateOf` という名のメソッドが、**ephemeris 族の中に**座標系も時刻軸も違うまま2つ存在しない
   (`FrameAnchorSource.stateOf` は 1.6 のとおり残る)。
5. `grep -rn "orientationModelId" src/ tests/ tools/` が 0 件。
6. `grep -rn "Absolute" src/physics/` が 0 件(`AbsoluteEphemeris` 族の消滅)。
7. CODING-RULE 2.2 に `ephemeris` / `pack` の節があり、`orbit` の定義が CR3BP 焼き込み族と
   `OrbitEpoch` のどちらも排除しない。無標 `stateAt` が ECI を指す例外も明記されている。
8. `npm run typecheck` と `npm run test`(全層)が通る。
9. `node tools/ephemeris/cli.mjs verify src/assets/ephemeris/modern-2026-10y.epk` が
   `10054 segment(s)` と payload SHA-256 `343c7b46a1b77c46b6f986d263666a62c227ac735209ae3b6ce89a751b286505`
   を報告する(**`c849c988` で実測済みの現状値**)。
10. 既存セーブが復元できる — `EPHEMERIS_PACK_VERSION` と `.epk` のワイヤ形式が変わっていない。

## 3.2 手順

### 手順1. CODING-RULE 2.2 へ規範を書く

**目的.** 規範を先に置く。以降の手順は、この節から外れているものを直す作業になる。
**この時点でコードは変えない。**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/CODING-RULE.md`「`orbit` / `path` / `trajectory`」節 | `orbit` の定義を規範2 へ改める。「解析的に解ける軌道」を落とし、**表引きか閉じた式かは軸ではない**ことと、**位相の基準を持てば絶対時刻で引けること**を1文ずつ添える |
| 同(新設)「`ephemeris` / `pack`」節 | 規範1・3・4・7 と、`ephemeris` / `orbit` を分ける2軸(**共通原点か主天体相対か / 天体 id で引く表か1本の経路か**)をそのまま規則として書く |
| 同(新設または「`celestialBody`」節へ追記)「原点を名前に出す」 | 規範5・6 を書く。**無標の `CelestialMotion.stateAt` / `at` が ECI を指すことを、唯一の例外として明記する** |

**達成条件と検証.** `grep -n "ephemeris" DEVELOP/CODING-RULE.md` が新設節を返す。
`grep -n "解析的に解ける軌道" DEVELOP/CODING-RULE.md` が 0 件。

### 手順2. 死んだ宣言を落とす

**目的.** 使われていない宣言が残っていると、命名の是非を判断するとき「これは何のためにあるのか」を
毎回調べ直すことになる。改名の前に対象を減らす。**この時点で挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/ephemeris-profile.ts:13,28,38` | `orientationModelId` を落とす。自転は `PoleModel` が全部持っており、この宣言はどこからも読まれていない(1.4) |
| `src/physics/ephemeris-pack/evaluator.ts:293` | `velocityOf` を落とす(呼び出し元なし) |
| `src/physics/ephemeris-pack/evaluator.ts:257` | `segmentOf` を private にする(`evaluate` からしか呼ばれない — **確認済み**) |
| `src/physics/ephemeris-pack/evaluator.ts:226-227` | 公開フィールド `manifest` / `pack` を private へ落とす(外部読み手が無いことは **確認済み**。`.manifest` の他の当たりは `DecodedEphemerisPack.manifest` と `validateManifest` のローカル) |

`tests/physics/ephemeris-profile.test.ts` は `orientationModelId` を見ていないので追従不要。

**達成条件と検証.** `npm run typecheck` と `npm run test:physics` が通る。
`grep -rn "orientationModelId\|velocityOf" src/ tests/ tools/` が 0 件。

### 手順3. `.epk` 読み口の同義語を1語へ寄せる

**目的.** 同じものに2つの名前がある箇所を潰す。**この時点で挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/ephemeris-pack/evaluator.ts:279-287` | `stateOf` を削除し `stateAtSeconds` へ一本化する。`positionOf`(289)はテスト専用(`chebyshev-ephemeris.test.ts:64` のみ)なので落とし、テスト側を `stateAtSeconds(...).r` へ書き換える |
| `tests/physics/chebyshev-ephemeris.test.ts:60,64,76,77,78,93,95,97` | `eph.stateOf` → `eph.stateAtSeconds`、`eph.positionOf` → `stateAtSeconds(...).r` |
| `src/physics/ephemeris-pack/format.ts:41` | TS 型 `EphemerisSeries` を `PackSegment` へ改名。**ワイヤ形式のキー `series` は v1 の凍結された綴りとして残す** |
| `src/physics/ephemeris-pack/format.ts:66` | `EphemerisManifestBase` → `PackManifestBase`(`Omit<…, 'series'>` のキー名は据置) |
| `src/physics/ephemeris-pack/format.ts:1-31` の冒頭コメント | ワイヤのキーが `series`、コード上の語が `segment` であることを1文で明記する |
| `tests/physics/ephemeris-pack-format.test.ts`, `tools/ephemeris/cli.mjs` | 型名の追従(ワイヤのキーは触らない) |

**達成条件と検証.** `npm run typecheck` / `npm run test:physics` が通る。
`grep -rn "EphemerisSeries" src/ tests/ tools/` が 0 件。
`grep -n "stateOf\|positionOf" src/physics/ephemeris-pack/evaluator.ts` が 0 件。
達成目標9 のコマンドが現状と同じ出力を返す。

### 手順4. 供給源の呼び名を `ephemeris` へ統一し、解析/暦の対を揃える

**目的.** `HelioEphemeris` 型の値が、保持側で `precise`、渡す側で `pack` と呼ばれている。1つの名前に
揃え、`pack` を `.epk` の器へ返す。あわせて、供給源が分岐する対を規範6 のとおり両方有標にする。
**この時点で挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/celestial-motion.ts` の `precise` 全 21 行 | フィールド・引数 `precise` → `ephemeris` |
| 同 `:123` `:237`(2箇所) | `packedHelioStateAt` → `ephemerisHelioStateAt` |
| 同 `:223` | `packedEciStateAt` → `ephemerisEciStateAt` |
| 同 `:244` `:561` | `packedStateAt` → `ephemerisStateAt`(`SatelliteMotion` の override も) |
| 同 `:429` | `packedPrimaryRelStateAt` → `ephemerisPrimaryRelStateAt` |
| 同 `:108` | `EciOrigin.packedCache` → `ephemerisCache` |
| 同 `:306,320` | `orbitFrameRotationAt` / `orbitNormalAt` のローカル `packed` → `ephemeris`。**メソッド名は据置** |
| 同 `helioStateAt`(抽象 + `Star`/`Planet`/`Satellite` の実装3箇所 + 呼び出し) | `analyticHelioStateAt` へ。`analyticEciStateAt` / `ephemerisEciStateAt` の対と語が揃う |
| 同 冒頭コメントと `stateAt` / `at` のコメント | 「暦パック」を供給源の意で使っている箇所は「天体暦」へ。**無標の `stateAt` が ECI であること**を1文で明記(規範5) |
| `src/game/celestial/solar-system/solar-system.ts:56` | ローカル `pack` → `ephemeris`(型は `HelioEphemeris`) |
| `src/game/celestial/solar-system/{inner-planets,earth-system,mars-system,jupiter-system,saturn-system,uranus-system,neptune-system,dwarf-planets,small-bodies}.ts` | 引数 `pack` → `ephemeris`(9ファイル、計 117 箇所) |
| `src/game/stages/stage.ts:110,113` | ローカル `pack` → `barycentricEphemeris`(**型は `AbsoluteEphemeris` で solar-system 側とは別物**。手順5 で `BarycentricEphemeris` へ改名するので語を先に合わせる) |
| `tests/physics/celestial-motion.test.ts`, `tests/physics/test-helpers.ts` | 引数名・メソッド名を使っていれば追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test:physics` / `npm run test:game` が通る。
`grep -rn "precise" src/` が 0 件、`grep -n "packed" src/physics/celestial-motion.ts` が 0 件、
`grep -rnE "\bpack\b" src/game/celestial/solar-system/` が 0 件。

### 手順5. 供給源クラスの区別語を座標原点へ合わせる

**目的.** `Absolute` は「相対でない」としか言っておらず、実際の軸である**座標原点**を名前に出して
いない。`Packed` も「`.epk` 由来」の意で、中身が Chebyshev 係数であることを隠している。
**この時点で挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/absolute-ephemeris.ts` | `AbsoluteEphemeris` → `BarycentricEphemeris`。ファイル名を `barycentric-ephemeris.ts` へ |
| 同 `:27` `icrfToGameEci` の冒頭コメント | **軸だけを付け替え、原点は動かさない**ことを明記(1.2) |
| 同 `:52` `isValidAt` | 引数が simTime であることをコメントで明記(`validStartJdTdb` との時刻軸の違い) |
| `src/physics/packed-absolute-ephemeris.ts` | `PackedAbsoluteEphemeris` → `ChebyshevBarycentricEphemeris`、`loadPackedAbsoluteEphemeris` → `loadChebyshevBarycentricEphemeris`。ファイル名を `chebyshev-barycentric-ephemeris.ts` へ |
| `src/physics/ephemeris-catalog.ts:39` | `loadAbsoluteEphemeris` → `loadBarycentricEphemeris` |
| `src/game/celestial/solar-system/solar-system.ts:4,53` | 型・引数 `absoluteSource` → `barycentricSource` |
| `src/game/celestial/solar-system/` 他9ファイル, `src/physics/celestial-motion.ts:8`, `src/game/stages/stage.ts:26` | import の追従 |
| `src/physics/ephemeris-pack/format.ts:84` | コメント "absolute-ephemeris" の追従 |
| `tests/physics/{absolute-ephemeris,packed-absolute-ephemeris,celestial-motion}.test.ts`, `tests/physics/test-helpers.ts` | import とテストファイル名の追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)が通る。
`grep -rn "Absolute" src/physics/` が 0 件。

### 手順6. `pack` 語を `.epk` の器へ閉じる

**目的.** `.epk` を解いた形(`DecodedEphemerisPack`)と評価器の入力形(`ChebyshevEphemerisPack`)が
どちらも "pack" で、両者を橋渡しするためだけの `CanonicalEvaluatorEphemerisPack` が生えている。
器の語を1層へ寄せ、モジュール名と重複する族語を落とす。**この時点で挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/ephemeris-pack/format.ts:85-90` | `CanonicalEvaluatorEphemerisPack` を解消する。`ChebyshevManifest` の `coordinateFrame` / `timeScale` を必須にできるなら型ごと落とし、できなければ `toEvaluatorEphemerisPack` の戻り値型を `ChebyshevPack` のままにする |
| `src/physics/ephemeris-pack/format.ts:76` | `DecodedEphemerisPack` → `DecodedPack`(src 6) |
| `src/physics/ephemeris-pack/format.ts:50,92` | `EphemerisManifest` → `PackManifest`(src 7)、`EphemerisPackFormatError` → `PackFormatError`(src 48 + tests 2) |
| `src/physics/ephemeris-pack/types.ts:53` | `ChebyshevEphemerisPack` → `ChebyshevPack`(src 9 + tests 3) |
| `src/physics/ephemeris-pack/evaluator.ts`, `src/physics/chebyshev-barycentric-ephemeris.ts`(手順5 で改名済) | 型名の追従 |
| `src/game/save/ephemeris-context.ts:1` | `EPHEMERIS_PACK_VERSION` の import 追従。**定数の値も名前も据置**(セーブ互換のキー) |
| `tests/physics/{chebyshev-ephemeris,ephemeris-pack-format,packed-absolute-ephemeris}.test.ts`, `tools/ephemeris/cli.mjs` | 型名の追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)が通る。
達成目標9 のコマンドが現状と同じ出力を返す。
`grep -n "EPHEMERIS_PACK_VERSION = " src/physics/ephemeris-pack/format.ts` が `1` を返す。

### 手順7.(任意)`src/physics/ephemeris/` へ畳む

**目的.** `barycentric-ephemeris` / `chebyshev-barycentric-ephemeris` / `ephemeris-catalog` /
`ephemeris-profile` / `ephemeris-pack/` が `physics/` 直下に散っている。1ディレクトリへ畳むと、
族語をファイル名から落とせる。**この時点で挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/ephemeris/`(新規) | `barycentric.ts` / `chebyshev-barycentric.ts` / `helio.ts` / `catalog.ts` / `profile.ts` / `pack-format.ts` / `pack-evaluator.ts` / `pack-types.ts` |
| `src/physics/barycentric-ephemeris.ts`(手順5 で改名済) | `barycentric.ts` + `helio.ts` へ**分割**して移動(いま重心層と恒星中心層が1ファイルに同居している。1.5-C) |
| `src/physics/{chebyshev-barycentric-ephemeris,ephemeris-catalog,ephemeris-profile}.ts`, `src/physics/ephemeris-pack/` | 移動 |
| 手順5 で挙げた全 import 元 | パス追従 |
| `tools/ephemeris/cli.mjs:15` | `formatSourcePath` のハードコードされたパスを追従。**typecheck では落ちない** |
| `tests/physics/*.test.ts` | パス追従 |

**アセットのディレクトリ `src/assets/ephemeris/` は据置**(`webpack.config.js:23` の asset ルールで
解決されるため、変えるとビルドは通って実行時に 404 になる)。

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)が通る。
達成目標9 のコマンドが現状と同じ出力を返す(ここが `cli.mjs` のパス追従の唯一の検査)。

### 手順8. `OrbitLine` / `RelativeOrbitLine` の限定を名前へ出す

**目的.** `OrbitLine` は `ellipseSampler` が離心近点角を 0..2π で回す閉曲線しか描けないが、
`OrbitalElements` 自体は双曲線も表せる。`RelativeOrbitLine` に至っては**軌道ではなく2点を結ぶ直線**。
どちらも名前が実装を写しておらず、CR3BP 焼き込み族を扱う `orbit-guide` / `orbit-catalog` と同じ族語で
並んでしまう。**この時点で挙動は変えない。**

| ファイル | 何をするか |
| --- | --- |
| `src/game/lines/orbit-line.ts` | `OrbitLine` → `EllipseLine`、ファイル名を `ellipse-line.ts` へ |
| `src/game/lines/relative-orbit-line.ts` | `RelativeOrbitLine` → `TargetRelativeLine`、ファイル名を `target-relative-line.ts` へ |
| `src/game/celestial/celestial-entity/{celestial-entity,geostationary-overlay}.ts`, `src/game/celestial/celestial-system.ts`, `src/game/celestial/orbit-guide/orbit-guide-lines.ts`, `src/game/dynamic/dynamic-entity/dynamic-entity.ts`, `src/game/game.ts`, `src/game/lines/{entity-line-manager,trajectory-line}.ts`, `src/game/pickable/{map-context-actions,orbit-pickables}.ts`, `src/game/stages/creative-stage.ts` | import と識別子の追従(`OrbitLine` は 12 ファイル・51 行、`RelativeOrbitLine` は 4 行) |
| `src/game/lines/trajectory-line.ts:1`, `src/game/lines/relative-orbit-line.ts:1-6` | コメント「OrbitLine(解析的な楕円)の兄弟」の追従 |

**`OrbitPickKind` の `'orbit-body'` / `'orbit-ship'` / `'orbit-guide'` は据置** — これは線の種類では
なく「何の軌道か」の分類なので、`orbit` の新しい定義に合っている。

**達成条件と検証.** `npm run typecheck` / `npm run test:game` / `npm run test:render` が通る。
`grep -rn "OrbitLine" src/` が 0 件。マップビューで地球周回の楕円・月の公転楕円・静止軌道リング・
航法ターゲット基準の相対線がいずれも従来どおり描かれることを目で確認する。

## 3.3 見積り

改名の総量から出す(いずれも `tests/dist/` を除いた実ファイルでの grep 行数、`c849c988` 時点)。

| 手順 | 触る箇所 | 根拠 |
| --- | --- | --- |
| 1 | 文書 3 節、約 30 行 | CODING-RULE 1ファイル |
| 2 | 削除 4 + 可視性 3 | `orientationModelId` 3、`velocityOf` 1 |
| 3 | 約 20 | `stateOf`/`positionOf` 削除 2 + テスト 8、`EphemerisSeries` 4、周辺型 4 |
| 4 | 約 165 | `precise` 21 + solar-system の `pack` 117 + `packed*` 約 20 + `helioStateAt` の有標化 約 5 + `stage.ts` 2 |
| 5 | 約 50 | `AbsoluteEphemeris` を含む行が全部で 28(内訳: `Packed…` 10・`load…` 8・素の型 10)+ ファイル名と import の追従 約 20 |
| 6 | 約 75 | `EphemerisPackFormatError` 50 + `ChebyshevEphemerisPack` 12 + `EphemerisManifest` 7 + `DecodedEphemerisPack` 6 |
| 7 | 移動 8 + import 追従 約 40 | 手順5 で列挙した import 元と同じ集合 + 1ファイルの分割 |
| 8 | 約 60 | `OrbitLine` 51 + `RelativeOrbitLine` 4 + コメント 3 |

手順4・6 が量の大半で、いずれも機械的な置換。手順7 だけは移動なので、**typecheck が通っても
`cli.mjs` が壊れうる**(下記リスク)。

## 3.4 リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| ワイヤ形式のキー `series` を `segment` へ改名してしまう | 既存の `.epk` 2本が読めなくなる。直すには `EPHEMERIS_PACK_VERSION` の major 上げが要り、それは `EphemerisContext.packFormatVersion` を変えるので**既存セーブが全部 incompatible になる** | 手順3。TS 型だけを改め、`validateManifest` が読むキーには触らないこと。達成目標9・10 |
| `EPHEMERIS_PACK_VERSION` / `EPHEMERIS_PACK_FORMAT` の**値**を触る | 同上。セーブが復元されなくなる | 手順6。名前を変えるとしても値は据置 |
| `tools/ephemeris/cli.mjs:15` が `src/physics/ephemeris-pack/format.ts` をハードコードしている | ディレクトリを畳むと CLI だけが壊れる。**`npm run typecheck` も `npm run test` も通ってしまう** | 手順7。達成目標9 のコマンドが唯一の検査 |
| `series` は HUD のチャートでも使われている | 一括置換で無関係な語まで巻き込む | 手順3。置換範囲を `src/physics/ephemeris-pack/` と `tools/ephemeris/` に限ること |
| `positionOf` は `tests/physics/test-helpers.ts:49` にも**別物**(ECI)として存在し、テスト 8 ファイルから呼ばれている | 一括置換で無関係な関数を壊す | 手順2・3。evaluator 側だけを消すこと |
| `pack` は `webpack` / `package` / `unpackAlignment` の部分文字列 | 単語境界を見ない置換が無関係な箇所を壊す | 手順4・6。`\bpack\b` で当たること |
| `stage.ts` の `pack` と solar-system の `pack` は**型が違う**(`AbsoluteEphemeris` / `HelioEphemeris`) | 両方を機械的に `ephemeris` へ寄せると、境界で別物が同名になる | 手順4。stage 側は `barycentricEphemeris` にする |
| `HelioEphemeris.stateOf` と `ChebyshevEphemeris.stateOf` が同名・同シグネチャで、**座標系も時刻軸も違う** | 取り違えても型が通る | 手順3 で後者を消すまで残る |
| `FrameAnchorSource.stateOf` も `(string, number)` で ECI を返す | ephemeris 族を消しても3つ目が残る | 1.6 のとおり別計画。**この計画の達成目標には数えない** |
| `OrbitLine` は `RelativeOrbitLine` の部分文字列 | 素朴な置換が `RelativeOrbitLine` を `RelativeEllipseLine` にしてしまう | 手順8。長い方から先に置換すること |
| solar-system 9ファイルの `pack` は `new PlanetMotion(...)` の**位置引数**として渡っている | 引数名の変更は無害だが、順序を触ると隣接引数と入れ替わっても型が通りうる | 手順4。引数の順序は触らないこと |
| コメント中の「暦パック」「精密暦」「解析暦」は識別子と語彙がズレたまま(コード内に「暦」約 50 箇所) | 改名後もコメントだけ旧語彙で残ると、次に読む人が対応を取れない | 手順4・5・6。触ったファイルのコメントは同じ commit で揃える |
