// 軌道標識の family 型が指す族メンバーと回転座標系の解決。カタログ族は焼き込み点列から、
// Richardson 族は halo.ts の解析解から、無次元回転座標([x,y,z,vx,vy,vz]、x は主天体→副天体、
// 位置は両天体間距離・速度はその距離×公転角速度で割った値)のメンバー関数を組む。
import {
  CATALOG_STRIDE, decodeCatalogPoints,
  type CatalogSystem, type CatalogSystemId,
} from '../../physics/orbit-catalog';
import { secondaryFrameOf, type SecondaryFrame } from '../../physics/lagrange';
import type { OrbitingCelestialBody } from '../../physics/celestial-body';
import { collinearFrame, haloState, lissajousState } from '../../physics/halo';
import { rotatingFrame as guideRotatingFrame } from '../../physics/orbit-guide';
import { cross, dot, len, sub, type Vec3 } from '../../math/vec3';
import type { ReferenceOrbitFamily } from '../../physics/reference-orbit';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { catalogSystemScale } from '../celestial/orbit-guide/orbit-guide-catalog';

const TAU = 2 * Math.PI;

export type RotatingSample = readonly [number, number, number, number, number, number];
export interface OrbitFamilyMember {
  readonly period: number; // メンバーの周期 [s]
  sample(phase: number): RotatingSample;
}

// カタログの読み込みを提供する側(OrbitGuideCatalog がこの形を満たす)。まだ手元に無い系は
// null で、その間 family 型の標識は状態を返さない。
export interface OrbitSlotCatalogAccess {
  systemFor(id: CatalogSystemId): CatalogSystem | null;
}

// 副天体が公転天体で、その主天体が primaryId と一致する SecondaryFrame を組む。
function slotSecondaryFrame(
  env: CelestialBodies, primaryId: string, secondaryId: string, t: number,
): SecondaryFrame | null {
  const secondary = env.findMotion(secondaryId);
  if (secondary === null || !('orbitFrameRotationAt' in secondary)) return null;
  const frame = secondaryFrameOf(
    env.celestialMotions, t, secondary as OrbitingCelestialBody, t,
  );
  if (frame === null || frame.primary.id !== primaryId) return null;
  return frame;
}

// 時刻 t の実天体位置で組んだ系の回転座標系(orbit-guide と同じ規則)とその角速度 [rad/s]。
export function slotRotatingFrameAt(
  env: CelestialBodies, primaryId: string, secondaryId: string, t: number,
): { origin: Vec3; xHat: Vec3; yHat: Vec3; zHat: Vec3; unit: number; omega: number } | null {
  const frame = slotSecondaryFrame(env, primaryId, secondaryId, t);
  if (frame === null) return null;
  const mu = frame.secondary.def.mu / (frame.primary.def.mu + frame.secondary.def.mu);
  const rotating = guideRotatingFrame(frame, mu);
  if (rotating === null) return null;
  const omega = len(frame.rotation.omega);
  return { ...rotating, omega };
}

// ECI 状態を無次元回転座標へ写す。v_rel = v − ω×r(centerManifoldState の逆写像)。
function toRotatingSample(
  r: Vec3, v: Vec3,
  frame: SecondaryFrame, rotating: NonNullable<ReturnType<typeof slotRotatingFrameAt>>,
): RotatingSample {
  const { origin, xHat, yHat, zHat, unit, omega } = rotating;
  const q = sub(r, origin);
  const vRel = sub(v, cross(frame.rotation.omega, r));
  const vScale = unit * omega;
  return [
    dot(q, xHat) / unit, dot(q, yHat) / unit, dot(q, zHat) / unit,
    dot(vRel, xHat) / vScale, dot(vRel, yHat) / vScale, dot(vRel, zHat) / vScale,
  ];
}

// Richardson 解析解の族メンバー。位相 p∈[0,1) は面内位相(0..2π)。
function analyticMember(
  frame: SecondaryFrame, orbit: ReferenceOrbitFamily, mu: number,
): OrbitFamilyMember | null {
  const d = orbit.familyDescriptor;
  if (d.kind === 'catalog') return null;
  const collinear = collinearFrame(frame, d.point);
  const n = len(frame.rotation.omega);
  if (!(collinear.lambda > 0) || !(n > 0)) return null;
  const rotating = guideRotatingFrame(frame, mu);
  if (rotating === null) return null;
  const env = { ...rotating, omega: n };
  return {
    period: TAU / (collinear.lambda * n),
    sample: (phase) => {
      const state = d.kind === 'halo'
        ? haloState(frame, { point: d.point, az: d.az, phase: TAU * phase })
        : lissajousState(frame, { point: d.point, ax: d.ax, az: d.az, phase: TAU * phase, psi: d.psi });
      return toRotatingSample(state.r, state.v, frame, env);
    },
  };
}

// 焼き込みカタログの族メンバー。点列は tFrac(0..1) を経過割合として持つので、
// 位相で挟む2点を線形補間する。族内位置 s は最も近い s のメンバーへ写像する。
function catalogMember(
  system: CatalogSystem, scaleTunit: number, orbit: ReferenceOrbitFamily,
): OrbitFamilyMember | null {
  const d = orbit.familyDescriptor;
  if (d.kind !== 'catalog') return null;
  const family = system.families[d.familyId];
  if (family === undefined || family.samples < 2) return null;
  const [first, ...rest] = family.members;
  if (first === undefined) return null;
  let best = first;
  for (const m of rest) if (Math.abs(m.s - d.s) < Math.abs(best.s - d.s)) best = m;
  const index = family.members.indexOf(best);
  const pts = decodeCatalogPoints(family.points);
  const base = index * family.samples * CATALOG_STRIDE;
  const count = family.samples;
  return {
    period: best.period * scaleTunit,
    sample: (phase) => {
      const p = ((phase % 1) + 1) % 1;
      // tFrac は 0..1 単調。末尾は先頭へ回り込む。
      let hi = 1;
      while (hi < count && (pts[base + hi * CATALOG_STRIDE + 3] ?? 1) < p) hi++;
      const i0 = hi >= count ? count - 1 : hi - 1;
      const i1 = hi >= count ? 0 : hi;
      const o0 = base + i0 * CATALOG_STRIDE;
      const o1 = base + i1 * CATALOG_STRIDE;
      const t0 = pts[o0 + 3] ?? 0;
      const t1 = (i1 === 0 ? 1 : (pts[o1 + 3] ?? 1));
      const span = Math.max(1e-9, (i1 === 0 ? 1 + (pts[o1 + 3] ?? 0) : t1) - t0);
      const f = Math.min(1, Math.max(0, (p - t0) / span));
      const lerp = (k: number) => {
        const a = pts[o0 + k] ?? 0;
        const b = pts[o1 + k] ?? 0;
        return a + (b - a) * f;
      };
      return [lerp(0), lerp(1), lerp(2), lerp(4), lerp(5), lerp(6)];
    },
  };
}

// 標識の family 型が指す族メンバー。系が組めない・族が無い・カタログ未取得なら null。
export function orbitSlotFamilyMember(
  orbit: ReferenceOrbitFamily, t: number,
  env: CelestialBodies, catalog: OrbitSlotCatalogAccess | null,
): OrbitFamilyMember | null {
  if (orbit.familyDescriptor.kind === 'catalog') {
    const systemId = `${orbit.primaryId}-${orbit.secondaryId}` as CatalogSystemId;
    const system = catalog?.systemFor(systemId) ?? null;
    const scale = catalogSystemScale(systemId);
    if (system === null || scale === null) return null;
    return catalogMember(system, scale.tunit, orbit);
  }
  const frame = slotSecondaryFrame(env, orbit.primaryId, orbit.secondaryId, t);
  if (frame === null) return null;
  const mu = frame.secondary.def.mu / (frame.primary.def.mu + frame.secondary.def.mu);
  return analyticMember(frame, orbit, mu);
}
