# ephemeris / orbit / pack の命名体系 — 再検討(第2版)

前身は `rename-ephemeris.md`(`25614bc3` で削除。`git show 25614bc3^:memos/hedalu244/rename-ephemeris.md`
で読める)。計画を書いたあとに**リネームより大きい構造の再編**を先に通したため、前版の前提の
半分が消えた。ようやく名前だけの問題になったので引き直す。

**目的は前版と同じ** — 同じ値が層をまたぐたびに別名になるのをやめる。**挙動は一切変えない。**

以下の件数・行番号はすべて **`e2da595e`** 時点のコードから実測したもの。**維持しない。**

---

# 第1部 実態調査

## 1.1 問い1a — `ephemeris` は epk 由来のものだけになったのか

**英語の識別子については、ほぼそうなった。例外は2つ。**

`ephemeris` を含む識別子は全 43 種。うち **41 種が `.epk` に由来する経路の上にある** —
`PointEphemeris` / `EphemerisPoints` / `EphemerisPoint` / `EphemerisPointKind` /
`ephemerisPointOf` / `loadEphemerisPoints` / `bindEphemeris` / `EphemerisProfile` /
`EphemerisContext` / `ChebyshevEphemeris` / `PackedAbsoluteEphemeris` / `EphemerisManifest` /
`EphemerisSeries` / `EphemerisPackFormatError` ほか。

**例外1: `ephemerisSeconds` / `EphemerisScale` / `ephemerisSecondsToJulianDate`**
(`src/physics/time/`、計 20 行)。天文の "ephemeris time" の定訳で、供給源とは無関係。
前版の規範7 のとおり例外にする。

**例外2: `PointEphemeris`**(18 行)。**名前は供給源非依存の genus を名乗っているのに、
`stateAt` の戻り値型が `KinematicState<'packed'>` で epk 経路へ縛られている**
(`point-ephemeris.ts:18`)。`refactor_celestial3.md` 2節はこの interface を
「暦パック以外の供給源(例えば TLE/SGP4)が来るとしたらこの interface の実装になる」継ぎ目として
残したと記録しているが、**その実装は `'packed'` を名乗ることになり、記録と型が食い違っている。**
実装は `PackedPointEphemeris` 1つだけ。

**解析暦側には名詞が無い。** 供給源の片側は `analyticStateAt` / `analyticAccelAt` /
`analyticOrbitRelStateAt` / `FrameTag 'analytic'` という**形容詞だけの族**で、対応する型も
モジュールも無い(実体は `KeplerOrbit` / `SatelliteOrbit` / `PlanetSystem` に散っている)。
**`ephemeris` が epk 側へ寄った結果、「暦」という上位概念を英語で名指す語が無くなった。**

## 1.2 日本語の「暦」は寄っていない

| 語 | src+tests+tools | 指しているもの |
| --- | --- | --- |
| 暦パック | 30 | `.epk` の器。ただし**供給源の意で使っている箇所が混ざる** |
| 解析暦 | 19 | 閉じた式の供給源 |
| 高精度暦 | 15 | epk 由来の供給源 |
| 天体暦 | 14 | 供給源一般(genus) |
| 暦データ | 8 | epk 由来の供給源 |
| 暦プロファイル | 5 | 年代 → データの割り当て宣言 |
| 精密暦 | 3 | epk 由来の供給源 |

**日本語の「暦」は genus のまま**(解析暦も高精度暦もどちらも「暦」)で、**英語の `ephemeris` は
species(epk 側)へ寄った。** 同じ2分割を、日本語は精度で、英語は供給源で切っている。
**これが今いちばん効いているズレ。** `SPEC/CELESTIAL.md 2.2` も「高精度暦データ」で、
精度の軸で名付けている。

## 1.3 問い1b — `orbit` の用例

`src/` で `orbit` を含む行は **1342**(うち `src/game/` 1093・`src/physics/` 231・`src/render/` 16。識別子 200 種以上)。意味で分けると6つある。

| # | 意味 | 代表 | 現 CODING-RULE 定義(「解析的に解ける軌道」)に合うか |
| --- | --- | --- | --- |
| A | **要素の束**(形の宣言) | `KeplerOrbit` / `SatelliteOrbit` / `planetOrbit()` / `jplSatelliteOrbit` / `sbdbOrbit` / `PlanetDef.orbit` / `PlanetSystem.orbit` | ○ |
| B | **状態から求めた瞬間の要素** | `OrbitalElements` / `orbitalElementsOf` / `orbitalElementsAround` / `orbitInfo` / `localOrbitPeriod` | ○ |
| C | **軌道面の幾何** | `orbitAxes` / `orbitPlaneBasis` / `orbitNormalAt` / `orbitFrameRotationAt` / `moonOrbitNormal` | ○ |
| D | **CR3BP の焼き込み点列** | `orbit-catalog.ts` / `orbit-guide.ts` / `LagrangeOrbitKind` / `src/assets/orbits/*.json` | **✗ 閉じた式で決まらない**(リサジューだけ Richardson の解析近似) |
| E | **描画物(線)** | `OrbitLine`(19)/ `orbitLine`(34)/ `RelativeOrbitLine`(19)/ `previewOrbitLine`(7)/ `orbitLineColor`(28)/ `LINE_STYLE.enemyOrbit` `.baseOrbit` | **✗** `OrbitLine` は閉じた楕円しか描けない(`OrbitalElements` は双曲線も表す)。`RelativeOrbitLine` は**軌道ですらない2点を結ぶ直線** |
| F | **UI の主題** | `OrbitPanel` / `OrbitChart` / `OrbitAnalysisWindow` / `OrbitReference` / `orbitKey` | ○(主題としての「いまの軌道」) |
| G | **当たり判定の点列** | `OrbitPickable`(13)/ `OrbitPickables`(6)/ `pickNearestOrbit`(3)/ `OrbitCalcMethod`(4)/ `orbitWindows`(8) | **✗ 基準も軌道要素も持たない ECI 点列**。`method: 'predicted'` は積分した軌跡そのもの |

**運動する天体の分類 `OrbitingMotion` / `isOrbiting` / `orbitingAttractorOf` は D 以外のどれでもない
が、「主天体を周回する」の意で定義に合う。**

**前版の規範2(「主天体に対する、繰り返される1本の経路そのもの。どの天体のものかを知らない。
表引きか閉じた式かは軸ではない」)は、いまも A〜D・F をすべて覆い、E だけを弾く。**
分ける2軸(**共通原点か主天体相対か** / **天体 id で引く表か1本の経路か**)も現行コードで裏が取れる
— `KeplerOrbit` にも `OrbitalElements` にも id フィールドは無く、`PointEphemeris` は id で引く表。
**前版の orbit 側の結論はそのまま使える。**

### 基準の有無で引き直すと、当たり判定が落ちる

規範6(2.1)は「繰り返される」を落として**基準となる重力源を持つか**(1天体でも2天体系でもよい)
を基準に据えた。これで判定が変わるのは1族だけ:

**`OrbitPickable` は基準を持たない。** 中身は `key` / `kind` / `method` / `ownerKeys` と
**`points: readonly Vec3[]`(ECI 絶対座標の点列)だけ**(`orbit-pickable.ts:10-20`)。
中心天体も軌道要素も運んでいない**当たり判定用の折れ線**で、`method: 'predicted'` のときは
中身が積分した軌跡そのもの。**`orbit` を名乗る資格が無い。**

**逆に、機体側の楕円は通る。** `OrbitalElements` は `center: CelestialMotion` を
値として持つ(`elements.ts:24`)ので、`strongestAttractor` で選んだ中心天体は**値へ載って運ばれる。**
`hud/orbit/`(86 行)・`OrbitReference`(10 行)・`OrbitLine` はいずれもこの型を経由するため、
**改名は要らない**(`OrbitLine` → `EllipseLine` の理由は楕円限定であることのほうで、主天体では
ない)。

**境界1件: `localOrbitPeriod`**(`attractor.ts:79`、7 行)。`strongestAttractor` を引いて
周期を出し、**天体そのものは捨てる。** ただし名詞として「軌道」を名乗っておらず、
「刻み幅・サンプル間隔を決めるためのもので、『その天体を中心に軌道要素を出す』こととは無関係」
とコメントが既に disclaim している。**据置。**

## 1.4 問い2 — `ephemeris` / `pack` / `precise` の使い分けの実態

**`precise` は英語からほぼ消え、日本語へ移った。**

| どこ | 件数 | 中身 |
| --- | --- | --- |
| `src/` の識別子 | **0** | 暦の意味では絶滅 |
| `tests/physics/celestial-motion.test.ts` | 13 | `preciseParts` / `preciseMoon` / `preciseValidDays` / `mockPrecise` |
| 日本語コメント「精密暦」 | 3 | `nav-target.ts` 2、`orbit-solvers.ts` 1、`stage.ts` 1 |
| 日本語コメント「高精度暦」 | 15 | src 9 / tests 6 |
| `doPreciseReentry` | 6 | **別件**(再突入判定の粒度)。据置 |

**前版が消したかったのは「優劣・程度の語で供給源を区別すること」だが、それは日本語側と
テスト側にそのまま残っている。**

さらに、**精度で名付けるのは事実として危うい。** 遠未来パックは JPL の解ではなく
「DE441 を起点として接続した、独自の長期数値積分」(`ephemeris-profile.ts:31`)で、
`tools/ephemeris/README.md` は「これはモデル誤差であり、はるかに小さいチェビシェフ表現誤差と
混同してはならない」と明記している。**「高精度暦」はモデルの素性ではなく期待を名乗っている。**

**`pack` は6段の粒度すべてに付いている**(1.5 で詳述)。**`ephemeris` は 1.1 のとおり epk 側。**
つまり3語は層で使い分けられておらず、**`pack` が粒度を、`ephemeris` が供給源を、`precise` が
言語を、それぞれ別々にまたいでいる。**

## 1.5 問い3 — `.epk` の語源と、`pack` / `packed` の粒度

### 語源: 独自定義。一般語ではない

- マジックは ASCII `TEPUIEPK`、`format` は `'tepui-ephemeris-pack'`
  (`ephemeris-pack/format.ts:36-37`)。**プロジェクト名が入っている時点で独自。**
- 導入は単一コミット `0e26bcf6`「Implement dual-epoch solar system ephemeris」(2026-08-10)。
  `.epk` / `ephemeris-pack/` / `PackedAbsoluteEphemeris` / `packId` がこの1回で同時に生えた。
- `tools/ephemeris/README.md` も「a deliberately small version 1 ephemeris-pack serializer.
  It is a transport format for precomputed position Chebyshev coefficients」— **転送形式の説明で
  あって、既存規格の実装ではない。**
- **業界の定訳は "pack" ではなく "kernel"。** SPICE の SPK = Spacecraft and Planet Kernel
  (別名 ephemeris kernel)、バイナリは `.bsp`。IAU Division A Commission 4 の WG も
  「天体位置暦の標準形式として SPK を使うこと」を勧告している。`.epk` という綴りは SPK の系譜に
  見えるが、**語としては独自。**

### 「複数入っているから pack」— 束ねを解いた後にも付いている

同梱パックは **11 天体 × 10054 セグメント**を1ファイルへ束ねている。束ねの意味は確かにある。
**問題は、束ねを解いたあとにも同じ語が付いていること。**

判定は規範3(2.1)の**「複数天体の numericEphemeris をまとめているか」**で行う。
「ファイルか」で切ると、復号した器も評価器の入力もファイルから段階的に離れていくため境界が
2値にならない — **束ねている天体の数なら数えられる。**

| 段 | 名前 | 何天体ぶんか | `pack` は妥当か |
| --- | --- | --- | --- |
| 1. ファイル / ワイヤ | `.epk` / `TEPUIEPK` / `EPHEMERIS_PACK_FORMAT` / `packId` / `packFormatVersion` / `modernPackUrl` | 全天体 | **○** |
| 2. 復号した器 | `DecodedEphemerisPack` / `decodeEphemerisPack` / `EphemerisPackFormatError` | 全天体 | **○** |
| 3. 評価器の入力 | `ChebyshevEphemerisPack` / `toEvaluatorEphemerisPack` / `evaluatorPack` | 全天体 | **○** |
| 4. **1天体ぶん** | **`ChebyshevBodyPack`**(`ephemeris-pack/types.ts:44`) | 1天体 | **✗ 束ねていない** |
| 5. **1点ぶんの窓** | **`PackedPointEphemeris`**(`packed-absolute-ephemeris.ts:68`) | 1天体 | **✗** |
| 6. **1サンプル** | **`FrameTag 'packed'`**(型タグ literal 14 行)/ `packedStateAt` / `ownPackedStateAt` / `orbitPointPackedStateAt` / `packedOrbitRelStateAt`(計 27 行) | 1時刻・1天体 | **✗** |

**境界1件: `EphemerisPoints`**(`ReadonlyMap<string, EphemerisPoint>`、19 行)。複数天体ぶんを
まとめているので個数の条件は満たすが、**並んでいるのは genus の `PointEphemeris` であって
numericEphemeris ではない** — 規範3 の `numeric` の限定がここで効いて、**pack ではない。**
ただしこの区別は**いま型では立っていない**(`PointEphemeris.stateAt` の戻り値タグが
`'numeric'` 固定。1.1 例外2 と同じ穴)。

**ユーザーの指摘のとおり。** さらに 5・6 では語形も間違っている — `packed` は過去分詞で
「束ねられた/圧縮された」を意味するが、**その値は束ねを解いた結果**であって、packed ではない。
意図されているのは "of pack origin" で、英語としては別の語が要る。

`PackedAbsoluteEphemeris`(段3相当)だけは器を指しているので `Packed` でも意味は通るが、
`Absolute` のほうが「相対でない」としか言っておらず、実際の軸(太陽系重心原点)を言っていない。

## 1.6 いま無標の口が何を答えているか

前版の規範5 は「**無標の `stateAt` / `stateOf` は ECI**」を唯一の例外として固定する案だった。
**現行コードはその例外を守れていない。**

| 口 | 原点 | 型タグ |
| --- | --- | --- |
| `CelestialMotion.stateAt(pivot, t)` | ECI | `'eci'` |
| `EciTransform.stateAt(t, motion)` | ECI | `'eci'` |
| `CelestialSystem.stateAt` / `CelestialEntity.stateAt` | ECI | `'eci'` |
| `game/dynamic/entity-state-at.ts` `stateAt` | ECI | `'eci'` |
| **`PointEphemeris.stateAt(simTime)`** | **太陽系重心** | `'packed'` |
| **`boundStateAt(ephemeris, t)`** | **太陽系重心** | `'packed'` |
| `FrameAnchorSource.stateOf(id, t)` | ECI | `'eci'` |
| **`ChebyshevEphemeris.stateOf(bodyId, time)`** | **太陽系重心・ICRF 軸** | `'icrf'` |

無標 `.stateAt(` の呼び出しは src で 71 箇所。**改名すべきは違反している2口だけで、
そこは呼び出しが 5 + 2 箇所しかない。**

## 1.7 `FrameTag` は2軸を1つの enum へ潰している

`FrameTag = 'eci' | 'analytic' | 'primaryRel' | 'packed' | 'icrf'`(`kinematic-state.ts:20`)。

| タグ | 原点 | 軸 | 供給源 |
| --- | --- | --- | --- |
| `'eci'` | ECI 原点天体 | ゲーム ECI | 混合(層が揃えている) |
| `'primaryRel'` | 主天体 | ゲーム ECI | 混合 |
| `'analytic'` | 太陽系重心 | ゲーム ECI | 解析 |
| `'packed'` | 太陽系重心 | ゲーム ECI | epk |
| `'icrf'` | 太陽系重心 | ICRF | epk |

**`'analytic'` と `'packed'` は原点も軸も同じで、供給源だけが違う。** これは意図的で、
`toEci<F>` が同じ `F` どうしの差しか許さないことで「片方をパック・片方を解析で引く」取り違えを
型で止めている(`kinematic-state.ts:52-58`)。**軸が混ざっているのは欠陥ではなく、
守りたい不変条件がそこにあるから。** ただし**タグ名が1サンプルに掛かる語である以上、
`'packed'` は 1.5 段6 の問題を型システムの中心へ持ち込んでいる。**

## 1.8 `line` と `trajectory` の現用法

**`line` = 画面に描かれる可視化された線**、**`trajectory` = 物体の軌跡**という基準で
現用法を突き合わせた。

### `line` — 基準は現用法を完全に説明できる

プロジェクト自身が名付けた `*Line` 識別子は、**例外なく描画物**である。

| 群 | 代表 | 描かれるか |
| --- | --- | --- |
| 見た目の宣言 | `LineStyle`(34)/ `LINE_RENDER_ORDER` / `orbitLineStyle`(5)/ `orbitLineColor`(28) | ○ |
| 描画クラス | `OrbitLine`(19)/ `TrajectoryLine`(18)/ `relativeOrbitLine`(15)/ `predictedLine`(17)/ `actualLine`(15)/ `previewOrbitLine`(7) | ○ |
| 集合・管理 | `EntityLineManager`(6)/ `entityLines`(5)/ `orbitGuideLines`(6)/ `zeroVelocityLines`(5)/ `referenceLine`(12、実体は `OrbitLine`) | ○ |
| 生成の下請け | `LineOverlay`(9)/ `svgLinePool`(8)/ `setLinePoints`(5)/ `makeLine`(5)/ `rebuildLines`(5)/ `drawPolylineWithGaps`(5) | ○ |
| 天体グリッド | `poleLine`(9)/ `planeLine`(9)/ `gridLine`(9)(実体は `THREE.Line` / `LineSegments`) | ○ |
| 表示可否 | `lineVisible`(12)/ `showOrbitLine` / `hideOrbitLine` / `lineCountEl`(6) | ○ |

**当たりの残りはすべて「line を含むだけの別語」**で、`pipeline`(78)/ `outline`(44)/
`inline`(27)/ `linear`(14)/ `deadline`(9)/ `baseline`(9)/ `coastline`(7)、
**共線ラグランジュ点の族**(`CollinearPoint` 12・`collinear` 11・`collinearGamma` 10・
`CollinearFrame` 6・`collinearFrame` 5・`collinearBody` 5 = 計 49)、および three.js の API 名
(`LineSegments` 21・`LineBasicMaterial` 28・`lineDistances` 8・`linecap` 7・`lineTo` 5)。
**規範として採ってよい。**

### `trajectory` — 基準は半分しか説明できない

`trajectory` は現状**4つの意味**で使われており、**うち2つが互いに真逆。**

| 意味 | 識別子 | 「物体の軌跡」か |
| --- | --- | --- |
| (a) 軌跡そのもの | `DynamicTrajectory`(22)/ `trajectory-features.ts` / `trajectoryStateAt`(2)/ `trajectorySampleInterval`(6) | **○ そのもの** |
| (b) **orbit の上位概念** | `TrajectoryStyles { ellipse, predicted, actual }`(3)/ `sameTrajectoryStyle`(3) | **○ 提案どおりの階層が既にコードにある** |
| (c) **orbit の兄弟(楕円を除く側)** | `showTrajectoryLine`(29)/ `trajectoryEligible`(5)/ `toggleTrajectoryLine`(5) | **✗ 逆** |
| (d) 描画物・その基準系 | `TrajectoryLine`(18)/ `trajectoryLine`(4)/ `syncTrajectoryLines`(2)/ `TrajectoryFramePanel`(5)/ `trajectoryPanel`(5)/ `trajectoryItem`(6) | **✗ `line` 側の語** |

**(b) と (c) は同じファイル `entity-line-manager.ts` に同居している。**
`TrajectoryStyles` は楕円を**含む**総称(`:31-33`)なのに、`trajectoryEligible` は
`fallbackEllipse = !trajectoryEligible && …`(`:76`)で楕円と**排他**。メニュー文言も
「**予測線・過去線で表示**」(`menu-actions.ts:43`)で、楕円ではない方を指している。

**現 CODING-RULE も (c) 側**(「計画した経路は `path`、積分した軌跡は `trajectory`」)。
つまり **`trajectory` を orbit の上位概念にすると、規約と (c) の 39 行を同時に覆すことになる。**
しかも **`showTrajectoryLine` はセーブのキー**(`save-data.ts:96,131,149`)で凍結されている。

---

# 第2部 決めたこと

## 2.1 規範

**各項の見出しに、CODING-RULE へ記録するかどうかを付す。** 記録は強い固定なので、
**「将来また同じ間違いが起きうるか」**だけを基準に絞った。**記録しない項も、この計画では
同じように適用する** — 是正後に再発の余地が残らないもの、条件として強すぎるものを外してある。

1. 【**記録する**】**`ephemeris`(暦)は上位概念に戻す。** 天体 id と時刻から**並進の位置・速度**を
   答える供給源すべてを指す。自転・重力場・大気・**加速度**を含まない。表引きか閉じた式かは
   問わない。**日本語の「暦」「天体暦」と1対1で対応させる。**
   **ただし `celestial` の内側の総称であって、`dynamic` を覆うほど上位ではない** — 積分の履歴に
   依存する軌跡は天体 id で引ける表ではないので暦ではない。この限定も一緒に記録する。
2. 【**記録する**。暦に限らない一般の対として】**供給源の区別は「表現」で切り、
   `analytic` / `numeric` の対にする。**
   - `analytic` — 閉じた式(ケプラー要素 + 摂動項)。**既存の語をそのまま使う。**
   - `numeric` — 数値積分の結果を区間多項式へ焼いた表。日本語は**数値暦**。
   - **精度・優劣の語(`precise` / 「高精度」/「精密」)で供給源を切らない。** 1.4 のとおり
     遠未来パックのモデル誤差は表現誤差よりはるかに大きく、精度は素性ではない。
   - **`packed` は使わない。** 1サンプルにも1天体にも掛かる語でなければならないため。
3. 【記録しない。是正後は `ephemeris-pack/` 1モジュールへ閉じ、再発の余地が無い】
   **`pack` は「複数天体の numericEphemeris をまとめているもの」を指す。**
   **「ファイル」や「器」を条件にしない** — `.epk` のバイト列から復号した器・評価器の入力へと
   層が下るにつれてファイルからは段階的に離れ、境界が2値にならない。**束ねている天体の数なら
   数えられる。** したがって 1.5 の段1〜3(と `PackEphemeris`)が pack、**1天体ぶん・1点ぶん・
   1サンプルは pack ではない。** `numeric` の限定も条件の一部で、genus の `ephemeris` を並べた
   集合(`EphemerisPoints`)は pack ではない。
4. 【語順の2項は**記録しない**(将来常には当てはまらない)。**無標 = ECI の1項だけ、規範5 の
   例外として記録する** — 前回の天体まわり再編のあとに `PointEphemeris.stateAt` が無標のまま
   太陽系重心を返す形で**実際に再発している**(1.6)】
   **位置・速度を答える口は、その層で2種以上ありうるほうを名前の先頭に出す。**
   - 原点が2種以上ありうる層 → **原点**(`eci*` / `bary*` / `primaryRel*` / `icrf*`)
   - 原点が1つで供給源が2種ある層(太陽系重心層)→ **供給源**(`analytic*` / `numeric*`)。
     原点はクラス冒頭コメントで一度だけ書く。
   - **無標の `stateAt` / `stateOf` / `bodyAt` は ECI を指す。** これを唯一の例外として
     CODING-RULE へ明記し、**新設しない。** 原点そのものは `FrameTag` が型で守っているので、
     これは安全のためではなく読みやすさのための規則。
5. 【**記録する**。暦に限らない一般法則として】**並列なものは両方を有標にする。**
   同じ契約に対する2つ以上の実装・経路・分類を名前で並べるとき、**片方を無標のまま残さない。**
   無標の側は「既定」「本来のもの」という順位を暗に主張してしまい、3つめが増えた時点で壊れる。
   並列でないもの(`PlanetSystem.analyticStateAt` など、対を持たない口)はこの規則の対象外。
6. 【**記録する**。現行の記述が既に嘘なので必須】**`orbit` は「基準となる重力源に対して定まる
   1本の経路」。** 判定基準は**基準の有無だけ。**
   - **基準は1天体とは限らない。** ケプラー軌道の中心天体1体(`OrbitalElements.center` /
     `PlanetSystem.orbit` の保持者)でも、**CR3BP の2天体系とそのラグランジュ点**
     (`CatalogSystemId` = `'earth-moon'` 等 + `CatalogSystem.mu`)でもよい。
     ハロー・リヤプノフ・DRO・リサジューはすべて後者。
   - **「繰り返される」を条件にしない。** 永年変化率を持つ軌道は閉じない(昇交点・近点の歳差と
     公転周期が無理数比になれば厳密に非周期)し、双曲線軌道はそもそも繰り返さない。
     **どちらも軌道である。**
   - **どう求めたかも条件にしない。** 閉じた式で解いたものも、数値積分して焼き込んだ点列も軌道。
   - **基準は値と一緒に運ばれていなければならない。** その場で選び直す手続き
     (`strongestAttractor`)は基準の代わりにならない — 選んだ結果を値へ載せて初めて orbit に
     なる。**載せずに捨てるなら orbit ではない。**
   - **位相の基準(`OrbitPhaseRef`・`*ForSimZero` で畳んだ元期)を持てば絶対時刻でも引けるが、
     それは orbit を ephemeris にしない。**
   - 現行 CODING-RULE の「解析的に解ける軌道」は CR3BP 焼き込み族(1.3 D)を排除してしまうので
     落とす。
7. 【**記録する**。規範1 と同じ節へ】**`ephemerisSeconds` / `EphemerisScale`** は天文の定訳
   "ephemeris time" として例外にする(`OrbitalElements` と同じ扱い)。
8. 【**記録しない・保留**。`trajectory` 側の精緻化が済んでおらず、この計画のスコープ外】
   **`line` は「画面に描かれる可視化された線」。** 1.8 のとおり現用法がこの基準を満たしている。
   **描かれないものに `line` を付けない**(共線 `collinear` などの別語は対象外)。
   **`trajectory` は「物体の軌跡」**とし、`orbit` はその一種と位置づける(積分したか閉じた式かは
   問わない)。**ただしこの位置づけはコードの半分としか合っていない** — (c) の
   `showTrajectoryLine` / `trajectoryEligible` は `trajectory` を orbit の**兄弟**として使い、
   現 CODING-RULE の定義もそちら。**この衝突の解消はこの計画では扱わない**(3.5)。
   したがって**この計画では、`trajectory` を新しく名前へ持ち込まない。**

**覆された場合**: 1 が覆ると手順1・3・4・6 が、2 が覆ると手順3・4・5 が、3 が覆ると手順4・5 が、
6 が覆ると手順1・7 が、8 が覆ると手順6 が変わる。

## 2.2 `numeric` を採る理由と、採らない選択肢

**採る理由。** 天体暦の定訳の対は "analytical ephemeris"(VSOP87・ELP2000 型)と
"numerical ephemeris"(DE440 型)で、日本語も**解析暦 / 数値暦**が対になっている。
コードには既に `analytic` があり、**その対として外部知識がそのまま効く語は `numeric` しかない。**
かつ遠未来パックの中身は文字どおり自前の数値積分の結果なので、由来まで正しく写す。
**英語の識別子と日本語のコメントが1語ずつ対応する**のが最大の利点 — 1.2 のズレはこれで閉じる。

**代案 a — `tabulated`(表引き)。** `KinematicState<'tabulated'>` は「表から引いた状態」としか
読めず、**タグ名としては `'numeric'` より誤読が少ない**(`'numeric'` は「数値でできた状態」と
読めてしまう)。欠点は定訳の対から外れることと、日本語に対応する短い語が無いこと。
**判断が割れたらこちらへ倒してよい** — 規範2 の残りは変わらない。

**代案 b — `chebyshev`。** いま実際に使っている内挿方式そのもの。正確だが、
**表現方式を型タグへ焼き込む**ので、エルミート補間などへ変えると全部書き換えになる。却下。

**代案 c — `ephemeris` を epk 側の species として固定する**(前版の案。`analyticStateAt` /
`ephemerisStateAt` の対)。差分は小さいが、**genus を名指す英語が無いままになり**、日本語の
「解析暦」が英語と矛盾し続ける。1.1 の問題を閉じないので却下。

**代案 d — `pack` を `kernel` へ寄せる**(SPICE の定訳を借りる)。`.epk` の綴りとも噛み合う。
欠点は `packId` / `packFormatVersion` が**セーブの JSON キー**で凍結されていること
(`save-data.ts:231-235`)。器の層だけ語が割れるので却下。**`pack` は器の語として据置。**

**代案 e — `FrameTag` から供給源の軸を抜き、原点だけの軸にする。** タグは概念的に綺麗になるが、
「片方をパック・片方を解析で引く」取り違えを型で止められなくなる(1.7)。**これは名前の問題では
なく設計の問題**なので、この計画では触らない。

## 2.3 適用後の名前

**供給源(1.5 段4〜6 の `pack` / `packed` を落とす)**

| いま | あと | 件数 |
| --- | --- | --- |
| `FrameTag 'packed'` | `'numeric'` | 30(型タグ literal 14 + コメント等) |
| `CelestialMotion.packedStateAt` / `ownPackedStateAt`、`PlanetSystem.ownPackedStateAt` | `numericStateAt` / `ownNumericStateAt` | 22 |
| `OrbitingMotion.orbitPointPackedStateAt` | `orbitPointNumericStateAt` | 3 |
| `OrbitingMotion.packedOrbitRelStateAt` | `numericOrbitRelStateAt`(既存 `analyticOrbitRelStateAt` と語順を揃える) | 2 |
| `PackedPointEphemeris`(private) | `ChebyshevPointEphemeris` | 2 |
| `ChebyshevBodyPack` | `ChebyshevBodySegments` | 6 |
| `PackedAbsoluteEphemeris` | `PackEphemeris`(器を暦として見せるアダプタ。`Absolute` は原点を言っていないので落とす) | 10 |
| `loadPackedAbsoluteEphemeris` | `loadPackEphemeris` | 5 |
| ファイル `packed-absolute-ephemeris.ts` | `pack-ephemeris.ts` | — |
| `EciTransform` の `OriginState.ephemeris` | `.numeric`(隣の `.analytic` と対にする) | 7 |

**器(`ephemeris-pack/` の中。モジュール名と重複する族語を落とす)**

| いま | あと | 件数 |
| --- | --- | --- |
| `EphemerisPackFormatError` | `PackFormatError` | 52 |
| `ChebyshevEphemerisPack` | `ChebyshevPack` | 9 |
| `EphemerisManifest` / `EphemerisManifestBase` | `PackManifest` / `PackManifestBase` | 8 |
| `DecodedEphemerisPack` | `DecodedPack` | 6 |
| `EphemerisSeries`(TS 型) | `PackSegment`(**ワイヤキー `series` は凍結**) | 4 |
| `decodeEphemerisPack` / `encodeEphemerisPack` | `decodePack` / `encodePack` | 24 |
| `buildEphemerisPackData` | `buildPackData` | 10 |
| `toEvaluatorEphemerisPack` | `toChebyshevPack` | 5 |

**原点を名前に出す(1.6 の違反2口)**

| いま | あと | 件数 |
| --- | --- | --- |
| `PointEphemeris.stateAt(simTime)` | `baryStateAt` | 5 |
| `boundStateAt(ephemeris, t)` | `boundBaryStateAt` | 6 |
| `ChebyshevEphemeris.stateOf(bodyId, time)` | `icrfStateAt` | 8 |

**線・当たり判定(1.3 E と、主天体を持たない点列)**

| いま | あと | 件数 |
| --- | --- | --- |
| `OrbitLine` / ファイル `orbit-line.ts` | `EllipseLine` / `ellipse-line.ts` | 19 + 派生 |
| `RelativeOrbitLine` / ファイル `relative-orbit-line.ts` | `TargetRelativeLine` / `target-relative-line.ts` | 19 |
| `showOrbitLine` / `hideOrbitLine` / `syncOrbitLine` / `previewOrbitLine` | `*EllipseLine` | 16 |
| `LINE_STYLE.enemyOrbit` / `.baseOrbit` | `enemyLine` / `baseLine`(`sameTrajectoryStyle` 経由で楕円・予測・過去の3種へ同じ値が渡るので、`Orbit` は嘘) | 2 |
| `OrbitPickable` / `OrbitPickables` / `orbitPickables` / `pickNearestOrbit` / ファイル `orbit-pickable(s).ts` | `LinePickable` / `LinePickables` / `linePickables` / `pickNearestLine` / `line-pickable(s).ts`(**基準を持たない点列**(規範6)で、かつ**集合の定義が「いま描かれていること」**(規範8)。理由は下記) | 29 |
| `OrbitPickKind` / `OrbitCalcMethod` | `LinePickKind` / `LineCalcMethod`。**値の文字列 `'orbit-body'` / `'orbit-ship'` / `'orbit-guide'` / `'analytic'` / `'predicted'` / `'guide'` は据置** — 「何を描いた線か」のラベルであって、値が orbit だと主張していない | 6 |
| `orbitWindows` / `OrbitWindowEntry` / `handleOrbitLineRightClick`(`map-context-actions.ts`) | `lineWindows` / `LineWindowEntry` / `handleLineRightClick` | 13 |

**`Trajectory*Pickable` ではなく `Line*Pickable` を採る理由。** 規範8 の2語で判定すると、
この型は `line` 側にしか落ちない:

1. **集合の定義が「描かれていること」そのもの。** `orbit-pickables.ts:1-3` が
   「**いまフレームにどの軌道線が表示されているか**を集めるだけ」と書いており、
   `refresh` は `cameraSystem.overviewMode` でなければ**空を返す**(`:35`)。
   `points` はすべて描画クラス(`OrbitLine` / `TrajectoryLine` / `RelativeOrbitLine` /
   `OrbitGuideLines`)の `samplePoints()` 由来で、当たり判定は**スクリーン座標**で行う
   (`project` / `radiusPxSq`)。**描かれていないものは存在しない。**
2. **`'orbit-guide'` には物体が乗っていない。** CR3BP 族・リサジュー・地球専用参照軌道は
   焼き込んだ形を天体位置へ載せた**参照曲線**で、誰の軌跡でもない(`orbit-pickables.ts:48-53`)。
3. **`relativeOrbitLine`(2点を結ぶ直線)も候補に入る**(`:76-78`)。軌跡でも軌道でもない。

**3つの `kind` のうち `trajectory` と呼べるのは `'orbit-body'` / `'orbit-ship'` の2つだけ**
なので、`TrajectoryPickable` は覆えない。

**ファイル**

| いま | あと |
| --- | --- |
| `src/physics/planet-orbit.ts` | `PlanetOrbit` 型はもう無い(`grep` 0)。中身は `AU` / `planetOrbit()` / `PlanetAngles` / `planetAngles()` なので `planet-orbit-elements.ts` へ改名するか `kepler-orbit.ts` へ吸収する。**どちらにするかは着手時に決める** |

**据置**

- `PointEphemeris` / `EphemerisPoints` / `EphemerisPoint` / `EphemerisPointKind` /
  `ephemerisPointOf` / `loadEphemerisPoints` / `bindEphemeris` — 規範1 のとおり genus の語なので
  そのままでよい。**ただし `PointEphemeris` の戻り値が `'numeric'` を名乗る件は 1.1 の矛盾が
  残る** — 別の供給源の実装は自分のタグを新設すること、を interface のコメントへ明記して閉じる。
- `EphemerisProfile` / `EphemerisContext` / `ephemeris-catalog` / `ephemerisSeconds`。
- `EPHEMERIS_PACK_MAGIC` / `_FORMAT` / `_VERSION` / `_MINOR_VERSION` / `_HEADER_BYTES` /
  `packId` / `packFormatVersion` / ワイヤキー `series` / `orbitLineColor`(**セーブとワイヤの
  凍結キー**)。
- `CelestialSystem.stateAt` / `CelestialEntity.stateAt` / `CelestialMotion.stateAt` /
  `FrameAnchorSource.stateOf`(規範4 の例外)。
- `hud/orbit/` の全識別子・`OrbitReference` / `orbitInfo` / `OrbitAnalysisWindow` /
  `orbitalElementsOf` — **`OrbitalElements.center` が主天体を値として運ぶので規範6 を通る**(1.3)。
- `localOrbitPeriod`(1.3 の境界1件。名詞として「軌道」を名乗っていない)。
- `doPreciseReentry`(暦とは別件)。
- `orbitFrameRotationAt` / `orbitNormalAt`(答えているのは orbit の量。供給源が暦なだけ)。
- `src/assets/ephemeris/`(webpack の asset ルールで解決される。変えるとビルドは通って実行時 404)。

## 2.4 日本語コメントの語彙

**英語と1語ずつ対応させる。** 触ったファイルは同じ commit で揃える。

| いま | あと |
| --- | --- |
| 高精度暦 / 精密暦 / 暦データ(供給源の意) | **数値暦** |
| 暦パック(**供給源**の意で使っている箇所) | **数値暦** |
| 暦パック(`.epk` の**器**の意) | 据置 |
| 解析暦 | 据置 |
| 天体暦 / 暦 | 据置(genus) |

**`SPEC/CELESTIAL.md 2.2`「高精度暦データ」は触らない。** 仕様は「なぜそちらを優先するか」を
書いていて、精度はその理由として正しい。**コードは「それが何か」を名乗るので軸が違う。**
仕様側の語も揃えたくなったら `/modify-feature` で別に通す。

---

# 第3部 実施

## 3.1 手順

**手順1 を先に置く。** 以降は「規範から外れているものを直す」作業になる。

**手順1(CODING-RULE への規範の記載)は `f36eb597` で実施済み。**

**手順2(器の語を1層へ寄せる)も実施済み。** `.epk` の payload SHA-256 は
`343c7b46…b286505`(10054 segment)で変わっていない。

**手順3(供給源の語を `packed` → `numeric` へ)も実施済み。**
`src/render/thermal-emissive.ts` の `packed` は3つの float を vec3 へ詰めた頂点属性で、
**語の意味として正しいので残した。**

**手順4(原点を名前に出す)も実施済み。** `src/physics/` に残る無標の `stateOf` は
`FrameAnchorSource`(ECI)とその実装の2箇所だけで、これは CODING-RULE 2.1 に書いた例外そのもの。

**手順5(`planet-orbit.ts` の解体)も実施済み。** 計画の2案はどちらも採らず、
`AU` を `astronomical-unit.ts` へ、`planetOrbit()` / `planetAngles()` を `kepler-orbit.ts` へ
分割した(理由は commit を参照)。

**手順6(線・当たり判定の名前)も実施済み。** `MapDisplayToggles.baseOrbit` は
**マップ表示トグルの永続キー**なので据置(一度巻き込んで戻した)。`orbitLineColor` も
セーブのキーなので据置。`tools/perf-probe.mjs` の `setOrbitLineFor` は HUD の行ラベルを
操作する関数でこの型とは無関係なので据置。

**手順7(`src/physics/ephemeris/` へ畳む)も実施済み。**

## 3.2 達成目標

1. `grep -rniE "packed" src/ tests/` が 0 件(`unpack` と `celestial-eci-baseline.test.ts` の定数 `PACKED` を除く。この定数も `NUMERIC` へ揃える)。
2. `grep -rniE "precise" src/ tests/` が `doPreciseReentry` の6行だけ。
3. `grep -rn "高精度暦\|精密暦" src/ tests/` が 0 件。
4. `grep -rnE "\bpack\b|Pack" src/physics/` の当たりが**器の層(`ephemeris-pack/` と
   `pack-ephemeris.ts`)と凍結キーだけ**。
5. CODING-RULE 2.2 に `ephemeris` 節と `analytic` / `numeric` 節があり、2.1 に
   「並列なものは両方を有標にする」と「無標の `stateAt` は ECI」の例外がある。`orbit` の定義が
   CR3BP 焼き込み族・双曲線軌道・位相基準のいずれも排除しない。**`pack` の規則は書かれていない**
   (規範3 は記録しない)。
6. `node tools/ephemeris/cli.mjs verify src/assets/ephemeris/modern-2026-10y.epk` が
   `10054 segment(s)` と payload SHA-256
   `343c7b46a1b77c46b6f986d263666a62c227ac735209ae3b6ce89a751b286505` を報告する
   (**前版が `f816c78c` で実測した値。着手時に再実測して更新すること**)。
7. `tests/physics/celestial-eci-baseline.test.ts` の焼き込んだ期待値が1つも変わらない
   (`git diff` に数値の行が出ない)。
8. 既存セーブが復元できる — `EPHEMERIS_PACK_VERSION` と `.epk` のワイヤ形式、
   `packId` / `packFormatVersion` / `orbitLineColor` が変わっていない。
9. `npm run typecheck` と `npm run test`(全層)が通る。

## 3.3 見積り

| 手順 | 触る箇所 | 根拠 |
| --- | --- | --- |
| 1 | 文書2節新設 + 2箇所改訂・約 55 行 | CODING-RULE 1ファイル(2.1 へ3項、2.2 へ2節、`orbit` の定義差し替え) |
| 2 | 約 120 | `PackFormatError` 52 + `decode/encodePack` 24 + `buildPackData` 10 + `ChebyshevPack` 9 + `PackManifest` 8 + `DecodedPack` 6 + `toChebyshevPack` 5 + `PackSegment` 4 |
| 3 | 約 105 | タグ 30 + `*PackedStateAt` 群 27 + `PackEphemeris` 族 17 + `OriginState` 7 + コメント 約 25 |
| 4 | 約 20 | `stateAt` 5 + `boundStateAt` 6 + `stateOf` 8 |
| 5 | 移動1 + import 追従 約 8 | |
| 6 | 約 140 | `OrbitLine` 19 + 派生 `orbitLine*` 34 + `RelativeOrbitLine` 19 + `show/hide/sync/preview` 16 + `*Pickable*` 族 29 + `OrbitPickKind`/`OrbitCalcMethod` 6 + `orbitWindows` 族 13 + コメント |
| 7 | 移動8 + import 追従 約 40 | |

**手順2・3・6 が量の大半で、いずれも機械的な置換。** 手順7 だけは移動なので、
**typecheck が通っても `cli.mjs` が壊れうる。**

## 3.4 リスクと落とし穴

| リスク | 影響 | どこで露見するか |
| --- | --- | --- |
| ワイヤキー `series` を `segment` へ改名してしまう | 既存の `.epk` 2本が読めなくなる。直すには `EPHEMERIS_PACK_VERSION` の major 上げが要り、それは `EphemerisContext.packFormatVersion` を変えるので**既存セーブが全部 incompatible になる** | 手順2。TS 型だけを改め、`validateManifest` が読むキーには触らない。達成目標6・8 |
| `EPHEMERIS_PACK_VERSION` / `_FORMAT` / `_MAGIC` の**値**を触る | 同上 | 手順2。名前を変えるとしても値は据置 |
| `packId` / `packFormatVersion` / `orbitLineColor` を「pack / orbit の語だから」と巻き込む | **セーブの JSON キー**。旧セーブが復元できなくなる | 手順2・3・6。`save-data.ts:140,231-235` / `ephemeris-context.ts:13-14` / `enemy-save.ts:19` |
| `pack` は `webpack` / `package` / `unpack` / `unpackAlignment` の部分文字列 | 単語境界を見ない置換が無関係な箇所を壊す(`webpack` 12 行、`unpack` 5 行) | 手順2・3。`\bpack\b` で当たること |
| `precise` は `doPreciseReentry` にも入っている | 再突入判定という別ドメインを壊す | 手順3。6行を除外 |
| `series` は HUD のチャートでも使う | 一括置換が無関係な語を巻き込む | 手順2。置換範囲を `src/physics/ephemeris-pack/` と `tools/ephemeris/` に限る |
| `OrbitLine` は `RelativeOrbitLine` の部分文字列 | 素朴な置換が `RelativeEllipseLine` を作る | 手順6。長い方から先に置換 |
| `'analytic'` は3つの別概念に付いている — `FrameTag`(解析暦)/ `GuideShape.kind`(閉じた式で書ける形、`orbit-guide.ts:24,222,233`)/ `OrbitCalcMethod`(解析楕円から描いた、`orbit-pickable.ts:8`) | 一括置換が無関係な2つを壊す | 手順3。**`FrameTag` の側だけ**。他2つは**値**として据置(手順6 で変えるのは `OrbitCalcMethod` の**型名**だけ) |
| `tools/ephemeris/cli.mjs:15` がフォーマット定義のパスをハードコード | ディレクトリを畳むと CLI だけが壊れる。**typecheck も test も通ってしまう** | 手順7。達成目標6 が唯一の検査 |
| コメントの「高精度暦」「暦パック」を識別子と別の commit で直す | 対応が取れないまま残る | 手順3。触ったファイルは同じ commit で揃える |

## 3.5 この計画で触らないもの

| 何 | なぜ外すか |
| --- | --- |
| `FrameTag` から供給源の軸を抜く(2.2 代案 e) | 型で止めている不変条件が消える。**名前ではなく設計の問題** |
| `PointEphemeris` を本当に供給源非依存にする(戻り値タグの型引数化) | 同上。1.1 の矛盾はコメントで明示するに留める |
| **`trajectory` の genus / sibling 衝突**(1.8 (b) 対 (c)) | `TrajectoryStyles` は楕円を含む総称、`showTrajectoryLine` / `trajectoryEligible` は楕円と排他。**どちらへ倒すかは現 CODING-RULE の `trajectory` 定義の変更を伴い、`showTrajectoryLine` はセーブキー**(`save-data.ts:96,131,149`)。独立した計画で |
| `FrameAnchorSource.stateOf` / `FrameAnchors.stateOf` の改名 | ECI を答える口だが影響が `game/` 全域。ephemeris 族の `stateOf` が消えれば衝突の実害は減る |
| `epoch` の3時刻軸(`epochJdTdb` / `epochOffsetSec` / `OrbitPhaseRef.t`) | 時刻軸の語彙は `physics/time/` の `JulianDate<S>` ごと考える話 |
| `SPEC/CELESTIAL.md 2.2`「高精度暦データ」 | 2.4 のとおり軸が違う。揃えるなら `/modify-feature` で別に |
| 天体 id `mars`〜`pluto` の重心/本体の食い違い | **命名ではなく値の問題**(`refactor_celestial3.md` 側で扱う) |
| `src/assets/ephemeris/` / `src/assets/orbits/` | webpack の asset ルールで解決される。変えるとビルドは通って実行時 404 |
