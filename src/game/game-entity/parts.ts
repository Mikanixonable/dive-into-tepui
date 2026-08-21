// 機体に載る搭載要素の型と性能値。第8版第1巻 §6-1 の一覧をそのまま型にしたもので、
// 機体の性能はここに書かれた値の合成として PartInventory が求める。
import { Vec3 } from '../../physics/vec3';
import type { PropellantId } from '../economy/propellant-compatibility';
import type { ResourceId } from '../economy/resource';

// 機体の内容積を占める内装要素。
export type InteriorPartType =
  | 'oxidizer_tank' | 'reductant_tank' | 'pressurant_tank' | 'rcs_tank' | 'water_tank'
  | 'battery' | 'fuel_cell' | 'rtg' | 'cockpit' | 'autopilot'
  | 'magazine' | 'ammunition' | 'plumbing' | 'payload_bay'
  | 'flywheel' | 'magnetorquer' | 'base_module' | 'farm' | 'life_support' | 'dock';

// 主要構造と装甲。§6-5 が「コックピットまたは主要構造を失った時点で装甲を 0 とする」と
// 定めるとおり、船体は他の要素と同じく HP を持つ1つの要素である。
export type StructuralPartType = 'hull' | 'armor';

export type PartType = StructuralPartType | ExteriorPartType | InteriorPartType;

// 機体の外側に露出し、外装として取り付ける搭載要素の種別。これ以外は内容積に収める。
// 種別の列挙をここ1箇所へ集め、union はそこから導く —— 種別を足す場所を1つにする。
const EXTERIOR_TYPE_LIST = [
  'weapon', 'engine', 'rcs_thruster', 'solar_panel', 'radiator',
  'combat_shield', 'heat_shield', 'communication', 'robot_arm',
  'docking_port', 'container_coupling',
] as const;

export type ExteriorPartType = typeof EXTERIOR_TYPE_LIST[number];

const EXTERIOR_TYPES: ReadonlySet<PartType> = new Set<PartType>(EXTERIOR_TYPE_LIST);

export function isExterior(part: { readonly type: PartType }): boolean {
  return EXTERIOR_TYPES.has(part.type);
}

export interface Part {
  readonly id: string;
  readonly type: PartType;
  readonly name: string;
  readonly weight: number; // kg

  maxHp: number;
  hp: number; // 0 = 破壊/機能停止
}

// --- 主要構造 ---

export interface HullPart extends Part {
  readonly type: 'hull';
}

export interface ArmorPart extends Part {
  readonly type: 'armor';
  damageReduction: number; // 0-1
}

// --- 外装要素 ---

export type WeaponType = 'gatling' | 'cannon' | 'missile';

export interface WeaponPart extends Part {
  readonly type: 'weapon';
  weaponType: WeaponType;
  fireRate: number; // rounds/s
  damage: number; // 命中1回あたりのダメージ
  muzzleVelocity: number; // m/s
  feedRate: number; // 給弾の要求量 [rounds/s]
}

// エンジンのサイクル(供給方式)。比推力係数・要求与圧・絞り範囲はサイクルが決める(§15-4)。
export type EngineCycle =
  | 'pressure_fed' | 'electric_pump' | 'gas_generator' | 'staged_combustion'
  | 'expander' | 'solid' | 'hybrid';

// 主機。サイクルと対応推進剤の組で定義する。
export interface EnginePart extends Part {
  readonly type: 'engine';
  readonly cycle: EngineCycle;
  readonly propellant: PropellantId;
  thrust: number; // N
  specificImpulse: number; // 真空比推力 [s]
  length: number; // 全長 [m]
  gimbalRange: number; // ジンバル可動角 [deg]
  gimbalRate: number; // ジンバル速度 [deg/s]
  throttleMin: number; // 絞り範囲の下限 [0-1]。1 なら絞れない
  throttleMax: number; // 絞り範囲の上限 [0-1]
  restarts: number; // 再着火回数。負なら無制限
  ignitionPropellantLoss: number; // 点火1回あたりの推進剤損失 [kg]
  maxContinuousBurn: number; // 連続燃焼時間の上限 [s]。無制限なら Infinity
  fuelConsumptionRate: number; // kg/s(絞り 100% 時)
  catalystMass: number; // 触媒床の質量 [kg]。触媒を要さない二液推進剤では 0
}

// 並進 RCS スラスタ。
export interface RcsThrusterPart extends Part {
  readonly type: 'rcs_thruster';
  readonly propellant: PropellantId;
  thrust: number; // N
  specificImpulse: number; // s
  catalystMass: number; // 触媒床の質量 [kg]。触媒を要さない二液推進剤では 0
}

export interface SolarPanelPart extends Part {
  readonly type: 'solar_panel';
  area: number; // 受光面積 [m^2]
  efficiency: number; // 太陽光→電力の変換効率 [0-1]
  deployable: boolean;
  tracking: boolean; // 太陽追尾の可否
}

export interface RadiatorPart extends Part {
  readonly type: 'radiator';
  area: number; // 放熱面積 [m^2]
  efficiency: number; // 放熱効率 [0-1]
  deployable: boolean;
}

// 指定方向からの被弾を受け止める。可動のものは電力を消費する(§6-4)。
export interface CombatShieldPart extends Part {
  readonly type: 'combat_shield';
  solidAngle: number; // 遮蔽する立体角 [sr]
  ballisticResistance: number; // 耐弾性能。被弾ダメージの軽減率 [0-1]
  movable: boolean;
  powerDraw: number; // W
}

// アブレータを消耗して大気圏突入から機体を守る(§6-4)。
export interface HeatShieldPart extends Part {
  readonly type: 'heat_shield';
  solidAngle: number; // 遮蔽する立体角 [sr]
  ablatorMass: number; // 残りアブレータ質量 [kg]
  ablationPerHeat: number; // 単位入熱あたりの消耗 [kg/J]
}

export interface CommunicationPart extends Part {
  readonly type: 'communication';
  range: number; // 到達距離 [m]
  bandwidth: number; // 帯域 [bit/s]
  powerDraw: number; // W
  directional: boolean; // 指向の可否
}

export interface RobotArmPart extends Part {
  readonly type: 'robot_arm';
  reach: number; // 到達距離 [m]
  payloadMass: number; // 可搬質量 [kg]
  powerDraw: number; // W
}

export interface DockingPortPart extends Part {
  readonly type: 'docking_port';
  portClass: string; // 適合クラス
  transferRate: number; // 移送速度 [kg/s]
}

export interface ContainerCouplingPart extends Part {
  readonly type: 'container_coupling';
  containerClass: string; // 保持できるコンテナの規格
}

// --- 内装要素 ---

// 推進剤タンクの共通部。酸化剤・還元剤・RCS はいずれもこの形を持つ。容量は宣言せず、
// volume と推進剤の密度(propellant-compatibility.ts の propellantTankCapacity)から導出する。
interface PropellantTankFields {
  readonly propellant: PropellantId;
  volume: number; // 容積 [m^3]
  material: ResourceId; // タンク材
  fuel: number; // 現在量 [kg]
}

export interface OxidizerTankPart extends Part, PropellantTankFields {
  readonly type: 'oxidizer_tank';
  insulationGrade: number; // 断熱等級。大きいほど蒸発損失が小さい
  requiredPressure: number; // 要求与圧 [MPa]
}

export interface ReductantTankPart extends Part, PropellantTankFields {
  readonly type: 'reductant_tank';
  insulationGrade: number;
  requiredPressure: number;
}

export type PressurantGas = 'nitrogen' | 'helium';

export interface PressurantTankPart extends Part {
  readonly type: 'pressurant_tank';
  volume: number; // 容積 [m^3]
  maxPressure: number; // 耐圧 [MPa]
  gas: PressurantGas;
}

export interface RcsTankPart extends Part, PropellantTankFields {
  readonly type: 'rcs_tank';
}

// 推進剤タンク3種のいずれか。PartInventory の集計・消費はこの3種をまとめて扱う。
export type PropellantTankPart = OxidizerTankPart | ReductantTankPart | RcsTankPart;

export function isPropellantTankPart(part: Part): part is PropellantTankPart {
  return part.type === 'oxidizer_tank' || part.type === 'reductant_tank' || part.type === 'rcs_tank';
}

// 主機(酸化剤・還元剤)のタンクか。RCS タンクは主機の供給源ではないので除く —
// isPropellantTankPart とは問いが違う別の述語であり、書き忘れではない。
export function isMainPropellantTank(
  part: Part,
): part is OxidizerTankPart | ReductantTankPart {
  return part.type === 'oxidizer_tank' || part.type === 'reductant_tank';
}

export interface WaterTankPart extends Part {
  readonly type: 'water_tank';
  volume: number; // 容積 [m^3]
  shieldingThickness: number; // 遮蔽の厚み [m]
}

export interface BatteryPart extends Part {
  readonly type: 'battery';
  capacity: number; // 蓄電容量 [J]
  maxOutput: number; // 最大出力 [W]
}

// 水素と酸素から電力と水を作る。再生型は電力で水を電気分解して戻せる(§6-3)。
export interface FuelCellPart extends Part {
  readonly type: 'fuel_cell';
  ratedOutput: number; // 定格出力 [W]
  efficiency: number; // [0-1]
  hydrogenRate: number; // 定格時の水素消費 [kg/s]
  oxygenRate: number; // 定格時の酸素消費 [kg/s]
  regenerative: boolean;
}

// 放射性同位体の崩壊熱を電力に変える。半減期に従って緩やかに減衰する(§6-3)。
export interface RtgPart extends Part {
  readonly type: 'rtg';
  ratedOutput: number; // 打ち上げ時の定格出力 [W]
  halfLife: number; // 半減期 [s]
  // 崩壊熱 [W]。定格出力の14〜16倍あり、そのほぼ全量が廃熱になる。変換効率が等級で違うため
  // 定格出力からは導けない。
  thermalOutput: number;
}

export interface CockpitPart extends Part {
  readonly type: 'cockpit';
  crewCapacity: number; // 搭乗人数
  pressurizedVolume: number; // 必要与圧容積 [m^3]
}

export interface AutopilotPart extends Part {
  readonly type: 'autopilot';
  powerDraw: number; // W
}

// 弾薬の容器。中身は弾薬要素が別に持つ(§6-2)。
export interface MagazinePart extends Part {
  readonly type: 'magazine';
  ammoCapacity: number; // 収納できる弾薬の数
}

export interface AmmunitionPart extends Part {
  readonly type: 'ammunition';
  readonly weaponType: WeaponType; // 対応する武器
  rounds: number; // 1つあたりの発数
}

export interface PlumbingPart extends Part {
  readonly type: 'plumbing';
  readonly propellant: PropellantId;
  bore: number; // 口径 [m]
  maxFlowRate: number; // 最大流量 [kg/s]
}

export interface PayloadBayPart extends Part {
  readonly type: 'payload_bay';
  volume: number; // 内容積 [m^3]
  maxPayloadMass: number; // 最大積載質量 [kg]
  openable: boolean;
}

// 姿勢トルクを出すアクチュエータ。角運動量が飽和したらアンローディングを要する(§14)。
export interface FlywheelPart extends Part {
  readonly type: 'flywheel';
  maxTorque: number; // N·m
  maxAngularMomentum: number; // N·m·s
  powerDraw: number; // W
}

export interface MagnetorquerPart extends Part {
  readonly type: 'magnetorquer';
  maxMagneticMoment: number; // A·m^2
  powerDraw: number; // W
}

// 機体を受け入れる口。ハッチとスロットの位置・法線、受け入れ条件の閾値を持つ。
// ドッキングポートによる結合はまだ無く、格納の判定は距離と相対速度だけで決まる。
export interface DockPort {
  readonly localPos: Vec3;
  readonly localNormal: Vec3;
}

export interface BaseModulePart extends Part {
  readonly type: 'base_module';
  // 中央ハッチ。機体が正面から近づく1つ目の口。
  readonly hatch: DockPort;
  // ドックスロット。格納した機体を並べる場所でもある。
  readonly dockSlots: readonly DockPort[];
  // 格納できる機体数。
  readonly capacity: number;
  // 倉庫容量 [kg]。
  readonly storageCapacity: number;
  // 備える生産設備の id (economy/facility.ts)。
  readonly facilities: readonly string[];
  // 受け入れの閾値。距離 [m] と、口の法線に対する向きの内積の下限。
  readonly hatchCaptureDist: number;
  readonly hatchCaptureAlignment: number;
  readonly slotCaptureDist: number;
  readonly slotCaptureAlignment: number;
  // 相対速度の上限 [m/s]。
  readonly captureRelSpeed: number;
}

export type FarmLightSource = 'led' | 'sunlight';

export interface FarmPart extends Part {
  readonly type: 'farm';
  cultivationArea: number; // 栽培面積 [m^2]
  lightSource: FarmLightSource;
  powerDraw: number; // W
  extraWasteHeat: number; // 消費電力とは別に出る廃熱 [W]
}

export interface LifeSupportPart extends Part {
  readonly type: 'life_support';
  crewCapacity: number; // 処理できる人数
  powerDraw: number; // W
  consumableRate: number; // 消耗品の消費 [kg/s]
  extraWasteHeat: number; // W
}

export interface DockPart extends Part {
  readonly type: 'dock';
  capacity: number; // 収容数
  maxVesselSize: number; // 収容できる機体の最大寸法 [m]
  powerDraw: number; // W
}

export type AnyPart =
  | HullPart | ArmorPart
  | WeaponPart | EnginePart | RcsThrusterPart | SolarPanelPart | RadiatorPart
  | CombatShieldPart | HeatShieldPart | CommunicationPart | RobotArmPart
  | DockingPortPart | ContainerCouplingPart
  | OxidizerTankPart | ReductantTankPart | PressurantTankPart | RcsTankPart | WaterTankPart
  | BatteryPart | FuelCellPart | RtgPart | CockpitPart | AutopilotPart
  | MagazinePart | AmmunitionPart | PlumbingPart | PayloadBayPart
  | FlywheelPart | MagnetorquerPart | BaseModulePart | FarmPart | LifeSupportPart | DockPart;

type ExtractPart<TType extends PartType> = Extract<AnyPart, { type: TType }>;

// 全搭載要素の既定値。createPart はこの表の該当行に overrides を重ねる。
const PART_DEFAULTS: { readonly [K in PartType]: Omit<ExtractPart<K>, 'id' | 'type' | 'name' | 'weight' | 'maxHp' | 'hp'> } = {
  hull: {},
  armor: { damageReduction: 0 },
  weapon: { weaponType: 'gatling', fireRate: 1, damage: 1, muzzleVelocity: 1000, feedRate: 1 },
  engine: {
    cycle: 'pressure_fed', propellant: 'hydrazine', thrust: 0, specificImpulse: 300,
    length: 1, gimbalRange: 0, gimbalRate: 0, throttleMin: 0.4, throttleMax: 1,
    restarts: -1, ignitionPropellantLoss: 0, maxContinuousBurn: Infinity, fuelConsumptionRate: 0,
    catalystMass: 0,
  },
  rcs_thruster: { propellant: 'hydrazine', thrust: 0, specificImpulse: 230, catalystMass: 0 },
  solar_panel: { area: 0, efficiency: 0, deployable: true, tracking: false },
  radiator: { area: 0, efficiency: 1, deployable: true },
  combat_shield: { solidAngle: 0, ballisticResistance: 0, movable: false, powerDraw: 0 },
  heat_shield: { solidAngle: 0, ablatorMass: 0, ablationPerHeat: 0 },
  communication: { range: 0, bandwidth: 0, powerDraw: 0, directional: false },
  robot_arm: { reach: 0, payloadMass: 0, powerDraw: 0 },
  docking_port: { portClass: 'standard', transferRate: 0 },
  container_coupling: { containerClass: 'standard' },
  oxidizer_tank: {
    propellant: 'hydrazine', volume: 0, material: 'structural-metal', fuel: 0, insulationGrade: 1, requiredPressure: 0.3,
  },
  reductant_tank: {
    propellant: 'hydrazine', volume: 0, material: 'structural-metal', fuel: 0, insulationGrade: 1, requiredPressure: 0.3,
  },
  pressurant_tank: { volume: 0, maxPressure: 30, gas: 'nitrogen' },
  rcs_tank: { propellant: 'hydrazine', volume: 0, material: 'structural-metal', fuel: 0 },
  water_tank: { volume: 0, shieldingThickness: 0 },
  battery: { capacity: 0, maxOutput: 0 },
  fuel_cell: { ratedOutput: 0, efficiency: 0.6, hydrogenRate: 0, oxygenRate: 0, regenerative: false },
  rtg: { ratedOutput: 0, halfLife: 87.7 * 365.25 * 86400, thermalOutput: 0 },
  cockpit: { crewCapacity: 1, pressurizedVolume: 5 },
  autopilot: { powerDraw: 0 },
  magazine: { ammoCapacity: 0 },
  ammunition: { weaponType: 'gatling', rounds: 0 },
  plumbing: { propellant: 'hydrazine', bore: 0.01, maxFlowRate: 0 },
  payload_bay: { volume: 0, maxPayloadMass: 0, openable: true },
  flywheel: { maxTorque: 0, maxAngularMomentum: 0, powerDraw: 0 },
  magnetorquer: { maxMagneticMoment: 0, powerDraw: 0 },
  base_module: {
    hatch: { localPos: { x: 0, y: 0, z: 0 } as Vec3, localNormal: { x: 0, y: 1, z: 0 } as Vec3 },
    dockSlots: [], capacity: 0, storageCapacity: 0, facilities: [],
    hatchCaptureDist: 0, hatchCaptureAlignment: 0, slotCaptureDist: 0, slotCaptureAlignment: 0,
    captureRelSpeed: 0,
  },
  farm: { cultivationArea: 0, lightSource: 'led', powerDraw: 0, extraWasteHeat: 0 },
  life_support: { crewCapacity: 0, powerDraw: 0, consumableRate: 0, extraWasteHeat: 0 },
  dock: { capacity: 0, maxVesselSize: 0, powerDraw: 0 },
} as const;

// type の既定値に overrides を重ねてパーツを作る。id は呼び出しごとにランダム発行される。
export function createPart<TType extends PartType>(
  type: TType,
  overrides: Partial<ExtractPart<TType>>
): ExtractPart<TType> {
  const base = {
    id: Math.random().toString(36).slice(2),
    type,
    name: 'Unknown Part',
    weight: 100,
    maxHp: 100,
    hp: 100,
  };
  return { ...base, ...PART_DEFAULTS[type], ...overrides } as unknown as ExtractPart<TType>;
}

// セーブされた AnyPart の生データを createPart 経由で組み立てる。id も引き継ぐので、
// セーブ前後でパーツの同一性(id)が保たれる。
export function partFromSaveData(data: AnyPart): AnyPart {
  return createPart(data.type, data as Partial<AnyPart>) as AnyPart;
}

// この要素が定常で引く電力 [W]。電力は最終的にすべて熱になるので(§6-5)、廃熱の集計も
// この値を土台にする。全損した要素は電力を引かない。
export function powerDrawOf(part: AnyPart): number {
  if (part.hp <= 0) return 0;
  switch (part.type) {
    case 'combat_shield': return part.movable ? part.powerDraw : 0;
    case 'communication': return part.powerDraw;
    case 'robot_arm': return part.powerDraw;
    case 'dock': return part.powerDraw;
    case 'autopilot': return part.powerDraw;
    case 'flywheel': return part.powerDraw;
    case 'magnetorquer': return part.powerDraw;
    case 'farm': return part.powerDraw;
    case 'life_support': return part.powerDraw;
    default: return 0;
  }
}

// 消費電力とは別に出る廃熱 [W]。電照農場と生命維持装置だけが持つ(§6-1)。
export function extraWasteHeatOf(part: AnyPart): number {
  if (part.hp <= 0) return 0;
  switch (part.type) {
    case 'farm': return part.extraWasteHeat;
    case 'life_support': return part.extraWasteHeat;
    default: return 0;
  }
}
