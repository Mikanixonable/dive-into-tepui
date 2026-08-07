# Step1 実装手順 — 重力源(「重力を及ぼすもの」)の一般化

対象: `memos/hedalu244/better_simulation_todo.md` の **Step1**。
方針: 現状の中心天体まわりの実装は設計が悪いだけでなく既に壊れている(§1.3)。**挙動の維持は目標にしない。**
壊れた挙動を温存する分岐は残さず、正しい一つの経路に畳む。

---

## 0. 前提 — 「中心天体」「焦点」に混ざっている5つの別問題

現状のコードは `CentralBodyId` 一つで A と B を兼ねており、これが設計崩壊の根本原因。
さらに文章上は C・D も「中心天体」「焦点」という語で呼ばれがちだが、**5つはすべて別の責務で、
互いに疎結合であるべきものである。Step1 でこれらを束ねる新しい概念(「支配天体」のようなもの)を作らない。**

| # | 問題 | 誰が決めるか | Step1 での扱い |
|---|---|---|---|
| **A** | **積分にどの重力を入れるか** | 誰も選ばない。**常に全部** | 中心天体という概念自体を消す(§2.2) |
| **B** | **解析楕円(= 軌道要素)をどの天体中心で出すか** | 呼び出し側が明示的に選ぶ | 「最も強く引く天体を返す配線」と「ある天体中心に要素を出す配線」を**別々に**用意し、呼び出し側の1行で繋ぐ(§2.4) |
| **C** | **積分軌道(サンプル列)をどの座標系でベイクするか** | プレイヤーが GUI で選ぶ(既存の `Frame`) | **触らない。**既知の配線ミスがあるが別件(§2.5) |
| **D** | **overview カメラがどこを注視するか / カメラ自身の座標系** | プレイヤーが GUI で選ぶ(MAP VIEW パネル) | **触らない。**軌道表示とは無関係(§2.5) |
| **E** | **刻み幅・サンプル間隔を決める時間スケール** | 状態から導出 | B とは別の配線として用意する(§2.6) |

B と C を混ぜてはいけない理由: B は時刻とともに切り替わりうる量である。楕円は毎フレーム引き直す
瞬間的な表示なので切り替わってよいが、C は一つの時系列を一貫した系でベイクする必要があり、
途中で系が変わったら折れ線が破綻する。**B から C を導出してはならない。**

**用語**: 以下、「中心天体」は B の意味でのみ使い、カメラの注視対象には使わない。
`OrbitLine.sync` の引数 `focusPos`(頂点を密に置く位置)は B でも D でもない第三の意味なので、
`densifyNear` へ改名する(§3 フェーズ B-9)。

---

## 1. 現状調査

### 1.1 いま力がどう組まれているか

`OrbitEntity.step`(`src/physics/orbit-entity.ts:51`)が唯一の実シミュレーション積分口で、
`stepEnvRK4`(`src/physics/envaccel.ts:40`)→ `stepOrbitRK4`(`src/physics/orbital.ts:147`)と降りる。
合計の加速度は

```
a = −μ_E r/|r|³                                  … stepOrbitRK4 の中心重力(mu 引数)
  + μ_S(ρ_S/|ρ_S|³ − r_S/|r_S|³)                 … thirdBodyAccel(太陽)
  + μ_M(ρ_M/|ρ_M|³ − r_M/|r_M|³)                 … thirdBodyAccel(月)
  + j2Accel(r) + dragAccel(r,v,bcInv) + thrust    … 地球固有 + 機体固有
```

**重要な事実:** 上の第三体項の「−μ_b r_b/|r_b|³」は、地球(= ECI 原点)自身が太陽・月に引かれて
加速していることの補正項そのもの、つまり better_simulation_todo.md が言う「地球座標系の公転によって
生まれる遠心力(見かけの力)」である。したがって **現行の earth 経路は既に「地球・月・太陽の
3体の重力を ECI で正しく解いたもの」と数式上まったく等価**であり、Step1 の書き換えは earth 経路に
関しては**純粋なリファクタ(値が1ビットも変わらない)**になる。これは回帰テストで守れる(§4-1)。

一方 `mu` 引数・`central-body.ts` 経由の **moon 経路は「月の二体だけを解き、地球と太陽を捨てる」**
ものなので、earth 経路より厳密に劣る。Step1 で削除する。

### 1.2 中心天体を意識している箇所(全数)

| 場所 | 内容 | §0 の分類 |
|---|---|---|
| `src/physics/central-body.ts` 全体 | `CentralBodyId`/`CENTRAL_BODIES`/`to|fromCentralBodyState`。mu・半径の第二の定義元 | A+B 混在 |
| `physics/orbit-entity.ts:77-97` | `stepMoonPrediction`(月中心の純二体伝播) | A |
| `physics/orbit-entity.ts:25,38-43` | `elements` メモ(地心固定) | B |
| `physics/orbital.ts:147` | `stepOrbitRK4(…, mu = MU_EARTH)` | A |
| `physics/orbital.ts:127-143` | `thirdBodyAccel`(§1.1 より不要になる) | A |
| `physics/orbital.ts:228,273,304` | `elementsFromState(mu 既定)` / `timeSincePeriapsis` と `velocityOnOrbit` は **MU_EARTH 直書き** | B |
| `physics/envaccel.ts:27-33` | `envAccel` が太陽・月を名指しでハードコード | A |
| `game/game-entity/game-entity.ts:25,57,62,68-85,128-132` | `predictionCentralBody` / `centralBodyRelativeState` / `elementsForPredictionBody` / `stepPrediction` の月分岐 | A+B 混在 |
| `game/game-entity/ship.ts:28-30` | 同引数のたらい回し | A+B |
| `game/player/player.ts:76-78,385-397` | 同引数 + `moonOrbitTrace`(中心天体が月のときだけ楕円をやめて積分列を描く) | B+C 混在 |
| `game/simulation/predictor.ts:52` | 刻み幅を中心天体相対動径から決める | E |
| `game/plan/plan.ts:11-15,32,99` | `Plan.centralBody` と `orbitPeriodOf(state, body, …)` | A+B+E 混在 |
| `game/plan/plan-arc.ts:26-28,102-127` | `stepDt` が MU_EARTH 固定 + 月専用の積分分岐 | A+E |
| `game/plan/plan-display.ts:105,151-166` | 月相対の要素・アプシス。`rp > body.soiRadius` の非表示ハック | B |
| `game/plan/plan-editor.ts:95,160-166,526,632,640` | 基準天体 SegmentedControl(navball パネルに間借り)と `bodyState` | B |
| `game/stages/creative-stage.ts:172` | 配置フォームの `form.body` を艦の `predictionCentralBody` として永続化 | A+B |
| `tests/physics/plan.test.ts` | `CENTRAL_BODIES` 依存 | — |

### 1.3 既に壊れている点(挙動を維持してはいけない理由)

1. **月中心の時刻計算が地球の μ で行われる。** `timeSincePeriapsis`(`orbital.ts:273`)と
   `velocityOnOrbit`(`orbital.ts:304`)が `MU_EARTH` を直書きしているため、月中心の `Elements` を
   渡している `plan-display.ts:109,162`(Pe/Ap 通過時刻)と `plan-editor` の Δv 表示が誤値になる。
   `Elements` が μ を持っていないので、型では防げない。
2. **予測と実シミュレーションが別の物理を解いている。** `predicted` は `stepMoonPrediction`(月の
   純二体)、`current` は地球中心+第三体。両者は必ず乖離し、`resyncPrediction` の
   `PREDICT_RESET_DIST`(500 m)を超えた時点で予測列が捨てられる。月周回 100 km での地球潮汐差は
   約 2.6e-5 m/s² なので、数千秒で 500 m を超える見積もり ⇒ 月周回の予測線は伸びきる前に
   作り直され続ける。ワープ中は常に破棄される。
3. **中心天体がコンストラクタ固定。** 地球↔月の遷移軌道はどちらを選んでも必ず片方が破綻する。
   `predictionCentralBody` は状態から導ける量を設定として持ってしまっている(= 正データの重複)。
4. **刻み幅とサンプル間隔が地心基準のまま(E の破綻)。** `Predictor.advanceBudget`(`predictor.ts:52`)は
   'earth' 指定の艦では地心動径(月近傍で 3.8e8 m)から `stepDtForRadius` → 600 s に張り付き、
   周期 2 時間弱の月周回を十数ステップで回そうとする。`GameEntity.sampleInterval` も地心の周期
   (≈1か月)基準になるため間隔が数万秒になる。
5. **`Player.moonOrbitTrace`(`player.ts:385-397`)は B の破綻を C の仕組みで埋め合わせたもの。**
   「楕円の中心が地球固定で月周回が描けない」ことへの回避策として、中心天体が月のときだけ
   積分列の折れ線に差し替えている。B と C の混線そのもの。
6. **`plan-display.ts:157-159` の SOI 非表示ハック**は、中心天体が手動選択で間違いうることの
   対症療法。中心天体を状態から決められるようにすれば不要。

---

## 2. Step1 の設計

### 2.1 「重力を及ぼすもの」= `Attractor`

新設 `src/physics/attractor.ts`。better_simulation_todo.md の「OrbitState に質量を加えたような
共通インターフェイス」がこれ。

```ts
export type AttractorId = 'earth' | 'moon' | 'sun';

// 重力を及ぼすもの。位置・速度は ECI(地球は原点に静止)。
export type Attractor = {
  readonly id: AttractorId;
  readonly mu: number;        // GM [m³/s²]
  readonly radius: number;    // 表面半径 [m](高度表示・地表衝突判定に使う)
  readonly state: OrbitState; // ECI
};
```

- **作用圏半径のようなフィールドは持たせない。** better_simulation_todo.md の「影響半径」は
  Step2/3 で入る**グローバルな打ち切り距離**(「この半径より遠い天体は計算しない」)であって、
  天体ごとの排他的な縄張りではない。両者は別物なので、前者を天体の属性として先取りしない。
- **ラベル(表示名)も持たせない。** 表示名は HUD の責務(`hud/frame-labels.ts` と同じパターンで
  id → 表示名の表を HUD 側に置く)。現在 `CENTRAL_BODIES` が持っている `label` の移設先は HUD。
- 「重力を受けるもの」は既存の `OrbitState` を持つもの(`OrbitEntity`)で足りる。**両方を持つもの
  (小惑星)は Step2/3 の話なので、Step1 では型を作らない。**

### 2.2 加速度の組み立て — 中心天体という概念を消す(A)

ECI は地球自身が加速しているため慣性系ではない。ある天体 b が ECI の運動方程式へ寄与する
加速度は、**直接引力から「原点天体が b から受ける引力」を引いた差分**である:

```
pull(r, b)           = μ_b (r_b − r) / |r_b − r|³     （|r_b − r| = 0 なら 0 = 自分自身）
attractorAccel(r, b) = pull(r, b) − pull(0, b)        （原点天体は r_b = 0 なので第2項が消え、直接引力そのもの）

a_eci(r, v) = Σ_b attractorAccel(r, b)                ← 重力 + 見かけの力(§1.1 と厳密に等価)
            + j2Accel(r)                              ← 地球固有(Step1 では一般化しない)
            + dragAccel(r, v, bcInv) + thrust         ← ExtraAccel のまま据え置き
```

`attractor.ts` の公開関数はこの分解をそのまま写す:

```ts
// 位置 r が全天体から受ける重力加速度の和。距離ゼロの天体(自分自身)は飛ばす。
export function gravityAccel(r: Vec3, bodies: readonly Attractor[]): Vec3;

// 天体 b が ECI の運動方程式へ寄与する加速度(上式)。
export function attractorAccel(r: Vec3, body: Attractor): Vec3;
```

恒等式 `Σ_b attractorAccel(r, b) === gravityAccel(r, bodies) − gravityAccel(0, bodies)` が成り立つ
(`gravityAccel(0, …)` は距離ゼロ規則で原点天体を飛ばすので、ちょうど原点天体の加速度になる)。
**積分側は右辺を使う** — 第2項はステップ内で定数なので RK4 の4段の外で1回だけ評価できるため
(現行 `thirdBodyAccel` は段ごとに `|r_b|^1.5` を再計算しており、そのぶん新実装のほうが速い)。
この恒等式はテストで守る(§4-3)。

実装の注意:
- `Math.pow(x, 1.5)` を使わず `d2 * Math.sqrt(d2)` で割る(既存 `stepOrbitRK4` の中心重力と同じ書き方)。
  天体ごとに `Vec3` を作らず、スカラで足して最後に1つ返す。
- **桁落ちを心配しなくてよい。** 太陽の直接項 5.9e-3 m/s² を LEO の中心重力 8.6 m/s² と同じ
  アキュムレータに足すときの丸めは約 1.9e-15 m/s²、これに対し月の潮汐差は 1.2e-6 m/s²。
  相対誤差 1e-9 なので Kahan 加算などは不要(この見積もりはコードにコメントとして残さない)。

### 2.3 モジュール構成(改名を含む)

| ファイル | 責務 |
|---|---|
| `physics/attractor.ts` **(新設)** | `Attractor` 型、重力の合算と分解、中心天体選びの材料、天体相対変換 |
| `physics/ephemeris.ts` | `attractorsAt(t): readonly Attractor[]` を追加。地球/月/太陽の表はここが唯一の定義元 |
| `physics/dynamics.ts` **(`envaccel.ts` を改名)** | 全項の合成と RK4 1ステップ(`stepDynamicsRK4`) |
| `physics/atmosphere.ts` | `EARTH_OMEGA` / `airspeed` / `dragAccel` を `envaccel.ts` から移設(大気の物理は1モジュールに) |
| `physics/orbital.ts` | 二体問題・ケプラー・`j2Accel`・RK4 の器。**中心重力と mu 既定値を持たない** |
| `physics/central-body.ts` | **削除** |

`stepOrbitRK4` は「中心重力 + 追加加速度」ではなく「**与えられた加速度で `OrbitState` を1ステップ
進めるだけ**」にする(`mu` 引数と内蔵中心重力を削除、`extraAccel` は必須引数)。
これで better_simulation_todo.md の「RK4 ステップの計算に中心天体は関係ない」が型で保証される。

### 2.4 解析楕円の中心天体は「選ぶ配線」と「使う配線」に分ける(B)

**一つにまとめた関数を作らない。**`attractor.ts` は次の2本を別々に提供し、繋ぐのは呼び出し側の1行にする。

```ts
// 位置 r で最も強く重力を及ぼしている天体(|attractorAccel| が最大)。
// 「何のためにどの天体を選ぶか」は呼び出し側の判断で、この関数は材料を一つ返すだけ。
export function strongestAttractor(r: Vec3, bodies: readonly Attractor[]): Attractor;

// 天体 body を中心とする接触軌道要素。中心の選び方には関与しない。
export function elementsAround(s: OrbitState, body: Attractor): Elements | null;

// 天体中心相対 ⇄ ECI(elementsAround の内部でも使う)。
export function relativeTo(s: OrbitState, body: Attractor): OrbitState;
export function toAbsolute(rel: OrbitState, body: Attractor): OrbitState;
```

呼び出し側は必ずこの形で、選択が1行として見えるように書く:

```ts
const center = strongestAttractor(e.state.r, bodies); // ← ここを GUI 選択に差し替えられる
e.orbitLine.sync(e.elementsAround(center), fo, force, e.state.r, center.state.r);
```

**Step1 では中心天体を選ぶ GUI を作らない。**必要になったら上の1行を差し替えるだけで済むよう、
`strongestAttractor` と `elementsAround` を密結合させないことだけを守る。

**比較の基準は `attractorAccel`(ECI の運動方程式に実際に現れる寄与)であって、素の引力 μ/d² ではない。**
素の引力で比べると、地心 2.6×10⁵ km 以遠では太陽が地球に勝ってしまい(ECI が太陽と一緒に自由落下
していることを無視した比較になるため)、月遷移軌道の途中で楕円の中心が太陽に飛ぶ。`attractorAccel` で
比べると入れ替わりは月から約 3.8×10⁴ km、太陽とは地心約 1.7×10⁶ km となり、実際の運動と整合する。
この量は積分が毎ステップ組んでいる項そのものなので、新しい近似も新しい定数も持ち込まない。

**中心天体は時刻とともに切り替わりうる。**楕円は毎フレーム引き直す瞬間的な表示なので問題ないが、
この性質があるため C(§2.5)に使ってはいけない。

### 2.5 積分軌道のベイク系(C)とカメラ(D)には触らない

- **C**: `physics/frame.ts` の `Frame`(`inertial`/`sunRotating`/`moonRotating`)と
  `render/sampled-line.ts` のベイク処理、`PlanDisplay.trajectoryFrame` とその GUI は
  **現状のまま**。B から自動導出してはいけない(§0)。
- **D**: `OverviewCamera.focus`(注視対象)と `cameraFrame`(カメラ自身の系)、および
  それらの GUI(`camera/overview-camera-panel.ts` = MAP VIEW パネルの「注視」「視点」)も
  **現状のまま**。軌道表示とは無関係の別責務で、カメラ関連 GUI は既にこのパネルに集約されている。

**既知の未修正バグ(Step1 のスコープ外、混同しないこと):** 「月回転系にしても予測軌道が月を周回する
形で表示されない」(`memos/mikanixonable/dev.md:741`)。原因は `DebugHistoryLine.sync` に渡すベイク系が
マニューバ計画用の `planDisplay.trajectoryFrame` になっており、エンティティの積分軌道表示が自分の
設定を持っていないこと(`memos/mikanixonable/map-orbit-display-fixes.md` 問題2)。
これは C の中の配線ミスであって A/B とは無関係。**Step1 では直さないし、ついでに触りもしない。**

### 2.6 「時間スケール」は中心天体とは別の配線にする(E)

刻み幅とサンプル間隔が要るのは「軌道要素の中心天体」ではなく**その場の軌道運動の時間スケール**である。
別々の名前で提供し、要素側の都合と混ざらないようにする。

```ts
// 位置 r における軌道運動の時間スケール [s]。最も強く引く天体まわりの円軌道周期。
// 刻み幅・サンプル間隔を決めるためのもので、「その天体を中心に軌道要素を出す」こととは無関係。
export function localOrbitPeriod(r: Vec3, bodies: readonly Attractor[]): number;
```

使う場所: `GameEntity.sampleInterval` / `Predictor.advanceBudget` の刻み幅 / `PlanArc.stepDt` /
`plan.ts` の `orbitPeriodOf`。どれも現在は地心動径と `MU_EARTH` 固定で、§1.3-4 の破綻の原因になっている。

### 2.7 `Elements` が μ を持つ

`Elements` に `readonly mu: number` を追加し、`timeSincePeriapsis`/`velocityOnOrbit` は
`el.mu` を読む(§1.3-1 の修正)。あわせて **`elementsFromState` / `keplerPeriod` /
`semiMajorFromPeriod` / `stateFromElements` の `mu` 既定値を撤廃して必須引数にする。**
「天体を意識してよいのは要素への変換と描画だけ」という規則を、変換側では**必ず意識させる**ことで
担保する(既定値があると `plan-trajectory.ts:69,73` のように無自覚に地心で計算する呼び出しが混ざる)。

### 2.8 呼び出し規約 — `attractorsAt` を同一ステップで二度引かない

`attractorsAt(t)` は既存の `sunPosAt`/`moonPosAt` と同じ理由(1サブステップ内で全エンティティが
同じ時刻を引く)で**メモ化必須**。返す配列も含めて不変なので呼び出し側からは区別できない。
これをやらないと 850 体 × 64 サブステップぶんの配列確保と三角関数評価が毎フレーム走る。

**メモは直近2件持つこと。** ステップ中点(積分用)とステップ始点(刻み幅・サンプル間隔の決定用)が
交互に引かれる呼び出しが構造上避けられず、1件だと全滅する。理由をコメントに残す。

あわせて、`OrbitEntity.step` は `Ephemeris` ではなく **`readonly Attractor[]` を受け取る**形へ変える
(そのステップぶんの値は呼び出し側が確定させる、という `stepEnvRK4` の既存方針と同じ)。
`OrbitEntity` が `Ephemeris` に依存しなくなるのは副次的な利点。

---

## 3. 実装手順

各フェーズ末で `npm run typecheck` が緑になるように並べてある。`npm run test:physics` は
`src/physics/` を触るフェーズ(A・B)で必ず走らせる。

### フェーズ A — physics 層に重力源を用意する(既存経路の挙動は変えない)

1. `src/physics/attractor.ts` を新設(§2.1・2.2・2.4・2.6)。
   `gravityAccel` / `attractorAccel` / `strongestAttractor` / `localOrbitPeriod` /
   `elementsAround` / `relativeTo` / `toAbsolute`。
2. `Ephemeris` に `attractorsAt(t)` を追加(§2.8 のメモ化つき)。地球は原点静止、月は
   `moonPosAt`/`moonVelAt`、太陽は `sunPosAt` と新設の `sunVelAt`(月と同じく中心差分で出す —
   軌道モデルを二重に持たない)。`MU_SUN`/`MU_MOON`/`R_MOON` はここに既にある。
   `CENTRAL_BODIES` の mu・半径はこの表に吸収して、定義元を一つにする。
3. `Elements.mu` を追加し、`timeSincePeriapsis`/`velocityOnOrbit` を `el.mu` 参照に直す(§2.7)。
4. `elementsFromState`/`keplerPeriod`/`semiMajorFromPeriod`/`stateFromElements` の `mu` 既定値を
   撤廃し、全呼び出し側(`grep -rn "elementsFromState\|keplerPeriod\|semiMajorFromPeriod\|stateFromElements" src tests`)
   に明示させる。この時点ではまだ `MU_EARTH` を渡すだけの箇所が多くてよい。
5. **検証テストを先に書く**(§4-1 の等価性テスト)。この時点ではまだ赤でよい。

### フェーズ B — 積分経路を一本化する(A)/ 楕円の中心天体を選べるようにする(B)

1. `stepOrbitRK4` から中心重力と `mu` を外す(§2.3)。`extraAccel` を必須に。
2. `envaccel.ts` → `physics/dynamics.ts` に改名。`EARTH_OMEGA`/`airspeed`/`dragAccel` は
   `atmosphere.ts` へ移設(`player/thermal.ts:3` の import 先も直す)。
   `stepDynamicsRK4(state, dt, bodies, bcInv, thrust)` が §2.2 の式を組む。
   原点項(`gravityAccel(0, bodies)`)は4段の外で1回だけ評価する。
3. `orbital.ts` の `thirdBodyAccel` を削除(§1.1 より不要)。
4. `OrbitEntity`:
   - `step(dt, bodies, bcInv, thrust, sampleInterval, keepDuration)` へ(§2.8)。
   - `stepMoonPrediction` を削除。
   - `elements` メモを削除(地心固定なので中心天体の指定に置き換わる。移設先は次項)。
5. `GameEntity`:
   - `predictionCentralBody` / `centralBodyRelativeState` / `elementsForPredictionBody` を削除。
   - `elements` ゲッタを **`elementsAround(body: Attractor)` メソッド**にする(中心は呼び出し側が
     渡す — §2.4)。`state` の参照同一性と `body.id` でメモ化する(`OrbitState` は不変で step ごとに
     差し替わるので `this._memoState !== this.state` で無効化できる)。
   - `stepSim(dt, ephemeris)` は `const bodies = ephemeris.attractorsAt(state.t + dt/2)` を1回引き、
     `current.step` と `sampleInterval` の両方に渡す。
   - `sampleInterval` は `localOrbitPeriod(state.r, bodies)` から決める(§2.6)。
     **`historyDuration === 0` のときは評価しない** — 弾・薬莢・破片は間隔を使わないのに
     現状は毎サブステップ `elementsFromState` を払っている。
   - `stepPrediction` の月分岐を削除。積分打ち切りは `altitudeOf`(地球固定)ではなく
     **いずれかの天体の表面 + `REENTRY_ALT` を割ったら打ち切り**にする(月面に突っ込む予測が
     月の内部を突き抜けてでたらめなスイングバイを描くのを止める。楕円の中心天体とは無関係)。
   - 呼び出し側の署名変更: `enemy.ts:289 syncBackgroundOrbitLine` / `targeter.ts:158-159 sync` /
     `plan-guide.ts:90` / `hud/panel.ts:83-84` / `nav-target.ts:62,101` が `bodies`(または
     `ephemeris`)を受け取り、**それぞれの場所で `strongestAttractor` を1行呼んで中心天体を選ぶ**。
     `Game.ephemeris` は private なので、渡し方は各所有者の `sync`/`update` 引数に足す
     (`Game` に public getter を生やしてついでに参照させる形にはしない)。
6. `Ship`/`Player`/`CreativeStage` から `predictionCentralBody` 引数を削除。
   `creative-stage.ts:172` は `form.body` を初期状態の計算(`buildElementsState`)にだけ使う
   (配置フォームの基準天体は「初期状態を何で入力するか」であって B ではない。仕様は現状のまま)。
7. **`Player.moonOrbitTrace` を削除**し(`player.ts:59,101,385-397,431-433`)、軌道線は
   「中心天体を選ぶ → その中心で楕円を描く」の1経路にする。これは §1.3-5 のとおり B の破綻を
   C で埋め合わせた回避策であり、楕円が月を中心に描けるようになれば存在理由が消える。
   **積分軌道の折れ線表示そのものは C の機能として別に存在すべきもので、ここで消すわけではない**
   (`DebugHistoryLine` が担っている。その配線ミスは §2.5 のとおり別件)。
8. `Predictor.advanceBudget` の刻み幅を `localOrbitPeriod` 基準にする。
9. `OrbitLine.sync` の引数 `focusPos` を `densifyNear` へ改名する(§0 の用語衝突の解消)。

### フェーズ C — plan 側と `central-body.ts` の撤去

1. `plan.ts`: `Plan.centralBody` を削除(データモデルが表示設定を持っているのが誤り)。
   `orbitPeriodOf(state, bodies)` は `localOrbitPeriod` を使う。
2. `plan-arc.ts`: 月専用の積分分岐(102-127)を削除して1経路に。`stepDt` は `localOrbitPeriod`。
   打ち切りはフェーズ B-5 と同じ全天体の表面判定。
3. `plan-display.ts`: アプシスの要素・通過時刻・高度を `strongestAttractor` → `elementsAround` の
   1行で選んだ中心天体で求める。**SOI 非表示ハック(157-159)を削除**(中心天体が状態から決まれば
   「別天体の軌道を誤って描く」状態自体が起きない)。TRAJECTORY パネルには何も足さない
   (あそこは C の設定を置く場所であって B の場所ではない)。
4. `plan-editor.ts`: **基準天体 SegmentedControl(95,160-166,212)を削除する。**
   これは A と B を兼ねた手動選択で、A は消え B は導出になるため置き換え先の GUI を作らない
   (navball パネルへの間借りも消える)。`bodyState`(526)は選んだ中心天体相対へ。
   `planPanelHtml` の `warnAtmosphere` は中心天体が地球かどうかで決める。
5. `plan-trajectory.ts:57,174` の `plan.centralBody` 受け渡しを削除。
6. `src/physics/central-body.ts` を削除。`grep -rn "centralBody\|CentralBody\|central-body" src tests`
   が 0 件になることを確認する(**旧名のエイリアスも互換分岐も残さない**)。
7. `tests/physics/plan.test.ts` を新 API で書き直す。

### フェーズ D — 文書

- `CLAUDE.md`: Architecture の `physics/orbital.ts`・`physics/envaccel.ts`・`physics/ephemeris.ts`・
  `physics/orbit-entity.ts`・`game-entity.ts`・`predictor.ts`・`plan/*` の記述を書き換える。
  `envaccel.ts` の項は `dynamics.ts` へ。`attractor.ts` の項を新設し、**§0 の A〜E の分離を
  一段落で明記する**(ここが後から一番崩れやすい)。**古い記述は消す**(「以前は月中心だった」の類は書かない)。
- `DEVELOP/OWNERSHIP.md`: `Attractor` 列は `Ephemeris` が毎回作って返す派生値で誰も保持しないこと、
  楕円の中心天体は状態から導く派生値であって誰の状態でもないことを明記。
  `predictionCentralBody`/`Plan.centralBody` の行を削除。
- `DEVELOP/CALLSTACK.md`: `stepMoonPrediction` の分岐を削除、`attractorsAt` の呼ばれる位置を追加。
- `DEVELOP/SPEC.md`:
  - **解析楕円の中心天体が地球固定でなくなる**ことを書く(プレイヤーから見える挙動の変化)。
  - **「月基準の宇宙船軌道表示」(253-255 行)は書き換えない。** あれは C(月回転系での積分軌道表示)の
    仕様であり、そのまま実装されるべきもの。§2.5 の既知バグはこの仕様が満たされていないという報告。
  - 「軌道要素方式の基準天体」(330 行)も書き換えない(配置フォームの入力方式の話 = フェーズ B-6)。
- `memos/hedalu244/better_simulation_todo.md` の Step1 節を完了ぶん削除する(todo リストなので
  経緯は残さない)。

---

## 4. 検証

`npm run typecheck` と `npm run test:physics` は必須。以下を `tests/physics/` に足す。

1. **等価性(最重要)**: 新 `stepDynamicsRK4(s, dt, [earth,moon,sun], 0, null)` の1ステップが、
   テスト内にローカルで書いた旧式(`−μ_E r/r³` + `thirdBodyAccel` × 2 を RK4 に渡したもの)と
   機械精度で一致すること。**これが「earth 経路の挙動が変わっていない」証明**。
   旧式は本体から消えるのでテストファイル内に写経する。
2. `gravityAccel` が距離ゼロの天体を飛ばして有限値を返すこと。
3. **分解の恒等式**: `Σ_b attractorAccel(r, b) === gravityAccel(r, bodies) − gravityAccel(0, bodies)`
   (§2.2)。積分側と中心天体選び側が同じ分解を見ていることの担保。
4. `strongestAttractor`: LEO → earth / 月から 30,000 km → moon / 月から 50,000 km → earth /
   地心 1e9 m → earth / 地心 5e9 m → sun。**素の引力比較なら地心 1e9 m で sun になってしまう**
   ので、このケースが §2.4 の基準を守る回帰になる。
5. `localOrbitPeriod`: LEO で約 5,580 s、月面 +100 km で約 7,066 s。
6. `elementsAround` + `Elements.mu` の伝搬: 月を中心とする円軌道の `tofBetween(el, 0, π)` が
   `keplerPeriod(a, MU_MOON)/2` に一致すること(§1.3-1 の回帰)。
7. `Ephemeris.attractorsAt`: 同一 `t` で同じ配列参照が返ること、`t` を交互に2値で引いても
   両方メモに乗ること(§2.8)、`moonPosAt`/`sunPosAt` と整合すること。
8. **月周回の1周回テスト**: 月面 +100 km の円軌道(周期 ≈ 7,066 s)を ECI で1周期積分し、
   月相対の位置が数十 km 以内で戻ること。地球の潮汐差ぶんはずれるので許容幅は緩めに取り、
   「実測値をピン留めする」既存テストの流儀に合わせる。

実行時確認(ユーザーが求めた場合のみ `/verify`): クリエイティブモードで月周回に艦を配置し、
①解析楕円が月を中心として出る ②予測線が破棄され続けずホライズンまで伸びる
③マニューバノードを置いて Pe/Ap 通過時刻が月の周期と整合する
④①〜③が MAP VIEW の「注視」「視点」や TRAJECTORY の座標系設定を変えても変わらない(B と C・D の独立性)。
`?perf=1` で update フェーズの時間が悪化していないことも見る(§2.2 のとおり理論上は改善するはず)。

---

## 5. Step1 でやらないこと

- 「重力を及ぼし、かつ受けるもの」(小惑星)の型。**早急な一般化にあたるので作らない。**
  `Attractor` を「`OrbitState` + μ を持つ平坦なデータ」に保っておけば、将来 `OrbitEntity` から
  作れる、という余地だけ残す。
- 木星などの惑星の追加、`Ephemeris` の天体ごとの分割(Step2)。
- **グローバルな影響半径による打ち切り**と質量ハードリミット、spatial hash(Step2/3)。
  §2.1 のとおり、これは天体ごとの属性ではなくグローバルな設定として後で入る。
- **C(ベイク系)と D(カメラ)まわり一切**(§2.5)。とくに `DebugHistoryLine` のベイク系配線ミス
  (`dev.md:741` / `map-orbit-display-fixes.md` 問題2)は別件として残す。
- 解析楕円の中心天体を選ぶ GUI。導出に一本化し、必要になったら §2.4 の1行を差し替える。
- J2 の一般化(天体ごとの扁平項)。地球固有のまま `dynamics.ts` で足す。
- ゲームルールとしての喪失判定(`GameEntity.checkLoss` の再突入高度)は**地球のみのまま**。
  月面衝突で機体が失われる仕様は Step1 のスコープ外(予測列の打ち切りだけ全天体基準にする)。
- 戦闘ビューの方位マーカー(`orbitalAxes` が地心速度基準)の中心天体対応。
  配線が揃えば直せるが、Step1 の目的(重力源の一般化)とは別の仕様変更なので
  `memos/hedalu244/feature_todo.md` へ回す。

---

## 6. 確定した判断(この文書の前提)

1. **解析楕円の中心天体に GUI は作らない。** `strongestAttractor` で導出し、
   `plan-editor` の基準天体 SegmentedControl は置き換えずに削除する(フェーズ C-4)。
   `strongestAttractor` と `elementsAround` を密結合させないので、後から GUI 選択に
   差し替えるのは呼び出し側1行の変更で済む。
2. **カメラ関連 GUI(D)は MAP VIEW パネル(`camera/overview-camera-panel.ts`)に既に集約されており、
   Step1 では触らない。** 楕円の中心天体を navball にも TRAJECTORY にもカメラパネルにも置かない
   (そもそも GUI を作らないため)。
3. **`DEVELOP/SPEC.md:253-255`(月回転系での積分軌道表示)は C の仕様なので書き換えない。**
   Step1 で消すのは `Player.moonOrbitTrace`(中心天体で分岐する B の回避策)だけで、
   C の機能そのものは `SampledLine` + `Frame` 経路として残る。

### 作業中に見つけた小さな逸脱(Step1 では直さない、`feature_todo.md` 行き)

- MAP VIEW パネル(カメラ用)に「弾薬」トグルが同居している(`overview-camera-panel.ts:35-40`)。
  カメラ関連 GUI の集約という観点では逆向きの混在。
