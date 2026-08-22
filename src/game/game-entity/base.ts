import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Attitude } from '../../physics/attitude';
import { qRotate } from '../../physics/attitude';
import { add, len, sub, v3, Vec3 } from '../../physics/vec3';
import type { AnyPart, Part } from './parts';
import { partFromSaveData } from './parts';
import { Player } from '../player/player';
import { buildBaseModel } from '../../render/ships';
import type { Hud } from '../hud/hud';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import { EquatorNodeMarkerPair } from '../marker/equator-node-marker-pair';
import type { BaseSaveData } from '../save-data';
import { Plan } from '../plan/plan';
import type { PlanExecutionMode } from '../player/player';
import { generateRandomName } from '../random-name';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import type { MarkerRole } from '../targeter';
import { fmtMarkerDist } from '../hud/utils';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import * as C from '../const';
import { BaseCollisionGeometry, RayHit, SphereHit } from '../../physics/base-collision';
import { PlayerThrottle } from '../player/player-throttle';
import type { Controllable } from './controllable';
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ThrustEffects } from '../player/thrust-effects';
import { RcsEffects } from '../player/rcs-effects';
import type { CameraSystem } from '../camera/camera-system';
import type { FloatingOrigin } from '../floating-origin';
import type { MapVisibility } from '../celestial/map-visibility';

// 基地のドッキングハッチのローカル位置および外向き法線ベクトル (中腹ドッキングパレット上部, 3倍スケール対応)
export const BASE_HATCH_LOCAL_POS: Vec3 = v3(0, 21.0, 0);
export const BASE_HATCH_LOCAL_NORMAL: Vec3 = v3(0, 1, 0);

export interface BaseDockSlot {
  readonly id: number;
  readonly localPos: Vec3;
  readonly localNormal: Vec3;
}

export const BASE_DOCK_SLOTS: readonly BaseDockSlot[] = [
  { id: 0, localPos: v3(-16.5, 21.0, -16.5), localNormal: v3(0, 1, 0) },
  { id: 1, localPos: v3( 16.5, 21.0, -16.5), localNormal: v3(0, 1, 0) },
  { id: 2, localPos: v3(-16.5, 21.0,  16.5), localNormal: v3(0, 1, 0) },
  { id: 3, localPos: v3( 16.5, 21.0,  16.5), localNormal: v3(0, 1, 0) },
];

// 収容中の艦のエントリ。parts は player.parts と同一参照(修理は艦へ直接反映される)。
// hp/maxHp は艦一覧タブ表示用の集計値で、修理のたびに書き戻す。
export interface DockedVesselEntry {
  readonly id: string;
  readonly name: string;
  hp: number;
  maxHp: number;
  readonly parts: Part[];
  readonly player: Player;
  slotIndex: number;
}

export interface BaseState {
  money: number;
  inventory: AnyPart[];
  dockedVessels: DockedVesselEntry[];
}

const idAllocator = new EntityIdAllocator('base-');

// 新規配置は state/name/att をそのまま使い、スナップショットからの再開は saved を
// simTime の epoch で展開する。
export type BaseInit =
  | { readonly state: KinematicState; readonly name?: string; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: BaseSaveData; readonly simTime: number };

export function baseMarkerSvg(): string {
  const pts = "12,2.5 19.43,6.08 21.26,14.11 16.12,20.56 7.88,20.56 2.74,14.11 4.57,6.08";
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="Base">` +
    `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
    `</svg>`;
}

export class Base extends GameEntity implements Controllable {
  readonly collisionGeom = new BaseCollisionGeometry();
  protected readonly predictedForGhost = true;
  readonly plan = new Plan();
  planExecution: PlanExecutionMode = 'off';
  fineAttitude = false;
  // 基地は常に赤道交点マーカーを出すので、コンストラクタで必ず組む。
  declare equatorNodes: EquatorNodeMarkerPair;
  public baseState: BaseState = {
    money: 100000,
    inventory: [],
    dockedVessels: []
  };

  // --- Controllable 実装 ---
  readonly throttle: PlayerThrottle;
  readonly thrustEffects: ThrustEffects;
  readonly rcsEffects: RcsEffects;
  private baseFuel: number;
  get totalThrust(): number { return C.BASE_THRUST; }
  get totalTorque(): number { return C.BASE_TORQUE; }
  get totalFuelConsumptionRate(): number { return C.BASE_FUEL_RATE; }
  get fuel(): number { return this.baseFuel; }
  get maxFuel(): number { return C.BASE_MAX_FUEL; }

  consumeFuel(amount: number): number {
    if (amount <= 0) return 1.0;
    const actual = Math.min(this.baseFuel, amount);
    this.baseFuel -= actual;
    return actual / amount;
  }

  raycast(rayOrigin: Vec3, rayDir: Vec3, maxDist: number, warpLevel = 1): RayHit | null {
    return this.collisionGeom.raycast(rayOrigin, rayDir, maxDist, this.state.r, this.att.q, warpLevel);
  }

  testSphereCollision(sphereCenter: Vec3, sphereRadius: number, warpLevel = 1): SphereHit | null {
    return this.collisionGeom.testSphereCollision(sphereCenter, sphereRadius, this.state.r, this.att.q, warpLevel);
  }

  // 基地は接触で押されない。mass は推力加速度の分母を兼ねるので、そちらとは別に持つ。
  override get contactMass(): number { return Infinity; }

  // hud/worldSfx/fx/markerManager は格納艦(Player)の組み立てに要る。格納艦は entities.players へ
  // 入らない — それが「格納中」の定義であり、艦自身の状態としては何も倒さない。
  constructor(
    init: BaseInit,
    scene: THREE.Scene,
    hud: Hud,
    worldSfx: WorldSfx,
    fx: EffectsSystem,
    private readonly markerManager: MarkerManager,
  ) {
    const { state, name, att, id } = 'saved' in init
      ? {
        state: kinematicState(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        name: init.saved.name || '基地',
        att: undefined,
        id: init.saved.id,
      }
      : { state: init.state, name: init.name ?? generateRandomName('base'), att: init.att, id: init.id };
    const savedAtt: Attitude | undefined = 'saved' in init && init.saved.q
      ? {
        q: { ...init.saved.q },
        w: init.saved.w ? v3(init.saved.w.x, init.saved.w.y, init.saved.w.z) : v3(),
        inertia: v3(C.BASE_INERTIA_X, C.BASE_INERTIA_Y, C.BASE_INERTIA_Z),
      }
      : undefined;
    super(state, buildBaseModel(), scene, savedAtt ?? att, idAllocator.next(id));
    // 姿勢に慣性モーメントを設定（既定の identityAttitude は inertia=(1,1,1) なので上書きが必要）
    if (!savedAtt && !att) {
      this.att = { ...this.att, inertia: v3(C.BASE_INERTIA_X, C.BASE_INERTIA_Y, C.BASE_INERTIA_Z) };
    } else if (att && !att.inertia) {
      this.att = { ...this.att, inertia: v3(C.BASE_INERTIA_X, C.BASE_INERTIA_Y, C.BASE_INERTIA_Z) };
    }
    this.mass = 3e6;
    this.radius = 330;
    this.collides = true;
    this.name = name;
    this.baseFuel = 'saved' in init && init.saved.fuel !== undefined ? init.saved.fuel : C.BASE_MAX_FUEL;
    this.throttle = new PlayerThrottle(hud, 'saved' in init ? init.saved.throttle : undefined);
    this.thrustEffects = new ThrustEffects(scene, worldSfx);
    this.rcsEffects = new RcsEffects(scene, worldSfx);
    this.equatorNodes = new EquatorNodeMarkerPair(this, markerManager);

    if ('saved' in init) {
      this.baseState.money = init.saved.money;
      this.baseState.inventory = (init.saved.inventory ?? []).map(partFromSaveData);
      const savedVessels = init.saved.dockedVessels ?? init.saved.dockedShips ?? [];
      this.baseState.dockedVessels = savedVessels.map((shipData, idx) => {
        const player = new Player(hud, worldSfx, scene, fx, markerManager, { saved: shipData, simTime: init.simTime });
        const slotIndex = idx < C.BASE_MAX_VESSELS ? idx : 0;
        this.attachDockedVesselMesh(player, slotIndex);
        return {
          id: player.id,
          name: player.name,
          hp: player.hp,
          maxHp: player.maxHp,
          parts: player.parts,
          player,
          slotIndex,
        };
      });
    }
  }

  // 基地のドッキングハッチのワールド座標を取得する
  getHatchWorldPos(): Vec3 {
    return add(this.state.r, qRotate(this.att.q, BASE_HATCH_LOCAL_POS));
  }

  // 基地のドッキングハッチのワールド正面法線ベクトルを取得する
  getHatchWorldNormal(): Vec3 {
    return qRotate(this.att.q, BASE_HATCH_LOCAL_NORMAL);
  }

  // 指定スロットのワールド位置を取得する
  getSlotWorldPos(slotIndex: number): Vec3 {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    return add(this.state.r, qRotate(this.att.q, slot.localPos));
  }

  // 指定スロットの外向き法線ベクトルを取得する
  getSlotWorldNormal(slotIndex: number): Vec3 {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    return qRotate(this.att.q, slot.localNormal);
  }

  // 利用可能な空きスロット番号(0..3)を返す。満杯なら null。
  getAvailableSlotIndex(): number | null {
    const occupied = new Set(this.baseState.dockedVessels.map((s) => s.slotIndex));
    for (let i = 0; i < C.BASE_MAX_VESSELS; i++) {
      if (!occupied.has(i)) return i;
    }
    return null;
  }

  // 格納艦の 3D メッシュを基地ドックスロットへアタッチ表示する
  attachDockedVesselMesh(ship: Player, slotIndex: number): void {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    const shipObj = ship.renderObject;
    shipObj.visible = true;
    shipObj.position.set(slot.localPos.x, slot.localPos.y, slot.localPos.z);

    const dir = new THREE.Vector3(slot.localNormal.x, slot.localNormal.y, slot.localNormal.z);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    shipObj.quaternion.copy(q);

    if (shipObj.parent !== this.renderObject) {
      this.renderObject.add(shipObj);
    }
  }

  // 発進時、格納艦の 3D メッシュを基地ドックスロットから分離し、ワールド Scene へ復帰させる
  detachDockedVesselMesh(ship: Player): void {
    const shipObj = ship.renderObject;
    if (shipObj.parent === this.renderObject) {
      this.renderObject.remove(shipObj);
    }
    if (this.scene && shipObj.parent !== this.scene) {
      this.scene.add(shipObj);
    }
    shipObj.visible = true;
  }

  // --- 操作制御 ---

  // 毎フレーム、操作対象の基地に対して1度だけ呼ぶ。input が null なら操作されない。
  updateBaseControls(input: Input | null, dt: number, simDt: number): void {
    if (input === null) {
      this.clearTransientCommands();
      return;
    }
    this.handleEdgeInput(input);
    this.torque = this.throttle.updateTorque(
      this.att, this.state.r, this.state.v, input, false, dt, simDt, this,
      () => {},  // 基地はプログレードホールド解除のヒントを出さない
    );
    this.throttle.updateThrustLatches(input);
    this.thrust = this.throttle.updateThrustState(input, this.att, simDt, this);
  }

  clearTransientCommands(): void {
    this.thrust = null;
    this.torque = v3();
    this.throttle.clearTransientState();
  }

  // 基地側のキー（RCS減衰・プログレード・スロットル等）を1フレーム分消費する。
  private handleEdgeInput(input: Input): void {
    input.takeKeys((code) => {
      switch (code) {
        case K.rcsDampToggle.code: this.throttle.toggleRcsDamp(); return true;
        case K.progradeReset.code: this.throttle.enableProgradeReset(); return true;
        case K.progradeHoldToggle.code: this.throttle.toggleProgradeHold(); return true;
        case K.throttleLow.code: this.throttle.setThrottlePreset(0); return true;
        case K.throttleMid.code: this.throttle.setThrottlePreset(1); return true;
        case K.throttleHigh.code: this.throttle.setThrottlePreset(2); return true;
        case K.throttleMax.code: this.throttle.setThrottlePreset(3); return true;
        default: return false;
      }
    });
  }

  // 基地のメッシュ・推力プルーム・RCS パフ・音・軌道線を同期する。
  syncBase(
    fo: FloatingOrigin,
    camera: CameraSystem,
    displayTime: number,
    isControlled: boolean,
    visibility: MapVisibility | null = null,
  ): void {
    const displayState = this.displayState(displayTime);
    const mapEntityVisible = !camera.overviewMode || visibility === null || visibility.category;
    this.renderObject.visible = displayState !== null && mapEntityVisible;
    if (displayState !== null) {
      this.renderObject.position.copy(fo.RtoThreeV3(displayState.r));
      this.renderObject.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    }

    const effectState = displayState ?? this.state;
    const effectVisible = displayState !== null && mapEntityVisible;
    const maxAccel = this.mass > 0 ? this.totalThrust / this.mass : 0;
    this.thrustEffects.sync(fo, effectState.r, this.thrust, maxAccel, effectVisible, isControlled, camera, 6.0);
    this.rcsEffects.sync(fo, effectState.r, this.torque, this.att, effectVisible, camera, isControlled, 6.0);
  }

  markerItem(role: MarkerRole, viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean): GroupedMarkerItem {
    const dist = len(sub(pos, viewerPos));
    const priority = role === 'primary' ? C.MARKER_PRIORITY.PRIMARY_TARGET : C.MARKER_PRIORITY.BASE - dist / 1e9;
    return {
      key: `base-${this.id}`,
      cls: role === 'primary' ? 'mk-target' : 'mk-base',
      sym: baseMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      detail: overviewMode ? '' : fmtMarkerDist(dist),
      bearingColor: C.COLOR_MARKER_ALLY,
      bearingSym: ENTITY_GLYPH.base,
      bearingClass: 'mk-dir mk-ally-dir',
      bearingVisible: false,
      color: C.COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  dispose(): void {
    super.dispose();
    if (this.scene) {
      this.thrustEffects.dispose(this.scene);
      this.rcsEffects.dispose(this.scene);
    }
    this.markerManager.remove(`base-${this.id}`);
    this.markerManager.remove(`base-${this.id}-bearing`);
    // 格納艦は entities.players から外れているため、ここでしか回収できない。
    for (const entry of this.baseState.dockedVessels) entry.player.dispose();
    this.baseState.dockedVessels = [];
  }

  // セーブデータへ変換する。格納艦は player.serialize() に委ねる。
  serialize(): BaseSaveData {
    return {
      id: this.id,
      name: this.name,
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      money: this.baseState.money,
      fuel: this.baseFuel,
      inventory: this.baseState.inventory.map(p => ({ ...p })),
      dockedVessels: this.baseState.dockedVessels.map(entry => entry.player.serialize()),
      throttle: this.throttle.serialize(),
    };
  }
}
