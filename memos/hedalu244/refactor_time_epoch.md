# 時刻軸の契約を決める — 元期をステージ/ランの値にし、実行時を simTime 1軸に閉じる

## 目的

**元期(simTime=0 が指す絶対時刻)が、共有モジュール `src/game/sim-epoch.ts` の定数として
焼き込まれている。** ステージごとに違ってよい値でも、クリエイティブモードのようにプレイヤーが
選ぶ値でもあるのに、リポジトリ全体が1つの定数を import している。この不協和が根にある。

- `DEVELOP/SPEC/GAME.md` 9.0 は「確定すると、その日時をゲーム内時刻の起点(**simTime=0 相当**)
  としてマップビューから始まる」と書いている。**実装はそうなっていない** — 原点は
  `20115-05-14T06:00:00` に固定されたまま、選んだ日時は `simTime` の初期値へ変換される。
  2026年を選ぶと `simTime = −570,845,167,200` から始まる(仕様違反)。
- その結果、simTime が小さいという前提が壊れ、`simulator.ts` の絶対秒の ε(`+= 1e-6`)が
  no-op になる。

加えて、時刻を表す値が **simTime・J2000 ET 秒・JD_TDB の3軸**あり、どれも素の `number` で渡って
いる。`epoch` の1語が `epochJdTdb` / `epochOffsetSec` / `OrbitEpoch.t` の3つを兼ねていて、
軸は名前からも型からも出ない。座標が `FrameTag` で守られているのに、時刻は守られていない。
**この無防備さは既にバグを1件生んでいる**(下の 6-(a))。

この計画で **元期をステージの宣言とランの値に変え、`sim-epoch.ts` を解体し、実行時の時刻軸を
simTime 1本に閉じ、契約を CODING-RULE へ書く。**

---

## 決めたこと

以下はすべて `d4df3da9` 時点のコードと、その場で回した数値実験から取った。**ユーザーが覆せる。**
覆されたときにどの手順が変わるかを各項の末尾に書く。

### 1. 元期はステージが宣言するパラメータであり、共有の定数ではない

**`src/game/sim-epoch.ts` は解体して削除する。** 中身は3つの別物が同居している:

| いまの中身 | 実体 | 行き先 |
| --- | --- | --- |
| `SIM_EPOCH_TDB` / `_CALENDAR_TDB` / `_JD_TDB` / `_ET` | 作中の既定日時。**ステージごとに違ってよい値** | `stages/stage.ts` の `STORY_EPOCH` と、各ステージクラスの `static readonly epoch` |
| `SIM_EPOCH_SEC` / `parseDisplayIso` | 元期を `Date` 系の書式化へ渡すための表示ブリッジ | `hud/utils.ts` の `epochUnixSeconds(epoch)`(`fmtDateTime` の隣) |
| `dateStringToSimTime` | 日時入力欄のパース | `stage-select.ts` の局所ヘルパ |

**`StageClass` に2つの静的宣言を足す。**

| 宣言 | 意味 | 既定 |
| --- | --- | --- |
| `readonly epoch: TdbJulianDate` | このステージが simTime=0 に置く絶対時刻 | **無し(全ステージが宣言する)** |
| `readonly picksStartEpoch: boolean` | 開始前にプレイヤーへ開始日時を選ばせるか | `false`(`CreativeStage` だけ `true`) |

`epoch` に基底の既定値を置かない。`STAGE_CLASSES: readonly StageClass[]`
(`stage-dictionary.ts:13`)が構造的に検査するので、**宣言し忘れはそこで型エラーになる。**
`selectLabel` / `selectSub` / `selectKeys` と同じ扱い(`selectLockedSub` /
`hiddenFromSelect` / `selectGroup` は基底に既定があるが、`epoch` はそちらではない)。

値の重複は `stages/stage.ts` が持つ1つの定数で避ける — 各ステージは
`static readonly epoch = STORY_EPOCH;` と書く。**「ステージに別の日時を与える」が1行の編集になる**
のがこの形の狙いで、`STORY_EPOCH` を `stage.ts` の外から import してよい相手はいない。

`picksStartEpoch` は `stage-select.ts:390` の `stageClass.id === 'creative'` を置き換える。
**「元期を自分で決めるステージ」と「プレイヤーに決めさせるステージ」の違いを、id の分岐ではなく
ステージの宣言として持つ。**

**これが覆ると:** 元期をステージの宣言にしないなら、手順3 が消えて `sim-epoch.ts` が残り、
手順4 は「共有定数をランの値へ差し替える」だけになる。

### 2. 元期はランごとの値であり、シミュレーション開始時刻がそれになる

`simTime = 0` は「このランが始まった瞬間」を指す。ステージを差し替えるときは全物体が入れ替わる
ので、**ラン間で時刻を変換する必要は生じない。** 元期は構築時に1度だけ効く値で、
実行時の評価には一切現れない。

ランの元期の決まり方(`launcher.ts` が解決する):

```
スナップショットの元期  ??  プレイヤーが選んだ日時(picksStartEpoch のステージのみ)  ??  stageClass.epoch
```

保存する内容:

| 何を | どの軸で | 理由 |
| --- | --- | --- |
| そのランの元期 | JD_TDB | 絶対時刻。精度は 1.6e-4 s で足りる(日付として意味を持つ粒度) |
| 保存時の時刻 | simTime | 精度が要る。元期からの経過秒 |

読み込みは**元期を照合するのではなく継承する** — スナップショットが持つ元期でランを組み直す。
照合が要るのは暦データそのもの(プロファイル・pack の同一性・形式版)だけで、元期は
「どのランか」を決める値であって「現在と一致すべき値」ではない。

**セーブ形式は破壊的に変えてよい**(未運用のため)。

**これが覆ると:** 元期を固定のままにするなら、手順4 が消え、手順6 が必須の防御になる。

### 3. 可変元期のもとで案を再検討した結果 — 案A が正しく、しかも配線は既にある

可変元期は「変換オフセットを構築点まで伝える必要がある」ことを意味する。これは案Aへの
最大の懸念だった。**しかし、その配線は既に全部ある。**

解析暦の元期の畳み込みは、**いま既に実行時パラメータとして 102 の構築点へ渡っている**:

| 畳む対象 | 関数 | いま元期を受け取っているか |
| --- | --- | --- |
| ケプラー要素(永年変化率・平均黄経) | `keplerOrbitAtEpoch`(`kepler-orbit.ts:157`) | **受け取っている**(`epochOffsetSec`) |
| 衛星軌道(二体部分) | `satelliteOrbitAtEpoch`(`satellite-orbit.ts:119`) | **受け取っている** |
| IAU 極モデル(極の赤経赤緯・本初子午線) | `poleModelAtEpoch`(`celestial-body-def.ts:29`) | **受け取っている** |
| 衛星の周期項 | — | 引数を二体部分の角から組むので**畳む必要が無い**(`satellite-orbit.ts:117` のコメント) |
| 太陽方向の平均角 | `PlanetSystem.anglesAt` | 畳んだ `orbit` から導く |
| 黄道傾斜 | `ecliptic.ts` | 時刻に依らない固定値 |

**絶対元期のデータで、この畳み込みを通らない経路は存在しない。** 唯一ハードコードなのは
`stage.ts:113` が渡す**値**であり、しかも `launcher.ts:134` はセーブを読んでから
`:138` で星系を組むので、**ランの元期を渡す場所は既に開いている。**

したがって可変元期のために新しく要る配線は:

| 供給先 | いまの状態 | 追加の配線 |
| --- | --- | --- |
| 解析暦 102 構築点 | 既に引数で受け取り済み | **値の出所だけ** |
| `.epk`(`PackedAbsoluteEphemeris`) | 受け取っていない | 1箇所(手順5) |
| 点群(`jupiterMeanLongitude`) | 受け取っていない | 1箇所(手順8) |
| HUD の日時表示 4ファイル | module 定数を import | 注入が要る(手順3) |
| セーブ/互換判定 2ファイル | module 定数 | 保存値へ(手順4) |

**新規の配線は実質6ファイル。** すべて構築時か表示時で、**1回の状態評価の中には元期が
一度も現れない。**

**案C・E(CelestialSystem を ET、DynamicSystem を simTime に分ける)は、可変元期でも
救われない。** 天体側が ET を直接話せば元期を知らずに済む、という利点はある。しかし:

- 境界は窓1箇所ではない。`CelestialMotion` の時刻付きメソッドを窓を通さずに叩く箇所が
  **14 ある**(`map-camera.ts:222,282,286` / `point-entity.ts:156` / `sphere-entity.ts:100` /
  `celestial-system.ts:348` / `scale-grid-view.ts:41,44` / `rotation-zone.ts:53` /
  `orbit-analysis-data.ts:186` / `nav-target.ts:281,288` / `lagrange.ts:107` /
  `reference-frames.ts:91,93`)。**この 14 も元期を要る**ので、案C は元期の配線を
  「既に配線済みの 102 構築点」から「未配線の 15 評価点」へ移すだけになる。
- `KinematicState<F>.t` は天体と機体が共有する1つのフィールドで、
  `FrameAnchors.stateOf(id, t)`(`frame-anchors.ts:44`)は同じ `t` で両方を解決する。
  窓は入口と出口の両方で変換することになる。
- 既にある `keplerOrbitAtEpoch` / `poleModelAtEpoch` の畳み込みを**削ることになる**
  (後者は「畳まないと 1e7 deg まで積み上がる」と理由がコメントに書かれている)。

**案B・D(全体を ET / JD_TDB で統一)は、この前提そのものと矛盾する。** ランの開始を
元期にする狙いは実行時の時計を小さく保つことなので、実行時を絶対時刻にしたら意味が消える。
加えて下の 5 の測定で落ちる。

**これが覆ると:** 「14 の直接消費点を窓へ畳めば案C が成立する」と判断するなら、
手順5・8 の代わりに、その 14 を窓経由へ寄せる別計画が先に要る。

### 4. 3軸は同じ時計であり、変換は定数だけの一次写像である

3軸はどれも **TDB(太陽系力学時)** で、違うのは「原点」と「単位」だけ。

| 軸 | 原点 | 単位 | どこが話すか |
| --- | --- | --- | --- |
| J2000 ET 秒 | JD 2451545.0 (TDB) | 秒 | `.epk` のワイヤ形式、SPICE/JPL カーネル |
| JD_TDB | ユリウス通日の起点 | 日 | 暦プロファイルの有効期間、ステージ/ランの元期、暦の表示 |
| simTime | そのランの元期 | 秒 | それ以外すべて |

```
ET      = (JD_TDB − 2451545.0) × 86400        // 原点の付け替え + 日→秒
simTime = ET − (ランの元期の ET)               // 原点の付け替えのみ
```

**時刻スケールの変換ではない。** `physics/time/index.ts` が持つ UTC↔TT↔TDB の変換は
`UtcOffsetProvider` / `TdbOffsetProvider` という外部データを要求するが、**実行時のコードはこの
境界を1度も跨がない** — 元期は最初から TDB として解釈され、うるう秒にも TDB−TT の周期項にも
触れない。よって3軸の間に物理は無く、**変換に必要なのは「ランの元期」1つだけ。**

**ET と JD_TDB が両方あるのは、物理ではなくデータの語彙の要請。** `.epk` は
`"timeOrigin": "J2000-ET"` を manifest に持ちセグメント境界を ET 秒で記録している
(`tools/ephemeris/generate.py` が SPICE からそう作り、`src/assets/ephemeris/*.epk` はその形で
commit 済み)。一方、暦プロファイルの有効期間・カタログ・元期・作中カレンダーは JD_TDB。
**ET は「係数表を引く引数」、JD_TDB は「絶対時刻を語る語彙」** で役割が違う。

### 5. 分解能の要請は一方通行である(案B/D を落とす測定)

座標が3種の原点を回すのは、**変換に天体の位置というデータが要り、かつ原点の選び方で有効桁が
決まる**から。時刻は前半が無い(定数だけ)ので、残るのは分解能だけ。

`20115-05-14T06:00:00 TDB` での float64 の ULP:

| 軸 | 代表値 | ULP | 1/60 秒を足したときの誤差 |
| --- | --- | --- | --- |
| simTime(ランの元期起点) | 0 〜 1e8 | ≤ 1.49e-8 s | 相対 1e-16 |
| J2000 ET 秒 | 571,665,664,800 | **1.2207e-4 s** | 実際に足されるのは 0.0167236… = **相対 0.342 %** |
| JD_TDB | 9,068,045.75 d | 1.8626e-9 d = **1.6093e-4 s** | 同程度 |

**`x + 1e-6 === x` と `x + 1e-9 === x` が |x| ≈ 5.7e11 で真になる。** `simulator.ts` は
ゼロ刻みの打ち切りに `this.simTime += 1e-6`(:107)、前進判定に `targetTime - 1e-9`(:89)と
`subDt <= 1e-9`(:94)を使っているので、実行時軸を絶対時刻にすると**無音のフリーズを検知する
最後の砦が no-op になる。**

逆向き(暦側を simTime へ寄せる)に対称的な損は無い。`.epk` のセグメント半幅は 172,800 s
(4日)で、ET のまま評価すると Chebyshev の正規化座標 x が 1.2207e-4 / 172800 = **7.06e-10** に
量子化される(float64 本来の 1e-16 ではなく)。地球の日心位置で 3.64 m の位相ずれ。全天体が
同じ t で引かれるので相対位置には出ないが、**要求した t が honor されていない。**

### 6. 契約が無いために既に壊れているもの(3件)

**(a) 木星トロヤ群・ヒルダ群が、木星から 17.3° ずれた位置に生成されている。**

`point-field.ts:137` は木星の平均黄経を `orbit.l0 + orbit.lRate * (t + EPOCH_T_OFFSET)` で求める。
`EPOCH_T_OFFSET` は 6,972,197.19 s。ところが木星本体は
`planetDefAtEpoch(JUPITER, phases, SIM_EPOCH_ET)` で畳まれ、`SIM_EPOCH_ET` は
571,665,664,800 s。**同じ「元期」を指す `number` が2つあり、値が違う。**
差は木星の平均運動で 9594.726 rad = 1527.048 周 → 巻き戻して **17.31°**。
`DEVELOP/SPEC/CELESTIAL.md` 10節「木星トロヤ群は…**木星の平均黄経から**±60度の位置を中心に
±30度散らした秤動域に分布する」に違反する。

**テストは検出できない。** `tests/game/point-field.test.ts:55,91` の基準が
`jupiterMeanLongitude` 自身で、実際の木星の位置と突き合わせていない(自己整合なので必ず通る)。

**(b) 開始日時が simTime=0 になっていない。** GAME.md 9.0 の仕様違反(冒頭の「目的」)。

**(c) `solarSystem()` が同じ瞬間を2つの引数で受け取っている。** `solar-system.ts:53` の
`epochOffsetSec`(解析暦の位相原点)と `epochJdTdb`(`HelioEphemeris` の時刻原点)。食い違うと
**解析経路と暦パック経路が別々の瞬間について答える**ので、パックが引ける天体と引けない天体の
境目、およびパックの有効期間の端で位置が飛ぶ。

**一致を実行時に検査する形では直さない。** 整合性を保つ責務が呼び出し側に残ったままになり、
それがこの2引数の問題そのもの。**片方を落として、もう片方から導く。**

### 7. 採る契約

```
実行時の時刻は simTime ただ1つ。元期はステージ/ランの構築時パラメータで、評価には現れない。
J2000 ET 秒は .epk 復号の内側だけ、JD_TDB は絶対時刻を語るときだけ。
```

1. **`KinematicState.t`・すべての `*At(t)` / `*Of(id, t)`・`OrbitEpoch.t` は simTime。** 無標。
2. **元期はステージが宣言し、ランが1つ持ち、`CelestialSystem` が保持する。**
   型は `TdbJulianDate`(`physics/time` に既にある `{ value, scale: 'TDB' }`)。
   **元期を共有モジュールの定数として置かない。**
3. **同じ瞬間を2つ保持する構造を作らない。** ET 秒が要る場所は `ephemerisSeconds()` で導く。
   検査で守るのではなく、持たないことで守る。
4. **J2000 ET 秒は `.epk` を復号して評価器へ渡すまでの内側にだけ存在してよい。**
   `PackedAbsoluteEphemeris` が構築時にセグメント境界を simTime へ寄せ、`AbsoluteEphemeris` の
   口は simTime で話す。解析暦が `keplerOrbitAtEpoch` でやっている畳み込みを、暦パック側でもやる。
5. **JD_TDB は「絶対時刻を語る語彙」に限る。** ランの元期、暦プロファイルの有効期間、
   pack の選択、作中カレンダーの表示。**1回の状態評価の引数にはしない。**
6. **simTime の分解能は |simTime|·2⁻⁵²。** 絶対秒の ε で刻みの前進を判定しない。
7. **表示用 unix 秒は第4の軸であり、名前に `UnixSec` を出す。** 元期からその場で導く。

**branded number は当てない。** 上の 4・5 を済ませると、実行時に simTime 以外の時刻を受け取る
関数が残らない。残る JD_TDB は構築時・保存時の cold path だけで、そこには `TdbJulianDate` という
既存の型が付く(cold path なのでオブジェクトの割り当てが問題にならない)。ホットパスに残るのは
simTime 1軸だけなので、**`+` / `-` をヘルパ呼び出しへ置き換える理由が無い。軸を減らして守る
対象を消すほうが、軸を残して型で見張るより効く。**

---

## 達成目標

全手順の実施後、以下がすべて満たされること。

1. `DEVELOP/SPEC/SAVE.md` の読み込み規則が「元期は継承する / 暦データの同一性だけを照合する」に
   なっている。`DEVELOP/CODING-RULE.md` に「時刻軸の境界」の節があり、契約 1〜7 が書かれている。
2. **`src/game/sim-epoch.ts` が存在しない。**
   `grep -rn "sim-epoch" src/ tests/` が 0 件。
3. **`STAGE_CLASSES` の全 8 クラスが `static readonly epoch` を宣言している。**
   `Stage` 基底に `epoch` の既定値が無い(1つ消すと `stage-dictionary.ts:13` で型エラーになる
   ことを、一時的に消して確かめる)。
4. `grep -n "id === 'creative'" src/game/stage-select.ts` が 0 件
   (`picksStartEpoch` に置き換わっている)。
5. **クリエイティブで 2026-01-01 を選んで開始したとき、`Simulator.simTime` の初期値が 0。**
   HUD の日時表示が `2026-01-01T00:00:00` を指す。
6. **同じ瞬間を2つのフィールド/引数で保持している箇所が 0。** `solarSystem()` が元期を
   受け取る引数は1つ、`CelestialSystem` が持つ元期も1つ。
7. `src/` を `grep -n "JdTdb"` して当たるのは、**暦プロファイル・pack カタログ・ランの元期だけ。**
   `AbsoluteEphemeris` / `HelioEphemeris` / `PackedAbsoluteEphemeris` の口には 0 件。
8. `src/` を `grep -rn "ephemerisSeconds\|EtSeconds"` して当たるのは `physics/time/`・
   `solar-system.ts`・`packed-absolute-ephemeris.ts` の**導出1行ずつだけ**。
   `ChebyshevEphemeris` の引数名から `secondsSinceEpoch` が消える。
9. `EPOCH_T_OFFSET` が `src/` から 0 件になる(テストヘルパへ移る)。
10. `jupiterMeanLongitude` の基準が、**実際の木星の日心黄経と ±6° 以内で一致する**ことを
    検査するテストがあり、通る。
11. `src/game/dynamic/simulator.ts` に、`simTime` と絶対秒の定数を比較・加算する箇所が 0 件。
12. `grep -rn "AtEpoch" src/` が 0 件。`OrbitEpoch` が 0 件。
13. `npm run typecheck` / `npm run test`(全層)が通る。
14. `.epk` の manifest キーと `EPHEMERIS_PACK_VERSION` の**値**が変わっていない
    (`git diff` に現れない)。**セーブ形式は変わってよい。**

---

## 手順

### 手順4. 開始日時がそのまま simTime=0 になる

**目的.** GAME.md 9.0 の仕様どおりにする。**この手順は挙動を変える。** 元期がランの開始時刻に
なることで、simTime は常に 0 から始まり、`|simTime|` はそのランの経過時間で抑えられる。
「決めたこと 2」の実施であり、この計画の中核。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/stage-select.ts` | `readEpoch()` の結果を simTime へ直さず、**`TdbJulianDate` のまま `done(stage, epoch)` で返す** |
| `src/launcher.ts:45,49,91-92,100-142,162-164,220,243-246` | `startSimTime?: number` を **`startEpoch?: TdbJulianDate`** へ。`startRun` は `initialSave` を先に読み(:134)、**元期を `initialSave?.ephemerisContext.epochJdTdb ?? startEpoch ?? stageClass.epoch` の順で決めて** `initCelestialSystem` と `Game` へ渡す。`initialSaveFor` の「明示されていれば自動復元しない」判定は `startEpoch` で同じ形 |
| `src/game/stages/stage.ts:66-71,104-113` | `createCelestialSystem(phaseOffsets, earthSpinPhase0, onProgress?, startSimTime?)` → **`(..., epoch: TdbJulianDate)`**(必須)。`profileAtOrNull(epoch.value)` でプロファイルを選び、`solarSystem(..., epoch)` |
| `src/game/stages/stage-debug-alt-system.ts:83` | 同じシグネチャへ追従 |
| `src/game/game.ts:127,211` | `initialSimTime?: number` を落とす。`new Simulator(..., initialSave?.simTime ?? 0)` — **新規開始は常に 0** |
| `src/game/save/ephemeris-context.ts` | `ephemerisContextStatus` から **`epochJdTdb` の一致検査を外す**(元期は継承する値)。照合に残すのは `profileId` / `packId` / `packFormatVersion`。**`ephemerisContextFor(epoch)` 化は手順3 で済ませた**(この節が game グラフへ依存すると physics のテストビルドが `.epk` を読めずに壊れるため、前倒しした) |
| `src/game/save/snapshot-service.ts` | `load(snapshotId, stageId, epoch)` が受け取る元期を、ステージの宣言ではなく**スナップショット自身の元期**にする(継承)。`launcher.ts:169` の呼び出しを合わせる |
| `src/game/save/save-data.ts:229,332-334` | `EphemerisContext.epochJdTdb` は「**そのランの元期**」の意味になる。`simTime` は元期からの経過秒。フィールド名は据置でよいので、**コメントを書き換える** |
| `tests/game/`(新規) | ①クリエイティブ相当の起動で **`Simulator.simTime` の初期値が 0** ②**スナップショットの元期が現在の元期と違っても読める** ③**西暦50年を元期にしたとき HUD の日時が 1950 年にならない**(`Date.UTC` の 0〜99 年の罠)を各1本 |

**達成条件と検証**

- `grep -rn "startSimTime\|initialSimTime\|CURRENT_EPHEMERIS_CONTEXT" src/` が **0 件**。
- `npm run typecheck`、`npm run test:game`、`npm run test:physics`。
- 目視: タイトル → クリエイティブ → 開始日時 `2026 / 1 / 1 / 0 / 0` → 開始。
  **HUD 上部の日時が `2026-01-01T00:00:00`、T+ が 0** から始まること。
  既定日時(20115)でも同じく T+ 0 から始まること。
- 目視: 2026 開始のランでスナップショットを保存 → タイトルへ戻る → 20115 の既定で起動 →
  そのスナップショットを読み込むと **2026 のランとして復元される**こと。

---

### 手順5. J2000 ET 秒を `.epk` の復号の内側へ閉じる

**目的.** 契約 4・5 の実施。`AbsoluteEphemeris` の口を simTime へ寄せ、**JD_TDB を実行時の
評価経路から追い出す。** 副次的に、Chebyshev の正規化座標の量子化(7.06e-10)が消えて
要求した t が honor されるようになる。**ワイヤ形式には触らない** — 復号後のセグメント境界を
構築時に1回引くだけ。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/absolute-ephemeris.ts:11-16` | `AbsoluteEphemeris` の `validStartJdTdb` / `validEndJdTdb` → `validStartSimTime` / `validEndSimTime`、`barycentricStateOf(id, jdTdb)` → `barycentricStateOf(id, simTime)`。**この型がもう JD_TDB を知らないことが要点** |
| 同 `:36-79` | `HelioEphemeris` の元期引数を落とす。`isValidAt(simTime)` は `validStart/EndSimTime` と直接比較、`stateOf` は `simTime` をそのまま渡す。`lastStarJdTdb` → `lastStarSimTime` |
| `src/physics/packed-absolute-ephemeris.ts:11-36` | コンストラクタが `epoch: TdbJulianDate` を追加で受け、内部で `const simZeroEt = ephemerisSeconds(epoch)` を1回導出する。`validStartSimTime = decoded.manifest.validStart − simZeroEt` 等。`toEvaluatorEphemerisPack(decoded)` の結果に対し、**manifest 側と bodies 側のセグメント `start`/`end` を同じ量だけ引いてから** `ChebyshevEphemeris` を作る(`validateManifest` が両者の一致を検査するので、片方だけ引くと構築時に落ちる)。`barycentricStateOf(id, simTime)` は `evaluator.stateAtSeconds(id, simTime)` を直接呼ぶ |
| 同 `:52-56` | `loadPackedAbsoluteEphemeris(bytes)` → `loadPackedAbsoluteEphemeris(bytes, epoch)` |
| `src/physics/ephemeris-pack/evaluator.ts:283-287` | `stateAtSeconds` の引数名 `secondsSinceEpoch` と「simulation epoch in SI seconds」のコメントを、**「pack の時刻軸の秒(構築側が原点を決める)」**へ書き換える。評価器自身は原点を知らない |
| `src/physics/ephemeris-catalog.ts:37-64` | `loadAbsoluteEphemeris(profileId, epochJdTdb, requiredEndJdTdb, onProgress)` → `(profileId, epoch: TdbJulianDate, requiredEndJdTdb, onProgress)`。**プロファイル選択と期間検査は JD_TDB のまま**(契約 5 の用途)。pack の期間検査は要求側を simTime へ寄せて比較する |
| `src/physics/ephemeris-profile.ts` | **触らない。** `*JdTdb` は絶対時刻の語彙として正しい |
| `src/game/stages/stage.ts:104-113` | `loadAbsoluteEphemeris(profile.id, epoch, ...)` |
| `src/game/celestial/solar-system/solar-system.ts:57` | `new HelioEphemeris(absoluteSource, SUN.id)` — 元期の引数が消える |
| `tests/physics/absolute-ephemeris.test.ts:11-73` | スタブを新しい口へ。`new HelioEphemeris(source, 'sun', 150)` の第3引数を落とし、期待値を simTime 基準へ書き直す |
| `tests/physics/packed-absolute-ephemeris.test.ts` | 構築に元期を渡す。**元期 J2000 を渡したときに従来と同じ値を返す**ことを1本足すと、rebase が値を動かしていないことが押さえられる |
| `tests/physics/celestial-eci-baseline.test.ts:170` / `tests/physics/window-agreement.test.ts` | 構築の追従 |
| `tests/physics/chebyshev-ephemeris.test.ts` | 評価器そのものは変わらない。引数名の変更に追従するだけ |

**達成条件と検証**

- `grep -rn "JdTdb" src/physics/absolute-ephemeris.ts src/physics/packed-absolute-ephemeris.ts`
  が **0 件**。
- `grep -rn "JdTdb" src/` が `ephemeris-profile.ts` / `ephemeris-catalog.ts` / `save/` /
  `stages/stage.ts` の**絶対時刻の用途だけ**であること(1件ずつ目視)。
- `npm run typecheck`、`npm run test:physics`、`npm run test:game`。
- `tests/physics/celestial-eci-baseline.test.ts` が通る — **rebase が位置を動かしていない
  ことの本体の検査**。
- `git diff --stat src/assets/` が空(`.epk` を触っていないこと)。

---

### 手順6. dynamic 層の絶対秒 ε を「実際に進んだか」の判定へ置き換える

**目的.** 契約 6 の実施。手順4 で simTime は 0 から始まるようになったので、これは**もう
既知の破綻を塞ぐ手当てではなく、判定を元期の選び方から独立させる作業**になる。刻みが進んだ
かどうかを、絶対秒の閾値ではなく浮動小数の実際の挙動で判定する。長時間の高倍率ランで
simTime が大きくなっても、無音のフリーズを検知する砦が効き続ける。**退化ケースの挙動だけが
変わる。**

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/simulator.ts:89` | `while (this.simTime < targetTime - 1e-9)` → `while (this.simTime < targetTime)`。前進しない場合はループ内の打ち切りが引き受ける |
| 同 `:94` | `if (subDt <= 1e-9)` → `if (this.simTime + subDt <= this.simTime)`。**「足しても進まない」ことそのものを判定する** |
| 同 `:107` | `this.simTime += 1e-6` → `this.simTime = targetTime`。ULP 未満の加算で逃げるのではなく、そのフレームぶんを消費して必ず終わらせる。ログ文言も実態へ合わせる |
| `src/game/dynamic/time-step.ts:12-21` | `simulationStepDuration` は相対量を返しているので大きさに依らない。**触らない** |
| `src/game/dynamic/entity-contact-response.ts:90` | `Math.abs(a.state.t - b.state.t) <= 1e-6` は残す。同一サブステップの個体は同じ `endTime` へビット一致で着地するので、|simTime| が大きい構成では実質 `===` に締まるだけで緩みはしない。**判断の根拠をコメント1行で残す** |
| `tests/game/`(新規 or 既存の simulator 系) | `initialSimTime = 5.7e11` で `advance` を回し、**simTime が単調に増え、targetTime へ到達する**ことを検査するテストを1本足す |

**達成条件と検証**

- `grep -n "1e-9\|1e-6" src/game/dynamic/simulator.ts` が **0 件**。
- `npm run test:game` — 新規テスト「巨大な simTime でも advance が targetTime へ到達する」が通る。
  **修正前に先に書いて落ちることを確認する。**
- `npm run typecheck`、`npm run test`(全層)。

---

### 手順7. `epoch` 1語を軸ごとの語へ解体する

**目的.** 契約が決まったので、`epoch` が3つの別物を指している状態を解く。
**この時点で挙動は変えない**(純粋な改名)。`refactor_orbit_ephemeris.md` 2節と
`rename-ephemeris.md` 1.6 が「別計画」として送った分がこれ。

**変更が必要な箇所**

| 現名 | 新名 | ファイル(件数は `d4df3da9`) |
| --- | --- | --- |
| `epochOffsetSec`(引数・ローカル) | `simZeroEt` | 9系ファイル + `celestial-motion.ts` / `kepler-orbit.ts` / `satellite-orbit.ts` / `celestial-body-def.ts`、計 132 件。**手順2 で `solar-system.ts` の 10 件は既に消えている** |
| `planetDefAtEpoch` / `satelliteDefAtEpoch` | `planetDefForSimZero` / `satelliteDefForSimZero` | `celestial-motion.ts:81,89` と 9系ファイルの呼び出し |
| `keplerOrbitAtEpoch` / `satelliteOrbitAtEpoch` / `poleModelAtEpoch` | `keplerOrbitForSimZero` / `satelliteOrbitForSimZero` / `poleModelForSimZero` | `kepler-orbit.ts:157` / `satellite-orbit.ts:119` / `celestial-body-def.ts:29` と呼び出し |
| `OrbitEpoch` / `OrbitalElements.epoch` | `OrbitPhaseRef` / `.phaseRef` | `elements.ts:10,21,72,76,163-166,197` / `kepler-extrapolation.ts:49-50` / `tests/physics/elements.test.ts:33,42` / `tests/physics/kepler-orbit.test.ts:76` |

`AtEpoch` の総数は src 123 + tests 28 = 151 件。すべて機械的な置換。

**「元期における」ではなく「simTime=0 起点へ畳んだ」**という中身を名前に出すのが狙いなので、
`AtEpoch`(前置詞 at = その時点における)を残さない。`OrbitEpoch` は元期ではなく位相の基準
(`t` は simTime)なので、`epoch` の語自体を外す。

**変更が必要な箇所(追加)**

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/dynamic-entity/{ammo-pickup,base,enemy}.ts` / `src/game/player/player.ts` / `src/game/game.ts:375` / `src/game/stages/spawner/enemy-generator.ts:70` | コメント中の「epoch で展開する」= 「時刻付き状態として復元する」の意。**`epoch` の語を落として「simTime 付きの状態として復元する」へ書き換える** |
| `src/physics/ephemeris-pack/format.ts:23` | 「seconds from the J2000 ET epoch」はワイヤ形式の説明なので**据置**(ここだけが ET を語ってよい場所) |
| `src/game/stages/stage.ts` の `STORY_EPOCH` / `StageClass.epoch` | **据置。** これは「元期」そのものを指す正しい用法 |
| `src/game/celestial/solar-system/constants.ts:10` | `EPOCH_T_OFFSET` は**この手順では触らない**(手順8 で消える)。一括置換の対象から外すこと |

**達成条件と検証**

- `grep -rn "AtEpoch" src/ tests/` が **0 件**(`tests/dist` を除く)。
- `grep -rn "OrbitEpoch" src/ tests/` が **0 件**。
- `grep -rniE "\bepoch\b" src/` の残りが `physics/time/`・`stages/stage.ts` の元期宣言・
  `ephemeris-pack/format.ts`・`save/` の元期フィールド・**`EPOCH_T_OFFSET`(手順8 で消える)**
  だけであること。
- `npm run typecheck`、`npm run test`(全層)。

---

### 手順8. 点群の元期を太陽系本体へ揃える(バグ修正)

**目的.** 「決めたこと 6-(a)」を直す。**この手順は挙動を変える** — トロヤ群・ヒルダ群の
生成位置が動き、`DEVELOP/SPEC/CELESTIAL.md` 10節の記述どおりになる。併せて **テストの基準を
自己参照から実際の木星へ付け替える**(現状のテストはこのバグを構造上検出できない)。
契約と構造が揃ったあとに置くことで、**修正が「元期は1つ」の規則に沿った形にしかならない**
ようにする。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/solar-system/point-field.ts:7,135-138` | `jupiterMeanLongitude(t: number)` → `jupiterMeanLongitude(t: number, simZeroEt: number)`。`EPOCH_T_OFFSET` の import と使用を落とす |
| 同 `:210-219` | `generatePointField(seed?)` → `generatePointField(simZeroEt: number, seed: number = ASTEROID_SEED)`。`jupiterMeanLongitude(0, simZeroEt)` を渡す |
| `src/game/celestial/solar-system/solar-system.ts:81` | `generatePointField(simZeroEt)`(手順2 で導出済みのローカルをそのまま渡す) |
| `src/game/celestial/solar-system/constants.ts:3-10` | `EPOCH_T_OFFSET` を削除。**本番の元期ではなくなったので `src/` に残す理由が無い**(唯一の利用者がこのバグだった) |
| `tests/physics/test-helpers.ts` | `TEST_SIM_ZERO_ET = 6972197.1872752225` を新設(値は `EPOCH_T_OFFSET` をそのまま移す)。導出の説明コメントも移す。手順2 で入れた既定引数もこれを使う |
| `tests/physics/celestial-motion.test.ts:9,75,90,199,221,229,233` / `tests/physics/celestial-eci-baseline.test.ts:12,170,194` | `EPOCH_T_OFFSET` の import 元をテストヘルパへ、名前を `TEST_SIM_ZERO_ET` へ |
| `tests/game/point-field.test.ts:6,32-33,40,54-55,67,76,88,91` | `generatePointField(...)` / `jupiterMeanLongitude(...)` に元期を渡す。**新規テストを1本足す** — `solarSystemParts` から `motionOf(parts,'jupiter').helioStateAt(t)` の日心黄経を求め、`jupiterMeanLongitude(t, simZeroEt)` との差が **±6° 以内**(木星の e=0.0484 による中心差の上界 2·e ≒ 5.5°)であることを検査する。既存のトロヤ群 ±35° 検査はそのまま残す |

**達成条件と検証**

- `grep -rn "EPOCH_T_OFFSET" src/` が **0 件**。
- `grep -rniE "\bepoch\b" src/` の残りから `EPOCH_T_OFFSET` が消える(手順7 で残した1件)。
- `npm run test:game` — 新規テスト「木星の平均黄経の基準が実際の木星と一致する」が通る。
- **修正前に新規テストを先に書いて落ちることを確認する**(既定元期での差 17.31° > 6°)。
  落ちなければ、テストがまた自己参照になっている。
- `npm run test:physics`(`EPOCH_T_OFFSET` を使うテスト群が移動後も通ること)。
- 目視: マップビューで木星まで引き、**トロヤ群の2つの雲が木星の前後 60° に付いている**こと。
- `npm run typecheck`、`npm run test`(全層)。

---

## 見積り

| 手順 | 触る箇所 | 導出 |
| --- | --- | --- |
| 4 | src 8 ファイル・tests 1 ファイル | `startSimTime` 経路 13 箇所 + save 3 ファイル + 新規テスト3本。**判断が最も要る手順** |
| 5 | src 6 ファイル・tests 5 ファイル | `JdTdb` 参照のうち評価経路にある 25 箇所(`absolute-ephemeris.ts` 17 + `packed-absolute-ephemeris.ts` 8)+ catalog/stage/solar-system の追従 |
| 6 | src 2 ファイル・tests 1 ファイル | 判定 3 箇所 + 新規テスト1本 |
| 7 | src 14 ファイル・tests 8 ファイル | `AtEpoch` 151 + `epochOffsetSec` 122(手順2 後)+ `OrbitEpoch` 11 = 284 件。うち約 250 件は9系ファイルの `planetDefForSimZero(X, phases, simZeroEt)` 形の同一パターン |
| 8 | src 3 ファイル・tests 4 ファイル | `EPOCH_T_OFFSET` 参照 13 箇所 + 新規テスト1本 |

**件数の大半は手順7** で、`\b` 境界付きの一括置換で機械的に片付く。**判断が要るのは手順4**
(元期の出所と読み込み規則)と**手順5**(型の口の設計)の2つ。

手順6・8 は**先にテストを書いて落とす**ぶんの往復が要る。

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `tests/physics/celestial-eci-baseline.test.ts` の固定値がまた動く | **手順2 で1度だけ再収録済み**(テストの元期が ET 由来から JD 由来へ変わり、畳み込みが 7.98e-6 s ずれたぶん。全天体で 0.35 m 以下、`t + 7.978640496730804e-6` で評価すると旧値に相対 1e-12 で一致することを確認済み)。**手順3 以降でこの値が動いたら、それは元期のずれではなく構造の破壊である** | 手順3〜8。動いたら再収録せず原因を探す |
| `solarSystem` 内で導出した `simZeroEt` を、フィールドやモジュール定数として保持する | 同じ形が別の場所に生える。**関数ローカルに留めて9系へ引数として渡すだけ**にすること | 手順2・8 |
| `Stage` 基底に `epoch` の既定値を置く | 宣言し忘れが型検査に落ちなくなり、共有定数へ静かに戻る。**既定を置かないこと自体が enforcement** | 手順3。達成目標3(1つ消して型エラーになることを確かめる) |
| `STORY_EPOCH` を `stage.ts` の外から import する | 「共有財にハードコードしない」という手順3 の目的が消える。**参照してよいのはステージクラスの静的宣言だけ** | 手順3。`grep -rn "STORY_EPOCH" src/` がステージ 8 ファイル + `stage.ts` に限られること |
| `epochUnixSeconds` を `Date.UTC` だけで組む | **西暦 0〜99 年が 1900+year へ写る**(`Date.UTC(50,0,1)` → 1950-01-01)。クリエイティブは西暦0年以降を受けるので届く。`setUTCFullYear` で補正が要る | 手順3・4。手順4 のテスト③ |
| 手順4 で元期の決定順を間違え、セーブの元期より選択日時を優先する | スナップショットを読んだのに別の元期でランが組まれ、**全天体の位置が保存時と食い違う。型検査もテストも通る** | 手順4。`initialSave?.ephemerisContext.epochJdTdb ?? startEpoch ?? stageClass.epoch` の順を守ること。達成目標5 の目視 |
| `launcher.ts:134` より前で星系を組む形に書き換える | セーブの元期を知る前に星系を組むことになり、上と同じ壊れ方をする。**現状は 134(セーブ読み)→ 138(星系構築)の順で、これは変えてはいけない** | 手順4 |
| `ephemerisContextStatus` から `packId` の照合まで外す | 暦 pack を作り直したときに、古い天体位置で保存されたスナップショットが黙って新しい pack で復元される | 手順4。外すのは `epochJdTdb` の照合**だけ** |
| HUD の日時表示に、ランの元期ではなく `STORY_EPOCH` を渡す箇所が残る | 2026 開始のランで日時表示だけ 20115 年になる。**HUD は目視でしか気付けない** | 手順3・4。`grep -rn "STORY_EPOCH" src/game/hud src/game/plan` が 0 件であること |
| `stage-select` の日時欄の既定値を「前回のランの元期」にする | 既定値は**そのステージが宣言した日時**。GAME.md 9.0「既定値はエポック」に反する | 手順3・4 |
| rebase で manifest 側のセグメント時刻だけを引き、bodies 側を引き忘れる(または逆) | `validateManifest` の `metadata.start !== segment.start` で**構築時に例外**。起動できなくなるので静かには壊れないが、原因が rebase だと気付きにくい | 手順5。両方を同じ関数の中で引くこと |
| rebase の減算が桁落ちすると思って避ける | 実際には桁落ちしない — 5.7e11 同士の差 1e8 は ULP 1.5e-8 で表現でき、**減算は誤差なし**。避けると手順5 の意味が消える | 手順5 |
| 手順5 で `ephemeris-profile.ts` の `*JdTdb` まで simTime へ寄せる | プロファイルは**元期を知らない**(元期の選択より先に引かれる)。simTime へ寄せると循環する | 手順5。`ephemeris-profile.ts` は触らないと明記済み |
| `.epk` の manifest キーや `EPHEMERIS_PACK_VERSION` の**値**を触る | 既存 `.epk` 2本が読めなくなる。復号(`format.ts`)には一切触らず、rebase は復号**後**に行うこと | 手順5。達成目標14 |
| `simulator.ts:94` を `subDt <= 0` にする | `simTime + subDt === simTime` になる正の subDt(ULP 未満)を拾えず、**ゼロ刻み検知が働かないまま無限ループ**する | 手順6。`this.simTime + subDt <= this.simTime` と書くこと |
| `this.simTime = targetTime` にした結果、そのフレームのイベント処理・接触解決が飛ぶ | 打ち切りは既にエラーログ付きの異常系。飛ぶこと自体は現状より良いが、ログの文言を実態に合わせないと次に読む人が誤解する | 手順6 |
| `epoch` の一括置換が `STORY_EPOCH` / `StageClass.epoch` / `EPHEMERIS_PACK` / `ephemerisSeconds` / `EPOCH_T_OFFSET` を巻き込む | 手順3 で入れたばかりの正しい名前が壊れる。`EPOCH_T_OFFSET` は手順8 まで残す必要がある | 手順7。`\bepoch\b` と `AtEpoch` を別々に処理し、大文字の定数名とステージの静的宣言を先に除外すること |
| `epochOffsetSec` の置換のついでに `poleModelAtEpoch` 内のローカル `centuries` / `days` の式へ手を入れる | 自転位相が全天体でずれる。**式は正しい。名前だけを変える** | 手順7 |
| `jupiterMeanLongitude` の新テストを、`jupiterMeanLongitude` 自身や `JUPITER.orbit` の畳み込み結果を基準に書く | **現行テストと同じ自己参照**になり、ずれをまた見逃す | 手順8。基準は `motionOf(parts,'jupiter').helioStateAt(t)` — 運動の合成を通った実際の位置から取ること |
| 手順6・8 の新テストを、修正後に初めて走らせる | 「通ったから直った」のか「元から通る書き方だった」のか区別できない | 手順6・8。**修正前に落ちることを確認してから直す** |
| トロヤ群の許容 ±35° が、中心差(真黄経−平均黄経、木星で最大 ±2.8°)ぶんで境界に触れる | 秤動幅 30° + 中心差 2.8° = 32.8° で通るが余裕が薄い。新テストの許容は **±6°** に分けること | 手順8 |
| `EPOCH_T_OFFSET` をテストへ移すとき、`celestial-motion.test.ts:221,229,233` の「逆算の検算」の意図を落とす | この定数が何から導かれたかの説明が消え、値を触ってよいものと誤解される | 手順8。コメントごと移すこと |
| `KinematicState.t` のコメント「絶対 simTime [s]」を、契約を書いたからと消す | ここが契約の適用点そのもの。**残す**(むしろ CODING-RULE 1.9 を指す1語を足す) | 手順1・7 |
| main へ送る前に全層を回さない | CI が落ちると `release` が更新されず公開版が取り残される。手順2〜5・7 は `physics` と `game` の両方に跨る | 全手順後。`npm run typecheck` と `npm run test`(全層)を作業ブランチで通してから PR |
