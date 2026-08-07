# Step 2 実装手順 — Ephemeris の解体と「重力を及ぼす解析軌道天体」の追加基盤

`better_simulation_todo.md` の実装計画素案 Step2 を、現状のコードと突き合わせて具体化したもの。
素案の細部ではなく大局的な目標(= 天体を1つ足すのが宣言的な1〜2行で済み、座標系の選択が
設計の根幹から切り離されていること)を満たすことを優先し、いくつか素案から逸脱している。
逸脱は §2 に理由つきで列挙した。

作業前に `.claude/skills/refactor-fixed/SKILL.md` と `/comment` を読むこと。
**各フェーズは単独でコミットできる状態(typecheck + test:physics が通り、ゲームが起動する)で
終えること。** フェーズをまたいで壊れたまま進めない。

---

## 0. 前提

- 作業ツリーには Step1 の残り(`Elements.centerId` の追加、`elementsAround` 化)が未コミットで
  乗っている。**まず `npm run typecheck` と `npm run test:physics` を通し、それをコミットしてから
  Phase 1 に入る。** この変更と混ぜない。
- この Step ではアトラクター数に対して計算量が線形に増える形のままでよい。空間分割(素案 Step3)は
  実装しない。**「登録するのは月以上の質量の主要天体だけ」という運用ルールで N を抑える** —
  コードによる質量フィルタは書かない(要求されていない一般化)。

---

## 1. 到達点

このフェーズ群を終えたとき、次が成り立っていること。

1. **天体を1つ増やす手順が決まっている。** `AttractorId` に id を1つ足すと、コンパイラが
   「軌道モデルの登録」と「見た目の登録」の2箇所を要求してくる。それ以外のコード
   (フォーカス候補・座標系リスト・ラグランジュ点・航法ターゲット・クリエイティブの基準天体)は
   すべてレジストリ由来になっていて、手で足す場所がない。
2. **`ephemeris.ts` に「太陽」「月」という固有名の分岐が1つも残っていない。**
3. **座標系が「原点天体 × 向き」の直積で表され、太陽中心慣性系・月中心慣性系が
   カメラと軌道線の両方で選べる。**
4. **木星が実際に動いている。** 引力を及ぼし、マップに出て、木星回転系が選べ、
   クリエイティブモードで木星周回軌道に艦を置ける。

---

## 2. 素案からの設計判断(逸脱と理由)

### 2-1. 天体は「親を持つ解析軌道の木」で表す

素案の「太陽・惑星・衛星の3種に大別できる?」に対する答えは **「大別しない」**。
太陽=根、地球=太陽を回る、月=地球を回る、木星=太陽を回る、タイタン=土星を回る、はすべて
**「親天体まわりの固定ケプラー要素 + 永年変化率」** という1つのモデルで書ける(実在の低精度
天体暦 — JPL の "Keplerian Elements for Approximate Positions of the Major Planets" — がまさに
この形)。惑星クラスと衛星クラスを分けると、その境界(準惑星は? 大型衛星は?)を人間が判断し
続けることになる。**分けるべきなのは「軌道の種類」ではなく「根かどうか」だけ。**

これにより現行の2つのハードコードが自動的に消える:

- 太陽の見かけの公転は「地球の日心軌道の符号反転」として導かれる。専用の `sunPosition` は不要。
- 月の歳差込みモデルは、同じ永年変化率つきモデルの一事例になる。

**ECI への変換は木の根本で1回だけ行う**(`絶対位置(body) − 絶対位置(earth)`)。地球は差が
厳密に 0 になるので原点固定は保たれ、地球近傍の数値精度は今と変わらない。
「あとから全部を太陽基準にする」と決めた場合の変更は、この引き算1箇所になる。

### 2-2. `Ephemeris` は `physics/` に残す。`game/` へ行くのは「天体の見た目」だけ

素案は「太陽・月クラスが THREE 依存を持つので Ephemeris ごと game/ へ」としているが、これは
**`OrbitEntity`(physics) と `GameEntity`(game) の既存の分け方と食い違う。** 敵艦は
「軌道状態は physics、メッシュは game」に分かれていて、`Enemy` の軌道モデルだけ physics に
置き直したりはしていない。天体も同じ形にする。

- `physics/ephemeris.ts` … 位置・速度・回転基準系を返す純粋なサンプラ。**THREE 非依存を維持する。**
- `game/celestial/*.ts` … 天体1つぶんのメッシュ・ラベル・表示距離圧縮を持つ「見た目」。

こうしないと `physics/frame.ts` `physics/halo.ts` と `tests/physics/*` が軒並み `Ephemeris` を
使えなくなる(テストは THREE を読み込めない)。素案の狙い(EntityManager と Ephemeris が
並列になる)は、**game 側の天体ビュー配列と `EntityManager` の配列が並列になる**ことで満たす。
将来 `attractors()` と `integrables()` を1つのインターフェイスへ寄せるときも、この分け方のまま
統合できる。

### 2-3. `Frame` は「原点天体 × 向き」の直積にする

現在の `Frame` は**向きしか持たない**(原点は常に ECI 原点)。一方 `attractor.ts` の
`relativeTo`/`toAbsolute` は**原点しか動かさない**。素案の言う「移動する中心、回転する向きの
座標系との相互変換の統一基盤」はこの2つの合流そのものなので、合流させる。

```
FrameId = `${AttractorId}Centered` | `${AttractorId}Rotating`
```

- `earthCentered` = 現 `'inertial'`(恒等変換)。
- `moonRotating` = 現 `'moonRotating'`。
- `earthRotating` = 現 `'sunRotating'`。**回転系は「公転している側の天体」に属する** — 太陽は根で
  自身の公転を持たないので `sunRotating` は存在しない。これで「地球の公転に固定した系」と
  「太陽の見かけの公転に固定した系」が同じものを二重に名乗る状態が消える。
- `sunCentered` = 太陽中心慣性系(素案の「太陽基準座標系」)。`moonCentered` も同時に手に入る。

`Frame` は文字列 id のままにする(`sampled-line.ts` が `frame === lastFrame` で再 bake を
判定している、DOM の data 属性に載る)。テンプレートリテラル型なので `AttractorId` を増やすと
自動で増える。

### 2-4. 「点」と「方向」を型で分ける

原点が動くようになった瞬間、**位置(アフィン変換: 回転 + 原点平行移動)と方向・変位
(線形変換: 回転のみ)を取り違えるバグが生きる。** 現在 `OverviewCamera` は視点オフセット・
パン・上方向という**3つとも「方向」**を `RelativeVec3` で持っており、そのまま原点移動を
足すと確実に壊れる。

`RelativeVec3` を **`FramePoint` / `FrameDir` の2つの branded type に割る。** これが素案の
「brandedType で型安全に明示」の最小かつ最も効く形。全 `Vec3` に座標系ブランドを付けるのは
やらない(`vec3.ts` のヘルパ群がジェネリック汚染される割に、実際のバグは ECI と
天体相対の取り違えに集中している)。

### 2-5. 系(ラグランジュ点・halo)は「副天体 id」で表す

`'earthMoon' | 'sunEarth'` と `'em-l1' | 'se-l1'` という2系統の列挙をやめ、**副天体の id 1つで
系を指す**。親は木から引ける。

- `em-l1` → `moon-l1`、`se-l1` → `earth-l1`、新設 `jupiter-l1`。
- `LibrationSystem` 型は削除し、`AttractorId`(副天体)を渡す。

表示名は「親の名 - 自分の名 L1」(`地球-月 L1` / `太陽-地球 L1` / `太陽-木星 L1`)を
レジストリから組む。

### 2-6. `AttractorId` は閉じた union のまま

木星を足すのに1行の編集が要るが、その1行が **`Record<AttractorId, …>` のレジストリ2つに
「実装漏れ」をコンパイルエラーとして出させる**トリガーになるので、閉じている価値の方が大きい。

**ただし新規コードで `AttractorId` に対する網羅的 `switch` を書かないこと。** 常に
「レジストリを引く鍵」として扱う。素案 Step3(無数の小惑星)で `string` へ広げるときに、
型の変更だけで済み、ロジックの変更が要らない状態を保つ。

---

## 3. 完成後のモジュール構成

### `physics/`(THREE 非依存・テスト対象)

| ファイル | 責務 |
|---|---|
| `ecliptic.ts` **新規** | 黄道基底と ECI の関係。`Q_ECL_TO_ECI`(Z上向き黄道→ECI、既存)、`Q_ECLY_TO_ECI`(Y上向き黄道→ECI、新規)、`ECL_POLE_ECI`、`eclToEci` |
| `analytic-orbit.ts` **新規** | 「親まわりの固定ケプラー要素 + 永年変化率」モデルの評価。親相対の状態・回転基準系・軌道法線 |
| `solar-system.ts` **新規** | 天体の静的事実の表。`CelestialBodyDef`(id/parent/mu/radius/orbit)と `SOLAR_SYSTEM: Record<AttractorId, CelestialBodyDef>` |
| `lagrange.ts` **新規** | 共線点 γ の求解と、回転系での5点の無次元座標(現 `ephemeris.ts` の `collinearGamma` / `lagrangePoints`) |
| `shadow.ts` **新規** | `sunlitFactor`(現 `ephemeris.ts` から移動。天体暦ではない) |
| `ephemeris.ts` **書き直し** | 木を歩いて任意時刻の ECI 位置・速度・`Attractor[]`・回転基準系・ラグランジュ点を返すサンプラ。**固有名の分岐なし** |
| `frame.ts` **書き直し** | `FrameId`、`FrameTransform`、点/方向/状態の順逆変換。**`Ephemeris` を import しない**(変換値を受け取るだけ) |
| `halo.ts` **改修** | 副天体 id で一般化。系の分岐を削除 |
| `elements.ts` **追記** | 平均近点角 → 離心近点角/真近点角(ニュートン法)。`timeSincePeriapsis` の逆で、現在ここに欠けている |
| `attractor.ts` **改修** | `relativeTo`/`toAbsolute` を削除(frame.ts の天体中心系変換へ寄せる) |

### `game/celestial/`(新規フォルダ、THREE 依存)

| ファイル | 責務 |
|---|---|
| `celestial-body.ts` | 抽象 `CelestialBody`。id・メッシュ所有・`sync(fo, displayTime, cameraSystem, ephemeris)` |
| `earth-body.ts` | 地球(`render/earth.ts` のシェーダ地球・自転・オーロラ) |
| `sun-body.ts` | 太陽(ビルボード + `DirectionalLight`) |
| `planet-body.ts` | 月・木星など「テクスチャ球 + 表示距離圧縮」で済む天体 |
| `celestial-registry.ts` | `Record<AttractorId, { name: string; create(): CelestialBody }>`。**表示名の唯一の定義元** |
| `environment-scene.ts` | `render/environment-scene.ts` から**移動**。天体ビュー配列 + 星球 + 天球グリッド + 参照軌道線 + 環境光 |

`render/` に残すのは THREE のビルダーだけ(`earth.ts` `stars.ts` `billboard.ts` `celestial-grid.ts`
`orbitline.ts` `sampled-line.ts`)。**`environment-scene.ts` は現時点ですでに `game/camera/`・
`game/floating-origin`・`game/const` を import しており `render/` の規約に違反している** ので、
この移動はその是正でもある。

---

## 4. フェーズ別手順

### Phase 1 — 解析軌道モデル(physics のみ、まだ配線しない)

**1-1. `physics/elements.ts` に逆ケプラーを足す。**

```ts
export function eccentricAnomalyFromMean(m: number, e: number): number   // 楕円のみ、ニュートン法
export function trueAnomalyFromMean(m: number, e: number): number
```

級数近似(equation of the center)ではなく**反復解**にする。`physics/` は勝手な近似を持ち込まない
規約であり、反復は 4〜5 回で機械精度に達し、後述のメモ化で毎フレームのコストにはならない。
これは `timeSincePeriapsis`(真近点角→時刻)の逆方向で、`elements.ts` に**現在欠けている**。

**1-2. `physics/ecliptic.ts` を作る。** 現 `ephemeris.ts` の `stdToEci` / `eclToEci` /
`ECL_POLE` / `ECL_POLE_ECI` / `Q_ECL_TO_ECI` / `EPS` をここへ移す。加えて:

```ts
// Y 上向きの黄道基底(X=春分点, Y=黄道北極)→ ECI。stateFromElements が Y=極 前提なので、
// 黄道基準の軌道要素から組んだ状態はこの回転で ECI へ移す。
export const Q_ECLY_TO_ECI: Quat;   // = qFromAxisAngle(v3(1,0,0), EPS)
```

**符号は思い込みで書かず、テストで固定すること。** 検証すべき不変条件は
`qRotate(Q_ECLY_TO_ECI, v3(0,1,0)) ≈ ECL_POLE_ECI = v3(0, cos EPS, sin EPS)`。

**1-3. `physics/analytic-orbit.ts` を作る。**

```ts
// 親天体まわりの軌道を、黄道基準の固定ケプラー要素と角度の永年変化率で表したもの。
// 短周期の摂動は持たない — 「解析楕円で近似できる主要天体」だけを対象とする。
export type AnalyticOrbit = {
  readonly a: number;          // 軌道長半径 [m]
  readonly e: number;          // 離心率
  readonly inc: number;        // 黄道に対する傾斜 [rad]
  readonly raan0: number;      // t=0 の昇交点黄経 [rad]
  readonly raanRate: number;   // 昇交点歳差 [rad/s]
  readonly lonPeri0: number;   // t=0 の近点黄経 ϖ [rad]
  readonly lonPeriRate: number;// 近点歳差 [rad/s]
  readonly l0: number;         // t=0 の平均黄経 L [rad]
  readonly lRate: number;      // 平均黄経の変化率 [rad/s](= 2π/公転周期)
};

// 親天体中心・ECI 軸での状態。mu は親天体の重力定数。
export function analyticState(orbit: AnalyticOrbit, t: number, phaseOffset: number, mu: number): OrbitState;

// この軌道に固定した回転基準系(x̂ = 親→自分, ẑ = 軌道面法線)。
export function analyticRotation(orbit: AnalyticOrbit, t: number, phaseOffset: number): FrameRotation;

// 軌道面の法線(単位ベクトル, ECI)。
export function analyticNormal(orbit: AnalyticOrbit, t: number, phaseOffset: number): Vec3;
```

実装の要点:

- 角度は現行 `moonAngles` と同じ順序で組む。**平均黄経 L は公転周期でちょうど1周し、
  平均近点角 M = L − ϖ、昇交点からの緯度引数 u = ν + (ϖ − Ω)。**
  現行コードのコメント(歳差ぶん公転が遅速する罠)がそのまま一般の天体に効くので、
  同じ注意書きをこのモジュールの先頭コメントに移すこと。
- `analyticState` は **既存の `stateFromElements(t, a, e, inc, raan, argp, nu, mu)` を再利用する。**
  黄道基準の角度をそのまま渡すと「Y = 黄道極」の基底で状態が出るので、`r`/`v` の両方を
  `qRotate(Q_ECLY_TO_ECI, …)` で ECI へ移す。位置と速度を別実装にしない。
- `analyticRotation` の `omega` は **「黄道極まわりの昇交点歳差」+「軌道面法線まわりの公転」**
  の和(現行 `moonOrbitRotation` と同じ形)。`u` の変化率は
  `u̇ = ν̇ + (ϖ̇ − Ω̇)`、`ν̇ = Ṁ (1 + e cos ν)² / (1 − e²)^{3/2}`。級数展開ではなく
  この閉形式を使う。
- `q` は `qMul(Q_ECL_TO_ECI, Rz(Ω)·Rx(inc)·Rz(u))`(現行 `moonOrbitRotation` と同じ)。
  こちらは Z 上向き黄道基底なので `Q_ECL_TO_ECI` の方を使う。**2つの黄道→ECI 回転が
  用途で使い分けられることを `ecliptic.ts` のコメントに明記すること。**

**1-4. `physics/solar-system.ts` を作る。**

```ts
export type CelestialBodyDef = {
  readonly id: AttractorId;
  readonly parent: AttractorId | null;   // null は根(太陽)
  readonly mu: number;
  readonly radius: number;
  readonly orbit: AnalyticOrbit | null;  // parent === null のときだけ null
};

// 宣言順が attractorsAt の返す配列順になる。地球を先頭に置く(ECI 原点であることが読めるように)。
export const SOLAR_SYSTEM: Record<AttractorId, CelestialBodyDef>;
```

数値(いずれも黄道基準・J2000 相当):

| 天体 | parent | a | e | inc | Ω / Ω̇ | ϖ / ϖ̇ | 周期 |
|---|---|---|---|---|---|---|---|
| sun | null | — | — | — | — | — | — |
| earth | sun | 1.495978707e11 m | 0.01671123 | 0 | 0 / 0 | 102.93768° / ≈0 | 恒星年 365.25636 d |
| moon | earth | 3.844e8 m | 0.0549 | 5.145° | 0 / −2π/18.612958yr | 0 / +2π/8.85yr | 恒星月 27.321661 d |

- `μ_sun = 1.32712440018e20`、`R_sun = 6.957e8`、`μ_moon = 4.9048695e12`、`R_moon = 1.7374e6`
  (現 `ephemeris.ts` の定数をそのまま移す)。地球は `orbital-state.ts` の `MU_EARTH` / `R_EARTH`
  を読む(定数の複製を作らない)。
- **`earth.l0` は「t=0 で太陽の ECI 方向が +X」になる値にする。** 現行の `sunPhase0 = 0` の
  観測挙動(ゲーム開始が昼側)を維持するため。ϖ≠0 なので `l0 = π` ではない —
  「地球の真黄経が π」から `ν → E → M → L` と戻して求めた値を定数として書き、
  **`|sunDirAt(0) − (1,0,0)| < 1e-6` をテストで固定する。**
- `MOON_DIST` / `SUN_DIST` は `SOLAR_SYSTEM` の `a` に一本化し、独立した export は消す
  (テストが参照しているので同時に直す)。

**1-5. `physics/lagrange.ts` を作る。** 現 `ephemeris.ts` の `collinearGamma` と
`lagrangePoints` をそのまま移す(質量比 `mu` と `place` を受ける形は良い設計なので変えない)。
`LagrangePoints` 型もここへ。

**1-6. テストを足す。** `tests/physics/analytic-orbit.test.ts` を新設し、
`tests/physics/index.ts` へ登録する。

- `trueAnomalyFromMean` ⇄ `timeSincePeriapsis` の往復が機械精度で戻ること(e = 0 / 0.0549 / 0.3)。
- `analyticState` の速度が、位置の中心差分と一致すること(相対 1e-6)。
  **これが「速度の解析式と位置の式が別物になっていない」ことの担保。**
- `analyticRotation` の `omega` が、基底の中心差分と一致すること
  (`assertOmegaMatchesBasis` が `ephemeris.test.ts` にあるのでヘルパを共有する)。
- 月の軌道: 赤道傾斜が 18.3°〜28.6° を交点周期で掃くこと、法線が位置と直交すること
  (現 `ephemeris.test.ts` の月の検査をこちらへ移してよい)。

**検証:** `npm run typecheck` / `npm run test:physics`。この時点でゲームの挙動は変わらない。

---

### Phase 2 — `Ephemeris` の再構築と呼び出し側の移行

**2-1. `physics/ephemeris.ts` を書き直す。** 新しい公開 API:

```ts
export class Ephemeris {
  // phaseOffsets は天体ごとの平均黄経の初期オフセット。既定は月のみ乱数(現行の挙動)。
  constructor(phaseOffsets?: Partial<Record<AttractorId, number>>);

  attractorsAt(t: number): readonly Attractor[];      // SOLAR_SYSTEM 宣言順、地球は原点で厳密に 0
  stateOf(id: AttractorId, t: number): OrbitState;     // ECI
  positionOf(id: AttractorId, t: number): Vec3;        // ECI
  orbitRotationAt(id: AttractorId, t: number): FrameRotation | null;  // 根は null
  orbitNormalAt(id: AttractorId, t: number): Vec3 | null;             // 根は null
  lagrangeAt(secondary: AttractorId, t: number): LagrangePoints;      // 親を木から引く
  sunDirAt(t: number): Vec3;                           // 照明用。恒星が1つであることは固有名でよい
  frameTransformAt(frame: FrameId, t: number): FrameTransform;        // Phase 4 で追加
}
```

- 内部は**木を根から歩いて各天体の絶対位置・速度を出し、最後に地球のぶんを引く**だけ。
  `earth` は自分自身を引くので厳密に `v3(0,0,0)` になる。
- **削除するもの:** `sunPosition` / `moonPosition` / `moonAngles` / `sunAngles` /
  `sunOrbitRotation` / `moonOrbitRotation` / `moonOrbitNormal` / `emLagrangePoints` /
  `seLagrangePoints` / `LazyVelAttractor` / `sunPosAt` / `moonPosAt` / `sunVelAt` / `moonVelAt` /
  `sunOrbitRotationAt` / `moonOrbitRotationAt` / `moonOrbitNormalAt` / `emLagrangeAt` / `seLagrangeAt`。
  **旧名のエイリアスを残さない**(規約)。旧名を全文検索して 0 件にすること。
- **`LazyVelAttractor` は不要になる。** 速度が中心差分ではなく解析式で位置と同時に出るため、
  遅延評価の動機(位置2回ぶんのコスト)が消える。クラスごと消す。
- **メモ化:** `attractorsAt(t)` の結果配列だけを覚える形へ一本化し、`positionOf`/`stateOf` は
  そこから引く。ただし**リング長を 2 から 4 へ増やす。** 現状は「ステップ中点(積分用)と
  始点(刻み幅用)」の2つで埋まっているが、`sunDirAt` が substep 終端という第3の時刻で
  引かれる(`Player.stepEnvironment`)ため、2 では毎回外れる。**変更後に `?perf=1` で
  update フェーズの ms を測り、悪化していないことを確認すること。**

**2-2. `sunlitFactor` を `physics/shadow.ts` へ移す。** 天体暦ではない。シグネチャは
現状のまま(地球の円柱影)にし、他天体の影への一般化はまだやらない。
import 元は `render/environment-scene.ts` と `game/player/player.ts`。

**2-3. 呼び出し側の移行。** 機械的な置換(§ 呼び出し一覧は下記):

| 旧 | 新 |
|---|---|
| `ephemeris.moonPosAt(t)` | `ephemeris.positionOf('moon', t)` |
| `ephemeris.sunPosAt(t)` | `ephemeris.positionOf('sun', t)` |
| `ephemeris.moonVelAt(t)` | `ephemeris.stateOf('moon', t).v` |
| `ephemeris.moonOrbitNormalAt(t)` | `ephemeris.orbitNormalAt('moon', t)` |
| `ephemeris.moonOrbitRotationAt(t)` | `ephemeris.orbitRotationAt('moon', t)` |
| `ephemeris.sunOrbitRotationAt(t)` | `ephemeris.orbitRotationAt('earth', t)` ※ |
| `ephemeris.emLagrangeAt(t)` | `ephemeris.lagrangeAt('moon', t)` |
| `ephemeris.seLagrangeAt(t)` | `ephemeris.lagrangeAt('earth', t)` |

※ **`earth` の回転基準系は現 `sunOrbitRotation` と x̂ が 180° 反対を向く**(新定義の x̂ は
親→自分 = 太陽→地球)。ẑ は同じ。影響を受けるのは `frame.ts` の `'sunRotating'`、
`nav-target` の面法線(ẑ なので影響なし)、`halo.ts`(Phase 3 で書き直す)、
`OverviewCamera` に保存された視点オフセット(初回だけ 180° 回った位置になるが、
ドラッグで直せる表示上の一過性)。**この反転を承知の上でやること。**

対象ファイル(Phase 1 のサーベイ結果):
`game/camera/focus-markers.ts`、`game/nav-target.ts`、`game/stages/creative-stage.ts`、
`render/environment-scene.ts`、`game/player/player.ts`、`physics/halo.ts`、`physics/frame.ts`、
`tests/physics/{ephemeris,frame,halo,attractor,dynamics,orbit-entity,plan}.test.ts`。

**2-4. 自由関数 `sunPosition` の直接呼び出しを潰す。**
`game/player/player-fire.ts:248` と `game/game-entity/enemy.ts:265` が
`sunPosition(simTime, 0)` を共有インスタンス経由せずに呼んでおり、位相が非ゼロになった
瞬間に太陽方向が食い違う。**`Ephemeris` の参照を受け取って `sunDirAt(simTime)` を呼ぶ形に直す。**
(自機側と敵側は別実装のままでよい — `/refactor-fixed` §12。共有するのは天体暦だけ。)

**2-5. `render/environment-scene.ts` の月軌道線。** `moonOrbitElements` が
`moonPosAt` の 2 点差分で疑似 `r,v` を作っているが、`stateOf('moon', t)` が速度を直接返すので
差分は不要になる。差し替えること。

**検証:** `npm run typecheck` / `npm run test:physics` / ゲームを起動して
太陽方向・月位置・照明・マップの月軌道線が今までどおりであること。
テストの更新点: 太陽距離が定数ではなくなる(地球軌道が離心率 0.0167 の楕円になるため
1.471e11〜1.521e11 m を振る)。距離を定数で固定しているアサーションは範囲チェックへ直す。
太陽-地球 L1/L2 の無次元比(0.00997 / 0.01004)は無次元なのでそのまま通るはず。

---

### Phase 3 — ラグランジュ点・halo の一般化と id 体系

**3-1. `Ephemeris.lagrangeAt(secondary, t)`。** 木から親を引き、
`primaryPos = positionOf(parent, t)`、`R = |positionOf(secondary,t) − primaryPos|`、
`q = orbitRotationAt(secondary, t).q`、`mu = μ_sec / (μ_pri + μ_sec)` を組んで
`lagrange.ts` の `lagrangePoints(mu, place)` へ渡す。`place` は

```
p_eci = primaryPos + qRotate(q, v3(R * x, R * y, 0))
```

の1本だけ。**現行 `seLagrangePoints` にある `(1 − x, −y)` の符号操作は不要になる**
(x̂ を親→自分に統一したため)。同時に、太陽-地球系の `R` が定数 `SUN_DIST` ではなく
瞬時の離心距離になり、精度が上がる。

**3-2. `physics/halo.ts` の一般化。**

- `LibrationSystem` 型を削除。`collinearFrame(secondary: AttractorId, point, t, ephemeris)` にする。
- `earthMoon` / `sunEarth` の分岐(現 64-81 行)を、木から引く汎用コードに置き換える:
  `primaryPos = positionOf(parent)`、`secondaryPos = positionOf(secondary)`、
  `omega = orbitRotationAt(secondary).omega`、`normal = orbitNormalAt(secondary)`、
  `mu = μ_sec/(μ_pri+μ_sec)`、`origin = lagrangeAt(secondary, t)[point]`。
  **現行の `sunEarth` 分岐が `normal = norm(omega)` としているのは「太陽側は歳差がないから
  omega がそのまま黄道法線」という個別事情に依存している。** 汎用版は常に `orbitNormalAt`
  を使う(歳差の有無に依らず正しい)。
- `HaloParams` / `LissajousParams` の `system` フィールドは `secondary: AttractorId` に改名。

**3-3. ラグランジュ点 id を `${secondary}-l${n}` に統一。**
`em-l1..5` → `moon-l1..5`、`se-l1..5` → `earth-l1..5`。影響:

- `game/camera/focus-markers.ts` … `LABEL_NAMES` と `positions` の2つのハードコード表を
  **両方削除**し、`SOLAR_SYSTEM` と `celestial-registry` から組み立てる。
  1天体につき「天体本体のラベル」と「親を持つなら L1〜L5」を生成する。
- `game/nav-target.ts:97-107` `resolvePlaneNormal` … `id === 'moon'` /
  `startsWith('em-l')` / `startsWith('se-l')` の3分岐を、
  「id が天体なら `orbitNormalAt(id, t)`」「id が `${b}-l${n}` 形式なら
  `qRotate(orbitRotationAt(b,t).q, Z_HAT)`」の2分岐に畳む。
  根(太陽)と地球は `orbitNormalAt` が扱えるので、**副産物として太陽・地球も
  航法ターゲットにできるようになる**(現在は `null` で弾かれている)。これは改善なので受け入れる。
- `game/creative/ship-placer-panel.ts` … `LIBRATION_SYSTEM_ITEMS` をレジストリ由来にする。
  `ReferenceBody = 'earth' | 'moon'` も `AttractorId` へ広げる(§Phase 6 と同時でよい)。
- `game/stages/creative-stage.ts` … `buildLibrationState` は `form.librationSystem` を
  そのまま副天体 id として渡すだけになる。

**3-4. `creative-stage.ts` の `'earth' | 'moon'` 分岐を畳む。**
`buildElementsState`(219/220/241 行)・`updatePreview`(98/99/107 行)・
`assertValidElementsForm`(250/252 行)に**同じ二分岐が3回**書かれている。
基準天体の `Attractor` を1つ引けば、μ・半径・ECI 化がすべてそこから出る:

```
const body = ephemeris.attractorsAt(simTime).find(b => b.id === form.body)!;
// mu = body.mu, radius = SOLAR_SYSTEM[form.body].radius,
// ECI 化 = 相対状態 + body.r / body.v(Phase 4 後は frame.ts の天体中心系変換で)
```

**検証:** `npm run typecheck` / `npm run test:physics`(`halo.test.ts` の
ISEE-3 halo の振幅検証、`ephemeris.test.ts` の共線点距離 0.15093/0.16783/0.00997/0.01004 が
そのまま通ること — 通らなければ §3-1 の写像が間違っている)。マップでラグランジュ点ラベルが
すべて出ること、クリエイティブで halo 軌道が置けること。

---

### Phase 4 — `Frame` の拡張(太陽基準座標系)

**4-1. `physics/frame.ts` を書き直す。**

```ts
export type FrameId = `${AttractorId}Centered` | `${AttractorId}Rotating`;

// ある時刻の座標系の剛体運動。origin/originVel は ECI での原点の位置・速度、
// q は「系相対 → ECI」の姿勢、omega は ECI 成分の角速度。
export type FrameTransform = {
  readonly origin: Vec3; readonly originVel: Vec3;
  readonly q: Quat; readonly omega: Vec3;
};

// 位置(アフィン: 回転 + 原点移動)
export function toFramePoint(tf: FrameTransform, p: Vec3): FramePoint;
export function toInertialPoint(tf: FrameTransform, p: FramePoint): Vec3;
// 方向・変位(線形: 回転のみ)
export function toFrameDir(tf: FrameTransform, d: Vec3): FrameDir;
export function toInertialDir(tf: FrameTransform, d: FrameDir): Vec3;
// 状態
export function toFrameState(tf: FrameTransform, s: OrbitState): FrameOrbitState;
export function toInertialState(tf: FrameTransform, t: number, s: FrameOrbitState): OrbitState;
```

- **`Ephemeris` を import しない。** 変換に要るのは `FrameTransform` の値だけ。
  id → `FrameTransform` の解決は `Ephemeris.frameTransformAt(frame, t)` の責務にする。
  これで `frame.ts` は純粋な変換モジュールになり、循環依存もなくなる。
- 状態の変換式は原点移動を含む形へ:
  `r_rel = R⁻¹(r − o)`、`v_rel = R⁻¹(v − ȯ − ω×(r − o))`、逆はその逆。
- `RelativeVec3` を `FramePoint` / `FrameDir` に割る(§2-4)。`RelativeOrbitState` は
  `FrameOrbitState` へ改名。
- `${id}Centered` は回転なし(`q` は恒等)、`${id}Rotating` は
  `orbitRotationAt(id)` の `q`/`omega` を持ち **原点は親天体**(共線点や副天体が静止して見える系に
  なるのはこの取り方)。**根(太陽)には `sunRotating` が存在しない** ので、
  `FRAMES` の列挙は `SOLAR_SYSTEM` から「全天体の `Centered` + 親を持つ天体の `Rotating`」で
  組み立てる。`isFrame` はその列挙に対する検査に変える。

**4-2. `attractor.ts` の `relativeTo` / `toAbsolute` を削除する。**
天体中心系への変換は `frameTransformAt(`${id}Centered`, t)` + `toFrameState` に一本化。
`elementsAround(s, body)` は `Attractor` から直接 `FrameTransform` を組む小さなヘルパ
(`frameOfAttractor(body)`)を使って書き直す。呼び出し側は
`plan-editor.ts:518,620` と `creative-stage.ts`。

**4-3. 呼び出し側の移行。**

- `render/sampled-line.ts` … `syncGeometry` は `toFrameState` を `FrameTransform` を受ける形へ。
  `syncTransform` は **`line.position` を `fo.RtoThreeV3(EARTH_CENTER)` から
  `fo.RtoThreeV3(tf.origin)` へ**変える(これだけで原点移動に対応する。剛体変換なので
  毎フレーム O(1) のままであることが重要)。定数 `EARTH_CENTER` は消える。
- `game/camera/overview-camera.ts` … `offset_r` / `pan_r` / `up_r` は**すべて `FrameDir`**。
  `toFramePos`/`toInertialPos` を `toFrameDir`/`toInertialDir` へ置換する。
  **ここを `Point` 側にすると原点移動ぶんだけ視点が飛ぶ。型で守られるが、意味を理解して置くこと。**
- `game/plan/plan-trajectory.ts:119` `toDisplay` … 点なので `toFramePoint`(サンプル時刻の
  変換)→ `toInertialPoint`(表示時刻の変換)。`FrameTransform` を2つ引く形になる。
- `game/hud/frame-labels.ts` … `FRAME_ITEMS` を定数表から**レジストリ由来の生成関数**へ。
  表示名は `${天体名}中心慣性系` / `${親名}-${天体名}回転系`。
- `game/camera/overview-camera-panel.ts` / `game/plan/plan-display.ts` … `FRAME_ITEMS` の
  参照方法だけ変わる。

**検証:** `npm run typecheck` / `npm run test:physics`
(`frame.test.ts` の往復テストを、原点が動く系 — `sunCentered` / `moonCentered` — にも広げること。
**「月が `moonCentered` で常に原点にいる」「月が `moonRotating` で常に +X 上にいる」**が
効く不変条件)。ゲーム側は、マップの座標系セレクタに太陽中心系・月中心系が現れ、
選ぶと視点と計画軌道線がその系に貼り付くことを目視で確認する。

---

### Phase 5 — 天体の見た目を `game/celestial/` へ

**5-1. `render/environment-scene.ts` を `game/celestial/environment-scene.ts` へ移動。**
すでに `game/` に依存しているので、これは規約違反の是正。import パスを直すだけ。

**5-2. `CelestialBody` を作る。**

```ts
// 天体1つぶんの見た目。位置・速度は持たない(Ephemeris が唯一の正本)。
export abstract class CelestialBody {
  abstract readonly id: AttractorId;
  abstract build(scene: THREE.Scene): void;
  abstract sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void;
}
```

- `EarthBody` … 現 `syncEarth`(自転角・`earth.tick`・`setSunDir`)。
- `SunBody` … 現 `syncSkyBodies` の太陽ビルボード部分 + `DirectionalLight` の向き。
  日照率による強度調整は自機位置に依存する**表示上の演出**なので、`EnvironmentScene` が
  `sunlitFactor` を計算して `SunBody` へ渡す形を維持する(`physics/` の値を `game/` で歪める
  という既存の切り分けどおり)。
- `PlanetBody` … 現 `placeCombatMoon` の表示距離圧縮を持つテクスチャ球。月と木星が共有する。
  スケール式(`visDist * radius / trueDist` で真の視直径を保つ)はここに1つだけ置く。

**5-3. `game/celestial/celestial-registry.ts`。**

```ts
export const CELESTIAL_VIEWS: Record<AttractorId, { name: string; create(): CelestialBody }>;
```

**表示名(`地球`/`月`/`太陽`/`木星`)の定義元はここ1箇所にする。**
`focus-markers.ts` / `frame-labels.ts` / `ship-placer-panel.ts` / `camera-system.ts` の
`PANEL_FOCUS_IDS` はすべてここを読む(日本語の表示文字列を `physics/` に置かないこと)。

**5-4. `EnvironmentScene` は天体ビューの配列を持つ形へ。** `sync` は
`for (const b of this.bodies) b.sync(...)` になり、星球・天球グリッド・参照軌道線・環境光だけが
直接の持ち物として残る。

**5-5. `camera-system.ts` の `PANEL_FOCUS_IDS`** をレジストリ由来にする
(天体本体のみ。ラグランジュ点は今までどおり右クリックメニュー経由)。

**検証:** `npm run typecheck` / ゲーム起動。地球・太陽・月の見た目、戦闘視点での月の
視直径、マップでの実スケール表示が今までどおりであること。

---

### Phase 6 — 木星の追加(受入テスト)

**6-1.** `physics/attractor.ts` の `AttractorId` に `'jupiter'` を足す。
**この時点でコンパイルエラーになる箇所が、天体追加に必要な作業の全量。**
`SOLAR_SYSTEM`(physics)と `CELESTIAL_VIEWS`(game)の2つの `Record` だけが赤くなるのが
正解。それ以外が赤くなったら、そこはまだレジストリ由来になっていない。

**6-2.** `SOLAR_SYSTEM.jupiter`:

| 項目 | 値 |
|---|---|
| parent | `'sun'` |
| mu | 1.26686534e17 m³/s² |
| radius | 6.9911e7 m(平均半径) |
| a | 7.78340821e11 m (5.20288700 au) |
| e | 0.04838624 |
| inc | 1.30439695° |
| Ω | 100.47390909°、Ω̇ = 0.20469106°/世紀 |
| ϖ | 14.72847983°、ϖ̇ = 0.21252668°/世紀 |
| L0 | 34.39644051° |
| 公転周期 | 11.862 年 → `lRate = 2π/(11.862 × 365.25 × 86400)` |

**6-3.** `CELESTIAL_VIEWS.jupiter` は `PlanetBody`。**テクスチャは用意しない** —
既存の月テクスチャを流用せず、単色マテリアル(帯模様なし)で置く。見た目の作り込みは
この Step の目的ではないので、ここで時間を使わないこと。

**6-4. 受入確認**(すべて手で確認する):

1. マップに `木星` ラベルと `太陽-木星 L1〜L5` が出る。
2. 座標系セレクタに `木星中心慣性系` と `太陽-木星回転系` が出る。選ぶと木星が静止する。
3. クリエイティブモードの基準天体に `木星` が出て、木星周回軌道に艦が置ける。
   置いた艦の軌道線が木星を中心に描かれる(`Elements.centerId` 経由)。
4. 木星を航法ターゲットにできる。
5. **`?perf=1` で update フェーズの ms を、Phase 0 の値と比べる。**
   重力源が 3 → 4 になり、`gravityAccel` は全エンティティ × RK4 4 段 × substep 数ぶん回る
   最内ループなので、+30% 程度の増加が出うる。許容できないほど悪化した場合は
   **その場で空間分割を作らず、ユーザーに報告して判断を仰ぐこと**(素案 Step3 の前倒しになる)。

---

### Phase 7 — 文書の更新(同じ変更セットに含める)

- **`CLAUDE.md`** … Architecture 節の `physics/ephemeris.ts` / `physics/frame.ts` /
  `physics/attractor.ts` / `render/environment-scene.ts` の記述を全面的に書き直す。
  新設モジュール(`ecliptic` / `analytic-orbit` / `solar-system` / `lagrange` / `shadow` /
  `game/celestial/*`)を追加。`test:physics` のカバー範囲の記述も更新する。
  **古い記述は消す。「かつては〜」を書かない。**
- **`DEVELOP/OWNERSHIP.md`** … `Ephemeris` の所有と、`EnvironmentScene` が持つ天体ビュー配列。
- **`DEVELOP/CALLSTACK.md`** … `sync` フェーズの天体まわりの呼び出し順。
- **`DEVELOP/SPEC.md`** … 選べる座標系が増えたこと、木星が存在すること、
  ラグランジュ点の表示名が変わったこと。
- **`.claude/skills/refactor-fixed/SKILL.md`** … §3(独自 `Vec3` と `THREE.Vector3` の境界)を
  **座標系の規約へ拡張する。** 素案が「refactor_fixed に反映すべき重要事案」と書いている点。
  書くべき内容:
  - 独自 `Vec3` / `OrbitState` は **ECI(地球中心慣性系)** を表す。これが既定であり、
    シミュレーションはすべてこの系で回る。
  - ECI 以外の座標系の値は **`frame.ts` の branded type**(`FramePoint` / `FrameDir` /
    `FrameOrbitState`)でしか持たない。生の `Vec3` に「実は月中心」の値を入れない。
  - **点と方向を混ぜない。** 位置は `FramePoint`、オフセット・速度差・上方向などの変位は
    `FrameDir`。原点が動く系ではこの取り違えが静かに壊れる。
  - 変換は必ず `Ephemeris.frameTransformAt` で引いた `FrameTransform` を通す。
    天体位置を自分で引き算して座標系を作らない。
  - 天体の静的事実は `physics/solar-system.ts`、表示名と見た目は
    `game/celestial/celestial-registry.ts`。**`AttractorId` に対する網羅的 `switch` を書かない**
    (常にレジストリを引く鍵として扱う)。
- **`memos/hedalu244/better_simulation_todo.md`** … Step2 を消し、Step3 の記述に
  「この時点で何が済んでいるか」を反映する(経緯は残さない)。
- 大きな変更なので、最後に **`/comment-cleanup`** で新旧コメントを一括点検する。

---

## 5. 落とし穴チェックリスト

実装中に必ず引っかかる/引っかかったことに気づきにくい点。

1. **`earthRotating` の x̂ が現 `sunRotating` と 180° 逆。** ẑ は同じなので
   ラグランジュ点も航法面法線も正しいまま、**視点の初期向きだけがひっくり返る**。
   バグではないので直そうとしないこと。
2. **`OverviewCamera` の3つの保存値は「方向」であって「点」ではない。**
   Phase 4 で `Point` 側に置くと、系を切り替えた瞬間にカメラが天体の位置ぶん飛ぶ。
3. **`sampled-line.ts` は頂点をフレーム相対で焼き、毎フレームは剛体変換だけを更新する。**
   原点移動を「頂点の書き換え」で実装すると毎フレーム全頂点を触ることになり、
   設計意図(O(1))が壊れる。**必ず `line.position` で表現すること。**
4. **地球の ECI 位置は厳密に 0 でなければならない。** 木を歩いた結果から地球ぶんを引く
   実装なら自動的に 0 になるが、地球だけ別経路で組むと 1e-5 m 程度の origin drift が入り、
   `attractorAccel` の原点補正項が壊れる。
5. **`attractorsAt` のメモが外れると重い。** リング長 4 と、`positionOf`/`sunDirAt` が
   同じメモを通ることを確認する。`?perf=1` で測る。
6. **太陽距離が定数でなくなる。** 距離を等号で見ているテスト・表示があれば範囲へ直す。
   `SUN_DIST` を「1 au の定数」として参照している箇所は `SOLAR_SYSTEM.earth.orbit.a` に寄せる。
7. **`Q_ECL_TO_ECI`(Z 上向き)と `Q_ECLY_TO_ECI`(Y 上向き)の取り違え。**
   前者は回転基準系の姿勢、後者は `stateFromElements` の出力の移送に使う。
   両方 `ecliptic.ts` に置き、コメントで用途を書き分けること。
8. **`elementsAround` のメモは `state` のオブジェクト同一性 + `body.id` に載っている。**
   `attractorsAt` が同一 `t` で同じ配列参照を返し続けることが前提なので、
   メモ化を外したり毎回新しい `Attractor` を作ったりしない。

---

## 6. この Step でやらないこと

- 空間ハッシュ・質量による重力源のカリング(素案 Step3)。**質量フィルタのコードも書かない。**
- 小惑星のような「積分軌道 + アトラクター」の中間種。`EntityManager` と
  `EnvironmentScene` の統合もまだやらない — **並べられる形にするところまで**が Step2。
- `sunlitFactor` の他天体への一般化(木星の影)。移動だけして中身は触らない。
- 木星のテクスチャ・大気・環などの見た目の作り込み。
- 天体の自転(地球以外)。`PlanetBody` は自転を持たない。
- `Elements` / `OrbitLine` の変更。`centerId` 経由でどの天体中心の楕円も描けるので、
  Step1 の成果だけで木星周回軌道の描画は通るはず。**通らなければそこにバグがある。**

---

## 7. フェーズごとの検証コマンド

```
npm run typecheck          # 全フェーズで必ず
npm run test:physics       # Phase 1〜4(physics/ を触るフェーズ)で必ず
npm run dev                # Phase 2 以降、目視確認
```

`/verify`(ヘッドレス実行)は Phase 6 の受入確認でだけ使う。
