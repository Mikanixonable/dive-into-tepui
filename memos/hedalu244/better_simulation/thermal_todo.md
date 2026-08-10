# 大気と熱モデルの整備
現状、大気が地球限定の実装になっているのと、熱システムがプレイヤー限定の実装になっているのを、一般化する。

より大局的な目的はgoal.mdを参考にすること。
計画はフェーズごとに区切ること。各フェーズ終了時には、typecheckと必要に応じたテストが通るようにフェーズを分割すること。
実施時には、各フェーズの完了後にコードレビュー、テスト、コミットを行うこと。計画を実施するときには全フェーズを順にすべて行うこと。
実施後、完了したタスクは文書から削除しbacklog.mdからも削除すること。やらないと決めたタスク、未完了のタスクはbacklog.mdに移すこと。その後、このファイル自体が空になるはずなので削除すること。

判断に困ったら/refactorと/refactor-fixedを参照すること。

## 0. 前提と優先順位

**判断が競合したら、この順で決める(`/refactor-fixed` §5)。**

1. **物理的正確さ** — `physics/` では最優先。
2. **実装の適切さ** — 責務分割・疎結合・命名・数式が素直にそのまま書かれていること。
3. **実行時パフォーマンス** — 重要だが上2つより下。
4. **変更コスト** — 最も低い。

## 1. 目的
現状、大気が地球限定の実装になっているのと、熱システムがプレイヤー限定の実装になっているのを、一般化する。

大気の量を表すパラメーターを天体に追加する。（0で無大気を表すようにし、フラグは作らない）
atmosphere.tsを地球限定のものから一般的なものに拡張。
空気抵抗や再突入時の加熱について、その星の大気に基づく体系的な判定を行う。

現実的に考えて、複数の星の大気の影響を受けることはない（ある星の大気圏には安定した星が存在できない）から、最も近い天体の大気だけを考慮する近似を行ってよい。

基本的な物体、単純なデブリなどに対しても、簡易的な熱シミュレーションシステムを実装する。
各GameEntityのプロパティとして、温度、熱容量、輻射率、上限温度のパラメーターを追加する。
受けた空気抵抗や、衝突などによって失われた力学的エネルギーと熱容量から温度上昇が計算され、雑に定数か線形で近似した黒体放射で放出される。上限温度を超えると破棄。
既存の万有引力シミュレーション、衝突シミュレーションと極力疎結合になるようにしたいが、そのせいで却って配線が複雑になる場合は統合する（捨てられた力学的エネルギーを記録するための配線を基底に作るなど）
太陽による加熱は将来へのbacklogに残す（現時点では影判定のコストが大きそうだから）
これが熱システムの統一基盤になる。

再突入高度の概念を破棄。熱による焼失に一般化する。デブリ類が大気を持たない天体と衝突したとき、衝突による衝撃熱で消失することもあれば、焼失しないこともある。焼失しなくてもバグではない（デブリは寿命や最大数が設定されているので、消えなくても問題はない）

現状プレイヤーだけが持っている熱システムを、この基盤の上に作り直す。プレイヤー特有の事案として、発熱、被弾に応じた温度変化、ラジエーターの展開による輻射率の変化などを実装しなおす。

---

## 2. 現況調査(計画立案時点)

計画の前提として確認した事実。実施時にずれていたら現況を正とする。

### 2-1. 大気が地球固有である箇所

- `physics/atmosphere.ts` — 区分指数密度表(Vallado、0〜1000 km の28行)がモジュール private 定数。
  `dragAccel(r, v, bcInv)` は `len(r) - R_EARTH` で高度を取る(= ECI 原点が地球であることに依存)。
  `airspeed(r, v)` は `EARTH_OMEGA`(= 2π/`SIDEREAL_DAY`)で Y 軸まわりの共回転のみ。
  `isBurnedUp(r, bodies, margin)` は **`body.id !== 'earth'` を直接見て弾いている**。
- `dynamics.ts` の `totalAccel` は、天体ごとのループの**外**で `dragAccel` を1回だけ呼ぶ。
  重力・J2・SRP が `Attractor` のフィールド駆動で固有名を持たないのに対し、抵抗だけが例外。
- `Attractor` に渡っているのは `id/mu/radius/state/degree2/isStar` だけ。
  `CelestialBodyDef` の `shape`/`pole`/`rings` は `Attractor` に載っていない。
- **高度の基準半径が2系統ある。** `dragAccel`/`thermal.ts` は `R_EARTH`(平均 6371.0 km)、
  `isBurnedUp` は `Attractor.radius`(= `R_EARTH_EQ` 6378.137 km)。約 7.1 km ずれている。
- `earthAltitudeOf` の呼び出しは `player.ts:373` の1箇所のみ。同じ式が `thermal.ts:58`、
  `atmosphere.ts:63`、`stage00.ts:273` にインラインで重複している。

### 2-2. 再突入高度の定数と使用箇所

`const.ts` の `REENTRY_ALT`(80 km)/`PLAYER_MIN_ALT`(45 km)/`DEBRIS_REENTRY_ALT`(95 km) は
すべて `isBurnedUp` の margin 引数。加えて:

- `game-entity.ts:184` — **予測軌道の打ち切り**(`stepPredicted`)。
- `plan-arc.ts:173` — **計画軌道の打ち切り**。
- `game-entity.ts:211`(基底 `checkLoss`)、`bullet.ts:91`、`enemy.ts:218`、`player.ts:380` — 消滅判定。
- `stage00.ts:193,272` — 敵配置の近地点マージン(`REENTRY_ALT + 余裕`)。
- `simulator.ts:90` — `REENTRY_SUBSTEP_ALT`(200 km)による substep 細分化。これは焼失判定ではないが
  同じく地球固有(`R_EARTH` 基準)。

予測・計画の打ち切りは**熱状態を持たない**ので、温度による焼失にそのまま置き換えられない。別の基準が要る。

### 2-3. 熱システムの現況

`player/thermal.ts` の `ThermalSystem` が単独で全部を持っている:

- 空力加熱 Sutton–Graves `q̇ = SG_CONST·√(ρ/NOSE_RADIUS)·s³`、
  冷却 `ε·σ·(RAD_AREA + radiatorArea)·(ENV_TEMP⁴ − T⁴)`、
  熱容量は `ship.mass * 100`(≒比熱 100 J/kg/K。`C.HEAT_CAPACITY` は使われない fallback)。
- `pendingHeat` [J] に射撃熱(`addGunHeat`)と被弾熱(`addImpactHeat`)を溜め、substep 数に依存しないよう
  `dtSub` を掛けずに一括投入。
- `checkThermalLimits()` が `'heat-aero' | 'heat-internal' | 'dynpressure' | null` を返す。
  `heat-aero`/`heat-internal` の区別は `qdyn >= REENTRY_GLOW_MIN_Q`(= 大気の有無の代理判定)。
- 動圧 `qdyn`、高度低下警告の EMA も同居。`updateAltitudeAlarm` の末尾が `checkThermalLimits()` を
  tail-return しており、**判定が警告処理に相乗りしている**。
- ラジエーターは面積 [m²] と太陽入射 [W] を `setRadiatorLoad` で渡すだけ。ただし面積の実体は
  `totalCoolingRate`(部品の `coolingRate` の総和、既定 25)をそのまま m² として使っており、
  `RADIATOR_PANEL_AREA`/`RADIATOR_EFFICIENCY_MULT` は**死んでいる**。

### 2-4. 衝突の力学的エネルギー

`Contact`(`simulation/contact.ts`)が持つのは `t/point/normal/selfState/otherState/impulse` のみ。
`physics/collision-response.ts` の `CollisionResponse` も `impulse`/`toi` 止まりで、
**ΔKE はどこでも計算されていない**。反発係数 `RESTITUTION = 0.4` は `contact.ts` 定数。
現状ダメージは `contact.impulse / mass`(Δv)からのみ導出。

---

## 3. 設計判断

実装前に確定させる点。**判断に迷ったらここに戻る。**

### 3-1. 大気データの表現

`CelestialBodyDef` の planet/satellite に `atmosphere?: AtmosphereDef` を追加する
(`degree2?`/`pole?`/`shape?` と同じ「省略すれば持たない」既存慣習に合わせる。star には付けない)。

```ts
// 基準高度で区切った指数モデルの1層。
export type AtmosphereLayer = {
  readonly baseAlt: number;     // 層の下端高度 [m]
  readonly density: number;     // baseAlt での密度 [kg/m^3]
  readonly scaleHeight: number; // スケールハイト [m]
};
export type AtmosphereDef = {
  readonly layers: readonly AtmosphereLayer[]; // baseAlt 昇順。空配列 = 無大気
  readonly spinPeriod: number;                 // 大気の共回転周期 [s]
};
```

- 「大気の量を表すパラメーター、0で無大気、フラグは作らない」の要求は、
  `exponentialAtmosphere(surfaceDensity, scaleHeight, spinPeriod)` という
  **1層を組み立てるヘルパ**で満たす。`surfaceDensity = 0` を渡せば密度は恒等的に 0 になり、
  `dragAccel` は分岐なしで 0 を返す。無大気の判定用フラグは作らない。
- 地球だけは既存の28行表をそのまま `layers` に載せる。**単一指数への退行は物理的正確さの後退**
  なので採らない(優先順位 §0-1)。他の天体は1層で足りる。
- 密度の正データは `layers` 一本にする。`surfaceDensity` をフィールドとしても持たせる案は、
  同じ事実が2箇所に分散するので採らない(`/refactor` データ構造)。

### 3-2. 高度の基準半径

`Attractor.radius` に一本化する。`R_EARTH`(平均半径)基準の高度計算は
`atmosphere.ts`/`thermal.ts`/`stage00.ts` から消す。地球について約 7.1 km 高度が下がる方向にずれるが、
**「接触・高度の基準球は外接球」という既存の確定判断**(`solar-system.ts` の地球エントリのコメント)に
揃えるほうが、2系統を残すより正しい。`earthAltitudeOf` は削除し、任意天体版
`altitudeAbove(r, body)` に置き換える。

### 3-3. どの天体の大気を使うか

「最も近い天体の大気だけ」を実装する。判定は**中心距離ではなく高度**
(`len(r - body.state.r) - body.radius`)の最小で選ぶ — 半径が桁違いの天体が混ざるので、
中心距離で選ぶと巨大な天体が常に勝つ。`atmosphere.ts` に

```ts
export function atmosphereAt(r: Vec3, bodies: readonly Attractor[]): { body: Attractor; density: number } | null
```

を置き、`dragAccel`・熱・予測打ち切りがすべてこれを通る。**大気を持つ天体が複数あっても
最も高度の低い1体しか見ない**のは仕様(§1 の近似)。

### 3-4. 共回転

`Attractor` に自転を載せる: `spin: { readonly axis: Vec3; readonly rate: number } | null`
(`rate` [rad/s])。`Ephemeris` が `PoleModel` から解決する
(`iau` は `wRateDegPerDay`、`cassini` は公転周期、`eciPole` は `SIDEREAL_DAY`)。
`airspeed` は `v - ω×(r - r_body)` に一般化し、`EARTH_OMEGA` は削除する。
`spin === null`(自転モデルを持たない天体)の大気は静止扱い。

これは `poleAt` が返す `{axis, spinAngle}` と重複しない — あちらは**位相**、こちらは**角速度**。
ただし実施時に `poleAt` から角速度も返せるなら、そちらへ寄せて `Attractor.spin` を
1つの解決経路に統一すること。

### 3-5. `GameEntity` の熱プロパティ

要求は「温度、熱容量、輻射率、上限温度」の4つ。うち**熱容量だけは比熱で持つ**:

```ts
temperature = C.ENV_TEMP;      // [K]
specificHeat = 0;              // [J/(kg·K)]  0 なら熱を蓄えない(= 熱計算をしない)
emissivity = 0;                // [-]
maxTemperature = Infinity;     // [K]  超えたら消失
```

- 熱容量 [J/K] を直に持つと `mass` と重複する(`mass × specificHeat` で出る)。
  「軽微な計算で求まるものをステートに持たない」に従い比熱側を正データにする。
- **輻射面積・受熱面積は追加しない。** 既存の `radius` から `4πr²`(輻射)/`πr²`(受熱)で出す。
  自機の `radius`(2.6 m)からは 85 m² で、現行の `RAD_AREA = 70` と同オーダー。
- `specificHeat = 0` が「熱を持たない物体」を表す。フラグは作らない(大気と同じ方針)。
- `maxTemperature = Infinity` が既定なので、**値を設定しない限り焼失しない**。
  デブリが無大気天体に衝突して焼けないのは仕様どおり(§1)。

### 3-6. 熱の入力経路

1. **空力加熱** — `stepActual` の後に1回だけ評価する(RK4 の各段では評価しない)。
   `physics/` に純関数 `aeroHeatFlux(density, airspeed)` を置き、
   受熱は `flux × πr² × dt`。素直な `½ρv³` 系の式にする(自機の Sutton–Graves は §3-8)。
2. **衝突** — `collision-response.ts` が `energyLoss` を返すようにする。
   反発で失われる運動エネルギーは既存の値だけで閉じた形に出る:
   `ΔKE = ½·(1−e²)·vn²/invM`(`invM = invMassA + invMassB`、`vn` は法線相対速度)。
   `Contact` に `energyLoss` を追加し、基底 `collideWith` が自分の分を吸収する。
   **配分は質量比**(`invMass` の逆比)とする — 根拠の薄い等分よりは物理的。
3. **推力・射撃・被弾** — 自機固有。§3-8。
4. **太陽輻射** — backlog 送り(影判定のコスト)。§6。

**放熱**は `ε·σ·4πr²·(T_env⁴ − T⁴)`。`T_env` は既存の `C.ENV_TEMP`。

### 3-7. 再突入高度の廃止と、予測・計画の打ち切り

`isBurnedUp` と `REENTRY_ALT`/`PLAYER_MIN_ALT`/`DEBRIS_REENTRY_ALT` は削除する。実体としての焼失は
`temperature > maxTemperature` 一本になる。

ただし**予測軌道(`stepPredicted`)と計画軌道(`PlanArc`)は熱状態を持たない**ので、
温度では打ち切れない。ここは「表示の打ち切り」であって物理判定ではないから、
`game/const.ts` に表示側の調整値を置く:

```
PREDICT_ATMOSPHERE_CUTOFF_DENSITY  // この密度を超えたら以降は描かない [kg/m^3]
```

密度で切ることで、任意天体に自動で追随する(地球 80 km 相当の密度を初期値にする)。
`REENTRY_SUBSTEP_ALT` も同様に密度基準へ移す。

`stage00.ts` の近地点マージンは焼失判定ではなく**敵配置の安全高度**なので、
`REENTRY_ALT` を消した後は `STAGE00_MIN_PERIGEE_ALT` として stage 側の定数に独立させる
(地球固有の値だが、stage00 自体が地球周回のステージなので問題ない)。

### 3-8. 自機の熱システムの残り

基盤に移した後、`player/thermal.ts` に残るのは**自機固有の事案だけ**:

- 射撃熱・被弾熱 → 基底の `absorbHeat(joules)` を呼ぶだけになる。`pendingHeat` は基底へ移す
  (substep 非依存の一括投入という性質は保つ)。
- **Sutton–Graves** — 一般物体の `½ρv³` より正確なので自機では維持する。基底の空力加熱を
  仮想メソッドにするのではなく、**基底の受熱式に係数を掛ける形**にはしない。
  `physics/atmosphere.ts` に `suttonGravesFlux(density, speed, noseRadius)` を並べて置き、
  どちらを使うかは受け手側(`Player` かそれ以外か)が決める。
  → **実施時に、基底へ仮想メソッドを1つ足すほうが素直ならそちらでよい。判断はコードを見てから。**
- ラジエーター — 展開に応じて**輻射面積**を増やす。要求文の「輻射率の変化」は、
  実装上は率(ε)ではなく面積で表現するほうが物理的に正しい(ε は材質の性質で、
  展開で変わらない)。基底の `4πr²` に加算する形で `Player` が上乗せする。
  ついでに死んでいる `RADIATOR_PANEL_AREA`/`RADIATOR_EFFICIENCY_MULT` を実際に使う形へ直し、
  `totalCoolingRate` を面積として扱っている現状を解消する。
- 動圧 `qdyn` と構造限界(`MAX_DYN_PRESSURE`)は**熱ではない**。`ThermalSystem` から出して
  自機の空力荷重の責務として分ける。高度低下警告(EMA)も熱ではないので同様に分ける。
  `updateAltitudeAlarm` が `checkThermalLimits()` を tail-return している現状の相乗りは解消する。
- `MAX_HULL_TEMP` は `Player.maxTemperature` になる。
  `'heat-aero'`/`'heat-internal'` の区別(死亡メッセージの出し分け)は、
  `qdyn` の代理判定をやめ、**その瞬間に大気があるか**(`atmosphereAt` が非 null か)で決める。

---

## 4. フェーズ分割

各フェーズ末で `npm run typecheck` が通ること。`src/physics/` を触るフェーズでは
`npm run test:physics` も通すこと。各フェーズ完了後にコードレビュー・テスト・コミットを行う。
`src/` を触ったフェーズは、**同じ変更セットで** CLAUDE.md / `DEVELOP/OWNERSHIP.md` /
`DEVELOP/CALLSTACK.md` / `DEVELOP/SPEC.md` を更新する(`/develop-docs`)。

### Phase 1 — 大気を天体データにする(挙動不変)

`physics/` 内で完結。地球の挙動は数値まで変わらない。

- `solar-system.ts` に `AtmosphereLayer`/`AtmosphereDef` と
  `exponentialAtmosphere(surfaceDensity, scaleHeight, spinPeriod)` を追加。
  `CelestialBodyDef` の planet/satellite に `atmosphere?` を追加。
- `atmosphere.ts` の28行表を地球の登録エントリへ移す。
  `densityAt(alt, atm)` を新設(現 `atmosphericDensity` の一般化)。
- `Attractor` に `atmosphere: AtmosphereDef | null` を追加し、`Ephemeris.attractorAt` で複写。
- この時点では `dragAccel`/`thermal.ts` はまだ `R_EARTH` 基準のまま、
  ただし密度の参照先だけを新データへ差し替える。

**受入**: `atmosphere.test.ts` が変更なしで通る(表が同一だから)。
無大気天体の `densityAt` が恒等的に 0。`exponentialAtmosphere(0, …)` も同様。

### Phase 2 — 抵抗と共回転の一般化

- `Attractor.spin` を追加、`Ephemeris` が `PoleModel` から解決。
- `airspeed(r, v, body)` を `v − ω×(r − r_body)` に一般化。`EARTH_OMEGA` 削除。
- `atmosphereAt(r, bodies)` を新設(高度最小の大気持ち天体を選ぶ)。
- `dragAccel(r, v, bcInv, bodies)` を一般化。`dynamics.ts` の `totalAccel` から
  `attractors` を渡す(既に手元にある)。
- 高度の基準を `Attractor.radius` に統一。`earthAltitudeOf` を削除し
  `altitudeAbove(r, body)` に置換。`thermal.ts`/`stage00.ts` のインライン重複も潰す。
- 登録データに火星・金星・タイタン・木星(および必要なら土星/海王星)の大気を追加。

**受入**: 大気なし天体で抵抗が厳密に 0。地球 LEO の抵抗が Phase 0 と同オーダー
(基準半径変更ぶんのずれは許容、テストは実測値をピン留めし直す)。
火星低軌道で有意な抵抗が出る。`airspeed` が自転軸まわりの回転として finite-difference と一致。

### Phase 3 — 衝突の力学的エネルギー損失を配線

- `collision-response.ts` の `CollisionResponse` に `energyLoss: number` を追加。
- `contact.ts` の `Contact` に `energyLoss` を追加し、質量比で両者へ配分。
- `collision-response.test.ts` に追加: `e = 1` で損失 0、`e` を下げると単調増加、
  `½(1−e²)vn²/invM` と一致、無限質量相手でも有限。

**受入**: `test:physics` 通過。ゲーム挙動は不変(まだ誰も `energyLoss` を読まない)。

### Phase 4 — `GameEntity` の熱シミュレーション基盤

- `GameEntity` に `temperature`/`specificHeat`/`emissivity`/`maxTemperature` と
  `absorbHeat(joules)` を追加。
- `physics/` に `aeroHeatFlux(density, speed)` と放熱の純関数を追加。
- `stepActual` の後段で1回、空力加熱と放熱を積分。
- 基底 `collideWith` が `contact.energyLoss` を吸収。
- 基底 `checkLoss` に `temperature > maxTemperature` の焼失を追加
  (**この時点では `isBurnedUp` も併存させる**。削除は Phase 5)。
- デブリ・薬莢・弾・小惑星に既定値を設定。既定は `specificHeat = 0`(熱なし)なので、
  値を入れたクラスだけが熱を持つ。

**受入**: 熱の純関数のテスト(平衡温度への収束、`specificHeat = 0` で不変、
`emissivity = 0` で放熱 0)。既存の挙動は `isBurnedUp` 併存により大きくは変わらない。

### Phase 5 — 再突入高度の概念を廃止

- `isBurnedUp` を削除。`REENTRY_ALT`/`PLAYER_MIN_ALT`/`DEBRIS_REENTRY_ALT` を削除。
- `Enemy.checkLoss` の再突入分岐を削除(基底の熱焼失に一本化)。`Bullet` も同様。
- 予測(`game-entity.ts:184`)と計画(`plan-arc.ts:173`)の打ち切りを
  `PREDICT_ATMOSPHERE_CUTOFF_DENSITY` へ置換。
- `REENTRY_SUBSTEP_ALT` を密度基準へ移す。
- `stage00.ts` の近地点マージンを `STAGE00_MIN_PERIGEE_ALT` として独立。
- `DEVELOP/SPEC.md` の再突入仕様を書き換え。

**受入**: 「再突入」「REENTRY_ALT」等の全文検索が、演出(`REENTRY_GLOW_*`)と
`reentry-effects.ts` 以外で 0 件。LEO から高度を下げていったとき、デブリも敵も自機も
温度上昇の末に消失すること(実機確認)。

### Phase 6 — 自機の熱システムを基盤の上に作り直す

- 射撃熱・被弾熱を `absorbHeat` 経由に。`pendingHeat` を基底へ移動。
- ラジエーターを輻射面積の上乗せとして再実装。`RADIATOR_PANEL_AREA`/
  `RADIATOR_EFFICIENCY_MULT` を実際に使い、`totalCoolingRate` の面積扱いを解消。
- Sutton–Graves を自機の受熱として維持(§3-8 の判断は実施時に確定)。
- 動圧・構造限界と高度低下警告を `ThermalSystem` から分離。
  `updateAltitudeAlarm` の tail-return による相乗りを解消。
- `MAX_HULL_TEMP` → `Player.maxTemperature`。
  `'heat-aero'`/`'heat-internal'` の区別を `atmosphereAt` の有無で判定。
- HUD(`hud/panel.ts`、`stage-status-panel.ts`、`map-picker.ts`)の温度・動圧表示を
  新しい所有者に合わせる。セーブ(`ThermalSaveData`)も追随。

**受入**: 自機の温度挙動が Phase 0 と実用上同等(射撃で上がる、ラジエーター展開で下がる、
再突入で焼失する)。セーブ/ロードが往復する。

### Phase 7 — 後片付け

- 完了したタスクをこの文書から削除。`backlog.md` の項目5(`atmosphere.ts`/`shadow.ts` の
  地球固有性)のうち大気側を削除。
- やらないと決めたもの・未完了のものを `backlog.md` へ移す(§6)。
- この文書が空になるので削除する。

---

## 5. フェーズ間の依存

```
Phase 1 (大気データ)
   └→ Phase 2 (抵抗・共回転・高度基準)
          └→ Phase 4 (熱基盤)  ←─ Phase 3 (衝突ΔKE)
                 └→ Phase 5 (再突入高度の廃止)
                        └→ Phase 6 (自機の作り直し)
                               └→ Phase 7
```

Phase 3 は Phase 1/2 と独立なので、順序を入れ替えても、並行して進めてもよい。

---

## 6. backlog へ送るもの(このタスクではやらない)

- **太陽輻射による加熱** — 影判定のコストが読めない(§1 の明示的な指示)。
  ただし `shadow.ts` の `sunlitFactor` は既にあり、`RadiatorSystem.solarLoad` が
  自機については実質これをやっている。一般物体へ広げるときに再検討。
- **`shadow.ts` の地球固有性** — 大気とは別問題なので `backlog.md` 項目5に残す。
- **非剛体(大気・ガス惑星・プラズマ弾)の接触モデル** — `backlog.md` 項目14 のまま。
  ガス惑星の「表面」に触れたときの扱いは、大気モデルが入ると再燃するが、本タスクの範囲外。
- **熱による部品破壊・性能低下** — 温度は現状「上限を超えたら消失」の二値でしか効かない。
  部品ごとの耐熱や性能低下は別タスク。
- **地球の28行表以外の天体の密度表の精度** — 火星・金星等は1層の指数近似で入れる。
  実測表への差し替えは必要が生じてから。