# 軌道・暦まわりに残っている構造の問題

**未実施・未検討のものだけを持つ。** 片付いたものは載せない — 現状はコードから調べる。
行番号・件数のスナップショットは **`93482f2a`**。名前の問題は `rename-ephemeris.md` へ分けてある。

---

## 1. 回転基準系が2枝に分かれ、その2枝が食い違っている(**要判断**)

`OrbitingMotion.orbitFrameRotationAt`(`celestial-motion.ts:293`)と
`orbitNormalAt`(`:308`)は、同じ量を2通りに答える。

| 枝 | 条件 | 基底の作り方 |
| --- | --- | --- |
| パック枝(`:295-303`) | 自分と主天体の**両方が直接**暦に収録されていて有効期間内 | **実状態**から `h = r × v`。周期項も全部入る |
| 解析枝(`:304` `:311`) | それ以外 | `keplerOrbitRotation` / `keplerOrbitNormal` = **平均要素**。周期項を含まない |

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

**触るときの注意:** `packedPrimaryRelStateAt`(`:393`)は `ownPackedStateAt`(直接収録のみ)を
使っている。`packedStateAt`(衛星の補完込み)へ替えると、**解析枝が実位置基準へ変わって
2.5° 動く。** これを拒む検査が `tests/physics/absolute-ephemeris.test.ts` にある
(「未収録の衛星の軌道法線には親からの補完を混ぜない」)ので、意図して統一するなら
その検査ごと書き換えることになる。

---

## 2. ヒットしえないキャッシュが2本ある(**持ち主は確定済み・測定済み**)

持ち主は天体1体を表すオブジェクトと、集合を扱うオブジェクトへ割り終えた。残る問いは
**それぞれが実際にヒットしているか**で、これは測った(下表)。

| # | 持ち主 | 形 | 中身 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `CelestialMotion.eciOriginCache`(`celestial-motion.ts:123`) | `TimeRing` ×N(埋まるのは原点の1本だけ) | 原点天体の暦パック値・解析値・加速度 | **必須。** 落とすと原点の暦パック評価が天体数ぶん走る |
| 2 | `PlanetMotion.helioCache`(`:407`) | `TimeRing` ×惑星数 | 惑星本体の日心状態(重心補正込み) | **残す** |
| 3 | `SatelliteMotion.relCache`(`:472`) | `TimeRing` ×衛星数 | 衛星の惑星相対状態(周期項の総和) | **残す** |
| 4 | `CelestialMotion.eciCache`(`:122`) | `TimeRing` ×N | 天体1体の ECI 瞬間値 | **要判断**(下記) |
| 5 | `CelestialSystem.allCache`(`celestial-system.ts:84`) | `TimeRing<配列>` | 全登録天体の配列 | **残す** |
| 6 | `CelestialSystem.gravityCache`(`:85`) | `TimeRing<配列>` | 重力源天体の配列 | **消す。構造上ヒットしえない** |
| 7 | `CelestialSystem.atmosphereCache`(`:86`) | `TimeRing<配列>` | 大気を持つ天体の配列 | **消す。同上** |
| 8 | `FrameAnchors.attractorCache*`(`src/game/frame-anchors.ts:31-32`) | **文字列キー**の1件メモ | 基準 id の主天体 | 他と全く別物。フレーム番号・id・時刻を繋いだ文字列キーを毎回組んでいる — 毎フレーム走る経路に文字列生成が入っている。TimeRing へ寄せるか、そもそも要るか |

### #6・#7 がヒットしえない理由(構造)

- `gravityAttractorsAt` を引くのは **`substep-celestial-bodies.ts:23` の1箇所だけ**で、しかも
  サブステップの**中点**という毎回違う t。呼び手が1つで t が毎回違えば、キャッシュは
  ミスしか出さない。
- `atmosphereCelestialBodiesAt` は2箇所(`simulator.ts:178` が `simTime`、
  `substep-celestial-bodies.ts:27` が中点)だが、**t が体系的に食い違う**ので同じく当たらない。
- 対して `celestialBodiesAt` は src に 32 箇所あり、その多くが同じフレームの同じ
  `simTime` / `displayTime` を引く。#5 が効いているのはこれが理由。

### 実測(太陽系98体、合成した引かれ方)

| キャッシュ | 積分パス(サブステップ4本) | 表示パス(集合2時刻 + 全個体の sync + 集合の再問い合わせ6回) |
| --- | --- | --- |
| `eciOriginCache` | hits 636 / misses 8(**98.8%**) | hits 194 / misses 2(**99.0%**) |
| `helioCache` | hits 1004 / misses 284(78.0%) | hits 298 / misses 94(76.0%) |
| `relCache` | hits 704 / misses 400(63.8%) | hits 196 / misses 100(66.2%) |
| `eciCache` | hits 4 / misses 644(**0.6%**) | hits 98 / misses 196(33.3%) |
| `allCache` | 0 / 4(0%) | 6 / 2(75.0%) |
| `gravityCache` | 0 / 4(0%) | 引かれない |
| `atmosphereCache` | 0 / 4(0%) | 引かれない |

**これは合成した引かれ方であって、実フレームの記録ではない。** 積分パスは
「中点で重力源と大気、開始時刻で表面」を4サブステップ、表示パスは「集合を simTime と
displayTime で引き、全個体が displayTime で自分の値を引き、集合をさらに6回引く」を模した。
`perfCounts()` の内訳を実機で出せば裏が取れる。

### #4(`eciCache`)の判断が要る理由

**中身は「引き算1回」ではない。** `celestialBodyAt`(`celestial-motion.ts:207`)は ECI 化に
加えて `degree2At(t)` と `atmosphereAt(t)` を解決し、その2つがそれぞれ `orientationAt(t)`
(IAU 極の三角関数、あるいはカッシーニ軸と軌道法線)を引く — **1体あたり2回の姿勢評価**が
この中に入っている。積分パスでヒット率 0.6% なのは、上の集合キャッシュが同じ t を
弾いているからで、消せば姿勢評価が積分パスで増える経路が生まれる。

消すなら測る対象は「同じ t で `celestialBodyAt` が2回以上引かれる経路がどれだけあるか」。
表示パスの 33% はその実例(集合が組んだあと、各個体の sync が同じ displayTime で引き直す)。

---

## 3. 「ECI 軸」が系全体の軸として残っている(**判断: 残す**)

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

## 4. 暦側の層が6段ある(**連星系の確度が出たので判断できる**)

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
  テストヘルパ(`tests/physics/test-helpers.ts:105`)だけなので、**差し替え口として要るのは
  テストの都合だけ**。畳むならテスト側の組み方も変わる。
- **`PackedAbsoluteEphemeris` を `ChebyshevEphemeris` へ畳むか。** 残っている実質は
  「構築時の rebase + `bodyEphemerisOf` の切り出し」だけ。復号と SHA 検証は別の関数。

---

## 次の手

1. **論点2 の #6・#7 を消す。** 測り終えた — 構造上ヒットしえないと分かっている。#4 は
   姿勢評価の重複を測ってから決める。
2. **論点4 を削る。** 「判断が要らないもの」は他と独立。「判断が要るもの」も連星系の確度が
   出たので、いつでも着手できる。
3. **論点1 の ω の揺れを測る。** 数値が出てから3つの形のどれを採るか決める。
4. **論点3 は着手しない。** 軸は残す。名前だけ `rename-ephemeris.md` 側で直す。
5. 名前の問題(`icrfToGameEci` が軸置換なのに ECI と名乗る等)は `rename-ephemeris.md` へ。
   **ただしあの文書は現状と食い違っている** — `HelioEphemeris`・`CelestialMotion.precise`・
   solar-system の引数 `pack` を前提に手順が組まれているが、どれも既に存在しない。
   着手する前に現況へ引き直す必要がある。
