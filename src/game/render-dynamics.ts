import * as THREE from 'three/webgpu';
import * as C from './const';
import { Vec3 } from '../physics/vec3';
import { BeltPhysics } from './belt';
import { Bullet, Casing, DebrisPiece, Enemy, MagPickup } from './entities';
import { Player } from './player';

const tmpVel = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const zAxis = new THREE.Vector3(0, 0, 1);

export interface RenderDynamicsCtx {
  dt: number;
  origin: Vec3;
  playerVelocity: Vec3;
  player: Player;
  enemies: Enemy[];
  bullets: Bullet[];
  plasmaBullets: Bullet[];
  casings: Casing[];
  magPickups: MagPickup[];
  debris: DebrisPiece[];
  belt: BeltPhysics;
  magsLeft: number;
  roundsInMag: number;
  camera: THREE.PerspectiveCamera;
  zoomActive: boolean;
}

export class RenderDynamicsSystem {
  private beltFeed = 0;

  render(ctx: RenderDynamicsCtx): void {
    this.renderPlayer(ctx.player, ctx.zoomActive);
    this.renderEnemies(ctx.enemies, ctx.origin);
    this.renderBullets(ctx.bullets, ctx.origin, ctx.playerVelocity);
    this.renderBullets(ctx.plasmaBullets, ctx.origin, ctx.playerVelocity);
    this.renderCasings(ctx.casings, ctx.origin);
    this.renderMagPickups(ctx.magPickups, ctx.origin);
    this.renderBelt(ctx);
    this.renderDebris(ctx.debris, ctx.origin);
  }

  private renderPlayer(player: Player, zoomActive: boolean): void {
    player.obj.position.set(0, 0, 0);
    player.obj.quaternion.set(player.att.q.x, player.att.q.y, player.att.q.z, player.att.q.w);
    player.obj.visible = player.alive && !zoomActive;
  }

  private renderEnemies(enemies: Enemy[], origin: Vec3): void {
    for (const e of enemies) {
      if (!e.alive) continue;
      e.obj.position.set(e.state.r.x - origin.x, e.state.r.y - origin.y, e.state.r.z - origin.z);
      e.obj.quaternion.set(e.att.q.x, e.att.q.y, e.att.q.z, e.att.q.w);
    }
  }

  private renderBullets(bullets: Bullet[], origin: Vec3, playerVelocity: Vec3): void {
    for (const b of bullets) {
      b.obj.position.set(b.state.r.x - origin.x, b.state.r.y - origin.y, b.state.r.z - origin.z);
      tmpVel.set(
        b.state.v.x - playerVelocity.x,
        b.state.v.y - playerVelocity.y,
        b.state.v.z - playerVelocity.z,
      );
      if (tmpVel.lengthSq() <= 1e-6) continue;
      tmpQuat.setFromUnitVectors(zAxis, tmpVel.normalize());
      b.obj.quaternion.copy(tmpQuat);
    }
  }

  private renderCasings(casings: Casing[], origin: Vec3): void {
    for (const cs of casings) {
      cs.obj.position.set(cs.state.r.x - origin.x, cs.state.r.y - origin.y, cs.state.r.z - origin.z);
      cs.obj.quaternion.set(cs.att.q.x, cs.att.q.y, cs.att.q.z, cs.att.q.w);
    }
  }

  private renderMagPickups(magPickups: MagPickup[], origin: Vec3): void {
    for (const mp of magPickups) {
      mp.obj.position.set(mp.state.r.x - origin.x, mp.state.r.y - origin.y, mp.state.r.z - origin.z);
      mp.obj.quaternion.set(mp.att.q.x, mp.att.q.y, mp.att.q.z, mp.att.q.w);
    }
  }

  private renderBelt(ctx: RenderDynamicsCtx): void {
    const beltCount = Math.min(ctx.magsLeft, C.BELT_MAX_VISIBLE);
    const targetFeed = 1 - ctx.roundsInMag / C.MAG_ROUNDS;
    if (targetFeed < this.beltFeed - 0.5) {
      ctx.belt.shiftBeltNodes();
      this.beltFeed = targetFeed;
    } else {
      this.beltFeed += (targetFeed - this.beltFeed) * Math.min(1, ctx.dt * 12);
    }
    ctx.belt.updateBeltPhysics(
      ctx.dt,
      beltCount,
      ctx.player.att,
      ctx.player.thrustAccelVec,
      this.beltFeed,
      ctx.player.alive,
    );
  }

  private renderDebris(debris: DebrisPiece[], origin: Vec3): void {
    for (const d of debris) {
      d.obj.position.set(d.state.r.x - origin.x, d.state.r.y - origin.y, d.state.r.z - origin.z);
      d.obj.quaternion.set(d.att.q.x, d.att.q.y, d.att.q.z, d.att.q.w);
    }
  }
}
