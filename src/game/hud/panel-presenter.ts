import { len, sub } from '../../math/vec3';
import { mapScaleFor } from './map-scale';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { ProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';
import { orbitInfo, relativeInfo } from '../orbit-info';
import type { CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { CelestialMotion } from '../../physics/celestial-motion';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { NavTarget } from '../nav-target';
import type { OrbitReference, OrbitReferenceMode } from '../orbit-reference';
import type { Vec3 } from '../../math/vec3';
import type { Enemy } from '../dynamic/dynamic-entity/enemy';
import type { OrbitPanelViewModel } from './orbit/orbit-panel';
import type { EnemyRow, EnemiesPanelViewModel } from './panels/enemies-panel';
import type { MapScaleViewModel } from './panels/map-scale-badge';
import type { TargetPanelData } from './panels/target-panel';
import type { TopBarViewModel } from './panels/top-bar';
import type { VesselPanelViewModel } from './panels/vessel-panel';

interface TopBarSource {
  readonly simTime: number;
  readonly displayWindowManager: {
    readonly current: {
      readonly epochUnixSec: number;
    };
  };
  readonly simSpeedManager: {
    readonly simSpeed: number;
    estimatedRealSecondsToWarpEnd(simTime: number): number | null;
    remainingSimulationSeconds(simTime: number): number | null;
  };
  readonly isPaused: boolean;
}

interface MapScaleSource {
  readonly viewManager: {
    readonly isMapView: boolean;
  };
  readonly cameraSystem: {
    readonly mapCamera: {
      readonly resolvedFocus: Vec3;
    };
    readonly activeCameraScale: (worldPos: Vec3) => number;
  };
}

interface VesselPanelSource {
  readonly activeControllable: Controllable | null;
  readonly viewManager: {
    readonly isMapView: boolean;
  };
  readonly activeStage: {
    readonly id: string;
  };
  readonly cameraSystem: {
    readonly combatCamera: {
      readonly rotationFollow: {
        readonly kind: string;
      } | null;
    };
  };
}

interface OrbitPanelSource {
  readonly activeControllable: Controllable | null;
  readonly celestialSystem: CelestialSystem;
  readonly orbitReference: {
    readonly selectedMode: OrbitReferenceMode;
    resolve(
      r: Vec3,
      celestialBodies: readonly CelestialMotion[],
      navTarget: NavTarget,
      dynamicSystem: DynamicSystem,
      celestialSystem: CelestialSystem,
      t: number,
    ): OrbitReference;
  };
  readonly navTarget: NavTarget;
  readonly dynamicSystem: DynamicSystem;
}

interface TargetPanelSource {
  readonly activeControllable: Controllable | null;
  readonly targeter: {
    readonly aliveTarget: CombatTarget | null;
  };
  readonly celestialSystem: {
    readonly celestialMotions: readonly CelestialMotion[];
  };
}

interface EnemiesPanelSource {
  readonly activeControllable: Controllable | null;
  readonly activeStage: {
    readonly scoreCounter: {
      readonly kills: number;
      readonly totalEnemiesSpawned: number;
    };
  };
  readonly dynamicSystem: {
    all(): readonly DynamicEntity[];
  };
  readonly targeter: {
    readonly aliveTarget: CombatTarget | null;
  };
}

export function topBarViewOf(source: TopBarSource): TopBarViewModel {
  const simTime = source.simTime;
  return {
    epochUnixSec: source.displayWindowManager.current.epochUnixSec,
    simTime,
    simSpeed: source.simSpeedManager.simSpeed,
    autoWarpRealSecondsRemaining: source.simSpeedManager.estimatedRealSecondsToWarpEnd(simTime),
    autoWarpSimulationSecondsRemaining: source.simSpeedManager.remainingSimulationSeconds(simTime),
    isPaused: source.isPaused,
  };
}

export function mapScaleViewOf(source: MapScaleSource): MapScaleViewModel {
  const visible = source.viewManager.isMapView;
  if (!visible) return { visible, scale: null };
  const focus = source.cameraSystem.mapCamera.resolvedFocus;
  const metersPerPixel = source.cameraSystem.activeCameraScale(focus);
  const scale = mapScaleFor(metersPerPixel);
  return { visible, scale };
}

export function vesselPanelViewOf(source: VesselPanelSource): VesselPanelViewModel | null {
  const target = source.activeControllable;
  if (!target) return null;
  return {
    visible: !source.viewManager.isMapView || source.activeStage.id === 'creative',
    rcsDamp: target.throttle.rcsDamp,
    throttleIdx: target.throttle.throttleIdx,
    aeroQdyn: target.aero?.qdyn ?? null,
    fineAttitude: target.fineAttitude,
    cameraFollowsAttitude: source.cameraSystem.combatCamera.rotationFollow?.kind === 'attitude',
    progradeHold: target.throttle.progradeHold,
    totalFuel: target.totalFuel,
    totalMaxFuel: target.totalMaxFuel,
    fire: target.fire
      ? { rounds: target.fire.rounds, mags: target.fire.mags, cooldown: target.fire.cooldown }
      : null,
    solarDeploy: target.power
      ? { up: target.power.deployOf('up'), down: target.power.deployOf('down') }
      : null,
    radiator: target.radiator
      ? {
        up: { deploy: target.radiator.deployOf('up'), wear: target.radiator.wearOf('up') },
        down: { deploy: target.radiator.deployOf('down'), wear: target.radiator.wearOf('down') },
      }
      : null,
  };
}

export function orbitPanelViewOf(source: OrbitPanelSource): OrbitPanelViewModel | null {
  const entity = source.activeControllable;
  if (!entity) return null;
  const celestialBodies = source.celestialSystem.celestialMotions;
  const reference = source.orbitReference.resolve(
    entity.state.r, celestialBodies, source.navTarget, source.dynamicSystem, source.celestialSystem, entity.state.t,
  );
  const info = orbitInfo(entity, reference, entity.state.t, (id) => source.celestialSystem.nameOf(id));
  return {
    selectedMode: source.orbitReference.selectedMode,
    centerId: info.centerId,
    centerName: !reference.attractor && source.navTarget.name ? source.navTarget.name : info.centerName,
    altitudeM: info.alt,
    speedMps: info.spd,
    apAltitudeM: info.apAlt,
    peAltitudeM: info.peAlt,
    inclinationDeg: info.incDeg,
    periodSec: info.period,
    qdyn: entity.aero?.qdyn ?? null,
    temperatureK: entity.temperature,
    altitudeWarning: entity.altitudeAlarm?.descendWarned ?? false,
  };
}

export function targetPanelDataOf(source: TargetPanelSource): TargetPanelData | null {
  const viewer = source.activeControllable;
  const target = viewer ? source.targeter.aliveTarget : null;
  if (!viewer || !target) return null;
  const relative = relativeInfo(viewer, target, source.celestialSystem.celestialMotions, viewer.state.t);
  return {
    name: target.name,
    distanceM: relative.dist,
    closingMps: relative.closing,
    relativeSpeedMps: relative.relSpeed,
    hp: target.hp,
    maxHp: target.maxHp,
    protein: target instanceof ProteinEnemy ? target.hudSnapshot : null,
  };
}

export function enemiesPanelViewOf(source: EnemiesPanelSource): EnemiesPanelViewModel {
  const viewer = source.activeControllable;
  if (!viewer) return { visible: false, remainingCount: 0, totalCount: 0, rows: [] };
  const { kills, totalEnemiesSpawned } = source.activeStage.scoreCounter;
  const enemies = source.dynamicSystem.all().filter(isEnemy).filter((enemy) => enemy.alive);
  return {
    visible: true,
    remainingCount: totalEnemiesSpawned - kills,
    totalCount: totalEnemiesSpawned,
    rows: enemyRowsOf(enemies, viewer.state.r, source.targeter.aliveTarget),
  };
}

function enemyRowsOf(
  enemies: readonly Enemy[], viewerPositionEci: Vec3, primaryTarget: CombatTarget | null,
): EnemyRow[] {
  const singles: EnemyRow[] = [];
  const waves = new Map<number, { count: number; nearestDistanceM: number; targeted: boolean }>();
  for (const enemy of enemies) {
    const distanceM = len(sub(enemy.state.r, viewerPositionEci));
    const targeted = enemy === primaryTarget;
    if (enemy.waveId === undefined) {
      singles.push({ kind: 'single', id: enemy.id, name: enemy.name, distanceM, targeted });
      continue;
    }
    const waveSummary = waves.get(enemy.waveId);
    if (!waveSummary) {
      waves.set(enemy.waveId, { count: 1, nearestDistanceM: distanceM, targeted });
    } else {
      waveSummary.count += 1;
      waveSummary.nearestDistanceM = Math.min(waveSummary.nearestDistanceM, distanceM);
      waveSummary.targeted = waveSummary.targeted || targeted;
    }
  }
  const waveRows: EnemyRow[] = Array.from(waves.entries()).map(([waveId, waveSummary]) => ({
    kind: 'wave',
    waveId,
    count: waveSummary.count,
    distanceM: waveSummary.nearestDistanceM,
    targeted: waveSummary.targeted,
  }));
  return [...singles, ...waveRows].sort((a, b) => a.distanceM - b.distanceM);
}
