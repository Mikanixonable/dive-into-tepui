# ephemeris / orbit の命名体系を規範化する

## 目的

`src/**/*.ts` に `ephemeris` を含む行が 214 行あるが、**語が層ごとに違うものを指していて、同じ値が
境界をまたぐたびに別名になっている。** `HelioEphemeris` は保持側で `precise`、渡す側で
`pack` と呼ばれ、`.epk` の器も、それを読む口も、どちらも `pack` と呼ばれている。

CODING-RULE 2.2 は `celestial` / `dynamic` を対として固定し `ephemeris` をその軸から外したが、
**`ephemeris` 自身の意味はまだ規範化されていない。** この計画で `ephemeris` / `pack` / `orbit` の
使い分けを規範として確定し、そこから外れた識別子を直す。**挙動は一切変えない。**

## 決めたこと

覆されたときにどの手順が変わるかを各項に書く。

### 前提: 何が何を答えているか

天体1体の運動は `CelestialMotion`(`src/physics/celestial-motion.ts`)が唯一の窓口で、並進(位置・
速度・加速度)・自転姿勢・2次重力場・大気をすべて答える。**供給源が2系統あるのは並進だけで、自転には
1系統しかない。**

| 問い | 供給源 | 実体 |
| --- | --- | --- |
| 並進(表引き) | `.epk` の Chebyshev 位置係数 | `HelioEphemeris` |
| 並進(閉じた式) | ケプラー要素 + 摂動項 | `PlanetOrbit` / `SatelliteOrbit` |
| 自転 | IAU 極モデル / カッシーニ / ECI 極 | `PoleModel`(`physics/celestial-body-def.ts`) |

`.epk` は位置係数しか収録しないので **pack は自転を答えない。** 有効期間の内外によらず自転は常に
解析で、同期回転衛星(カッシーニ)の自転位相は `keplerOrbit` から出るため、pack が引ける期間でも
解析軌道を経由する。`EphemerisProfile.orientationModelId` は自転モデルを指す宣言だが、`src/` からも
`tests/` からも `tools/` からも読まれていない。

**したがって `ephemeris` が答えるのは並進だけで、`CelestialMotion` の下請けの一方でしかない。**
`celestial` と同じ次元の分類ではない(CODING-RULE 2.2 で確定済み)。

### 前提: `ephemeris` と `orbit` を分ける軸

**「表引きか閉じた式か」は軸ではない。** 両方向に反例がある — `AbsoluteEphemeris` は
`tests/physics/absolute-ephemeris.test.ts:10-17` で閉じた式として実装されており
(`absolute-ephemeris.ts:2` の冒頭コメントも解析解を実装の選択肢に数えている)、逆に
`orbit-catalog.ts` の CR3BP 族は焼き込んだ点列である。表現の選択は族の境界ではない。

**軸1 — 絶対時刻を引数に取るか。** `ephemeris` は写像で、絶対時刻を渡すとその瞬間の状態が返る
(`barycentricStateOf(id, jdTdb)` / `stateOf(id, simTime)`)。`orbit` は経路そのもの(形)で、
絶対時刻を引数に取らない — `KeplerOrbit` は t=0 の要素と変化率の束、`OrbitalElements` は真近点角
で引き、`CatalogFamily.points` の各点が持つのは周期を1とする位相 `tFrac` だけ。絶対時刻から状態を
出すのは `keplerOrbitState(orbit, t)` という関数であって `orbit` 自身ではない。

**軸2 — 誰に対する位置か。** `orbit` は主天体相対で、主天体が変われば別の軌道になる。
`ephemeris` は系で共通の1原点(恒星 = 系の階層の根)に対する位置で、天体ごとに原点は
変わらない。`OrbitingMotion.packedPrimaryRelStateAt`(`celestial-motion.ts:429-438`)が主天体相対を
得るために **ephemeris を2回引いて差を取っている**のは、ephemeris が主天体相対を直接は答えられない
ため。

**この2軸で、両者は直交する。** 同じ ECI 位置を共通原点から引いても主天体相対を積み上げても出せる
ので、`CelestialMotion.eciStateAt` が両方を持って切り替えられる。`orbitFrameRotationAt` /
`orbitNormalAt` が ephemeris を2回引いて軌道面法線を組むのも同じ理由で、答えているのは orbit の量、
供給源が ephemeris というだけなので名前は `orbit` のままでよい。

### 規範(推奨案)

1. **`ephemeris`** — **絶対時刻を引数に、系で共通の1つの原点に対する天体の並進状態(位置・
   速度)を答える写像**、およびその素性。自転・重力場・大気を含まない。天体を id 文字列として
   しか知らない。
2. **`orbit`** — **主天体に対する、繰り返される経路そのもの。** 絶対時刻を引数に取らず、形と、
   その上の位相(真近点角・弧長・周期比)で表す。現行 CODING-RULE の「解析的に解ける軌道」は
   実装に合っていない。
3. **`pack`** — `.epk` という**器**だけを指す。表を読む口を `pack` と呼ばない。
4. **語順** — 供給源の型は `<区別語>Ephemeris`、素性側は `Ephemeris<区別語>`。区別語には
   「**どの座標原点か・どの表現か**」という軸そのものを置き、`precise` / `absolute` のような
   優劣・程度の語を置かない。
5. **`ephemerisSeconds` / `EphemerisScale`**(`physics/time/`)は天文の定訳 "ephemeris time" として
   例外にする。`OrbitalElements` と同じ扱いで、CODING-RULE に明記して迷いを断つ。

覆された場合: 1 が覆ると手順1・4・5・6 が、2 が覆ると手順1・8 が、3 が覆ると手順4・6 が変わる。

### 適用後の名前

| いま | あと | 区別しているもの |
| --- | --- | --- |
| `AbsoluteEphemeris` | `BarycentricEphemeris` | 座標原点 = 太陽系重心、時刻軸 = JD_TDB |
| `PackedAbsoluteEphemeris` | `ChebyshevBarycentricEphemeris` | 上の実装が Chebyshev 係数であること |
| ~~`OriginCenteredEphemeris`~~ | `HelioEphemeris`(改名済み) | 座標原点 = 恒星(系の根)、時刻軸 = simTime |
| `loadAbsoluteEphemeris` | `loadBarycentricEphemeris` | |
| `loadPackedAbsoluteEphemeris` | `loadChebyshevBarycentricEphemeris` | |
| `CelestialMotion.precise` | `.ephemeris` | 供給源そのもの |
| solar-system 9ファイルの引数 `pack` | `ephemeris` | 同上 |
| `CelestialMotion.packedStateAt` | `ephemerisStateAt` | 解析経路 `helioStateAt` との対 |
| `OrbitingMotion.packedPrimaryRelStateAt` | `ephemerisPrimaryRelStateAt` | 同上 |
| `EphemerisSeries`(TS 型) | `PackSegment` | evaluator 側 `ChebyshevSegment` と同一概念 |
| `ChebyshevEphemeris.stateOf` | 削除(`stateAtSeconds` へ一本化) | 時刻軸が秒であることを名前で示す |
| `CanonicalEvaluatorEphemerisPack` | 解消 | |
| `OrbitLine` | `EllipseLine` | 閉じた楕円しか描けない |
| `RelativeOrbitLine` | `TargetRelativeLine` | 軌道ではなく2点を結ぶ直線 |

### 他の選択肢

**代案A — `ephemeris` を捨て、表引き側を `table` / `tabulated` にする。** 天文学の ephemeris は
解析暦も含む「位置表」全般を指すので、コード内の日本語コメントの「暦」(解析暦・精密暦の両方を
含む)とのズレが残り続ける。`PositionTable` などへ寄せれば、`CelestialMotion` 全体を「暦」と呼ぶ
日本語と衝突しなくなる。**欠点**: 定訳を捨てるので外部知識が効かず、`.epk`(= ephemeris pack)・
`EphemerisProfile`・`EphemerisContext`・セーブの JSON キー `ephemerisContext` まで巻き込む。
セーブのキー変更は互換判定に触るので範囲が跳ね上がる。

**代案B — CODING-RULE の当初定義(「時刻から天体の位置を答える仕組み」)を守り、
`CelestialMotion` を `BodyEphemeris` へ改名する。** 語の定義とコードは一致するが、
`CelestialMotion` は自転・2次重力場・大気まで持つので `ephemeris` では狭すぎる。かつ
`celestial` / `dynamic` の対から天体運動の中心クラスが抜ける。**却下を推奨。**

**代案C — `Barycentric` の代わりに `Ssb`(Solar System Barycenter)を使う。** `SsbEphemeris` は
短く原点が一意。`Barycentric` は「どの重心か」を言っていないぶん曖昧だが、この系では太陽系重心
しかない。略語1語の識別子は「略語は1単語として扱う」規則には収まるが、読み手を選ぶ。

**代案D — `OrbitLine` は `KeplerLine`。** CR3BP 焼き込み族(`orbit-guide`)との対比は出るが、
`elements.ts` は双曲線も表せる = **ケプラー軌道でも `OrbitLine` では描けないものがある**ので、
実装の限定を正確に写すのは `Ellipse` のほう。`KeplerLine` を採るなら「二体解析解の線」の意で、
楕円限定であることは別途コメントで担保する。

**代案E — 語順を族語前置で全部揃える**(`EphemerisBarycentric` / `EphemerisOriginCentered`)。
`EphemerisProfile` / `EphemerisContext` と語順が揃い、grep で族が一箇所に集まる。**欠点**: 英語の
語順として不自然で、`HelioEphemeris`(34 箇所)を含む既存の読みやすさを落とす。

## 達成目標

全手順の実施後、以下がすべて満たされること。

1. `grep -rn "precise" src/` が 0 件。
2. `grep -rnE "\bpack\b" src/game/celestial/solar-system/` が 0 件(`.epk` の器を指す用例はこの層に
   無い)。
3. `stateOf` という名のメソッドが、座標系も時刻軸も違うまま2つ存在しない。
4. `grep -rn "orientationModelId" src/ tests/ tools/` が 0 件。
5. `grep -rn "Absolute" src/physics/` が 0 件(`AbsoluteEphemeris` 族の消滅)。
6. CODING-RULE 2.2 に `ephemeris` の節があり、`orbit` の定義が CR3BP 焼き込み族を排除しない。
7. `npm run typecheck` と `npm run test`(全層)が通る。
8. `node tools/ephemeris/cli.mjs verify src/assets/ephemeris/modern-2026-10y.epk` が
   `10054 segment(s)` と payload SHA-256 `343c7b46…` を報告する(現状と同一)。
9. 既存セーブが復元できる — `EPHEMERIS_PACK_VERSION` と `.epk` のワイヤ形式が変わっていない。

## 手順

### 手順1. CODING-RULE 2.2 へ `ephemeris` の節を足し、`orbit` の定義を実装へ合わせる

**目的.** 規範を先に置く。以降の手順は、この節から外れているものを直す作業になる。
**この時点でコードは変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/CODING-RULE.md` 「`orbit` / `path` / `trajectory`」節 | `orbit` の定義を「主天体に対する、繰り返される経路そのもの。絶対時刻を引数に取らない」へ改める。表引きか閉じた式かは軸ではないことを1文で添える |
| 同(新設) | 「`ephemeris` / `pack`」節を足す。上の「規範(推奨案)」1・3・4・5 と、`ephemeris` / `orbit` を分ける2軸(絶対時刻を引数に取るか / 共通原点か主天体相対か)をそのまま規則として書く |

**達成条件と検証.** `grep -n "ephemeris" DEVELOP/CODING-RULE.md` が新設節を返す。
`grep -n "解析的に解ける軌道" DEVELOP/CODING-RULE.md` が 0 件。

### 手順2. 死んだ宣言を落とす

**目的.** 使われていない宣言が残っていると、命名の是非を判断するとき「これは何のためにあるのか」を
毎回調べ直すことになる。改名の前に対象を減らす。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/ephemeris-profile.ts:13,28,38` | `orientationModelId` を落とす。自転は `PoleModel` が全部持っており、この宣言はどこからも読まれていない |
| `src/physics/ephemeris-pack/evaluator.ts:293` | `velocityOf` を落とす(呼び出し元なし) |
| `src/physics/ephemeris-pack/evaluator.ts:257` | `segmentOf` を private にする(`evaluate` からしか呼ばれない) |
| `src/physics/ephemeris-pack/evaluator.ts:226-227` | 公開フィールド `manifest` / `pack` の外部読み手が無いことを確認し、private へ落とす |
| `tests/physics/ephemeris-profile.test.ts` | `orientationModelId` を見ている表明があれば落とす |

**達成条件と検証.** `npm run typecheck` と `npm run test:physics` が通る。
`grep -rn "orientationModelId\|velocityOf" src/ tests/ tools/` が 0 件。

### 手順3. 同義語を1語へ寄せる

**目的.** 同じものに2つの名前がある箇所を潰す。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/ephemeris-pack/evaluator.ts:279-287` | `stateOf` を削除し `stateAtSeconds` へ一本化する。`positionOf`(289)は `stateAtSeconds` 経由へ書き換えるか、テスト専用なら落とす |
| `tests/physics/chebyshev-ephemeris.test.ts:60,76,77,78,93,95,97` | `eph.stateOf` を `eph.stateAtSeconds` へ |
| `src/physics/ephemeris-pack/format.ts:41` | TS 型 `EphemerisSeries` を `PackSegment` へ改名。**ワイヤ形式のキー `series` は v1 の凍結された綴りとして残す** |
| `src/physics/ephemeris-pack/format.ts:66` | `EphemerisManifestBase` → `PackManifestBase`(`Omit<…, 'series'>` のキー名は据置) |
| `src/physics/ephemeris-pack/format.ts:1-31` の冒頭コメント | ワイヤのキーが `series`、コード上の語が `segment` であることを1文で明記する |
| `tests/physics/ephemeris-pack-format.test.ts` | 型名の追従 |
| `tools/ephemeris/cli.mjs` | 型名を参照していれば追従(ワイヤのキーは触らない) |

**達成条件と検証.** `npm run typecheck` / `npm run test:physics` が通る。
`grep -rn "EphemerisSeries" src/ tests/ tools/` が 0 件。
`grep -n "stateOf" src/physics/ephemeris-pack/evaluator.ts` が 0 件。
達成目標8のコマンドが現状と同じ出力を返す。

### 手順4. 供給源の呼び名を `ephemeris` へ統一する

**目的.** `HelioEphemeris` 型の値が、保持側で `precise`、渡す側で `pack` と呼ばれている。
1つの名前に揃え、`pack` を `.epk` の器へ返す。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/celestial-motion.ts` の `precise` 全 21 箇所 | フィールド・引数 `precise` → `ephemeris`。`packedStateAt` → `ephemerisStateAt`、`packedPrimaryRelStateAt` → `ephemerisPrimaryRelStateAt`。コメントの「暦パック」も供給源を指す箇所は「天体暦」へ |
| `src/game/celestial/solar-system/solar-system.ts:53-58` | 引数 `pack` → `ephemeris` |
| `src/game/celestial/solar-system/{inner-planets,earth-system,mars-system,jupiter-system,saturn-system,uranus-system,neptune-system,dwarf-planets,small-bodies}.ts` | 引数 `pack` → `ephemeris`(9ファイル、計 117 箇所) |
| `src/game/stages/stage.ts:110` | ローカル `pack` → `ephemeris` |
| `tests/physics/celestial-motion.test.ts`, `tests/physics/test-helpers.ts` | 引数名を使っていれば追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test:physics` / `npm run test:game` が通る。
`grep -rn "precise" src/` が 0 件、`grep -rnE "\bpack\b" src/game/` が 0 件。

### 手順5. 供給源クラスの区別語を軸へ合わせる

**目的.** `Absolute` は「相対でない」としか言っておらず、実際の軸である**座標原点**を名前に出して
いない。`Packed` も「`.epk` 由来」の意で、中身が Chebyshev 係数であることを隠している。
**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/absolute-ephemeris.ts` | `AbsoluteEphemeris` → `BarycentricEphemeris`。ファイル名を `barycentric-ephemeris.ts` へ |
| `src/physics/packed-absolute-ephemeris.ts` | `PackedAbsoluteEphemeris` → `ChebyshevBarycentricEphemeris`、`loadPackedAbsoluteEphemeris` → `loadChebyshevBarycentricEphemeris`。ファイル名を `chebyshev-barycentric-ephemeris.ts` へ |
| `src/physics/ephemeris-catalog.ts:38` | `loadAbsoluteEphemeris` → `loadBarycentricEphemeris` |
| `src/game/celestial/solar-system/solar-system.ts:4,53` | 型・引数 `absoluteSource` の追従 |
| `src/game/celestial/solar-system/` 他9ファイル | import の追従 |
| `src/physics/celestial-motion.ts:8` | import の追従 |
| `src/game/stages/stage.ts:26` | import の追従 |
| `src/physics/ephemeris-pack/format.ts:84` | コメント "absolute-ephemeris" の追従 |
| `tests/physics/{absolute-ephemeris,packed-absolute-ephemeris,celestial-motion}.test.ts`, `tests/physics/test-helpers.ts` | import とテストファイル名の追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)が通る。
`grep -rn "Absolute" src/physics/` が 0 件。

### 手順6. `pack` 語を `.epk` の器へ閉じる

**目的.** `.epk` を解いた形(`DecodedEphemerisPack`)と評価器の入力形(`ChebyshevEphemerisPack`)が
どちらも "pack" で、両者を橋渡しするためだけの `CanonicalEvaluatorEphemerisPack` が生えている。
器の語を1層へ寄せる。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/ephemeris-pack/format.ts:85-91` | `CanonicalEvaluatorEphemerisPack` を解消する。`ChebyshevManifest` の `coordinateFrame` / `timeScale` を必須にできるなら型ごと落とし、できなければ `toEvaluatorEphemerisPack` の戻り値型を `ChebyshevPack` のままにする |
| `src/physics/ephemeris-pack/format.ts:76` | `DecodedEphemerisPack` → `DecodedPack`(モジュール名が既に `ephemeris-pack` なので族語が重複している) |
| `src/physics/ephemeris-pack/format.ts:50,92` | `EphemerisManifest` → `PackManifest`、`EphemerisPackFormatError` → `PackFormatError`(50 箇所) |
| `src/physics/ephemeris-pack/types.ts:53` | `ChebyshevEphemerisPack` → `ChebyshevPack` |
| `src/physics/ephemeris-pack/evaluator.ts` | 型名の追従 |
| `src/physics/chebyshev-barycentric-ephemeris.ts`(手順5 で改名済) | 型名の追従 |
| `src/game/save/ephemeris-context.ts:1` | `EPHEMERIS_PACK_VERSION` の import 追従。**定数の値も名前も据置**(セーブ互換のキー) |
| `tests/physics/{chebyshev-ephemeris,ephemeris-pack-format,packed-absolute-ephemeris}.test.ts` | 型名の追従 |
| `tools/ephemeris/cli.mjs` | 型名の追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)が通る。
達成目標8のコマンドが現状と同じ出力を返す。
`grep -n "EPHEMERIS_PACK_VERSION = " src/physics/ephemeris-pack/format.ts` が `1` を返す。

### 手順7.(任意)`src/physics/ephemeris/` へ畳む

**目的.** `absolute-ephemeris` / `packed-absolute-ephemeris` / `ephemeris-catalog` /
`ephemeris-profile` / `ephemeris-pack/` が `physics/` 直下に散っている。1ディレクトリへ畳むと、
族語をファイル名から落とせる。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/ephemeris/`(新規) | `barycentric.ts` / `chebyshev-barycentric.ts` / `origin-centered.ts` / `catalog.ts` / `profile.ts` / `pack-format.ts` / `pack-evaluator.ts` / `pack-types.ts` |
| `src/physics/absolute-ephemeris.ts`(手順5 で改名済) | `barycentric.ts` + `origin-centered.ts` へ分割して移動(いま2層が1ファイルに同居している) |
| `src/physics/{chebyshev-barycentric-ephemeris,ephemeris-catalog,ephemeris-profile}.ts`, `src/physics/ephemeris-pack/` | 移動 |
| 手順5 で挙げた全 import 元 | パス追従 |
| `tools/ephemeris/cli.mjs:15` | `formatSourcePath` のハードコードされたパスを追従。**typecheck では落ちない** |
| `tests/physics/*.test.ts` | パス追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)が通る。
達成目標8のコマンドが現状と同じ出力を返す(ここが `cli.mjs` のパス追従の唯一の検査)。

### 手順8. `OrbitLine` の限定を名前へ出す

**目的.** `OrbitLine` は `ellipseSampler` が離心近点角を 0..2π で回す閉曲線しか描けないが、
`OrbitalElements` 自体は双曲線も表せる。名前が実装の限定を写していないため、CR3BP 焼き込み族を扱う
`orbit-guide` / `orbit-catalog` と同じ族語で並んでしまう。**この時点で挙動は変えない。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/lines/orbit-line.ts` | `OrbitLine` → `EllipseLine`、ファイル名を `ellipse-line.ts` へ |
| `src/game/lines/relative-orbit-line.ts` | `RelativeOrbitLine` → `TargetRelativeLine`、ファイル名を `target-relative-line.ts` へ |
| `src/game/celestial/celestial-entity/celestial-entity.ts:8`, `.../geostationary-overlay.ts:13`, `src/game/celestial/celestial-system.ts:9`, `src/game/celestial/orbit-guide/orbit-guide-lines.ts`, `src/game/dynamic/dynamic-entity/dynamic-entity.ts:20-21`, `src/game/game.ts`, `src/game/lines/entity-line-manager.ts`, `src/game/lines/trajectory-line.ts`, `src/game/pickable/map-context-actions.ts`, `src/game/pickable/orbit-pickables.ts`, `src/game/stages/creative-stage.ts` | import と識別子の追従(`OrbitLine` 19 箇所、`RelativeOrbitLine` 4 箇所) |
| `src/game/lines/trajectory-line.ts:1` | コメント「OrbitLine(解析的な楕円)の兄弟」の追従 |

**`OrbitPickKind` の `'orbit-body'` / `'orbit-ship'` / `'orbit-guide'` は据置** — これは線の種類では
なく「何の軌道か」の分類なので、`orbit` の新しい定義に合っている。

**達成条件と検証.** `npm run typecheck` / `npm run test:game` / `npm run test:render` が通る。
`grep -rn "OrbitLine" src/` が 0 件。マップビューで地球周回の楕円・月の公転楕円・静止軌道リング・
航法ターゲット基準の相対線がいずれも従来どおり描かれることを目で確認する。

## 見積り

改名の総量から出す(いずれも `tests/dist/` を除いた実ファイルでの出現数)。

| 手順 | 触る箇所 | 根拠 |
| --- | --- | --- |
| 1 | 文書 2 節、約 20 行 | CODING-RULE 1ファイル |
| 2 | 削除 5 + 追従 | `orientationModelId` 3、`velocityOf` 1、可視性 3 |
| 3 | 約 20 | `stateOf` 削除 1 + テスト 7、`EphemerisSeries` 4、周辺型 4 |
| 4 | 約 150 | `precise` 27 + solar-system の `pack` 117 + `stage.ts` 2 |
| 5 | 約 60 | `AbsoluteEphemeris` 15 + `PackedAbsoluteEphemeris` 7 + `load*` 8 + import 追従 約 30 |
| 6 | 約 90 | `EphemerisPackFormatError` 50 + `ChebyshevEphemerisPack` 12 + `DecodedEphemerisPack` 6 + 周辺 約 20 |
| 7 | 移動 7 + import 追従 約 40 | 手順5 で列挙した import 元と同じ集合 |
| 8 | 約 25 | `OrbitLine` 19 + `RelativeOrbitLine` 4 + コメント 2 |

手順4・6 が量の大半で、いずれも機械的な置換。手順7 だけは移動なので、**typecheck が通っても
`cli.mjs` が壊れうる**(下記リスク)。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| ワイヤ形式のキー `series` を `segment` へ改名してしまう | 既存の `.epk` 2本が読めなくなる。直すには `EPHEMERIS_PACK_VERSION` の major 上げが要り、それは `EphemerisContext.packFormatVersion` を変えるので**既存セーブが全部 incompatible になる** | 手順3。TS 型だけを改め、`validateManifest` が読むキーには触れないこと。達成目標8・9 |
| `EPHEMERIS_PACK_VERSION` / `EPHEMERIS_PACK_FORMAT` の**値**を触る | 同上。セーブが復元されなくなる | 手順6。名前を変えるとしても値は据置 |
| `tools/ephemeris/cli.mjs:15` が `src/physics/ephemeris-pack/format.ts` をハードコードしている | ディレクトリを畳むと CLI だけが壊れる。**`npm run typecheck` も `npm run test` も通ってしまう** | 手順7。達成目標8のコマンドが唯一の検査 |
| `series` は HUD のチャートでも使われている(`src/game/hud/orbit/orbit-analysis-data.ts` ほか3ファイル、計 37 箇所) | 一括置換で無関係な語まで巻き込む | 手順3。置換範囲を `src/physics/ephemeris-pack/` と `tools/ephemeris/` に限ること |
| `positionOf` は `tests/physics/test-helpers.ts:49` にも別物として存在する | 一括置換で無関係な関数を壊す | 手順2・3 |
| `pack` は `webpack` / `package` / `unpackAlignment` の部分文字列 | 単語境界を見ない置換が無関係な箇所を壊す | 手順4・6。`\bpack\b` で当たること |
| `HelioEphemeris.stateOf` と `ChebyshevEphemeris.stateOf` が同名・同シグネチャで、**座標系も時刻軸も違う** | 取り違えても型が通る。手順3 で片方を消すまで残る | 手順3 |
| `src/assets/ephemeris/*.epk` は `webpack.config.js:23` の asset ルールで解決される | アセットのディレクトリ名を変えるとビルドは通るが実行時に 404 | 手順7。ディレクトリ名は据置を推奨 |
| solar-system 9ファイルの `pack` は `new PlanetMotion(...)` の位置引数として渡っている | 引数名の変更は無害だが、順序を触ると隣接引数と入れ替わっても型が通りうる | 手順4。引数の順序は触らないこと |
| コメント中の「暦パック」「精密暦」「解析暦」は識別子と語彙がズレたまま(コード内に「暦」50 箇所) | 改名後もコメントだけ旧語彙で残ると、次に読む人が対応を取れない | 手順4・5・6。触ったファイルのコメントは同じ commit で揃える |
