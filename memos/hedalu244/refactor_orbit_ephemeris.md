# 軌道・暦まわりの構造リファクタリング — 残っている問題

計画に書いた手順はすべて実施済み。この文書は**そのあとに残った構造の問題だけ**を持つ。
名前の問題は `rename-ephemeris.md` へ分けてある。以下の行番号・件数のスナップショットは
**`f816c78c`**。

---

## 1. 暦の供給源が 102 の構築点へ配られている

`HelioEphemeris | null` が `planetSystem()` 50 箇所・`new SatelliteMotion` 51 箇所・
`new StarMotion` 1 箇所へ引数として渡り、天体1体ごとが同じ1個の参照を `precise` として持つ。
**ECI 原点天体を消したときと同じ形の歪み** — 系レベルの選択を天体1体が知っている。

ただし `origin` のようにただ消すことはできない。天体ごとの知識を要する利用が2つ残る。

| 誰が | 何のために |
| --- | --- |
| `SatelliteMotion.packedStateAt`(`celestial-motion.ts:444`) | 未収録の衛星を「収録済みの親 + 解析の相対」で補う |
| `OrbitingMotion.packedPrimaryRelStateAt`(`celestial-motion.ts:321`) | 回転基準系と軌道法線を、パックから引いた相対角運動量で組む |

消すなら「窓が1個だけ持ち、要るときに引数で渡す」形になる。触るのは構築点 102 と、この2つを
含む `packed*` 4メソッドのシグネチャ。

### 供給源(暦/解析)を1つの型へ括るか — 括らない

ECI 化が窓へ集まった後も、切り替えのゲートは3種のままで互いに違う。

| 場所 | ゲート | 落ち先 |
| --- | --- | --- |
| `CelestialBodyWindows.bodyAtIndex`(`:102`) | **原点天体と自分の両方**が引けるか | 両方まとめて解析へ揃える |
| `orbitFrameRotationAt` / `orbitNormalAt`(`:221` `:236`) | **自分と主天体**が引けるか(原点天体は無関係) | `keplerOrbitRotation` / `keplerOrbitNormal` |
| `SatelliteMotion.packedStateAt`(`:444`) | **自分が収録されているか** | 切り替えでなく混合(パックの親 + 解析の相対) |

同じ型へ押し込むと、この違いが条件として引数へ溢れる。**括るより、配る先を減らすほうが効く。**

## 2. 時刻軸は3種のまま、型では守られていない

| 軸 | どこ |
| --- | --- |
| J2000 ET 秒(TDB) | `ChebyshevEphemeris.stateAtSeconds` |
| JD_TDB | `AbsoluteEphemeris.barycentricStateOf` |
| simTime | それ以外すべて |

変換点は `PackedAbsoluteEphemeris.barycentricStateOf`(JD_TDB → ET)と
`HelioEphemeris.stateOf` / `isValidAt`(simTime → JD_TDB)の**2箇所に閉じている**ので、構造と
しては細い。問題は、3種とも素の `number` で渡っていて `FrameTag` のような防御が無いこと、
そして `epoch` 1語が `epochJdTdb` / `epochOffsetSec` / `OrbitEpoch.t` の3軸を兼ねていること。

原点にやったのと同じ手(branded type)を時刻軸へも当てるかは**未決**。当てるなら
`physics/time/` の `JulianDate<S>` と地続きになるので、この計画の続きではなく別立て。

## 3. キャッシュの持ち主は5つ残る

`CelestialBodyWindows`(5本)/ `PlanetMotion.helioCache` / `SatelliteMotion.relCache` /
`HelioEphemeris` の恒星1件メモ / `FrameAnchors` の1件メモ。数は減っていないが、**天体1体ごとに
持っていた ECI キャッシュと ECI 原点のキャッシュが窓の1箇所へ集まった**ぶん、持ち主が減った。
残った各所には「1時刻あたり何回引かれるから要るのか」が1文ずつ書いてある。

**一元化はしない。** (天体, 量, t) の複合キーが要り、RK4 の各段 × 天体数というホットパスへ
Map 参照が入る。`TimeRing` は 32 段の数値比較だけでキー生成もハッシュも無い。

## 4. 暦側の層は6段のまま

`.epk` → `DecodedEphemerisPack` → `ChebyshevEphemerisPack` → `ChebyshevEphemeris` →
`PackedAbsoluteEphemeris` → `HelioEphemeris`。段ごとに責務は違う(ワイヤ形式 / 評価 /
時刻軸変換 + SHA 検証 / 原点と軸の付け替え)ので、**構造の問題ではない。**
橋渡しのためだけに生えている `CanonicalEvaluatorEphemerisPack` と、層ごとの語のブレは
`rename-ephemeris.md` の手順6・7 が扱う。

---

## 次の手

構造として残っているのは **1**(暦の配り先)だけで、構築点 102 を触るので、やるなら独立した
計画にする。**2** は時刻軸の branded type という別の話。**3・4 はやらないと決めた。**
それ以外は名前の問題なので `rename-ephemeris.md` へ。
