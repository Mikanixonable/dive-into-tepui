# 軌道・暦まわりに残っている構造の問題

**未実施・未検討のものだけを持つ。** 片付いたものは載せない — 現状はコードから調べる。
行番号・件数のスナップショットは **`752f9338`**。名前の問題は `rename-ephemeris.md` へ分けてある。

---

## 1. 回転基準系が2枝に分かれ、その2枝が食い違っている(**要判断**)

`OrbitingMotion.orbitFrameRotationAt`(`celestial-motion.ts:225`)と
`orbitNormalAt`(`:240`)は、同じ量を2通りに答える。

| 枝 | 条件 | 基底の作り方 |
| --- | --- | --- |
| パック枝(`:227-235`) | 自分と主天体の**両方が直接**暦に収録されていて有効期間内 | **実状態**から `h = r × v`。周期項も全部入る |
| 解析枝(`:236` `:243`) | それ以外 | `keplerOrbitRotation` / `keplerOrbitNormal` = **平均要素**。周期項を含まない |

解析枝が平均要素なのは**意図的で、理由が記録されている**(`satellite-orbit.ts:112-116`):
「回転基準系と軌道法線は二体部分だけから組まれ、周期項を含まない — **混ぜると角速度が
滑らかでなくなるため**で、この結果、衛星の実位置は回転系の x̂ 軸から最大 2.5° ほどずれる
(周期項の振幅の総和)」。**無視された仕様違反ではなく、記録された設計判断である。**

ただしその判断は**パック枝には適用されていない。** 結果として:

- **暦パックの有効期間の端をまたぐと、回転基準系が最大 2.5° 飛ぶ。**
- 同じ天体の同じ量が、時刻によって別の定義で答えられている。

### 選べる形

| | 得る | 失う |
| --- | --- | --- |
| **実状態に統一** | 有効期間の端の飛びが消える。同じ量が1つの定義になる | 解析領域で ω に周期項ぶんの揺れが入る(パック領域には既にある揺れ)。カメラの回転系と軌道計画の描画が動く |
| **平均要素に統一** | 角速度が滑らかになる | パック領域の精度を捨てる。SPEC の「主天体→対象の方向を x̂」からは 2.5° 離れたまま |
| **2枝のまま** | 値が1つも動かない | 食い違いと不連続がそのまま残る |

**決める前に測ること:** 実状態へ統一したときの **ω の揺れの大きさ**(月で数値化する)。
「混ぜると角速度が滑らかでなくなる」がどの程度かは、コメントに書かれているだけで未測定。

**触るときの注意:** `packedPrimaryRelStateAt`(`:325`)は `ownPackedStateAt`(直接収録のみ)を
使っている。`packedStateAt`(衛星の補完込み)へ替えると、**解析枝が実位置基準へ変わって
2.5° 動く。** これを拒む検査が `tests/physics/absolute-ephemeris.test.ts` にある
(「未収録の衛星の軌道法線には親からの補完を混ぜない」)ので、意図して統一するなら
その検査ごと書き換えることになる。

---

## 2. 天体1体ぶんの値を、天体の外側でキャッシュしている(**測定が先**)

**畳み方の問題ではない。** (天体, 量, t) の複合キーを1個の Map へ持つ形は検討の対象ですらない。
問うべきは**どのオブジェクトがキャッシュを持つか**で、狙う形は決まっている:

> **重いのは天体1体の位置と速度を求めることだけで、そこから先 — ECI 化(引き算1回)も、
> 全天体を配列へまとめる操作も — は軽微なはず。だとすれば重い計算を畳むキャッシュは
> 天体1体を表すオブジェクト(`CelestialMotion` / `CelestialEntity`)が1体ぶんずつ持てば足り、
> 外側の4系統は要らない。**

**この「軽微なはず」は未測定。** 外側のキャッシュを消してよいかはそこで決まる。

| # | 持ち主 | 形 | 見立て |
| --- | --- | --- | --- |
| 1 | `PlanetMotion.helioCache`(`celestial-motion.ts:339`)/ `SatelliteMotion.relCache`(`:404`) | `TimeRing` ×2種 | **狙う形そのもの。** 1体ぶんの重い計算を、その1体が持っている。残す |
| 2 | `CelestialBodyWindows.bodyCaches[n]`(`celestial-body-windows.ts:29`) | `TimeRing` ×N | 中身は1体ぶんの ECI 瞬間値。**持ち主が外側なだけ**。論点3 で `CelestialEntity` へ移る |
| 3 | 同 `originCache`(`:30`) | `TimeRing` | 原点天体1体ぶんを「全天体が同じ t で引く」前提で畳んだもの。原点天体自身の #1 が効くなら丸ごと不要 |
| 4 | 同 `allCache` / `gravityCache` / `atmosphereCache`(`:31-33`) | `TimeRing<配列>` ×3 | 畳んでいるのは**配列の同一参照**だけ(中身は `bodyAtIndex` を叩く)。論点3 で持ち主は `CelestialSystem` へ移る。**残すかどうかだけがここの問い** |
| 5 | `FrameAnchors.attractorCache*`(`src/game/frame-anchors.ts:31-32`) | **文字列キー**の1件メモ | 他と全く別物。フレーム番号・id・時刻を繋いだ文字列キーを毎回組んでいる — 毎フレーム走る経路に文字列生成が入っている。TimeRing へ寄せるか、そもそも要るか |

**持ち主の話(論点3)とは独立。** 集合のキャッシュが要ると測定で分かっても、持ち主は集合を
扱う `CelestialSystem` になるだけで、論点3 の分担は動かない。逆も同じ。

**#4 を消すときに壊しうる契約。** 引き手は同一フレーム内で**複数の t** を使う —
`game.ts:521-522` は `simTime` と `displayTime` の2本を引き、`substep-celestial-bodies.ts:22-28`
は各サブステップの中点で引く。ただし**配列の参照同一性に依存した比較は src に無い**(調べた)。
契約は「読み取り専用として扱ってよい」と「同じ t で組み直さない」の2つだけなので、
まとめる操作が実測で軽微なら #4 は消せる。

**やり方。** `TimeRing.stats` は各インスタンスが持っているのに、`CelestialSystem.perfCounts()`
(`celestial-system.ts:204`)は**合算しか出さない**。内訳を一時的に出し、
**ヒットしていない・ヒットが1回しかないキャッシュは消す。** 残りをどう持つかはその後で決める。

---

## 3. ECI 化を天体1体ずつへ割る(**方針決定済み・未実施**)

「ECI 化はここでしか起きない」を**層**の取り決めとして書いたつもりが、**1個のオブジェクトへ
寄せる**形になっている。その結果、同じ集合を表す配列が何本も並び、添字と id で外から
対応付けられている:

- `CelestialBodyWindows`: `motions` / `bodyCaches`(添字で対応)/ `indexById` /
  `gravityIndices` / `atmosphereIndices`(`:24-29`, `:41-47`)
- `CelestialSystem`: `entities` / `motions` / `entitiesById`(`celestial-system.ts:65-68`, `:100-107`)

**同じ集合を表す配列を複数持ち、参照や id で外部が対応付ける形は、所有者の一元化に逆行する。**
暦を天体1体ずつへ割った(`BodyEphemeris`)のと同じことを、ここでもやる。

### 分担(**決定**)

- **ECI 変換は `CelestialEntity` が行う** — 天体1体のことだけを考える層。
- **集合は `CelestialSystem` が集めて返す** — 天体の全集合を扱う層。

**「集合で引かれる口がある」ことは割らない理由にならない。** 集合を要る引き手は、系が個体から
集めて返せば満たせる。引かれ方の内訳(調査結果):

| 口 | 引き手 | 割ったあとの答え手 |
| --- | --- | --- |
| **集合**(`celestialBodiesAt` / `gravityAttractorsAt` / `atmosphereCelestialBodiesAt`) | 積分(`substep-celestial-bodies.ts`)、最強引力天体・大気天体の選択(`strongestAttractor` / `nearestAtmosphereBody` / `orbitingAttractorOf`)、`FrameAnchorSource.bodies`、HUD/マップ/計画の一覧 | `CelestialSystem`(個体から集める) |
| **他の1体**(`bodyAt` / `stateAt`) | `ReferenceFrames.transformAt`(`reference-frames.ts:111`)、`trajectory-line.ts:66`、`nav-target.ts:223-224`、`plan-display.ts:239-243`、`map-camera.ts:446`、`arc-celestial-bodies.ts:110` | 当の個体(系が引き当てる) |
| **自分1体**(`CelestialEntity.stateAt` / `bodyAt` / `stateOf`) | 各個体の `sync`(`sphere-entity` / `point-entity` / `star-entity`)と参照軌道要素 | 個体自身。**ここが2段変換の場所** |

配列窓の呼び出しは src に 41 件(定義 6 件と `CelestialSystem` の素通し 8 件を除く 27 件が実消費)。

### 変換の配り方は C(**決定**)

**ECI 化は「原点天体中心・無回転の参照フレームへの変換」の特殊ケースにすぎない。**
`inertialFrame` は既にある(`reference-frames.ts:32`)ので、**新しいモジュールも新しい変換の
語彙も増やさずに済む** — これが決め手。個体の `sync` は **恒星中心 → ECI → フローティング
原点** の2段変換になるが、後段はすでに `FloatingOrigin` を `CameraSystem.sync` が配っている
(`game.ts:528`)ので、前段も「その時刻の変換を受け取って自分に適用する」同じ形に揃う。

採らなかった案(記録):

- **A. 変換オブジェクトを `CelestialSystem` が作って配る**(`FloatingOrigin` と同型)。配る形は
  C と同じだが、変換の型を新設することになる。C は既存の `FrameTransform` で足りる。
- **B. 原点天体の `CelestialMotion` を各個体が結ぶ**(`bindEphemeris` と同型)。配る物が
  増えない代わりに、供給源の一致を守る責任が全個体へ分散する。

### 着手前に決めること

1. **依存の向きを反転させる。** いまは `ReferenceFrames` が `windows` を持ち、登録天体の ECI
   状態をそこから引いている(`reference-frames.ts:111`)。**天体が恒星中心の値を答え、
   フレーム側が原点を移す**形へ変える。`ReferenceFrames` は既に `motions` を受け取っているので、
   引き先はそちらへ移る。
2. **供給源の一致を誰が守るか。** `bodyAtIndex`(`celestial-body-windows.ts:103-122`)は
   **自分と原点天体を必ず同じ供給源(パック/解析)から引く**ことで成立している。落とすと
   **差がそのまま相対位置の誤りになる**(`kinematic-state.ts` の `toEci`)。ECI フレームの
   変換が「この時刻はどちらの供給源か」を併せて答え、各個体がその札に従って自分の値を引く形なら、
   判断はいまの `originAt`(`:125`)と同じく1箇所に残る。
3. **branded 型と無標 ECI の関係。** `toFrameState` は `FrameKinematicState`(branded)を返すが、
   ECI は無標の `KinematicState` として全層を流れている。ECI を「既定のフレーム」として扱うなら
   この2つの型の関係を決める必要がある — **C の実質的な費用はここ。**

---

## 4. 「ECI 軸」が系全体の軸として残っている(**判断: 残す**)

**原点と軸は別の問題で、原点を恒星中心へ寄せた理由は軸には掛からない。**

- **原点変換は時刻ごとに原点天体の状態を要る。** だから系の内側で採ると評価のたびに地球が要る。
- **軸変換は定数の回転で、どの天体の状態も要らない。** `FrameTag`(`kinematic-state.ts:14`)は
  **原点の札**であって、軸は `icrf` を除く全タグで共通。しかも `icrfToGameEci`
  (`absolute-ephemeris.ts:14`)が写す先は ECI 原点天体とは無関係の固定軸で、**ステージが
  原点天体を差し替えても軸は動かない。**

つまり「ECI 軸が残っている」のは層の漏れではなく、**系全体で1つの固定軸を使っているだけ**。
残す理由は2つ。

1. **軸を系の内外で分けると、変換すべき量が位置・速度から向きと姿勢のすべてへ広がる。**
   原点変換が効くのは `r` / `v` だけだが、軸変換は `Degree2Gravity.pole` / `tesseral.longAxis` /
   `Atmosphere.pole` / `BodyOrientation.axis` / `spinRotationAt().q` / `orbitNormalAt()` /
   `orbitFrameRotationAt().q` にも効く。境界が一気に広くなる。
2. **IAU の自転要素は ICRF 赤道を基準に定義されている** — `body-orientation.ts` の
   `spinPhaseRef` は `ECI_POLE` との昇交点を位相原点に取る。軸を移しても、この定数方向は残る。

### 「黄道軸へ揃え直す」は別の問い(**未判断・優先度低**)

層の話ではなく**固定軸の選び直し**としてなら意味がある。系全体を黄道基準にすると:

- **得る:** `satelliteState`(`satellite-orbit.ts:136` `:183`)の `eciToEcl` → 補正 → `eclToEci` の
  往復が消える。`keplerOrbitState` の `ECLIPTIC_BASIS` が恒等になる。暦パック側の回転は
  復号時に焼き込めるので、評価あたりの費用は増えない。
- **失う:** 地球の自転軸が `(0,1,0)` そのものでなくなる — `pole: { kind: 'eciPole' }` の意味と、
  SPEC/CELESTIAL.md 3節・4.2節・8節が明記する「ECI の Y 軸そのもの」が崩れる。星野・天球
  グリッド・大気の共回転・静止軌道まで前提を引き直すことになる。

**往復が実測で効いていない限り、見合わない。** 残っているのは実質**名前の問題**で、実体は
「ゲーム固定の慣性軸(春分点方向 X・北極 Y)」。名前は `rename-ephemeris.md` 側で直す。

---

## 5. 暦側の層が6段ある(**連星系の確度が出たので判断できる**)

| 段 | src での生成点 | src で実際に消費される口 |
| --- | --- | --- |
| `.epk` バイト列 | — | `decodeEphemerisPack` |
| `DecodedEphemerisPack` | `decodeEphemerisPack` 1箇所 | `manifest` / `payload` / `payloadBytes` |
| `CanonicalEvaluatorEphemerisPack` | `toEvaluatorEphemerisPack` 1箇所 | `ChebyshevEphemeris` の入力のみ |
| `ChebyshevEphemeris` | `packed-absolute-ephemeris.ts:19` 1箇所 | **`stateOf()` と `pack` の2つだけ** |
| `AbsoluteEphemeris`(interface) | — | 実装は `PackedAbsoluteEphemeris` と、テストヘルパ `testEphemerisSource` の2つ |
| `BodyEphemeris`(interface) | `bodyEphemerisOf` | 天体1体ごと(収録済みの 11 体) |

**段の数は減っていない。** 最後の段の性質が変わっただけで(系で1個の共有物 →
天体1体ぶんの値)、深さはそのまま。

### 連星系の確度(**判断済み**)

**連星系の実現性はかなり低い。やるとしても、閉じた式で近似できる範囲 — 連星の対を1つの
ケプラー軌道として扱う2連星と、階層に分けられる3連星 — に限る。位置を数値積分でしか
求められない非周期の多体系は、`DynamicSystem` 側の予測シミュレーションと構造上相性が悪いので
実現性を捨てている。**(SPEC/CELESTIAL.md の未確定の案も同じ内容へ更新済み。)

**したがって連星系は解析暦(`KeplerOrbit`)側の拡張であって、`AbsoluteEphemeris` の2つめの
本番実装にはならない。** 暦パック層に「数値積分の実装が来るかもしれない」という理由の
拡張性を残す必要はない。

### 判断が要らないもの(先に削れる)

- **`ChebyshevEphemeris.velocityOf`(`evaluator.ts:283`)は完全に死んでいる**(定義以外の参照が
  `src` にも `tests` にも 0 件)。
- `segmentOf`(`:253`)は public だが、呼んでいるのは同じクラスの `evaluate` だけ。
- `evaluate` / `positionOf` は**テストからしか呼ばれていない**
  (`tests/physics/chebyshev-ephemeris.test.ts`)。テストが本当にその口を必要としているかを
  見てから決める。

### 判断が要るもの(判断材料は揃った)

- **`AbsoluteEphemeris` interface を畳むか。** 本番の実装は1つに確定した。残る2つめは
  テストヘルパ(`tests/physics/test-helpers.ts:109`)だけなので、**差し替え口として要るのは
  テストの都合だけ**。畳むならテスト側の組み方も変わる。
- **`PackedAbsoluteEphemeris` を `ChebyshevEphemeris` へ畳むか。** 残っている実質は
  「構築時の rebase + `bodyEphemerisOf` の切り出し」だけ。復号と SHA 検証は別の関数。

---

## 次の手

1. **論点3 を先にやる。** 分担も配り方も決まっているので、測定を待たずに進められる。
   着手前に決めることが3点(依存の反転・供給源の一致・branded 型)。
2. **論点2 を測る。** 論点3 とは独立。持ち主が決まったあと、各キャッシュが要るかを内訳から
   判断する。
3. **論点1 の ω の揺れを測る。** 数値が出てから3つの形のどれを採るか決める。
4. **論点5 を削る。** 「判断が要らないもの」は論点1・2 と独立。「判断が要るもの」も
   連星系の確度が出たので、いつでも着手できる。
5. **論点4 は着手しない。** 軸は残す。名前だけ `rename-ephemeris.md` 側で直す。
6. 名前の問題(`icrfToGameEci` が軸置換なのに ECI と名乗る等)は `rename-ephemeris.md` へ。
   **ただしあの文書は現状と食い違っている** — `HelioEphemeris`・`CelestialMotion.precise`・
   solar-system の引数 `pack` を前提に手順が組まれているが、どれも既に存在しない。
   着手する前に現況へ引き直す必要がある。
