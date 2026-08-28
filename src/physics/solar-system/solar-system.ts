// 現実の太陽系。各系の構築関数を呼んで全天体の運動を組み、系ごとの名前付きフィールドと
// 宣言順の一覧(all)で返す。ECI の中心(originId)は呼び出し側の選択で、同じ太陽系を別の
// 原点で組める。高精度暦パックを渡すと、その有効期間だけパック経路を通る。
import { AbsoluteEphemeris, OriginCenteredEphemeris } from '../absolute-ephemeris';
import { CelestialMotion, EciOrigin, PhaseOffsets, StarMotion } from '../celestial-motion';
import { DwarfPlanetMotions, dwarfPlanets } from './dwarf-planets';
import { EarthSystemMotions, earthSystem } from './earth-system';
import { InnerPlanetMotions, innerPlanets } from './inner-planets';
import { JupiterSystemMotions, jupiterSystem } from './jupiter-system';
import { MarsSystemMotions, marsSystem } from './mars-system';
import { NeptuneSystemMotions, neptuneSystem } from './neptune-system';
import { SUN } from './sun';
import { SaturnSystemMotions, saturnSystem } from './saturn-system';
import { SmallBodyMotions, smallBodies } from './small-bodies';
import { UranusSystemMotions, uranusSystem } from './uranus-system';

export type SolarSystemMotions = {
  readonly sun: StarMotion;
  readonly earthSystem: EarthSystemMotions;
  readonly innerPlanets: InnerPlanetMotions;
  readonly marsSystem: MarsSystemMotions;
  readonly jupiterSystem: JupiterSystemMotions;
  readonly saturnSystem: SaturnSystemMotions;
  readonly uranusSystem: UranusSystemMotions;
  readonly neptuneSystem: NeptuneSystemMotions;
  readonly dwarfPlanets: DwarfPlanetMotions;
  readonly smallBodies: SmallBodyMotions;
  // 全天体を系ごとの宣言順に並べたもの。重力源配列・天体一覧の順序はこれで決まる。
  readonly all: readonly CelestialMotion[];
};

// 太陽系に登録された天体の id。各系の名前付きフィールドがそのまま id になる。
export type SolarSystemId =
  | keyof EarthSystemMotions | keyof InnerPlanetMotions | keyof MarsSystemMotions
  | keyof JupiterSystemMotions | keyof SaturnSystemMotions | keyof UranusSystemMotions
  | keyof NeptuneSystemMotions | keyof DwarfPlanetMotions | keyof SmallBodyMotions
  | 'sun';

// 太陽系の全天体の運動を組む。phases は天体ごとの平均黄経の初期位相 [rad]、epochOffsetSec は
// 全天体の軌道評価時刻へ一律に足す定数 [s]。absoluteSource を渡すと、その有効期間だけ
// 高精度暦パック経路を通る(epochJdTdb はそのパックの元期)。
export function solarSystemMotions(
  originId: SolarSystemId, phases: PhaseOffsets, epochOffsetSec: number,
  absoluteSource: AbsoluteEphemeris | null, epochJdTdb: number,
): SolarSystemMotions {
  const origin = new EciOrigin();
  const pack = absoluteSource === null
    ? null
    : new OriginCenteredEphemeris(absoluteSource, originId, epochJdTdb);
  const sun = new StarMotion(SUN, phases[SUN.id] ?? 0, epochOffsetSec, pack, origin);
  const earth = earthSystem(sun, phases, epochOffsetSec, pack, origin);
  const inner = innerPlanets(sun, phases, epochOffsetSec, pack, origin);
  const mars = marsSystem(sun, phases, epochOffsetSec, pack, origin);
  const jupiter = jupiterSystem(sun, phases, epochOffsetSec, pack, origin);
  const saturn = saturnSystem(sun, phases, epochOffsetSec, pack, origin);
  const uranus = uranusSystem(sun, phases, epochOffsetSec, pack, origin);
  const neptune = neptuneSystem(sun, phases, epochOffsetSec, pack, origin);
  const dwarfs = dwarfPlanets(sun, phases, epochOffsetSec, pack, origin);
  const small = smallBodies(sun, phases, epochOffsetSec, pack, origin);

  const all: readonly CelestialMotion[] = [
    ...Object.values(earth), ...Object.values(inner), ...Object.values(mars),
    ...Object.values(jupiter), ...Object.values(saturn), ...Object.values(uranus),
    ...Object.values(neptune), ...Object.values(dwarfs), ...Object.values(small),
    sun,
  ];
  // 木が揃ってから ECI の中心を結ぶ。中心天体自身も自分を参照するので、この順序は崩せない。
  const originMotion = all.find((m) => m.id === originId);
  if (originMotion === undefined) throw new Error(`solarSystemMotions: 太陽系に無い原点 id: ${originId}`);
  origin.set(originMotion);

  return {
    sun,
    earthSystem: earth,
    innerPlanets: inner,
    marsSystem: mars,
    jupiterSystem: jupiter,
    saturnSystem: saturn,
    uranusSystem: uranus,
    neptuneSystem: neptune,
    dwarfPlanets: dwarfs,
    smallBodies: small,
    all,
  };
}
