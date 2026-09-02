// 星系の全天体から、表示に使う座標系(ReferenceFrame)の集合と、その時刻ごとの剛体運動
// (FrameTransform)を供給する。天体の ECI 値を入力に取り、参照フレーム相対への剛体運動を
// 答える。座標系そのものの値の変換は physics/frame.ts の純関数群が担い、ここは
// 「どの座標系があるか」と「その原点・姿勢・角速度が時刻 t で何になるか」を答える。
// THREE/DOM 非依存。
import { Quat, qFromForwardUp } from '../../math/quat';
import { CelestialMotion, OrbitingMotion, SatelliteMotion } from '../../physics/celestial-motion';
import { EciTransform } from '../../physics/eci-transform';
import {
  FrameAnchorSource, FrameRotationSource, FrameTransform, ReferenceFrame, rotationSourceKey,
} from '../../physics/frame';
import { FrameRotation } from '../../physics/kepler-orbit';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { cross, len, lenSq, norm, scale, sub, v3 } from '../../math/vec3';

// 回転しない座標系(ReferenceFrame.rotatingWith === null)の姿勢・角速度。
const IDENTITY_ROTATION: FrameRotation = { q: { x: 0, y: 0, z: 0, w: 1 } as Quat, omega: v3() };

// 回転系(rotatingWith が非 null)の原点。衛星は惑星まわりの公転を止めて見せたいので
// その惑星(例: 月回転系は地球中心)、惑星は自分自身(例: 太陽-地球回転系は地球中心のまま、
// 地球自身の公転方向へ向きだけ合わせる。原点ごと恒星へ移した完全な恒星中心系が欲しければ
// {center: starId, rotatingWith: null} を使う)。
function rotatingFrameCenterOf(motion: CelestialMotion): string {
  return motion instanceof SatelliteMotion ? motion.planet.id : motion.id;
}

export class ReferenceFrames {
  // 登録天体の id 引き。座標系の基準・回転対象が登録天体かどうかの判定もこれで行う。
  private readonly motionsById: Readonly<Partial<Record<string, CelestialMotion>>>;

  // (center, rotationSourceKey(rotatingWith)) の対ごとに ReferenceFrame を1個だけ持つキャッシュ。
  private readonly frameCache = new Map<string, Map<string, ReferenceFrame>>();

  // origin 中心・無回転の慣性系。frameOf(origin.id, null) と同一参照。
  readonly inertialFrame: ReferenceFrame;
  // 全天体の慣性系 + 公転天体ぶんの回転系。値は frameOf が返すのと同じ参照になる。
  readonly frames: readonly ReferenceFrame[];

  // motions は宣言順の全登録天体、eci は天体の値を ECI へ移す変換器(その原点が慣性系の中心)。
  constructor(motions: readonly CelestialMotion[], private readonly eci: EciTransform) {
    this.motionsById = Object.fromEntries(motions.map((m) => [m.id, m]));
    const originId = eci.originId;
    this.inertialFrame = this.frameOf(originId, null);
    this.frames = [
      this.inertialFrame,
      ...motions.filter((m) => m.id !== originId).map((m) => this.frameOf(m.id, null)),
      ...motions.filter((m) => m.kind !== 'star')
        .map((m) => this.frameOf(rotatingFrameCenterOf(m), { kind: 'revolution', id: m.id })),
    ];
  }

  // center 中心・rotatingWith の回転(公転か自転)に合わせて回る座標系(rotatingWith が null
  // なら慣性系)。同じ対には常に同じ参照を返す。center/rotatingWith.id は登録されていない id
  // (生存中の重力天体・機体・役割トークン)でもよい — transformAt 側がその場合の解決を担う。
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
  transformAt(frame: ReferenceFrame, t: number, source: FrameAnchorSource): FrameTransform {
    const origin = this.anchorStateAt(frame.center, t, source);
    const rotation = this.frameRotationAt(frame.rotatingWith, t, source) ?? IDENTITY_ROTATION;
    return { origin: origin.r, originVel: origin.v, q: rotation.q, omega: rotation.omega };
  }

  // rotatingWith が指す回転。恒等でよい(回転しない・回転を組めない)ときは null。'spin' は
  // その天体の自転基準系、'revolution' は登録天体なら解析的な公転回転基準系。
  // 登録されていない(= 生存中の重力天体・機体・役割トークンの)id は解析軌道を持たないので、
  // source が答える主天体との瞬間の相対状態(x̂ = 主天体→id、ẑ = 相対角運動量方向)から
  // 骨組みの基底を組む — 主天体は frame.center とは独立に source.attractorOf が決める
  // (CELESTIAL.md 8節: 原点をどこに選んでも回転対象自身の主天体まわりの公転になる)。
  private frameRotationAt(
    rotatingWith: FrameRotationSource | null, t: number, source: FrameAnchorSource,
  ): FrameRotation | null {
    if (rotatingWith === null) return null;
    if (rotatingWith.kind === 'spin') return this.motionOf(rotatingWith.id).spinRotationAt(t);
    const registered = this.motionsById[rotatingWith.id];
    if (registered !== undefined) return this.orbitingMotionOf(registered).orbitFrameRotationAt(t);
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

  // 参照フレームの基準の時刻 t における状態。登録天体なら天体自身、無ければ source
  // (生存中の重力天体・機体・役割トークン)に委ね、どちらでも解決できなければ ECI 原点に落とす。
  private anchorStateAt(id: string, t: number, source: FrameAnchorSource): KinematicState {
    const motion = this.motionsById[id];
    if (motion !== undefined) return this.eci.stateAt(t, motion);
    return source.stateOf(id, t) ?? kinematicState<'eci'>(t, v3(), v3());
  }

  // 天体 id の運動。登録されていない id を渡すと例外になる。
  private motionOf(id: string): CelestialMotion {
    const motion = this.motionsById[id];
    if (motion === undefined) throw new Error(`ReferenceFrames: 登録されていない天体 id: ${id}`);
    return motion;
  }

  // 公転している天体の運動。恒星を渡すと例外になる。
  private orbitingMotionOf(motion: CelestialMotion): OrbitingMotion {
    if (!(motion instanceof OrbitingMotion)) throw new Error(`ReferenceFrames: 公転していない天体 id: ${motion.id}`);
    return motion;
  }
}
