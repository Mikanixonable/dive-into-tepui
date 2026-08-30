# HelioEphemeris の解体 — 暦の供給源を天体ごとに割る

`refactor_orbit_ephemeris.md` の論点1(暦の供給源が 100 の構築点へ配られている)の検討を、
ここへ分けた。行番号・件数のスナップショットは **`6161c5b3`**。

---

## 1. 事実確認 — 先に出た問いへの回答

### 1.1 ECI 化はどこに集約されているか

**`src/physics/celestial-body-windows.ts` の `CelestialBodyWindows`。**
唯一の ECI 化点は `bodyAtIndex`(`:102-120`)の `toEci(...)` 2行で、他のどこでも起きない。

保持関係は:

| 誰が | 何を |
| --- | --- |
| `CelestialSystem`(`celestial-system.ts:98`) | `new CelestialBodyWindows(motions, origin.motion)` を1個作る |
| 同 `:100` | `for (const entity of entities) entity.bindWindows(this.bodyWindows)` で全天体へ差し込む |
| 同 `:183` | `get windows()` で外へ公開 |
| `ReferenceFrames`(`:99` で受け取る) | 参照フレームの解決に使う |

### 1.2 CelestialEntity の sync 側の ECI 変換はどうなっているか — **既に窓を通っている**

`CelestialEntity` は `private eciWindows` を持ち、コメントがこう書いている
(`celestial-entity.ts:56-58`):

> 自分の ECI 瞬間値を引く窓。**ECI 化は窓の中でしか起きないので、個体はどの天体が原点かを
> 知らない。** CelestialSystem が構築直後に1度だけ差し込む。

`stateAt(t)` → `windows.stateAt(this.id, t)` → `bodyAt` → `bodyAtIndex`。
**sync が引く座標は、既に窓を通り、既にパック経路を通っている。**

したがって「`HelioEphemeris` が `CelestialSystem` に引き上げられていると `CelestialEntity` へ
届かない」という懸念は**起きていない。** 届ける必要がそもそも無い — エンティティは窓へ id と t を
渡すだけで、パックが引ける時刻ならパックの精度で返ってくる。エンティティが原点天体を知らずに
済んでいるのは設計上の意図で、`bindWindows` は2度目の呼び出しで例外を投げてそれを守っている。

**これは対抗案にとって不利な事実ではなく、単に「その問題は解かなくてよい」という事実。**

### 1.3 「だけ」は誤りだった — 訂正

前回「天体 id と時刻 t を渡すと位置と速度を返す**だけ**」と書いたのは誤り。
`HelioEphemeris`(`absolute-ephemeris.ts:35-77`)は**5つのことをしている**:

| # | 中身 | 性質 |
| --- | --- | --- |
| 1 | `hasBody(id)` — 収録の有無を id で引く | **毎回の評価で Set 参照**。答えは構築時に確定しているのに |
| 2 | `isValidAt(simTime)` — 有効期間の判定 | 2比較。パック全体で1つ |
| 3 | 恒星中心化(`sub(body.r, star.r)`) | **関係量**。恒星の状態が要る |
| 4 | 軸置換(`icrfToGameEci`) | 純粋な写像。`v3(x, z, -y)` |
| 5 | 恒星の1件メモ(`:38-39`) | 3 を安くするためだけに存在する |

**指摘のとおり責務が集中している。** ただし1点だけ精確にしておくと、**ここは ECI 変換をして
いない。** `icrfToGameEci` という名前に反して中身は軸の置換だけ(`:29-31`)で、原点は動かさない。
出力は `KinematicState<'helio'>`(恒星中心・ゲーム軸)。原点天体の差し引き(= ECI 化)は窓の
`toEci` にある。**名前が嘘をついている** — これは `rename-ephemeris.md` 側の問題。

---

## 2. 数えた事実

`.epk` に入っているのは **11 天体**(`tools/ephemeris/generate.py:37-49`):
sun / mercury / venus / earth / moon / mars / jupiter / saturn / uranus / neptune / pluto。
巨大惑星のエントリは**系の重心**であって本体ではない。

一方、星系に登録される天体は約 100 体。内訳のうち重要なのは:

| | 数 | パックは答えられるか |
| --- | --- | --- |
| パック収録の 11 天体 | 11 | 直接引ける |
| 収録惑星の衛星 | 約 50 | **間接的に引ける**(`SatelliteMotion.packedStateAt` が「収録済みの親 + 解析の相対」で補う) |
| 太陽周回の非収録天体(準惑星 6 + 小天体 32) | **38** | **永久に引けない** |
| その非収録天体の衛星 | 数体 | **永久に引けない** |

**約 40 体は、答えられないパックへの参照を握り、評価のたびに `Set.has` を引いてそれを
再発見している。** RK4 の各段 × 天体数 × フレーム。これは指摘の核心を支持する事実。

---

## 3. 対抗案の評価

> `HelioEphemeris` を天体ごとに割る。ECI 変換もやらない。「一つの天体について、時刻 t を渡すと、
> 恒星中心での位置と速度を返す」まで簡素化する。id からの対応付けは `.epk` から読めるので、
> それを「その id の天体だけ」に配る。入っていなければ null。フォールバック切り替えと ECI 変換は
> `CelestialEntity` がやる。

### 3.1 正しいところ — 3つとも正しい

**(a) 天体ごとに割ると、id 引きが消える。** 「パックに入っているか」は構築時に確定する事実なのに、
いまは評価のたびに問い直している。割れば `hasBody` が消え、上の表の3種のゲートのうち
`SatelliteMotion` のものが**条件ごと消滅する**(null かどうかで見える)。

**(b) 「id がヒットするか」ではなく「null でない値を貰えたか」で見える、というのが正しい形。**
天体は自分の暦を持つか持たないかだけを知ればよく、カタログを引く必要がない。

**(c) 責務の集中は実在する。** 1.3 のとおり。

### 3.2 そのままでは壊れるところ — **ECI 変換は関係量である**

**ECI 座標は差である。**

```
ECI(自分) = 日心(自分) − 日心(ECI 原点天体)
```

そして**この2項は同じ供給源から来ていなければならない。** パックと解析は同じ天体に別の答えを
返すので、片方だけを差し替えるとその食い違いがそのまま相対位置の誤りになる
(`kinematic-state.ts:40-42` に明記)。だから窓はこう書いている(`celestial-body-windows.ts:109-110`):

```ts
// 原点が暦パックで引けない時刻では、この天体も引かずに解析経路へ揃える。
const ephemeris = originEphemeris === null ? null : motion.packedHelioStateAt(t);
```

**`CelestialEntity` が自分で ECI 変換をすると、この保証が N 体ぶんの個別判断に散る。**
各エンティティは自分の暦だけでなく、

- ECI 原点天体の暦(パック経路の項を作るため)
- ECI 原点天体の解析運動(フォールバックの項を作るため)
- 「原点が引けないなら自分も引かない」という**協調のルール**

を持たなければならない。これは **ECI 原点天体を窓へ集約する前の状態そのもの**で、
`refactor_orbit_ephemeris.md` が「ECI 原点天体を消したときと同じ形の歪み」と呼んでいるものが
戻ってくる。しかも 1 箇所の判断が N 箇所の**両者一致の約束**に化けるので、前より悪い。

同じ理由で、恒星中心化(1.3 の #3)も関係量なので `CelestialEntity` 単独ではできない。

**したがって「割る」は正しく、「ECI 変換をエンティティへ持たせる」は採れない。**
ただし — 次節のとおり、**恒星中心化のほうは持たせる必要すらない。**

---

## 4. 決定的な発見 — 恒星中心化は必ず打ち消される

`HelioEphemeris.stateOf` の**消費点は3つしかない**(`celestial-motion.ts`):

| 行 | 式 |
| --- | --- |
| `:167` | `precise.stateOf(this.id, t)` → `packedHelioStateAt` → 窓の `toEci(t, ephemeris, originEphemeris)` |
| `:326` | `toPrimaryRelative(t, precise.stateOf(this.id, t), precise.stateOf(primary.id, t))` |
| `:448` | `addPrimaryRelative(precise.stateOf(planet.id, t), relStateAt(t))` → 同じく窓の `toEci` |

**3つとも、必ずもう1つの `stateOf` の結果との差で消費されている。** そして恒星中心化は
「同じ恒星の、同じ t の、同じ状態」を引くこと(1件メモが同じ参照を返す)なので:

```
(bary_自分 − bary_恒星) − (bary_原点 − bary_恒星)  =  bary_自分 − bary_原点
```

**恒星の項は厳密に打ち消える。** 軸置換 `icrfToGameEci` は線形写像なので減算と可換で、
差に対して1回掛ければ同じ答えになる。`:448` の衛星の経路でも同じく消える
(`(bary_惑星 − 恒星 + rel) − (bary_原点 − 恒星)`)。

**つまり `HelioEphemeris` の恒星中心化は、観測可能な出力に一度も生き残らない。**
そして #5 の恒星1件メモは、**必ず打ち消える減算を安くするためだけに存在している**
(`refactor_orbit_ephemeris.md` 論点3 の #5 がこれ)。

副次的に、直接差を取るほうが**精度も上がる** — いまは 1e11 m 級の中間値を作ってから引いて
いるが、直接引けば丸めが1回減る。

---

## 5. 合成案 δ

**割る(指摘のとおり)。ただし ECI 変換はエンティティへ渡さず、恒星中心化は削除する。**

### 5.1 型

```
BodyEphemeris = {
  validStartSimTime, validEndSimTime,
  barycentricStateAt(simTime): BarycentricState   // id を取らない。フレーム変換をしない
}
```

`HelioEphemeris` は**消える。** `AbsoluteEphemeris` は「id → `BodyEphemeris | null`」を
構築時に1度だけ答える工場になる(評価時には呼ばれない)。

### 5.2 配り方 — 構築点 100 から `pack` が**完全に消える**

`.epk` は id ごとの係数表を持っているので、対応付けは構築時に解ける。しかも
**既にある `bindWindows` と同じ手が使える**:

```ts
// CelestialSystem の constructor、bindWindows の隣
for (const m of this.motions) m.bindEphemeris(pack?.bodyEphemerisOf(m.id) ?? null);
```

`solarSystem()` から各系の構築関数へ `pack` を引き渡す配線が**丸ごと不要になる**
(`earthSystem(sun, phases, simZeroEt, pack)` から引数が1つ落ちる、を9系ぶん)。
`planetSystem()` 49 + `new SatelliteMotion` 50 + `new StarMotion` 1 の引数も落ちる。

### 5.3 関係量が要る3箇所は、**既に持っている参照で足りる**

割ったあと「相手の暦」が要る場所は3つだけで、どれも**相手への参照を既に持っている**:

| 場所 | 要る相手 | 既に持っている参照 |
| --- | --- | --- |
| 窓の `bodyAtIndex` | ECI 原点天体 | `this.origin`(`celestial-body-windows.ts:38`) |
| `SatelliteMotion.packedStateAt` | 親惑星 | `this.planet`(`:401`) |
| `packedPrimaryRelStateAt` | 主天体 | `this.primary` |

**新しく配るものは何も無い。** これが「割る」が成立する理由。

### 5.4 ゲートがどうなるか

| いまのゲート | δ のあと |
| --- | --- |
| 窓: 原点と自分の両方が引けるか | `origin.ephemeris !== null && this.ephemeris !== null && 期間内` — **Set 参照なし** |
| `orbitFrameRotationAt`: 自分と主天体が引けるか | 同上(`primary.ephemeris`)。**Set 参照なし** |
| `SatelliteMotion`: 自分が収録されているか | **消滅**(`this.ephemeris === null` が構築時の事実) |

3種 → 2種、かつ両方が null 検査と範囲比較だけになる。

---

## 6. δ が他の論点へ及ぼすもの

- **論点1** — `precise` が天体から消え、構築点 100 の引数も消える。**本題が片付く。**
- **論点3 の #5**(`HelioEphemeris` の恒星1件メモ)— **キャッシュごと消滅する。**
  必ず打ち消える減算を安くするためのものだった。
- **論点4** — `HelioEphemeris` の段が丸ごと消え、6段が5段になる。`PackedAbsoluteEphemeris` は
  「id → `BodyEphemeris`」の工場に役割が変わり、通しメソッドが無くなる。
- **2.5° の判断が切り離せる。** δ は `packedPrimaryRelStateAt` の2枝(パック枝=実状態 /
  解析枝=平均要素)に触らない。**構造の是正を、回転基準系を動かすかどうかの判断と独立に
  進められる。** 前案 γ はこの2つを束ねてしまっていた。

---

## 7. 未確定 — 決める前に確かめること

1. **`.epk` から天体1体ぶんを切り出せるか。** `ChebyshevEphemeris` は既に
   `bodiesById: Map<string, IndexedBody>` を内部に持つ(`evaluator.ts:227`)ので、
   1体ぶんの `IndexedBody` を包んで返せば済むはず。**要確認。**
2. **有効期間を天体ごとに持つか、パック共通で持つか。** いまは `manifest.validStart/End` が
   パック共通。天体ごとのセグメント範囲から導けるが、11 天体で違うのかを確かめる。
3. **フレームタグ。** 恒星中心化を落とすとパック経路は `'barycentric'`、解析経路は `'helio'` を
   話す。`toEci<F>` はどちらでも通る(枝ごとに F が揃うため)が、
   `addPrimaryRelative` は `'helio'` 固定なので総称化が要る。
4. **`icrfToGameEci` の名前**(軸置換なのに ECI と名乗る)は `rename-ephemeris.md` へ。

## 8. 次の手

δ を採るなら、順序は **7-1 の確認 → 型の設計(`BodyEphemeris`)→ `bindEphemeris` の導入 →
恒星中心化の削除 → 構築点 100 の引数削除** で、最後の1つだけが機械作業。
`tests/physics/celestial-eci-baseline.test.ts` の固定値が動くかは、恒星の打ち消しが
厳密であるぶん**動かないはず** — 動いたら丸めの差ではなく構造の破壊を疑う。
