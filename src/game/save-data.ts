import { AnyPart } from './game-entity/parts';
import { EnemyKind } from './game-entity/enemy';
import { AttractorId } from '../physics/attractor';
import type { GamePhase } from './stages/stage';
import type { WaveAttackSaveData } from './stages/stage-utils/wave-attack';

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
  // 旧セーブデータには無いフィールドなので任意。無ければ既定値(true)。
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
  // 旧セーブデータには無いフィールドなので任意。無ければ followPlan から移行する。
  planExecution?: 'off' | 'instant' | 'powered';
  // 'planExecution' 導入前のセーブが持っていたフィールド。
  followPlan?: boolean;
  // 旧セーブデータには無いフィールドなので任意。無ければ既定値(false)。
  fineAttitude?: boolean;
}

// 基地は艦(EntitySaveData)と持ち物が根本的に異なる(所持金・在庫・収容艦)ため、
// kind で分岐する EntitySaveData の派生ではなく独立した型にする。
export interface BaseSaveData {
  id: string;
  // 旧セーブデータには無いフィールドなので任意。無ければ既定名。
  name?: string;
  r: Vec3SaveData;
  v: Vec3SaveData;
  // 姿勢と角速度。旧セーブには無いため任意。
  q?: QuatSaveData;
  w?: Vec3SaveData;
  money: number;
  // 基地の燃料。旧セーブには無いため任意。
  fuel?: number;
  // 倉庫在庫部品。旧セーブには無いため任意。
  inventory?: AnyPart[];
  // 格納中の艦は entities.players に含まれないため、艦本体(軌道状態・parts・弾薬・計画)を
  // まるごとここへ保存する。復元時に Player を作り直し、DockedVesselEntry.player を張り直す。
  dockedVessels: PlayerSaveData[];
  dockedShips?: PlayerSaveData[];
  throttle?: ThrottleSaveData;
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

export interface AmmoPickupSaveData extends EntitySaveData {
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
// 具象ステージはこれを拡張した型を自分の serialize() とコンストラクタで使う(stage0.ts の
// Stage0SaveData・stage00.ts の Stage00SaveData)。
export interface StageSaveData {
  scoreCounter: ScoreCounterSaveData;
  phase: GamePhase;
  logistics: LogisticsSaveData;
}

export interface Stage0SaveData extends StageSaveData {
  timeLeft: number;
}

export interface Stage00SaveData extends StageSaveData, WaveAttackSaveData {
}

// クリエイティブモードの内訳。艦0..n隻を自由に配置するモード自身の状態(トグル)に加えて、
// 任意で動かす WaveAttack の進行状態を持つ — waveAttack は waveAttackEnabled が false の
// 間も直前の状態を保つ(OFF→ON で再開したとき波数が0に戻らないように)。
export interface CreativeStageSaveData extends StageSaveData {
  waveAttackEnabled: boolean;
  waveAttack: WaveAttackSaveData;
}

// スナップショットの由来。撮られ方であって、保持されるかどうか(SnapshotMeta.pinned)とは
// 別の軸。クリップは pinned を立てるだけで kind は書き換えない — 由来を塗り替えると
// どのトリガで撮られたかが失われる。
export type SnapshotKind = 'auto' | 'manual' | 'checkpoint';

// 一覧 UI がスナップショット本体を読まずに1件を描くための情報。すべて GameSaveData から
// 導出でき、正本ではなく索引。
export interface SnapshotMeta {
  id: string;
  kind: SnapshotKind;
  pinned: boolean;
  name: string;
  createdAtReal: number;
  simTime: number;
  centerBodyId: AttractorId;
  altitude: number;
  speed: number;
  hpRatio: number;
  maxHp: number;
  magazines: number;
  money: number;
  playerCount: number;
  enemyAliveCount: number;
  phase: GamePhase;
}

// 天体暦を使うスナップショットが、どの絶対時刻・プロファイル・packで生成されたか。
// このフィールドは後方互換のため GameSaveData では任意とする。旧形式には無く、
// 旧スナップショットは SnapshotService が従来どおり復元を試みる。
export interface EphemerisContext {
  epochJdTdb: number;
  profileId: string;
  packId: string;
  packFormatVersion: number;
}

// 1ステージぶんのスナップショット集合とクリア記録。スロットは遊んだステージごとに1件持つ。
export interface StageHistoryMeta {
  stageId: string;
  clearCount: number;
  lastPlayedAtReal: number;
  // 新しい順。
  snapshots: SnapshotMeta[];
}

// セーブデータ(歴史線)1件。
export interface SaveSlotMeta {
  id: string;
  name: string;
  createdAtReal: number;
  lastPlayedAtReal: number;
  lastStageId: string;
  stages: StageHistoryMeta[];
}

// 全スロットのメタを束ねた索引。スナップショット本体は別キーに置き、一覧描画で
// 本体を読まずに済むようにする。
export interface SaveIndex {
  version: number;
  slots: SaveSlotMeta[];
  activeSlotId: string | null;
}

// GameSaveData の形式バージョン。値が変わった時点で、それ以前に書かれたスナップショットは
// 読めなくなる。
export const SAVE_VERSION = 2;

// 書き出しファイルの識別子と形式バージョン。組み立てる側(SaveSlots)と検証する側
// (save-transfer)の両方が参照するので、どちらでもない型定義の場所に置く。
export const SLOT_EXPORT_FORMAT = 'tepui.slot';
export const SLOT_EXPORT_VERSION = 1;

// スロット1件を書き出したファイルの中身。format は無関係な JSON を読ませたときに
// 「壊れたセーブ」ではなく「セーブファイルではない」と判定するための識別子。
export interface SlotExport {
  format: typeof SLOT_EXPORT_FORMAT;
  formatVersion: number;
  exportedAtReal: number;
  slot: SaveSlotMeta;
  // スナップショット id → 本体。
  snapshots: Record<string, GameSaveData>;
}

export interface ChaseCameraSaveData {
  rot: QuatSaveData;
  dist: number;
  pan: Vec3SaveData;
  followAttitude: boolean;
}

// MapCamera のフォーカス対象(FocusTarget の保存形)。'point' は焼き込み先の座標系
// (center/rotatingWith)と、その座標系相対の点をそのまま持つ。
export type FocusTargetSaveData =
  | { kind: 'object'; id: string }
  | { kind: 'point'; center: string; rotatingWith: string | null; point: Vec3SaveData };

export interface MapCameraSaveData {
  offset: Vec3SaveData;
  pan: Vec3SaveData;
  up: Vec3SaveData;
  rotatingWith: string | null;
  focus: FocusTargetSaveData;
  // 旧セーブデータには無い。無ければ既定のオイラー操作。
  rotationMode?: 'quaternion' | 'euler';
  // 旧セーブデータには無い。無ければ既定の広範囲視点 FOV。
  fovDeg?: number;
  // 旧セーブデータには無い。無ければ赤道面。
  referencePlane?: 'ecliptic' | 'equator' | 'moonOrbit';
  projectionMode?: 'perspective' | 'orthographic';
  orthographicHalfHeight?: number;
}

export interface CameraSaveData {
  view: 'combat' | 'map';
  chase: ChaseCameraSaveData;
  overview: MapCameraSaveData;
}

export interface GameSaveData {
  version: number;
  stageId: string;
  simTime: number;
  /** 旧スナップショットには無い。存在する場合は現在の暦と一致しなければ復元しない。 */
  ephemerisContext?: EphemerisContext;
  phaseOffsets: Partial<Record<AttractorId, number>>;
  /** 旧スナップショットには無い。存在しなければ地球の自転初期位相は復元されない。 */
  earthSpinPhase0?: number;
  players: PlayerSaveData[];
  activePlayerId: string | null;
  enemies: EnemySaveData[];
  ammoPickups: AmmoPickupSaveData[];
  bases: BaseSaveData[];
  stage: StageSaveData;
  // 旧セーブデータには無いフィールドなので任意。無ければ視点は既定のまま始まる。
  camera?: CameraSaveData;
}
