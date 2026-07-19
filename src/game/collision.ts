import * as THREE from 'three/webgpu';
import { qRotate } from '../physics/attitude';
import { Vec3, add, sub } from '../physics/vec3';
import * as C from './const';
import { BeltPhysics } from './belt';
import { Casing, DebrisPiece, Enemy, MagPickup } from './entities';
import { Player } from './player';

type CollisionEntity = {
  r: Vec3;
  v: Vec3;
  m: number;
  rad: number;
  isBelt?: boolean;
  beltIdx?: number;
  isPlayer?: boolean;
  isCasing?: boolean;
};

export interface CollisionPhysicsCtx {
  player: Player;
  enemies: Enemy[];
  casings: Casing[];
  magPickups: MagPickup[];
  debris: DebrisPiece[];
  belt: BeltPhysics;
}

export class CollisionPhysics {
  resolve(dt: number, ctx: CollisionPhysicsCtx, onPlayerCasingImpact: () => void): void {
    const entities = this.buildCollisionEntities(dt, ctx);
    this.resolveCollisionPairs(entities, onPlayerCasingImpact);
    this.writeBackBeltCollisionState(dt, entities, ctx);
  }

  private buildCollisionEntities(dt: number, ctx: CollisionPhysicsCtx): CollisionEntity[] {
    const entities: CollisionEntity[] = [];
    if (ctx.player.alive) {
      entities.push({
        r: ctx.player.state.r,
        v: ctx.player.state.v,
        m: 1000,
        rad: C.PLAYER_HULL_RADIUS,
        isPlayer: true,
      });
    }
    for (const e of ctx.enemies) if (e.alive) entities.push({ r: e.state.r, v: e.state.v, m: 10000, rad: e.radius });
    for (const c of ctx.casings) entities.push({ r: c.state.r, v: c.state.v, m: 1, rad: 0.2, isCasing: true });
    for (const m of ctx.magPickups) if (m.alive) entities.push({ r: m.state.r, v: m.state.v, m: 50, rad: C.MAG_PICKUP_PHYS_RADIUS });
    for (const d of ctx.debris) {
      if (d.collideRadius !== undefined) {
        entities.push({ r: d.state.r, v: d.state.v, m: C.EJECTED_MAG_MASS, rad: d.collideRadius });
      }
    }
    this.appendBeltCollisionEntities(dt, entities, ctx);
    return entities;
  }

  private appendBeltCollisionEntities(dt: number, entities: CollisionEntity[], ctx: CollisionPhysicsCtx): void {
    if (!ctx.player.alive || dt <= 1e-6) return;
    const q = ctx.player.att.q;
    const baseR = ctx.player.state.r;
    const baseV = ctx.player.state.v;
    for (let i = 0; i < ctx.belt.beltPos.length; i++) {
      const bp = ctx.belt.beltPos[i]!;
      const bpPrev = ctx.belt.beltPrevPos[i]!;
      const localBp = new THREE.Vector3().copy(bp);
      const localBpPrev = new THREE.Vector3().copy(bpPrev);
      const wr = add(baseR, qRotate(q, localBp));
      const wv = add(baseV, qRotate(q, localBp.sub(localBpPrev).multiplyScalar(1 / dt)));
      entities.push({ r: wr, v: wv, m: 5, rad: 0.8, isBelt: true, beltIdx: i });
    }
  }

  private resolveCollisionPairs(entities: CollisionEntity[], onPlayerCasingImpact: () => void): void {
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i]!;
        const b = entities[j]!;
        if (a.isBelt && b.isBelt) continue;
        if ((a.isPlayer && b.isBelt) || (b.isPlayer && a.isBelt)) continue;
        const impact = this.resolveCollisionPair(a.r, a.v, a.m, a.rad, b.r, b.v, b.m, b.rad);
        if (impact && ((a.isPlayer && b.isCasing) || (b.isPlayer && a.isCasing))) {
          onPlayerCasingImpact();
        }
      }
    }
  }

  private resolveCollisionPair(
    rA: Vec3,
    vA: Vec3,
    massA: number,
    radA: number,
    rB: Vec3,
    vB: Vec3,
    massB: number,
    radB: number,
    restitution = 0.4,
  ): boolean {
    const dx = rB.x - rA.x;
    const dy = rB.y - rA.y;
    const dz = rB.z - rA.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    const minD = radA + radB;
    if (distSq <= 0 || distSq >= minD * minD) return false;
    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;
    const pen = minD - dist;
    const invMa = 1 / massA;
    const invMb = 1 / massB;
    const invM = invMa + invMb;
    const pCorr = (pen / invM) * 0.8;
    rA.x -= nx * pCorr * invMa;
    rA.y -= ny * pCorr * invMa;
    rA.z -= nz * pCorr * invMa;
    rB.x += nx * pCorr * invMb;
    rB.y += ny * pCorr * invMb;
    rB.z += nz * pCorr * invMb;
    const dvx = vB.x - vA.x;
    const dvy = vB.y - vA.y;
    const dvz = vB.z - vA.z;
    const vn = dvx * nx + dvy * ny + dvz * nz;
    if (vn >= 0) return false;
    const j = -((1 + restitution) * vn) / invM;
    vA.x -= nx * j * invMa;
    vA.y -= ny * j * invMa;
    vA.z -= nz * j * invMa;
    vB.x += nx * j * invMb;
    vB.y += ny * j * invMb;
    vB.z += nz * j * invMb;
    return true;
  }

  private writeBackBeltCollisionState(dt: number, entities: CollisionEntity[], ctx: CollisionPhysicsCtx): void {
    if (!ctx.player.alive || dt <= 1e-6) return;
    const pq = ctx.player.att.q;
    const qInv = { x: -pq.x, y: -pq.y, z: -pq.z, w: pq.w };
    const baseR = ctx.player.state.r;
    const baseV = ctx.player.state.v;
    for (const e of entities) {
      if (!e.isBelt || e.beltIdx === undefined) continue;
      const bpLocal = qRotate(qInv, sub(e.r, baseR));
      const bvLocal = qRotate(qInv, sub(e.v, baseV));
      ctx.belt.beltPos[e.beltIdx]!.set(bpLocal.x, bpLocal.y, bpLocal.z);
      ctx.belt.beltPrevPos[e.beltIdx]!.set(
        bpLocal.x - bvLocal.x * dt,
        bpLocal.y - bvLocal.y * dt,
        bpLocal.z - bvLocal.z * dt,
      );
    }
  }
}
