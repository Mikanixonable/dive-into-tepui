// マップのガイドとして描く軌道の曲線(ECI [m])。焼き込みカタログ(orbit-catalog.ts)の
// 無次元形状を、その瞬間の実際の天体位置・公転面から組んだ回転座標系へ載せて返す。
// リサジュー軌道だけは連続な族として焼き込まないので、Richardson の解析近似から直に組む。
import type { CelestialMotion } from './celestial-motion';

import { Vec3Tuple } from './cr3bp';
import { CollinearFrame, collinearFrame, richardsonCoefficients, richardsonState } from './halo';
import type { CollinearPoint, SecondaryFrame } from './lagrange';
import {
  CATALOG_STRIDE, CatalogFamily, CatalogSystem, CatalogSystemId, decodeCatalogPoints,
} from './orbit-catalog';
import {
  LocalTime, dawnDuskElements, molniyaElements, sunSyncRepeatGroundTrackElements, tundraElements,
} from './earth-reference-orbits';
import { OrbitalElements, positionOnOrbit, trueAnomalyFromMean } from './elements';
import { Vec3, add, cross, len, norm, scale, sub } from '../math/vec3';

// ガイド線の曲線の渡し方。閉じた式で書けるものは関数、焼き込みの離散サンプルしか無いものは
// 節点列で渡す。どちらもパラメータ u は「周期に対する経過時刻の割合」で、進行方向マーカーが
// 実際の軌道速度に比例して動く。
export type GuideShape =
  | { readonly kind: 'analytic'; readonly positionAt: (u: number) => Vec3 }
  | {
    readonly kind: 'knots';
    // 節点のパラメータ(昇順、先頭 0・末尾 1)と、同じ添字の位置・d(位置)/du。
    readonly us: readonly number[];
    readonly positions: readonly Vec3[];
    readonly tangents: readonly Vec3[];
  };

// 軌道1本ぶんのガイド線。位置は ECI [m]。
export interface GuideLoop {
  readonly shape: GuideShape;
  // u∈[0,1] の間に軌道を回る周回数。閉じた1周の軌道は 1、リサジューは指定した周回数。
  readonly revolutions: number;
  // 焼き込みメンバーの安定性指数(リサジューのように族を持たない軌道では undefined)。
  readonly stability?: number;
}

// 系を構成する主天体・副天体。カタログの系 id とゲームのレジストリを繋ぐ唯一の対応表。
const SYSTEM_BODIES: Readonly<Record<CatalogSystemId, readonly [string, string]>> = {
  'earth-moon': ['earth', 'moon'],
  'sun-earth': ['sun', 'earth'],
  'sun-mars': ['sun', 'mars'],
  'jupiter-europa': ['jupiter', 'europa'],
  'saturn-titan': ['saturn', 'titan'],
  'saturn-enceladus': ['saturn', 'enceladus'],
  'mars-phobos': ['mars', 'phobos'],
};

// 系の副天体 id。
export function guideSecondary(system: CatalogSystemId): string {
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

// その瞬間の天体位置から系の回転基底を組む。副天体の解決(guideSecondary の id を星系から
// 引くこと)は呼び出し側の仕事で、主星を持たない副天体では null。
// 焼き込みは重心原点なので、原点も重心へ置く(質量比はカタログが持つ値を使う)。
export function rotatingFrame(system: SecondaryFrame, mu: number): RotatingFrame | null {
  const primaryPos = system.primaryState.r;
  const secondaryPos = system.secondaryState.r;
  const rVec = sub(secondaryPos, primaryPos);
  const unit = len(rVec);
  if (!(unit > 0)) return null;

  const xHat = scale(rVec, 1 / unit);
  const zHat = norm(system.normal);
  const yHat = norm(cross(zHat, xHat));
  // 重心は主天体から副天体へ向かって mu の位置にある。
  const origin = add(primaryPos, scale(xHat, mu * unit));
  return { origin, xHat, yHat, zHat, unit };
}

// 無次元の回転系座標を ECI [m] へ移す。
function toEci(frame: RotatingFrame, local: Vec3Tuple): Vec3 {
  return add(frame.origin, rotateToEci(frame, local));
}

// 無次元回転系のベクトルを ECI [m] のベクトルへ写す(原点の平行移動を伴わない、速度や
// 接線のための変換)。
function rotateToEci(frame: RotatingFrame, local: Vec3Tuple): Vec3 {
  const { xHat, yHat, zHat, unit } = frame;
  return add(
    add(scale(xHat, local[0] * unit), scale(yHat, local[1] * unit)),
    scale(zHat, local[2] * unit),
  );
}

// デコード済みの点列。族ごとに base64 を毎回ほどくと、1本引くたびに族まるごとのバイト列を
// 走査することになる(1族=数十万バイト)。族の中身は焼き込みなので変わらない。
const decodedPoints = new WeakMap<CatalogFamily, Float32Array>();

function familyPoints(family: CatalogFamily): Float32Array {
  const cached = decodedPoints.get(family);
  if (cached !== undefined) return cached;
  const values = decodeCatalogPoints(family.points);
  decodedPoints.set(family, values);
  return values;
}

// 族の s∈[0,1] を挟む2メンバーの添字と内分比。範囲外は端で頭打ちにする。
function bracketMember(family: CatalogFamily, s: number): { lo: number; hi: number; f: number } {
  const members = family.members;
  const last = members.length - 1;
  if (last <= 0) return { lo: 0, hi: 0, f: 0 };
  const target = Math.min(1, Math.max(0, s));
  let i = 0;
  while (i < last - 1 && (members[i + 1]?.s ?? 0) < target) i++;
  const lo = members[i]?.s ?? 0;
  const hi = members[i + 1]?.s ?? 0;
  const span = hi - lo;
  return { lo: i, hi: i + 1, f: span > 0 ? Math.min(1, Math.max(0, (target - lo) / span)) : 0 };
}

// 族の s の位置にある軌道を、ECI [m] のガイド線として返す。s は 0 が族の始端、1 が終端で、
// 範囲外は端で頭打ちになる。系や族がカタログに無い、あるいはレジストリに天体が無ければ null。
export function catalogLoop(
  system: SecondaryFrame, catalog: CatalogSystem, familyId: string, s: number,
): GuideLoop | null {
  const family = catalog.families[familyId];
  if (family === undefined || family.members.length === 0) return null;
  const frame = rotatingFrame(system, catalog.mu);
  if (frame === null) return null;

  const values = familyPoints(family);
  const { lo, hi, f } = bracketMember(family, s);
  const samples = family.samples;
  const base = lo * samples * CATALOG_STRIDE;
  const other = hi * samples * CATALOG_STRIDE;

  // 隣り合う2メンバーを同じ添字の点どうしで混ぜてから ECI へ移す。閉じた輪なので、
  // 末尾に始点を u=1 として足し、節点列が u∈[0,1] を覆うようにする。速度は無次元時間に
  // 対する値なので、パラメータ(周期に対する割合)の接線にするには周期を掛ける。
  const points: Vec3[] = [];
  const us: number[] = [];
  const tangents: Vec3[] = [];
  const period = lerp(family.members[lo]?.period ?? 0, family.members[hi]?.period ?? 0, f);
  for (let i = 0; i < samples; i++) {
    const a = base + i * CATALOG_STRIDE;
    const b = other + i * CATALOG_STRIDE;
    const local: Vec3Tuple = [
      mix(values, a, b, 0, f),
      mix(values, a, b, 1, f),
      mix(values, a, b, 2, f),
    ];
    const velocity: Vec3Tuple = [
      mix(values, a, b, 4, f) * period,
      mix(values, a, b, 5, f) * period,
      mix(values, a, b, 6, f) * period,
    ];
    points.push(toEci(frame, local));
    // 速度は原点の平行移動を受けないので、回転基底だけで写す。
    tangents.push(rotateToEci(frame, velocity));
    us.push(mix(values, a, b, 3, f));
  }
  points.push(points[0]!);
  tangents.push(tangents[0]!);
  us.push(1);

  return {
    shape: { kind: 'knots', us, positions: points, tangents },
    revolutions: 1,
    stability: lerp(family.members[lo]?.stability ?? 1, family.members[hi]?.stability ?? 1, f),
  };
}

// 2メンバーの同じ添字・同じ成分を内分する。
function mix(values: Float32Array, a: number, b: number, offset: number, f: number): number {
  const va = values[a + offset] ?? 0;
  const vb = values[b + offset] ?? 0;
  return va + f * (vb - va);
}

function lerp(a: number, b: number, f: number): number {
  return a + f * (b - a);
}

// リサジュー軌道の軌跡。面内・面外の振幅と位相を独立に取り、cycles 周ぶんの開いた曲線を返す。
// 面内は振動数 λ、面外は ωz で振動し両者が噛み合わないので閉じない。形状には Richardson
// (1980) の三次近似(halo.ts の richardsonState)を使い、振幅による軌道面の歪みを反映する。
// inPlane/outOfPlane は無次元(L点局所γ単位 frame.r*frame.gamma に対する比)。系ごとに
// R*gamma が数桁違うため、メートルではなく比で受け取ることでどの系でも同じ値が Richardson
// 近似の妥当域(目安 0〜0.5)に収まる。
export function lissajousLoop(
  system: SecondaryFrame, point: CollinearPoint,
  inPlane: number, outOfPlane: number, inPlanePhase: number, outOfPlanePhase: number,
  cycles: number,
): GuideLoop | null {
  // 振幅に依らない係数は1度だけ求め、位相だけを u から動かす。
  const frame: CollinearFrame = collinearFrame(system, point);
  const coeffs = richardsonCoefficients(frame);
  const deltaN = point === 'L2' ? -1 : 1;
  const unit = frame.r * frame.gamma;
  const axHat = inPlane;
  const azHat = outOfPlane;
  const zRatio = frame.omegaZ / frame.lambda;
  const omegaCorrection = 1 + coeffs.s1 * axHat * axHat + coeffs.s2 * azHat * azHat;

  // u∈[0,1] を cycles 周ぶんの位相へ写し、局所γ単位の Richardson 解を ECI [m] へ戻す。
  const positionAt = (u: number): Vec3 => {
    const phase = 2 * Math.PI * cycles * u;
    const theta1 = omegaCorrection * (phase + inPlanePhase);
    const psiZ = omegaCorrection * (zRatio * phase + outOfPlanePhase);
    const { x, y, z } = richardsonState(coeffs, frame.kappa, deltaN, axHat, azHat, theta1, 1, psiZ, 1);
    return add(frame.origin, add(
      add(scale(frame.xHat, x * unit), scale(frame.yHat, y * unit)),
      scale(frame.zHat, z * unit),
    ));
  };
  return { shape: { kind: 'analytic', positionAt }, revolutions: cycles };
}

// 地球専用の参照軌道(軌道ガイドタブ「基本」群、静止軌道を除く4種類)。パラメータは
// 平均近点角(=経過時間)なので、進行方向マーカーが実際の軌道速度どおり近点で速く・
// 遠点で遅く動く。
function elementsLoop(elements: OrbitalElements | null, centerEci: Vec3): GuideLoop | null {
  if (elements === null) return null;
  const positionAt = (u: number): Vec3 => add(
    centerEci, positionOnOrbit(elements, trueAnomalyFromMean(u * 2 * Math.PI, elements.e)),
  );
  return { shape: { kind: 'analytic', positionAt }, revolutions: 1 };
}

// 太陽同期準回帰軌道のガイド線。earth は地球の運動(星系に居るかの判定は呼び出し側)。
export function sunSyncRepeatGroundTrackLoop(
  earth: CelestialMotion, earthPivot: number, repeatDays: number, revsPerRepeat: number,
): GuideLoop | null {
  return elementsLoop(
    sunSyncRepeatGroundTrackElements(repeatDays, revsPerRepeat, earth, earthPivot),
    earth.positionAt(earthPivot));
}

// 太陽方向の昇交点赤経(elements.ts の orbitPlaneBasis の規約: raan=0 で昇交点は +X 方向、
// raan を Y 軸まわりに正転すると昇交点は -Z 側へ回る)を、その瞬間の太陽方向から逆算する。
export function dawnDuskGuideLoop(
  earth: CelestialMotion, earthPivot: number, sunDirFrom: (r: Vec3, t: number) => Vec3,
  repeatDays: number, revsPerRepeat: number, localTime: LocalTime,
): GuideLoop | null {
  const earthPos = earth.positionAt(earthPivot);
  const sunDir = sunDirFrom(earthPos, earthPivot);
  const sunRaanDeg = (Math.atan2(-sunDir.z, sunDir.x) * 180) / Math.PI;
  return elementsLoop(
    dawnDuskElements(repeatDays, revsPerRepeat, localTime, sunRaanDeg, earth, earthPivot), earthPos);
}

// 自転周期に共鳴する参照軌道(モルニヤ・ツンドラ)の共通部。自転モデルを持たない天体では
// 共鳴の基準が無いので線を引かない。
function spinResonantLoop(
  earth: CelestialMotion, earthPivot: number, spinRate: number | null,
  elementsOf: (planet: CelestialMotion, spinPeriod: number) => OrbitalElements,
): GuideLoop | null {
  if (spinRate === null || spinRate === 0) return null;
  return elementsLoop(
    elementsOf(earth, Math.abs((2 * Math.PI) / spinRate)), earth.positionAt(earthPivot));
}

// モルニヤ軌道のガイド線。earth は地球の運動(星系に居るかの判定は呼び出し側)。
export function molniyaGuideLoop(
  earth: CelestialMotion, earthPivot: number, spinRate: number | null, perigeeAltitude: number, raanDeg: number,
): GuideLoop | null {
  return spinResonantLoop(
    earth, earthPivot, spinRate,
    (p, spin) => molniyaElements(perigeeAltitude, raanDeg, p, earthPivot, spin));
}

// ツンドラ軌道のガイド線。earth は地球の運動(星系に居るかの判定は呼び出し側)。
export function tundraGuideLoop(
  earth: CelestialMotion, earthPivot: number, spinRate: number | null, perigeeAltitude: number, raanDeg: number,
): GuideLoop | null {
  return spinResonantLoop(
    earth, earthPivot, spinRate,
    (p, spin) => tundraElements(perigeeAltitude, raanDeg, p, earthPivot, spin));
}
