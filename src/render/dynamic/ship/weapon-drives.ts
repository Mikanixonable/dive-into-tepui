// 機関砲の被駆動部(回転砲身束・給弾スプロケット・デリンクドラム)を、射撃レートに追従する
// 角速度で表示時刻に沿って回す。
import * as THREE from 'three/webgpu';
import type { ModularShipView } from './modular-ship-view';
import type { ShipModuleRenderInput } from './ship-render-contract';

// 撃ち始めに目標角速度へ近づく一次遅れの時定数 [s]。
const SPIN_UP_TIME_CONSTANT = 0.15;
// トリガーを離してから止まるまでの一次遅れの時定数 [s]。
const SPIN_DOWN_TIME_CONSTANT = 0.8;
// 1回の同期で進める表示時刻の上限 [s]。時刻の跳躍で駆動部が回らないようにする。
const MAX_STEP = 0.1;
const TWO_PI = 2 * Math.PI;
const SPIN_AXIS = new THREE.Vector3(0, 0, 1);
const SPIN_QUAT = new THREE.Quaternion();

// 送り車の半径 [m](build-ship-modules.py の給弾塔)。ベルト1リンクぶんの装弾
// MAG_ROUNDS(game/player/ammo-spec.ts) を、そのピッチ MAG_BELT_PITCH
// (physics/player-shape.ts) ぶん送る回転角 [rad/発]。
const SPROCKET_RAD_PER_ROUND = (2.847 / 0.26) / 32;
// デリンクドラムは1発剥がすごとに1ステーション(全6)ぶん回る [rad/発]。
const DRUM_RAD_PER_ROUND = TWO_PI / 6;

// 1つの被駆動部の回転状態。base は初見時の anchor 姿勢で、spin はその +Z まわりに重ねる。
interface DriveSpin {
  readonly base: THREE.Quaternion;
  angularSpeed: number;
  phase: number;
}

// 回す対象と、その1発あたりの回転角 [rad/発]。
interface DrivenPart {
  readonly anchor: THREE.Object3D;
  readonly radiansPerRound: number;
}

// 1隻ぶんの被駆動部 anchor の角速度と回転角を持ち、毎フレーム anchor の姿勢へ書く。
export class WeaponDrives {
  private readonly spins = new Map<THREE.Object3D, DriveSpin>();
  private lastDisplayTime: number | null = null;

  // 健全な武装モジュールの被駆動部を、全砲口の合計射撃レート gunFireRate [rounds/s] に
  // 見合う速さへ追従させ、displayTime [s] の前進ぶん回す。消えた・壊れた部品の状態は捨てる。
  public sync(
    ship: ModularShipView, modules: readonly ShipModuleRenderInput[], gunFireRate: number, displayTime: number,
  ): void {
    const parts = drivenParts(ship, modules);
    const dt = this.lastDisplayTime === null ? 0 : Math.min(MAX_STEP, Math.max(0, displayTime - this.lastDisplayTime));
    this.lastDisplayTime = displayTime;
    // 作り直し・撤去・破壊で外れた駆動部の状態を捨てる。
    const live = new Set(parts.map(part => part.anchor));
    for (const anchor of this.spins.keys()) {
      if (!live.has(anchor)) this.spins.delete(anchor);
    }
    for (const { anchor, radiansPerRound } of parts) {
      let spin = this.spins.get(anchor);
      if (spin === undefined) {
        spin = { base: anchor.quaternion.clone(), angularSpeed: 0, phase: 0 };
        this.spins.set(anchor, spin);
      }
      advance(spin, radiansPerRound * gunFireRate, dt);
      anchor.quaternion.copy(spin.base).multiply(SPIN_QUAT.setFromAxisAngle(SPIN_AXIS, spin.phase));
    }
  }
}

// hp が残る武装モジュールが持つ被駆動部の一覧。砲身束は発射レートを束の数で等分する。
function drivenParts(ship: ModularShipView, modules: readonly ShipModuleRenderInput[]): DrivenPart[] {
  const parts: DrivenPart[] = [];
  const rotors: THREE.Object3D[] = [];
  for (const module of modules) {
    if (module.kind !== 'weapon' || module.hp <= 0) continue;
    rotors.push(...ship.semanticAnchors(module.id, 'barrel-rotor:'));
    for (const anchor of ship.semanticAnchors(module.id, 'feed-sprocket:')) {
      parts.push({ anchor, radiansPerRound: SPROCKET_RAD_PER_ROUND });
    }
    const drum = ship.semanticAnchor(module.id, 'feed-drum');
    if (drum !== null) parts.push({ anchor: drum, radiansPerRound: DRUM_RAD_PER_ROUND });
  }
  // 回転砲身は1発ごとに砲身1本ぶん回る。複数束なら発射レートを棟数で等分する。
  for (const anchor of rotors) {
    parts.push({ anchor, radiansPerRound: TWO_PI / (barrelCountOf(anchor) * rotors.length) });
  }
  return parts;
}

// 角速度を目標 target [rad/s] へ一次遅れで dt [s] だけ近づけ、その間の回転を回転角へ積む。
function advance(spin: DriveSpin, target: number, dt: number): void {
  const timeConstant = target > spin.angularSpeed ? SPIN_UP_TIME_CONSTANT : SPIN_DOWN_TIME_CONSTANT;
  const previous = spin.angularSpeed;
  spin.angularSpeed = target + (previous - target) * Math.exp(-dt / timeConstant);
  const phase = (spin.phase + 0.5 * (previous + spin.angularSpeed) * dt) % TWO_PI;
  spin.phase = phase < 0 ? phase + TWO_PI : phase;
}

// anchor が宣言する砲身の本数。正の整数でなければアセットの不備として投げる。
function barrelCountOf(anchor: THREE.Object3D): number {
  const count: unknown = anchor.userData.barrelCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
    throw new Error(`barrel rotor has no positive barrelCount: ${anchor.name}`);
  }
  return count;
}
