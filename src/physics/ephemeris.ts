// 天体暦: レジストリから天体ごとの CelestialMotion を組み、任意時刻の ECI 位置・速度・
// 重力源配列・回転基準系・ラグランジュ点を天体 id 引きで答えるサンプラ。
// 天体一覧を返す各メソッドは時刻 t をキーにした固定長リングでメモ化する。ヒットするのは
// キーが厳密に一致したときだけで、ミス時は常に再計算するため、どの順に呼んでも返る値は
// 変わらない(呼び出し順に依存する隠れた制約を作らない)。
import { Quat, qFromForwardUp } from './attitude';
import { AbsoluteEphemeris, OriginCenteredEphemeris } from './absolute-ephemeris';
import { CelestialBody } from './celestial-body';
import {
  BodyOrientation, CelestialMotion, EciOrigin, OrbitingMotion, PlanetMotion, SatelliteMotion, StarMotion,
} from './celestial-motion';
import { FrameAnchorSource, FrameRotationSource, ReferenceFrame, FrameTransform, rotationSourceKey } from './frame';
import { FrameRotation } from './kepler-orbit';
import { LagrangePoints } from './lagrange';
import { CelestialBodyDef, CelestialRegistry, SOLAR_SYSTEM, starOf } from './solar-system';
import { KinematicState, kinematicState } from './kinematic-state';
import { SECONDS_PER_DAY } from './time';
import { TimeCacheStats, TimeRing, addTimeCacheStats } from './time-ring';
import { Vec3, cross, len, lenSq, norm, scale, sub, v3 } from '../math/vec3';

// 全天体の軌道評価時刻へ一律に足す定数 [s]。要素の元期は J2000 のままにしたうえで、
// simTime = 0 をゲーム開始にふさわしい瞬間 — 地球から見て太陽が +X 方向(昼側)にある、
// すなわち地球の日心黄経が π になる瞬間 — へ合わせる。
// 導出: 地球の平均黄経 L(t) = l0 + L̇·t を L = 180° と置いて解く。
//   (180° − 100.46457166°) / 35999.37244981 [deg/Cy] × JULIAN_CENTURY = 6.9721972e6 s。
// 中心差(真黄経と平均黄経の差)は地球の e = 0.0167 で高々 ±1.9° あるが、この定数は
// 見た目の昼夜を合わせるためのアンカーなので平均黄経で足りる。
export const EPOCH_T_OFFSET = 6972197.1872752225;

// 回転しない座標系(ReferenceFrame.rotatingWith === null)の姿勢・角速度。
const IDENTITY_ROTATION: FrameRotation = { q: { x: 0, y: 0, z: 0, w: 1 } as Quat, omega: v3() };

// 回転系(rotatingWith が非 null)の原点。衛星は惑星まわりの公転を止めて見せたいので
// その惑星(例: 月回転系は地球中心)、惑星は自分自身(例: 太陽-地球回転系は地球中心のまま、
// 地球自身の公転方向へ向きだけ合わせる。原点ごと恒星へ移した完全な恒星中心系が欲しければ
// {center: starId, rotatingWith: null} を使う)。
function rotatingFrameCenterOf(motion: CelestialMotion): string {
  return motion instanceof SatelliteMotion ? motion.planet.id : motion.id;
}

export class Ephemeris {
  // 天体ごとの平均黄経の初期オフセット。構築時に決まり、以後変わらない。
  private readonly phaseOffsets: Partial<Record<string, number>>;

  // registry の全天体の運動(宣言順)。celestialBodiesAt が返す配列の順序でもある。
  private readonly motions: readonly CelestialMotion[];
  private readonly motionsById = new Map<string, CelestialMotion>();
  // mu が 0 でない天体と、大気を持つ天体(いずれも宣言順)。どちらも時刻に依らないので構築時に確定する。
  private readonly gravityMotions: readonly CelestialMotion[];
  private readonly atmosphereMotions: readonly CelestialMotion[];

  // 天体一覧を返す各メソッドの時刻キャッシュ。
  private readonly allCelestialBodiesCache = new TimeRing<readonly CelestialBody[]>();
  private readonly gravityAttractorsCache = new TimeRing<readonly CelestialBody[]>();
  private readonly atmosphereCelestialBodiesCache = new TimeRing<readonly CelestialBody[]>();

  // registry の主星。恒星を持たないレジストリでは null(輻射源・影の計算がそもそも無意味になる)。
  readonly starId: string | null;
  // originId 中心・無回転の慣性系。frameOf(originId, null) と同一参照。
  readonly inertialFrame: ReferenceFrame;
  // 全天体の慣性系 + 公転天体ぶんの回転系。値は frameOf が返すのと同じ参照になる。
  readonly frames: readonly ReferenceFrame[];
  // (center, rotationSourceKey(rotatingWith)) の対ごとに ReferenceFrame を1個だけ持つキャッシュ。
  private readonly frameCache = new Map<string, Map<string, ReferenceFrame>>();

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
    let star: StarMotion | null = null;
    for (const [id, def] of Object.entries(registry)) {
      if (def.kind !== 'star') continue;
      star = new StarMotion(def, this.phaseOf(id), epochOffsetSec, precise, origin);
      this.motionsById.set(id, star);
    }
    for (const [id, def] of Object.entries(registry)) {
      if (def.kind !== 'planet') continue;
      this.motionsById.set(id, new PlanetMotion(def, star, this.phaseOf(id), epochOffsetSec, precise, origin));
    }
    for (const [id, def] of Object.entries(registry)) {
      if (def.kind !== 'satellite') continue;
      const planet = this.motionsById.get(def.planet);
      if (!(planet instanceof PlanetMotion)) throw new Error(`Ephemeris: 衛星 ${id} の惑星 ${def.planet} が無い`);
      this.motionsById.set(id, new SatelliteMotion(def, planet, this.phaseOf(id), epochOffsetSec, precise, origin));
    }

    // 木が揃ってから ECI の中心を結ぶ。中心天体自身も自分を参照するので、この順序は崩せない。
    this.motions = Object.keys(registry).map((id) => this.motionOf(id));
    origin.set(this.motionOf(originId));

    this.gravityMotions = this.motions.filter((m) => m.def.mu !== 0);
    this.atmosphereMotions = this.motions.filter((m) => m instanceof OrbitingMotion && m.def.atmosphere !== undefined);
    this.inertialFrame = this.frameOf(originId, null);
    this.frames = [
      this.inertialFrame,
      ...this.motions.filter((m) => m.id !== originId).map((m) => this.frameOf(m.id, null)),
      ...this.motions.filter((m) => m.kind !== 'star')
        .map((m) => this.frameOf(rotatingFrameCenterOf(m), { kind: 'revolution', id: m.id })),
    ];
  }

  // celestialBodiesAt の時刻キャッシュのヒット/ミス累計。
  get celestialBodiesCacheStats(): TimeCacheStats { return this.allCelestialBodiesCache.stats; }

  // 保持する全時刻キャッシュを合算したヒット/ミス累計。
  get timeCacheStats(): TimeCacheStats {
    let stats = addTimeCacheStats(this.allCelestialBodiesCache.stats, this.gravityAttractorsCache.stats);
    stats = addTimeCacheStats(stats, this.atmosphereCelestialBodiesCache.stats);
    for (const motion of this.motions) stats = addTimeCacheStats(stats, motion.cacheStats);
    return stats;
  }

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
  private motionOf(id: string): CelestialMotion {
    const motion = this.motionsById.get(id);
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

  // center 中心・rotatingWith の回転(公転か自転)に合わせて回る座標系(rotatingWith が null
  // なら慣性系)。同じ対には常に同じ参照を返す。center/rotatingWith.id は registry に
  // 登録されていない id(生存中の重力天体・機体・役割トークン)でもよい —
  // frameTransformAt 側がその場合の解決を担う。
  frameOf(center: string, rotatingWith: FrameRotationSource | null): ReferenceFrame {
    let byRotation = this.frameCache.get(center);
    if (byRotation === undefined) {
      byRotation = new Map();
      this.frameCache.set(center, byRotation);
    }
    // rotatingWith オブジェクト自身もキャッシュ内で1個だけ作って使い回す。
    const key = rotationSourceKey(rotatingWith);
    let frame = byRotation.get(key);
    if (frame === undefined) {
      frame = { center, rotatingWith };
      byRotation.set(key, frame);
    }
    return frame;
  }

  // 登録の有無を問わず center 中心の慣性系を返す、frameOf(id, null) の別名。
  frameFor(id: string): ReferenceFrame { return this.frameOf(id, null); }

  // ReferenceFrame の時刻 t における剛体運動。origin は frame.center の状態、回転は
  // frameRotationAt が決める。
  frameTransformAt(frame: ReferenceFrame, t: number, source: FrameAnchorSource): FrameTransform {
    const origin = this.anchorStateAt(frame.center, t, source);
    const rotation = this.frameRotationAt(frame.rotatingWith, t, source) ?? IDENTITY_ROTATION;
    return { origin: origin.r, originVel: origin.v, q: rotation.q, omega: rotation.omega };
  }

  // rotatingWith が指す回転。恒等でよい(回転しない・回転を組めない)ときは null。'spin' は
  // その天体の自転基準系、'revolution' は registry の天体なら解析的な公転回転基準系。
  // registry に無い(= 生存中の重力天体・機体・役割トークンの)id は解析軌道を持たないので、
  // source が答える主天体との瞬間の相対状態(x̂ = 主天体→id、ẑ = 相対角運動量方向)から
  // 骨組みの基底を組む — 主天体は frame.center とは独立に source.attractorOf が決める
  // (CELESTIAL.md 8節: 原点をどこに選んでも回転対象自身の主天体まわりの公転になる)。
  private frameRotationAt(
    rotatingWith: FrameRotationSource | null, t: number, source: FrameAnchorSource,
  ): FrameRotation | null {
    if (rotatingWith === null) return null;
    if (rotatingWith.kind === 'spin') return this.spinRotationAt(rotatingWith.id, t);
    if (rotatingWith.id in this.registry) return this.orbitFrameRotationAt(rotatingWith.id, t);
    // 登録天体でない対象は、その瞬間の主天体相対状態から基底を組む。
    const target = source.stateOf(rotatingWith.id, t);
    if (target === null) return null;
    const primaryId = source.attractorOf(rotatingWith.id, t);
    if (primaryId === null) return null;
    const primary = this.anchorStateAt(primaryId, t, source);
    const rel = sub(target.r, primary.r);
    const h = cross(rel, sub(target.v, primary.v));
    if (lenSq(rel) < 1 || lenSq(h) < 1e-9) return null;
    const zHat = norm(h);
    const q = qFromForwardUp(zHat, cross(zHat, norm(rel))) ?? IDENTITY_ROTATION.q;
    return { q, omega: scale(zHat, len(h) / (len(rel) * len(rel))) };
  }

  // 参照フレームの基準の時刻 t における状態。registry にあれば暦、無ければ source
  // (生存中の重力天体・機体・役割トークン)に委ね、どちらでも解決できなければ ECI 原点に落とす。
  private anchorStateAt(id: string, t: number, source: FrameAnchorSource): KinematicState {
    if (id in this.registry) return this.stateOf(id, t);
    return source.stateOf(id, t) ?? kinematicState(t, v3(), v3());
  }

  // 全登録天体の定義(registry の宣言順)。
  get defs(): readonly CelestialBodyDef[] {
    return this.motions.map((m) => m.def);
  }

  // 指定時刻の全登録天体(registry の宣言順)。origin は原点に静止。
  // 同一 t には同一の配列参照が返るので、**呼び出し側はこの配列と要素を書き換えてはならない。**
  celestialBodiesAt(t: number): readonly CelestialBody[] {
    const cached = this.allCelestialBodiesCache.get(t);
    if (cached !== undefined) return cached;
    return this.allCelestialBodiesCache.put(t, this.motions.map((m) => m.at(t)));
  }

  // 指定時刻の重力源天体(mu が 0 でないもの、registry の宣言順)。配列の扱いは
  // celestialBodiesAt と同じ。
  gravityAttractorsAt(t: number): readonly CelestialBody[] {
    const cached = this.gravityAttractorsCache.get(t);
    if (cached !== undefined) return cached;
    return this.gravityAttractorsCache.put(t, this.gravityMotions.map((m) => m.at(t)));
  }

  // 指定時刻の大気を持つ天体(registry の宣言順)。抗力を掛ける1体を選ぶ側が引く窓で、
  // 配列の扱いは celestialBodiesAt と同じ。
  atmosphereCelestialBodiesAt(t: number): readonly CelestialBody[] {
    const cached = this.atmosphereCelestialBodiesCache.get(t);
    if (cached !== undefined) return cached;
    return this.atmosphereCelestialBodiesCache.put(t, this.atmosphereMotions.map((m) => m.at(t)));
  }
}
