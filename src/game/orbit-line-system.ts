import { moonPosition } from '../physics/ephemeris';
import { elementsFromState, Elements, R_EARTH } from '../physics/orbital';
import { scale, sub, v3, Vec3 } from '../physics/vec3';
import { MapModeSystem } from './map-mode/map-mode-system';
import { Player } from './player/player';
import { Enemy } from './entities';
import { OrbitLine } from '../render/orbitline';

export interface OrbitLineUpdateCtx {
  simTime: number;
  origin: Vec3;
  playerVelocity: Vec3;
  player: Player;
  target: Enemy | null;
  enemies: Enemy[];
  enemyOrbitLines: OrbitLine[];
  maneuver: MapModeSystem;
  playerOrbitLine: OrbitLine;
  targetOrbitLine: OrbitLine;
  plannedOrbitLine: OrbitLine;
  geoOrbitLine: OrbitLine;
  moonOrbitLine: OrbitLine;
}

export class OrbitLineSystem {
  update(ctx: OrbitLineUpdateCtx): { playerEl: Elements | null; tgtEl: Elements | null } {
    const playerEl = elementsFromState(ctx.origin, ctx.playerVelocity);
    ctx.playerOrbitLine.update(ctx.player.alive ? playerEl : null, ctx.origin, ctx.player.thrustVizDir !== null, true);

    const tgt = ctx.target && ctx.target.alive ? ctx.target : null;
    const tgtEl = tgt ? elementsFromState(tgt.state.r, tgt.state.v) : null;
    ctx.targetOrbitLine.update(tgtEl, ctx.origin);

    const mapMode = ctx.maneuver.mapMode;
    for (let i = 0; i < ctx.enemies.length; i++) {
      const enemy = ctx.enemies[i]!;
      const line = ctx.enemyOrbitLines[i]!;
      if (mapMode && enemy.alive && enemy !== tgt) {
        line.update(elementsFromState(enemy.state.r, enemy.state.v), ctx.origin);
      } else {
        line.update(null, ctx.origin);
      }
    }

    const { plannedEl } = ctx.maneuver.updateDisplay();
    ctx.plannedOrbitLine.update(mapMode ? null : plannedEl, ctx.origin);
    if (mapMode) {
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
