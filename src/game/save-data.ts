export interface Vec3SaveData {
  x: number;
  y: number;
  z: number;
}

export interface QuatSaveData {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface EntitySaveData {
  id: string;
  name?: string;
  kind: 'player' | 'enemy' | 'ammo';
  r: Vec3SaveData;
  v: Vec3SaveData;
  q: QuatSaveData;
  w: Vec3SaveData;
}

export interface OrbitStateSaveData {
  t: number;
  r: Vec3SaveData;
  v: Vec3SaveData;
}

export interface PlanSaveData {
  centralBody: string;
  anchor: OrbitStateSaveData;
  nodes: OrbitStateSaveData[];
}

export interface PlayerSaveData extends EntitySaveData {
  mags: number;
  rounds: number;
  heat: number;
  plan: PlanSaveData | null;
}

import { EnemyKind } from './game-entity/enemy';

export interface EnemySaveData extends EntitySaveData {
  enemyKind: EnemyKind;
  alive: boolean;
  health: number;
  accent: string | number;
  waveId?: number;
}

export interface AmmoSaveData extends EntitySaveData {
  // ammo pickup specific data if any
}

export interface GameSaveData {
  version: number;
  stageId: string;
  simTime: number;
  player: PlayerSaveData | null;
  enemies: EnemySaveData[];
  ammos: AmmoSaveData[];
}
