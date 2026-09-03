import { AnyPart } from '../dynamic/dynamic-entity/parts';
import type { FormationRole } from '../dynamic/dynamic-entity/enemy';
import type { ProteinAssetId } from '../protein/protein-asset-loader';
import type { ProteinDisplaySettings } from '../protein/protein-display';
import type { GamePhase } from '../stages/stage';
import type { WaveAttackSaveData } from '../stages/stage-utils/wave-attack';
import type { ProteinSaveData } from '../protein/protein-schema';
import type { BoosterStackData, BoosterStageData } from '../player/booster-stack';

interface Vec3SaveData {
  x: number;
  y: number;
  z: number;
}

interface QuatSaveData {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface EntitySaveData {
  id: string;
  name?: string;
  // 具象クラスのタグ。
  kind: 'player' | 'metal-enemy' | 'protein-enemy' | 'ammo' | 'rcs-fuel' | 'booster';
  r: Vec3SaveData;
  v: Vec3SaveData;
  q: QuatSaveData;
  w: Vec3SaveData;
}

interface KinematicStateSaveData {
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

interface ThermalSaveData {
  hullTemp: number;
}

interface RadiatorPanelSaveData {
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
  kind: 'metal-enemy' | 'protein-enemy';
  alive: boolean;
  health: number;
  // マーカー色・集団識別と、マーカー・軌道線の色。
  accent: string | number;
  orbitLineColor: string | number;
  waveId?: number;
  // 陣形に属する敵だけが持つ識別子と役割。無ければ単体敵として復元する。
  formationId?: string;
  formationRole?: FormationRole;
  // バースト射撃の残弾・次弾までの残り時間。未着手なら両方 undefined。
  burstLeft?: number;
  burstDelay?: number;
  // プロパティウィンドウの軌道線表示トグル。無ければ既定 false。
  showTrajectoryLine?: boolean;
}

export interface MetalEnemySaveData extends EnemySaveData {
  kind: 'metal-enemy';
  // 機体テンプレート番号。型番を持たない漂流機体は null。
  typeIndex: number | null;
}

export interface ProteinEnemySaveData extends EnemySaveData {
  kind: 'protein-enemy';
  assetId: ProteinAssetId;
  display: ProteinDisplaySettings;
  // 機能部位の HP・フェーズ・修飾。
  protein: ProteinSaveData;
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

// 天体暦を使うスナップショットが、どの絶対時刻・プロファイル・packで生成されたか。
// このフィールドは後方互換のため GameSaveData では任意とする。旧形式には無く、
// 旧スナップショットは SnapshotService が従来どおり復元を試みる。
interface EphemerisContext {
  // このランの元期(simTime=0 が指す絶対時刻)。読み込み側はこれを継承する。
  epochJdTdb: number;
  // その元期が選ぶ暦プロファイルと暦パック。数値暦を持たない時代では両方 null。
  profileId: string | null;
  packId: string | null;
  packFormatVersion: number;
}

// GameSaveData の形式バージョン。値が変わった時点で、それ以前に書かれたスナップショットは
// 読めなくなる。
export const SAVE_VERSION = 2;

// chase にこの形が入っている保存データは読み捨て、戦闘視点を既定で組む。
export interface ChaseSaveDataV1 {
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

// カメラの回転追従の保存形。'attitude' はフォーカス機体の姿勢追従(対象は id でなく
// フォーカスから決まる)。
export type CameraRotationFollowSaveData = FrameRotationSourceSaveData | { kind: 'attitude' };

// FocusCamera のフォーカス対象(FocusTarget の保存形)。'point' は焼き込み先の座標系
// (center/rotatingWith)と、その座標系相対の点をそのまま持つ。rotatingWith は
// 旧セーブでは文字列(公転対象の id)または null だったので、読み込み側がその形も受け付ける。
type FocusTargetSaveData =
  | { kind: 'object'; id: string }
  | { kind: 'point'; center: string; rotatingWith: FrameRotationSourceSaveData | string | null; point: Vec3SaveData };

export interface FocusCameraSaveData {
  offset: Vec3SaveData;
  pan: Vec3SaveData;
  up: Vec3SaveData;
  rotatingWith: CameraRotationFollowSaveData | string | null;
  focus: FocusTargetSaveData;
  // 旧セーブデータには無い。無ければ既定のオイラー操作。
  rotationMode?: 'quaternion' | 'euler';
  // 省略されている保存データでは既定の FOV を使う。
  fovDeg?: number;
  // 旧セーブデータには無い。無ければ赤道面。
  referencePlane?: 'ecliptic' | 'equator' | 'moonOrbit';
  projectionMode?: 'perspective' | 'orthographic';
  orthographicHalfHeight?: number;
}

export interface CameraSaveData {
  view: 'combat' | 'map';
  // 戦闘ビューの視点。ChaseSaveDataV1 形なら読み捨てられる。
  chase: FocusCameraSaveData | ChaseSaveDataV1;
  // マップビューの視点。
  overview: FocusCameraSaveData;
}

interface NavTargetSaveData {
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
