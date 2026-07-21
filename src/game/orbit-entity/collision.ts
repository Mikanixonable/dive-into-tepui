// 剛体球どうしの接触解決(自機・敵機・薬莢・補給・デブリ・マガジンベルト)。
// collideRadius を持つ OrbitEntity だけが参加し、state.r / state.v を直接補正する。
import { Vec3 } from '../../physics/vec3';
import { BeltSection, DebrisPiece, OrbitEntity } from './entities';
import { Player } from '../player/player';

const isCasing = (e: OrbitEntity): boolean => e instanceof DebrisPiece && e.kind === 'casing';

export class CollisionPhysics {
  // entities は player 以外の衝突参加エンティティ(Simulator.allEntities() が一本化して渡す —
  // casings/debris の配列分割は Simulator 内部の上限管理の都合であり、ここでは扱わない)。
  resolve(dt: number, player: Player, entities: OrbitEntity[], onPlayerCasingImpact: () => void): void {
    const p = player;
    const beltActive = p.alive && dt > 1e-6;
    const participants = entities.filter(e => e.alive && e.collideRadius !== undefined);
    if (p.alive) participants.push(p);
    // ベルト状態を読み込み、衝突計算後に書き戻す
    if (beltActive) {
      participants.push(...p.belt.collisionSections(dt, p.state.r, p.state.v, p.att.q));
    }
    this.resolveCollisionPairs(participants, p, onPlayerCasingImpact);
    if (beltActive) {
      p.belt.applyCollisionSections(dt, p.state.r, p.state.v, p.att.q);
    }
  }

  private resolveCollisionPairs(
    entities: OrbitEntity[],
    player: Player,
    onPlayerCasingImpact: () => void,
  ): void {
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i]!;
        const b = entities[j]!;
        const aBelt = a instanceof BeltSection;
        const bBelt = b instanceof BeltSection;
        if (aBelt && bBelt) continue;
        if ((a === player && bBelt) || (b === player && aBelt)) continue;
        const impact = this.resolveCollisionPair(
          a.state.r, a.state.v, a.mass, a.collideRadius!,
          b.state.r, b.state.v, b.mass, b.collideRadius!,
        );
        if (impact && ((a === player && isCasing(b)) || (b === player && isCasing(a)))) {
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
}
