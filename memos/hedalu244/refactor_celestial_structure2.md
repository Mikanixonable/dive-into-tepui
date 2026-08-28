# 天体側の再編 — 所有木を GameEntity 側へ揃える計画

行番号付きの参照はすべて `f2952a24` 時点のコードから引いた着手点。食い違ったらコードを信じる。

## 目的

天体まわりが、次の形で割れている。

- **管理者が2つ。** 物理は `Ephemeris`(`physics/ephemeris.ts`)、見た目は `EnvironmentScene`
  (`game/celestial/environment-scene.ts`)が別々に天体を列挙し、両者を繋ぐのは id 文字列だけ。
  `GameEntity` 側が `EntityManager` → `GameEntity` の1本の木であるのに対し、天体は id / `CelestialBodyDef`
  / `CelestialBody` / `CelestialView` の4つに散っていて「天体1体」を指すオブジェクトが無い。
- **星系が「定数表」で表されている。** `SOLAR_SYSTEM`(`physics/solar-system.ts:505-2026`)は
  `Record<id, CelestialBodyDef>` で、衛星と惑星の関係は `planet: 'earth'` という文字列。`Ephemeris` の
  コンストラクタ(`:151-178`)が表を文字列 id で解釈して木を組み直す。関係が2箇所(表の文字列と、
  解釈後の木)にある。
- **静的事実の正本が2箇所。** `game/celestial/celestial-registry.ts:37,48,54,63,74,84,103` が
  半径・形状・環を `bodyDef(SOLAR_SYSTEM, id)` から取る。実行中の星系ではなく現実の太陽系を直接
  引くので、別の星系が同じ id を別のパラメータで再定義した瞬間、見た目だけが現実の値で描かれる。
- **「registry」が2つの別物を指す。** `CelestialRegistry`(静的事実の表)と `CELESTIAL_VIEWS`
  (`celestial-registry.ts`、日本語名 + View 選択)。
- **参照軌道線の持ち主が GameEntity 側と逆。** エンティティは線の実体を個体が持ち、出す/消す判断を
  `EntityLineManager` が持つ。天体は `EnvironmentScene` が実体(`referenceLines: Map`)も判断
  (`syncReferenceLines`)も持つ。
- **見た目の事実が5つの表に分散。** `CELESTIAL_VIEWS`、`BODY_CLASSES`(`body-class.ts`)、
  `CELESTIAL_ALBEDO`(`render/celestial-albedo.ts:34-117`)、`CELESTIAL_TEXTURES`
  (`render/celestial-textures.ts:39-67`)、`ATMOSPHERE_OPTICS`(`render/atmosphere-params.ts:20-39`)。
  すべて id をキーにした表。
- `physics/solar-system.ts` が 2045 行。

修正後は、**天体1体を1つのオブジェクト(`CelestialEntity`)が表し、それらを1つの所有者
(`CelestialSystem`)が持つ**。`CelestialSystem` は任意の星系を表せる構造で、太陽系は
「関係を参照で組んで `CelestialSystem` を返す構築コード(パック)」として表され、定数表と
`Ephemeris` は存在しない。天体1体の物理は個体が所有する `CelestialMotion` が答える。見た目の事実は
天体ごとの構築箇所に置かれ、参照線は個体が持ち判断は所有者が持つ。

### 目標の保持木

```
Launcher.startRun
├─ celestialSystem = await stageClass.createCelestialSystem(phaseOffsets, onProgress, startSimTime)
│     └─ 既定の Stage は太陽系パック solarSystem(originId: 'earth', phaseOffsets, absoluteSource, …) を呼ぶ
│        架空星系のステージは自分のパック(zephyrusSystem())を呼ぶ
└─ new Game(…, celestialSystem, …)   → celestialSystem.build(scene, pipeline.*)、dispose は Game

CelestialSystem(game。任意の星系の所有者)
   ├─ bodies: CelestialEntity[]       宣言順。GameEntity の対応物
   │   ├─ id / name / bodyClass / def(静的事実。motion.def)
   │   ├─ motion: CelestialMotion     物理(下記)。GameEntity.actual: DynamicTrajectory の対応物
   │   ├─ メッシュ・輝点・環(RingView)・大気の光学・表面ライン
   │   ├─ referenceLine: OrbitLine | null
   │   ├─ build / setVisible / sync / dispose
   │   └─ 派生: Earth(静止軌道リング・GEO ラベル・自転初期位相)、Sun
   ├─ origin: CelestialEntity / star: CelestialEntity | null / bodyOf(id) / has(id) / sunDirFrom(r, t) / serialize()
   ├─ frames: ReferenceFrames         座標系の同一性(frameOf のキャッシュ)と、天体でない基準の解決。回転は motion へ委譲
   ├─ windows: CelestialBodyWindows   同一時刻の窓(celestialBodiesAt / gravityAttractorsAt / atmosphereCelestialBodiesAt)
   ├─ 照明フィード(恒星光・露出・天体照・遮蔽・環の影・大気パス)— bodies から集める
   ├─ 星野・天球グリッド・縮尺グリッド・ライティングアンカー・OrbitGuideLines・ZeroVelocityLines・PointFieldView
   └─ update / sync / dispose

CelestialMotion(physics。THREE 非依存。天体1体の時刻 → 状態)
   ├─ def / phase / origin(ECI の中心。パック呼び出しの引数で決まる)/ pack(暦パック、あれば)
   ├─ at(pivot): CelestialBody           pivot の厳密な ECI 状態 + 加速度。32 段の時刻メモ
   ├─ stateAt(pivot, t): KinematicState  at(pivot) からの2次近似。stateAt(t) は pivot = t の略記
   ├─ orientationAt(t) / spinRotationAt(t) / degree2At(t) / atmosphereAt(t)
   └─ 派生: StarMotion
            OrbitingMotion { primary: CelestialMotion; keplerOrbit;
                             orbitFrameRotationAt / orbitNormalAt / lagrangeAt / lagrangeStateAt
                             / hasUsableCollinearPoints / hasStableTriangularPoints }   ← 副天体の所有物
              ├─ PlanetMotion { star: StarMotion | null; satellites: SatelliteMotion[] }(重心補正)
              └─ SatelliteMotion { planet: PlanetMotion }

太陽系パック(構築コード。系ごとに physics と game の2ファイルを参照で対にする)
   physics/solar-system/earth-system.ts   earthSystem(sun, phases, pack, epoch) → { earth: PlanetMotion, moon: SatelliteMotion }
   game/celestial/solar-system/earth-system.ts   earthSystemEntities(m) → { earth: new Earth(m.earth), moon: new SphereEntity(m.moon, '月', …) }
   physics/solar-system/solar-system.ts   solarSystemMotions(originId, phases, pack, …) → { sun, earthSystem, marsSystem, …, all }(all は宣言順)
   game/celestial/solar-system/solar-system.ts   solarSystem(originId, phases, pack, …) → CelestialSystem
```

天体1体を指す型は3つに絞る。`CelestialBodyDef`(時刻に依らない事実。`kind` と `planet` id は持たない —
分類はクラス、関係は参照)、`CelestialEntity`(個体)、`CelestialBody`(時刻 t の瞬間の窓。
`attractorAccel` 等の物理関数が読む値)。`FutureBodyCandidate` / `CelestialView` / `CelestialRegistry` /
`Ephemeris` は消える。

系レベルに残るのは `ReferenceFrames` と `CelestialBodyWindows` だけで、どちらも
`bodies.map((b) => b.motion)` から組む。id で突き合わせる第2の構造は無い。

### 主要な型と署名

全手順が終わった時点の形。各手順はここを指し、途中の経過形はその手順に書く。既存の型
(`KinematicState` / `Vec3` / `CelestialBody` / `BodyOrientation` / `FrameRotation` / `Degree2Gravity` /
`Atmosphere` / `LagrangePoints` / `ReferenceFrame` / `FrameRotationSource` /
`FrameTransform` / `FrameAnchorSource` / `KeplerOrbit` / `PlanetOrbit` / `SatelliteOrbit` / `PoleModel` /
`Degree2GravityDef` / `ShapeDef` / `AtmosphereDef` / `RingSystemDef` / `OriginCenteredEphemeris` /
`AbsoluteEphemeris` / `TimeCacheStats` / `OrbitalElements` / `AtmosphereOptics` / `CelestialSurface` /
`LineOverlay` / `OrbitLine`)は今のまま。

```ts
// physics/celestial-motion.ts
export type PhaseOffsets = Partial<Record<string, number>>;   // save-data.ts:333 と同じ形

export type StarDef = { readonly id: string; readonly mu: number; readonly radius: number };
export type PlanetDef = {
  readonly id: string; readonly mu: number; readonly radius: number;
  readonly orbit: PlanetOrbit;
  readonly pole?: PoleModel; readonly degree2?: Degree2GravityDef; readonly shape?: ShapeDef;
  readonly atmosphere?: AtmosphereDef; readonly rings?: RingSystemDef; readonly lagrangeLabels?: boolean;
};
export type SatelliteDef = Omit<PlanetDef, 'orbit'> & { readonly orbit: SatelliteOrbit };   // planet の id は持たない
export type CelestialBodyDef = StarDef | PlanetDef | SatelliteDef;
export type CelestialKind = 'star' | 'planet' | 'satellite';

// ECI の中心。原点天体自身も自分を参照するので、全 motion を作ってから1度だけ set する。
export class EciOrigin {
  get motion(): CelestialMotion;            // 未設定なら throw
  set(motion: CelestialMotion): void;       // 2度目は throw
}

export abstract class CelestialMotion {
  readonly def: CelestialBodyDef;
  readonly phase: number;                   // 平均黄経の初期位相 [rad]
  abstract readonly kind: CelestialKind;
  get id(): string;
  protected constructor(
    def: CelestialBodyDef, phase: number, epochOffsetSec: number,
    pack: OriginCenteredEphemeris | null, origin: EciOrigin,
  );
  abstract helioStateAt(t: number): KinematicState;     // 恒星中心。TimeRing でメモ
  abstract helioAccelAt(t: number): Vec3;
  at(pivot: number): CelestialBody;                     // pivot の ECI 状態 + 加速度 + 姿勢込みの重力場・大気
  stateAt(t: number): KinematicState;                   // = stateAt(t, t)
  stateAt(pivot: number, t: number): KinematicState;    // celestialBodyStateAt(this.at(pivot), t)
  orientationAt(t: number): BodyOrientation | null;
  spinRotationAt(t: number): FrameRotation | null;
  degree2At(t: number): Degree2Gravity | null;
  atmosphereAt(t: number): Atmosphere | null;
  get spinRate(): number | null;
  get cacheStats(): TimeCacheStats;
}
export class StarMotion extends CelestialMotion {
  readonly def: StarDef;
  constructor(def: StarDef, phase: number, epochOffsetSec: number, pack: OriginCenteredEphemeris | null, origin: EciOrigin);
}
export abstract class OrbitingMotion extends CelestialMotion {
  abstract readonly primary: CelestialMotion | null;    // 惑星: 恒星(無い星系では null)、衛星: 惑星
  abstract readonly keplerOrbit: KeplerOrbit;
  orbitFrameRotationAt(t: number): FrameRotation;
  orbitNormalAt(t: number): Vec3;
  lagrangeAt(t: number): LagrangePoints;                // primary が null なら throw
  lagrangeStateAt(point: keyof LagrangePoints, t: number): KinematicState;
  hasUsableCollinearPoints(minClearanceRatio: number): boolean;
  hasStableTriangularPoints(): boolean;
}
export class PlanetMotion extends OrbitingMotion {
  readonly def: PlanetDef;
  readonly star: StarMotion | null;
  readonly satellites: readonly SatelliteMotion[];      // SatelliteMotion のコンストラクタが積む
  constructor(def: PlanetDef, star: StarMotion | null, phase: number, epochOffsetSec: number, pack: OriginCenteredEphemeris | null, origin: EciOrigin);
}
export class SatelliteMotion extends OrbitingMotion {
  readonly def: SatelliteDef;
  readonly planet: PlanetMotion;
  constructor(def: SatelliteDef, planet: PlanetMotion, phase: number, epochOffsetSec: number, pack: OriginCenteredEphemeris | null, origin: EciOrigin);
  relStateAt(t: number): KinematicState;                // 惑星相対。TimeRing でメモ
}

// physics/celestial-body.ts — 自由関数の対は残す。積分の内側(dynamics.ts)が窓の値に当てるための口で、
// celestialBodyPositionAt は速度の Vec3 を作らない。motion.stateAt(pivot, t) は celestialBodyStateAt を呼ぶ。
export function celestialBodyPositionAt(a: CelestialBody, t: number): Vec3;
export function celestialBodyStateAt(a: CelestialBody, t: number): KinematicState;

// physics/reference-frames.ts
export class ReferenceFrames {
  constructor(motions: readonly CelestialMotion[], origin: CelestialMotion);
  readonly inertialFrame: ReferenceFrame;
  readonly frames: readonly ReferenceFrame[];
  frameOf(center: string, rotatingWith: FrameRotationSource | null): ReferenceFrame;   // 同じ対に同じ参照。center は天体 id か役割トークン('@activeShip' 等)か機体 id
  frameFor(id: string): ReferenceFrame;
  transformAt(frame: ReferenceFrame, t: number, source: FrameAnchorSource): FrameTransform;
}

// physics/celestial-body-windows.ts
export class CelestialBodyWindows {
  constructor(motions: readonly CelestialMotion[]);
  celestialBodiesAt(t: number): readonly CelestialBody[];          // 同一 t に同一配列
  gravityAttractorsAt(t: number): readonly CelestialBody[];
  atmosphereCelestialBodiesAt(t: number): readonly CelestialBody[];
  get stats(): TimeCacheStats;                                      // 窓 + 全 motion の累計
}

// physics/solar-system/earth-system.ts(系ごとに同じ形)
export const EARTH: PlanetDef;
export const MOON: SatelliteDef;
export type EarthSystemMotions = { readonly earth: PlanetMotion; readonly moon: SatelliteMotion };
export function earthSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number, pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): EarthSystemMotions;

// physics/solar-system/solar-system.ts
export type SolarSystemMotions = {
  readonly sun: StarMotion;
  readonly earthSystem: EarthSystemMotions; readonly innerPlanets: InnerPlanetMotions; readonly marsSystem: MarsSystemMotions;
  readonly jupiterSystem: JupiterSystemMotions; readonly saturnSystem: SaturnSystemMotions; readonly uranusSystem: UranusSystemMotions;
  readonly neptuneSystem: NeptuneSystemMotions; readonly dwarfPlanets: DwarfPlanetMotions; readonly smallBodies: SmallBodyMotions;
  readonly all: readonly CelestialMotion[];             // 今の SOLAR_SYSTEM の宣言順(earth, moon, mercury, …, sun)
};
export type SolarSystemId = keyof EarthSystemMotions | keyof InnerPlanetMotions | … | 'sun';
export function solarSystemMotions(
  originId: SolarSystemId, phases: PhaseOffsets, epochOffsetSec: number,
  absoluteSource: AbsoluteEphemeris | null, epochJdTdb: number,
): SolarSystemMotions;

// game/celestial/celestial-entity.ts
export type BodyClass = 'star' | 'planet' | 'dwarf' | 'satellite' | 'smallBody';
export abstract class CelestialEntity {
  readonly motion: CelestialMotion;
  readonly name: string;
  readonly bodyClass: BodyClass;
  get id(): string;
  get def(): CelestialBodyDef;
  readonly atmosphereOptics: AtmosphereOptics | null;   // 手順8 から
  referenceLine: OrbitLine | null;                       // 手順9 から
  protected constructor(motion: CelestialMotion, name: string, bodyClass: BodyClass, atmosphereOptics: AtmosphereOptics | null);
  abstract build(scene: THREE.Scene, sunOcclusion: SunOcclusion, sunLight: SunLight): void;
  abstract setVisible(visible: boolean): void;
  abstract sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, star: CelestialMotion | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void;
  referenceElementsAt(t: number): OrbitalElements | null;   // 手順9 から。中心は motion.primary
  syncMapOverlay(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, markerManager: MarkerManager, celestialBodies: readonly CelestialBody[], visible: boolean): void;   // 手順9 から。既定は何もしない
  abstract dispose(): void;
}
export class SphereEntity extends CelestialEntity {
  constructor(motion: OrbitingMotion, name: string, bodyClass: BodyClass, surface: CelestialSurface, atmosphereOptics: AtmosphereOptics | null, surfaceMarkings: (() => LineOverlay) | null);
}
export class PointEntity extends CelestialEntity {
  constructor(motion: OrbitingMotion, name: string, bodyClass: BodyClass, surface: CelestialSurface, atmosphereOptics: AtmosphereOptics | null);
}
export class Earth extends CelestialEntity {
  constructor(motion: PlanetMotion, name: string, spinPhase0: number);
  get spinPhase0(): number;
}
export class Sun extends CelestialEntity {
  constructor(motion: StarMotion, name: string);
}

// game/celestial/celestial-system.ts
export class CelestialSystem {
  constructor(bodies: readonly CelestialEntity[], origin: CelestialEntity, phaseOffsets: PhaseOffsets);
  readonly bodies: readonly CelestialEntity[];          // 宣言順
  readonly origin: CelestialEntity;
  readonly star: CelestialEntity | null;
  readonly frames: ReferenceFrames;
  bodyOf(id: string): CelestialEntity;         // 未登録なら throw
  find(id: string): CelestialEntity | null;
  has(id: string): boolean;
  nameOf(id: string): string;                  // 未登録なら id
  get defs(): readonly CelestialBodyDef[];
  celestialBodiesAt(t: number): readonly CelestialBody[];            // windows へ委譲
  gravityAttractorsAt(t: number): readonly CelestialBody[];
  atmosphereCelestialBodiesAt(t: number): readonly CelestialBody[];
  sunDirFrom(r: Vec3, t: number): Vec3;                 // 恒星が無ければ +X
  build(
    scene: THREE.Scene, sunLight: SunLight, exposure: Exposure, sunOcclusion: SunOcclusion,
    planetLight: PlanetLightSource, ambient: AmbientSource, atmosphere: AtmospherePass,
  ): void;
  update(displayTime: number, overviewMode: boolean, graphics: GraphicsSettingsData): void;
  sync(/* 今の EnvironmentScene.sync と同じ引数 */): void;
  setOrbitGuideSettings(settings: OrbitGuideSettings): void;
  get referenceOrbitLines(): readonly { readonly id: string; readonly line: OrbitLine }[];
  get orbitGuide(): OrbitGuideLines;
  serialize(): { readonly phaseOffsets: PhaseOffsets; readonly earthSpinPhase0: number | undefined };
  perfCounts(): { celestialBodiesCacheHits: number; celestialBodiesCacheMisses: number; timeCacheHits: number; timeCacheMisses: number };
  dispose(): void;
}

// game/celestial/solar-system/earth-system.ts(系ごとに同じ形。写像型で網羅を強制)
export function earthSystemEntities(m: EarthSystemMotions, earthSpinPhase0: number): { readonly [K in keyof EarthSystemMotions]: CelestialEntity };

// game/celestial/solar-system/solar-system.ts
export function solarSystem(
  originId: SolarSystemId, phases: PhaseOffsets, earthSpinPhase0: number,
  absoluteSource: AbsoluteEphemeris | null, epochOffsetSec: number, epochJdTdb: number,
): CelestialSystem;

// game/stages/stage.ts
static createCelestialSystem(
  phaseOffsets: PhaseOffsets, earthSpinPhase0: number, onProgress?: (ratio: number) => void, startSimTime?: number,
): Promise<CelestialSystem>;
```

### ユーザー案が論点を解消するか

解消する。反対する理由は無い。調整は「決めたこと」2〜4。

## 決めたこと

ユーザーが覆せる。覆したときに変わる手順を各項の末尾に書く。

1. **`Ephemeris` は解体して 0 件にする。** 天体1体で答えられる計算は `CelestialMotion` へ、系レベルに
   残る2つは `ReferenceFrames` / `CelestialBodyWindows` へ。**挙動不変で進めるため、解体は手順7 に置く**
   (手順1〜6 は `Ephemeris` の中で部品を育て、7 で消費者を移して消す)。テストは物理の部品
   (太陽系パック / `ReferenceFrames` / `CelestialBodyWindows`)に対して書き直し、現行テストの維持を
   理由に構造を曲げない。覆すなら: 手順7 が縮む。
2. **時刻を引く口は2段: `at(pivot): CelestialBody`(pivot の厳密な状態 + 加速度を 32 段の `TimeRing` に
   メモ)と、そこからの2次近似 `stateAt(pivot, t): KinematicState`。** `stateAt(t)` は pivot = t の略記。
   位置だけの口(`positionAt`)は motion には置かない — `stateAt(...).r` で足り、割り当てを避けたい経路は
   下記のとおり motion を経由しない。呼び出し側への規約は「|t − pivot| が1歩の幅程度であること」
   「pivot の種類を増やさないこと」の2つで、pivot の選び方は呼び出し側の判断。今と同じ (pivot, t) を
   選べばビット単位で同じ値になる。2次近似の式は `celestialBodyPositionAt` / `celestialBodyStateAt`
   (`physics/celestial-body.ts:49,64`)の1箇所のまま — `motion.stateAt(pivot, t)` はそれを `at(pivot)` の
   値へ当てるだけ。
   `setTime(t)` は答えが直前の呼び出しに依存する順序制約を生むので置かない(`ephemeris.ts:5-7` の
   「どの順に呼んでも返る値は変わらない」を保つ)。1段のキャッシュも採らない — 1フレームに
   displayTime / simTime / サブステップ中点 / 予測弧の任意時刻が交互に流入する。
   **積分の内側(`dynamics.ts:131,143`)は motion のメソッドを段ごとに呼ばず、窓
   (`celestialBodiesAt(pivot)`)の値に `celestialBodyPositionAt` を当てる今の形を保つ** — `TimeRing` の
   照合は最大 32 回の数値比較で、個体数 × RK4 段 × 重力源数のループに入れると照合が積分より重くなる。
   いまの (pivot, t) の選び方(6 通り)は手順1 の表に列挙し、本計画では変えない。
   覆すなら: 手順1 の `CelestialMotion` の口と、手順7 の対応表の1行目が変わる。
3. **名前。** 所有者は `CelestialSystem`、個体は `CelestialEntity`、物理は `CelestialMotion`。
   `CelestialBody` は物理関数 40 箇所が読む窓の値の名として据え置く。`System` / `Manager` の
   使い分けと置き場(`game/celestial/`)は実施後に再検討する。
4. **星系は定数表ではなく構築コードで表す。** 関係(衛星→惑星、惑星→恒星)は構築時の参照で表し、
   `planet: 'earth'` のような文字列の関係と、それを解釈する汎用の木構築は持たない。ECI の中心
   (`originId`)はパック呼び出しの引数 — 原点はステージの選択であってパックの性質ではないので、
   同じ太陽系パックを別の原点で使える。系ごとに physics(軌道・質量・形状・自転・環・大気の層:
   THREE 非依存)と game(名前・表示クラス・テクスチャ/アルベド・大気の光学・表面ライン)の2ファイルを
   置き、game 側は physics 側が返す**名前付きフィールド**(`m.moon`)を写像型
   (`{ [K in keyof EarthSystemMotions]: CelestialEntity }`)で網羅する — 1体足して見た目を書き忘れると
   コンパイルエラー。1ファイルに載せないのは、見た目側がテクスチャの jpg import(webpack 専用)と
   `THREE.Vector3` を含み、physics に置けないため。覆すなら: 手順6・8 の分割単位が変わる。
5. **天体でないもの(星野・天球グリッド・縮尺グリッド・ライティングアンカー・軌道ガイド線・
   ゼロ速度曲線・小天体点群)も `CelestialSystem` が所有するが、実装は今の各クラスに委譲したまま置く。**
   覆すなら: 手順3 で `Sky` 相当を切り出す1手順が増える。
6. **`CelestialSystem` を組むのは Stage(`createCelestialSystem`)で、Launcher が await して Game へ渡す。**
   暦パックの非同期ロードはパックの呼び出しに要り、THREE の資源(scene・pipeline)は Game が
   `celestialSystem.build(scene, …)` で後から渡す(個体のメッシュ生成は今も `build(scene)` で行って
   いる)。「誰が組むか」は呼び出し行の位置だけの違いなので、覆しても手順7 の1箇所が動くだけ。
7. **tests/physics がコンパイルする game 側のファイル(`tsconfig.test.json` の include: `plan.ts` /
   `focus-target.ts` / `point-field.ts` / `placement-validation.ts` …)は、`CelestialSystem` ではなく
   物理の部品だけを受け取る。** `CelestialEntity` を要するテスト(`body-visibility.test` の
   `MapVisibilityPolicy` 部分・`focus-target.test`)は、物理部品で書けない部分を削る。
   `tests/perf/` は npm script から呼ばれていないので、壊れる実験ファイルは直さず消す。
   覆すなら: 手順7 のテスト書き換えの範囲が広がる。
8. **`DynamicTrajectory._extrapolationCenter: CelestialBody | null`(`physics/dynamic-trajectory.ts:27`)
   は是正しない。** `extrapolatedAt` は先端 `tip` を「その時刻の中心天体まわりの二体軌道」として
   外挿する(`:112-115`)ので、先端と同じ瞬間の窓の値を対で持つのは値の意味どおり。
9. **`FutureCelestialBodyProvider`(`game/simulation/arc-bodies.ts:18-22`)の interface は残し、
   `FutureCelestialBodies` クラスだけを消す。** interface は `tests/physics/predicted-arc.test.ts:25`
   が「地球1体だけ」のスタブを差す継ぎ目で、`CelestialSystem` が構造的に満たす。
10. **小惑星帯・トロヤ群の点群(`point-field.ts:66,138,215` が木星の軌道要素を直接読む)は太陽系
    パック固有のものとして残す。** 恒星が無い星系では組まない(`environment-scene.ts:182`)。
    太陽系以外への一般化は仕様の「未確定の案」。木星の軌道要素は `physics/solar-system/jupiter-system.ts`
    の名前付き定数を読む。

## 達成目標

全手順の実施後、次がすべて成り立つ。

- `grep -rn "Ephemeris\b\|physics/ephemeris'\|CelestialRegistry\|SOLAR_SYSTEM\b\|bodyDef(\|\.registry\b" src tests tools`
  が 0 件(`ephemeris-pack/` / `ephemeris-catalog` / `ephemeris-profile` / `absolute-ephemeris`(暦パックの語)
  は残る)。
- `src/` に `planet: 'earth'` のような、天体間の関係を id 文字列で持つフィールドが無い。
  関係は `motion.primary` / `planet.satellites` の参照だけ。
- `grep -rn "CelestialBodyId\|OrbitingId\|FrameAnchorId" src tests tools` が 0 件。id の型は `string`。
- 次が `src/` `tests/` から 0 件: `CELESTIAL_VIEWS`、`fallbackCelestialView`、`BODY_CLASSES`、
  `CELESTIAL_ALBEDO`、`CELESTIAL_TEXTURES`、`ATMOSPHERE_OPTICS`、`albedoOf(`、`bondAlbedoOf(`、
  `lightSourceAlbedoOf(`、`textureOf(`、`atmosphereOpticsOf(`、`celestialBodyName(`、
  `FutureCelestialBodies`、`FutureBodyCandidate`、`EnvironmentScene`、`CelestialView`、
  `celestial-registry.ts`、`body-class.ts`、`future-celestial-bodies.ts`、`environment-scene.ts`、
  `ephemeris.ts`、`physics/solar-system.ts`(単一ファイル)。
- `Game` が天体関連で持つフィールドは `celestialSystem` の1つ。
- 天体1体の時刻依存の値を引く呼び出しは、すべて `CelestialEntity.motion`(または `CelestialMotion`)
  のメソッド。`positionOf(id, t)` のような id 引きの口が無い。
- 参照軌道線の実体(`OrbitLine`)は `CelestialEntity` のフィールド。`Map<OrbitingId, OrbitLine>` が消える。
- 静止軌道リング・GEO ラベル・自転初期位相は `Earth` の中にあり、`CelestialSystem` に `'earth' in`
  の分岐が無い。
- `physics/solar-system/` と `game/celestial/solar-system/` の各ファイルが 500 行以下。
- `game/celestial/solar-system/` の系ファイルから1体の見た目を消すと `npm run typecheck` が落ちる。
- `npm run typecheck` と `npm run test:physics` が通る。
- 見た目が変わらない(手順ごとの検証項目を全部通す)。負荷確認ウィンドウの天体暦キャッシュの
  ヒット/ミス累計が、同じ操作で同じ桁。

## 手順間の依存関係

意味上の依存(前の手順の産物を使う)と、同じファイルを触るための衝突を分けて書く。
**手順0〜6 はどれも `Ephemeris` の公開 API を保ち、既存テストで数値を固定したまま単独で main へ入れられる。**
手順7 が `Ephemeris` を消す唯一の手順で、ここから先は 7 の後にしか入らない。

```
0 ─────────────────────────────────────────────┐(どこにでも入る。独立)
1 ──┬── 4 ──┐                                  │
    ├── 5 ──┼── 7 ── 8 ── 9 ── 10              │
    └── 6 ──┤                                  │
2 ──────────┤                                  │
3 ── 4      │                                  │
            └──────────────────────────────────┘
```

| 手順 | 意味上の前提 | 同じファイルを触るので順番に行う相手 | 備考 |
| --- | --- | --- | --- |
| 0 | なし | 全手順(機械的な置換なので、他の手順の直前か直後に1コミットで) | いつでも |
| 1 | なし | 5・6(`ephemeris.ts`) | 最初に着手する |
| 2 | なし | 3(`game.ts` の隣接行) | 1 と並行できる |
| 3 | なし | 2(`game.ts`) | 1 と並行できる |
| 4 | 1(`ephemeris.motionOf`)、3(ファイル名) | 9(`celestial-system.ts` と個体) | 5・6 と並行できる |
| 5 | 1(motions の配列) | 6(`ephemeris.ts` のコンストラクタ) | 4 と並行できる |
| 6 | 1(motion のクラス) | 5(`ephemeris.ts`)、4(`fallbackEntity` が `def.kind` を読むなら `motion.kind` へ) | 4 と並行できる。33 ファイルの import 変更を含む |
| 7 | 1〜6 すべて | 8・9(`celestial-system.ts`) | 唯一の非可逆点。下の分割で入れる |
| 8 | 7(`Stage.createCelestialSystem` と `SolarSystemMotions` の名前付きフィールド)、4 | 7・9 | 系ファイルごとに並行できる |
| 9 | 4(個体と `Earth`)、8(`entity.atmosphereOptics`) | 7・8 | — |
| 10 | 7(`Ephemeris` が無いこと)、条件(`game/` を import しない) | 全部 | 最後 |

手順7 は1コミットで入れる必要はない。`Ephemeris` を消すのは最後にして、次の3段に分ける:

- **7a** `CelestialSystem` に最終形の口(`bodyOf` / `has` / `nameOf` / `frames` / `celestialBodiesAt` 等)を
  足す。`Ephemeris` はまだあり、両方の口が同じ部品を指す。typecheck が通る。
- **7b** 消費者を群ごとに移す(表の 8 群)。群ごとに typecheck が通るので、群ごとにコミットできる。
  tests がコンパイルする game ファイル(決めたこと 7)は、この段で物理部品を受ける形にする。
- **7c** `Ephemeris` と `Stage.createEphemeris` を消し、`Stage.createCelestialSystem` を入れ、テストを
  書き直す。ここで初めて `grep Ephemeris` が 0 件になる。

分割して別ブランチで進めるなら、**同じファイルを触る組(2 と 3、5 と 6、4 と 9、7〜9)を別ブランチに
置かない。** 1 だけのブランチ、2+3 のブランチ、4 のブランチ、5+6 のブランチ、は互いに独立に main へ入る。

## 手順

### 手順 0. `string` の別名 `CelestialBodyId` / `OrbitingId` / `FrameAnchorId` を消す

#### 目的

3つとも `string` の素の別名で(`physics/celestial-body.ts:13,16`、`physics/frame.ts:33`)、型としての
強制力が無い(`:16` のコメントが自認している。`FrameAnchorId = CelestialBodyId | '@activeShip' | …` も
`string` との union なので `string` に潰れる)。意味の無い別名を消し、`string` にする。
`SolarSystemId` は実在の union なので残す。**この時点で挙動は変えない。** 他のどの手順とも独立で、
いつ入れてもよい。

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `physics/celestial-body.ts:10-16` | `CelestialBodyId` / `OrbitingId` の定義を消す |
| `physics/frame.ts:33` | `FrameAnchorId` の定義を消す。`:30-32` のコメント(役割トークンは `@` で始まる)は残す |
| `grep -rln "\bCelestialBodyId\b\|\bOrbitingId\b\|\bFrameAnchorId\b" src tests tools` の全件(33 + 12 + 6 ファイル、235 箇所) | `string` に置換し、import から外す。`Partial<Record<CelestialBodyId, number>>` は `Partial<Record<string, number>>` |

#### 達成条件と検証

- `npm run typecheck`、`npm run test:physics`(`frame` / `frame-anchors` / `focus-target`)。
- `grep -rn "CelestialBodyId\|OrbitingId\|FrameAnchorId" src tests tools DEVELOP` が 0 件。

### 手順 1. `Ephemeris` の内部を天体ごとの `CelestialMotion` へ再編する

#### 目的

天体1体で答えられる計算を、`Ephemeris` のメソッド群 + `Map<id, TimeRing>` の id 引きから、
天体1体につき1つの物理オブジェクトへ移す。Planet / Satellite / Star の違いを `switch (def.kind)` では
なくクラスで表す。`Ephemeris` の公開 API と数値はこの時点では同一で、各メソッドは `motionOf(id)` へ
委譲するだけになる。木はまだ `Ephemeris` のコンストラクタが `registry` から組む(手順6 で構築コードへ
移る)。**この時点で挙動は変えない。**

署名は「主要な型と署名」節の `physics/celestial-motion.ts`。この手順では `PlanetDef` / `SatelliteDef` に
まだ `kind` と `planet` が残る(手順6 で外す)。`ephemeris.ts` からの移動元:

| 移し先 | 移動元(`ephemeris.ts`) |
| --- | --- |
| `CelestialMotion.helioStateAt` / `helioAccelAt` | `:245-309`(重心補正)、`:333-352` |
| `CelestialMotion.at`(ECI 化と暦パック分岐。origin が自分自身なら厳密に 0) | `:362-375`、`:649-655` |
| `orientationAt` / `spinRotationAt` / `degree2At` / `atmosphereAt` | `:554-620` |
| `OrbitingMotion.orbitFrameRotationAt` / `orbitNormalAt`(暦パック分岐込み) | `:385-417` |
| `OrbitingMotion.lagrangeAt` / `lagrangeStateAt` | `:422-444` |
| `OrbitingMotion.hasUsableCollinearPoints` / `hasStableTriangularPoints` | `:447-474` |
| `SatelliteMotion.relStateAt` | `:252-270` |
| `PlanetDef` / `SatelliteDef` / `keplerOrbit` | `:44-51` |

`TimeRing` は `physics/time-ring.ts` へ出し、窓キャッシュ(`:126-128`)と各 motion が共用する。
暦パック(`precise`)は各 motion が参照を持ち、`at` / `orbitFrameRotationAt` の分岐
(`:363-371, 387-401, 408-415`)は motion の中に入る。

いまの (pivot, t) の選び方。本計画では変えない(挙動不変)。`at(pivot)` からの2次近似を motion の口に
したあと、pivot を変える最適化(例: 日照・遮蔽を中点から近似する)はこの表の行を1つずつ動かす形になる。

| 呼び出し側 | pivot(厳密に引く時刻) | t | 近似 |
| --- | --- | --- | --- |
| `physics/dynamics.ts:131,143`(重力・抗力) | サブステップ中点(`substep-bodies.ts:24-25`) | RK4 の各段 | 2次(`celestialBodyPositionAt`) |
| `physics/surface-contact.ts:32-34`、`game/simulation/surface-candidates.ts:59-60`、`surface-contact-physics.ts:73` | サブステップ開始(`substep-bodies.ts:27`) | 個体の時刻 | 2次(`celestialBodyStateAt`) |
| `physics/trajectory-features.ts:51,93`、`physics/orbit-solvers.ts:31` | 呼び出し側が持つ窓 | 近点・交点の探索時刻 | 2次(`orbit-solvers.ts:23` が数時間先では効かないと注記) |
| `physics/shadow.ts`、`physics/occlusion.ts`(日照・遮蔽) | サブステップ開始、または表示時刻 | pivot と同じ | 0次(`state.r` をそのまま) |
| `game/simulation/arc-bodies.ts:103`(予測弧) | 弧の各歩の中点 | pivot と同じ | なし(歩ごとに厳密評価) |
| `game/nav-target.ts:177`、`game-entity.ts:474`、表示系の `positionOf(id, displayTime)` | t そのもの | — | なし(nav-target は精密暦の un-bake と揃えるため意図的に厳密) |

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `physics/time-ring.ts`(新規) | `ephemeris.ts:69-116` の `TimeRing` / `TIME_CACHE_SLOTS` / `TimeCacheStats` を移す |
| `physics/celestial-motion.ts`(新規) | 上の階層。`ephemeris.ts:44-67, 229-474, 552-620, 649-655` の実装を移す |
| `physics/ephemeris.ts` | `:121-135` のフィールドを `motions: readonly CelestialMotion[]` + `motionOf(id)` に。`:151-178` で木を組み、最後に `EciOrigin` を書く。`:190-205` の累計は motions を走査。公開メソッドは1行の委譲に |
| `physics/solar-system.ts`、`tests/physics/*` | 変更なし(`spinRateOf(def)` は def の純関数のまま motion が呼ぶ) |

#### 達成条件と検証

- `npm run typecheck`。
- `npm run test:physics` — `ephemeris` / `celestial-body` / `body-orientation` / `equatorial-satellites` /
  `laplace-satellites` / `irregular-satellites` / `small-bodies` / `halo` / `frame` / `plan` /
  `absolute-ephemeris` / `window-agreement` が数値を固定しているので、これが通ることが「挙動不変」の判定。
- `grep -n "planetHelioCache\|satelliteRelCache\|satellitesOf\|helioStateOf\|orientationOf\|keplerOrbitOf" src/physics/ephemeris.ts` が 0 件。
- `physics/ephemeris.ts` が 250 行以下(残るのは構築・窓・座標系・starId・phaseOffsets・perfCounts)。

### 手順 2. `FutureCelestialBodies` を消す

#### 目的

`FutureCelestialBodies`(`game/simulation/future-celestial-bodies.ts`)は `registry` を `{id, mu, radius}`
の配列へ写して `celestialBodyAt` をたらい回すだけの層。`Ephemeris` に宣言順の `defs` を生やせば
構造的に provider を満たすので、層を消す。**この時点で挙動は変えない。**

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `game/simulation/arc-bodies.ts:18-22,80` | `candidates()` を `readonly defs: readonly Pick<CelestialBodyDef, 'id' \| 'mu' \| 'radius'>[]` に。`FutureBodyCandidate` の名前を消す |
| `physics/ephemeris.ts` | `readonly defs: readonly CelestialBodyDef[]`(宣言順)を公開 |
| `game/simulation/future-celestial-bodies.ts` | 削除 |
| `game/game.ts:22,107,151,202,223` | `futureCelestialBodies` を消し、`Predictor` / `PlanEditor` に `this.ephemeris` を渡す |
| `game/simulation/predictor.ts:20,38`、`game/plan/plan-editor.ts:32,95` | 型を `Ephemeris` に(plan-editor は `:93` の `ephemeris` を使う) |
| `tests/physics/predicted-arc.test.ts:25-36`、`window-agreement.test.ts:18,141` | スタブの `candidates` → `defs`、`new FutureCelestialBodies(EPHEMERIS)` → `EPHEMERIS` |

#### 達成条件と検証

- `npm run typecheck`、`npm run test:physics`(`predicted-arc` / `window-agreement` / `plan`)。
- `grep -rn "FutureCelestialBodies\|FutureBodyCandidate\|candidates()" src tests` が 0 件。

### 手順 3. `EnvironmentScene` を `CelestialSystem` に改名し、`Ephemeris` を所有させる

#### 目的

天体の所有者を1つにする。`Game` は `celestialSystem` だけを持ち、`ephemeris` はそこへの委譲になる
(手順7 で消える経過の形)。**この時点で挙動は変えない。**

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `game/celestial/environment-scene.ts` → `celestial-system.ts` | `git mv` + クラス名。`private readonly ephemeris`(`:140`)を `readonly` に |
| `game/game.ts:36,67-68,96-97,146,177-185,312,344,555` | `_ephemeris` を消す。コンストラクタ内の `this.ephemeris`(`:151-172`)は引数を直接使う(構築順は変えない)。`get ephemeris()` は `this.celestialSystem.ephemeris` |
| `game/orbit-pickables.ts:12,29`、`game/save/snapshot-service.ts:93`、`render/stars.ts:44`、`celestial-view.ts:27` | 型名・プロパティ名・コメント |

#### 達成条件と検証

- `npm run typecheck`。
- `grep -rn "EnvironmentScene\|environment-scene\|_environment\b" src tests DEVELOP .claude` が 0 件。
- `npm run dev` で起動し、戦闘ビューとマップビューが描かれる。

### 手順 4. `CelestialView` を `CelestialEntity` にし、個体が `motion` を所有する

#### 目的

天体1体を表すオブジェクトを作る。`CelestialView` の階層(`SphereView` / `PointView` / `EarthView` /
`SunView`)をそのまま `CelestialEntity` の階層にし、`id` に加えて `name` / `bodyClass` / `motion` を持たせる。
生成は「実行中の `motion`(と `motion.def`)を受け取って個体を組む見た目の表」が行い、`bodyDef(SOLAR_SYSTEM, id)`
を消す。個体の `sync` は `ephemeris.positionOf(this.id, t)` ではなく `this.motion.stateAt(t).r` を引く。
**この時点で挙動は変えない。**

この手順の見た目の表は id をキーにした `Record<SolarSystemId, …>` のままで、**手順8 で系ごとの
構築コード(名前付きフィールドの写像)へ置き換わる経過の形。**

```ts
// game/celestial/catalog/solar-system-catalog.ts(手順8 で消える)
type CelestialEntityDef = {
  readonly name: string;
  readonly bodyClass: BodyClass;
  create(motion: CelestialMotion): CelestialEntity;   // sunOcclusion / sunLight は build(scene, …) で受ける
};
export const SOLAR_SYSTEM_CATALOG: Record<SolarSystemId, CelestialEntityDef>;
export function fallbackEntity(motion: CelestialMotion): CelestialEntity;  // 未登録 id。恒星なら Sun、それ以外は単色の SphereEntity
```

`celestialBodyName(id)`(`hud/frame/frame-labels.ts:10`)と `bodyClassOf(registry, id)`
(`body-class.ts:114`)は、この手順では表を読む形に書き換えて残す(呼び出し元 45 箇所は手順7 で
まとめて直す)。

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `game/celestial/celestial-view.ts` → `celestial-entity.ts` | 基底。`id` / `name` / `bodyClass` / `motion` / `def`(getter)。`sync` の引数から `ephemeris` を外す |
| `game/celestial/sphere-view.ts` → `sphere-entity.ts` | コンストラクタを `motion` 受けに。`:53-57` の半軸・`outerRadius` を `motion.def` から。`:84-116` の `ephemeris.positionOf / poleAt` を `motion` に |
| `game/celestial/point-view.ts` → `point-entity.ts` | 同上(`:66-80, 111-150, 162-170`)。`sunIrradianceAt` は `star` の motion を受ける形に |
| `game/celestial/earth-view.ts` → `earth.ts` | クラス名 `Earth`。`:39` を `motion.stateAt(displayTime).r` に |
| `game/celestial/sun-view.ts` → `sun.ts` | クラス名 `Sun`。`:23` の既定引数を消し `motion.def` から |
| `game/celestial/celestial-view.ts:26-33` | `sunIrradianceAt` は `star: CelestialMotion \| null` を `CelestialSystem` から受ける |
| `game/celestial/celestial-registry.ts` → `catalog/solar-system-catalog.ts` | `:36-95` の各 entry を `motion` 受けに。`:97-203` に `bodyClass` を足す(`body-class.ts:13-111` の値を移す)。`:206-221` を `fallbackEntity` に |
| `game/celestial/body-class.ts` | `BODY_CLASSES` を消す。`bodyClassOf` は表を読む(手順7 で消える) |
| `game/celestial/celestial-system.ts:113,171-177,202,230-232` | `bodies: readonly CelestialEntity[]`。生成を `SOLAR_SYSTEM_CATALOG[id]?.create(motion) ?? fallbackEntity(motion)` に(`motion` は `ephemeris.motionOf(id)`)、`body.build(scene, sunOcclusion, sunLight)` へ。`instanceof EarthView` → `Earth` |
| `hud/frame/frame-labels.ts:5-11` | `CELESTIAL_VIEWS` → `SOLAR_SYSTEM_CATALOG` |

`CelestialView` の語は上のファイル(`grep -rln CelestialView src` の 7 件)の外には無い。

#### 達成条件と検証

- `npm run typecheck`。
- `grep -rn "CelestialView\|CELESTIAL_VIEWS\|fallbackCelestialView\|BODY_CLASSES\|bodyDef(SOLAR_SYSTEM" src` が 0 件。
  `grep -n "ephemeris" src/game/celestial/sphere-entity.ts src/game/celestial/point-entity.ts src/game/celestial/earth.ts src/game/celestial/sun.ts` が 0 件。
- `npm run dev`:
  - 戦闘ビュー: 惑星が輝点、月がテクスチャ球、地球の雲・オーロラ、太陽のグロー。
  - マップビュー: 土星に環、木星・天王星・海王星の細い環、月に表面ライン(模式図スタイル)、
    フォーカスを冥王星系へ移すとカロンほか5衛星が単色球で出る。
  - `?stage=debug-alt-system`: `zephyrus` / `zephyrus-i` が単色球で出て、恒星なしで落ちない。

### 手順 5. 系レベルの物理(座標系・窓)を `Ephemeris` から切り出す

#### 目的

`Ephemeris` に残った系レベルの責務のうち、天体1体に帰属しない2つを独立に組める部品にする。
**この時点で挙動は変えない。**

署名は「主要な型と署名」節の `ReferenceFrames` / `CelestialBodyWindows`。移動元:

| 移し先 | 移動元(`ephemeris.ts`) |
| --- | --- |
| `ReferenceFrames.inertialFrame` / `frames` | `:139-143`、`:167-174` |
| `ReferenceFrames.frameOf` / `frameFor`(同じ対に同じ参照) | `:487-505` |
| `ReferenceFrames.transformAt`(登録天体の回転は motion へ委譲) | `:516-550` |
| `CelestialBodyWindows.celestialBodiesAt` / `gravityAttractorsAt` / `atmosphereCelestialBodiesAt` | `:625-646` |
| `CelestialBodyWindows.stats` | `:185-222` |

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `physics/reference-frames.ts`(新規)、`physics/celestial-body-windows.ts`(新規) | 上のとおり |
| `physics/ephemeris.ts` | コンストラクタで `frames` / `windows` を組む。`frameOf` 等・`celestialBodiesAt` 等は委譲 |
| `physics/frame.ts:1-12` のコメント | 座標系の中身を組むのが `ReferenceFrames` になる |

#### 達成条件と検証

- `npm run typecheck`、`npm run test:physics`(全件)。
- `physics/ephemeris.ts` から `TimeRing` / `frameCache` / `Map<` が 0 件。
- `npm run dev` で、座標系パネルで「月回転系」「地球自転系」へ切り替えて軌道線が凍らない
  (`frames` の参照同一性が保たれている)。

### 手順 6. 太陽系を「定数表」から「motion を組んで返す構築コード」へ移す

#### 目的

`SOLAR_SYSTEM`(`Record<id, CelestialBodyDef>`、`planet: 'earth'` の文字列関係)と、それを id で解釈する
`Ephemeris` の木構築(`:151-178`)を、系ごとの構築コードに置き換える。関係は `new SatelliteMotion(MOON, earth)`
のように参照で表す。`CelestialRegistry` 型・`bodyDef` / `starOf` / `primaryOf` は消える。`Ephemeris` の
コンストラクタは `motions` を受け取るだけになる。`CelestialBodyDef` から `kind` と `planet` を外す
(分類はクラス、関係は参照)。**この時点で挙動は変えない。**

署名は「主要な型と署名」節の `physics/solar-system/`。系ファイルの中身はこの形:

```ts
// physics/solar-system/earth-system.ts
export const EARTH: PlanetDef = { id: 'earth', mu: MU_EARTH, radius: R_EARTH_EQ, orbit: planetOrbit({ … }), pole: { kind: 'eciPole' }, degree2: { … }, shape: { … }, atmosphere: EARTH_ATMOSPHERE, lagrangeLabels: true };
export const MOON: SatelliteDef = { … };
export function earthSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number, pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): EarthSystemMotions {
  const earth = new PlanetMotion(EARTH, sun, phases[EARTH.id] ?? 0, epochOffsetSec, pack, origin);
  const moon = new SatelliteMotion(MOON, earth, phases[MOON.id] ?? 0, epochOffsetSec, pack, origin);
  return { earth, moon };
}
```

`SolarSystemId` は `keyof EarthSystemMotions | keyof MarsSystemMotions | …` の union として残し、
手順4 の id キーの表がそれで網羅性検査を続ける(手順8 で写像型へ替わる)。架空星系のステージの
`ALT_REGISTRY`(`stage-debug-alt-system.ts:34-58`)は `zephyrusSystemMotions()` という同じ形の構築
コードにする。

系の分割(`SOLAR_SYSTEM` の行):

| 系 | `physics/solar-system/` | 行 |
| --- | --- | --- |
| 共通 | `constants.ts`(`:16-40`)、`celestial-body-def.ts`(`:69-202` の型・`shapeAxes`・`spinRateOf`)、`moon-terms.ts`(`:204-258`)、`poles.ts`(`:260-330`)、`rings.ts`(`:355-470`)、`satellite-orbit-builders.ts`(`:331-354,471-504`) | — |
| 太陽 | `sun.ts` | `:2022` |
| 地球系 | `earth-system.ts` | `:506-562` |
| 内惑星 | `inner-planets.ts` | `:563-624` |
| 火星系 | `mars-system.ts` | `:625-666` |
| 木星系 | `jupiter-system.ts` | `:667-813` |
| 土星系 | `saturn-system.ts` | `:814-970` |
| 天王星系 | `uranus-system.ts` | `:971-1045` |
| 海王星系 | `neptune-system.ts` | `:1046-1096` |
| 準惑星・大型小惑星とその衛星(ケレス〜ディスノミア) | `dwarf-planets.ts` | `:1097-1332` |
| 小天体 | `small-bodies.ts` | `:1333-2021` |
| 集約 | `solar-system.ts`(`solarSystemMotions`、`SolarSystemMotions`、`SolarSystemId`) | — |

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `physics/solar-system.ts` | 上の表のとおり分割して消す。各天体の項は `PlanetDef` / `SatelliteDef` / `StarDef` の名前付き定数 + 系の構築関数に |
| `physics/celestial-motion.ts` | `CelestialBodyDef` を `StarDef` / `PlanetDef` / `SatelliteDef` に(`kind` / `planet` なし)。`kind` は motion の getter |
| `physics/ephemeris.ts` | コンストラクタを `(motions: readonly CelestialMotion[], origin)` に。`:151-178` の木構築を消す |
| `game/stages/stage.ts:101-114` | `createEphemeris` が `solarSystemMotions(...)` を組んで `new Ephemeris(motions, …)` |
| `game/stages/stage-debug-alt-system.ts:9-58,60` | `ALT_REGISTRY` → `zephyrusSystemMotions()` |
| `physics/solar-system` を import する 33 ファイル(`grep -rln "physics/solar-system" src tools tests`) | import 先を `physics/solar-system/constants` 等へ。`tools/render-lab/cases.ts:10,30`、`lab.ts:21`、`point-field.ts:10,66,138,215`(木星の軌道要素を `jupiter-system.ts` の定数から)を含む |
| `def.kind` / `def.planet` を読む箇所(`grep -rn "\.kind === '\(star\|planet\|satellite\)'\|def\.planet\|\.planet ===" src`) | `motion.kind` / `motion.primary` に(手順7 の一斉移行と重なる箇所は、ここでは `ephemeris.motionOf(id)` 経由にしておく) |
| `tests/physics/*` の `new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, phases)`(25 ファイル) | `test-helpers.ts` の `solarSystemEphemeris(phases)`(内部で `solarSystemMotions('earth', …)`)に。`solar-system.test.ts` / `small-bodies.test.ts` 等の `bodyDef(SOLAR_SYSTEM, id)` は名前付き定数(`EARTH` 等)を直接読む |

#### 達成条件と検証

- `npm run typecheck`、`npm run test:physics`(全件。`solar-system.test` / `small-bodies` /
  `equatorial-satellites` / `laplace-satellites` / `irregular-satellites` が個々の天体の値を固定している)。
- `grep -rn "CelestialRegistry\|SOLAR_SYSTEM\b\|bodyDef(\|starOf(\|primaryOf(registry\|planet: '" src tests tools` が 0 件。
- `wc -l src/physics/solar-system/*.ts` の各ファイルが 500 行以下。`src/physics/solar-system.ts` が存在しない。
- `solarSystemMotions(...).all.map((m) => m.id)` が `f2952a24` の `Object.keys(SOLAR_SYSTEM)` と同じ並び
  (テストとして1本残す)。
- `npm run dev`: 戦闘ビュー・マップビューの絵と、`?stage=debug-alt-system` の起動。

### 手順 7. 消費者を `CelestialSystem` / `CelestialMotion` / 部品へ移し、`Ephemeris` を消す

#### 目的

`ephemeris.*` の呼び出し(約 230 箇所)と、`Ephemeris` を受け取る約 55 ファイルを、次の対応で
一斉に移す。`celestialBodyName` / `bodyClassOf`(約 45 箇所)も同時に消す。`CelestialSystem` は
`Stage.createCelestialSystem` が組み(太陽系パック → 手順4 の見た目の表 → `new CelestialSystem(bodies, origin)`)、
Launcher が await して Game へ渡す。**この時点で挙動は変えない。**

| 今の呼び出し | 移し先 |
| --- | --- |
| `ephemeris.stateOf / positionOf / celestialBodyAt (id, t)` | `celestialSystem.bodyOf(id).motion.stateAt(t) / stateAt(t).r / at(t)`(pivot = t。厳密評価のまま — 手順1 の表の (pivot, t) を変えない)。既に個体を持っている場所は `entity.motion` |
| `ephemeris.poleAt / spinRotationAt / orbitFrameRotationAt / orbitNormalAt / lagrangeAt / lagrangeStateAt / hasUsableCollinearPoints / hasStableTriangularPoints (id, …)` | `celestialSystem.bodyOf(id).motion.<同名>(…)`(`poleAt` は `orientationAt`) |
| `ephemeris.celestialBodiesAt / gravityAttractorsAt / atmosphereCelestialBodiesAt (t)` | `celestialSystem.celestialBodiesAt(t)` 等(`windows` への委譲)。tests がコンパイルする game ファイルは `CelestialBodyWindows` を受ける |
| `ephemeris.frameOf / frameFor / frames / inertialFrame / frameTransformAt` | `celestialSystem.frames.<同名>`。tests がコンパイルする game ファイルは `ReferenceFrames` を受ける |
| `ephemeris.motionOf(id)` / `'earth' in registry`(手順6 の経過形) | `celestialSystem.bodyOf(id).motion` / `celestialSystem.has(id)` |
| `celestialBodyName(id)` / `bodyClassOf(…, id)` | `celestialSystem.bodyOf(id).name / .bodyClass`(未登録 id の名前は `celestialSystem.nameOf(id)` が id を返す) |
| `ephemeris.starId` / `sunDirFrom` / `originId` / `defs` / `getPhaseOffsets` / `perfCounts` | `celestialSystem.star` / `sunDirFrom` / `origin` / `defs` / `serialize()` / `perfCounts()` |
| `physics/halo.ts:91-102,310,319`、`physics/orbit-guide.ts:70-74,193,261-267,305-331` の `ephemeris` 引数 | 副天体の `OrbitingMotion`(主天体は `motion.primary`)。`'earth' in registry` の判定は呼び出し側(`orbit-guide-lines.ts`)が `celestialSystem.has('earth')` で行う |
| `Stage.createEphemeris`(`stages/stage.ts:66-70,101-114`、`stage-debug-alt-system.ts:59-61`)、`launcher.ts:44-51,135-140`、`game.ts:131,146,177-179` | `Stage.createCelestialSystem(...)` が `solarSystem(...)`(game 側パック: 手順8 までは手順4 の表で個体を組む)を返す。Game は受け取って `build(scene, pipeline.*)`・dispose |
| `save/snapshot-service.ts:23,31,92`、`save-data.ts:333` | `celestialSystem.serialize()`(`phaseOffsets` は構築時に受け取った record をそのまま返す — 明示 0 のキーを落とさない) |
| `perf-meter.ts` | `celestialSystem.perfCounts()` |

ファイル単位(`grep -rln "Ephemeris\b" src` の全件 + `grep -rn "celestialBodyName(\|bodyClassOf(" src`):

| 群 | ファイル |
| --- | --- |
| game 直下 | `game.ts`、`display-window-manager.ts`、`entity-line-manager.ts`、`trajectory-line.ts`、`nav-target.ts`、`targeter.ts`、`orbit-reference.ts`、`orbit-pickables.ts`、`map-pickables.ts`、`map-context-actions.ts`、`frame-anchors.ts`(型のみ) |
| game/camera | `camera-system.ts`、`focus-markers.ts`、`focus-target.ts`(tests 対象: `ReferenceFrames` + `(id) => CelestialMotion \| null` を受ける)、`map-camera.ts` |
| game/celestial | `celestial-system.ts`(内部の `this.ephemeris.*` 約 25 箇所)、`body-visibility.ts`、`map-visibility.ts`、`planet-distance.ts`、`planet-light.ts`、`scale-grid-view.ts`、`orbit-guide-lines.ts`、`zero-velocity-lines.ts`、`point-field-view.ts`、`body-class.ts`(削除)、`catalog/solar-system-catalog.ts`、`solar-system/solar-system.ts`(新規: game 側パックの入口) |
| game/hud | `frame/frame-labels.ts`、`frame/anchor-zone.ts`、`frame/frame-controls.ts`、`frame/rotation-zone.ts`、`frame/camera-frame-panel.ts`、`frame/trajectory-frame-panel.ts`、`orbit/orbit-analysis-data.ts`、`panels/physical-object-list-panel.ts`、`object-groups.ts` |
| game/plan | `plan.ts`(tests 対象: `CelestialBodyWindows`)、`plan-display.ts`、`plan-editor.ts`、`plan-path.ts` |
| game/simulation | `simulator.ts`、`substep-bodies.ts`(`CelestialBodyWindows`)、`entity-state-at.ts`、`entity-manager.ts`、`predictor.ts` |
| game/game-entity・player・stages・creative | `game-entity.ts`、`enemy.ts`、`player.ts`、`player-fire.ts`、`stages/stage.ts`、`stage-debug-alt-system.ts`、`stage-utils/wave-attack.ts`、`creative/object-placer-panel.ts`、`creative/orbit-form-fields.ts`、`save/snapshot-service.ts`、`save/legacy-save.ts`(コメント) |
| physics | `halo.ts`、`orbit-guide.ts`、`ephemeris.ts`(削除) |
| src 直下 | `launcher.ts`、`perf-meter.ts` |
| tests | `tests/physics/` の 25 ファイル(`solarSystemEphemeris(phases)` → `solarSystemMotions('earth', phases, …)` + `new CelestialBodyWindows(all)` / `new ReferenceFrames(all, origin)`)。`body-visibility.test` / `focus-target.test` の `CelestialEntity` を要する部分は削る。`tests/perf/` の壊れる実験は削除 |

群は互いに独立なので `/delegate` で配れる(同じファイルを2人が触らない分け方)。

#### 達成条件と検証

- `npm run typecheck`、`npm run test:physics`(全件)。
- `grep -rn "Ephemeris\b\|physics/ephemeris'\|celestialBodyName(\|bodyClassOf(\|createEphemeris\|motionOf(" src tests tools` が 0 件。
- `npm run dev`:
  - マップビュー: 天体ラベルの日本語名、ラグランジュ点ラベル(`地球-L1` 等)、表示パネルの天体クラス
    絞り込み、物理オブジェクト一覧のグリフ、座標系パネルの「月回転系」「地球自転系」の表記が同じ。
  - 軌道ガイドタブでハロー軌道・リサジュー・太陽同期軌道の線が出る(`halo.ts` / `orbit-guide.ts`)。
  - `?stage=debug-alt-system` で起動でき、`zephyrus` のラベルが id で出る。
  - スナップショットを保存 → ロードで月の位相(`phaseOffsets`)と地球のテクスチャの向きが変わらない。
  - 負荷確認ウィンドウの天体暦キャッシュのヒット/ミス累計が、同じ操作で同じ桁。

### 手順 8. 見た目を系ごとの構築コードへ移し、見た目の表を解体する

#### 目的

手順4 の id キーの表(`SOLAR_SYSTEM_CATALOG`)を、physics 側の系ファイルと対になる game 側の系ファイル
(名前付きフィールドの写像)に置き換え、`CELESTIAL_ALBEDO` / `CELESTIAL_TEXTURES` / `ATMOSPHERE_OPTICS`
の値をそれぞれの天体の構築箇所へ移す。**この時点で挙動は変えない。**

署名は「主要な型と署名」節の `game/celestial/solar-system/`。系ファイルの中身はこの形:

```ts
// game/celestial/solar-system/earth-system.ts
export function earthSystemEntities(m: EarthSystemMotions, earthSpinPhase0: number): { readonly [K in keyof EarthSystemMotions]: CelestialEntity } {
  return {
    earth: new Earth(m.earth, '地球', earthSpinPhase0),
    moon: new SphereEntity(
      m.moon, '月', 'satellite',
      CelestialSurface.textured({ url: moonTextureUrl, albedoScale: 0.3459, bondAlbedo: 0.11, averageHue: [1.0458, 0.9880, 0.9844] }),
      null, () => new MoonSurfaceMarkings(),
    ),
  };
}
// game/celestial/solar-system/solar-system.ts
export function solarSystem(
  originId: SolarSystemId, phases: PhaseOffsets, earthSpinPhase0: number,
  absoluteSource: AbsoluteEphemeris | null, epochOffsetSec: number, epochJdTdb: number,
): CelestialSystem {
  const m = solarSystemMotions(originId, phases, epochOffsetSec, absoluteSource, epochJdTdb);
  const e: Record<SolarSystemId, CelestialEntity> = {
    sun: new Sun(m.sun, '太陽'), ...earthSystemEntities(m.earthSystem, earthSpinPhase0), ...marsSystemEntities(m.marsSystem), …,
  };
  const bodies = m.all.map((motion) => e[motion.id as SolarSystemId]);   // 宣言順を保つ
  return new CelestialSystem(bodies, e[originId], phases);
}
```

写像型が「physics 側に居る天体に見た目が無い」をコンパイルエラーにする。`fallbackEntity` は
架空星系のパック(`zephyrusSystem()`)だけが使う。アルベド(`celestial-albedo.ts:34-117`、82 件)と
テクスチャ(`celestial-textures.ts:39-67`、15 件 + 地球)は各天体の `surface` に置く。
`bondAlbedoOf` / `lightSourceAlbedoOf` / `texturePhotometryOf` の計算(`celestial-albedo.ts:118-160`)は
`CelestialSurface` 側の測光(`photometry`)として残し、呼び出し元は個体から引く。

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `game/celestial/catalog/solar-system-catalog.ts` | `game/celestial/solar-system/{sun,earth-system,inner-planets,mars-system,jupiter-system,saturn-system,uranus-system,neptune-system,dwarf-planets,small-bodies}.ts` に分割して消す。手順7 で作った `solar-system/solar-system.ts` の入口が各系を集める |
| `game/celestial/celestial-entity-def.ts`(新規) | `textured` / `solid` の surface 構築子、`BodyClass` 型 |
| `render/celestial-albedo.ts` | `CELESTIAL_ALBEDO` / `albedoOf` / `bondAlbedoOf` / `lightSourceAlbedoOf` を消す。`Albedo` 型・`rec709Luminance` は残す |
| `render/celestial-textures.ts` | `CELESTIAL_TEXTURES` / `textureOf` / `texturePhotometryOf` を消す。`CelestialTexture` 型は残す。`EARTH_TEXTURES` は `render/earth.ts` へ |
| `render/atmosphere-params.ts:20-39,53-56` | `ATMOSPHERE_OPTICS` / `atmosphereOpticsOf` を消す(地球は `earth-system.ts`、火星は `mars-system.ts` へ)。`AtmosphereOptics` 型・`rankAtmospheres` は残す |
| `render/celestial-surface.ts` | `photometry`(bondAlbedo・averageHue)を surface が持つ |
| `game/celestial/point-entity.ts`(`point-view.ts:74`) | `bondAlbedoOf(id)` → surface の測光 |
| `game/celestial/planet-light.ts:24-31` | `lightSourceAlbedoOf(body.id)` → `bodies` を受けて個体の測光 |
| `game/celestial/celestial-system.ts:357-373` | `atmosphereOpticsOf(id)` → `entity.atmosphereOptics` |
| `game/hud/orbit/orbit-projection-tab.ts:16` | `textureOf(id)?.url` → `celestialSystem.bodyOf(id)` の surface から |
| `game/stages/stage-debug-alt-system.ts` | `zephyrusSystem()`(motions → `fallbackEntity` → `CelestialSystem`) |

系ごとのファイルは互いに独立なので `/delegate` で系単位に配れる。

#### 達成条件と検証

- `npm run typecheck`。
- `grep -rn "CELESTIAL_ALBEDO\|CELESTIAL_TEXTURES\|ATMOSPHERE_OPTICS\|albedoOf(\|bondAlbedoOf(\|lightSourceAlbedoOf(\|textureOf(\|texturePhotometryOf(\|atmosphereOpticsOf(\|SOLAR_SYSTEM_CATALOG\|SolarSystemId" src` が 0 件。
- `game/celestial/solar-system/saturn-system.ts` から1体消して `npm run typecheck` が落ちる(戻す)。
- `wc -l src/game/celestial/solar-system/*.ts` の各ファイルが 500 行以下。
- `npm run dev`:
  - 戦闘ビューで各惑星の輝点の明るさ(金星が最も明るく、海王星が最も暗い)が変わらない。
  - マップビューで天体照(地球照・月面の色み)、地球・火星の大気の色が変わらない。
  - 模式図スタイルで月の海のラインが出る。
- `npm run render-lab:shot` — `tools/render-lab/cases.ts` が動く。撮り直しで ±4 LSB 揺れるので、
  差分は目視で「絵が同じ」を確かめる。

### 手順 9. 参照軌道線・地球固有の表示・照明フィードを `CelestialEntity` へ寄せる

#### 目的

線の実体を個体が持ち、出す/消す/濃さの判断を所有者が持つ形に揃える(`GameEntity.orbitLine` +
`EntityLineManager` と同じ分担)。静止軌道リング・GEO ラベル・自転初期位相は `Earth` に閉じ、
`CelestialSystem` から `'earth' in` の分岐を消す。環の影と大気の候補は `bodies` を走査して集める。
**この時点で挙動は変えない。**

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `game/celestial/celestial-entity.ts` | `referenceLine: OrbitLine \| null`。`referenceElementsAt(t)`(`celestial-system.ts:537-549` の移動。中心は `motion.primary`)。`showReferenceLine(style)` / `hideReferenceLine()` / `syncReferenceLine(fo, camera, opacity)`。マップ専用の付随表示のための `syncMapOverlay(…)` フック(既定は何もしない) |
| `game/celestial/celestial-system.ts:62-65,119-126,153-157,194-195,260-269,388-428,499-507,518-535,552-556` | `referenceLines: Map` を消す。`sync` が個体ごとに「出すか(policy.body(id).orbit)・濃さ(`referenceLineOpacityAt`)」を決めて個体へ指示する。`referenceOrbitLines` getter は `bodies` から線を持つものを列挙 |
| `game/celestial/celestial-system.ts:46-60,121-122,410-416,430-497,200-204` | 静止軌道リング・GEO ラベル・`buildGeoElements`・`earthSpinPhase0` を `Earth` へ |
| `game/celestial/earth.ts` | 上を受け取る。`syncMapOverlay` で GEO を描く |
| `game/celestial/celestial-system.ts:315-342` | 環の影: `referenceIds` + `bodyDef` の走査を `bodies` の `def.rings` 走査に |
| `game/orbit-pickables.ts:41` | getter の戻り型に追随 |

#### 達成条件と検証

- `npm run typecheck`。
- `grep -n "'earth'\|referenceLines\|referenceIds\|geoLine\|geoElements" src/game/celestial/celestial-system.ts` が 0 件。
- `npm run dev` マップビュー:
  - 参照軌道線が惑星=白・衛星=灰で出て、カメラを引くと惑星線が、寄ると衛星線がフェードする。
  - 表示パネルの「静止軌道」トグルで地球のリングと `GEO (35,786km)` ラベルが出入りする。
    地球から 24 万〜72 万 km で薄れて消える。
  - 土星へフォーカスして環の影が本体に落ちる。地球・火星の大気が描かれる。
  - 参照線を右クリックしてコンテキストメニューが出る。戦闘ビューへ戻すと参照線が消える。
- スナップショットを保存 → ロードで地球のテクスチャの向きが変わらない(`earthSpinPhase0`)。

### 手順 10(条件付き). `game/celestial/` を `src/celestial/` へ移す

#### 目的

`game/` と対称な置き場にする。**実施条件: この時点で `game/celestial/` が `game/` を import して
いないこと。** 満たさないなら着手せず、残っている import(`CameraSystem` / `FloatingOrigin` /
`OrbitLine` / `MarkerManager` / `MapVisibilityPolicy` / `game/const`)を列挙して報告し、ユーザーの
判断を待つ。**この時点で挙動は変えない。**

#### 変更が必要な箇所

| ファイル | 何をするか |
| --- | --- |
| `game/celestial/**` → `celestial/**` | `git mv` |
| `grep -rln "game/celestial\|\./celestial/" src tests tools tsconfig.test.json` の全件 | import パス |
| `DEVELOP/CODING-RULE.md` 1.3 | フォルダ境界に `celestial/` を1行足す |

#### 達成条件と検証

- `grep -rn "from '\.\./game/\|from '\.\./\.\./game/" src/celestial` が 0 件。
- `npm run typecheck`、`npm run test:physics`、`npm run dev` で起動。

## 見積り

編集の見積り。検証(`typecheck` + `test:physics` を手順あたり 2〜3 回 + 目視)は手順あたり 30 分で
別に足す(10 手順 × 30 分 ≈ 5 時間)。`test:physics` の部分実行が使えるようになれば検証側が縮むが、
全体を決めるのは編集量と委譲の並列度。

| 手順 | 導出 | 見積り |
| --- | --- | --- |
| 0 | 別名3つの置換 235 箇所(33 + 12 + 6 ファイル)× 0.5 分 + 定義の削除 | 2 時間 |
| 1 | `ephemeris.ts` から約 450 行を移して階層に組み直す: 450 行 × 0.5 分 + 数値差の追跡 1 時間 | 5 時間 |
| 2 | 置換 9 ファイル × 5 分 | 1 時間 |
| 3 | 改名 6 ファイル × 5 分 + 起動確認 | 1 時間 |
| 4 | 5 ファイルのコンストラクタ・sync 変更 5 × 20 分 + 表 98 項の `create` 書き換え 98 × 1 分 | 4 時間 |
| 5 | 約 150 行の切り出し × 1 分 + 委譲の配線 | 2 時間 |
| 6 | 98 項を名前付き定数 + 構築関数へ 98 × 2 分 + 共通部の分割 500 行 × 0.2 分 + `kind`/`planet` 読みの置換 約 30 箇所 × 3 分 + import 33 ファイル × 3 分 + テスト 25 ファイル × 3 分 | 9 時間(系単位に委譲すれば実時間 4 時間) |
| 7 | 呼び出し約 275 箇所 × 1.5 分(機械的な置換)+ 受け渡しの配線 55 ファイル × 5 分 + テスト 25 ファイル × 10 分 | 16 時間(8 群に委譲すれば実時間 5 時間) |
| 8 | 見た目 98 項 × 2 分 + 表の解体 100 項 × 1 分 + 入口と型 | 6 時間(系単位に委譲すれば実時間 3 時間) |
| 9 | `celestial-system.ts` の約 200 行を個体と `Earth` へ移す: 200 行 × 1 分 | 4 時間 |
| 10 | 条件を満たす場合: `git mv` + import 修正 約 40 ファイル × 2 分 | 1.5 時間 |

編集 約 52 時間(委譲込みで約 33 時間)+ 検証 約 5 時間。実測が得られたら置き換える。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 手順0 で `FrameAnchorId`(`string \| '@activeShip' \| '@navTarget'`)を `string` にすると、役割トークンと天体 id の区別が型から消える | 今も型では区別されておらず(`string` との union は `string` に潰れる)、区別は `frameRoleOf` の実行時判定だけ。挙動は変わらない | 手順0: `frame.test` / `frame-anchors.test` |
| 手順1 で重心補正の衛星走査順(`satellitesOf` の宣言順)が変わる | 位置に 1e-6 m 級の丸め差、テストが落ちる | 手順1: `ephemeris.test` / `equatorial-satellites.test` |
| 手順1 で `TimeRing` の段数や「キー厳密一致」の規約を崩す | 同一 t で別参照が返り、`celestialBodiesAt` の同一参照前提が外れて毎フレーム焼き直し | 手順1: 負荷確認ウィンドウの `timeCacheHits/Misses` が桁で変わる |
| 手順1 で暦パック経路の衛星分岐(`ephemeris.ts:364-371`)を落とす | パック期間で衛星が親からずれる | 手順1: `absolute-ephemeris.test`。`npm run dev` で開始日時を高精度期間にして月の位置 |
| 手順1 で `origin` が自分自身のとき `stateAt` が厳密 0 にならない書き方をする | 地球が原点から 1e-9 m 級でずれ、距離ゼロ判定が揺れる | 手順1: `celestial-body.test`(`:163` 地球が原点) |
| 手順1 で `EciOrigin` を書く前に `at` が呼ばれる | 起動時に例外 | 手順1: 構築関数の末尾で書き、`at` は未設定なら throw する |
| 手順1・7 で積分の内側(`dynamics.ts:131,143`)や接触判定を `motion.stateAt(pivot, t)` に書き換える | 段ごとに `TimeRing` の照合(最大 32 比較)と速度の Vec3 の割り当てが入り、個体数 × 段 × 重力源数ぶん遅くなる | 手順1・7: 窓の値に `celestialBodyPositionAt` を当てる形を保つ。負荷確認ウィンドウの orbit 区間の時間 |
| 手順1〜7 のどこかで (pivot, t) の選び方(手順1 の表)を変える | 軌道・接触・日照の値が変わる(1e-6 相対から、0次→2次で最大 km 級) | 各手順: `dynamics.test` / `surface-contact.test` / `shadow.test` / `window-agreement.test` |
| 手順2 で `defs` の順序が `Object.keys(registry)` と違う | 重力源配列の順が変わり、和の丸めで軌道が 1e-9 相対で変わる | 手順2: `window-agreement.test` |
| 手順4 で `SphereEntity` の `outerRadius`(`sphere-view.ts:55-57`)を `def.rings` から組み損ねる | 環付き天体の LOD 閾値が変わり、遠くで環ごと消える | 手順4: マップで土星を引いていったときの消える距離 |
| 手順4 で `Sun` の既定引数を消したあと、架空星系の恒星(`fallbackEntity`)が半径 0 になる | 恒星の見た目が消える | 手順4: `?stage=debug-alt-system` は恒星が無いので露見しない — 恒星付きの架空星系をテストで一度作る |
| 手順5 で `ReferenceFrames.frames` / `frameOf` が同じ対に同じ参照を返さなくなる | `trajectory-line.ts` の `frame === lastFrame` が毎フレーム外れて焼き直し | 手順5: 座標系を切り替えて軌道線の描画が重くならない(負荷確認ウィンドウ) |
| 手順6 で `all` の並びが今の `SOLAR_SYSTEM` の宣言順(earth, moon, mercury, …, sun)とずれる | 重力源配列の順が変わり、和の丸めで軌道が変わる。ラベル・一覧の並びも変わる | 手順6: 並びを固定するテストを1本残す。`window-agreement.test` |
| 手順6 で `satellites` への登録漏れ(惑星の構築後に衛星を作るが親の配列へ積み忘れる) | 重心補正が消え、木星・土星の本体位置が数千 km ずれる | 手順6: `laplace-satellites.test` / `equatorial-satellites.test`。`SatelliteMotion` のコンストラクタが親へ自分を積む形にして、忘れられなくする |
| 手順6 で `kind` を消したあと、CODING-RULE 1.8 が許す「分類に対する網羅的 switch」の置き場が無くなる | 分類の分岐が `instanceof` の羅列になる | 手順6: `motion.kind: 'star' \| 'planet' \| 'satellite'` の getter を残し、switch はそれに対して書く |
| 手順7 で `phaseOffsets` を motions から再構成し、明示 0 のキー(`{moon: 0}`)を落とす | セーブの内容が変わる(ロード結果は同じ) | 手順7: 構築時の record をそのまま返す。`save-ephemeris-context.test` |
| 手順7 で `nameOf` の未登録フォールバック(id をそのまま返す)を落とす | 架空天体のラベルが例外で止まる | 手順7: `?stage=debug-alt-system` のラベル |
| 手順7 で `MapVisibilityPolicy` の `focusSystemOf`(`map-visibility.ts:36-42`)の `-l1..5` 剥がしを壊す | ラグランジュ点フォーカス時に系の表示が消える | 手順7: 地球-L1 へフォーカス |
| 手順7 で tests がコンパイルする game ファイル(`tsconfig.test.json`)に `CelestialSystem` を渡す | `test:physics` が THREE / DOM の連鎖で落ちる | 手順7: `plan.ts` / `focus-target.ts` / `point-field.ts` / `placement-validation.ts` は物理部品だけを受ける |
| 手順7 で `tests/perf/` を放置する | `tests/perf` は npm script から呼ばれず、黙って腐る | 手順7: 壊れる実験ファイルは削除する(決めたこと 7) |
| 手順7 で `Game` のコンストラクタ内の `CelestialSystem.build(scene)` の位置を動かす | `scene.add` の順が変わり、renderOrder が同じ半透明物(環・大気・線)の重なりが変わる | 手順7: 今の `EnvironmentScene` 構築位置(`game.ts:177`)で `build` を呼ぶ |
| 手順8 で写像型を `Partial` にする、または `fallbackEntity` を太陽系パックでも使う | 見た目の書き忘れが黙って単色球になる | 手順8: 達成条件の「1体消して typecheck が落ちる」 |
| 手順8 で `EARTH_TEXTURES` 経由の地球の測光(`celestial-textures.ts:76`)を落とす | 地球照が単色既定 0.11 に落ちて暗くなる | 手順8: マップで月の夜側の地球照 |
| 手順8 でアルベド 82 項の転記を誤る | 特定の衛星の明るさだけ変わる | 手順8: 転記は機械的に行い、目で並べて照合する |
| 手順6・8 で `tools/render-lab/cases.ts` の import を直し忘れる | `npm run render-lab` が落ちる(typecheck の対象外) | 手順6・8: `npm run render-lab:shot` |
| 手順9 で参照線の生成を起動時に全数へ戻す | 非表示設定でも 97 本の頂点バッファが常駐 | 手順9: 遅延生成(`ensure`/`remove`)を保つ |
| 手順9 で `Earth` の自転(`earth-view.ts:40` の `phase0 + 2πt/SIDEREAL_DAY`)を physics の `spinRotationAt('earth')`(`ephemeris.ts:577-580`、phase0 なし)へ揃えたくなる | 挙動が変わる(地球自転系の向きとテクスチャが一致するようになる)。是正としては正しいが本計画の外 | 手順9: 揃えない。別件として報告する |
