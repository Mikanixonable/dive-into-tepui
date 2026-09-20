// 計画ノードの値を解釈・再構築する純粋な編集モデル。DOM、入力、命令キューを持たず、
// PlanEditor とテストから同じ Δv 規則を使えるようにする。
import { atmosphericDensity, ellipsoidAltitude } from '../../physics/atmosphere';
import { strongestAttractor } from '../../physics/attractor';
import { frameOfCelestialBody, toFrameState } from '../../physics/frame';
import type { OrbitalElements } from '../../physics/elements';
import { positionOnOrbit } from '../../physics/elements';
import { fromOrbitAxes, kinematicState, orbitAxes } from '../../physics/kinematic-state';
import type { KinematicState } from '../../physics/kinematic-state';
import { add, dot, len, sub, type Vec3, v3 } from '../../math/vec3';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { Plan } from './plan';

const PE_WARN_DENSITY = 2.4e-8; // 噴射後の軌道の近点がこの大気密度に達したら警告する [kg/m^3]

// i 番目のノードの Δv(噴射後速度 − 到達時点速度)を ECI で返す。
export function nodeDeltaV(
  plan: Plan, i: number, arriving: readonly (KinematicState | null)[],
): Vec3 | null {
  const node = plan.nodes[i];
  const arr = arriving[i];
  return node && arr ? sub(node.v, arr.v) : null;
}

// i 番目のノードの Δv の大きさ [m/s]。到着状態が求まるまでは 0 と表示する。
export function nodeDeltaVMag(
  plan: Plan, i: number, arriving: readonly (KinematicState | null)[],
): number {
  const dv = nodeDeltaV(plan, i, arriving);
  return dv === null ? 0 : len(dv);
}

// 軌道要素と Δv 方向を解釈するための中心天体相対状態。中心はその位置で最も強く引く天体。
export function bodyStateFor(
  state: KinematicState, celestialBodies: CelestialBodies,
): KinematicState {
  const center = strongestAttractor(
    state.r, celestialBodies.celestialMotions, state.t,
  );
  const rel = toFrameState(frameOfCelestialBody(center, state.t), state);
  return kinematicState<'eci'>(state.t, rel.r, rel.v);
}

// i 番目のノードの Δv を、到着状態の軌道基準枠(PRO/NRM/RAD)成分へ分解する。
export function nodeDeltaVLocal(
  plan: Plan, i: number, arriving: readonly (KinematicState | null)[],
  celestialBodies: CelestialBodies,
): Vec3 | null {
  const arr = arriving[i];
  const dvWorld = nodeDeltaV(plan, i, arriving);
  if (!arr || dvWorld === null) return null;
  const axes = orbitAxes(bodyStateFor(arr, celestialBodies));
  return v3(dot(dvWorld, axes.pro), dot(dvWorld, axes.nrm), dot(dvWorld, axes.radOut));
}

// ノードを区間 arcIdx 上の sample へ移した新しい状態。到着軌道のローカル Δv を保つ。
export function rebuildDraggedNode(
  plan: Plan, sample: KinematicState, arcIdx: number, idx: number,
  arriving: readonly (KinematicState | null)[], celestialBodies: CelestialBodies,
): KinematicState | null {
  const dvLocal = nodeDeltaVLocal(plan, idx, arriving, celestialBodies);
  if (dvLocal === null) return null;

  // サンプル速度は通過したノードの Δv を全部含む — 自ノードぶんだけ引くと中間ノードの Δv が残る。
  let baseV: Vec3 = sample.v;
  for (let i = idx; i < arcIdx; i++) {
    const passed = plan.nodes[i];
    const passedArr = arriving[i];
    if (!passed || !passedArr) return null;
    baseV = sub(baseV, sub(passed.v, passedArr.v));
  }

  // 到着軌道基準のローカル Δv 成分を、移動先のプレバーン状態基準へ組み直す。
  const newPreBurnState = kinematicState<'eci'>(sample.t, sample.r, baseV);
  const newDvWorld = fromOrbitAxes(bodyStateFor(newPreBurnState, celestialBodies), dvLocal);
  return kinematicState<'eci'>(sample.t, sample.r, add(baseV, newDvWorld));
}

// 噴射後の軌道 el の近点が、中心天体の大気の中にあるか。大気の高度は基準楕円体から測る。
export function periapsisInAtmosphere(el: OrbitalElements, t: number): boolean {
  const atmosphere = el.center.atmosphereAt(t);
  if (atmosphere === null) return false;
  return atmosphericDensity(
    ellipsoidAltitude(positionOnOrbit(el, 0), atmosphere), atmosphere,
  ) >= PE_WARN_DENSITY;
}
