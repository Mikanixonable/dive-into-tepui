import * as THREE from 'three/webgpu';
import { Vec3 } from '../physics/vec3';
import { Bullet, Casing, DebrisPiece, Enemy, MagPickup } from './entities';
import { Player } from './player/player';

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

// 各エンティティの transform 同期はエンティティ自身の syncTransform() が担う
// (entities.ts)。ここは Simulator が所有する配列をどの順で回すかだけを持つ。
export class RenderDynamicsSystem {
  render(ctx: RenderDynamicsCtx): void {
    ctx.player.render(ctx.zoomActive);
    for (const e of ctx.enemies) if (e.alive) e.syncTransform(ctx.origin);
    for (const b of ctx.bullets) b.syncBulletTransform(ctx.origin, ctx.playerVelocity);
    for (const pb of ctx.plasmaBullets) pb.syncBulletTransform(ctx.origin, ctx.playerVelocity);
    for (const cs of ctx.casings) cs.syncTransform(ctx.origin);
    for (const mp of ctx.magPickups) mp.syncTransform(ctx.origin);
    ctx.player.updateBelt(ctx.dt);
    for (const d of ctx.debris) d.syncTransform(ctx.origin);
  }
}
