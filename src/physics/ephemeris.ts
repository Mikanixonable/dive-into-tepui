// 天体暦: レジストリから天体ごとの CelestialMotion を組み、任意時刻の ECI 位置・速度・
// 重力源配列・回転基準系・ラグランジュ点を天体 id 引きで答えるサンプラ。系レベルの計算
// (座標系と天体一覧の窓)は ReferenceFrames / CelestialBodyWindows へ委譲する。
import { AbsoluteEphemeris, OriginCenteredEphemeris } from './absolute-ephemeris';
import { CelestialBody } from './celestial-body';
import { CelestialBodyWindows } from './celestial-body-windows';
import {
  BodyOrientation, CelestialMotion, EciOrigin, OrbitingMotion, PlanetMotion, SatelliteMotion, StarMotion,
} from './celestial-motion';
import { FrameAnchorSource, FrameRotationSource, ReferenceFrame, FrameTransform } from './frame';
import { FrameRotation } from './kepler-orbit';
import { LagrangePoints } from './lagrange';
import { ReferenceFrames } from './reference-frames';
import { CelestialBodyDef, CelestialRegistry, SOLAR_SYSTEM, starOf } from './solar-system';
import { KinematicState } from './kinematic-state';
import { SECONDS_PER_DAY } from './time';
import { TimeCacheStats } from './time-ring';
import { Vec3, norm, sub, v3 } from '../math/vec3';

// 全天体の軌道評価時刻へ一律に足す定数 [s]。要素の元期は J2000 のままにしたうえで、
// simTime = 0 をゲーム開始にふさわしい瞬間 — 地球から見て太陽が +X 方向(昼側)にある、
// すなわち地球の日心黄経が π になる瞬間 — へ合わせる。
// 導出: 地球の平均黄経 L(t) = l0 + L̇·t を L = 180° と置いて解く。
//   (180° − 100.46457166°) / 35999.37244981 [deg/Cy] × JULIAN_CENTURY = 6.9721972e6 s。
// 中心差(真黄経と平均黄経の差)は地球の e = 0.0167 で高々 ±1.9° あるが、この定数は
// 見た目の昼夜を合わせるためのアンカーなので平均黄経で足りる。
export const EPOCH_T_OFFSET = 6972197.1872752225;

export class Ephemeris {
  // 天体ごとの平均黄経の初期オフセット。構築時に決まり、以後変わらない。
  private readonly phaseOffsets: Partial<Record<string, number>>;

  // registry の全天体の運動(宣言順)。celestialBodiesAt が返す配列の順序でもある。
  private readonly motions: readonly CelestialMotion[];
  private readonly motionsById: Readonly<Partial<Record<string, CelestialMotion>>>;

  private readonly referenceFrames: ReferenceFrames;
  private readonly windows: CelestialBodyWindows;

  // registry の主星。恒星を持たないレジストリでは null(輻射源・影の計算がそもそも無意味になる)。
  readonly starId: string | null;

  // registry/originId/epochOffsetSec を省略すると現実の太陽系・地球原点・既定エポックで動く。
  // absoluteSource を渡すと、その有効期間だけ高精度暦パック経路を通る。
  constructor(
    readonly registry: CelestialRegistry = SOLAR_SYSTEM,
    readonly originId: string = 'earth',
    epochOffsetSec: number = EPOCH_T_OFFSET,
    phaseOffsets: Partial<Record<string, number>> = {},
    absoluteSource?: AbsoluteEphemeris,
    epochJdTdb = 2451545 + epochOffsetSec / SECONDS_PER_DAY,
  ) {
    this.phaseOffsets = phaseOffsets;
    this.starId = starOf(registry);
    const precise = absoluteSource === undefined
      ? null
      : new OriginCenteredEphemeris(absoluteSource, originId, epochJdTdb);
    const origin = new EciOrigin();

    // 恒星→惑星→衛星の順に作る。衛星は親の惑星の参照を要求し、自分を親の重心補正へ積む。
    const byId: Partial<Record<string, CelestialMotion>> = {};
    let star: StarMotion | null = null;
    for (const [id, def] of Object.entries(registry)) {
      if (def.kind !== 'star') continue;
      star = new StarMotion(def, this.phaseOf(id), epochOffsetSec, precise, origin);
      byId[id] = star;
    }
    for (const [id, def] of Object.entries(registry)) {
      if (def.kind !== 'planet') continue;
      byId[id] = new PlanetMotion(def, star, this.phaseOf(id), epochOffsetSec, precise, origin);
    }
    for (const [id, def] of Object.entries(registry)) {
      if (def.kind !== 'satellite') continue;
      const planet = byId[def.planet];
      if (!(planet instanceof PlanetMotion)) throw new Error(`Ephemeris: 衛星 ${id} の惑星 ${def.planet} が無い`);
      byId[id] = new SatelliteMotion(def, planet, this.phaseOf(id), epochOffsetSec, precise, origin);
    }
    this.motionsById = byId;

    // 木が揃ってから ECI の中心を結ぶ。中心天体自身も自分を参照するので、この順序は崩せない。
    this.motions = Object.keys(registry).map((id) => this.motionOf(id));
    origin.set(this.motionOf(originId));

    this.referenceFrames = new ReferenceFrames(this.motions, this.motionOf(originId));
    this.windows = new CelestialBodyWindows(this.motions);
  }

  // celestialBodiesAt の時刻キャッシュのヒット/ミス累計。
  get celestialBodiesCacheStats(): TimeCacheStats { return this.windows.celestialBodiesStats; }

  // 保持する全時刻キャッシュを合算したヒット/ミス累計。
  get timeCacheStats(): TimeCacheStats { return this.windows.stats; }

  // 負荷確認ウィンドウが読む、時刻キャッシュのヒット/ミス累計。perf-meter.ts の
  // PerfCounts を import すると DOM/three 依存の連鎖を引き込むため、戻り値の形を
  // ここで直接書く(tsconfig.test.json でも DOM/three 非依存のまま compile できる)。
  perfCounts(): {
    celestialBodiesCacheHits: number; celestialBodiesCacheMisses: number;
    timeCacheHits: number; timeCacheMisses: number;
  } {
    const bodies = this.celestialBodiesCacheStats;
    const time = this.timeCacheStats;
    return {
      celestialBodiesCacheHits: bodies.hits, celestialBodiesCacheMisses: bodies.misses,
      timeCacheHits: time.hits, timeCacheMisses: time.misses,
    };
  }

  // 現在の位相オフセットのスナップショット(セーブ用)。
  getPhaseOffsets(): Partial<Record<string, number>> { return { ...this.phaseOffsets }; }

  // id の平均黄経の初期位相(未指定なら 0)。
  private phaseOf(id: string): number { return this.phaseOffsets[id] ?? 0; }

  // 天体 id の運動。registry に無い id を渡すと例外になる。
  motionOf(id: string): CelestialMotion {
    const motion = this.motionsById[id];
    if (motion === undefined) throw new Error(`Ephemeris: レジストリに登録されていない天体 id: ${id}`);
    return motion;
  }

  // 公転している天体 id の運動。恒星や registry に無い id を渡すと例外になる。
  private orbitingMotionOf(id: string): OrbitingMotion {
    const motion = this.motionOf(id);
    if (!(motion instanceof OrbitingMotion)) throw new Error(`Ephemeris: 公転していない天体 id: ${id}`);
    return motion;
  }

  // 指定時刻の ECI(originId 中心)位置・速度。originId 自身は厳密に 0 になる。
  stateOf(id: string, t: number): KinematicState { return this.motionOf(id).stateAt(t); }

  // 指定時刻の ECI 位置。
  positionOf(id: string, t: number): Vec3 { return this.motionOf(id).stateAt(t).r; }

  // 1天体ぶんの時刻 t での重力源表現。返る値は不変。
  celestialBodyAt(id: string, t: number): CelestialBody { return this.motionOf(id).at(t); }

  // 天体 id に固定した回転基準系(x̂ = 中心天体→id、ẑ = 軌道面法線)。中心は分類から決まる
  // (惑星なら恒星、衛星ならその惑星)。
  orbitFrameRotationAt(id: string, t: number): FrameRotation { return this.orbitingMotionOf(id).orbitFrameRotationAt(t); }

  // id の軌道面の法線(単位ベクトル、ECI)。
  orbitNormalAt(id: string, t: number): Vec3 { return this.orbitingMotionOf(id).orbitNormalAt(t); }

  // secondary(公転している天体)を副天体とする円制限三体問題のラグランジュ点。
  lagrangeAt(secondary: string, t: number): LagrangePoints { return this.orbitingMotionOf(secondary).lagrangeAt(t); }

  // ラグランジュ点1点の ECI 状態(位置・速度)。
  lagrangeStateAt(secondary: string, point: keyof LagrangePoints, t: number): KinematicState {
    return this.orbitingMotionOf(secondary).lagrangeStateAt(point, t);
  }

  // secondary の共線点(L1/L2/L3)が行き先として意味を持つか。公転していない天体では false。
  hasUsableCollinearPoints(secondary: string, minClearanceRatio: number): boolean {
    const motion = this.motionOf(secondary);
    return motion instanceof OrbitingMotion && motion.hasUsableCollinearPoints(minClearanceRatio);
  }

  // secondary の三角点(L4/L5)が線形安定か。公転していない天体では false。
  hasStableTriangularPoints(secondary: string): boolean {
    const motion = this.motionOf(secondary);
    return motion instanceof OrbitingMotion && motion.hasStableTriangularPoints();
  }

  // 天体の自転軸(単位ベクトル、ECI)と、その軸まわりの自転位相 [rad]。自転軸を持たない天体は null。
  poleAt(id: string, t: number): BodyOrientation | null { return this.motionOf(id).orientationAt(t); }

  // 天体 id の自転に固定した回転基準系。自転モデルを持たない天体では null。
  spinRotationAt(id: string, t: number): FrameRotation | null { return this.motionOf(id).spinRotationAt(t); }

  // ECI の点 r から見た恒星方向の単位ベクトル(陰影・日照判定・輻射の向き)。基準点を引数に
  // 取るのは、恒星との位置関係が点ごとに違うため — 惑星間では地心方向で代用できない。
  // 恒星が無いレジストリでは無害な既定方向(+X)を返す。
  sunDirFrom(r: Vec3, t: number): Vec3 {
    return this.starId === null ? v3(1, 0, 0) : norm(sub(this.positionOf(this.starId, t), r));
  }

  // originId 中心・無回転の慣性系。frameOf(originId, null) と同一参照。
  get inertialFrame(): ReferenceFrame { return this.referenceFrames.inertialFrame; }

  // 全天体の慣性系 + 公転天体ぶんの回転系。値は frameOf が返すのと同じ参照になる。
  get frames(): readonly ReferenceFrame[] { return this.referenceFrames.frames; }

  // center 中心・rotatingWith の回転(公転か自転)に合わせて回る座標系(rotatingWith が null
  // なら慣性系)。同じ対には常に同じ参照を返す。
  frameOf(center: string, rotatingWith: FrameRotationSource | null): ReferenceFrame {
    return this.referenceFrames.frameOf(center, rotatingWith);
  }

  // 登録の有無を問わず center 中心の慣性系を返す、frameOf(id, null) の別名。
  frameFor(id: string): ReferenceFrame { return this.referenceFrames.frameFor(id); }

  // ReferenceFrame の時刻 t における剛体運動。
  frameTransformAt(frame: ReferenceFrame, t: number, source: FrameAnchorSource): FrameTransform {
    return this.referenceFrames.transformAt(frame, t, source);
  }

  // 全登録天体の定義(registry の宣言順)。
  get defs(): readonly CelestialBodyDef[] {
    return this.motions.map((m) => m.def);
  }

  // 指定時刻の全登録天体(registry の宣言順)。origin は原点に静止。
  // 同一 t には同一の配列参照が返るので、**呼び出し側はこの配列と要素を書き換えてはならない。**
  celestialBodiesAt(t: number): readonly CelestialBody[] { return this.windows.celestialBodiesAt(t); }

  // 指定時刻の重力源天体(mu が 0 でないもの、registry の宣言順)。配列の扱いは
  // celestialBodiesAt と同じ。
  gravityAttractorsAt(t: number): readonly CelestialBody[] { return this.windows.gravityAttractorsAt(t); }

  // 指定時刻の大気を持つ天体(registry の宣言順)。抗力を掛ける1体を選ぶ側が引く窓で、
  // 配列の扱いは celestialBodiesAt と同じ。
  atmosphereCelestialBodiesAt(t: number): readonly CelestialBody[] {
    return this.windows.atmosphereCelestialBodiesAt(t);
  }
}
