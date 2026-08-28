// デバッグ用ステージ: 現実の太陽系とは無関係な架空のレジストリ・原点で進行する。恒星を
// 1体も持たないため、輻射源・日照率・点群などの太陽系依存の経路が恒星0個でも安全に振る舞う
// ことを実演する。タイトルの通常ボタン列には出ない。
import { Stage, type StageDeps } from './stage';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../simulation/sim-speed-manager';
import * as C from '../const';
import {
  CelestialMotion, EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion,
} from '../../physics/celestial-motion';
import { planetOrbit } from '../../physics/planet-orbit';
import { satelliteOrbit } from '../../physics/satellite-orbit';
import { keplerPeriod, stateFromOrbitalElements } from '../../physics/elements';
import { kinematicState } from '../../physics/kinematic-state';
import { add } from '../../math/vec3';
import type { StageSaveData } from '../save/save-data';
import { Ephemeris } from '../../physics/ephemeris';

const PRIMARY_ID = 'zephyrus';
const MOON_ID = 'zephyrus-i';
const PRIMARY_MU = 4e13; // [m^3/s^2] (火星と土星の中間程度)
const PRIMARY_RADIUS = 3e6; // [m]

// 原点天体自身の日心軌道は ECI 化で厳密に打ち消される(stateOf が自分自身の日心状態を
// 引くため)ので値に意味は無いが、PlanetDef が要求する形は満たす。
const ZERO_HELIOCENTRIC_ORBIT = planetOrbit({
  a: 1, e: 0, incDeg: 0, raanDeg: 0, lonPeriDeg: 0, l0Deg: 0,
  lRateDegPerCentury: 0, raanRateDegPerCentury: 0, incRateDegPerCentury: 0,
  lonPeriRateDegPerCentury: 0, eRatePerCentury: 0, aRatePerCenturyAu: 0,
});

// 恒星を持たない架空の2体系: 惑星 zephyrus(原点・重力源)+ その衛星 zephyrus-i(重力源)。
const ZEPHYRUS: PlanetDef = {
  id: PRIMARY_ID,
  mu: PRIMARY_MU,
  radius: PRIMARY_RADIUS,
  orbit: ZERO_HELIOCENTRIC_ORBIT,
};
const ZEPHYRUS_I: SatelliteDef = {
  id: MOON_ID,
  mu: 1e11,
  radius: 2e5,
  orbit: satelliteOrbit({
    a: 2e7, e: 0.05, incDeg: 10,
    raan0Deg: 0, lonPeri0Deg: 0, l0Deg: 0,
    periodSec: keplerPeriod(2e7, PRIMARY_MU),
    nodePeriodSec: Infinity, perigeePeriodSec: Infinity,
    lonTerms: [], latTerms: [], distTerms: [],
  }),
};

// 架空星系の運動を組む。恒星が無いので惑星の主星は null になる。
function zephyrusSystemMotions(phases: PhaseOffsets): readonly CelestialMotion[] {
  const origin = new EciOrigin();
  const zephyrus = new PlanetMotion(ZEPHYRUS, null, phases[PRIMARY_ID] ?? 0, 0, null, origin);
  const zephyrusI = new SatelliteMotion(ZEPHYRUS_I, zephyrus, phases[MOON_ID] ?? 0, 0, null, origin);
  origin.set(zephyrus);
  return [zephyrus, zephyrusI];
}

export class StageDebugAltSystem extends Stage {
  static readonly id = 'debug-alt-system' as const;
  static async createEphemeris(phaseOffsets: PhaseOffsets): Promise<Ephemeris> {
    return new Ephemeris(zephyrusSystemMotions(phaseOffsets), PRIMARY_ID, phaseOffsets);
  }
  static readonly selectLabel = 'DEBUG(架空星系)';
  static readonly selectSub = '【デバッグ】恒星0個・架空天体2体のレジストリで起動する';
  static readonly hiddenFromSelect = true;
  static readonly selectKeys = ['KeyE'];

  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.begin();
  }

  briefingHtml(): string {
    return `<b>架空星系デバッグステージ</b><br>恒星0個・${PRIMARY_ID} 系で起動`;
  }

  // 自機を zephyrus の低軌道へ置く(このレジストリでは既定の地球 LEO に意味が無い)。
  protected init(): void {
    const t = this._simulator.simTime;
    const primary = this._ephemeris.celestialBodiesAt(t).find((a) => a.id === PRIMARY_ID)!;
    const rel = stateFromOrbitalElements(t, PRIMARY_RADIUS + 5e5, 0, 0, 0, 0, 0, primary.mu);
    this.addPlayer({
      state: kinematicState(t, add(primary.state.r, rel.r), add(primary.state.v, rel.v)),
      ammo: { mags: 20, rounds: C.MAG_ROUNDS },
    });
  }

  update(_dt: number, player: Player | null, _entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!player) return;
    this.logistics.updateLogistics(simTime, player, simSpeed);
  }

  // 検証を継続できるよう、勝敗を発生させない(UnlockManager のクリア数にも入らない)。
  checkWin(): boolean {
    return false;
  }
}
