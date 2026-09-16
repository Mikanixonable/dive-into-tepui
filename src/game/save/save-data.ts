// セーブの外部形式と、そこから運動状態・姿勢を戻すデコーダ。
import { AnyPart } from '../dynamic/dynamic-entity/parts';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { v3, type Vec3 } from '../../math/vec3';
import type { Attitude } from '../../physics/attitude';
import type { EphemerisContext } from '../../physics/ephemeris/ephemeris-context';
import type { FormationRole } from '../dynamic/dynamic-entity/entity-kind';
import type { ProteinAssetId } from '../protein/protein-asset-loader';
import type { ProteinDisplaySettings } from '../../render/protein/protein-display';
import type { GamePhase } from '../stages/stage';
import type { WaveAttackSaveData } from '../stages/stage-utils/wave-attack';
import type { ProteinSaveData } from '../protein/protein-schema';
import type { BoosterStackData, BoosterStage } from '../player/booster-stack';
import type { OrbitGuideSettings } from '../celestial/orbit-guide/orbit-guide-settings';

interface Vec3SaveData {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface QuatSaveData {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

interface EntitySaveData {
  readonly id: string;
  readonly name?: string;
  // 具象クラスのタグ。
  readonly kind: 'player' | 'metal-enemy' | 'protein-enemy' | 'ammo' | 'rcs-fuel' | 'booster' | 'base';
  readonly r: Vec3SaveData;
  readonly v: Vec3SaveData;
  readonly q: QuatSaveData;
  readonly w: Vec3SaveData;
}

// 保存された位置・速度を、復元時刻の ECI 運動状態へ戻す。
export function savedKinematicState(saved: EntitySaveData, simTime: number): KinematicState<'eci'> {
  return kinematicState<'eci'>(simTime, v3(saved.r.x, saved.r.y, saved.r.z), v3(saved.v.x, saved.v.y, saved.v.z));
}

// 保存された姿勢・角速度へ、復元する個体の主慣性モーメントを添えて姿勢へ戻す。
export function savedAttitude(saved: EntitySaveData, inertia: Vec3): Attitude {
  return { q: { ...saved.q }, w: v3(saved.w.x, saved.w.y, saved.w.z), inertia };
}

interface KinematicStateSaveData {
  readonly t: number;
  readonly r: Vec3SaveData;
  readonly v: Vec3SaveData;
}

export interface PlanSaveData {
  readonly anchor: KinematicStateSaveData;
  readonly nodes: KinematicStateSaveData[];
}

export interface FireSaveData {
  readonly mags: number;
  readonly rounds: number;
  readonly barrel: number;
  // 装着している砲身の平均温度 [K] と、薬室側が平均より高い温度差 [K]。
  // 欠けているときは環境温度の等温な砲身として復元する。
  readonly barrelTemperature?: number;
  readonly barrelDeviation?: number;
  readonly cooldown: number;
  readonly muzzleIdx: number;
}

interface ThermalSaveData {
  readonly hullTemp: number;
}

interface RadiatorPanelSaveData {
  readonly deployTarget: 0 | 1;
  readonly deploy: number;
}

export interface RadiatorSaveData {
  readonly up: RadiatorPanelSaveData;
  readonly down: RadiatorPanelSaveData;
}

export interface PowerSaveData {
  readonly charge: number;
}

export interface ThrottleSaveData {
  readonly throttleIdx: number;
  // 無ければ既定値(true)。
  readonly rcsDamp?: boolean;
  readonly progradeHold?: boolean;
}

export interface PlayerSaveData extends EntitySaveData {
  readonly kind: 'player';
  readonly fire: FireSaveData;
  readonly thermal: ThermalSaveData;
  readonly radiator: RadiatorSaveData;
  readonly power: PowerSaveData;
  readonly throttle: ThrottleSaveData;
  readonly parts: AnyPart[];
  readonly plan: PlanSaveData | null;
  // 無ければ実行しない。
  readonly planExecution?: 'off' | 'instant';
  // 無ければ既定値(false)。
  readonly fineAttitude?: boolean;
  // プロパティウィンドウの軌道線表示トグル。無ければ false。
  readonly showTrajectoryLine?: boolean;
  // 接続中のブースター。無ければ空スタック。
  readonly boosters?: BoosterStackData;
}

// 分離後も独立して燃焼・慣性飛行するブースター。接続中の段は PlayerSaveData 側へ保存する。
export interface DetachedBoosterSaveData extends EntitySaveData {
  readonly kind: 'booster';
  readonly stage: BoosterStage;
  // 分離直後の親艦との再接触を避ける猶予の期限。無ければ即時に接触できる。
  readonly collisionEnableAt?: number;
}

export interface BaseSaveData extends EntitySaveData {
  readonly kind: 'base';
  readonly money: number;
  // 基地の燃料。
  readonly fuel?: number;
  readonly throttle?: ThrottleSaveData;
  // プロパティウィンドウの軌道線表示トグル。無ければ false。
  readonly showTrajectoryLine?: boolean;
}

export interface EnemySaveData extends EntitySaveData {
  readonly kind: 'metal-enemy' | 'protein-enemy';
  readonly alive: boolean;
  readonly health: number;
  // マーカー色・集団識別と、マーカー・軌道線の色。
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  // 表示色とは独立した、同時発砲数を共有する攻撃グループ。旧セーブには無い。
  readonly attackGroupId?: string;
  readonly waveId?: number;
  // 陣形に属する敵だけが持つ識別子と役割。無ければ単体敵として復元する。
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
  // バースト射撃の残弾・次弾までの残り時間。未着手なら両方 undefined。
  readonly burstLeft?: number;
  readonly burstDelay?: number;
  // プロパティウィンドウの軌道線表示トグル。無ければ false。
  readonly showTrajectoryLine?: boolean;
}

export interface MetalEnemySaveData extends EnemySaveData {
  readonly kind: 'metal-enemy';
  // 機体テンプレート番号。型番を持たない漂流機体は null。
  readonly typeIndex: number | null;
}

export interface ProteinEnemySaveData extends EnemySaveData {
  readonly kind: 'protein-enemy';
  readonly assetId: ProteinAssetId;
  readonly display: ProteinDisplaySettings;
  // 機能部位の HP・フェーズ・修飾。
  readonly protein: ProteinSaveData;
}

export interface AmmoPickupSaveData extends EntitySaveData {
  readonly kind: 'ammo';
}

export interface RcsFuelPickupSaveData extends EntitySaveData {
  readonly kind: 'rcs-fuel';
}

// 顔ぶれ1体分の保存形。kind で具象を判別する。
export type EntitySaveDataUnion =
  | PlayerSaveData
  | MetalEnemySaveData
  | ProteinEnemySaveData
  | AmmoPickupSaveData
  | RcsFuelPickupSaveData
  | DetachedBoosterSaveData
  | BaseSaveData;

export interface ScoreCounterSaveData {
  readonly shots: number;
  readonly hits: number;
  readonly kills: number;
  readonly losses: number;
  readonly totalEnemiesSpawned: number;
}

export interface LogisticsSaveData {
  readonly resupplyCheckAt: number;
  readonly resupplyEnabled: boolean;
  // 無ければ自動投入を有効にする。
  readonly rcsFuelResupplyEnabled?: boolean;
}

// 全ステージ共通の内訳(スコア・決着状態・補給タイマー)。ステージ固有の内訳は、これを拡張した
// 型に持つ。
export interface StageSaveData {
  readonly scoreCounter: ScoreCounterSaveData;
  readonly phase: GamePhase;
  readonly logistics: LogisticsSaveData;
}

export interface Stage0SaveData extends StageSaveData {
  readonly timeLeft: number;
}

export interface Stage00SaveData extends StageSaveData, WaveAttackSaveData {
}

// クリエイティブモードの内訳。波状攻撃のトグルと進行状態を持ち、進行状態はトグルが OFF の間も
// 保つ(ON に戻したとき波数を続きから再開する)。
export interface CreativeStageSaveData extends StageSaveData {
  readonly waveAttackEnabled: boolean;
  readonly waveAttack: WaveAttackSaveData;
}

// GameSaveData の形式バージョン。上げるのは構造が変わって互換を切るときで、上げた時点で
// それ以前に書かれた記録は読めなくなる。項目を増やすだけなら版は据え置き、省略可能にして
// 読み込み側で基底値を補う(SAVE.md「形式の版」)。
export const SAVE_VERSION = 3;

// FrameRotationSource の保存形。
export interface FrameRotationSourceSaveData {
  readonly kind: 'revolution' | 'spin';
  readonly id: string;
}

// カメラの回転追従の保存形。'attitude' はフォーカス機体の姿勢追従(対象は id でなく
// フォーカスから決まる)。
export type CameraRotationFollowSaveData = FrameRotationSourceSaveData | { kind: 'attitude' };

// FocusCamera のフォーカス対象(FocusTarget の保存形)。'point' は焼き込み先の座標系
// (center/rotatingWith)と、その座標系相対の点をそのまま持つ。
type FocusTargetSaveData =
  | { kind: 'object'; id: string }
  | { kind: 'point'; center: string; rotatingWith: FrameRotationSourceSaveData | null; point: Vec3SaveData };

export interface FocusCameraSaveData {
  readonly offset: Vec3SaveData;
  readonly pan: Vec3SaveData;
  readonly up: Vec3SaveData;
  readonly rotatingWith: CameraRotationFollowSaveData | null;
  readonly focus: FocusTargetSaveData;
  // 無ければ既定のオイラー操作。
  readonly rotationMode?: 'quaternion' | 'euler';
  // 無ければ既定の FOV。
  readonly fovDeg?: number;
  // 無ければ赤道面。
  readonly referencePlane?: 'ecliptic' | 'equator' | 'moonOrbit';
  readonly projectionMode?: 'perspective' | 'orthographic';
  readonly orthographicHalfHeight?: number;
}

export interface CameraSaveData {
  readonly view: 'combat' | 'map';
  // 戦闘ビューの視点。
  readonly chase: FocusCameraSaveData;
  // マップビューの視点。
  readonly overview: FocusCameraSaveData;
}

export interface NavTargetSaveData {
  readonly id: string;
  readonly name: string;
}

export interface GameSaveData {
  readonly version: number;
  readonly stageId: string;
  readonly simTime: number;
  /**
   * そのランの元期と、それが選ぶ暦データの識別。元期は読み込み側が継承する値で、照合するのは
   * 暦データの識別。
   */
  readonly ephemerisContext: EphemerisContext;
  // 顔ぶれ。種別は各要素の kind が持つ。
  readonly entities: EntitySaveDataUnion[];
  readonly activeControlledId: string | null;
  readonly stage: StageSaveData;
  // 無ければ視点は既定のまま始まる。
  readonly camera?: CameraSaveData;
  // 無ければターゲット未選択のまま始まる。
  readonly navTarget?: NavTargetSaveData | null;
  // 無ければ既定の軌道ガイドで始まる。
  readonly orbitGuide?: OrbitGuideSettings;
}
