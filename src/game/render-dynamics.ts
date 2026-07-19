import * as THREE from 'three/webgpu';
import { Vec3 } from '../physics/vec3';
import { Bullet, Casing, DebrisPiece, Enemy, MagPickup } from './entities';
import { Player } from './player/player';

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
  camera: THREE.PerspectiveCamera;
  zoomActive: boolean;
}

export class RenderDynamicsSystem {
  render(ctx: RenderDynamicsCtx): void {
    this.renderPlayer(ctx.player, ctx.zoomActive);
    this.renderEnemies(ctx.enemies, ctx.origin);
    this.renderBullets(ctx.bullets, ctx.origin, ctx.playerVelocity);
    this.renderBullets(ctx.plasmaBullets, ctx.origin, ctx.playerVelocity);
    this.renderCasings(ctx.casings, ctx.origin);
    this.renderMagPickups(ctx.magPickups, ctx.origin);
    ctx.player.updateBelt(ctx.dt);
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

  private renderDebris(debris: DebrisPiece[], origin: Vec3): void {
    for (const d of debris) {
      d.obj.position.set(d.state.r.x - origin.x, d.state.r.y - origin.y, d.state.r.z - origin.z);
      d.obj.quaternion.set(d.att.q.x, d.att.q.y, d.att.q.z, d.att.q.w);
    }
  }
}
