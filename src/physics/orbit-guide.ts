// マップのガイドとして描く軌道の点列(ECI [m])。焼き込みカタログ(orbit-catalog.ts)の
// 無次元形状を、その瞬間の実際の天体位置・公転面から組んだ回転座標系へ載せて返す。
// リサジュー軌道だけは連続な族として焼き込まないので、Richardson の解析近似から直に組む。
import { Ephemeris } from './ephemeris';
import { primaryOf } from './solar-system';
import { OrbitingId } from './celestial-body';
import { Vec3Tuple } from './cr3bp';
import { CollinearFrame, collinearFrame } from './halo';
import {
  CATALOG_STRIDE, CatalogFamily, CatalogSystem, CatalogSystemId, decodeCatalogPoints,
} from './orbit-catalog';
import { Vec3, add, cross, len, norm, scale, sub, v3 } from './vec3';

export type GuidePoint = 'L1' | 'L2' | 'L3';

// 軌道1本ぶんのガイド線。点列は ECI [m]、times は各点の「周期に対する経過時刻の割合」で、
// 進行方向マーカーを実際の軌道速度に比例して動かすのに使う。
export interface GuideLoop {
  readonly points: readonly Vec3[];
  readonly times: readonly number[];
  readonly closed: boolean;
  // 焼き込みメンバーの諸元(リサジューのように族を持たない軌道では undefined)。
  readonly period?: number;
  readonly jacobi?: number;
  readonly stability?: number;
}

// 系を構成する主天体・副天体。カタログの系 id とゲームのレジストリを繋ぐ唯一の対応表。
const SYSTEM_BODIES: Readonly<Record<CatalogSystemId, readonly [OrbitingId | 'sun', OrbitingId]>> = {
  'earth-moon': ['earth', 'moon'],
  'sun-earth': ['sun', 'earth'],
  'sun-mars': ['sun', 'mars'],
  'jupiter-europa': ['jupiter', 'europa'],
  'saturn-titan': ['saturn', 'titan'],
  'saturn-enceladus': ['saturn', 'enceladus'],
  'mars-phobos': ['mars', 'phobos'],
};

// 系の副天体 id。レジストリに無ければ null。
export function guideSecondary(system: CatalogSystemId): OrbitingId {
  return SYSTEM_BODIES[system][1];
}

// CR3BP の無次元回転系から ECI [m] への写像。origin は重心の ECI 位置、xHat は主天体→副天体、
// zHat は公転面法線、unit は両天体間距離 [m]。
interface RotatingFrame {
  readonly origin: Vec3;
  readonly xHat: Vec3;
  readonly yHat: Vec3;
  readonly zHat: Vec3;
  readonly unit: number;
}

// その瞬間の天体位置から系の回転基底を組む。レジストリに天体が無ければ null。
// 焼き込みは重心原点なので、原点も重心へ置く(質量比はカタログが持つ値を使う)。
export function rotatingFrame(t: number, ephemeris: Ephemeris, system: CatalogSystemId, mu: number): RotatingFrame | null {
  const [primary, secondary] = SYSTEM_BODIES[system];
  if (ephemeris.registry[secondary] === undefined) return null;
  if (ephemeris.registry[primary] === undefined) return null;
  if (primaryOf(ephemeris.registry, secondary) === null) return null;

  const primaryPos = ephemeris.positionOf(primary, t);
  const secondaryPos = ephemeris.positionOf(secondary, t);
  const rVec = sub(secondaryPos, primaryPos);
  const unit = len(rVec);
  if (!(unit > 0)) return null;

  const xHat = scale(rVec, 1 / unit);
  const zHat = norm(ephemeris.orbitNormalAt(secondary, t));
  const yHat = norm(cross(zHat, xHat));
  // 重心は主天体から副天体へ向かって mu の位置にある。
  const origin = add(primaryPos, scale(xHat, mu * unit));
  return { origin, xHat, yHat, zHat, unit };
}

// 無次元の回転系座標を ECI [m] へ移す。
function toEci(frame: RotatingFrame, local: Vec3Tuple): Vec3 {
  const { origin, xHat, yHat, zHat, unit } = frame;
  return add(origin, add(
    add(scale(xHat, local[0] * unit), scale(yHat, local[1] * unit)),
    scale(zHat, local[2] * unit),
  ));
}

// 族の s∈[0,1] を挟む2メンバーの添字と内分比。範囲外は端で頭打ちにする。
function bracketMember(family: CatalogFamily, s: number): { lo: number; hi: number; f: number } {
  const members = family.members;
  const last = members.length - 1;
  if (last <= 0) return { lo: 0, hi: 0, f: 0 };
  let i = 0;
  while (i < last - 1 && (members[i + 1]?.s ?? 1) < s) i++;
  const sLo = members[i]?.s ?? 0;
  const sHi = members[i + 1]?.s ?? 1;
  const span = sHi - sLo;
  return { lo: i, hi: i + 1, f: span > 0 ? Math.min(1, Math.max(0, (s - sLo) / span)) : 0 };
}

// 族の s の位置にある軌道を、ECI [m] のガイド線として返す。s は 0 が族の始端、1 が終端で、
// 範囲外は端で頭打ちになる。系や族がカタログに無い、あるいはレジストリに天体が無ければ null。
export function catalogLoop(
  t: number, ephemeris: Ephemeris, catalog: CatalogSystem, system: CatalogSystemId,
  familyId: string, s: number,
): GuideLoop | null {
  const family = catalog.families[familyId];
  if (family === undefined || family.members.length === 0) return null;
  const frame = rotatingFrame(t, ephemeris, system, catalog.mu);
  if (frame === null) return null;

  const values = decodeCatalogPoints(family.points);
  const { lo, hi, f } = bracketMember(family, s);
  const samples = family.samples;
  const base = lo * samples * CATALOG_STRIDE;
  const other = hi * samples * CATALOG_STRIDE;

  // 隣り合う2メンバーを同じ添字の点どうしで混ぜてから ECI へ移す。
  const points: Vec3[] = [];
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const a = base + i * CATALOG_STRIDE;
    const b = other + i * CATALOG_STRIDE;
    const local: Vec3Tuple = [
      mix(values, a, b, 0, f),
      mix(values, a, b, 1, f),
      mix(values, a, b, 2, f),
    ];
    points.push(toEci(frame, local));
    times.push(mix(values, a, b, 3, f));
  }

  const memberLo = family.members[lo];
  const memberHi = family.members[hi];
  return {
    points,
    times,
    closed: true,
    period: lerp(memberLo?.period ?? 0, memberHi?.period ?? 0, f),
    jacobi: lerp(memberLo?.jacobi ?? 0, memberHi?.jacobi ?? 0, f),
    stability: lerp(memberLo?.stability ?? 1, memberHi?.stability ?? 1, f),
  };
}

function mix(values: Float32Array, a: number, b: number, offset: number, f: number): number {
  const va = values[a + offset] ?? 0;
  const vb = values[b + offset] ?? 0;
  return va + f * (vb - va);
}

function lerp(a: number, b: number, f: number): number {
  return a + f * (b - a);
}

// リサジュー軌道の軌跡。面内・面外の振幅と位相を独立に取り、cycles 周ぶんの開いた折れ線を返す。
// 面内は振動数 λ、面外は ωz で振動するので、両者が噛み合わず閉じない。
export function lissajousLoop(
  t: number, ephemeris: Ephemeris, system: CatalogSystemId, point: GuidePoint,
  inPlane: number, outOfPlane: number, inPlanePhase: number, outOfPlanePhase: number,
  cycles: number, samples: number,
): GuideLoop | null {
  const secondary = SYSTEM_BODIES[system][1];
  if (ephemeris.registry[secondary] === undefined) return null;
  if (primaryOf(ephemeris.registry, secondary) === null) return null;
  const frame: CollinearFrame = collinearFrame(secondary, point, t, ephemeris);

  const ratio = frame.omegaZ / frame.lambda;
  const points: Vec3[] = [];
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    const phase = 2 * Math.PI * cycles * u;
    const local: Vec3Tuple = [
      -Math.cos(phase + inPlanePhase) * inPlane,
      frame.kappa * Math.sin(phase + inPlanePhase) * inPlane,
      Math.sin(ratio * phase + outOfPlanePhase) * outOfPlane,
    ];
    points.push(add(frame.origin, add(
      add(scale(frame.xHat, local[0]), scale(frame.yHat, local[1])),
      scale(frame.zHat, local[2]),
    )));
    times.push(u);
  }
  return { points, times, closed: false };
}

// 静止軌道のリング。地球の赤道面上・恒星日周期の高度を通る円を ECI [m] で返す。
export function geostationaryLoop(center: Vec3, radius: number, samples: number): GuideLoop {
  const points: Vec3[] = [];
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const u = i / samples;
    const a = 2 * Math.PI * u;
    points.push(add(center, v3(radius * Math.cos(a), 0, -radius * Math.sin(a))));
    times.push(u);
  }
  return { points, times, closed: true };
}
