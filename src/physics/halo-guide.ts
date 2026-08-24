// マップのガイドとして描く、ラグランジュ点まわりの周期・準周期軌道の点列(ECI [m])。
// ハロー軌道と DRO は焼き込んだ族(src/assets/orbits/lagrange-orbits.json)を補間し、
// リヤプノフ軌道・リサジュー軌道は Richardson (1980) の解析近似から直に組む。
// どれもその瞬間の天体位置から組んだ回転基底へ載せた静的な線として返す。
import { Ephemeris } from './ephemeris';
import { primaryOf } from './solar-system';
import { OrbitingId } from './celestial-body';
import { resamplePolyline, Vec3Tuple } from './cr3bp';
import { CollinearFrame, collinearFrame, richardsonCoefficients, richardsonPoint } from './halo';
import { Vec3, add, scale } from './vec3';
import table from '../assets/orbits/lagrange-orbits.json';

export type GuideSystem = 'sun-earth' | 'earth-moon';
export type GuidePoint = 'L1' | 'L2' | 'L3';
export type Hemisphere = 'north' | 'south';

interface HaloMember {
  readonly s: number;
  readonly period: number;
  readonly jacobi: number;
  readonly points: readonly (readonly number[])[];
}

interface DroMember {
  readonly radius: number;
  readonly period: number;
  readonly jacobi: number;
  readonly points: readonly (readonly number[])[];
}

interface OrbitTable {
  readonly systems: Record<GuideSystem, {
    readonly halo: Partial<Record<GuidePoint, { readonly members: readonly HaloMember[] }>>;
    readonly dro: { readonly members: readonly DroMember[] };
  }>;
}

const ORBIT_TABLE = table as unknown as OrbitTable;

const SECONDARY_OF: Record<GuideSystem, OrbitingId> = { 'sun-earth': 'earth', 'earth-moon': 'moon' };

// 系の回転局所基底。レジストリに副天体か其の主天体が無ければ null。
function guideFrame(t: number, ephemeris: Ephemeris, system: GuideSystem, point: GuidePoint): CollinearFrame | null {
  const secondary = SECONDARY_OF[system];
  if (ephemeris.registry[secondary] === undefined) return null;
  if (primaryOf(ephemeris.registry, secondary) === null) return null;
  return collinearFrame(secondary, point, t, ephemeris);
}

// 配列要素の取り出し。範囲外は焼き込み表の破綻なので投げる。
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`halo-guide: 範囲外の要素参照 ${index}`);
  return item;
}

// 焼き込み表の点(面内の族は 2 要素)を3次元の位置にする。
function tuple(values: readonly number[]): Vec3Tuple {
  return [at(values, 0), at(values, 1), values.length > 2 ? at(values, 2) : 0];
}

// 回転基底上の無次元位置(長さの単位 unit [m]、原点 origin)を ECI [m] へ移す。
function toEci(frame: CollinearFrame, origin: Vec3, unit: number, local: Vec3Tuple): Vec3 {
  return add(origin, add(
    add(scale(frame.xHat, local[0] * unit), scale(frame.yHat, local[1] * unit)),
    scale(frame.zHat, local[2] * unit),
  ));
}

// 焼き込みの2メンバーを同じ添字の点どうしで混ぜる。
function blendMembers(a: readonly (readonly number[])[], b: readonly (readonly number[])[], f: number): Vec3Tuple[] {
  return a.map((point, i) => {
    const p = tuple(point);
    const q = tuple(at(b, i));
    return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1]), p[2] + f * (q[2] - p[2])] as Vec3Tuple;
  });
}

// キー key を持つ昇順の族から、key を挟む2メンバーと内分比を取る。範囲外は端で頭打ちにする。
function bracket<T>(members: readonly T[], keyOf: (member: T) => number, key: number): { lo: T; hi: T; f: number } {
  let i = 0;
  while (i < members.length - 2 && keyOf(at(members, i + 1)) < key) i++;
  const lo = at(members, i);
  const hi = at(members, Math.min(i + 1, members.length - 1));
  const span = keyOf(hi) - keyOf(lo);
  const f = span > 0 ? Math.min(1, Math.max(0, (key - keyOf(lo)) / span)) : 0;
  return { lo, hi, f };
}

// ハロー族の s∈[0,1] の位置にある軌道を、ECI [m] の閉じた点列として返す。
// s は 0=平面リヤプノフからの分岐直後、1=族末端(NRHO 側)で、範囲外は端で頭打ちになる。
// hemisphere は面外の突出が公転面法線側(north)かその逆(south)か。
export function haloGuideLoop(
  t: number, ephemeris: Ephemeris, system: GuideSystem, point: GuidePoint,
  s: number, hemisphere: Hemisphere, samples: number,
): Vec3[] | null {
  const family = ORBIT_TABLE.systems[system].halo[point];
  if (family === undefined || family.members.length === 0) return null;
  const frame = guideFrame(t, ephemeris, system, point);
  if (frame === null) return null;

  // s を挟む2メンバーを混ぜてから、求められた点数へ引き直す。
  const { lo, hi, f } = bracket(family.members, (member) => member.s, s);
  const blended = blendMembers(lo.points, hi.points, f);
  const sign = hemisphere === 'north' ? 1 : -1;
  const unit = frame.r * frame.gamma;
  return resamplePolyline(blended, samples, true)
    .map((p) => toEci(frame, frame.origin, unit, [p[0], p[1], sign * p[2]]));
}

// Richardson 三次近似の軌道を1周ぶん、ECI [m] の閉じた点列にする。
function richardsonLoop(frame: CollinearFrame, ax: number, az: number, samples: number): Vec3[] {
  const coefficients = richardsonCoefficients(frame);
  const unit = frame.r * frame.gamma;
  const points: Vec3[] = [];
  for (let i = 0; i < samples; i++) {
    const tau = (2 * Math.PI * i) / samples;
    points.push(toEci(frame, frame.origin, unit, richardsonPoint(coefficients, ax, az, true, tau)));
  }
  return points;
}

// 公転面内で閉じた平面リヤプノフ軌道。amplitude は面内(主天体→副天体方向)の振幅 [m]。
export function planarLyapunovLoop(
  t: number, ephemeris: Ephemeris, system: GuideSystem, point: GuidePoint,
  amplitude: number, samples: number,
): Vec3[] | null {
  const frame = guideFrame(t, ephemeris, system, point);
  if (frame === null) return null;
  return richardsonLoop(frame, amplitude / (frame.r * frame.gamma), 0, samples);
}

// 面外方向に8の字を描く垂直リヤプノフ軌道。amplitude は面外振幅 [m]。
export function verticalLyapunovLoop(
  t: number, ephemeris: Ephemeris, system: GuideSystem, point: GuidePoint,
  amplitude: number, samples: number,
): Vec3[] | null {
  const frame = guideFrame(t, ephemeris, system, point);
  if (frame === null) return null;
  return richardsonLoop(frame, 0, amplitude / (frame.r * frame.gamma), samples);
}

// 面内・面外の振幅を独立に取るリサジュー軌道の軌跡。閉じないので cycles 周ぶんの折れ線を返す。
// inPlane・outOfPlane はメートル。
export function lissajousPath(
  t: number, ephemeris: Ephemeris, system: GuideSystem, point: GuidePoint,
  inPlane: number, outOfPlane: number, cycles: number, samples: number,
): Vec3[] | null {
  const frame = guideFrame(t, ephemeris, system, point);
  if (frame === null) return null;
  // 面内は振動数 λ、面外は ωz で振動するので、面内が cycles 周する間に面外は比 ωz/λ 周する。
  const ratio = frame.omegaZ / frame.lambda;
  const points: Vec3[] = [];
  for (let i = 0; i < samples; i++) {
    const phase = (2 * Math.PI * cycles * i) / (samples - 1);
    const local: Vec3Tuple = [
      -Math.cos(phase) * inPlane,
      frame.kappa * Math.sin(phase) * inPlane,
      Math.sin(ratio * phase) * outOfPlane,
    ];
    points.push(toEci(frame, frame.origin, 1, local));
  }
  return points;
}

// 副天体を回転系で逆行に周回する平面周期軌道(DRO)。radius は副天体からの軌道半径 [m] で、
// 焼き込んだ族の範囲外は端で頭打ちになる。
export function droLoop(
  t: number, ephemeris: Ephemeris, system: GuideSystem, radius: number, samples: number,
): Vec3[] | null {
  const members = ORBIT_TABLE.systems[system].dro.members;
  if (members.length === 0) return null;
  const frame = guideFrame(t, ephemeris, system, 'L1');
  if (frame === null) return null;

  // 半径が桁で変わる族なので、対数で内分する。
  const { lo, hi, f } = bracket(members, (member) => Math.log(member.radius), Math.log(radius / frame.r));
  const blended = blendMembers(lo.points, hi.points, f);
  const secondary = ephemeris.positionOf(SECONDARY_OF[system], t);
  return resamplePolyline(blended, samples, true).map((p) => toEci(frame, secondary, frame.r, p));
}
