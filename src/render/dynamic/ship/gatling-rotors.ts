// 機関砲の回転砲身束を、射撃レートに追従する角速度で表示時刻に沿って回す。
import * as THREE from 'three/webgpu';
import type { ModularShipView } from './modular-ship-view';
import type { ShipModuleRenderInput } from './ship-render-contract';

// 撃ち始めに目標角速度へ近づく一次遅れの時定数 [s]。
const SPIN_UP_TIME_CONSTANT = 0.15;
// トリガーを離してから止まるまでの一次遅れの時定数 [s]。
const SPIN_DOWN_TIME_CONSTANT = 0.8;
// 1回の同期で進める表示時刻の上限 [s]。時刻の跳躍で砲身が回らないようにする。
const MAX_STEP = 0.1;
const TWO_PI = 2 * Math.PI;
const SPIN_AXIS = new THREE.Vector3(0, 0, 1);

// 1つの砲身束の回転状態。
interface RotorSpin {
  // 局所 +Z 回りの角速度 [rad/s]。
  angularSpeed: number;
  // 局所 +Z 回りの回転角 [rad]、0..2π。
  phase: number;
}

// 1隻ぶんの回転砲身束 anchor(`barrel-rotor:<k>`)の角速度と回転角を持ち、毎フレーム anchor の姿勢へ書く。
export class GatlingRotors {
  private readonly spins = new Map<THREE.Object3D, RotorSpin>();
  private lastDisplayTime: number | null = null;

  // 健全な武装モジュールの砲身束を、全砲口の合計射撃レート gunFireRate [rounds/s] を等分した
  // 速さへ追従させ、displayTime [s] の前進ぶん回す。消えた・壊れた砲身束の状態は捨てる。
  public sync(
    ship: ModularShipView, modules: readonly ShipModuleRenderInput[], gunFireRate: number, displayTime: number,
  ): void {
    const rotors = healthyRotors(ship, modules);
    const dt = this.lastDisplayTime === null ? 0 : Math.min(MAX_STEP, Math.max(0, displayTime - this.lastDisplayTime));
    this.lastDisplayTime = displayTime;
    const roundsPerRotor = rotors.length > 0 ? gunFireRate / rotors.length : 0;
    // 作り直し・撤去・破壊で外れた砲身束の状態を捨てる。
    const live = new Set(rotors);
    for (const anchor of this.spins.keys()) {
      if (!live.has(anchor)) this.spins.delete(anchor);
    }
    for (const anchor of rotors) {
      const spin = this.spins.get(anchor) ?? { angularSpeed: 0, phase: phaseOf(anchor) };
      this.spins.set(anchor, spin);
      // 1発ごとに砲身が1本ぶん回る。
      const target = TWO_PI * roundsPerRotor / barrelCountOf(anchor);
      advance(spin, target, dt);
      anchor.quaternion.setFromAxisAngle(SPIN_AXIS, spin.phase);
    }
  }
}

// hp が残る武装モジュールが持つ砲身束 anchor の一覧。
function healthyRotors(ship: ModularShipView, modules: readonly ShipModuleRenderInput[]): THREE.Object3D[] {
  const rotors: THREE.Object3D[] = [];
  for (const module of modules) {
    if (module.kind !== 'weapon' || module.hp <= 0) continue;
    rotors.push(...ship.semanticAnchors(module.id, 'barrel-rotor:'));
  }
  return rotors;
}

// 角速度を目標 target [rad/s] へ一次遅れで dt [s] だけ近づけ、その間の回転を回転角へ積む。
function advance(spin: RotorSpin, target: number, dt: number): void {
  const timeConstant = target > spin.angularSpeed ? SPIN_UP_TIME_CONSTANT : SPIN_DOWN_TIME_CONSTANT;
  const previous = spin.angularSpeed;
  spin.angularSpeed = target + (previous - target) * Math.exp(-dt / timeConstant);
  const phase = (spin.phase + 0.5 * (previous + spin.angularSpeed) * dt) % TWO_PI;
  spin.phase = phase < 0 ? phase + TWO_PI : phase;
}

// anchor の現在の姿勢を局所 +Z 回りの回転角 [rad] として読む。作り直された状態が姿勢を跳ばさないようにする。
function phaseOf(anchor: THREE.Object3D): number {
  const q = anchor.quaternion;
  return 2 * Math.atan2(q.z, q.w);
}

// anchor が宣言する砲身の本数。正の整数でなければアセットの不備として投げる。
function barrelCountOf(anchor: THREE.Object3D): number {
  const count: unknown = anchor.userData.barrelCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
    throw new Error(`barrel rotor has no positive barrelCount: ${anchor.name}`);
  }
  return count;
}
