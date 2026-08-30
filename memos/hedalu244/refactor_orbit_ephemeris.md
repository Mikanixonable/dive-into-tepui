# 軌道・暦まわりに残っている構造の問題

**未実施・未検討のものだけを持つ。** 片付いたものは載せない — 現状はコードから調べる。
行番号・件数のスナップショットは **`778974f0`**。名前の問題は `rename-ephemeris.md` へ分けてある。

---

## 1. 回転基準系が2枝に分かれ、その2枝が食い違っている(**要判断**)

`OrbitingMotion.orbitFrameRotationAt`(`celestial-motion.ts:231`)と
`orbitNormalAt`(`:246`)は、同じ量を2通りに答える。

| 枝 | 条件 | 基底の作り方 |
| --- | --- | --- |
| パック枝(`:233-241`) | 自分と主天体の**両方が直接**暦に収録されていて有効期間内 | **実状態**から `h = r × v`。周期項も全部入る |
| 解析枝(`:242` `:249`) | それ以外 | `keplerOrbitRotation` / `keplerOrbitNormal` = **平均要素**。周期項を含まない |

解析枝が平均要素なのは**意図的で、理由が記録されている**(`satellite-orbit.ts:114-116`):
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

**触るときの注意:** `packedPrimaryRelStateAt`(`:333`)は `ownPackedStateAt`(直接収録のみ)を
使っている。`packedStateAt`(衛星の補完込み)へ替えると、**解析枝が実位置基準へ変わって
2.5° 動く。** これを拒む検査が `tests/physics/absolute-ephemeris.test.ts` にある
(「未収録の衛星の軌道法線には親からの補完を混ぜない」)ので、意図して統一するなら
その検査ごと書き換えることになる。

---

## 2. キャッシュの持ち主が5系統ある(**測定が先**)

「全部を1個の Map へ畳むか」は問うべき問いではない((天体, 量, t) の複合キーが要り、RK4 の
各段 × 天体数というホットパスへ Map 参照が入る)。**答えるべきは1本ずつの是非で、これは未評価。**

| # | 持ち主 | 形 | 疑うべき点 |
| --- | --- | --- | --- |
| 1 | `CelestialBodyWindows` の `allCache` / `gravityCache` / `atmosphereCache`(`:31-33`) | `TimeRing<配列>` ×3 | 3本とも中身は `bodyAtIndex` を叩くだけで、**畳んでいるのは配列の同一参照**。1フレームで3窓が**別々の t** で引かれるのでなければ、t キー1本 + 3スロットで足りる |
| 2 | 同 `bodyCaches[n]`(`:29`)/ `originCache`(`:30`) | `TimeRing` ×(N+1) | 実質がある(天体1体の ECI 値と原点)。ただし `originCache` は全天体が同じ t で引く前提の畳みなので、**1件メモで足りる可能性** |
| 3 | `PlanetMotion.helioCache`(`celestial-motion.ts:346`) | `TimeRing` | 窓が ECI 値を天体ごとに畳んだ**後**でも1時刻あたり複数回引かれるか。引き手は 窓の解析経路・`helioAccelAt`・衛星の `helioStateAt`・系の重心補正 |
| 4 | `SatelliteMotion.relCache`(`:411`) | `TimeRing` | コメントは「1時刻あたり4回前後」と書くが、**その数字が ECI キャッシュを窓へ集める前のものかどうか**が未確認 |
| 5 | `FrameAnchors.attractorCache*`(`game/frame-anchors.ts:31-32`) | **文字列キー**の1件メモ | 他の4つと全く別物。フレーム番号・id・時刻を繋いだ文字列キーを**毎回組んでいる** — 毎フレーム走る経路に文字列生成が入っている。TimeRing へ寄せるか、そもそも要るか |

**やり方。** `TimeRing.stats` は既に各インスタンスが持っているのに、
`CelestialSystem.perfCounts()`(`celestial-system.ts:208`)は**合算しか出さない**。内訳を
一時的に出し、hits/misses が「1時刻あたり n 回引かれる」を裏付けているかを1本ずつ見る。
**ヒットしていない・ヒットが1回しかないキャッシュは消す。** 残りをどう持つかはその後で決める。

---

## 3. 暦側の層が6段ある(**連星系の確度次第**)

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

### 判断が要らないもの(先に削れる)

- **`ChebyshevEphemeris.velocityOf` は完全に死んでいる**(定義以外の参照が `src` にも `tests`
  にも 0 件)。
- `segmentOf` は public だが、呼んでいるのは同じクラスの `evaluate` だけ。
- `evaluate` / `positionOf` は**テストからしか呼ばれていない**(それぞれ1件)。テストが本当に
  その口を必要としているかを見てから決める。

### 判断が要るもの

- **`AbsoluteEphemeris` interface を畳むか。** 本番の実装は1つだが、**テストヘルパが2つめの
  実装になっている**(`tests/physics/test-helpers.ts:109`)ので、テストの差し替え口としては
  生きている。畳むならテスト側の組み方も変わる。
- **`PackedAbsoluteEphemeris` を `ChebyshevEphemeris` へ畳むか。** 残っている実質は
  「構築時の rebase + `bodyEphemerisOf` の切り出し」だけ。ただし復号と SHA 検証は別の関数。
- **どちらも `DEVELOP/SPEC/CELESTIAL.md` の未確定の案「恒星が2つ以上、相互に公転しあう連星系 —
  天体の位置を数値積分で求める」の確度次第。** これは `AbsoluteEphemeris` の2つめの**本番**
  実装になりうる。**ユーザーへ問う必要がある。**

---

## 次の手

1. **論点2 を測る。** キャッシュの内訳を一時的に出し、効いていないものを消す。判断を待たずに
   進められて、結果が論点3 の判断材料にもなる。
2. **論点1 の ω の揺れを測る。** 数値が出てから3つの形のどれを採るか決める。
3. **論点3 の「判断が要らないもの」を削る。** 論点1・2 と独立。
4. **論点3 の残りは、連星系の確度をユーザーへ問うてから。**
5. 名前の問題(`icrfToGameEci` が軸置換なのに ECI と名乗る等)は `rename-ephemeris.md` へ。
   **ただしあの文書は現状と食い違っている** — `HelioEphemeris`・`CelestialMotion.precise`・
   solar-system の引数 `pack` を前提に手順が組まれているが、どれも既に存在しない。
   着手する前に現況へ引き直す必要がある。
