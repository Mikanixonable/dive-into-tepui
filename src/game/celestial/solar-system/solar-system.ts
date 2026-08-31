// 現実の太陽系。各系の構築関数を呼んで全天体の運動と見た目を組み、宣言順に並べた
// CelestialSystem を返す。ECI の中心(originId)は呼び出し側の選択で、同じ太陽系を別の原点で
// 組める。数値暦を渡すと、収録された天体はその有効期間で数値暦経路を通る。
import { EphemerisPoints } from '../../../physics/ephemeris/point';
import { PhaseOffsets, StarMotion } from '../../../physics/celestial-motion';
import { REFERENCE_STAR_RADIANT_INTENSITY } from '../../../render/pipeline/sun-light';
import { CelestialSystem } from '../celestial-system';
import { ephemerisSeconds, TdbJulianDate } from '../../../physics/time';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { StarEntity } from '../celestial-entity/star-entity';
import { PointFieldView } from '../point-field-view';
import { generatePointField } from './point-field';
import { DwarfPlanetId, DWARF_PLANET_NAMES, dwarfPlanets } from './dwarf-planets';
import { EarthSystemBodyId, EARTH_SYSTEM_NAMES, earthSystem } from './earth-system';
import { InnerPlanetId, INNER_PLANET_NAMES, innerPlanets } from './inner-planets';
import { JupiterSystemBodyId, JUPITER_SYSTEM_NAMES, jupiterSystem } from './jupiter-system';
import { MarsSystemBodyId, MARS_SYSTEM_NAMES, marsSystem } from './mars-system';
import { NeptuneSystemBodyId, NEPTUNE_SYSTEM_NAMES, neptuneSystem } from './neptune-system';
import { SaturnSystemBodyId, SATURN_SYSTEM_NAMES, saturnSystem } from './saturn-system';
import { SmallBodyId, SMALL_BODY_NAMES, smallBodies } from './small-bodies';
import { SUN, SUN_LIGHT_COLOR, SUN_SURFACE_COLOR } from './sun';
import { UranusSystemBodyId, URANUS_SYSTEM_NAMES, uranusSystem } from './uranus-system';

// 太陽系に登録された天体の id。各系の id 集合を合わせたもの。
type SolarSystemId =
  | EarthSystemBodyId | InnerPlanetId | MarsSystemBodyId | JupiterSystemBodyId
  | SaturnSystemBodyId | UranusSystemBodyId | NeptuneSystemBodyId | DwarfPlanetId | SmallBodyId
  | 'sun';

// 太陽系の全天体の表示名。各系ファイルの表を1つに合わせたもので、名前の正本は系ファイルのまま。
const SOLAR_SYSTEM_BODY_NAMES: Record<SolarSystemId, string> = {
  sun: '太陽',
  ...EARTH_SYSTEM_NAMES,
  ...INNER_PLANET_NAMES,
  ...MARS_SYSTEM_NAMES,
  ...JUPITER_SYSTEM_NAMES,
  ...SATURN_SYSTEM_NAMES,
  ...URANUS_SYSTEM_NAMES,
  ...NEPTUNE_SYSTEM_NAMES,
  ...DWARF_PLANET_NAMES,
  ...SMALL_BODY_NAMES,
};

// 天体 id の表示名。星系を組まずに引ける静的な引き先で、太陽系に無い id はそのまま返す。
export function solarSystemBodyName(id: string): string {
  return SOLAR_SYSTEM_BODY_NAMES[id as SolarSystemId] ?? id;
}

// 太陽系の CelestialSystem を組む。originId は ECI の中心天体(ステージの選択)、
// earthSpinPhase0 は地球の自転初期位相 [rad]、epoch は simTime=0 が指す絶対時刻。
// ephemerisPoints を渡すと、そこに載っている天体だけがその有効期間で数値暦経路を通る。
export function solarSystem(
  originId: SolarSystemId, phases: PhaseOffsets, earthSpinPhase0: number,
  ephemerisPoints: EphemerisPoints | null, epoch: TdbJulianDate,
): CelestialSystem {
  // 要素・極モデルの元期(J2000)から simTime=0 へ畳むための秒数。元期の唯一の表現である
  // epoch からその場で導く — 別の値として持ち回ると、片方だけが古くなる。
  const simZeroEt = ephemerisSeconds(epoch);
  const sunMotion = new StarMotion(SUN);
  // 太陽の放射強度は描画の放射照度の目盛りの基準そのもの。
  const sun = new StarEntity(
    sunMotion, SOLAR_SYSTEM_BODY_NAMES.sun, SUN_LIGHT_COLOR,
    REFERENCE_STAR_RADIANT_INTENSITY, SUN_SURFACE_COLOR);

  // 全天体を系ごとの宣言順に並べたもの。重力源配列・天体一覧の順序はこれで決まる。
  const entities: readonly CelestialEntity[] = [
    ...Object.values(earthSystem(sunMotion, phases, simZeroEt, earthSpinPhase0)),
    ...Object.values(innerPlanets(sunMotion, phases, simZeroEt)),
    ...Object.values(marsSystem(sunMotion, phases, simZeroEt)),
    ...Object.values(jupiterSystem(sunMotion, phases, simZeroEt)),
    ...Object.values(saturnSystem(sunMotion, phases, simZeroEt)),
    ...Object.values(uranusSystem(sunMotion, phases, simZeroEt)),
    ...Object.values(neptuneSystem(sunMotion, phases, simZeroEt)),
    ...Object.values(dwarfPlanets(sunMotion, phases, simZeroEt)),
    ...Object.values(smallBodies(sunMotion, phases, simZeroEt)),
    sun,
  ];

  const originEntity = entities.find((b) => b.id === originId);
  if (originEntity === undefined) throw new Error(`solarSystem: 太陽系に無い原点 id: ${originId}`);

  return new CelestialSystem(
    entities, originEntity, phases, epoch, new PointFieldView(generatePointField(simZeroEt)),
    ephemerisPoints);
}
