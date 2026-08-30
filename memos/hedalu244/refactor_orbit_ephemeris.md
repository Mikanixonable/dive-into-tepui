# 軌道・暦まわりに残っている構造の問題

**未実施・未検討のものだけを持つ。** 片付いたものは載せない — 現状はコードから調べる。
行番号・件数のスナップショットは **`93482f2a`**。名前の問題は `rename-ephemeris.md`、
座標の持ち主と変換の置き場は `refactor_frame_transform.md` へ分けてある。

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

## 2. 「ECI 軸」が系全体の軸として残っている(**判断: 残す**)

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

## 3. 暦側の層が6段ある(**連星系の確度が出たので判断できる**)

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

1. **論点3 を削る。** 「判断が要らないもの」は他と独立。「判断が要るもの」も連星系の確度が
   出たので、いつでも着手できる。
2. **論点1 の ω の揺れを測る。** 数値が出てから3つの形のどれを採るか決める。
3. **論点2 は着手しない。** 軸は残す。名前だけ `rename-ephemeris.md` 側で直す。
4. キャッシュの持ち主と ECI 変換の置き場は `refactor_frame_transform.md` へ移した。
   ヒットしえないと分かっている集合キャッシュ2本(`gravityCache` / `atmosphereCache`)の
   削除も、変換器の形が決まってからでよい。
5. 名前の問題(`icrfToGameEci` が軸置換なのに ECI と名乗る等)は `rename-ephemeris.md` へ。
   **ただしあの文書は現状と食い違っている** — `HelioEphemeris`・`CelestialMotion.precise`・
   solar-system の引数 `pack` を前提に手順が組まれているが、どれも既に存在しない。
   着手する前に現況へ引き直す必要がある。
