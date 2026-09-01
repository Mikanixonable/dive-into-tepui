import { AnyPart } from '../dynamic/dynamic-entity/parts';
import type { EnemyKind } from '../dynamic/dynamic-entity/enemy-kind';
import type { FormationRole } from '../dynamic/dynamic-entity/enemy-formation';
import type { GamePhase } from '../stages/stage';
import type { WaveAttackSaveData } from '../stages/stage-utils/wave-attack';
import type { ProteinSaveData } from '../protein/protein-schema';
import type { BoosterStackData, BoosterStageData } from '../player/booster-stack';

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
  kind: 'player' | 'enemy' | 'ammo' | 'rcs-fuel' | 'booster';
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
  // 装着している砲身の平均温度 [K] と、薬室側が平均より高い温度差 [K]。
  // 欠けているときは環境温度の等温な砲身として復元する。
  barrelTemperature?: number;
  barrelDeviation?: number;
  cooldown: number;
  muzzleIdx: number;
}

export interface ThermalSaveData {
  hullTemp: number;
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
  // 旧セーブデータには無いフィールドなので任意。無ければ followPlan から移行する。'powered' は
  // 廃止済みモードだが、旧セーブの読み込みのために型として残す。
  planExecution?: 'off' | 'instant' | 'powered';
  // 'planExecution' 導入前のセーブが持っていたフィールド。
  followPlan?: boolean;
  // 旧セーブデータには無いフィールドなので任意。無ければ既定値(false)。
  fineAttitude?: boolean;
  // プロパティウィンドウの軌道線表示トグル。旧セーブには無いため任意(既定 false)。
  showTrajectoryLine?: boolean;
  // 接続中のブースター。旧セーブには無いため任意(既定は空スタック)。
  boosters?: BoosterStackData;
}

// 分離後も独立して燃焼・慣性飛行するブースター。接続中の段は PlayerSaveData 側へ保存する。
export interface DetachedBoosterSaveData extends EntitySaveData {
  kind: 'booster';
  stage: BoosterStageData;
  // 分離直後の親艦との再接触を避ける猶予期限。旧データでは即時接触可能とする。
  collisionEnableAt?: number;
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
  // プロパティウィンドウの軌道線表示トグル。旧セーブには無いため任意(既定 false)。
  showTrajectoryLine?: boolean;
}

export interface EnemySaveData extends EntitySaveData {
  enemyKind: EnemyKind;
  alive: boolean;
  health: number;
  accent: string | number;
  // マーカー・軌道線の色。旧セーブデータには無いため任意(無ければ accent から導く)。
  orbitLineColor?: string | number;
  waveId?: number;
  // 陣形に属する敵だけが持つ識別子と役割。無ければ単体敵として復元する。
  formationId?: string;
  formationRole?: FormationRole;
  // バースト射撃の残弾・次弾までの残り時間。未着手なら両方 undefined。
  burstLeft?: number;
  burstDelay?: number;
  // プロパティウィンドウの軌道線表示トグル。旧セーブには無いため任意(既定 false)。
  showTrajectoryLine?: boolean;
  // タンパク質敵が持つ部位HP・フェーズ・修飾。旧セーブには存在しない。
  protein?: ProteinSaveData;
}

export interface AmmoPickupSaveData extends EntitySaveData {
}

export interface RcsFuelPickupSaveData extends EntitySaveData {
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
  // 旧セーブデータには無い。無ければ自動投入を有効にする。
  rcsFuelResupplyEnabled?: boolean;
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
  centerBodyId: string;
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
  // このランの元期(simTime=0 が指す絶対時刻)。読み込み側はこれを継承する。
  epochJdTdb: number;
  // その元期が選ぶ暦プロファイルと暦パック。数値暦を持たない時代では両方 null。
  profileId: string | null;
  packId: string | null;
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

// FrameRotationSource の保存形。
export interface FrameRotationSourceSaveData {
  kind: 'revolution' | 'spin';
  id: string;
}

// MapCamera のフォーカス対象(FocusTarget の保存形)。'point' は焼き込み先の座標系
// (center/rotatingWith)と、その座標系相対の点をそのまま持つ。rotatingWith は
// 旧セーブでは文字列(公転対象の id)または null だったので、読み込み側がその形も受け付ける。
export type FocusTargetSaveData =
  | { kind: 'object'; id: string }
  | { kind: 'point'; center: string; rotatingWith: FrameRotationSourceSaveData | string | null; point: Vec3SaveData };

export interface MapCameraSaveData {
  offset: Vec3SaveData;
  pan: Vec3SaveData;
  up: Vec3SaveData;
  rotatingWith: FrameRotationSourceSaveData | string | null;
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

export interface NavTargetSaveData {
  id: string;
  name: string;
}

export interface GameSaveData {
  version: number;
  stageId: string;
  simTime: number;
  /**
   * そのランの元期と、それが選ぶ暦データの識別。旧スナップショットには無い。
   * 元期は読み込み側が継承する値で、照合するのは暦データのほうだけ。
   */
  ephemerisContext?: EphemerisContext;
  phaseOffsets: Partial<Record<string, number>>;
  /** 旧スナップショットには無い。存在しなければ地球の自転初期位相は復元されない。 */
  earthSpinPhase0?: number;
  players: PlayerSaveData[];
  activePlayerId: string | null;
  enemies: EnemySaveData[];
  ammoPickups: AmmoPickupSaveData[];
  // 旧スナップショットには無い。読み込み時に空配列へ正規化する。
  rcsFuelPickups?: RcsFuelPickupSaveData[];
  // 旧スナップショットには無い。読み込み時は空配列として扱う。
  detachedBoosters?: DetachedBoosterSaveData[];
  bases: BaseSaveData[];
  stage: StageSaveData;
  // 旧セーブデータには無いフィールドなので任意。無ければ視点は既定のまま始まる。
  camera?: CameraSaveData;
  // 旧セーブデータには無い。無ければターゲット未選択のまま始まる。
  navTarget?: NavTargetSaveData | null;
}
