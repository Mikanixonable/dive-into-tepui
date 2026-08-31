# 2次外挿を天体1体の口へ集約し、`CelestialBody` を層の間から外す

## 目的

天体の位置を「ある時刻で厳密に引き、そこから近傍時刻へ2次外挿する」計算が、いま2箇所に分かれて
いる。

- 天体1体の口(`CelestialEntity.stateAt(pivot, t)`)。時刻キャッシュを持ち、外挿はその上で走る。
- 物理層。`CelestialBody` という凍結値を受け取り、`celestialBodyPositionAt` /
  `celestialBodyStateAt` を**呼び出し側が直接**当てる(RK4 の各段・掃引接触・到達候補)。

後者があるために `CelestialBody` が層をまたいで持ち回られ、天体1体が答えるべきことを外の
モジュールが組み立てている。**外挿の口を1つにし、`CelestialBody` を口の内側のキャッシュ値へ
畳む。**

持ち回るものが凍結値から時刻へ変わることで、**「どの時刻で厳密に引き、どの時刻へ外挿して
いるか」が呼び出しの形にそのまま現れる。** いまはこれを知るのに、値がどこで組まれてどこまで
渡ったかを遡る必要がある。呼び出しの形に出れば、pivot の種類を減らす・区間を寄せるといった
軽量化の余地を、コードを読むだけで探せるようになる — これも目的の一つ(手順6)。

## 決めたこと

### A. 口の持ち主は `CelestialMotion`

`src/physics/` は `src/game/` を import できない(CODING-RULE 1.3)。`CelestialEntity` は
`src/game/` にあり THREE を引くので、物理層が名指しできない。口を物理層から呼ぶには次のどちらか。

| 案 | 形 | 代償 |
| --- | --- | --- |
| **A1(採用)** | `CelestialMotion` が `EciTransform` を結ばれ、`stateAt(pivot, t)` を答える。`CelestialEntity` はそこへ委譲する | ECI の解決とキャッシュが `CelestialMotion` へ降りる |
| A2 | `src/physics/` にインタフェースを置き、`CelestialEntity` が実装する | 依存の逆転。物理層の関数が game 層の実装を握る |

A1 を採る。ECI 化とその時刻キャッシュは THREE に依らない物理の計算で、THREE を引くクラスに
置く理由がない。原点をどの天体に置くかは系レベルの選択のままで、**構築引数ではなく
`bindEciTransform` で結ぶ**(`bindEphemeris` と同型)。

覆すなら手順2が変わる。A2 にすると手順2は「`physics/celestial-source.ts`(新規)を置き、
`CelestialEntity` に実装させる」になり、手順3以降の引数の型が `CelestialMotion` から
そのインタフェースへ替わるだけで、手順の並びは変わらない。

### B. pivot は素の `number` 引数として持ち回る

pivot を天体一覧と束ねた型は作らない(CODING-RULE 1.6)。**渡すのは引数1つ。**

```ts
// いま
export function attractorAccel(r: Vec3, attractor: CelestialBody, t: number): Vec3;
// これから
export function attractorAccel(
  r: Vec3, attractor: CelestialMotion, pivot: number, t: number,
): Vec3;
```

ただし pivot は**呼び出し側で再計算できない。** サブステップの窓は区間の中点
(`simTime + dt/2`)で解決され、その1組を個体ごとの細分(`substepDivisions`)の内側でも
使い回す。細分の内側では `state.t + dt/2` は中点と一致しないので、解決した時刻そのものを
下まで渡す必要がある。

**1回の積分ステップに pivot は2つ現れる。** 重力源と大気は区間の中点で、表面と遮蔽体は区間の
開始時刻で解決されているため。値を変えないので、両方をそのまま持ち回る。

### C. `CelestialBody` は完全に消す

いま `CelestialBody` が持つものは、行き先が3つに分かれる。

| フィールド | 行き先 |
| --- | --- |
| `id` / `mu` / `radius` / `isStar` | 時刻に依らないので `CelestialMotion.def` / `kind` |
| `state` / `accel` / `degree2` / `atmosphere` | `CelestialMotion` の時刻キャッシュの中身(非公開) |

値オブジェクト(`OrbitalElements` / `SecondaryFrame` / `FrameAnchorSource`)が持っている
「天体 + その瞬間の状態」の対は、`CelestialMotion` と `KinematicState` の2フィールドへ割る。
`accel` も `degree2` も `atmosphere` もこれらは要らないので、対を共有の型にする理由がない。

### D. 手順1〜5 は精度を変えない。手順6 だけが近似を動かす

現在の呼び出しはすべて「解決した時刻を pivot に、そこから外挿」の形で書ける。手順5 までを
写し終えた時点で、値はビット一致していなければならない。固定値テスト
(`celestial-eci-baseline`)が合格の物差し。

**手順6 は意図的にビット一致を崩す。** 1サブステップに現れる pivot を1つへ寄せる近似で、
効果と代償が測れるのは手順5 まで終わってからなので、最後に置く。

### E. `205d2a9f` を revert する

`205d2a9f`(「天体の状態を引くとき pivot を必ず明示させる」)は `stateAt` の既定引数
`t = pivot` を外し、17ファイル・30箇所を `stateAt(t, t)` へ書き換えたもの。外挿が物理層に
散ったままでは pivot を明示する先が無く、`stateAt(t, t)` が並ぶだけになる。**手順1で戻す。**
表示側は厳密な値しか要らないので既定引数のままでよく、pivot を明示するのは積分側だけになる。

## 達成目標

- `grep -rn "celestialBodyStateAt\|celestialBodyPositionAt" src/ tests/` が
  `src/physics/celestial-motion.ts` の内側だけになる(外挿の実装が1箇所)。
- `grep -rn "CelestialBody" src/ tests/` が 0 件(型が消えている)。
- `src/physics/celestial-body.ts` が消え、その中の自由関数が引き取り先へ移っている。
- `CelestialSystem` から `allCache`(`TimeRing<readonly CelestialBody[]>`)と
  `celestialBodiesAt` / `gravityAttractorsAt` / `atmosphereCelestialBodiesAt` の時刻引数が
  消えている — 一覧は時刻に依らず、時刻ごとの解決は天体1体が畳む。
- `npm run typecheck` / `npm run test`(全層)/ `npm run build` が通り、
  `celestial-eci-baseline` の固定値が1文字も変わらない。

## 手順

### 手順2. ECI の解決と時刻キャッシュを `CelestialMotion` へ下ろす

**目的.** 物理層が名指しできる場所に、外挿の口とその土台のキャッシュを置く。
**この時点で挙動は変えない** — `CelestialEntity` は同じ値を委譲で返す。

**目指す形**

```ts
// src/physics/celestial-motion.ts

// pivot 1時刻ぶんの、解決済みの ECI の値。外挿の土台。
type EciValues = {
  readonly state: KinematicState;
  readonly accel: Vec3;                        // ECI 加速度 [m/s²]
  readonly degree2: Degree2Gravity | null;
  readonly atmosphere: Atmosphere | null;
};

export abstract class CelestialMotion {
  private readonly eciCache = new TimeRing<EciValues>();
  private eciTransform: EciTransform | null = null;

  // ECI 化の変換器を結ぶ。結ぶまでは ECI 値を答えられない。
  bindEciTransform(transform: EciTransform): void;

  // pivot で厳密に引いた値から時刻 t へ2次外挿した ECI 位置・速度。t を省くと pivot 自身の
  // 厳密な値。|t − pivot| は積分1歩の幅程度に収めること。
  stateAt(pivot: number, t: number = pivot): KinematicState;

  // 同じ外挿の位置だけ。
  positionAt(pivot: number, t: number): Vec3;

  // pivot での姿勢込みの2次重力場・大気。持たない天体は null。
  degree2At(pivot: number): Degree2Gravity | null;
  atmosphereAt(pivot: number): Atmosphere | null;
}
```

`degree2At` / `atmosphereAt` はいま呼ぶたびに姿勢を組み直している。`EciValues` へ畳むことで
pivot ごとに1回になる。**この畳み込みが無いと、手順3で RK4 の各段が姿勢を組み直すことになる。**

| ファイル | 何をするか |
| --- | --- |
| `src/physics/celestial-motion.ts` | 上の形を実装。`degree2At` / `atmosphereAt` を `eciCache` 経由へ差し替え、素の計算は private へ落とす |
| `src/physics/eci-transform.ts` | `celestialBodyAt(t, motion)` を `EciValues` を返す形へ(`id`/`mu`/`radius`/`isStar` を落とす) |
| `src/game/celestial/celestial-entity/celestial-entity.ts` | `eciCache` / `bindEciTransform` / `eci` を削除。`stateAt` は `this.motion.stateAt(pivot, t)` へ委譲。`bodyAt` は削除し、呼び出し元を手順4で置き換えるまでの間だけ `this.motion` 経由の同値を返す |
| `src/game/celestial/celestial-system.ts` | `entity.bindEciTransform` を `motion.bindEciTransform` へ。`perfCounts` の集計元を差し替え |
| `src/physics/celestial-body.ts` | `CelestialBody` から `state`/`accel`/`degree2`/`atmosphere` を読む経路が残るので、この手順では型はそのまま。`celestialBodyAt` の組み立てだけ `CelestialSystem` 側へ寄せる |
| `tests/physics/equatorial-satellites.test.ts` | `new EciTransform(...).stateAt(t, motion)` を結び直しの形へ |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)。
`grep -rniE "eci" src/game/celestial/celestial-entity/celestial-entity.ts` が 0 件。
`celestial-eci-baseline` の固定値が変わらない。

### 手順3. 物理層の天体引数を `CelestialMotion` + pivot へ移す

**目的.** RK4 の各段・掃引接触・遮蔽が自分で外挿するのをやめ、天体1体の口へ問い合わせる形に
する。**外挿の実装が `celestial-motion.ts` の内側だけになる。**

**目指す形**

```ts
// src/physics/dynamics.ts
export function stepDynamics(
  state: KinematicState,
  dt: number,
  attractors: readonly CelestialMotion[],
  attractorPivot: number,          // attractors を厳密に引いた時刻
  occluders: readonly CelestialMotion[],
  occluderPivot: number,           // occluders を厳密に引いた時刻
  atmosphereBody: CelestialMotion | null,
  bcInv: number,
  srpCoeff: number,
  thrust: Vec3 | null,
): KinematicState;
```

`totalAccel` の中は `celestialBodyPositionAt(attractor, t)` が
`attractor.positionAt(attractorPivot, t)` になるだけで、式は変わらない。

| ファイル | 何をするか |
| --- | --- |
| `src/physics/celestial-body.ts` | `attractorAccel` / `strongestAttractor` / `nearestAtmosphereBody` / `localOrbitPeriod` / `orbitalElementsOf` / `orbitingAttractorOf` / `frameOfCelestialBody` / `bodyAnchorSource` を `CelestialMotion` + pivot へ。`celestialBodyPositionAt` / `celestialBodyStateAt` / `CelestialBody` / `CelestialBodyWindows` を削除し、残る自由関数を `celestial-motion.ts` か新しい引き取り先へ移してファイルを消す |
| `src/physics/dynamics.ts` | 上のシグネチャ。`degree2` は `attractor.degree2At(attractorPivot)` |
| `src/physics/surface-contact.ts` | `celestialBodyStateAt(body, next.t)` を `body.stateAt(pivot, next.t)` へ。pivot を引数に足す |
| `src/physics/occlusion.ts` | 遮蔽体の位置を `occluder.positionAt(pivot, pivot)` へ(いまも外挿していないので pivot をそのまま渡す) |
| `src/physics/srp.ts` / `src/physics/shadow.ts` | 同上 |
| `src/physics/trajectory-features.ts` / `src/physics/orbit-solvers.ts` | `centerStateAt` / `centerPositionAt` の既定引数を `center.stateAt(pivot, t)` へ。pivot を引数に足す |
| `src/physics/atmosphere.ts` | コメント中の `CelestialBody.radius` 参照を書き換え |

**達成条件と検証.** `npm run typecheck` / `npm run test:physics`。
`grep -rn "celestialBodyPositionAt\|celestialBodyStateAt" src/physics/` が
`celestial-motion.ts` の内側だけ。`ls src/physics/celestial-body.ts` が無い。

### 手順4. 天体の窓と弧の一覧を `CelestialMotion` + pivot へ移す

**目的.** 時刻ごとに配列を組み直す窓をやめる。**一覧は時刻に依らず、時刻ごとの解決は天体1体が
畳む。** `CelestialSystem` の配列キャッシュが構造ごと消える。

**目指す形**

```ts
// src/game/dynamic/substep-celestial-bodies.ts
export class SubstepCelestialBodies {
  // 区間 [simTime, simTime + dt] の窓を組み直す。
  reset(system: CelestialSystem, simTime: number, dt: number): void;

  readonly gravityPivot: number;    // = simTime + dt / 2
  readonly surfacePivot: number;    // = simTime
  get surface(): readonly CelestialMotion[];
  get atmosphere(): readonly CelestialMotion[];
  get star(): CelestialMotion | null;
  attractorsNear(r: Vec3): readonly CelestialMotion[];
  atmosphereBodyNear(r: Vec3): CelestialMotion | null;
}

// src/game/dynamic/attractors.ts
export type ClassifiedAttractors = {
  readonly always: readonly CelestialMotion[];
  readonly grid: SpatialGrid<CelestialMotion>;
};
export function classifyAttractors(
  attractors: readonly CelestialMotion[], pivot: number,
): ClassifiedAttractors;
```

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/celestial-system.ts` | `allCache` を削除。`celestialBodiesAt(t)` / `gravityAttractorsAt(t)` / `atmosphereCelestialBodiesAt(t)` を時刻引数の無い一覧の getter へ。`celestialBodyAt(id, t)` を削除 |
| `src/game/dynamic/substep-celestial-bodies.ts` | 上の形。分類は `gravityPivot` で組む |
| `src/game/dynamic/attractors.ts` | 上の形。`SpatialGrid` へ載せる位置を `motion.positionAt(pivot, pivot)` で引く |
| `src/game/dynamic/simulator.ts` | 2つの pivot を `stepSimulation` へ渡す |
| `src/game/dynamic/dynamic-entity/dynamic-entity.ts` | `stepSimulation` / `historySampleInterval` の天体引数と pivot |
| `src/game/dynamic/dynamic-entity/{bullet,contact,debris-piece,enemy}.ts` | 同じ引数の追従 |
| `src/game/dynamic/dynamic-system.ts` / `time-step.ts` / `surface-candidates.ts` / `surface-contact-physics.ts` | 天体引数と pivot |
| `src/game/dynamic/arc-celestial-bodies.ts` / `predicted-arc.ts` | `FutureCelestialBodyProvider` を `CelestialMotion` の一覧へ。`resolve(t, …)` が返すのは一覧と pivot |
| `src/physics/dynamic-trajectory.ts` | `step` の天体引数と pivot。`_extrapolationCenter` を `CelestialMotion` + その pivot の2フィールドへ |
| `src/render/pipeline/{lighting/planet-light-select,sun-occlusion-select}.ts` | 天体引数と pivot |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)。
`grep -rn "celestialBodiesAt(" src/` の呼び出しに時刻引数が無い。
`window-agreement` と `predicted-arc` のテストが変更なしで通る。

### 手順5. 値オブジェクトから `CelestialBody` を外す

**目的.** 「天体 + その瞬間の状態」を1つの凍結値で持っている型を、`CelestialMotion` と
`KinematicState` の2フィールドへ割る。これで `CelestialBody` の最後の参照が消える。

**目指す形**

```ts
// src/physics/elements.ts
export interface OrbitalElements {
  // …(幾何の量は変わらない)
  readonly center: CelestialMotion;      // 中心天体。mu と radius をここから読む
  readonly centerState: KinematicState;  // その中心天体の、要素を組んだ瞬間の ECI 状態
}

// src/physics/lagrange.ts
export type SecondaryFrame = {
  readonly secondary: CelestialMotion;
  readonly secondaryState: KinematicState;
  readonly primary: CelestialMotion;
  readonly primaryState: KinematicState;
  readonly rotation: FrameRotation;
  readonly normal: Vec3;
};

// src/physics/frame.ts
export interface FrameAnchorSource {
  readonly bodies: readonly CelestialMotion[];
  readonly bodiesPivot: number;
  stateOf(id: string, t: number): KinematicState | null;
  attractorOf(id: string, t: number): string | null;
}
```

| ファイル | 何をするか |
| --- | --- |
| `src/physics/elements.ts` | `center` を2フィールドへ。`el.center.mu` / `el.center.radius` は `def` 経由 |
| `src/physics/lagrange.ts` / `src/physics/orbit-guide.ts` / `src/physics/earth-reference-orbits.ts` / `src/physics/kepler-extrapolation.ts` | 同じ割り方に追従 |
| `src/physics/frame.ts` / `src/game/frame-anchors.ts` | `bodies` と `bodiesPivot` |
| `src/game/lines/orbit-line.ts` | `el.center.state.r` を `el.centerState.r` へ。**頂点ループの外へ巻き上げる** |
| `src/game/` の残り 30 ファイル(`hud/orbit/` 6・`plan/` 5・`creative/` 4・`marker/` 3・`pickable/` 2・`player/` 3・`celestial/` 4・その他 3) | 型注釈と `body.state` 読みの追従 |

**達成条件と検証.** `npm run typecheck` / `npm run test`(全層)/ `npm run build`。
`grep -rn "CelestialBody" src/ tests/ DEVELOP/ CLAUDE.md .claude/` が 0 件。
`npm run smoke:browser`。マップビューで参照軌道線・ラグランジュ点ラベル・静止軌道リングを見る。

### 手順6. 1サブステップの pivot を中点1つへ寄せる

**目的.** pivot の種類が減るほど天体1体の時刻キャッシュが当たり、暦の評価回数が減る。
**この手順だけは値が変わる** — 近似を1つ動かす。

いまサブステップ1回に現れる pivot は3種で、天体1体につき3回ぶんキャッシュが埋まる。

| pivot | 何を解決しているか |
| --- | --- |
| `simTime` | 表面・遮蔽体(`celestialBodiesAt`) |
| `simTime + dt/2` | 重力源・大気(`gravityAttractorsAt` / `atmosphereCelestialBodiesAt`) |
| `endTime` | 消滅判定が読む大気天体(`Simulator.atmosphereBodies`)。次のサブステップの `simTime` と同じ値になるので、実質の増分は1つ |

これを中点1つへ寄せる。**表面側は外挿の幅がむしろ縮む** — いま `simTime` を pivot に
`[simTime, endTime]` を覆っているので最大 `|t − pivot| = dt`、中点からなら `dt/2` になる。
遮蔽体は区間内の天体の移動にほとんど左右されない量なので、半ステップの移動は効かない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/substep-celestial-bodies.ts` | `surfacePivot` を削除し、`gravityPivot`(中点)1つにする |
| `src/game/dynamic/simulator.ts` | `beginSubstep` と `cleanup` へ渡す pivot を中点へ。`atmosphereBodies()` の pivot も中点へ |
| `src/game/dynamic/surface-contact-physics.ts` / `surface-candidates.ts` | 受け取る pivot が中点になるだけ(コードは変わらない) |

**達成条件と検証**

- `npm run typecheck` / `npm run test`(全層)。**トレランスで判定しているテスト
  (`window-agreement` / `surface-candidates` / `predicted-arc` / `dynamics`)が通ること**が
  近似の許容範囲の物差し。落ちたら、その差が近似の限界なのかバグなのかを切り分けてから戻す。
- `npm run dev` の負荷確認ウィンドウで `timeCacheMisses` を手順5 完了時と比べる。
  導出: 天体 N 体・サブステップ S 回として、いまの充填は `N × 2S`(simTime と中点)。
  寄せたあとは `N × S`。**実シミュレーション由来のミスが半減していれば効いている。**
- 大気圏再突入と地表着陸を実機で通し、接触の瞬間が変わっていないことを見る。

## 見積り

| 手順 | ファイル | 根拠 |
| --- | --- | --- |
| 1 | 17 | `205d2a9f` が触った数そのまま(revert) |
| 2 | 6 | ECI 化に触るのは motion・変換器・entity・system と、その2テスト |
| 3 | 9 | `src/physics/` で `CelestialBody` を受ける 18 ファイルのうち、値オブジェクト側(手順5)を除いた数 |
| 4 | 16 | `src/game/dynamic/` 14 + `src/render/pipeline/` 2 |
| 5 | 36 | `src/physics/` 6 + `src/game/` 30 |
| 6 | 4 | サブステップの窓と、それを呼ぶ側 |

合計 **約 88 ファイル**(重複あり)。`CelestialBody` を参照するファイルは現状 74 で、うち 17 は
型注釈だけを通しているので機械的に写せる。

実行時コスト: `celestialBodyPositionAt` の直線コードの前に `TimeRing.get` の照合が入る。
`TimeRing` は 32 段の線形走査なので、RK4 の各段 × 天体数 × 細分 × 個体数ぶん走る。
**サブステップの中では同じ pivot が連続するので、`eciCache` の前に直前の pivot 1段の
先頭比較を置く**(手順2で入れる)。それでも実測が悪化するなら、手順4の完了時点で
`npm run dev` の負荷確認ウィンドウで `timeCacheHits` / `timeCacheMisses` を読んで判断する。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| `degree2At` / `atmosphereAt` を pivot ごとに畳まないまま手順3へ進む | RK4 の各段が姿勢(三角関数と直交化)を組み直し、積分が目に見えて重くなる。**値は正しいので絵にも数値にも出ない** | 手順2。`grep` で `orientationAt` の呼び出しが `eciCache` の内側だけになっていることを見る。手順4完了時に負荷確認ウィンドウ |
| 2つの pivot(重力=中点 / 表面=開始時刻)を、手順3・4 のうちに1つへ揃えてしまう | 天体位置が半ステップぶんずれる。低軌道で数百 m、月で数十 km。**絵では気付けない。** 手順6 でやると決めた変更が、写し替えの中に紛れて評価できなくなる | 手順3・4。`window-agreement` と `celestial-eci-baseline` |
| 手順6 でトレランス判定のテストが通ったことを「値が変わっていない」と読む | 近似が動いたことが記録に残らず、次に軌道がずれたときの原因候補から外れる | 手順6。通ったテストの許容幅と、実測した差を報告に書く |
| 細分(`substepDivisions`)の内側で pivot を `state.t + dt/2` から再計算する | 再突入中の個体だけ天体位置がずれ、接触判定と加熱がずれる | 手順4。再突入を含む `surface-candidates` / `time-step` のテスト |
| `SpatialGrid` へ載せる位置を pivot でなく問い合わせ時刻で引く | 分類が問い合わせごとに変わり、1回の分類を使い回す前提が崩れて O(N log N) が毎点走る | 手順4。負荷確認ウィンドウの `gravitySources` と実測フレーム時間 |
| `OrbitalElements` の `centerState` を、要素を組んだ瞬間と違う時刻で詰める | 軌道楕円が中心天体からずれた位置に描かれる | 手順5。マップビューの参照軌道線 |
| `orbit-line.ts` の頂点ループの中で `centerState` を引き直す形にする | 頂点数ぶん暦が走り、軌道線の描画が重くなる | 手順5。マップビューで軌道線を出したときのフレーム時間 |
| `DynamicTrajectory._extrapolationCenter` の pivot がフレームを越えて古くなる | `TimeRing` から落ちて再計算になる。値は同じだが、ケプラー外挿の最大 2048 サンプルぶん暦が走る | 手順4。軌道線を長く伸ばしたときのフレーム時間 |
| `EciTransform.stateAt(t, motion)` と `FrameAnchorSource.stateOf(id, t)` を同じ口と見て巻き込む | 座標系の解決が壊れ、マップのカメラと軌道線が飛ぶ | 手順2・5。`npm run test:physics`、マップビュー |
| `celestial-body.ts` を消すとき、そこにあった自由関数の引き取り先を決めずに `celestial-motion.ts` へ全部入れる | 500行の目安を超え、運動と重力場の判定が同じファイルへ混ざる | 手順3。`wc -l src/physics/celestial-motion.ts` |
