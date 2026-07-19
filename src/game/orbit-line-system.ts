import { moonPosition } from '../physics/ephemeris';
import { sampleAt } from '../physics/predict';
import { elementsFromState, Elements, R_EARTH } from '../physics/orbital';
import { scale, sub, v3, Vec3 } from '../physics/vec3';
import { EphemerisSystem } from './ephemeris';
import { MapPlanner, PlannerCtx, ProjectFn } from './planner';
import { MapView } from './mapview';
import { Player } from './player';
import { Enemy } from './entities';
import { OrbitLine } from '../render/orbitline';
import { TrajectoryOverlay } from './traj-overlay';

export interface OrbitLineUpdateCtx {
  mapMode: boolean;
  simTime: number;
  origin: Vec3;
  playerVelocity: Vec3;
  player: Player;
  target: Enemy | null;
  enemies: Enemy[];
  enemyOrbitLines: OrbitLine[];
  ephemeris: EphemerisSystem;
  planner: MapPlanner;
  plannerCtx: PlannerCtx;
  mapView: MapView;
  trajOverlay: TrajectoryOverlay;
  playerOrbitLine: OrbitLine;
  targetOrbitLine: OrbitLine;
  plannedOrbitLine: OrbitLine;
  geoOrbitLine: OrbitLine;
  moonOrbitLine: OrbitLine;
  project: ProjectFn;
}

export class OrbitLineSystem {
  update(ctx: OrbitLineUpdateCtx): { playerEl: Elements | null; tgtEl: Elements | null } {
    const playerEl = elementsFromState(ctx.origin, ctx.playerVelocity);
    ctx.playerOrbitLine.update(ctx.player.alive ? playerEl : null, ctx.origin, ctx.player.thrustVizDir !== null, true);

    const tgt = ctx.target && ctx.target.alive ? ctx.target : null;
    const tgtEl = tgt ? elementsFromState(tgt.state.r, tgt.state.v) : null;
    ctx.targetOrbitLine.update(tgtEl, ctx.origin);

    for (let i = 0; i < ctx.enemies.length; i++) {
      const enemy = ctx.enemies[i]!;
      const line = ctx.enemyOrbitLines[i]!;
      if (ctx.mapMode && enemy.alive && enemy !== tgt) {
        line.update(elementsFromState(enemy.state.r, enemy.state.v), ctx.origin);
      } else {
        line.update(null, ctx.origin);
      }
    }

    ctx.trajOverlay.maybeRefresh(ctx.plannerCtx);
    ctx.trajOverlay.updateForMapMode(
      ctx.mapMode,
      ctx.origin,
      ctx.plannerCtx,
      ctx.simTime,
      ctx.mapView.sliderT,
      ctx.project,
      (simTime, duration) => ctx.mapView.displayTime(simTime, duration),
    );

    ctx.planner.updateMapGizmo(ctx.origin, ctx.plannerCtx, ctx.project, ctx.mapMode, ctx.mapView.dist);
    if (ctx.mapMode) {
      ctx.mapView.drawLabels(
        ctx.origin,
        {
          simTime: ctx.simTime,
          sunPhase0: ctx.ephemeris.sunPhase0,
          moonPhase0: ctx.ephemeris.moonPhase0,
          duration: ctx.trajOverlay.predictDurationSec(ctx.plannerCtx),
        },
        ctx.project,
      );
    }

    let plannedEl: Elements | null = null;
    if (!ctx.mapMode && ctx.planner.planNodes.length > 0) {
      const sample = sampleAt(ctx.planner.trajSamples, ctx.planner.planNodes[0]!.time);
      if (sample) plannedEl = elementsFromState(sample.r, sample.v);
    }
    ctx.plannedOrbitLine.update(ctx.mapMode ? null : plannedEl, ctx.origin);
    if (ctx.mapMode) {
      this.updateMapReferenceLines(ctx.simTime, ctx.origin, ctx.geoOrbitLine, ctx.moonOrbitLine);
    } else {
      ctx.geoOrbitLine.update(null, ctx.origin);
      ctx.moonOrbitLine.update(null, ctx.origin);
    }
    return { playerEl, tgtEl };
  }

  private updateMapReferenceLines(
    simTime: number,
    origin: Vec3,
    geoOrbitLine: OrbitLine,
    moonOrbitLine: OrbitLine,
  ): void {
    const geoEl: Elements = {
      a: R_EARTH + 35786e3,
      e: 1e-6,
      p: R_EARTH + 35786e3,
      incDeg: 0,
      apAlt: 35786e3,
      peAlt: 35786e3,
      period: 86164,
      hHat: v3(0, 1, 0),
      pHat: v3(1, 0, 0),
      qHat: v3(0, 0, -1),
    };
    geoOrbitLine.update(geoEl, origin, false, false);

    const dtMoon = 10;
    const mR1 = moonPosition(simTime, 0);
    const mR2 = moonPosition(simTime + dtMoon, 0);
    const mV = scale(sub(mR2, mR1), 1 / dtMoon);
    const moonEl = elementsFromState(mR1, mV);
    moonOrbitLine.update(moonEl, origin, false, false);
  }
}
