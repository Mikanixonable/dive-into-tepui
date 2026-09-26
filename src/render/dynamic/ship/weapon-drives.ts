// 機関砲の被駆動部(回転砲身束・給弾スプロケット・デリンクドラム・案内爪)を、射撃レートに
// 追従する速さで表示時刻に沿って動かす。回転する部品は anchor 局所 +Z まわり、摺動する部品は
// 局所 +Z 向きの往復として駆動する。
import * as THREE from 'three/webgpu';
import type { ModularShipView } from './modular-ship-view';
import type { ShipModuleRenderInput } from './ship-render-contract';

// 撃ち始めに目標速度へ近づく一次遅れの時定数 [s]。
const SPIN_UP_TIME_CONSTANT = 0.15;
// トリガーを離してから止まるまでの一次遅れの時定数 [s]。
const SPIN_DOWN_TIME_CONSTANT = 0.8;
// 1回の同期で進める表示時刻の上限 [s]。時刻の跳躍で駆動部が跳ばないようにする。
const MAX_STEP = 0.1;
const TWO_PI = 2 * Math.PI;
const SPIN_AXIS = new THREE.Vector3(0, 0, 1);
const SPIN_QUAT = new THREE.Quaternion();
const STROKE_DIR = new THREE.Vector3();

// 送り車の半径 [m](build-ship-modules.py の給弾塔)。ベルト1リンクぶんの装弾
// MAG_ROUNDS(game/player/ammo-spec.ts) を、そのピッチ MAG_BELT_PITCH
// (physics/player-shape.ts) ぶん送る回転角 [rad/発]。
const SPROCKET_RAD_PER_ROUND = (2.847 / 0.26) / 32;
// デリンクドラムは1発剥がすごとに1ステーション(全6)ぶん回る [rad/発]。
const DRUM_RAD_PER_ROUND = TWO_PI / 6;
// 案内爪はベルト1リンク(32発)の送りで1往復する [rad/発] と、行程の半分の長さ [m]。
const SHOE_RAD_PER_ROUND = TWO_PI / 32;
const SHOE_AMPLITUDE = 0.22;

// 駆動の形。spin は anchor 局所 +Z まわりの回転、stroke は +Z 向きの往復摺動。
type DriveMode = { type: 'spin' } | { type: 'stroke'; amplitude: number };

// 1つの被駆動部の状態。base は初見時の anchor の位置と姿勢で、駆動はその上に重ねる。
interface DriveState {
  readonly baseQuat: THREE.Quaternion;
  readonly basePos: THREE.Vector3;
  angularSpeed: number;
  phase: number;
}

// 動かす対象、その1発あたりに進む位相 [rad/発]、駆動の形。
interface DrivenPart {
  readonly anchor: THREE.Object3D;
  readonly radiansPerRound: number;
  readonly mode: DriveMode;
}

// 1隻ぶんの被駆動部 anchor の速さと位相を持ち、毎フレーム anchor の姿勢・位置へ書く。
export class WeaponDrives {
  private readonly states = new Map<THREE.Object3D, DriveState>();
  private lastDisplayTime: number | null = null;

  // 健全な武装モジュールの被駆動部を、全砲口の合計射撃レート gunFireRate [rounds/s] に
  // 見合う速さへ追従させ、displayTime [s] の前進ぶん動かす。消えた・壊れた部品の状態は捨てる。
  public sync(
    ship: ModularShipView, modules: readonly ShipModuleRenderInput[], gunFireRate: number, displayTime: number,
  ): void {
    const parts = drivenParts(ship, modules);
    const dt = this.lastDisplayTime === null ? 0 : Math.min(MAX_STEP, Math.max(0, displayTime - this.lastDisplayTime));
    this.lastDisplayTime = displayTime;
    // 作り直し・撤去・破壊で外れた駆動部の状態を捨てる。
    const live = new Set(parts.map(part => part.anchor));
    for (const anchor of this.states.keys()) {
      if (!live.has(anchor)) this.states.delete(anchor);
    }
    for (const { anchor, radiansPerRound, mode } of parts) {
      let state = this.states.get(anchor);
      if (state === undefined) {
        state = {
          baseQuat: anchor.quaternion.clone(), basePos: anchor.position.clone(),
          angularSpeed: 0, phase: 0,
        };
        this.states.set(anchor, state);
      }
      advance(state, radiansPerRound * gunFireRate, dt);
      if (mode.type === 'spin') {
        anchor.quaternion.copy(state.baseQuat)
          .multiply(SPIN_QUAT.setFromAxisAngle(SPIN_AXIS, state.phase));
      } else {
        // 往復摺動: 位相の前半で押し込み、後半で戻る。両端で速度0になる滑らかな行程。
        const stroke = mode.amplitude * 0.5 * (1 - Math.cos(state.phase));
        anchor.position.copy(state.basePos).addScaledVector(
          STROKE_DIR.set(0, 0, 1).applyQuaternion(state.baseQuat), stroke);
      }
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
      parts.push({ anchor, radiansPerRound: SPROCKET_RAD_PER_ROUND, mode: SPIN });
    }
    const drum = ship.semanticAnchor(module.id, 'feed-drum');
    if (drum !== null) parts.push({ anchor: drum, radiansPerRound: DRUM_RAD_PER_ROUND, mode: SPIN });
    const shoe = ship.semanticAnchor(module.id, 'feed-shoe');
    if (shoe !== null) {
      parts.push({
        anchor: shoe, radiansPerRound: SHOE_RAD_PER_ROUND,
        mode: { type: 'stroke', amplitude: SHOE_AMPLITUDE },
      });
    }
  }
  // 回転砲身は1発ごとに砲身1本ぶん回る。複数束なら発射レートを棟数で等分する。
  for (const anchor of rotors) {
    parts.push({
      anchor, radiansPerRound: TWO_PI / (barrelCountOf(anchor) * rotors.length), mode: SPIN,
    });
  }
  return parts;
}

const SPIN: DriveMode = { type: 'spin' };

// 速さを目標 target [rad/s] へ一次遅れで dt [s] だけ近づけ、その間の前進を位相へ積む。
function advance(state: DriveState, target: number, dt: number): void {
  const timeConstant = target > state.angularSpeed ? SPIN_UP_TIME_CONSTANT : SPIN_DOWN_TIME_CONSTANT;
  const previous = state.angularSpeed;
  state.angularSpeed = target + (previous - target) * Math.exp(-dt / timeConstant);
  const phase = (state.phase + 0.5 * (previous + state.angularSpeed) * dt) % TWO_PI;
  state.phase = phase < 0 ? phase + TWO_PI : phase;
}

// anchor が宣言する砲身の本数。正の整数でなければアセットの不備として投げる。
function barrelCountOf(anchor: THREE.Object3D): number {
  const count: unknown = anchor.userData.barrelCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
    throw new Error(`barrel rotor has no positive barrelCount: ${anchor.name}`);
  }
  return count;
}
