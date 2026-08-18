// 既定の設計が積む搭載要素の一覧。HP の配分比と、各部品の性能値をここで決める。
import * as C from '../const';
import { v3 } from '../../physics/vec3';
import type { AnyPart, BaseModulePart, DockPort, PartType } from '../game-entity/parts';
import { createPart } from '../game-entity/parts';

// 既定の基地モジュール。中腹のドッキングパレット上部に中央ハッチ、その四隅にスロットを持つ。
export function createDefaultBaseModule(maxHp: number): BaseModulePart {
  const up = v3(0, 1, 0);
  const slot = (x: number, z: number): DockPort => ({ localPos: v3(x, 21.0, z), localNormal: up });
  return createPart('base_module', {
    name: 'Base Module',
    weight: BASE_WEIGHT.baseModule,
    maxHp,
    hp: maxHp,
    hatch: { localPos: v3(0, 21.0, 0), localNormal: up },
    dockSlots: [slot(-16.5, -16.5), slot(16.5, -16.5), slot(-16.5, 16.5), slot(16.5, 16.5)],
    capacity: C.BASE_MAX_VESSELS,
    storageCapacity: 1e6,
    facilities: [],
    hatchCaptureDist: 80,
    hatchCaptureAlignment: 0.5,
    slotCaptureDist: 50,
    slotCaptureAlignment: 0.5,
    captureRelSpeed: 20,
  });
}

// 既定パーツへの HP 配分比。合計 1 になるよう保つ(機体の maxHp をこの比で割り振る)。
// 放熱板・太陽電池パドルは機体の左右2枚ぶんなので、パーツも side ごとに1枚ずつ持つ。
const CREWED_HP_RATIO = {
  hull: 0.32, cockpit: 0.08, engine: 0.07, rcsThruster: 0.03, flywheel: 0.03, rcsTank: 0.07,
  radiator: 0.05, solarPanel: 0.03, weapon: 0.07, magazine: 0.02, ammunition: 0.02,
  battery: 0.03, communication: 0.02, lifeSupport: 0.03, armor: 0.05,
} as const;

// 無人の敵対機の HP 配分比。船体・主機・姿勢制御・タンク・武装・装甲へ配る。合計 1 になるよう保つ。
const HOSTILE_HP_RATIO = {
  hull: 0.45, engine: 0.10, flywheel: 0.05, rcsTank: 0.08, weapon: 0.15, armor: 0.17,
} as const;

// 既定パーツの質量 [kg]。主要構造は外皮そのものであり、その質量は形状と肉厚から導かれるので
// (§10-3)、hull 要素自身は質量を持たない。
const CREWED_WEIGHT = {
  hull: 0, cockpit: 135, engine: 90, rcsThruster: 8, flywheel: 25, rcsTank: 30,
  radiator: 18, solarPanel: 12, weapon: 60, magazine: 20, ammunition: 40,
  battery: 45, communication: 15, lifeSupport: 80, armor: 60,
} as const;

const HOSTILE_WEIGHT = {
  hull: 0, engine: 800, flywheel: 300, rcsTank: 600, weapon: 900, armor: 1100,
} as const;

const BASE_WEIGHT = {
  baseModule: 1.5e6, cockpit: 6e5, engine: 3e4, flywheel: 2e4, rcsTank: 5e5,
} as const;

// 既定の有人艦が積む要素の消費電力 [W]。合計が C.CREWED_POWER_DRAW と一致する。
const CREWED_DRAW = { communication: 30, flywheel: 60, lifeSupport: 400 } as const;
// 生命維持装置が消費電力とは別に出す廃熱 [W]。乗員の代謝ぶん。
const LIFE_SUPPORT_EXTRA_HEAT = 100;

// maxHp を CREWED_HP_RATIO で割り振った、有人機の既定の搭載要素一式。
export function crewedParts(maxHp: number): AnyPart[] {
  const R = CREWED_HP_RATIO;
  const share = (ratio: number): number => Math.max(1, Math.round(maxHp * ratio));
  const W = CREWED_WEIGHT;
  const mk = <T extends PartType>(type: T, ratio: number, props: object): AnyPart =>
    createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
  return [
    mk('hull', R.hull, { name: 'Basic Hull', weight: W.hull }),
    mk('cockpit', R.cockpit, { name: 'Cockpit', crewCapacity: 2, pressurizedVolume: 8, weight: W.cockpit }),
    mk('engine', R.engine, {
      weight: CREWED_WEIGHT.engine, name: 'Main Engine', cycle: 'pressure_fed', propellant: 'nitrogen-tetroxide',
      // 既定パーツだけを積んだ機体が、全開で THROTTLE_LEVELS の最大値の加速度になる推力。
      thrust: C.PLAYER_MASS * C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!,
      specificImpulse: 320, length: 1.4, gimbalRange: 6, gimbalRate: 10,
      throttleMin: 0.4, throttleMax: 1, fuelConsumptionRate: 1,
    }),
    mk('rcs_thruster', R.rcsThruster, {
      weight: CREWED_WEIGHT.rcsThruster, name: 'Translation RCS', propellant: 'hydrazine',
      thrust: C.PLAYER_MASS * C.THROTTLE_LEVELS[0]!, specificImpulse: 230,
    }),
    mk('flywheel', R.flywheel, {
      weight: CREWED_WEIGHT.flywheel, name: 'Reaction Wheel',
      maxTorque: C.MAX_ANG_ACCEL * Math.max(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL),
      maxAngularMomentum: 400, powerDraw: CREWED_DRAW.flywheel,
    }),
    mk('rcs_tank', R.rcsTank, {
      weight: CREWED_WEIGHT.rcsTank, name: 'Main RCS Tank', propellant: 'hydrazine', volume: 1.0, material: 'aluminium',
      maxFuel: C.CREWED_RCS_FUEL_CAPACITY, fuel: C.CREWED_RCS_FUEL_CAPACITY,
    }),
    mk('radiator', R.radiator, {
      weight: CREWED_WEIGHT.radiator, name: 'Heat Radiator L',
      area: C.RADIATOR_COOLING_AREA / 2, efficiency: C.RADIATOR_EFFICIENCY_MULT, deployable: true,
    }),
    mk('radiator', R.radiator, {
      weight: CREWED_WEIGHT.radiator, name: 'Heat Radiator R',
      area: C.RADIATOR_COOLING_AREA / 2, efficiency: C.RADIATOR_EFFICIENCY_MULT, deployable: true,
    }),
    mk('solar_panel', R.solarPanel, {
      weight: CREWED_WEIGHT.solarPanel, name: 'Solar Array L',
      area: C.SOLAR_PANEL_AREA / 2, efficiency: C.SOLAR_PANEL_EFFICIENCY, deployable: true, tracking: false,
    }),
    mk('solar_panel', R.solarPanel, {
      weight: CREWED_WEIGHT.solarPanel, name: 'Solar Array R',
      area: C.SOLAR_PANEL_AREA / 2, efficiency: C.SOLAR_PANEL_EFFICIENCY, deployable: true, tracking: false,
    }),
    mk('weapon', R.weapon, {
      weight: CREWED_WEIGHT.weapon, name: 'Gatling Gun', weaponType: 'gatling',
      fireRate: 1 / C.FIRE_INTERVAL, damage: C.ENEMY_BULLET_DAMAGE, muzzleVelocity: C.MUZZLE_SPEED,
      feedRate: 1 / C.FIRE_INTERVAL,
    }),
    mk('magazine', R.magazine, { name: 'Magazine Rack', ammoCapacity: C.INITIAL_MAGS, weight: CREWED_WEIGHT.magazine }),
    mk('ammunition', R.ammunition, { name: 'Gatling Rounds', weaponType: 'gatling', rounds: C.MAG_ROUNDS, weight: CREWED_WEIGHT.ammunition }),
    mk('battery', R.battery, { name: 'Main Battery', capacity: C.POWER_CAPACITY, maxOutput: 5000, weight: CREWED_WEIGHT.battery }),
    mk('communication', R.communication, {
      weight: CREWED_WEIGHT.communication, name: 'Relay', range: 4e8, bandwidth: 2e6, powerDraw: CREWED_DRAW.communication, directional: true,
    }),
    mk('life_support', R.lifeSupport, {
      weight: CREWED_WEIGHT.lifeSupport, name: 'Life Support', crewCapacity: 2, powerDraw: CREWED_DRAW.lifeSupport,
      consumableRate: 1e-5, extraWasteHeat: LIFE_SUPPORT_EXTRA_HEAT,
    }),
    mk('armor', R.armor, { name: 'Light Armor', damageReduction: 0.2, weight: CREWED_WEIGHT.armor }),
  ];
}

// maxHp を HOSTILE_HP_RATIO で割り振った、無人の敵対機の搭載要素一式。
export function hostileParts(maxHp: number): AnyPart[] {
  const R = HOSTILE_HP_RATIO;
  const share = (ratio: number): number => Math.max(1, Math.round(maxHp * ratio));
  const mk = <T extends PartType>(type: T, ratio: number, props: object): AnyPart =>
    createPart(type, { maxHp: share(ratio), hp: share(ratio), ...props } as never);
  return [
    mk('hull', R.hull, { name: 'Hostile Hull', weight: HOSTILE_WEIGHT.hull }),
    mk('engine', R.engine, {
      weight: HOSTILE_WEIGHT.engine, name: 'Hostile Engine', cycle: 'pressure_fed', propellant: 'nitrogen-tetroxide',
      thrust: 0, specificImpulse: 300, fuelConsumptionRate: 1,
    }),
    mk('flywheel', R.flywheel, {
      weight: HOSTILE_WEIGHT.flywheel, name: 'Hostile Reaction Wheel', maxTorque: C.MAX_ANG_ACCEL, maxAngularMomentum: 400, powerDraw: 0,
    }),
    mk('rcs_tank', R.rcsTank, {
      weight: HOSTILE_WEIGHT.rcsTank, name: 'Hostile Tank', propellant: 'hydrazine', volume: 1.0, material: 'aluminium',
      maxFuel: 1000, fuel: 1000,
    }),
    mk('weapon', R.weapon, {
      weight: HOSTILE_WEIGHT.weapon, name: 'Plasma Cannon', weaponType: 'cannon',
      fireRate: 1 / C.ENEMY_FIRE_INTERVAL, damage: C.PLAYER_BULLET_DAMAGE,
      muzzleVelocity: C.PLASMA_BULLET_SPEED, feedRate: 1 / C.ENEMY_FIRE_INTERVAL,
    }),
    mk('armor', R.armor, { name: 'Hostile Armor', damageReduction: 0.2, weight: HOSTILE_WEIGHT.armor }),
  ];
}

// 軌道基地の搭載要素一式。基地モジュールと管制室に加え、軌道保持用の小さな主機を積む。
export function baseParts(maxHp: number): AnyPart[] {
  const half = Math.round(maxHp * 0.5);
  return [
    createDefaultBaseModule(half),
    createPart('cockpit', {
      name: 'Control Room', maxHp: half, hp: half, weight: BASE_WEIGHT.cockpit, crewCapacity: 8, pressurizedVolume: 200,
    }),
    createPart('engine', {
      name: 'Station Keeping Engine', maxHp: 1, hp: 1, weight: BASE_WEIGHT.engine,
      cycle: 'pressure_fed', propellant: 'nitrogen-tetroxide',
      thrust: C.BASE_THRUST, specificImpulse: 300, fuelConsumptionRate: C.BASE_FUEL_RATE,
    }),
    createPart('flywheel', {
      name: 'Station Reaction Wheel', maxHp: 1, hp: 1, weight: BASE_WEIGHT.flywheel,
      maxTorque: C.BASE_TORQUE, maxAngularMomentum: 1e6, powerDraw: 0,
    }),
    createPart('rcs_tank', {
      name: 'Station Tank', maxHp: 1, hp: 1, weight: BASE_WEIGHT.rcsTank,
      propellant: 'hydrazine', volume: 40, material: 'aluminium',
      maxFuel: C.BASE_MAX_FUEL, fuel: C.BASE_MAX_FUEL,
    }),
  ];
}
