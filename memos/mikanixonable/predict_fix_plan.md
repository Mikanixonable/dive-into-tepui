# マップビュー predict 機能の修正案

調査対象: `game/simulation/predictor.ts` / `game-entity/game-entity.ts` /
`physics/orbit-entity.ts` / `physics/ephemeris.ts` / `game/game.ts`。
実装はまだ入れていない。**着手順は末尾の「着手順」節を見る**(項目番号は識別子であって
優先度ではない。第2部 A が要件本体で、第1部 1・2・6 はその前提)。

---

## 1. 予測1ステップで `attractorsAt` を別時刻で2回引いており、メモが1回も効かない

`predictor.ts:53` が刻み幅を決めるために先端時刻 `tipState.t` で引き、
`game-entity.ts:132` が積分のために中点 `p.state.t + dt/2` で引く。
`advanceBudget` のループは同じ個体を連続で回すので、引かれる時刻は

    t, t+dt/2, t+dt, t+dt+dt'/2, ...

と毎回新しくなり、`attractorsAt` の2枠メモ(`ephemeris.ts:293-301`)は
**全ミス**になる。`game-entity.ts:88` のコメント「1ステップの中で別の時刻を引くと
メモが効かなくなる」が、まさに `stepPrediction` 側で破られている。

コストは軽くない。1ミスあたり `moonPosAt`/`sunPosAt` に加えて
`moonVelAt`/`sunVelAt` が中心差分で `moonPosition`/`sunPosition` を直接2回ずつ呼ぶ
(`ephemeris.ts:256-265`)ので、**月・太陽の位置計算が計6回**走る。
`PREDICT_STEP_BUDGET = 500` なので最大 1000 ミス / フレーム = 約 6000 回の天体位置評価。

### 案: `bodies` を `stepPrediction` の引数にする

`Predictor` が先端時刻で1回引いた配列を、そのまま `stepPrediction` へ渡して積分にも使う。

```ts
// predictor.ts
const bodies = this.ephemeris.attractorsAt(tipState.t);
const dt = Math.max(C.PREDICT_MIN_STEP_DT, localOrbitPeriod(tipState.r, bodies) / STEPS_PER_REV);
if (!e.stepPrediction(bodies, simTime, dt)) break;
```

`stepPrediction` は `ephemeris` 引数を落とし、受け取った `bodies` を積分と
`sampleInterval` の両方に使う。1ステップ1回の引きになり、しかも `Predictor` が
すでに持っている配列なのでメモのヒット/ミスに依存しない。

中点(t+dt/2)から始点(t)へ変わる精度差は無視できる。`stepDynamicsRK4` は
そもそも1ステップの間 `bodies` を固定して扱うので、これは2次の選択でしかない
(LEO の `dt ≈ 9.3s` に対し月は `dt/2` で 4.6km / 384,000km しか動かない)。

「刻み幅を決めるのは `Predictor`、実際に進めるかを判断するのは entity」という
`Simulator`/`stepSim` と同じ分担は保たれる — 重力源の確定も刻み幅と同じく
「ステップの前提を呼び出し側が決める」側に寄るだけで、むしろ一貫する。

`stepSim` は現状のまま(中点で1回引いて両用)でよい。ただし **`stepSim` と
`stepPrediction` で重力源の引き方が非対称になる**ので、どちらかに寄せるかは要判断。
寄せるなら `stepSim` も `Simulator` から `bodies` を渡す形にできる(サブステップ内の
全個体が同じ時刻を引くので、そちらは1回引いて配ればメモすら不要になる)。

## 2. 予測を持たない個体にも重力源の引きと周期計算が走る

`predictor.ts:49-57` の `advanceBudget` は、`stepPrediction` を呼ぶ前に
`attractorsAt` と `localOrbitPeriod` を評価する。しかし `stepPrediction` は
`game-entity.ts:119` で `predictDuration <= 0` なら即 `false` を返す。

`predictDuration` が 0 なのは弾・薬莢・破片・`BeltSection` — **通常フレームの
エンティティの大半**。これらがラウンドロビンで訪問されるたびに、捨てるだけの
`attractorsAt` を1回引いている。しかも 1. のとおり毎回ミスするうえ、
**2枠メモを新しい時刻で上書きして汚染する**ので、後続の有効な引きまで巻き添えにする。

### 案: `advanceBudget` の先頭でガードする

```ts
private advanceBudget(e: GameEntity, budgetSteps: number, simTime: number): number {
  if (e.predictDuration <= 0) return 0;
  ...
}
```

第2部 A を入れると `predictDuration` は `predictsFuture: boolean` に置き換わるので、
この条件も `if (!e.predictsFuture) return 0;` になる。**A より先に入れるなら
一度書き換えが要る**が、この項目は1行で効果が大きいので先行させる価値がある。

さらに `update` の `resyncPrediction` ループ(`predictor.ts:27`)と
ラウンドロビンの訪問対象も、予測を持ちうる個体だけにできると無駄がない。
ただし `all()` をフィルタすると毎フレーム配列が確保されるので、
`EntityManager` 側に予測対象だけの配列を持たせるか、上記ガードで済ませるかは要判断。
まずはガードだけで実測し、訪問コスト自体が問題になってから配列を検討する。

## 3. `suspended` 中に古い予測列が残り、誤った未来軌道を描く

`predictor.ts:23` は `suspended` なら `resyncPrediction` すら通さずに `return` する。
コメントは「等速域へ戻るまで既存列を保持して計算予算を使わない」と言っているが、
高ワープ中は実状態が予測列を大きく追い越すので、**保持された列はもう自機の未来ではない**。

`displayState`(`game-entity.ts:146`)は `t > current.state.t` なら無条件に
`_predicted.at(t)` を返すので、ワープ中のマップには
「過去の状態から積分された、現在とは無関係な軌道」が実線で出る。
`simTime` が列の先端を追い越して初めて `at()` が `null` になって消える
(=消えるまでの間はむしろ誤情報として描かれる)。

### 案A: `suspended` でも `resyncPrediction` だけは通す

`return` を予算配分の直前へ下げる。乖離した列はその場で破棄されるので、
ワープ中は「線が出ない」状態になる。破棄自体はコストゼロ(参照を落とすだけ)、
`at()` の二分探索1回ぶんしかかからない、というのが `predictor.ts:26` の前提とも合う。

### 案B: `suspended` に入った時点で全個体の予測を破棄する

状態遷移を検出する必要がある(前フレームの `suspended` を持つ)。
`Predictor` に1つ状態が増えるが、ワープ中は毎フレームの `resync` すら不要になる。

**案A を推す** — 状態を増やさず、ワープ解除の瞬間に再構築が始まる点も同じ。

## 4. `suspended` の判定が `simSpeed` 直接比較で、2箇所に重複している

`game.ts:349` と `game.ts:450` がどちらも
`this.simSpeedManager.simSpeed > C.MAX_PHYS_SIM_SPEED` を直書きしている。

CLAUDE.md / `/refactor-fixed` の規約は「呼び出し側は `simSpeed` を
`MAX_PHYS_SIM_SPEED` と比較せず `SimSpeedManager` の `can*` 述語に尋ねる」。
`canPlayerThrust` / `canPlayerFire` / `canEnemyFire` /
`canResolvePhysicalCollisions`(`sim-speed-manager.ts:40-57`)と同じ形が要る。

### 案

`SimSpeedManager` に `canPredict` を足し、`Predictor.update` の第3引数を
`suspended: boolean` から `canPredict: boolean` へ反転する
(否定形の引数を渡さない。`predictor.ts:23` も `if (!canPredict) return;` になる)。

```ts
// sim-speed-manager.ts
// 高ワープでは実状態が1フレームで予測列を追い越すため、予測を進めても表示に使える列にならない。
get canPredict(): boolean {
  return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
}
```

3. の案A を採る場合、「予算を配らない」と「再同期もしない」は別の判断になるので、
`canPredict` は前者だけを意味する名前(`canGrowPrediction` など)の方が正確かもしれない。

## 5. ホライズン境界の実装が CLAUDE.md の記述と逆

`game-entity.ts:130` は `p.state.t > simTime + predictDuration` を
**ステップの前**に判定するので、先端は最大1ステップぶんホライズンを**超える**。
`game-entity.ts:129` のコメント「常に predictDuration より先に p.state.t があるように」も
超過が意図であることを示している。

一方 CLAUDE.md は「`predicted.state.t + dt` がホライズンを越えるなら
`dt` を縮めずにステップを拒否する / 先端はホライズンの1ステップ手前に留まる」と書いている。
**実装が正しい**(ホライズンちょうどの `displayState` を引けるようにするには超過が要る)。

### 案

CLAUDE.md の該当記述を実装に合わせて書き直す。コード変更は不要。
`game-entity.ts:129` のコメントも「ホライズン時刻ちょうどを `at()` で引けるよう、
先端は必ずホライズンを1ステップぶん越えたところまで伸ばす」と理由まで書く。

## 6. `STEPS_PER_REV` が同名・別値で2箇所にある

- `predictor.ts:64` = 600
- `plan-arc.ts:22` = 100

`predictor.ts:62-63` のコメントが「plan-arc.ts の STEPS_PER_REV と同じ考え方」と
明示的に参照しているのに、定数もモジュールも共有していない。
他の予測系定数(`PREDICT_SAMPLES_PER_REV` など)は `const.ts:278-283` に集約されている。

値が違うこと自体は正しい(要求精度が違う — 予測列は `PREDICT_RESET_DIST` 以内に
留まればよく、計画側は28日を一発積分する)。問題は**置き場所と名前**。

### 案

両方を `const.ts` へ移し、要求精度の違いが名前から読めるようにする。

```ts
export const PREDICT_STEPS_PER_REV = 600; // 予測列の1周回あたり積分ステップ数
export const PLAN_ARC_STEPS_PER_REV = 100; // 計画軌道の1周回あたり積分ステップ数
```

`PLAN_ARC_MAX_SAMPLES` / `PLAN_ARC_MAX_STEPS` が既に `const.ts:265-271` にあるので、
`plan-arc.ts` 側は特に収まりがよい。
なお `const.ts:268` のコメントが既に「stepDt(1周回/STEPS_PER_REV)」と
`const.ts` に無い定数を参照しているので、移動でその不整合も消える。

## 7. 噴射時の即時 `invalidatePrediction` が `Player` 限定

`player.ts:181` の `if (this.thrust !== null) this.invalidatePrediction();` だけが、
`resyncPrediction` の距離判定を待たずに予測列を落としている。

`stepPrediction` は `game-entity.ts:121` で噴射中の伸長を拒否するだけなので、
`Player` 以外が推力を持つと「古い自由飛行の予測が `PREDICT_RESET_DIST`(500m)
乖離するまで数フレーム描かれ続ける」。現状 `Enemy` は推力を使わないので顕在化しない。

CLAUDE.md はこれを「意図的に player 限定にしてあり、将来 `Enemy` の推力では
即時リセットしない余地を残している」と説明している。設計判断としては成立するが、
**その判断が `Player.behave` の1行に埋まっている**のが弱い。

### 案

コード変更はせず、判断を `/refactor-fixed` へ移す(「予測列の即時破棄は操作対象の
UX 要求であり、`thrust` の setter 化や `Ship` への一般化はしない」)。
`Enemy` に推力を入れる時点で改めて判断する、という形で残す。

## 8. 予算不足時の飢餓が保証されていない

`resyncPrediction`(`predictor.ts:27`)は毎フレーム全個体に無条件で走るが、
伸長は `PREDICT_STEP_BUDGET` の中でラウンドロビン。個体数が多いと
「伸ばしかけた列が追いつく前に乖離して破棄される」個体が出うる。

破棄自体は安いので**フレーム時間はスパイクしない**(そこは設計どおり)。
問題は、そういう個体の予測が永久に完成しないこと自体が検知されないこと。

さらに `predictDuration` を保持窓として `history.cleanup` している
(`game-entity.ts:133`)ため、先端がホライズンに達すると
保持窓の下端がちょうど `simTime` 付近になる。伸長が遅れて先端が `simTime` に
追い越されると `at(simTime)` が `null` になり、破棄→再生成のループに入る。

### 案

まず**計測してから**判断する。`?perf=1`(`perf-meter.ts`)に
「予測列を持つ個体数 / うち先端がホライズンに達している個体数 / 当該フレームの
破棄数」を出す。破棄数が定常的に非ゼロなら実害があるので、
そのとき初めて対策(予算の傾斜配分、または表示対象だけを予測する)を検討する。

2. のガードを入れると実効予算が大きく増えるので、**計測は 2. の後**に行う。

## 9. (小) 「直近の入力でメモ化して参照同一性で捨てる」実装が3か所

- `game-entity.ts:34-36, 71-75` — `elementsAround` のメモ(state 参照 + body.id)
- `ephemeris.ts:217-252` — `sunMemoT`/`moonMemoT` の単一枠
- `ephemeris.ts:224, 293-301` — `attractorsMemo` の2枠(`Array.find` + `unshift` + 長さ切り詰め)

3つとも「直近 N 件を引数一致で返す」だけだが、実装が全部違う。
共通ヘルパー化は可能だが、キーの比較方法(参照同一性 / 数値一致 / 複合キー)も
枠数も違うので、**まとめると却って読みにくくなる可能性が高い**。

1. と 2. を入れると `attractorsMemo` が予測経路で必要なくなる可能性があるので、
**その後に「2枠は本当に要るか」を再評価する**。1枠で足りるなら
`attractorsMemo` は `sunMemoT` と同じ形に落ちて、差異そのものが消える。

---

# 第2部: マップビューの未来表示 UI(PREDICT パネル)

調査対象: `game/display-time-manager.ts` / `game/display-time-panel.ts` /
`game/view-manager.ts` / `game/game.ts` の sync 経路 / `game/player/player.ts`。

UI と機能の対応は次のとおり。

| UI | 状態 | 役割 |
|---|---|---|
| 期間(90分/1日/7日/28日/手動) | `durationKey` | `durationSec()` = スライダー全振りの秒数 |
| 手動(数値 + 時/日/週/年) | `manualDurationSec` | `durationKey==='manual'` のときの `durationSec()` |
| スライダー(range 0..1000) | `sliderT`(0..1) | 未来ゴーストの位置 |

解決は `resolveDisplayTime`(`display-time-manager.ts:48-51`)の1行:
`(forceCurrent || sliderT<=0) ? simTime : simTime + sliderT * durationSec()`。
`forceCurrent` は `view-manager.ts:105` がマップ表示中だけ `false` にする。

`displayTime` を読むのは、全エンティティのメッシュ・自機メッシュと `▷`・敵のグループ
マーカー・`MapPicker` の候補集合・`Logistics` の ▣AMMO・`CreativeStage` の基地マーカー・
`EnvironmentScene`(解析式なので期間制限なし)・`PlanDisplay` の ⬡ ゴースト。
カメラ・軌道楕円線・Navball・HUD パネルの数値・ボード通過マーク・LEAD は現在時刻のまま。

---

## A. 予測期間がスライダーの期間と無関係に固定3時間になっている 【要件】

エンティティの未来位置は `predictDuration = C.PREDICT_DURATION = 3時間`
(`const.ts:280`、`Ship`/`Ammo` に固定)までしか存在せず、超えると
`displayState` が `null` を返して `GameEntity.sync` が `obj.visible = false` にする。
スライダーの期間とは完全に独立なので、

- 期間 90分(< 3時間)→ スライダーでは決して見えない1.5時間ぶんを積んで保持している
  (完成後は伸長が止まるので毎フレームの費用ではないが、構築中の予算とサンプルの実費)
- 期間 1日(既定)→ スライダー先頭 **12.5%** より右で全エンティティが消える
- 期間 7日 → 1.8% / 28日 → 0.45% / 手動1年 → 0.03%

⬡ ゴーストはさらに狭く、`PlanTrajectory` の末尾区間 = 1周回(LEO で約93分)まで
(`plan-display.ts:126`)。「PREDICT」と題したパネルが、予測系が供給できない期間を
提示している状態。

### 要件

**予測軌道の表示範囲を、スライダーの最大値(= `durationSec()`)と一致させる。**
期間 2時間なら2時間ぶん、2年なら2年ぶんの予測軌道が出る。

### 案: ホライズンを `Predictor` の引数にし、`predictDuration` は可否フラグへ縮める

現状 `predictDuration` は「予測する長さ」と「そもそも予測するか(0 = 弾・薬莢・破片)」を
兼ねている。長さが実行時に変わるので、この2つを分離する。

```ts
// game-entity.ts
// 未来を予測する種別か。既定 false(弾・薬莢・破片)。Ship/Ammo が true。
readonly predictsFuture: boolean = false;
```

`Predictor` はホライズン秒数を受け取り、`stepPrediction` へ渡す。
`OrbitEntity.step` の `keepDuration` にも同じ値を使う(現状 `predictDuration` を
渡している `game-entity.ts:133` の置き換え)。

```ts
// predictor.ts(第3引数の canGrowPrediction は第1部 4 で入れる述語)
update(simTime: number, player: Player | null, canGrowPrediction: boolean, horizon: number): void

// game-entity.ts
stepPrediction(bodies, simTime, dt, horizon): boolean {
  if (!this.predictsFuture) return false;
  ...
  if (p.state.t > simTime + horizon) return false;
  p.step(dt, bodies, this.bcInv, null, this.sampleInterval(bodies, p.state), horizon);
}
```

`Game.update` の2箇所の `predictor.update(...)` が
`this.displayTimeManager.durationSec()` を渡す。`DisplayTimeManager` は
既に `Game` 所有で、`displayTime` も `Game` が解決して配っているので、
新しい参照関係は増えない(`Predictor` は `DisplayTimeManager` を持たない —
「いつを見るか」は `DisplayTimeManager`、「どこまで積むか」を決めるのは
その値を受け取る呼び出し側、という現行の分担を崩さない)。

`C.PREDICT_DURATION` と、`Ship`/`Ammo` の `predictDuration = C.PREDICT_DURATION` は
**行き先が無くなるので消す**(CLAUDE.md の「`predictDuration` は
`DisplayTimeManager` と独立な種別ごとの定数 / 表示と予測は無関係な軸」という記述も、
まさにこの変更で逆になるため同じ変更セットで書き直す)。

### 案の前提: 刻み幅と保持サンプル数に上限が要る

**期間を素直に伸ばすとステップ数とメモリが破綻する。** LEO(周期 5580s)で
`STEPS_PER_REV = 600` → `dt ≈ 9.3s` のまま計算すると:

| 期間 | 積分ステップ数 | 保持サンプル数(`PREDICT_SAMPLES_PER_REV = 32`) |
|---|---|---|
| 90分 | 581 | 31 |
| 3時間(現状) | 1,161 | 62 |
| 1日 | 9,290 | 496 |
| 7日 | 65,000 | 3,470 |
| 28日 | 260,000 | 13,900 |
| 1年 | 3,390,000 | 181,000 |

`PREDICT_STEP_BUDGET = 500` / フレームなので、1年ぶんは1個体だけで
約 6,800 フレーム(≒113秒)かかり、サンプルは1個体 18万件。実用にならない。

`plan-arc.ts` が同じ問題を `PLAN_ARC_MAX_STEPS` / `PLAN_ARC_MAX_SAMPLES` で
既に解いている(`const.ts:265-271`)。予測側にも同じ形の上限を入れ、
**短い期間では1周回基準の精度、長い期間では上限で頭打ち**にする。

```ts
// const.ts
export const PREDICT_MAX_STEPS = 20000;   // 1個体の予測列の積分ステップ数上限
export const PREDICT_MAX_SAMPLES = 2000;  // 1個体の予測列の保持サンプル数上限

// predictor.ts — 刻み幅は「1周回基準」と「ホライズン全体をステップ上限で割った値」の粗い方
const dt = Math.max(
  C.PREDICT_MIN_STEP_DT,
  localOrbitPeriod(tipState.r, bodies) / C.PREDICT_STEPS_PER_REV,
  horizon / C.PREDICT_MAX_STEPS,
);

// game-entity.ts の sampleInterval も同じ形で頭打ちにする
```

これで 1年でも 20,000 ステップ / 2,000 サンプルに収まる。
1個体が予算を独占すれば40フレームだが、実際はラウンドロビンで割るので
**個体数ぶん遅くなる**(第1部 8 の飢餓が A で顕在化する — 下記)。
なお `PREDICT_STEPS_PER_REV` は第1部 6 で `const.ts` へ移す定数なので、
**6 を A より先に入れる**。
代わりに 1年表示の刻みは 1,576s(周期の 1/3.5)まで粗くなり、**軌道の形は
もはや正確でない**。この粗さを許容するか、期間の上限を実用範囲(例: 28日)へ
下げるかは判断が要る。28日なら上限に当たらず、1周回基準の精度が保てる。

### 併せて決めること

- **⬡ ゴーストの範囲**: `PlanTrajectory` の末尾区間は「1周回を超えると折れ線が
  自己重なりして点を選べなくなる」という**クリック可否の都合**で1周回に固定されている
  (`plan-trajectory.ts`)。ゴーストの表示範囲をホライズンに合わせるなら、
  折れ線の長さとゴーストの到達範囲を分離する必要がある。別項目として切る。
- **抵抗の効き**: 3時間なら LEO の大気抵抗は無視できるが、28日では実際に高度が落ちる。
  期間を伸ばすと予測が「正しく」再突入して `truncated` で打ち切られる個体が出る。
  これは不具合ではなく正しい挙動だが、線が途中で切れる見え方の説明が要る。
- **期間変更時の既存列**: ホライズンが縮んだ列は長すぎるだけで無害、伸びた列は
  そのまま伸長が再開する。どちらも `invalidatePrediction` は不要。ただし
  `dt` が `horizon / PREDICT_MAX_STEPS` で決まる領域では**期間を変えると刻み幅も変わる**ので、
  既存列と新しい刻みが同じ列に混在する。表示上は問題ないが、
  「列全体で刻みが一定」を前提にしている箇所が無いか確認が要る。
- **飢餓の顕在化**: 第1部 8 は現状「実害があるか未計測」だが、A で1個体あたりの
  必要ステップ数が最大 20 倍(3時間 → 上限)になるため、`PREDICT_STEP_BUDGET = 500`
  のままでは長期間 + 多個体で予測が完成しなくなる。**A と 8 の計測はセットで行う。**

## B. `sliderT` がどこでもリセットされない

書き込みはスライダーの `input` ハンドラ(`display-time-manager.ts:31`)のみ。

- 期間を切り替えても `sliderT` が保持されるので、表示時刻が不連続に飛ぶ
  (0.5 × 1日 → 0.5 × 28日)。ツマミは動かないのに表示が 12時間 → 14日 へ跳ぶ。
- マップを閉じても `sliderT > 0` のまま。`forceCurrent` が隠すだけなので、
  再びマップへ入った瞬間に古い未来オフセットが復活する。
- パネル側に `setSliderValue` が無い **片方向バインド**。`sliderT` を
  プログラムから変えてもツマミが追従しない。

### 案

`DisplayTimePanel` に `setSliderValue(t: number)` を足し、`sync()` から押し出す
(他のパネルと同じ「状態は manager、DOM は panel、毎フレーム押し出す」形)。
そのうえで:

- `onDurationSelect` で `sliderT = 0` に戻す。期間はスライダーの尺度そのものなので、
  尺度を変えたら位置は原点へ戻すのが素直(表示時刻を保つよう `sliderT` を
  再スケールする案もあるが、28日→90分では表現できない時刻になるので却下)。
- `forceCurrent` を `true` にする側(`ViewManager`)ではなく `DisplayTimeManager` 側で、
  `forceCurrent` が立った時に `sliderT = 0` にする。フラグの意味は
  「未来表示を禁止」なので、禁止された時点で位置を捨てるのが一貫する。

## C. 手動レンジのクランプが UI に反映されない

クランプは `DisplayTimeManager.onManualDurationChange`(`display-time-manager.ts:34`)
だけにあり、`<input type=number>` に `max` が無い(`display-time-panel.ts:59-62`)。
「100年」と入力すると内部は1年、フィールドは 100 のまま乖離する。
また `emitManualDuration`(`display-time-panel.ts:97-101`)は負値・非有限で
**何も通知せず return** するので、直前の値が黙って残る。

### 案

クランプをパネル側の1箇所に寄せ、入力値そのものを直す。

```ts
private emitManualDuration(): void {
  const raw = Number(this.manualValue.value);
  const sec = Math.max(0, Math.min(C.DISPLAY_DURATION_MAX,
    (isFinite(raw) ? raw : 0) * UNIT_SEC[this.manualUnitValue]));
  const value = sec / UNIT_SEC[this.manualUnitValue];
  if (Number(this.manualValue.value) !== value) this.manualValue.value = String(value);
  this.onManualDurationChange?.(sec);
}
```

`DisplayTimeManager` 側の `Math.max/min` は残してよい(受け取る値の不変条件)。
ただし `display-time-panel.ts` が `const.ts` を import することになる点は要確認 —
現状このファイルは `const` に依存していない。単位表 `UNIT_SEC` は既にここにあるので
不自然ではないが、上限だけ manager から渡す形(`setManualMax(sec)`)の方が
依存を増やさない。**そちらを推す。**

## D. 自機のエフェクトだけ現在位置に取り残される

`player.ts:384-388` は `thrustEffects` / `rcsEffects` / `reentryEffects` / `belt` を
`this.state.r`(現在)で同期する一方、`obj.position` は `displayState` を使う
(`player.ts:379`)。マップ中も編集モードでなければ推力は効くので、
未来位置のゴースト機体と現在位置のプルームが分離して見える。

`game.ts:577-578` のコメントが敵マーカーについて「揃えないと機体は未来位置、
マーカーは現在位置に割れる」と書いているのと同じ問題が、自機のエフェクト側に残っている。

### 案

`displayState` が非 null ならその位置を、null なら描画自体を止める。

```ts
if (displayState !== null) {
  this.thrustEffects.sync(fo, displayState.r, ...);
  this.rcsEffects.sync(fo, displayState.r, ...);
  this.reentryEffects.sync(fo, displayState.r, displayState.v, this.thermal.qdyn, ...);
}
```

`reentryEffects` は位置と速度の両方を取る(`player.ts:386`)ので、両方 `displayState` から
渡す。ただし `thermal.qdyn` は現在時刻の動圧なので、未来位置のゴーストに現在の
プラズマ光が付く不整合は残る — 未来の動圧は予測列から出せないので、
**未来表示中はこのエフェクトを出さない**方が正しいかもしれない。要判断。
`belt` は自機ローカルの子メッシュなので `obj` に追随し、変更不要。
`orbitLine` は接触楕円なので現在状態のままでよい(未来位置でも楕円はほぼ同じ)。
ただし **A を入れて期間が伸びると差が見えるようになる**ので、その時点で再判断する。

## E. 目盛りラベルを毎フレーム作り直している

`DisplayTimeManager.sync()` が毎フレーム `tickLabels()` を呼び、配列確保 +
`fmtTime` 6回(`display-time-manager.ts:59, 68-71`)。実際に変わるのは
`durationKey` / `manualDurationSec` が変わったときだけ。
DOM 書き込み自体は `setTicks` の差分比較で防がれているので**実害は小さい**。

### 案

`durationSec()` の値をキーにメモ化する(`elementsAround` と同じ形)。
ただし 1〜2 のような明確な費用ではないので、**優先度は最低**。
第1部 9 の「直近入力でメモ化するパターンが3か所」と同じ話でもあるので、
共通ヘルパーを作らない限り 4 か所目を増やすだけになる。**見送ってよい。**

## F. CLAUDE.md の記述ずれ(`CameraSystem.sync`)

CLAUDE.md は `CameraSystem` が `sync(fo, displayTime)` を取ると書いているが、
実際は `game.ts:543` が `sync(this.floatingOrigin)` を呼び、
`camera/camera-system.ts` に `displayTime` は現れない。
カメラは未来表示に追従しない(現在位置の自機を追う)のが実装の意図。

### 案

CLAUDE.md の該当箇所を実装に合わせて直す。第1部 5(ホライズン境界)と
同じ「文書だけ直す」項目なので、まとめて1回で処理する。

---

## 着手順(第1部 + 第2部)

A(要件)を安全に入れるための前提が先に来る。1〜3 は A の費用を読めるようにする作業。

1. **第1部 2**(予測なし個体のガード)— 1行、効果大、リスクなし。
   A で `predictsFuture` へ書き換わるが、先行させる価値がある
2. **第1部 1**(`bodies` を引数化)— ステップ単価が半分になる。
   これを入れてからでないと A で期間を伸ばしたときの費用が読めない
3. **第1部 6**(`STEPS_PER_REV` を `const.ts` へ)— A が
   `PREDICT_STEPS_PER_REV` / `PREDICT_MAX_STEPS` を同じ場所に置くための下地
4. **第1部 4**(`canGrowPrediction` 述語)— A で `Predictor.update` の
   引数を触るので、同じ変更セットで済ませる
5. **A**(ホライズンをスライダー期間へ)【要件本体】+ **第1部 8**(飢餓の計測)。
   A は必要ステップ数を最大 20 倍にするので、計測なしでは入れ切れない。セットで行う
6. **B / C / D** — A と独立。UI の一貫性。D は A の後の方が差が見えて判断しやすい
7. **第1部 3**(`suspended` 中の古い列)— 4 で述語が入った後
8. **第1部 5・F**(CLAUDE.md だけ直す)— まとめて1回。
   A で `predictDuration` の記述も直すので、その変更セットに合流させてもよい
9. **第1部 7・9・E** — 見送り/判断保留
