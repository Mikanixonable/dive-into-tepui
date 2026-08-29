// 現実の太陽系。各系の構築関数を呼んで全天体の運動と見た目を組み、宣言順に並べた
// CelestialSystem を返す。ECI の中心(originId)は呼び出し側の選択で、同じ太陽系を別の原点で
// 組める。高精度暦パックを渡すと、その有効期間だけパック経路を通る。
import { AbsoluteEphemeris, OriginCenteredEphemeris } from '../../../physics/absolute-ephemeris';
import { EciOrigin, PhaseOffsets, StarMotion } from '../../../physics/celestial-motion';
import { REFERENCE_STAR_RADIANT_INTENSITY } from '../../../render/pipeline/sun-light';
import { CelestialSystem } from '../celestial-system';
import type { CelestialEntity } from '../celestial-entity';
import { StarEntity } from '../star-entity';
import { PointFieldView } from './point-field-view';
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
export type SolarSystemId =
  | EarthSystemBodyId | InnerPlanetId | MarsSystemBodyId | JupiterSystemBodyId
  | SaturnSystemBodyId | UranusSystemBodyId | NeptuneSystemBodyId | DwarfPlanetId | SmallBodyId
  | 'sun';

// 太陽系の全天体の表示名。各系ファイルの表を1つに合わせたもので、名前の正本は系ファイルのまま。
export const SOLAR_SYSTEM_BODY_NAMES: Record<SolarSystemId, string> = {
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
// earthSpinPhase0 は地球の自転初期位相 [rad]。absoluteSource を渡すと、その有効期間だけ
// 高精度暦パック経路を通る(epochJdTdb はそのパックの元期)。
export function solarSystem(
  originId: SolarSystemId, phases: PhaseOffsets, earthSpinPhase0: number,
  absoluteSource: AbsoluteEphemeris | null, epochOffsetSec: number, epochJdTdb: number,
): CelestialSystem {
  const origin = new EciOrigin();
  const pack = absoluteSource === null
    ? null
    : new OriginCenteredEphemeris(absoluteSource, originId, epochJdTdb);
  const sunMotion = new StarMotion(SUN, phases[SUN.id] ?? 0, epochOffsetSec, pack, origin);
  // 太陽の放射強度は描画の放射照度の目盛りの基準そのもの。
  const sun = new StarEntity(
    sunMotion, SOLAR_SYSTEM_BODY_NAMES.sun, SUN_LIGHT_COLOR,
    REFERENCE_STAR_RADIANT_INTENSITY, SUN_SURFACE_COLOR);

  // 全天体を系ごとの宣言順に並べたもの。重力源配列・天体一覧の順序はこれで決まる。
  const bodies: readonly CelestialEntity[] = [
    ...Object.values(earthSystem(sunMotion, phases, epochOffsetSec, pack, origin, earthSpinPhase0)),
    ...Object.values(innerPlanets(sunMotion, phases, epochOffsetSec, pack, origin)),
    ...Object.values(marsSystem(sunMotion, phases, epochOffsetSec, pack, origin)),
    ...Object.values(jupiterSystem(sunMotion, phases, epochOffsetSec, pack, origin)),
    ...Object.values(saturnSystem(sunMotion, phases, epochOffsetSec, pack, origin)),
    ...Object.values(uranusSystem(sunMotion, phases, epochOffsetSec, pack, origin)),
    ...Object.values(neptuneSystem(sunMotion, phases, epochOffsetSec, pack, origin)),
    ...Object.values(dwarfPlanets(sunMotion, phases, epochOffsetSec, pack, origin)),
    ...Object.values(smallBodies(sunMotion, phases, epochOffsetSec, pack, origin)),
    sun,
  ];

  // 木が揃ってから ECI の中心を結ぶ。中心天体自身も自分を参照するので、この順序は崩せない。
  const originBody = bodies.find((b) => b.id === originId);
  if (originBody === undefined) throw new Error(`solarSystem: 太陽系に無い原点 id: ${originId}`);
  origin.set(originBody.motion);

  return new CelestialSystem(bodies, originBody, phases, new PointFieldView());
}
