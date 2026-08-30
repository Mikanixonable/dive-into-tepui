# 天体の座標とキャッシュを揃える — 調査と計画

`refactor_frame_transform.md` の残件。**あちらで「決定済み」としたものも含めて引き直した。**
以下はすべて `50f4fe22` 時点のコードから取ったスナップショットであり、正本ではない。
食い違ったらコードを信じる。数値は実際に走らせて測ったもの(2.5節に手順)。

---

## 0. 結論

1. **現在の実装は物理的に正しい。** 重心不変条件 `Σμ_i·R_i = μ_sys·R_b` は、衛星を持つ
   9系すべてで**丸め誤差(≤2e-3 m)まで**成り立つ。恒星まわりも ≤2.5e-7 m。衛星の要素は
   **相対軌道**として正しく解釈されている(2.5節で判定)。例外は μ=0 の惑星2体だけ(6.3節)。
2. **「相対 → 重心相対」の順序は反転できない。** 二体ならスカラー倍だが、**多衛星系では
   スカラー倍ではない**(2.2節)。衛星 k の系重心相対は他の全衛星の位置に依存するので、
   要素を読み込み時に付け替えることはできず、**相対の評価は必ず先に来る。**
3. **反転できるのは「何を保存し、何を公開するか」だけ。** そしてそれには十分な価値がある —
   不変条件が構成上の恒等式ではなく**検査できる性質**になり、暦パックの規約とも噛み合う。
   これは挙動不変の変更で、物理は1ミリも変わらない(4節)。
4. **`PlanetSystem.starRelStateAt` は名前どおり主星相対である。** 疑いは外れ(3節)。
5. **実バグが1件ある。** 暦パックは**1つの pack の中で天体ごとに収録している点が違う** —
   太陽・水星・金星・地球・月は**本体**、火星〜冥王星は**惑星系重心**。JPL の SPK に
   本体のセグメントが無いためで、manifest にはどちらかを表す欄が無く、消費側は id を
   突き合わせるだけ。**切り替えが無いことがバグ。** 冥王星で 2,128 km(6.1節)。
   3 を実施すると、これは構造的に起きなくなる。
6. **多衛星系の重心不変条件を確かめるテストが無い。** 既存のテストは地球-月(衛星1体)だけで、
   Σ の重みが問題になる場合を覆っていない(7節・手順1)。

---

## 1. いま何が、どの原点で、どこに畳まれているか

| 持ち主 | 畳んでいる値 | **原点** | 1つの t あたりの被参照数 | 1回の評価の重さ |
| --- | --- | --- | --- | --- |
| `StarMotion.analyticCache` | 恒星の状態 | 太陽系重心 | ≈ 2N | **24 系ぶんのケプラー解** |
| `PlanetSystem.starRelCache` | 系重心の二体解 | **主星** | 1〜2 | ケプラー解 1 個 |
| (`PlanetSystem.analyticStateAt`) | 系重心の状態 | 太陽系重心 | 1 | 加算1回(畳んでいない) |
| `PlanetMotion.analyticCache` | 惑星本体の状態 | 太陽系重心 | 2·M+2(M = 衛星数) | **M 個の衛星状態** |
| `SatelliteMotion.relCache` | 衛星の状態 | **惑星本体** | 4 | 周期項の総和 |
| (`SatelliteMotion.analyticStateAt`) | 衛星の状態 | 太陽系重心 | 1(`EciTransform` だけ) | 加算1回(畳んでいない) |
| `EciTransform.originCache` | 原点天体の一式 | 太陽系重心 ×2 | 全天体 | パック評価 + 上記 |
| `CelestialEntity.eciCache` | ECI 瞬間値 | ECI 原点天体 | 表示経路で多数 | 減算 + 姿勢・大気 |

規模: **天体 98 / 惑星系 47(うち μ>0 が 24、衛星を持つのが 11)/ 衛星 50。**

**「高頻度 × 構築が重い」という基準では、畳む場所の選び方そのものは正しい。**
畳んでいない2つはどちらも被参照 1・評価は加算1回なので、畳む理由が無い
(`SatelliteMotion` の絶対位置を畳んでも当たらないことは `refactor_frame_transform.md`
4節で実測済み、hit 0%)。**問題は「どの座標で畳んでいるか」だけ** — 5つのうち2つが
動く天体を原点に持っている。

### 位置が組み上がる順

```
SatelliteMotion.analyticStateAt(t)                    ← 衛星の太陽系重心位置。畳んでいない
├─ PlanetMotion.analyticStateAt ………………… analyticCache(太陽系重心)
│  └─ PlanetMotion.computeAnalyticStateAt             ← 系重心 − Σ w_k·(衛星の惑星本体相対)
│     ├─ PlanetSystem.analyticStateAt                 ← 系重心の太陽系重心位置。畳んでいない
│     │  ├─ StarMotion.analyticStateAt ………… analyticCache(太陽系重心)
│     │  │  └─ StarMotion.computeAnalyticStateAt      ← −Σ w_i·(系重心の主星相対)
│     │  │     └─ PlanetSystem.starRelStateAt … starRelCache(**主星相対**)  …… μ>0 の 24 系
│     │  └─ PlanetSystem.starRelStateAt ………… 同上(μ>0 なら hit、μ=0 ならここで解く)
│     └─ SatelliteMotion.relStateAt ……………… relCache(**惑星本体相対**)  …… 全衛星ぶん
└─ SatelliteMotion.relStateAt ………………………… 同上(hit)
```

ケプラー解は1つの t あたり **47 回**(24 が恒星の畳み込みで、23 が各系の自前)。

`src` `tests` `tools` の全走査で、`analyticStateAt` / `relStateAt` / `starRelStateAt` /
`packedStateAt` を呼ぶのは `celestial-motion.ts` `planet-system.ts` `eci-transform.ts`
の3モジュールだけ。**相対量は既に外へ漏れていない**(公開修飾子が付いているだけ)。

---

## 2. 物理 — 相対と重心相対は何が違うか

### 2.0 現在の実装が実際に計算していること

記号: `M` = 惑星本体の GM、`m_k` = 衛星 k の GM、`μ_tot = M + Σ_j m_j`(系の全質量)。
コードは質量ではなく GM を持つが、以下の `w_k` は比なので G が約分され、**無次元**になる。

```
r_k = 衛星 k の要素だけから解いた惑星本体相対位置    ← 他の衛星に依存しない
R_b = 系重心の太陽系重心位置                        ← 日心ケプラー解 + 恒星の位置
R_p = R_b − Σ_k w_k·r_k        w_k = m_k/μ_tot     ← Σ はここだけ。1系につき1回
R_k = R_p + r_k                                     ← 衛星はこれだけ
```

**衛星ごとに Σ を取ってはいない。** `SatelliteMotion.relStateAt`
(`celestial-motion.ts:469`)が呼ぶのは `satelliteState(自分の要素, system.anglesAt(t), t)`
だけで、`anglesAt` は系重心の日心軌道から取る平均角(月の太陽摂動項の引数に使うためだけ)。
**他の衛星の位置も、惑星本体の位置も参照しない。**

**循環しない理由は依存が一方向だから** — `r_k` → `R_p` → `R_k`。他の衛星の影響は
`R_p` を経由してだけ入る(カロンが冥王星を振り回せばニクスの絶対位置も動く。
ニクスの相対軌道の原点である冥王星本体が動くため)。

**運動量保存則の成立:**

```
M·R_p + Σ_k m_k·R_k = (M + Σ m_k)·R_p + Σ m_k·r_k
                     = μ_tot·(R_b − Σ (m_k/μ_tot)·r_k) + Σ m_k·r_k
                     = μ_tot·R_b − Σ m_k·r_k + Σ m_k·r_k  =  μ_tot·R_b   ∎
```

`w_k` の分母が `μ_tot` であることが `μ_tot·w_k = m_k` を成り立たせ、それが最後の相殺を生む。
**分母を `M` や `M+m_k` にすると相殺が崩れる。**

冥王星系(t=0)の実測:

| 衛星 | m_k [m³/s²] | w_k | \|r_k\| | \|w_k·r_k\| |
| --- | --- | --- | --- | --- |
| charon | 1.0610e11 | 1.085862e-1 | 19,600.0 km | 2,128.290 km |
| styx | 0 | 0 | 42,120.2 km | 0 |
| nix | 1.5000e6 | 1.535150e-6 | 49,298.8 km | 0.076 km |
| kerberos | 0 | 0 | 58,882.2 km | 0 |
| hydra | 2.0000e6 | 2.046866e-6 | 64,756.0 km | 0.133 km |

`M = 8.7100e11`、`μ_tot = 9.7710e11`。
`Σ w_k·r_k = (1152.340, −1579.024, −841.202) km` で、`R_b − R_p` がこれと一致する。
`(M·R_p + Σ m_k·R_k)/μ_tot − R_b` = **6.9e-4 m**(`|R_b|` = 4.53e12 m に対する相対 1.5e-16 で、
f64 の丸めそのもの)。

**以下 2.1〜2.3 に出てくる `b_k = r_k − Σ_j w_j·r_j` は「手順3で保存しようとしている値」
であって、いま計算しているものではない。** 値としては `R_k − R_b` に等しいが、実装は
`b_k` を衛星ごとに作らず `Σ w_j·r_j` を1回作って `R_p` にしている。

### 2.1 二体: 厳密にスカラー倍

質量 M(惑星)と m(衛星)。相対ベクトル `r = R_k − R_p` は
**μ = G(M+m) のケプラー軌道に厳密に乗る**(これが二体問題の標準形)。重心相対は

```
R_k − R_b =  (M/(M+m))·r          R_p − R_b = −(m/(M+m))·r
```

で、どちらも `r` のスカラー倍。**どちらを原本にしても情報量は同じ**という指摘は正しい。

### 2.2 多衛星: スカラー倍ではない ← ここが要

衛星が複数あると、系重心はただ1点で、全衛星が分け合う。衛星 k の系重心相対は

```
b_k = r_k − Σ_j w_j·r_j          w_j = m_j/(M + Σ m)      b_p = − Σ_j w_j·r_j
```

**`b_k` は `r_k` のスカラー倍ではない** — 他の全衛星の位置が引き算で入ってくる。
したがって:

- **要素の読み込み時に `a` を掛け直して重心相対へ移す、ということができない。**
  変換項 `Σ w_j r_j` が時刻の関数だから。
- **「共通重心相対を先に求め惑星相対を導出値とする」は、評価の順序としては成立しない。**
  `b_k` を出すには先に全部の `r_j` が要る。**相対の評価は必ず先に来る。**
- 反転できるのは「評価したあと、何を保存し何を公開するか」だけ(4節)。

なお、`w_k = m_k/(M+m_k)` は**単衛星のときだけ**正しい。多衛星では
`w_k = m_k/(M + Σ_j m_j)` — 系重心は対ごとの重心ではなく、全員で1点だから。
コードは後者を使っている(`celestial-motion.ts:432-435` の `muTotal`)。**正しい。**

### 2.3 「仮の惑星相対」ではない

多衛星系で近似なのは「各衛星の相対運動が独立したケプラー楕円である」という点で、
**これは相対で書こうと重心相対で書こうと同じだけ近似である**(2.2 の変換が厳密な線形写像
なので、近似の量は写像で保存される)。**座標の取り替えでは近似は1つも消えない。**
重心相対へ寄せる価値は精度ではなく、4節に挙げる別のところにある。

### 2.4 入力データはどちらを記述しているか — 相対軌道

判定はデータそのものから付く。

- **月の要素は `a = 3.844e8 m = 384,400 km`**(`earth-system.ts:107`)。これは
  **地心距離**であって、月の重心相対長半径 379,730 km ではない。
- `satellite-orbit.ts:11-13` が到達精度の指標として挙げているのも
  「近地点 356,400〜370,400 km・遠地点 404,000〜406,700 km」— **地心**距離のレンジ。
- 実測(2.5節): モデルが出す地心距離は **356,327〜406,854 km**。重心相対なら
  352,000〜401,700 km になるはずで、**4,700 km ずれる。**

したがって `satelliteState` が返すのは相対軌道であり、コードはそれを相対として
扱っている。**ここは間違っていない。** 重心相対を正本にするなら、
ラベルの付け替えではなく 2.2 の変換を通す必要がある。

### 2.5 実測

`tests/dist/` のビルド済みモジュールから太陽系を組み、t = 0 / 1e6 / 3e8 / −3e8 / 1e9 [s]
で確かめた(スクラッチのプローブ。テストへ入れるのは手順1)。

**系ごとの重心不変条件 `|Σμ_i·R_i/μ_sys − R_bary|`:**

| 系 | 衛星数 | Δr 最大 | Δv 最大 | 重心−本体(t=0) |
| --- | --- | --- | --- | --- |
| earth | 1 | 1.7e-5 m | 3.6e-12 m/s | 4,376 km |
| mars | 2 | 3.2e-5 m | 4.5e-12 m/s | 0.0 km |
| jupiter | 14 | 1.8e-4 m | 4.6e-12 m/s | 68.5 km |
| saturn | 15 | 6.1e-4 m | 2.1e-12 m/s | 272.0 km |
| uranus | 6 | 6.9e-4 m | 3.6e-12 m/s | 24.5 km |
| neptune | 2 | 5.5e-4 m | 9.4e-13 m/s | 74.1 km |
| pluto | 5 | 1.1e-3 m | 1.0e-12 m/s | 2,128 km |
| haumea | 2 | 1.4e-3 m | 6.8e-13 m/s | 209.5 km |
| eris | 1 | 2.0e-3 m | 2.3e-13 m/s | 182.3 km |
| **quaoar** | 1 | **1.35e+7 m** | **78.7 m/s** | 0.0 km |
| **orcus** | 1 | **9.01e+6 m** | **68.6 m/s** | 0.0 km |

**恒星まわり `|μ_s·R_s + Σ μ_sys·R_bary| / μ_total`:** 6e-8 〜 2.5e-7 m
(太陽の重心相対距離は 13〜112 万 km を振れる)。

**月の地心距離:** 356,327〜406,854 km(4,000 サンプル、6時間刻み・1,000 日)。

→ **丸め誤差まで完全に成り立っている。** 重み・スケーリングの取り違えは無い。
quaoar / orcus の2件は μ=0 の分岐(6.3節)で、意図された逸脱。

### 2.6 ついでに確かめた: 衛星の平均運動の質量因子

相対軌道の平均運動は `n²a³ = G(M+m)` だが、`equatorialSatelliteOrbit`
(`satellite-orbit-builders.ts:23`)は `keplerPeriod(a, planetMu)` = `GM` だけで周期を作る。
使っているのはフォボス・ダイモス・トリトンの3体だけ(天王星衛星は `jplSatelliteOrbit` で
公表周期をそのまま使っている)。

| | 質量比 m/M | GM で導いた周期の公表値からのずれ | G(M+m) にしたときのずれ |
| --- | --- | --- | --- |
| triton | 2.1e-4 | **+12 ppm** | −92 ppm |
| phobos / deimos | ≤1.7e-8 | 無視できる | 同左 |

**直すと悪くなる。** 公表された `a` と周期の組は、この丸め精度では `GM` 側と整合している。
**放置でよい** — 質量因子の落とし忘れではあるが、データの丸めに埋もれている。

---

## 3. `starRelStateAt` は主星相対である

疑いは外れ。根拠3つ、どれも独立している。

1. **返しているのは `keplerOrbitState(this.orbit, t)` そのもの。** これは
   「中心天体中心・ECI 軸での状態」を返す(`kepler-orbit.ts:170-174`)。
2. **`this.orbit` の中心は恒星と定義されている**(`celestial-motion.ts:41`)。
3. **入力データが日心。** 水星〜海王星は JPL Standish "Keplerian Elements for Approximate
   Positions of the Major Planets" Table 1(`inner-planets.ts:14`)、小天体は JPL SBDB の
   日心接触要素(`small-bodies.ts:30`)。

**「主星の位置を経由しない」と「主星相対ではない」は別のこと。** 二体解は*構成として*
主星を焦点に持つので、主星が太陽系重心のどこに居るかを**評価せずに**主星相対の
ベクトルを出せる。コメント(`planet-system.ts:22-24`)は正しい。

ただし**疑いたくなる理由は実在する** — これは階層の中で唯一、太陽系重心以外を原点に持つ
公開値で、しかも原点を特定しない `'primaryRel'` タグを着ている(6.2節)。

---

## 4. 反転できるのは「何を保存するか」だけ。それでも価値がある

2.2 のとおり評価順は反転できない。しかし**保存と公開**は反転できて、これは
`b_k = r_k − Σ w_j r_j` が厳密な線形写像なので**挙動不変**である(浮動小数の丸めを除く)。

反転して得られるもの:

- **不変条件が検査できる性質になる。** いまは `R_p := R_b − Σw_k r_k`、`R_k := R_p + r_k`
  と定義しているので、`Σμ_i R_i = μ_sys R_b` は**構成上の恒等式**。テストは通るが、
  通って当然であって「保存されている」ことの証明にはならない。重心相対を保存すれば
  `M·b_p + Σ m_k·b_k = 0` が**保存値そのものに対する検査**になる。
- **保存値の原点が、保存値から導かれる点でなくなる。** いま衛星は「惑星本体相対」で
  保存されているが、その惑星本体の位置は衛星たちから決まる。値としては循環していないが、
  読む側は毎回この向きを思い出す必要がある。
- **暦パックの規約と噛み合う。** パックの木星〜冥王星は系重心(6.1節)。系重心という
  置き場がコードにできれば、そこへ結ぶだけで済む。
- **キャッシュの段数が減る。** 系ごとに 2〜3 本の `TimeRing` が 1 本になる。

反転して失うもの:

- **`celestial-eci-baseline.test.ts` のビット一致**(加算の順序が変わる)。
- 記録1件が衛星数に比例する(土星で 16 状態 × 32 段)。
- 「個体が自分の位置を答える」形が「個体が系へ問い合わせる」形になる
  (`refactor_frame_transform.md` 0節の方針と衝突する。ただし**衛星の位置は単体では
  決まらない**ので、正本を系に置くほうが実態に合っている)。

---

## 5. 名前・コメントと実態の不一致

| 場所 | 書いてあること | 実態 |
| --- | --- | --- |
| `kinematic-state.ts:15` | `analytic` — 「**原点は恒星(星系の階層の根)中心**」 | **誤り。** 原点は太陽系重心。`StarMotion.analyticStateAt` は 0 を返さない(2.5節の実測で 13〜112 万 km)。再編前の記述が残っている |
| `kinematic-state.ts:17` | `primaryRel` — 「惑星なら恒星」 | 解析経路で主星相対を持つのは**惑星本体ではなく系重心**(`PlanetSystem`)。惑星本体が主星相対を持つのはパック経路の `packedPrimaryRelStateAt` だけ |
| `celestial-motion.ts:364-365` | 「**自分と主天体の両方を直接収録している**有効期間での、主天体相対」 | 巨大惑星では「自分」として収録されているのが系重心(6.1)。結果として `orbitNormalAt` / `orbitFrameRotationAt` は系重心の日心運動から法線を組む — **要素が系重心のものなので、ここだけは偶然より正しい** |
| `celestial-motion.ts:1` | 「解析暦・暦パックのどちらでも太陽系重心中心の…を合成し」 | 原点は合っているが、**指している点が違う**(本体 vs 系重心)ことが書かれていない |
| `PlanetSystem.starRelCache` | 名前は `starRel`、型のタグは `'primaryRel'` | 同じ量に2つの語。`PlanetSystem` は `CelestialMotion` ではないので `primary` を持たず、主星は `this.body.star` を経由して取っている(`planet-system.ts:34`) |
| `satellite-orbit-builders.ts:23` | `keplerPeriod(a, planetMu)` | 相対軌道の平均運動は `G(M+m)`。ただし直すと公表値から遠のく(2.6節)。**コメントで理由を残すべきで、式を直すべきではない** |
| `planet-system.ts:2-3` | 「**重心と惑星本体は別のもの** … 地球なら 4,673 km 離れる」 | **正しく、かつ重要。** 6.1 のバグは、この区別が暦パックの取り込みでだけ落ちていることによる |

`celestial-motion.ts:216-217` / `planet-system.ts:22-24` / `satellite-orbit.ts:112` /
`celestial-motion.ts:467-468` は**いずれも正しい**。

---

## 6. 実バグ

### 6.1 ★ 暦パックの火星〜冥王星は「惑星系重心」で収録され、「惑星本体」として消費されている

**1つの pack の中で天体ごとに収録している点が違う。** `tools/ephemeris/generate.py:74-86` の
`spk_state` が SPK から取る点:

| pack の id | SPK から取る点 | コードが使う点 | ずれ(t=0 の実測) |
| --- | --- | --- | --- |
| `sun` | `0→10` 太陽本体 | 恒星本体 | 0 |
| `mercury` / `venus` | `0→1`+`1→199` / `0→2`+`2→299` 本体 | 惑星本体 | 0 |
| `earth` / `moon` | `0→3`+`3→399` / `3→301` 本体 | 本体 | 0 |
| `mars` | `0→4` **火星系重心** | 惑星本体 | 0.0 km(無視できる) |
| `jupiter` | `0→5` **木星系重心** | 惑星本体 | **68.5 km**(最大 227 km) |
| `saturn` | `0→6` **土星系重心** | 惑星本体 | **272 km**(ほぼタイタン) |
| `uranus` | `0→7` **天王星系重心** | 惑星本体 | **24.5 km**(最大 44 km) |
| `neptune` | `0→8` **海王星系重心** | 惑星本体 | **74.1 km**(ほぼ一定、トリトンのみ) |
| `pluto` | `0→9` **冥王星系重心** | 惑星本体 | **2,128 km** |

**なぜ混在するのか — JPL の SPK にそれしか入っていないから。** DE440/441 の SPK が持つ
セグメントは `0→1`〜`0→9`(SSB → 惑星**系重心**)・`0→10`(SSB → 太陽本体)・
`1→199` `2→299`(水星/金星の系重心 → 本体。衛星が無いので実質ゼロ)・
`3→301` `3→399`(地球-月重心 → 月/地球本体)だけで、**`4→499` や `5→599` に相当する
セグメントは存在しない。** `spk_state` は第2区間があるものだけ足し、無いものは
`else: kernel[0, body]`(= 系重心)へ**黙って落ちる**。

つまり実質的な切れ目は「**地球-月だけが本体まで分解されている**」で、水星・金星の分岐は
値としてはゼロを足しているだけ。

**切り替えはどこにも無い。** 点の選択は生成時に NAIF コードごとに決まるが、manifest が
持つのは `"body": "jupiter"` という**名前だけ**で、どの点かを表す欄が無い。消費側は
`celestial-system.ts:125` の `absoluteSource.bodyEphemerisOf(motion.id)` で id を突き合わせる
だけなので、`'jupiter'` の `PlanetMotion` に系重心の暦がそのまま結ばれる。
**間違った切り替えではなく、切り替えが無いことがバグ。**

`generate.py:36` の「Giant-planet entries are system barycentres」は **N 体モデルに使う
GM についての注記**で、位置についても同じことが起きているとは書かれていない。
`tools/ephemeris/README.md` も `format.ts` も「barycentric ICRF/J2000」としか言わず、
これは**原点**の話であって**どの点を収録したか**の話ではない。

#### epk の出どころ

`.bsp` カーネルはリポジトリに入っていない(README が「DE440/DE441 を落としてはこない」と
明記)。`src/assets/ephemeris/*.epk` は**コミットされた生成物**。

| pack | 生成 | 中身 |
| --- | --- | --- |
| `modern-2026-10y.epk` | `generate.py spk --kernel de440.bsp --start 2026-01-01TDB --years 10` | **JPL DE440 をそのまま Chebyshev へ再フィット**。積分もモデルも挟まない |
| `far-future-20115-10y.epk` | `generate.py extend --kernel de441_part-2.bsp --start 20115-05-14TDB --years 10` | **DE441 の正側の境界での 11 体の状態を初期値に、rebound IAS15 で N 体積分**した結果をフィット。`MODEL_ID = tepui-de441-11body-ias15-lunar-secular-v2` |

far-future 側では月の平均黄経に経験的な加速度(62.564 arcsec/cy²)を足してある —
2924 年の予報が DE441 の境界に着地するようフィットした継続項で、観測の主張ではない
(`validation-de441-2924y.json` が同じ長さの予報を DE441 の内側で回して測った誤差)。

**far-future 側では系重心であることがモデルそのものに焼き込まれている。** N 体積分は
巨大惑星を「系 GM を持つ1個の質点」として扱う(`generate.py:36`)ので、`'jupiter'` 粒子は
**構成として**木星系重心。ここを本体へ変えるにはガリレオ衛星を別粒子として積分するしかない。
地球と月は別粒子(399 / 301)なので、地球-月重心はモデル内で分解されている。
→ **手順3 は「pack を作り直して本体を入れる」道を採れない。** 点の種別を宣言する側で解く。

**起きること(パックの有効期間 = modern プロファイルで元期±10年、通常のプレイ全域):**

- 惑星本体が系重心の位置に描かれる。冥王星は自分の半径(1,188 km)の **1.79 倍**離れた点に立つ。
- 衛星は `packedStateAt`(`celestial-motion.ts:495-500`)が「収録済みの親 + 惑星本体相対」を
  組むので、**系ごと同じ量だけ平行移動する。**
- **描かれた系の重心が、コード自身の μ で計算した重心と一致しなくなる**(2.5節の不変条件が
  パック経路では破れる。解析経路でしか測っていないので実測表には出ていない)。
- `generate.py:212-227` の validate は `spk_state` 同士を比べるので**検出しない。**
  `celestial-eci-baseline.test.ts` は木星をわざとパックから外しているので**ここも通る。**

**DE440/441 の SPK には `5→599` のようなセグメントが無い**(巨大惑星は系重心しか収録されない)
ので、「本体を取り直す」形では直せない。直し方は7節の手順4。

### 6.2 `'primaryRel'` は「何に対する相対か」を持たないので、足し先の取り違えが型検査を通る

`addPrimaryRelative<F>(primary: KinematicState<F>, rel: KinematicState<'primaryRel'>)`
(`kinematic-state.ts:62`)は、**どの `'primaryRel'` を、どの絶対状態へでも足せる。**
`'primaryRel'` を返すのは `keplerOrbitState` / `satelliteState` / `stateOnOrbitAt` /
`toPrimaryRelative` / `kepler-extrapolation` の5系統で、中心天体はそれぞれ別。次はどちらも型検査を通る:

```ts
addPrimaryRelative(star.analyticStateAt(t), moon.relStateAt(t))         // 主星 + 惑星相対
addPrimaryRelative(planet.analyticStateAt(t), system.starRelStateAt(t)) // 惑星本体 + 主星相対
```

`FrameTag` が守っているのは供給源(解析 vs パック)だけで、**「相対の中心が誰か」は
守っていない。**

### 6.3 μ=0 の惑星は系の重心不変条件を破る(実測 9,000〜13,500 km)

`PlanetMotion.computeAnalyticStateAt`(`celestial-motion.ts:430`)は `this.def.mu <= 0` の
とき重心補正をせず、**本体を系重心に置いたまま**返す。該当は `orcus`(衛星 `vanth`)と
`quaoar`(衛星 `weywot`)。本体の μ が未測定なので比が決まらない、という意図は正しく、
コメントもある。ただし結果として:

- 系の質量(= 衛星ぶんだけ)が、コードが系重心と呼ぶ点から 9,000 / 13,500 km 離れた
  衛星の位置に全部乗る。**2.5節の不変条件がここだけ破れる。**
- 太陽系重心への影響は `w = μ_sys/μ_total = 4.4e-11` 倍なので **0.4 mm**。無害。
- 一方 `system.mu` が本体を数えないので、恒星の畳み込みへ渡る系質量が実際の 1/30 程度に
  なる。これも `w` が小さいので無害だが、**「μ=0 は質量未測定であって 0 ではない」という
  前提と矛盾している**(未測定なら系質量も未知のはずで、0 として数えるのは別の近似)。

**直すべきかは判断が要る**(未測定の μ をどう扱うかの方針そのもの)。少なくとも
**テストで例外として宣言する**べきで、いまは黙って破れている。

### 6.4(軽微)恒星を持たない星系では惑星の解析加速度が原点向きになる

`PlanetMotion.analyticAccelAt`(`celestial-motion.ts:407`)は `star === null` のとき
`twoBodyAccel(自分の絶対位置, 自分の μ)` を返す — 太陽系重心という**何も無い点**へ
引かれる加速度になる。`stage-debug-alt-system.ts` では当の惑星が ECI 原点なので
`EciTransform.celestialBodyAt` の `sub(accel, origin.accel)` で厳密に消え、実害は無い。
**恒星を持たない星系に惑星を2つ置いた時点で壊れる。**

---

## 7. 計画

### 7.0 判断基準

**目的は性能ではない。** 以下を強い順に並べ、各手順がどれを満たすかで採否を決める。

| | 基準 | 効き方 |
| --- | --- | --- |
| **①** | **暦パック(epk)が太陽系重心座標を採る。揃える価値が高い** | パックの点と解析暦の点が同じ種類の値になり、`EciTransform` が入れ替えられる。**パックが系重心を収録している以上、系重心を答えるノードがコード側に要る**(6.1 の根治) |
| **②** | **保持する座標を揃えると座標変換ミスが減る**(実バグあり) | 変換が起きる箇所を数え、減らす。型で塞げるものは塞ぐ(6.2) |
| ③ | 太陽系重心は慣性系で動かない。太陽は動くので原点に適さない | 保持値の原点が、保持値から導かれる点でなくなる |
| ④ | 惑星系重心は二体問題で解ける。惑星は動くので原点に適さない | 同上 |
| ⑤ | 導出物を畳めば計算が減る**かもしれない**(反例あり) | **採否の根拠にしない。** 測って数字を報告し、**大きな悪化がないことだけ**を条件にする |

⑤ の反例は実在する — 「地球相対の月」を引きたいとき、太陽系重心相対だけを持っていると
引き算が増える。この計画ではその引き算を受け入れる立場を取り、**精度がいくら落ちるかを
先に測った**(7.1)。

### 7.1 先に測った数字

**(a) 主星相対を保持値から外す3案のケプラー解の回数**(1 distinct t あたり。系 47・うち μ>0 が 24)

| 案 | 解の回数 | 増分 | 200 substep/frame での増分 |
| --- | --- | --- | --- |
| 現状 | 24 + (実際に引かれた無質量系) | — | — |
| **L**: `starRelCache` を消し、各系が自分で解く | 24 + 47 | +17.3 µs | +3.5 ms |
| **P**: 恒星の畳み込みが全 47 系を eager に解く | 47 | +16.6 µs | +3.3 ms |
| **S**: 畳み込みが解いた 24 系へ太陽系重心位置を配る | 24 + (同上) | **±0** | **±0** |

参考: `CelestialSystem.celestialBodiesAt`(98体・新しい t)= 204.9 µs。
**案 S を採る** — ①〜④を満たしたうえで⑤の悪化が無い。

**(b) 惑星相対を引き算で復元したときの精度**

`r_k = R_k − R_p` を太陽系重心スケールで引く。f64 の絶対分解能は `|R| × 2⁻⁵²`:

| 系 | 日心距離 | 分解能 | `|r_k|` | 相対誤差 |
| --- | --- | --- | --- | --- |
| earth-moon | 1.5e11 m | 33 µm | 3.8e8 m | 9e-14 |
| pluto-charon | 4.5e12 m | 1.0 mm | 2.0e7 m | 5e-11 |
| orcus-vanth | 7.2e12 m | 1.6 mm | 9.0e6 m | 1.8e-10 |
| eris-dysnomia | 1.0e13 m | 2.2 mm | 3.7e7 m | 6e-11 |

**新しい種類の損失ではない。** `EciTransform.toEci` は既に同じスケールで引き算しており
(地球原点なら 1.5e11 m 同士)、33 µm の損失を織り込み済み。復元した `r_k` の利用者は
`analyticAccelAt`(積分1歩ぶんの2次外挿項)と `packedStateAt`(位置合成)の2つだけで、
どちらも mm を問題にしない。**したがって「惑星系重心相対の補助キャッシュ」は
いま置く必要がない**(置く判断は、mm を問題にする利用者が現れたときに戻す)。

### 手順2 — `PlanetSystem` を「太陽系重心相対を答え、暦を結べるノード」にする

**目的**: 基準①③。**パックが系重心を収録している以上、系重心はコード側でも
一人前のノードでなければならない。** 同時に主星相対を保持値・公開値から外す(基準③)。

**変更箇所**: `planet-system.ts`・`celestial-motion.ts`(`StarMotion`)・`celestial-system.ts`

- `PlanetSystem` に **id** を与える(`planetSystem()` が `def.id` から作る)。
- `PlanetSystem.analyticCache` を置き、**太陽系重心相対の系重心状態**を畳む。
- `PlanetSystem` に `bindEphemeris` / `ownPackedStateAt` / `packedStateAt` を持たせる
  (中身は `CelestialMotion` のものと同じ。**共通の口を切り出して両方が実装する**)。
- **`starRelStateAt` と `starRelCache` を消す。**
- **案 S**: `StarMotion.computeAnalyticStateAt` を2パスにする。
  1. μ>0 の系ぶん `keplerOrbitState(system.orbit, t)` を解いて一時配列へ置き、`Σ w_i·r_i` を作る。
  2. 自分の太陽系重心位置 `R_s = −Σ w_i·r_i` を確定し、**同じ一時配列から各系の
     `R_i = R_s + r_i` を作って、その系の `analyticCache` へ書き込む。**
  μ=0 の系は今までどおり自分の `analyticStateAt` で自分の二体解を1回だけ解く
  (恒星の位置はキャッシュ済み)。**ケプラー解の回数は現状と同一**(7.1(a))。
- 主星相対は、恒星の畳み込みの中の一時値と、μ=0 の系の自前計算の中の一時値としてだけ
  残る。**どこにも保存されず、外へも出ない。**

**落とし穴**: 恒星を持たない星系(`stage-debug-alt-system.ts`)は `StarMotion` が居ないので、
`PlanetSystem` が自分で二体解を解いて太陽系重心相対とする分岐が要る(現状と同じ扱い)。

**検証**: 手順1のテスト・`npm run test:physics`・`node tools/perf-probe.mjs`(前後で比較。
7.1(a) の予測は ±0 なので、**差が出たら予測が外れたということ**)。
`celestial-eci-baseline.test.ts` は落ちる(8節)。

### 手順3 — 暦パックに点の種別を持たせ、系重心の暦を系へ結ぶ(**6.1 の修正**)

**目的**: 基準①②。手順2 で系重心が一人前のノードになっているので、**結び先を変えるだけ。**

**変更箇所**: `ephemeris-pack/format.ts`(manifest)・`packed-absolute-ephemeris.ts`・
`celestial-system.ts:125`・`celestial-motion.ts`(`packedStateAt` 群)・
`tools/ephemeris/generate.py` と `cli.mjs`

**係数(実データ)は作り直さない。manifest だけを Node で編集する。** 実測で確かめた:

| 確かめたこと | 結果 |
| --- | --- |
| `cli.mjs unpack` → `pack` の往復 | **ファイル全体がバイト完全一致**(実際の `modern-2026-10y.epk` で確認) |
| `payloadSha256` の範囲 | **payload バイトだけ**(`format.ts` 冒頭の仕様どおり)。manifest を変えても不変 |
| manifest へ `bodyPoints` を足して repack | payload SHA-256 `343c7b46…` のまま。`cli.mjs verify` 通過。**+182 byte** |
| 未知キーの扱い | `validateManifest`(`format.ts:207`)が `return { ...value, series }` なので**トップレベルは素通し** |

→ **`ephemeris-profile.ts` の `packId` は書き換え不要**(payload の digest なので不変)。
→ **編集した pack は今日のコードのまま読み込める**ので、pack の編集とコードの変更は
**独立に入れられる**(どちらが先でもよい)。
→ **Python 環境も `.bsp` カーネルも要らない。** `npm run` すら要らず `node` 1つ。

**series の中には足せない。** `validateManifest` は series を既知6フィールドから作り直すので
未知キーが剥がれ、`canonicalJson(manifest) !== manifestJson`(`format.ts:341`)で弾かれる。
**トップレベルの表にする** — ついでに 10,054 セグメントぶんの重複も避けられる。

```json
"bodyPoints": { "mars": "systemBarycenter", "jupiter": "systemBarycenter",
                "saturn": "systemBarycenter", "uranus": "systemBarycenter",
                "neptune": "systemBarycenter", "pluto": "systemBarycenter" }
```

- **同梱の2つの pack の manifest を編集する。** 手順は
  `cli.mjs unpack` → JSON の `manifest.bodyPoints` を足す → `cli.mjs pack`。
  far-future 側も `BODIES` が同じなので同じ表になる。
- **`generate.py` を直して `bodyPoints` を書き出すようにする**(走らせる必要はない。
  次に誰かが pack を作ったとき、欄が欠けて黙ってバグが戻るのを防ぐため)。
- **パック経路でも系の重心不変条件を測る**(手順1 から移した。**比較対象になる「暦パックが
  答える系重心」がこの手順まで存在しないので、手順1 では書けなかった**)。系重心を収録した
  合成供給源を `testEphemerisSource` で組み、`Σμ_i·R_i^packed = μ_sys·R_b^packed` を確かめる。
  **6.1 の回帰テストはこれ。**
- **同梱 pack が `bodyPoints` を宣言していることをテストで押さえる**(`tests/repo-assets.ts`
  経由でリポジトリのファイルを読む)。**上の「黙って戻る」穴を塞ぐのはこのテスト。**
- **点の種別を答える口を `AbsoluteEphemeris` へ足す**:
  `pointKindOf(id): 'body' | 'systemBarycenter'`。`PackedAbsoluteEphemeris` は
  `manifest.bodyPoints[id] ?? 'body'`。テスト用の合成供給源は `'body'` を返す。
- **結線**(`celestial-system.ts`): `systemBarycenter` なら `PlanetSystem` へ、
  `body` なら `CelestialMotion` へ結ぶ。

**コード側に「format v1 ではこの id が系重心」という表は置かない。** pack 自身に
書けるのだから、置く理由が無い(置くと pack と表の二重管理になる)。
- **`packedStateAt` を三段に揃える**:

  ```
  PlanetSystem.packedStateAt      = 自分の pack ⟋ 本体の pack + Σ w_k·r_k ⟋ null
  PlanetMotion.packedStateAt      = 自分の pack ⟋ 系の pack − Σ w_k·r_k ⟋ null
  SatelliteMotion.packedStateAt   = 自分の pack ⟋ 系の pack − Σ w_k·r_k + r_k ⟋ null
  ```

  どれも「絶対(パック) + 相対(解析)」で、既存の不変条件の中に収まる。地球系(本体を収録)
  でも木星系(系重心を収録)でも同じ式が立つ。

**落とし穴**: `OrbitingMotion.packedPrimaryRelStateAt`(`orbitNormalAt` /
`orbitFrameRotationAt` が使う)は**いま巨大惑星で系重心の日心運動を見ており、要素が
系重心のものなので偶然正しい**。手順3 で `ownPackedStateAt` が本体を答えるようになると
**ここは本体の運動に変わる**。軌道法線としてはどちらでも 1e-7 rad の差だが、
**意図して選び直す** — 系重心側を取るなら `PlanetSystem` から引く形にする。

**検証**: 手順1の**パック経路**のテスト。**Python 環境も `.bsp` カーネルも要らない。**
`celestial-eci-baseline.test.ts` の期待値を取り直す —
**これは意図してモデルを変える(火星〜冥王星とその衛星が 0〜2,128 km 動く)手順なので、
取り直してよい唯一の手順。**

### 手順4 — 系の内訳を1件のレコードへ畳み、`relCache` と `PlanetMotion.analyticCache` を消す

**目的**: 基準②③④。**惑星相対を保持値・公開値から外す**最後の1件。

**変更箇所**: `planet-system.ts`・`celestial-motion.ts`(`PlanetMotion` / `SatelliteMotion`)

```
PlanetSystem.membersAt(t)                ← 1系・1時刻につき1件。TimeRing で畳む
├─ bary    : 系重心の太陽系重心状態        (手順2 で入れた analyticCache と同じもの)
├─ body    : 惑星本体の太陽系重心状態      (= bary − Σ w_k·r_k)
└─ sats[k] : 衛星の太陽系重心状態          (= body + r_k)
```

- 相対の二体解 `r_k` はレコード構築中の一時値。**保存しない。**
- `PlanetMotion.analyticStateAt` / `SatelliteMotion.analyticStateAt` はレコードの引き当てになる。
  `PlanetMotion.analyticCache` と `SatelliteMotion.relCache` は消える。
- **惑星相対が要る2箇所**(`SatelliteMotion.analyticAccelAt` と手順3 の `packedStateAt`)は
  `sats[k] − body` で作る。精度は 7.1(b)(最悪 2.2 mm、相対 1.8e-10)。
- `SatelliteMotion.relStateAt` と `PlanetMotion.computeAnalyticStateAt` は消える。
- **`TimeRing` は 144 本 → 47 本**(いま: 系 47 + 惑星 47 + 衛星 50)。
  衛星1体の太陽系重心位置を引く費用も「32段の線形走査 ×2 + 加算」から
  「32段の線形走査 + 配列添字」に減る。

**評価回数は変わらない** — いまも `PlanetMotion.computeAnalyticStateAt` が全衛星の
`relStateAt` を引くので、系のどれか1体が引かれた時点で M 体ぶん評価している。

**落とし穴**:

- **2.4節の取り違え。** `sats[k] − bary` は `r_k` ではない(月なら 379,730 km であって
  384,400 km ではない)。`r_k` は `sats[k] − body`。手順1の地心距離テストがここを守る。
- **惑星系重心相対を補助的に持つかは、いまは置かない**(7.1(b))。置くなら
  `body − bary` と `sats[k] − bary` をレコードへ足すだけで、あとから入れられる。
- `mu <= 0` の分岐(6.3節)はそのまま移す。**挙動を変えない。** 変えるなら別 commit。

**検証**: 手順1のテスト・`npm run test:physics`・`perf-probe`。

### 手順5 — 名前・コメント・タグの是正

- `kinematic-state.ts:15` の `analytic` の原点を太陽系重心へ直す(**5節の唯一の明確な誤り**)。
- `kinematic-state.ts:17` の `primaryRel` の説明を、系重心と惑星本体の別が分かる形へ。
- `celestial-motion.ts:1` / `:364` に「どの点か」を書く。
- `satellite-orbit-builders.ts:23` に「`G(M+m)` ではなく `GM` を使う。公表された `a` と
  周期の組がその丸め精度で `GM` 側と整合しているため」を書く(2.6節)。
- **手順2〜4 のあと `addPrimaryRelative` の呼び出しを数える。** 3箇所以下なら
  足し先の決まった専用関数へ割って 6.2 を塞ぐ。

### 手順6(別判断) — μ=0 の惑星の扱い

6.3節。**方針の問題なので実装より先に決める。**「μ 未測定」を系質量 0 として数えるのか、
系質量も未知として恒星の畳み込みから外すのか。手順1でテストが宣言していれば、
いつ着手しても壊れない。

### 到達点

| 保持値 | 座標 | 持ち主 |
| --- | --- | --- |
| 恒星の状態 | 太陽系重心相対 | `StarMotion.analyticCache` |
| 系重心の状態 | 太陽系重心相対 | `PlanetSystem`(手順2)→ `membersAt.bary`(手順4) |
| 惑星本体の状態 | 太陽系重心相対 | `PlanetSystem.membersAt.body` |
| 衛星の状態 | 太陽系重心相対 | `PlanetSystem.membersAt.sats[k]` |
| 原点天体の一式 | 太陽系重心相対 ×2 | `EciTransform.originCache` |
| ECI 瞬間値 | ECI 原点天体 | `CelestialEntity.eciCache` |

**主星相対・惑星本体相対を保持している場所は 0 になる。** 公開している場所も 0。
必要になった者が、太陽系重心相対どうしを引き算して作る。

### 掃かずに残るもの(直す/直さないの判断が要るので、手順に入れていない)

| | 何 | なぜ残すか |
| --- | --- | --- |
| 6.3 | μ=0 の惑星が系の重心不変条件を破る(9,000〜13,500 km) | **「μ 未測定」をどう扱うかの方針**。手順1でテストが例外として宣言するところまでが計画の範囲。手順6 で別途決める |
| 6.4 | 恒星の無い星系で惑星の解析加速度が原点向きになる | 現状は原点天体自身なので厳密に消え、**発火する経路が無い**。惑星を2体置いた時点で壊れるので、そうする時に直す。**手順5 でコメントに書いて残す** |
| 2.6 | `equatorialSatelliteOrbit` が `G(M+m)` でなく `GM` で周期を作る | **直すと公表値から遠のく**(トリトンで +12 ppm → −92 ppm)。手順5 で理由をコメントに書くだけ |
| 6.2 | `'primaryRel'` が中心天体を持たない | 実行時に中心が決まる経路(`el.center`)があるので**型では塞げない**。手順2〜4 のあと `addPrimaryRelative` の呼び出しを数え、**3箇所以下なら**専用関数へ割る。多ければ別作業 |
| — | `packedPrimaryRelStateAt` が巨大惑星で見る点(手順3 の落とし穴) | **どちらを取るかの選択**。軌道法線としては 1e-7 rad の差でしかない |

## 8. 触ると壊れるもの

- **`tests/physics/celestial-eci-baseline.test.ts`** — ECI 値をビット単位で押さえている。
  **手順2・4 はビット一致する見込みがある** — どちらも同じ式を同じ順で評価する形に
  書けるため(手順2: `R_s = −Σ w_i·r_i` の累積順を保ち、`R_i = R_s + r_i` の加算も
  `addPrimaryRelative` と同じ順。手順4: `R_p = R_b − Σ w_k·r_k` → `R_k = R_p + r_k` を
  そのまま移すだけ)。**演算順を保つことを実装時の制約として明示する。**
  それでも落ちたら、**手順3 まで進めてからまとめて取り直す**(手順3 は値が動くので
  どのみち取り直す)。赤いまま main へ送らない(CLAUDE.md)ので、
  **手順2〜4 は1本の作業として扱い、途中で main へ入れない。**
- **`tests/physics/celestial-motion.test.ts`** — 重心不変条件を 1 m / 1e-6 m/s で
  押さえている。手順2・4 は代数的に同値なので通るはず(実測の余裕は 500 倍)。
- **手順3 で火星〜冥王星の ECI 位置が 0〜2,128 km 動く。** `orbit-catalog.ts` や
  参照軌道にこの6天体を中心に取った要素が焼き込まれていないかを先に見る。
- **手順3 は `orbitNormalAt` / `orbitFrameRotationAt` の入力を変える**(上記の落とし穴)。
  巨大惑星の軌道線・回転基準系を目で確かめる。
- 検証は `npm run typecheck` + `npm run test:physics`。**main へ送る前は `npm run test` 全層。**
  **手順3 でも Python 環境は要らない**(manifest の編集は `cli.mjs` の unpack/pack だけ)。
- **手順3 は 4.3 MB の binary asset を2つ差し替える。** 差分は manifest の 182 byte
  だけだが、git 上は binary の全置換になる。**係数は1バイトも変わっていないこと**を
  commit メッセージに書き、`payloadSha256` が変わっていないことを根拠として添える。
