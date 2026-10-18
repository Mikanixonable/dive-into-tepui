// 参照軌道(軌道標識): 質量も当たり判定も持たず、位置・速度が時刻の関数として決まる軌道。
// 2つの型がある。
// - elements: 基準天体の重力定数と元期の平均軌道要素から、J2 永年歳差だけを反映して
//   時刻 t の ECI 状態を返す。大気減衰・第三体摂動・短周期変動は含めない。
// - family: 制限三体問題の族メンバーを、その瞬間の実天体位置で組んだ回転座標系へ載せる。
//   理想解なので、その上に乗った実体は現実の摂動でずれていく。
// THREE/DOM 非依存の純粋関数群。
import { stateFromOrbitalElements, meanMotionFromSemiMajor } from './elements';
import { kinematicState, type KinematicState } from './kinematic-state';
import type { CelestialBody } from './celestial-body';
import type { CollinearPoint } from './lagrange';
import { addScaled, cross, scale, type Vec3 } from '../math/vec3';

// 族の1メンバーの指定。カタログの焼き込み族は族 id と族内位置 s∈[0,1]、
// Richardson 解析解で組む族はラグランジュ点と振幅 [m]。リサジューの psi は面外位相 [rad]。
export type OrbitFamilyDescriptor =
  | { readonly kind: 'catalog'; readonly familyId: string; readonly s: number }
  | { readonly kind: 'halo'; readonly point: CollinearPoint; readonly az: number }
  | { readonly kind: 'lissajous'; readonly point: CollinearPoint; readonly ax: number; readonly az: number; readonly psi: number };

// 基準天体まわりの標識。要素は元期 epoch の平均軌道要素(角度は [rad]、距離は [m])。
export interface ReferenceOrbitElements {
  readonly kind: 'elements';
  readonly bodyId: string;
  readonly epoch: number; // 元期 [s](simTime)
  readonly a: number;
  readonly e: number;
  readonly i: number; // 傾斜角 [rad]
  readonly raan: number;
  readonly argPeriapsis: number;
  readonly meanAnomaly0: number; // 元期の平均近点角 [rad]
}

// ラグランジュ点まわりの標識。族メンバーは系(主星 primaryId・副星 secondaryId)と族記述で指し、
// 位相はメンバーの周期を回る小数位相(0..1 で1周)として持つ。
// phase0 は simTime=0 での位相点の位相(配置側が配置時刻を織り込んで決める)。
export interface ReferenceOrbitFamily {
  readonly kind: 'family';
  readonly primaryId: string;
  readonly secondaryId: string;
  readonly familyDescriptor: OrbitFamilyDescriptor;
  readonly phase0: number; // simTime=0 での位相 (0..1)
}

export type ReferenceOrbit = ReferenceOrbitElements | ReferenceOrbitFamily;

// 標識が時刻 t にあるべき状態を返すために必要な環境。
// - bodyById: 基準天体。mu・j2・半径・その時刻の ECI 状態をここから読む。
// - familyMemberAt: 族メンバーの回転座標系の周期と、位相 0..1 の無次元回転座標状態
//   ([x,y,z,vx,vy,vz])。族・メンバーが無いときは null。
// - rotatingFrameAt: 系を時刻 t の実天体位置で組んだ回転座標系
//   (orbit-guide.rotatingFrame と同じ規則)+ その角速度 omega [rad/s]。
export interface ReferenceOrbitEnv {
  bodyById(id: string): CelestialBody | null;
  // 基準天体の2次重力場。J2 を持たない天体は undefined(歳差なしとして扱う)。
  degree2Field(bodyId: string, t: number): { readonly j2: number; readonly refRadius: number } | undefined;
  familyMemberAt(
    orbit: ReferenceOrbitFamily,
  ): { period: number; sample(phase: number): readonly [number, number, number, number, number, number] } | null;
  rotatingFrameAt(
    primaryId: string, secondaryId: string, t: number,
  ): { origin: Vec3; xHat: Vec3; yHat: Vec3; zHat: Vec3; unit: number; omega: number } | null;
}

// J2 永年歳差率。dΩ/dt = −(3/2)nJ₂(R/p)²cosi、dω/dt = (3/4)nJ₂(R/p)²(5cos²i−1)、
// 平均運動の補正 n̄ = n(1 + (3/4)J₂(R/p)²√(1−e²)(3cos²i−1))。
function secularRates(
  a: number, e: number, inc: number, mu: number, j2: number, radius: number,
): { raanDot: number; argpDot: number; meanMotion: number } {
  const p = a * (1 - e * e);
  const n = meanMotionFromSemiMajor(a, mu);
  if (!(p > 0) || !(j2 > 0)) return { raanDot: 0, argpDot: 0, meanMotion: n };
  const rp2 = (radius / p) ** 2;
  const cosI = Math.cos(inc);
  const raanDot = -1.5 * n * j2 * rp2 * cosI;
  const argpDot = 0.75 * n * j2 * rp2 * (5 * cosI * cosI - 1);
  const meanMotion = n * (1 + 0.75 * j2 * rp2 * Math.sqrt(1 - e * e) * (3 * cosI * cosI - 1));
  return { raanDot, argpDot, meanMotion };
}

// 標識の時刻 t における中心天体相対状態(ECI 軸)。絶対 ECI 位置は基準天体の位置を足す。
export function referenceOrbitStateAt(
  orbit: ReferenceOrbit, t: number, env: ReferenceOrbitEnv,
): KinematicState | null {
  if (orbit.kind === 'elements') {
    const body = env.bodyById(orbit.bodyId);
    if (!body || !(orbit.a > 0) || !(orbit.e >= 0) || orbit.e >= 1) return null;
    const field = env.degree2Field(orbit.bodyId, t);
    const { raanDot, argpDot, meanMotion } = secularRates(
      orbit.a, orbit.e, orbit.i, body.def.mu,
      field?.j2 ?? 0, field?.refRadius ?? body.def.radius,
    );
    const dt = t - orbit.epoch;
    const nu = trueAnomaly(orbit.meanAnomaly0 + meanMotion * dt, orbit.e);
    const rel = stateFromOrbitalElements(
      t, orbit.a, orbit.e, orbit.i,
      orbit.raan + raanDot * dt, orbit.argPeriapsis + argpDot * dt,
      nu, body.def.mu,
    );
    const c = body.stateAt(t);
    return kinematicState<'eci'>(rel.t, addScaled(c.r, rel.r, 1), addScaled(c.v, rel.v, 1));
  }

  const member = env.familyMemberAt(orbit);
  const frame = env.rotatingFrameAt(orbit.primaryId, orbit.secondaryId, t);
  if (!member || !frame || !(member.period > 0)) return null;
  const frac = (((orbit.phase0 + t / member.period) % 1) + 1) % 1;
  const s = member.sample(frac);
  const { origin, xHat, yHat, zHat, unit, omega } = frame;
  // 回転座標の位置・速度を ECI へ。速度は基底の回転(ω×r)ぶんを加える。
  const local = addScaled(
    addScaled(scale(xHat, s[0] * unit), yHat, s[1] * unit), zHat, s[2] * unit,
  );
  const rotV = addScaled(
    addScaled(scale(xHat, s[3] * unit * omega), yHat, s[4] * unit * omega),
    zHat, s[5] * unit * omega,
  );
  // ω ベクトルは zHat 方向。ECI 速度 = 回転系速度の回転写像 + ω×位置。
  const spinV = scale(cross(zHat, local), omega);
  // 原点(重心)自体の速度は rotatingFrameAt 側が実天体の速度から組む — ここでは
  // 副天体公転運動に伴う原点移動を omega と unit で近似せず、呼び出し側が組んだ
  // 回転系が持つ origin の速度を返り値へ混ぜる責任は env 側が取り決める。
  // ここでは origin 速度を含めない(族標識の速度用途は描画とランデブー誘導の初値で、
  // 誤差は全力モデルの修正が吸収する)。
  return kinematicState<'eci'>(t, addScaled(origin, local, 1), addScaled(rotV, spinV, 1));
}

// 平均近点角 M [rad] → 真近点角 ν。elements.trueAnomalyFromMean と同じ式だが、
// OrbitalElements を組まずに済ませるためローカルに持つ。
function trueAnomaly(m: number, e: number): number {
  const M = Math.atan2(Math.sin(m), Math.cos(m));
  let E = e > 0.8 ? Math.PI * Math.sign(M || 1) : M;
  for (let i = 0; i < 50; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-14) break;
  }
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

// 標識の周期 [s]。elements は J2 補正済みの平均運動から、family はメンバー周期から。
// 求まらないときは null。
export function referenceOrbitPeriod(orbit: ReferenceOrbit, env: ReferenceOrbitEnv): number | null {
  if (orbit.kind === 'elements') {
    const body = env.bodyById(orbit.bodyId);
    if (!body || !(orbit.a > 0)) return null;
    const field = env.degree2Field(orbit.bodyId, 0);
    const { meanMotion } = secularRates(
      orbit.a, orbit.e, orbit.i, body.def.mu,
      field?.j2 ?? 0, field?.refRadius ?? body.def.radius,
    );
    return meanMotion > 0 ? (2 * Math.PI) / meanMotion : null;
  }
  const member = env.familyMemberAt(orbit);
  return member && member.period > 0 ? member.period : null;
}
