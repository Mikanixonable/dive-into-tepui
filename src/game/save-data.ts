import { AnyPart } from './game-entity/parts';
import { EnemyKind } from './game-entity/enemy';
import { AttractorId } from '../physics/attractor';
import type { GamePhase } from './stages/stage';

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

export interface FireSaveData {
  mags: number;
  rounds: number;
  barrel: number;
  cooldown: number;
  muzzleIdx: number;
}

export interface ThermalSaveData {
  hullTemp: number;
  pendingHeat: number;
}

export interface RadiatorPanelSaveData {
  deployTarget: 0 | 1;
  deploy: number;
}

export interface RadiatorSaveData {
  up: RadiatorPanelSaveData;
  down: RadiatorPanelSaveData;
}

export interface PowerSaveData {
  charge: number;
}

export interface ThrottleSaveData {
  throttleIdx: number;
  // 旧セーブデータには無いフィールドなので任意。Throttle.restore が既定値(true)で埋める。
  rcsDamp?: boolean;
  progradeHold?: boolean;
}

export interface PlayerSaveData extends EntitySaveData {
  fire: FireSaveData;
  thermal: ThermalSaveData;
  radiator: RadiatorSaveData;
  power: PowerSaveData;
  throttle: ThrottleSaveData;
  parts: AnyPart[];
  plan: PlanSaveData | null;
  followPlan: boolean;
  // 旧セーブデータには無いフィールドなので任意。Player.restore が既定値(false)で埋める。
  fineAttitude?: boolean;
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
  // バースト射撃の残弾・次弾までの残り時間。未着手なら両方 undefined。
  burstLeft?: number;
  burstDelay?: number;
}

export interface AmmoSaveData extends EntitySaveData {
}

export interface ScoreCounterSaveData {
  shots: number;
  hits: number;
  kills: number;
  losses: number;
  totalEnemiesSpawned: number;
}

export interface LogisticsSaveData {
  resupplyCheckAt: number;
  resupplyEnabled: boolean;
}

// 全ステージ共通の内訳(スコア・決着状態・補給タイマー)。ステージ固有の内訳を持つ
// 具象ステージはこれを拡張した型を自分の serialize/restore で使う(stage0.ts の
// Stage0SaveData・stage00.ts の Stage00SaveData)。
export interface StageSaveData {
  scoreCounter: ScoreCounterSaveData;
  phase: GamePhase;
  logistics: LogisticsSaveData;
}

export interface Stage0SaveData extends StageSaveData {
  timeLeft: number;
}

export interface Stage00SaveData extends StageSaveData {
  waveState: 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat';
  spawnTimer: number;
  waveCount: number;
}

export interface GameSaveData {
  version: number;
  stageId: string;
  simTime: number;
  phaseOffsets: Partial<Record<AttractorId, number>>;
  players: PlayerSaveData[];
  activePlayerId: string | null;
  enemies: EnemySaveData[];
  ammos: AmmoSaveData[];
  bases: BaseSaveData[];
  stage: StageSaveData;
}
