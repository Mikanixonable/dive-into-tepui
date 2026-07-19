// 軌道積分の実行と、それに紐づく環境加速度の組み立て。
// game.ts を import しない — 依存は constructor 注入と各メソッド引数のみ。
import { stepAttitude } from '../physics/attitude';
import { envAccelInto } from '../physics/envaccel';
import { ExtraAccel, stepOrbitRK4 } from '../physics/orbital';
import { add, clone, v3 } from '../physics/vec3';
import * as C from './const';
import { AmmoResupplySystem } from './combat/ammo-resupply';
import { CombatCtx, CombatSystem } from './combat/combat';
import { Bullet, Casing, DebrisPiece, Enemy, OrbitEntity } from './entities';
import { EphemerisSystem } from './ephemeris';
import { Player } from './player';
import { ThermalSystem } from './thermal';

export interface SimulatorCtx {
  player: Player;
  enemies: Enemy[];
  bullets: Bullet[];
  plasmaBullets: Bullet[];
  casings: Casing[];
  debris: DebrisPiece[];
  combatCtx: (simTime: number) => CombatCtx;
}

export interface SimulationAdvance {
  simTime: number;
  simDt: number;
}

interface StepWorldOptions {
  includePlasmaBullets?: boolean;
  trackPrevR?: boolean;
}

export class Simulator {
  private readonly envShip = this.makeEnvAccel(C.SHIP_BCINV);
  private readonly envBullet = this.makeEnvAccel(C.BULLET_BCINV);
  private readonly envSmall = this.makeEnvAccel(C.SMALL_DEBRIS_BCINV);

  constructor(
    private readonly ephemeris: EphemerisSystem,
    private readonly thermal: ThermalSystem,
    private readonly ammoResupply: AmmoResupplySystem,
    private readonly combat: CombatSystem,
  ) {}

  buildPlayerAccel(thrustFn: ExtraAccel | null): ExtraAccel {
    return thrustFn ? (r, v) => add(thrustFn(r, v), this.envShip(r, v)) : this.envShip;
  }

  integrateSimulation(
    simTime: number,
    dt: number,
    warp: number,
    ctx: SimulatorCtx,
    checkCollision: boolean,
    doSubstep: boolean,
    playerAccel: ExtraAccel | null = null,
  ): SimulationAdvance {
    const simDt = dt * (doSubstep ? warp : Math.min(warp, 4));
    const nSub = doSubstep && warp > C.MAX_PHYS_WARP ? Math.min(64, Math.ceil(simDt / 20)) : 1;
    const sub = simDt / nSub;
    let nextSimTime = simTime;
    for (let i = 0; i < nSub; i++) {
      nextSimTime = this.advanceSimulationStep(nextSimTime, sub, ctx, playerAccel, checkCollision);
    }
    if (!checkCollision) this.stepCoastingAttitudes(simDt, ctx);
    return { simTime: nextSimTime, simDt };
  }

  private makeEnvAccel(bcInv: number): ExtraAccel {
    return (r, v, out) => envAccelInto(out ?? v3(), r, v, this.ephemeris.sunPos, this.ephemeris.moonPos, bcInv);
  }

  private stepWorldOrbits(dt: number, ctx: SimulatorCtx, options: StepWorldOptions = {}): void {
    const { includePlasmaBullets = false, trackPrevR = false } = options;
    this.stepEntities(ctx.enemies, dt, this.envShip, { skipDead: true, trackPrevR });
    this.stepEntities(ctx.bullets, dt, this.envBullet, { skipDead: true, trackPrevR });
    if (includePlasmaBullets) {
      this.stepEntities(ctx.plasmaBullets, dt, this.envBullet, { skipDead: true, trackPrevR });
    }
    this.stepEntities(ctx.casings, dt, this.envSmall);
    this.stepEntities(ctx.debris, dt, this.envSmall);
    this.ammoResupply.stepOrbits(dt, this.envSmall);
  }

  private stepEntities(
    entities: Iterable<OrbitEntity>,
    dt: number,
    accel: ExtraAccel,
    options: { skipDead?: boolean; trackPrevR?: boolean } = {},
  ): void {
    const { skipDead = false, trackPrevR = false } = options;
    for (const entity of entities) {
      if (skipDead && !entity.alive) continue;
      if (trackPrevR) entity.prevR = clone(entity.state.r);
      stepOrbitRK4(entity.state, dt, accel);
    }
  }

  private advanceSimulationStep(
    simTime: number,
    sub: number,
    ctx: SimulatorCtx,
    playerAccel: ExtraAccel | null,
    checkCollision: boolean,
  ): number {
    this.ephemeris.update(simTime);
    if (checkCollision) ctx.player.prevR = clone(ctx.player.state.r);
    if (playerAccel && ctx.player.alive) {
      stepOrbitRK4(ctx.player.state, sub, playerAccel);
      this.thermal.updateThermal(sub, ctx.player.state.r, ctx.player.state.v);
    }
    this.stepWorldOrbits(sub, ctx, {
      includePlasmaBullets: checkCollision,
      trackPrevR: checkCollision,
    });
    const nextSimTime = simTime + sub;
    if (checkCollision) {
      const combatCtx = ctx.combatCtx(nextSimTime);
      this.combat.checkBulletHits(combatCtx);
      this.combat.checkBoardCrossings(combatCtx);
    }
    return nextSimTime;
  }

  private stepCoastingAttitudes(simDt: number, ctx: SimulatorCtx): void {
    const attDt = Math.min(simDt, 0.12);
    for (const cs of ctx.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of ctx.debris) stepAttitude(d.att, v3(), attDt);
    this.ammoResupply.stepAttitudes(attDt);
  }
}
