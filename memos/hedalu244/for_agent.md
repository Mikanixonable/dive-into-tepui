# 重力源の一般化 — 残作業

対象: `memos/hedalu244/better_simulation_todo.md` の **Step1**。
方針: 中心天体まわりの旧実装は設計が悪いだけでなく壊れていた。**挙動の維持は目標にしない。**

**フェーズ A(physics 層の土台)と B(積分の一本化・楕円の中心天体)は完了。** 残りは **C → D**。

---

## 0. 前提 — 「中心天体」「焦点」に混ざっている5つの別問題

**5つはすべて別の責務で、互いに疎結合であるべきものである。これらを束ねる新しい概念
(「支配天体」のようなもの)を作らない。**

| # | 問題 | 誰が決めるか | 状態 |
|---|---|---|---|
| **A** | **積分にどの重力を入れるか** | 誰も選ばない。**常に全部** | 済(中心天体という概念が消えた) |
| **B** | **解析楕円(= 軌道要素)をどの天体中心で出すか** | 呼び出し側が明示的に選ぶ | 済(`strongestAttractor` → `elementsAround` の2行)。**plan 側だけ未対応(フェーズ C)** |
| **C** | **積分軌道(サンプル列)をどの座標系でベイクするか** | プレイヤーが GUI で選ぶ(既存の `Frame`) | **触らない。**既知の配線ミスがあるが別件(§2.3) |
| **D** | **overview カメラがどこを注視するか / カメラ自身の座標系** | プレイヤーが GUI で選ぶ(MAP VIEW パネル) | **触らない。**軌道表示とは無関係(§2.3) |
| **E** | **刻み幅・サンプル間隔を決める時間スケール** | 状態から導出 | 済(`localOrbitPeriod`)。**plan-arc の `stepDt` だけ未対応(フェーズ C)** |

B と C を混ぜてはいけない理由: B は時刻とともに切り替わりうる量である。楕円は毎フレーム引き直す
瞬間的な表示なので切り替わってよいが、C は一つの時系列を一貫した系でベイクする必要があり、
途中で系が変わったら折れ線が破綻する。**B から C を導出してはならない。**

---

## 1. 残っている中心天体依存

| 場所 | 内容 | §0 の分類 |
|---|---|---|
| `src/physics/central-body.ts` 全体 | `CentralBodyId`/`CENTRAL_BODIES`/`to|fromCentralBodyState`。mu・半径が `Ephemeris.attractorsAt` の表と二重定義になっている | A+B 混在 |
| `game/plan/plan.ts:11-15,32,99` | `Plan.centralBody` と `orbitPeriodOf(state, body, …)` | B+E 混在 |
| `game/plan/plan-arc.ts:26-28` | `stepDt` が `keplerPeriod(r, MU_EARTH)` 固定 | E |
| `game/plan/plan-display.ts:105,151-166` | 月相対の要素・アプシス。`rp > body.soiRadius` の非表示ハック(中心天体が手動選択で間違いうることの対症療法) | B |
| `game/plan/plan-editor.ts:95,160-166,526,632,640` | 基準天体 SegmentedControl(navball パネルに間借り)と `bodyState` | B |
| `tests/physics/plan.test.ts` | `CENTRAL_BODIES` 依存 | — |

---

## 2. 設計

### 2.1 使える土台(`src/physics/attractor.ts` / `ephemeris.ts`、実装済み)

```ts
type Attractor = { id: 'earth'|'moon'|'sun'; mu: number; radius: number; r: Vec3; v: Vec3 };

gravityAccel(r, bodies)          // Σ μ_b (r_b − r)/|r_b − r|³。距離ゼロ(自分自身)は飛ばす
attractorAccel(r, body)          // その天体が ECI の運動方程式へ寄与する加速度
strongestAttractor(r, bodies)    // |attractorAccel| が最大の天体 = B の材料
localOrbitPeriod(r, bodies)      // その場の軌道運動の時間スケール [s] = E
relativeTo(s, body) / toAbsolute(rel, body)
elementsAround(s, body)          // body を中心とする接触軌道要素 = B の使い手

Ephemeris.attractorsAt(t)        // [earth, moon, sun]。直近2件メモ化、同一 t は同じ配列参照
Elements.mu                      // 中心天体の重力定数。timeSincePeriapsis/velocityOnOrbit が読む
stepDynamicsRK4(state, dt, bodies, bcInv, thrust)  // physics/dynamics.ts
```

`elementsFromState` / `keplerPeriod` / `semiMajorFromPeriod` / `stateFromElements` の `mu` は
**既定値なしの必須引数**。「天体を意識してよいのは要素への変換と描画だけ」という規則を、
変換側では必ず意識させることで担保している。**この既定値を復活させないこと。**

B の使い方は必ずこの形で、選択が1行として見えるように書く:

```ts
const center = strongestAttractor(s.r, bodies); // ← ここを GUI 選択に差し替えられる
const el = elementsAround(s, center);
// 軌道線を描くなら中心天体の位置も渡す(densifyNear は中心天体相対座標)
orbitLine.sync(el, fo, force, sub(s.r, center.r), center.r);
```

**中心天体を選ぶ GUI は作らない。**必要になったら上の1行を差し替えるだけで済むよう、
`strongestAttractor` と `elementsAround` を密結合させないことだけを守る。

比較の基準は `attractorAccel`(ECI の運動方程式に実際に現れる寄与)であって素の引力 μ/d² では
ない。素の引力で比べると地心 2.6×10⁵ km 以遠で太陽が地球に勝ち、月遷移軌道の途中で楕円の
中心が太陽に飛ぶ。回帰テストあり。

### 2.2 呼び出し規約 — `attractorsAt` の使い回し

`attractorsAt(t)` は 1 サブステップ内で全エンティティが同じ時刻を引くことを前提にメモ化して
ある。**同一ステップの中で異なる t を何度も引くと台無しになる**ので、呼び出し側は1回引いた
配列を使い回すこと(例: `GameEntity.stepSim` は中点で1回引き、`current.step` と
`sampleInterval` の両方に渡す)。

### 2.3 積分軌道のベイク系(C)とカメラ(D)には触らない

- **C**: `physics/frame.ts` の `Frame`、`render/sampled-line.ts` のベイク処理、
  `PlanDisplay.trajectoryFrame` とその GUI は**現状のまま**。B から自動導出してはいけない。
- **D**: `OverviewCamera.focus` と `cameraFrame`、および `camera/overview-camera-panel.ts`
  (MAP VIEW パネルの「注視」「視点」)も**現状のまま**。カメラ関連 GUI は既にここに集約されている。

**既知の未修正バグ(スコープ外、混同しないこと):** 「月回転系にしても予測軌道が月を周回する
形で表示されない」(`memos/mikanixonable/dev.md:741`)。原因は `DebugHistoryLine.sync` に渡すベイク系が
マニューバ計画用の `planDisplay.trajectoryFrame` になっており、エンティティの積分軌道表示が自分の
設定を持っていないこと(`memos/mikanixonable/map-orbit-display-fixes.md` 問題2)。
これは C の中の配線ミスであって A/B とは無関係。**直さないし、ついでに触りもしない。**

---

## 3. 残りの実装手順

### フェーズ C — plan 側と `central-body.ts` の撤去

1. `plan.ts`: `Plan.centralBody` を削除(データモデルが表示設定を持っているのが誤り)。
   `orbitPeriodOf(state, bodies)` は `localOrbitPeriod` を使う。
2. `plan-arc.ts`: `stepDt` を `localOrbitPeriod` 基準にする(現状 `keplerPeriod(r, MU_EARTH)` 固定で、
   月周回の計画弧は地心動径から刻みを決めてしまう)。積分の打ち切りも `altitudeOf`(地球固定)を
   やめ、`GameEntity.stepPrediction` と同じ「いずれかの天体の表面 + `REENTRY_ALT`」にそろえる。
3. `plan-display.ts`: アプシスの要素・通過時刻・高度を §2.1 の2行で選んだ中心天体で求める。
   **SOI 非表示ハック(157-159)を削除**(中心天体が状態から決まれば「別天体の軌道を誤って描く」
   状態自体が起きない)。TRAJECTORY パネルには何も足さない(あそこは C の設定を置く場所であって
   B の場所ではない)。
4. `plan-editor.ts`: **基準天体 SegmentedControl(95,160-166,212)を削除する。**
   これは A と B を兼ねた手動選択で、A は消え B は導出になるため置き換え先の GUI を作らない
   (navball パネルへの間借りも消える)。`bodyState`(526)は選んだ中心天体相対へ。
   `planPanelHtml` の `warnAtmosphere` は中心天体が地球かどうかで決める。
5. `plan-trajectory.ts:174` の `orbitPeriodOf` 呼び出しを新シグネチャへ。
6. `src/physics/central-body.ts` を削除。`grep -rn "centralBody\|CentralBody\|central-body" src tests`
   が 0 件になることを確認する(**旧名のエイリアスも互換分岐も残さない**)。
7. `tests/physics/plan.test.ts` を新 API で書き直す。

### フェーズ D — 文書

- `CLAUDE.md`: Architecture の `physics/orbital.ts`・`physics/envaccel.ts`(→ `dynamics.ts`)・
  `physics/ephemeris.ts`・`physics/orbit-entity.ts`・`game-entity.ts`・`predictor.ts`・`plan/*`・
  `render/orbitline.ts` の記述を書き換える。`attractor.ts` の項を新設し、**§0 の A〜E の分離を
  一段落で明記する**(ここが後から一番崩れやすい)。**古い記述は消す**(「以前は月中心だった」の類は書かない)。
- `DEVELOP/OWNERSHIP.md`: `Attractor` 列は `Ephemeris` が毎回作って返す派生値で誰も保持しないこと、
  楕円の中心天体は状態から導く派生値であって誰の状態でもないことを明記。
  `predictionCentralBody`/`Plan.centralBody` の行を削除。
- `DEVELOP/CALLSTACK.md`: `stepMoonPrediction` の分岐を削除、`attractorsAt` の呼ばれる位置を追加。
- `DEVELOP/SPEC.md`:
  - **解析楕円の中心天体が地球固定でなくなる**ことを書く(プレイヤーから見える挙動の変化)。
  - **「月基準の宇宙船軌道表示」(253-255 行)は書き換えない。** あれは C(月回転系での積分軌道表示)の
    仕様であり、そのまま実装されるべきもの。§2.3 の既知バグはこの仕様が満たされていないという報告。
  - 「軌道要素方式の基準天体」(330 行)も書き換えない(配置フォームの入力方式の話)。
- `memos/hedalu244/better_simulation_todo.md` の Step1 節を削除する(todo リストなので経緯は残さない)。

---

## 4. 実行時確認(ユーザーが求めたときだけ `/verify`)

クリエイティブモードで月周回に艦を配置し、
①解析楕円が月を中心として出る ②予測線が破棄され続けずホライズンまで伸びる
③マニューバノードを置いて Pe/Ap 通過時刻が月の周期と整合する
④①〜③が MAP VIEW の「注視」「視点」や TRAJECTORY の座標系設定を変えても変わらない(B と C・D の独立性)。
`?perf=1` で update フェーズの時間も見る。

---

## 5. やらないこと

- 「重力を及ぼし、かつ受けるもの」(小惑星)の型。**早急な一般化にあたるので作らない。**
  `Attractor` を「位置・速度 + μ を持つ平坦なデータ」に保っておけば、将来 `OrbitEntity` から
  作れる、という余地だけ残す。
- 木星などの惑星の追加、`Ephemeris` の天体ごとの分割(Step2)。
- **グローバルな影響半径による打ち切り**と質量ハードリミット、spatial hash(Step2/3)。
  これは天体ごとの属性ではなくグローバルな設定として後で入る(だから `Attractor` に
  作用圏半径のようなフィールドを持たせていない)。
- **C(ベイク系)と D(カメラ)まわり一切**(§2.3)。
- 解析楕円の中心天体を選ぶ GUI。導出に一本化し、必要になったら §2.1 の1行を差し替える。
- J2 の一般化(天体ごとの扁平項)。地球固有のまま `dynamics.ts` で足す。
- ゲームルールとしての喪失判定(`GameEntity.checkLoss` の再突入高度)は**地球のみのまま**。
  月面衝突で機体が失われる仕様はスコープ外(予測列の打ち切りだけ全天体基準にしてある)。
- 戦闘ビューの方位マーカー(`orbitalAxes` が地心速度基準)の中心天体対応。
  配線が揃えば直せるが、重力源の一般化とは別の仕様変更なので `feature_todo.md` へ回す。

---

## 6. 積み残し・見つけた問題

### この作業で受け入れたトレードオフ(再検討するなら記録として)

- **予測経路では `attractorsAt` のメモが効かない。** `Predictor` が刻み幅を決めるために先端時刻
  `tip.t` で引き、`stepPrediction` が積分のために中点 `tip.t + dt/2` で引く。時刻が単調増加する
  ので直近2件のメモはどちらも外れる。1ステップ 3.3 μs(実測)、予算上限 500 ステップで約 1.6 ms/
  フレーム。**中点サンプリングをやめて1回にすれば半減するが、月周回の予測精度が落ちる**
  (月が dt/2 ぶん遅れた位置になり、1周で無視できない誤差になる)ので採らなかった。
- `Ephemeris` の `LazyVelAttractor` は速度を初回参照時にだけ計算する(積分と刻み幅の決定は位置
  しか読まないため)。getter が `id === 'moon'` で分岐しているので、**Step2 で天体を増やすときは
  ここも直す必要がある。**

### スコープ外で見つけた小さな逸脱(`feature_todo.md` 行き)

- MAP VIEW パネル(カメラ用)に「弾薬」トグルが同居している(`overview-camera-panel.ts:35-40`)。
  カメラ関連 GUI の集約という観点では逆向きの混在。
- `OrbitLine.sync` に「要調査」コメントあり: 頂点を密に置きたいのは本来フローティングオリジン
  近傍だが、呼び出し側は自機位置を渡している。

---

## 7. 確定した判断(この文書の前提)

1. **解析楕円の中心天体に GUI は作らない。** `strongestAttractor` で導出し、
   `plan-editor` の基準天体 SegmentedControl は置き換えずに削除する(フェーズ C-4)。
2. **カメラ関連 GUI(D)は MAP VIEW パネルに既に集約されており、触らない。**
   楕円の中心天体を navball にも TRAJECTORY にもカメラパネルにも置かない。
3. **`DEVELOP/SPEC.md:253-255`(月回転系での積分軌道表示)は C の仕様なので書き換えない。**
   `Player.moonOrbitTrace`(中心天体で分岐する B の回避策)は削除済みだが、
   C の機能そのものは `SampledLine` + `Frame` 経路として残る。
