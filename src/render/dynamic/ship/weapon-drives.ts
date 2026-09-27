// 機関砲の砲身・給弾部・排莢部・後座部を、射撃と表示時刻に沿って動かす。
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
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const TURN_QUAT = new THREE.Quaternion();
const STROKE_DIR = new THREE.Vector3();

// 送り車の半径 [m](build-ship-modules.py の給弾塔)。ベルト1リンクぶんの装弾
// MAG_ROUNDS(game/player/ammo-spec.ts) を、そのピッチ MAG_BELT_PITCH
// (physics/player-shape.ts) ぶん送る回転角 [rad/発]。
const SPROCKET_RAD_PER_ROUND = (2.847 / 0.26) / 32;
// デリンクドラムと排莢車は1発ごとに1ステーション(全6)ぶん回る [rad/発]。
const STATION_RAD_PER_ROUND = TWO_PI / 6;
// 案内爪と外枠の押し出し爪はベルト1リンク(32発)の送りで1往復する [rad/発]。
const LINK_CYCLE_RAD_PER_ROUND = TWO_PI / 32;
// リンク排出口の案内ローラー(半径 0.09 m)が、ベルト1リンクのピッチ 4.09 m を 32 発で送る回転角 [rad/発]。
const LINK_ROLLER_RAD_PER_ROUND = (4.09 / 0.09) / 32;
// 弾と薬莢の送り路は1発ごとに1ピッチ進む [rad/発]。
const CONVEYOR_RAD_PER_ROUND = TWO_PI;

// 連射中に後退位置へ沈む時定数と、射撃をやめて元の位置へ戻る時定数 [s]。
const RECOIL_SET_BACK_TIME_CONSTANT = 0.12;
const RECOIL_RUN_OUT_TIME_CONSTANT = 0.3;
// 連射が続いたときに機関部が留まる後退位置 [後座量に対する比]。
const RECOIL_SUSTAINED_SET_BACK = 0.45;
// 1発の後座から復座までの長さの上限 [s] と、そのうち後退に使う割合。
const MAX_RECOIL_DURATION = 0.18;
const RECOIL_ATTACK_RATIO = 0.2;
// 復座区間の緩衝反発: (1-q)² cos(位相 q) が負になる区間で、後退位置より前へ押し戻される。
const RECOIL_REBOUND_PHASE = 1.5 * Math.PI;
// 圧縮部品を潰し切らない最小の長さ比。
const MIN_COMPRESSED_RATIO = 0.05;

export interface WeaponRecoilInput {
  readonly moduleId: string;
  readonly muzzleIndex: number;
  readonly firedAt: number;
  readonly cycleDuration: number;
}

// 駆動の形。spin は anchor 局所 +Z まわりの回転、stroke は +Z 向きの往復摺動、
// conveyor は +Z 向きに pitch ずつ送って同じ並びへ戻る鋸歯の摺動。
type DriveMode =
  | { type: 'spin' }
  | { type: 'stroke'; amplitude: number }
  | { type: 'conveyor'; pitch: number };

// 給弾・排莢の被駆動部の種類。anchor 名の接頭辞、1発あたりに進む位相 [rad/発]、駆動の形。
interface FeedDrive {
  readonly prefix: string;
  readonly radiansPerRound: number;
  readonly mode: (anchor: THREE.Object3D) => DriveMode;
}

const SPIN: DriveMode = { type: 'spin' };
const FEED_DRIVES: readonly FeedDrive[] = [
  { prefix: 'feed-sprocket:', radiansPerRound: SPROCKET_RAD_PER_ROUND, mode: () => SPIN },
  { prefix: 'feed-drum', radiansPerRound: STATION_RAD_PER_ROUND, mode: () => SPIN },
  { prefix: 'feed-shoe', radiansPerRound: LINK_CYCLE_RAD_PER_ROUND, mode: () => ({ type: 'stroke', amplitude: 0.22 }) },
  { prefix: 'feed-conveyor', radiansPerRound: CONVEYOR_RAD_PER_ROUND, mode: conveyorOf },
  { prefix: 'link-roller:', radiansPerRound: LINK_ROLLER_RAD_PER_ROUND, mode: () => SPIN },
  { prefix: 'link-kicker', radiansPerRound: LINK_CYCLE_RAD_PER_ROUND, mode: () => ({ type: 'stroke', amplitude: 0.28 }) },
  { prefix: 'eject-rotor', radiansPerRound: STATION_RAD_PER_ROUND, mode: () => SPIN },
  { prefix: 'eject-conveyor', radiansPerRound: CONVEYOR_RAD_PER_ROUND, mode: conveyorOf },
];

// 1つの被駆動部の状態。base は初見時の anchor の位置と姿勢で、駆動はその上に重ねる。
interface DriveState {
  readonly baseQuat: THREE.Quaternion;
  readonly basePos: THREE.Vector3;
  angularSpeed: number;
  phase: number;
}

// 砲口ごとの後座 anchor の状態。setBack は連射で沈んだ後退位置の深さ 0..1。
interface RecoilState {
  readonly baseQuat: THREE.Quaternion;
  readonly basePos: THREE.Vector3;
  readonly travel: number;
  setBack: number;
}

// 後座量に追従する部品の初見時の姿勢と、anchor 局所 +Z 方向の縮尺。
interface FollowerState {
  readonly baseQuat: THREE.Quaternion;
  readonly baseScaleZ: number;
}

// 動かす対象、その1発あたりに進む位相 [rad/発]、駆動の形。
interface DrivenPart {
  readonly anchor: THREE.Object3D;
  readonly radiansPerRound: number;
  readonly mode: DriveMode;
}

// 砲口 muzzleIndex の後座量に追従する anchor。
interface RecoilPart {
  readonly moduleId: string;
  readonly muzzleIndex: number;
  readonly anchor: THREE.Object3D;
}

// 1隻ぶんの被駆動部 anchor の速さと位相を持ち、毎フレーム anchor の姿勢・位置へ書く。
export class WeaponDrives {
  private readonly states = new Map<THREE.Object3D, DriveState>();
  private readonly recoilStates = new Map<THREE.Object3D, RecoilState>();
  private readonly followerStates = new Map<THREE.Object3D, FollowerState>();
  private lastDisplayTime: number | null = null;

  // 健全な武装モジュールの被駆動部を、全砲口の合計射撃レート gunFireRate [rounds/s] に
  // 見合う速さへ追従させ、displayTime [s] の前進ぶん動かす。消えた・壊れた部品の状態は捨てる。
  public sync(
    ship: ModularShipView, modules: readonly ShipModuleRenderInput[], gunFireRate: number, displayTime: number,
    recoilInputs: readonly WeaponRecoilInput[] = [],
  ): void {
    const parts = drivenParts(ship, modules);
    const dt = this.lastDisplayTime === null ? 0 : Math.min(MAX_STEP, Math.max(0, displayTime - this.lastDisplayTime));
    this.lastDisplayTime = displayTime;
    forgetStale(this.states, parts.map(part => part.anchor));
    this.syncRecoil(ship, modules, recoilInputs, gunFireRate > 0, displayTime, dt);
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
        anchor.quaternion.copy(state.baseQuat).multiply(TURN_QUAT.setFromAxisAngle(Z_AXIS, state.phase));
        continue;
      }
      // 往復摺動は位相の前半で押し込み後半で戻る両端で止まる行程、送り路は1周期で1ピッチ進む。
      const offset = mode.type === 'stroke'
        ? mode.amplitude * 0.5 * (1 - Math.cos(state.phase))
        : mode.pitch * state.phase / TWO_PI;
      anchor.position.copy(state.basePos).addScaledVector(STROKE_DIR.copy(Z_AXIS).applyQuaternion(state.baseQuat), offset);
    }
  }

  // 砲口ごとの後座量を、連射で沈む後退位置と直近の1発の後座から表示時刻に評価し、
  // 後座 anchor と、それに追従するばね・蛇腹・リンクへ適用する。
  private syncRecoil(
    ship: ModularShipView,
    modules: readonly ShipModuleRenderInput[],
    recoilInputs: readonly WeaponRecoilInput[],
    firing: boolean,
    displayTime: number,
    dt: number,
  ): void {
    const anchors = recoilParts(ship, modules, 'gun-recoil:');
    forgetStale(this.recoilStates, anchors.map(part => part.anchor));
    const displacements = new Map<string, number>();
    for (const { moduleId, muzzleIndex, anchor } of anchors) {
      let state = this.recoilStates.get(anchor);
      if (state === undefined) {
        state = {
          baseQuat: anchor.quaternion.clone(), basePos: anchor.position.clone(),
          travel: positiveUserNumber(anchor, 'recoilTravel'), setBack: 0,
        };
        this.recoilStates.set(anchor, state);
      }
      state.setBack = approach(state.setBack, firing ? 1 : 0, dt,
        firing ? RECOIL_SET_BACK_TIME_CONSTANT : RECOIL_RUN_OUT_TIME_CONSTANT);
      const shot = recoilInputs.find(input => input.moduleId === moduleId && input.muzzleIndex === muzzleIndex) ?? null;
      const displacement = recoilDisplacement(shot, displayTime, state.travel, state.setBack);
      displacements.set(recoilKey(moduleId, muzzleIndex), displacement);
      anchor.position.copy(state.basePos).addScaledVector(
        STROKE_DIR.copy(Z_AXIS).applyQuaternion(state.baseQuat), -displacement,
      );
    }

    // 後座量に追従する部品。圧縮部品は軸方向に縮み、リンクは後座量に比例して回る。
    const compressors = recoilParts(ship, modules, 'gun-recoil-compress:');
    const levers = recoilParts(ship, modules, 'gun-recoil-lever:');
    forgetStale(this.followerStates, [...compressors, ...levers].map(part => part.anchor));
    for (const { moduleId, muzzleIndex, anchor } of compressors) {
      const displacement = displacements.get(recoilKey(moduleId, muzzleIndex)) ?? 0;
      const restLength = positiveUserNumber(anchor, 'restLength');
      const ratio = Math.max(MIN_COMPRESSED_RATIO, (restLength - displacement) / restLength);
      anchor.scale.z = this.followerState(anchor).baseScaleZ * ratio;
    }
    for (const { moduleId, muzzleIndex, anchor } of levers) {
      const displacement = displacements.get(recoilKey(moduleId, muzzleIndex)) ?? 0;
      const rate = finiteUserNumber(anchor, 'leverRate');
      anchor.quaternion.copy(this.followerState(anchor).baseQuat)
        .multiply(TURN_QUAT.setFromAxisAngle(Z_AXIS, displacement * rate));
    }
  }

  // 追従部品の初見時の状態。初めて見た anchor は今の姿勢と縮尺を基準として覚える。
  private followerState(anchor: THREE.Object3D): FollowerState {
    let state = this.followerStates.get(anchor);
    if (state === undefined) {
      state = { baseQuat: anchor.quaternion.clone(), baseScaleZ: anchor.scale.z };
      this.followerStates.set(anchor, state);
    }
    return state;
  }
}

// 作り直し・撤去・破壊で外れた anchor の状態を捨てる。
function forgetStale<T>(states: Map<THREE.Object3D, T>, live: readonly THREE.Object3D[]): void {
  const liveSet = new Set(live);
  for (const anchor of states.keys()) {
    if (!liveSet.has(anchor)) states.delete(anchor);
  }
}

// hp が残る武装モジュールが持つ被駆動部の一覧。砲身束は発射レートを束の数で等分する。
function drivenParts(ship: ModularShipView, modules: readonly ShipModuleRenderInput[]): DrivenPart[] {
  const parts: DrivenPart[] = [];
  const rotors: THREE.Object3D[] = [];
  for (const module of modules) {
    if (module.kind !== 'weapon' || module.hp <= 0) continue;
    rotors.push(...ship.semanticAnchors(module.id, 'barrel-rotor:'));
    for (const { prefix, radiansPerRound, mode } of FEED_DRIVES) {
      for (const anchor of ship.semanticAnchors(module.id, prefix)) {
        parts.push({ anchor, radiansPerRound, mode: mode(anchor) });
      }
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

// 健全な武装モジュールの、名前が prefix<砲口番号>(:<部品番号>) の anchor を砲口に対応付ける。
function recoilParts(
  ship: ModularShipView,
  modules: readonly ShipModuleRenderInput[],
  prefix: string,
): RecoilPart[] {
  const result: RecoilPart[] = [];
  for (const module of modules) {
    if (module.kind !== 'weapon' || module.hp <= 0) continue;
    for (const anchor of ship.semanticAnchors(module.id, prefix)) {
      const name = typeof anchor.userData.semanticAnchor === 'string'
        ? anchor.userData.semanticAnchor : anchor.name.slice('anchor:'.length);
      const muzzleIndex = Number(name.slice(prefix.length).split(':')[0]);
      if (!Number.isInteger(muzzleIndex) || muzzleIndex < 0) {
        throw new Error(`gun recoil anchor has invalid muzzle index: ${anchor.name}`);
      }
      result.push({ moduleId: module.id, muzzleIndex, anchor });
    }
  }
  return result;
}

function recoilKey(moduleId: string, muzzleIndex: number): string {
  return `${moduleId}:${muzzleIndex}`;
}

// 送り路 anchor の userData が宣言する1発ぶんの送り量 [m]。
function conveyorOf(anchor: THREE.Object3D): DriveMode {
  return { type: 'conveyor', pitch: positiveUserNumber(anchor, 'conveyorPitch') };
}

// anchor の userData[key] の正の有限値。無ければアセットの不備として投げる。
function positiveUserNumber(anchor: THREE.Object3D, key: string): number {
  const value = finiteUserNumber(anchor, key);
  if (value <= 0) throw new Error(`${anchor.name} has non-positive ${key}`);
  return value;
}

// anchor の userData[key] の有限値。無ければアセットの不備として投げる。
function finiteUserNumber(anchor: THREE.Object3D, key: string): number {
  const value: unknown = anchor.userData[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${anchor.name} has no finite ${key}`);
  return value;
}

// 後退位置 setBack と直近の1発 shot から、表示時刻 displayTime の後座量 [m] を 0..travel で返す。
// 1発の後座は後退位置から後座端まで下がり、緩衝反発を伴って後退位置へ戻る。
function recoilDisplacement(
  shot: WeaponRecoilInput | null, displayTime: number, travel: number, setBack: number,
): number {
  const held = travel * RECOIL_SUSTAINED_SET_BACK * setBack;
  const kick = shot === null ? 0 : kickProfile(shot, displayTime);
  return Math.min(travel, Math.max(0, held + (travel - held) * kick));
}

// 1発の後座の形。発射から後座端(1)まで素早く下がり、復座で 0 を越えて小さく押し戻されてから 0 へ収まる。
function kickProfile(input: WeaponRecoilInput, displayTime: number): number {
  if (!Number.isFinite(input.firedAt) || !Number.isFinite(input.cycleDuration) || input.cycleDuration <= 0) return 0;
  const duration = Math.min(MAX_RECOIL_DURATION, input.cycleDuration * 0.95);
  const age = displayTime - input.firedAt;
  if (!(duration > 0) || age <= 0 || age >= duration) return 0;
  const attackDuration = duration * RECOIL_ATTACK_RATIO;
  if (age < attackDuration) return 1 - (1 - age / attackDuration) ** 3;
  const progress = (age - attackDuration) / (duration - attackDuration);
  return (1 - progress) ** 2 * Math.cos(RECOIL_REBOUND_PHASE * progress);
}

// value を target へ時定数 timeConstant [s] の一次遅れで dt [s] だけ近づけた値。
function approach(value: number, target: number, dt: number, timeConstant: number): number {
  return target + (value - target) * Math.exp(-dt / timeConstant);
}

// 速さを目標 target [rad/s] へ一次遅れで dt [s] だけ近づけ、その間の前進を位相へ積む。
function advance(state: DriveState, target: number, dt: number): void {
  const previous = state.angularSpeed;
  state.angularSpeed = approach(previous, target, dt,
    target > previous ? SPIN_UP_TIME_CONSTANT : SPIN_DOWN_TIME_CONSTANT);
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
