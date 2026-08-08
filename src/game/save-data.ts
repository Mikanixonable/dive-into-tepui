import { AnyPart } from './game-entity/parts';
import { EnemyKind } from './game-entity/enemy';
import { AttractorId } from '../physics/attractor';

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

export interface KinematicStateSaveData {
  t: number;
  r: Vec3SaveData;
  v: Vec3SaveData;
}

export interface PlanSaveData {
  anchor: KinematicStateSaveData;
  nodes: KinematicStateSaveData[];
}

export interface PlayerSaveData extends EntitySaveData {
  mags: number;
  rounds: number;
  heat: number;
  hp: number;
  maxHp: number;
  parts: AnyPart[];
  plan: PlanSaveData | null;
}

// 基地は艦(EntitySaveData)と持ち物が根本的に異なる(所持金・在庫・収容艦)ため、
// kind で分岐する EntitySaveData の派生ではなく独立した型にする。
export interface BaseSaveData {
  id: string;
  // 旧セーブデータには無いフィールドなので任意。Base.restore が既定名で埋める。
  name?: string;
  r: Vec3SaveData;
  v: Vec3SaveData;
  money: number;
  inventory: AnyPart[];
  // 格納中の艦は entities.players に含まれないため、艦本体(軌道状態・parts・弾薬・計画)を
  // まるごとここへ保存する。復元時に Player を作り直し、DockedShipEntry.player を張り直す。
  dockedShips: PlayerSaveData[];
}

export interface EnemySaveData extends EntitySaveData {
  enemyKind: EnemyKind;
  alive: boolean;
  health: number;
  accent: string | number;
  waveId?: number;
}

export interface AmmoSaveData extends EntitySaveData {
}

export interface GameSaveData {
  version: number;
  stageId: string;
  simTime: number;
  phaseOffsets: Partial<Record<AttractorId, number>>;
  player: PlayerSaveData | null;
  enemies: EnemySaveData[];
  ammos: AmmoSaveData[];
  bases: BaseSaveData[];
}
