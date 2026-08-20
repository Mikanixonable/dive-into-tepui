// VesselInit から機体の設計・初期状態・表示名・識別子を解決する。this を持たない純粋関数群。
import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../physics/solar-system';
import { v3 } from '../../physics/vec3';
import type { InertiaTensor } from '../../physics/inertia-tensor';
import type { GraphicsSettings } from '../../render/graphics-settings';
import * as C from '../const';
import { EntityIdAllocator } from '../game-entity/entity-id';
import type { Hud } from '../hud/hud';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import { generateRandomName } from '../random-name';
import type { AmmoLoad } from './gunnery';
import {
  isSupportedBaseSaveFormat,
  type AssemblySaveData,
  type BaseSaveData,
  type EnemySaveData,
  type PlayerSaveData,
} from '../save-data';
import type { VesselAssembly } from './assembly';
import type { EnemyKind } from './enemy-ai';
import {
  baseAssemblyFromSaveData, blueprintDesign, crewedShipDesign, hostileShipDesign, orbitalBaseDesign,
  type VesselDesign,
} from './vessel-designs';
import { createBlueprint, type VesselBlueprint } from './blueprint';

const baseIdAllocator = new EntityIdAllocator('base-');

// 有人艦の新規配置。省略時は高度 INITIAL_ALT・傾斜 INITIAL_INC_DEG の円軌道に機首プログレードで置く。
export interface CrewedShipInit {
  readonly name?: string;
  readonly state?: KinematicState;
  readonly id?: string;
  readonly ammo?: AmmoLoad;
}

// 保存された設計から組む機体の新規配置。
export interface BlueprintShipInit {
  readonly blueprint: VesselBlueprint;
  readonly name?: string;
  readonly state: KinematicState;
  readonly id?: string;
}

export interface OrbitalBaseInit {
  readonly state: KinematicState;
  readonly name?: string;
  readonly att?: Attitude;
  readonly id?: string;
}

export interface HostileShipInit {
  readonly name: string;
  readonly state: KinematicState;
  readonly enemyKind: EnemyKind;
  readonly att: Attitude;
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly waveId?: number;
  readonly id?: string;
}

// どの既定の設計で組むか。saved* から始まるものはスナップショットの復元。
export type VesselInit =
  | { readonly crewedShip: CrewedShipInit }
  | { readonly blueprintShip: BlueprintShipInit }
  | { readonly orbitalBase: OrbitalBaseInit }
  | { readonly hostileShip: HostileShipInit }
  | { readonly savedShip: PlayerSaveData; readonly simTime: number }
  | { readonly savedBase: BaseSaveData; readonly simTime: number }
  | { readonly savedHostile: EnemySaveData; readonly simTime: number };

// 機体の組み立てに要る、ゲーム側が持っている資源一式。
export interface VesselDeps {
  readonly hud: Hud;
  readonly worldSfx: WorldSfx;
  readonly scene: THREE.Scene;
  readonly fx: EffectsSystem;
  readonly markerManager: MarkerManager;
  readonly graphics: GraphicsSettings;
}

// 高度 INITIAL_ALT、傾斜角 INITIAL_INC_DEG の円軌道状態を返す。
export function initialShipState(): KinematicState {
  const r0 = R_EARTH + C.INITIAL_ALT;
  const vCirc = Math.sqrt(MU_EARTH / r0);
  const inc = (C.INITIAL_INC_DEG * Math.PI) / 180;
  return kinematicState(0, v3(r0, 0, 0), v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)));
}

// state の速度方向を機首、位置方向を上として姿勢を組む。
export function progradeAttitude(state: KinematicState, inertia: InertiaTensor): Attitude {
  return { q: qFromForwardUp(state.v, state.r) ?? { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia };
}

// init が指す既定の設計を返す。
export function resolveDesign(init: VesselInit): VesselDesign {
  if ('blueprintShip' in init) return blueprintDesign(init.blueprintShip.blueprint);
  if ('crewedShip' in init) return crewedShipDesign();
  if ('savedShip' in init) {
    if (!init.savedShip.assembly) return crewedShipDesign();
    const saved = init.savedShip;
    const assembly = saved.assembly!;
    return blueprintDesign(createBlueprint({
      id: `${saved.id}-saved`, name: saved.name ?? saved.id,
      tree: assembly.tree, placements: assembly.placements, now: 0,
    }));
  }
  if ('orbitalBase' in init) return orbitalBaseDesign();
  if ('savedBase' in init) {
    const saved = init.savedBase;
    if (!isSupportedBaseSaveFormat(saved.formatVersion)) return orbitalBaseDesign();
    const assembly = baseAssemblyFromSaveData(saved.assembly);
    if (!assembly) return orbitalBaseDesign();
    try {
      return orbitalBaseDesign(assembly);
    } catch {
      // 断面・エッジ・配置の意味的な破損は設計導出時に例外になることがある。セーブ全体を失わず、
      // 既定基地で復元を続ける。
      return orbitalBaseDesign();
    }
  }
  if ('hostileShip' in init) return hostileShipDesign(init.hostileShip.enemyKind, init.hostileShip.accent);
  return hostileShipDesign(init.savedHostile.enemyKind, init.savedHostile.accent);
}

// 機体を名指すもの一式。設計とは別に、init ごとに決まる。
export interface VesselIdentity {
  readonly name: string;
  readonly state: KinematicState;
  readonly att: Attitude;
  readonly id: string | undefined;
}

// init から、この機体の位置・姿勢・表示名・識別子を決める。姿勢は与えられていなければ
// 機首プログレードに置き、識別子は省略時に GameEntity 側の採番へ委ねて undefined を返す。
export function resolveIdentity(init: VesselInit, design: VesselDesign): VesselIdentity {
  const inertia = design.massProperties.inertia;
  type Xyz = { x: number; y: number; z: number };
  const savedState = (s: { r: Xyz; v: Xyz }, t: number): KinematicState =>
    kinematicState(t, v3(s.r.x, s.r.y, s.r.z), v3(s.v.x, s.v.y, s.v.z));
  const savedAtt = (q: { x: number; y: number; z: number; w: number }, w: Xyz | undefined): Attitude =>
    ({ q: { ...q }, w: w ? v3(w.x, w.y, w.z) : v3(), inertia });

  if ('crewedShip' in init) {
    const { name, state, id } = init.crewedShip;
    const s = state ?? initialShipState();
    const n = name ?? generateRandomName('player');
    return { name: n, state: s, att: progradeAttitude(s, inertia), id: id ?? n };
  }
  if ('savedShip' in init) {
    const d = init.savedShip;
    return {
      name: d.name || d.id, state: savedState(d, init.simTime),
      att: savedAtt(d.q, d.w), id: d.id,
    };
  }
  if ('orbitalBase' in init) {
    const { state, name, att, id } = init.orbitalBase;
    return {
      name: name ?? generateRandomName('base'), state,
      att: att ? { ...att, inertia } : { q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia },
      id: baseIdAllocator.next(id),
    };
  }
  if ('savedBase' in init) {
    const d = init.savedBase;
    return {
      name: d.name || '基地', state: savedState(d, init.simTime),
      att: d.q ? savedAtt(d.q, d.w) : { q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia },
      id: baseIdAllocator.next(d.id),
    };
  }
  if ('hostileShip' in init) {
    const { name, state, att, id } = init.hostileShip;
    return { name, state, att: { ...att, inertia }, id };
  }
  if ('blueprintShip' in init) {
    const { blueprint, name, state, id } = init.blueprintShip;
    return { name: name ?? blueprint.name, state, att: progradeAttitude(state, inertia), id };
  }
  const d = init.savedHostile;
  return {
    name: d.name || '', state: savedState(d, init.simTime),
    att: savedAtt(d.q, d.w), id: d.id || undefined,
  };
}

// assembly は Three.js の Object3D を含まない値だが、保存境界で部品・配列をコピーしておく。これにより
// セーブ後の runtime 部品 HP や作業中の配列変更が、別の保存値を通じて設計へ逆流しない。
export function serializeAssembly(assembly: VesselAssembly): AssemblySaveData {
  return {
    tree: assembly.tree,
    placements: assembly.placements.map((placement) => {
      const part = { ...placement.part };
      if (placement.kind === 'internal') return { ...placement, part, edgeIds: [...placement.edgeIds] };
      const mount = placement.mount.kind === 'port'
        ? { ...placement.mount, port: { ...placement.mount.port } }
        : { ...placement.mount };
      return { ...placement, part, mount };
    }),
  };
}
