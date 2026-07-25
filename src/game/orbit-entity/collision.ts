// 剛体球どうしの接触解決(自機・敵機・薬莢・補給・デブリ・マガジンベルト)。
// collideRadius を持つ OrbitEntity だけが参加し、めり込み補正と反発の結果を
// 新しい OrbitState として双方に差し替える。
import { orbitState } from '../../physics/orbital';
import { v3 } from '../../physics/vec3';
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
        const impact = this.resolveCollisionPair(a, b);
        if (impact && ((a === player && isCasing(b)) || (b === player && isCasing(a)))) {
          onPlayerCasingImpact();
        }
      }
    }
  }

  // 接触していれば a/b の state を補正後の値へ差し替え、実際に反発したかを返す。
  // (めり込み補正だけ行い離反中で反発しなかった場合は false — 薬莢衝突音の発火条件)
  private resolveCollisionPair(a: OrbitEntity, b: OrbitEntity, restitution = 0.4): boolean {
    const rA = a.state.r, vA = a.state.v;
    const rB = b.state.r, vB = b.state.v;
    const dx = rB.x - rA.x;
    const dy = rB.y - rA.y;
    const dz = rB.z - rA.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    const minD = a.collideRadius! + b.collideRadius!;
    if (distSq <= 0 || distSq >= minD * minD) return false;
    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;
    const pen = minD - dist;
    const invMa = 1 / a.mass;
    const invMb = 1 / b.mass;
    const invM = invMa + invMb;
    const pCorr = (pen / invM) * 0.8;
    const cA = pCorr * invMa;
    const cB = pCorr * invMb;
    const rA2 = v3(rA.x - nx * cA, rA.y - ny * cA, rA.z - nz * cA);
    const rB2 = v3(rB.x + nx * cB, rB.y + ny * cB, rB.z + nz * cB);

    const vn = (vB.x - vA.x) * nx + (vB.y - vA.y) * ny + (vB.z - vA.z) * nz;
    if (vn >= 0) {
      a.state = orbitState(rA2, vA);
      b.state = orbitState(rB2, vB);
      return false;
    }
    const j = -((1 + restitution) * vn) / invM;
    const jA = j * invMa;
    const jB = j * invMb;
    a.state = orbitState(rA2, v3(vA.x - nx * jA, vA.y - ny * jA, vA.z - nz * jA));
    b.state = orbitState(rB2, v3(vB.x + nx * jB, vB.y + ny * jB, vB.z + nz * jB));
    return true;
  }
}
