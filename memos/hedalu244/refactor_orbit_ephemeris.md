# 軌道・暦まわりの構造リファクタリング — 残っている問題

計画に書いた手順はすべて実施済み。この文書は**そのあとに残った構造の問題だけ**を持つ。
名前の問題は `rename-ephemeris.md` へ分けてある。以下の行番号・件数のスナップショットは
**`6161c5b3`**(`refactor_time_epoch.md` の全手順を実施した直後)。

---

## 1. 暦の供給源が 100 の構築点へ配られている ← **検討は `refactor_helios_ephemeris.md` へ移した**

> 以下は移設前の検討(案α/β/γ)。**対抗案として「暦を天体ごとに割る」が出て、それを含む
> 合成案 δ が `refactor_helios_ephemeris.md` にある。そちらが現行の検討。**
> ここの 1.1〜1.4 は問題の構造を説明する部分として残す。

### 1.1 いま何が起きているか

`HelioEphemeris | null` が `CelestialMotion` の `protected readonly precise`
(`celestial-motion.ts:108`)として**天体1体ごとに保持され**、同じ1個の参照が 100 の構築点へ
引数で渡っている(`planetSystem()` 49 + `new SatelliteMotion` 50 + `new StarMotion` 1。
内訳は `solar-system/` 98・`stage-debug-alt-system.ts` 2)。

構築の木を降りてくる値は3つあるが、**性質が違う**。

| 渡っている値 | 天体が保持するか | 実体 |
| --- | --- | --- |
| `phases` | しない。`*DefForSimZero` が def へ畳んで消える | 構築時のカリー化 |
| `simZeroEt` | しない。同上 | 構築時のカリー化 |
| `pack`(`HelioEphemeris`) | **する**(`this.precise`) | **系レベルの選択が天体1体に居座っている** |

前2つは畳まれて消えるので、構築点に現れること自体は歪みではない。**歪んでいるのは3つめだけ** —
「この星系はどの供給源が答えるか」は系の選択で、ECI 原点天体(`origin`)を窓へ寄せたときに
片付けたのと同じ形。origin は片付き、precise は残った。

### 1.2 なぜ origin のように「ただ消す」ことができないのか

`precise` の消費点は2種類あり、片方だけが窓に閉じている。

| 消費点 | src での呼び出し元 | 窓に閉じているか |
| --- | --- | --- |
| `packedHelioStateAt`(`:159`)→ `packedStateAt`(`:166` / `SatelliteMotion` の override `:444`) | `celestial-body-windows.ts:111` と `:128` の**2箇所だけ** | **閉じている** |
| `packedPrimaryRelStateAt`(`:321`)→ `orbitFrameRotationAt`(`:221`)/ `orbitNormalAt`(`:236`) | 窓を通らない**6箇所** | 閉じていない |

窓を通らない6箇所:

| 場所 | 呼ぶもの | 手元にあるもの |
| --- | --- | --- |
| `physics/lagrange.ts:107`(`secondaryFrameOf`) | 両方 | `bodies: readonly CelestialBody[]`(窓の出力そのもの) |
| `physics/reference-frames.ts:93` | 回転 | `this.windows`(`:38` で保持済み) |
| `game/nav-target.ts:280` / `:287` | 法線 / 回転 | `celestialSystem`(→ `.windows`) |
| `game/camera/map-camera.ts:282` | 法線 | `this.celestialSystem` |
| `game/celestial/scale-grid-view.ts:44` | 法線 | `celestialSystem` |

**つまり作業量は「100」ではなく「2つのメソッドと6つの呼び出し点」で、100 のほうは
引数を削るだけの機械作業。** そして6箇所は全部、既に窓へ手が届く場所にいる。

### 1.3 解き方の候補

#### 案α — `precise` を引数にする

`packedHelioStateAt(precise, t)` / `orbitFrameRotationAt(precise, t)` / `orbitNormalAt(precise, t)`。
窓が1個だけ持ち、要るときに渡す。構築点 100 から引数が消え、呼び出し点8つに引数が増える。

**採らない。** 「月の公転面法線が欲しい」だけの `map-camera.ts` に暦パックを調達させることに
なり、**系レベルの選択を構築側から消費側へ移すだけ**で、歪みの総量が減らない。

#### 案β — 窓を唯一の供給者にする

`CelestialBodyWindows` に `orbitNormalAt(id, t)` / `orbitFrameRotationAt(id, t)` を生やし、
6箇所をそこへ寄せる。天体は `precise` を一切見ない。α に「呼び出し点の付け替え」を足した形で、
消費側は暦の存在を知らずに済む。

#### 案γ — 窓の**出力から導く**(推し)

**主天体相対の状態は、既に窓の出力の中にある。**

窓の `bodyAtIndex`(`celestial-body-windows.ts:102`)は各天体を
`toEci(t, helio_self, helio_origin)` で作る。したがって

```
bodyAt(self).state − bodyAt(primary).state
  = (helio_self − helio_origin) − (helio_primary − helio_origin)
  = helio_self − helio_primary            // ECI 原点は差で消える
```

が**厳密に**主天体相対。恒星は `helioStateAt` も `packedHelioStateAt` も 0 を返す
(`celestial-motion.ts:184` / `HelioEphemeris` が恒星を引いた差)ので、惑星についても
「窓の惑星 − 窓の恒星 = 惑星の日心状態」で成立する。

しかも**窓は両者が同じ供給源から引かれることを保証している**(`bodyAtIndex` のコメント)。
いまの `packedPrimaryRelStateAt` のゲート(自分と主天体の両方がパックに載っているか)より
強い保証で、ゲートの3種類のばらつき自体が消える。

これが成り立つなら **`precise` の消費者は `CelestialBodyWindows` の `bodyAtIndex` / `originAt`
ただ2つ**になり、`OrbitingMotion` から `packedPrimaryRelStateAt` ごと消える。

β との差は**窓が何を配るか**。β は窓が `precise` を天体へ渡し続ける(供給源の選択が
`OrbitingMotion` の中に残る)。γ は窓が**既に持っている ECI 値の対**から組むので、天体側に
暦の概念が一切残らない。呼び出し点の書き換え量は6箇所でほぼ同じだが、
**`lagrange.ts:107` の `secondaryFrameOf` は既に `bodies` を受け取っているので γ では窓すら要らない**
(引数から `motion` の時刻付きメソッドが落ちる)。残り5箇所は窓経由になる。

### 1.4 案γ で判断が要る唯一の点 — 解析フォールバックが変わる

`orbitFrameRotationAt` / `orbitNormalAt` は**いま既に2つの枝を持ち、その2つは食い違っている。**

| 枝 | 条件 | 基底の作り方 |
| --- | --- | --- |
| パック枝(`:222-231`) | 自分と主天体の両方がパックに載っていて有効期間内 | **実状態**から `h = r × v` を組む。周期項も全部入る |
| 解析枝(`:232`) | それ以外 | `keplerOrbitRotation(keplerOrbit, t)` = **平均要素**。周期項を含まない |

解析枝が平均要素なのは**意図的で、理由が記録されている**(`satellite-orbit.ts:114-116`):
「回転基準系と軌道法線は二体部分だけから組まれ、周期項を含まない — **混ぜると角速度が
滑らかでなくなるため**で、この結果、衛星の実位置は回転系の x̂ 軸から最大 2.5° ほどずれる
(周期項の振幅の総和)」。**これは無視された仕様違反ではなく、記録された設計判断である。**

ただしその判断は**パック枝には適用されていない。** 結果として:

- **暦パックの有効期間の端をまたぐと、回転基準系が最大 2.5° 飛ぶ。** この不連続はいま既にある。
- 同じ天体の同じ量が、時刻によって別の定義で答えられている。

**案γ はこの2枝を「実状態」1本に統一する。** 得るもの・失うものは:

| | 得る | 失う |
| --- | --- | --- |
| γ(実状態に統一) | 有効期間の端の 2.5° の飛びが消える。ゲートが3種→2種。`precise` が天体から完全に消える | 解析領域で ω に周期項ぶんの揺れが入る(パック領域には既にある揺れ)。カメラの回転系が微妙に揺れうる |
| β(2枝のまま) | **値が1つも動かない** | 食い違いと不連続はそのまま残る。`OrbitingMotion` は供給源の選択を知り続ける |

**判断はこれだけ:「2枝の食い違いを、実状態側へ寄せて潰してよいか」。**
潰してよいなら γ、値を動かしたくないなら β(構築点 100 の引数削除はどちらでも同じく片付く)。
**ω の揺れの実際の大きさは未測定** — 決める前に月で数値化する価値がある。

### 1.5 供給源(暦/解析)を1つの型へ括るか — 括らない(変更なし)

`bodyAtIndex` / `orbitFrameRotationAt` / `packedStateAt` の3種のゲートは互いに違い、同じ型へ
押し込むと違いが条件として引数へ溢れる。**括るより配る先を減らすほうが効く。**
ただし**案γ が通ればゲートは2種に減る**(3つめの `orbitFrameRotationAt` のゲートが消える)。

---

## 2. 時刻軸は3種のまま、型では守られていない → **解消済み**

`refactor_time_epoch.md` の全手順で片付いた。現況:

- **実行時の時刻軸は simTime 1本。** `AbsoluteEphemeris` の口は `validStartSimTime` /
  `barycentricStateOf(id, simTime)` で、**この型は絶対時刻を知らない**
  (`absolute-ephemeris.ts:11-19`)。
- **J2000 ET 秒は `.epk` 復号の内側だけ。** `PackedAbsoluteEphemeris` が構築時に一度だけ
  セグメント境界を simTime へ寄せる(`packed-absolute-ephemeris.ts:20-24`、
  `toEvaluatorEphemerisPack(decoded, timeOriginSec)`)。
- **JD_TDB が残るのは cold path 6ファイル**(`save/ephemeris-context.ts`・`save/save-data.ts`・
  `stages/stage.ts`・`launcher.ts`・`ephemeris-catalog.ts`・`ephemeris-profile.ts`)で、
  型は `TdbJulianDate`。`grep -rn "sim-epoch" src/ tests/` は 0 件。
- **契約は `DEVELOP/CODING-RULE.md` 1.9「時刻軸の境界」が正本。**

branded number は当てない(軸を減らして守る対象を消した)。**この論点は閉じる。**

---

## 3. キャッシュの持ち主は5つ残る → **再開する**

前回の「一元化はしない」という結論は、**誰も要求していない問い**(全部を 1 個の Map へ畳むか)
に答えていた。答えるべきは**1本ずつの是非**で、これは未評価のまま残っている。

| # | 持ち主 | 形 | 疑うべき点 |
| --- | --- | --- | --- |
| 1 | `CelestialBodyWindows` の `allCache` / `gravityCache` / `atmosphereCache`(`:30-32`) | `TimeRing<配列>` ×3 | 3本とも中身は `bodyAtIndex` を叩くだけで、**畳んでいるのは配列の同一参照**。1フレームで3窓が**別々の t** で引かれるのでなければ、t キー1本 + 3スロットで足りる |
| 2 | 同 `bodyCaches[n]`(`:28`)/ `originCache`(`:29`) | `TimeRing` ×(N+1) | 実質がある(天体1体の ECI 値と原点)。ただし `originCache` は全天体が同じ t で引く前提の畳みで、**1件メモで足りる可能性** |
| 3 | `PlanetMotion.helioCache`(`celestial-motion.ts:333`) | `TimeRing` | 窓が ECI 値を天体ごとに畳んだ**後**でも、1時刻あたり複数回引かれるか。引き手は 窓の解析経路・`helioAccelAt`・衛星の `helioStateAt`・系の重心補正 |
| 4 | `SatelliteMotion.relCache`(`:398`) | `TimeRing` | コメントは「1時刻あたり4回前後」と書くが、**その数字が ECI キャッシュを窓へ集める前のものかどうか**が未確認 |
| 5 | `HelioEphemeris` の恒星1件メモ(`absolute-ephemeris.ts:38-39`) | 1件 | 理由は明確(天体数ぶんの Chebyshev 評価が1回に畳まれる)。疑うのは**1件で足りるか** — RK4 が t と t+dt/2 を交互に引くと毎回外れる |
| 6 | `FrameAnchors.attractorCache*`(`game/frame-anchors.ts:31-32`) | **文字列キー**の1件メモ | 他の5つと全く別物。`${frameIndex}|${id}|${t}` を**毎回組んでいる** — 毎フレーム走る経路に文字列生成が入っている。TimeRing へ寄せるか、そもそも要るか |

**次にやること(測定が先)。** `TimeRing.stats` は既に各インスタンスが持っているのに、
`CelestialSystem.perfCounts()`(`celestial-system.ts:197-208`)は**合算しか出さない**。
内訳を一時的に出して、hits/misses が「1時刻あたり n 回引かれる」を裏付けているかを1本ずつ見る。
**ヒットしていない・ヒットが1回しかないキャッシュは消す。** 消せるものが出たあとで、
残りをどう持つかを決める(構造の判断はその後)。

---

## 4. 暦側の層は6段のまま → **再開する**

前回は「段ごとに責務が違うので構造の問題ではない」と結論した。**この根拠は弱い。**
責務が違うことは、型を分ける理由にならない。型を分ける理由は「差し替わる先が2つ以上ある」ことで、
いま数えると**どの段も 1:1**。

| 段 | src での生成点 | src で実際に消費される口 |
| --- | --- | --- |
| `.epk` バイト列 | — | `decodeEphemerisPack` |
| `DecodedEphemerisPack` | `decodeEphemerisPack` 1箇所 | `manifest` / `payload` / `payloadBytes` |
| `CanonicalEvaluatorEphemerisPack` | `toEvaluatorEphemerisPack` 1箇所 | `ChebyshevEphemeris` の入力のみ |
| `ChebyshevEphemeris` | `packed-absolute-ephemeris.ts:23` 1箇所 | **`bodyIds()` と `stateAtSeconds()` の2つだけ** |
| `AbsoluteEphemeris`(interface) | — | **実装は `PackedAbsoluteEphemeris` ただ1つ** |
| `PackedAbsoluteEphemeris` | `ephemeris-catalog.ts` 1箇所 | `HelioEphemeris` の構築のみ |
| `HelioEphemeris` | `solar-system.ts:60` 1箇所 | 天体 100 体(論点1) |

**時刻軸変換が構築時へ移った結果、実際に薄くなったもの:**

- ~~`ChebyshevEphemeris.stateAtSeconds` は `stateOf` の純粋な同義語~~ → **削除済み。**
  「pack 自身の時刻軸の秒」で引くための明示的別名だったが、その軸はいま simTime そのもの。
- ~~`format.ts` の doc コメント「evaluator times remain J2000-ET seconds」~~ → **削除済み。**
  `timeOriginSec` で寄せているので評価器の時刻は呼び出し側の軸で、直下の和文コメントが正しい。
- ~~`CanonicalEvaluatorEphemerisPack` の `as unknown as` の二重キャスト~~ → **削除済み。**
  **キャストは元から不要**で、外しても型が通った(「型検査を通っていない正準型」ではなくなった)。
- **`PackedAbsoluteEphemeris` の実質は「構築時の rebase 3行 + `ids` の Set」だけ。**(未着手)
  `barycentricStateOf` は `evaluator.stateOf` を呼んで `{r, v}` を取り出す通し。
- `ChebyshevEphemeris` の `evaluate` / `segmentOf` / `positionOf` / `velocityOf` / `pack` /
  `manifest` は**テストからしか呼ばれていない。**(未着手 — テストが要るかの確認が先)

**層を残す根拠として唯一生きているもの:** `DEVELOP/SPEC/CELESTIAL.md` の未確定の案が
「恒星が2つ以上、相互に公転しあう連星系 — 天体の位置を**数値積分**で求める」を挙げている。
これは `AbsoluteEphemeris` の2つめの実装になりうる。**interface を畳むかはここの確度次第で、
ユーザーへ問う必要がある。**

**判断不要ぶんは実施済み**(`stateAtSeconds`・嘘コメント・二重キャスト)。残るのは
`PackedAbsoluteEphemeris` を畳むか、`AbsoluteEphemeris` interface を畳むか、
テスト専用の口を削るかで、**どれも「連星系の確度」次第。**

---

## 次の手

1. **論点1。** `precise` を天体から窓へ移す。**要判断は 1.4 の1点だけ**(2枝の食い違いを
   実状態側へ寄せるか = γ / 値を動かさないか = β)。決める前に月の ω の揺れを数値化する。
   残りは構築点 100 の引数削除という機械作業。
2. ~~論点4 の「判断不要ぶん」を削る~~ → **実施済み。** 残りは連星系の確度を問うてから。
3. **論点3 は測定が先。** 内訳を出してから、消せるキャッシュを消す。
4. 名前の問題は `rename-ephemeris.md` へ。
