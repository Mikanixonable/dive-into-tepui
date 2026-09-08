import { len, sub } from '../../math/vec3';
import { mapScaleFor } from './map-scale';
import { isEnemy, type Enemy } from '../dynamic/dynamic-entity/enemy';
import type { CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import { ProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';
import { orbitInfo, relativeInfo } from '../orbit-info';
import type { Vec3 } from '../../math/vec3';
import type { Game } from '../game';
import type { OrbitPanelViewModel } from './orbit/orbit-panel';
import type { EnemyRow, EnemiesPanelViewModel } from './panels/enemies-panel';
import type { MapScaleViewModel } from './panels/map-scale-badge';
import type { TargetPanelData } from './panels/target-panel';
import type { TopBarViewModel } from './panels/top-bar';
import type { VesselPanelViewModel } from './panels/vessel-panel';

export function topBarViewOf(game: Game): TopBarViewModel {
  const simTime = game.simTime;
  return {
    epochUnixSec: game.displayWindowManager.current.epochUnixSec,
    simTime,
    simSpeed: game.simSpeedManager.simSpeed,
    autoWarpRealSecondsRemaining: game.simSpeedManager.estimatedRealSecondsToWarpEnd(simTime),
    autoWarpSimulationSecondsRemaining: game.simSpeedManager.remainingSimulationSeconds(simTime),
    isPaused: game.isPaused,
  };
}

export function mapScaleViewOf(game: Game): MapScaleViewModel {
  const visible = game.viewManager.isMapView;
  if (!visible) return { visible, scale: null };
  const focus = game.cameraSystem.mapCamera.resolvedFocus;
  const metersPerPixel = game.cameraSystem.activeCameraScale(focus);
  const scale = mapScaleFor(metersPerPixel);
  return { visible, scale };
}

export function vesselPanelViewOf(game: Game): VesselPanelViewModel | null {
  const target = game.activeControllable;
  if (!target) return null;
  return {
    visible: !game.viewManager.isMapView || game.activeStage.id === 'creative',
    rcsDamp: target.throttle.rcsDamp,
    throttleIdx: target.throttle.throttleIdx,
    aeroQdyn: target.aero?.qdyn ?? null,
    fineAttitude: target.fineAttitude,
    cameraFollowsAttitude: game.cameraSystem.combatCamera.rotationFollow?.kind === 'attitude',
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

export function orbitPanelViewOf(game: Game): OrbitPanelViewModel | null {
  const entity = game.activeControllable;
  if (!entity) return null;
  const celestialBodies = game.celestialSystem.celestialMotions;
  const reference = game.orbitReference.resolve(
    entity.state.r, celestialBodies, game.navTarget, game.dynamicSystem, game.celestialSystem, entity.state.t,
  );
  const info = orbitInfo(entity, reference, entity.state.t, (id) => game.celestialSystem.nameOf(id));
  return {
    selectedMode: game.orbitReference.selectedMode,
    centerId: info.centerId,
    centerName: !reference.attractor && game.navTarget.name ? game.navTarget.name : info.centerName,
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

export function targetPanelDataOf(game: Game): TargetPanelData | null {
  const viewer = game.activeControllable;
  const target = viewer ? game.targeter.aliveTarget : null;
  if (!viewer || !target) return null;
  const relative = relativeInfo(viewer, target, game.celestialSystem.celestialMotions, viewer.state.t);
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

export function enemiesPanelViewOf(game: Game): EnemiesPanelViewModel {
  const viewer = game.activeControllable;
  if (!viewer) return { visible: false, remainingCount: 0, totalCount: 0, rows: [] };
  const { kills, totalEnemiesSpawned } = game.activeStage.scoreCounter;
  const enemies = game.dynamicSystem.all().filter(isEnemy).filter((enemy) => enemy.alive);
  return {
    visible: true,
    remainingCount: totalEnemiesSpawned - kills,
    totalCount: totalEnemiesSpawned,
    rows: enemyRowsOf(enemies, viewer.state.r, game.targeter.aliveTarget),
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
