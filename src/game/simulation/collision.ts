// 剛体球どうしの接触解決(自機・敵機・薬莢・補給・デブリ・マガジンベルト)。
// collideRadius を持つ GameEntity だけが参加し、めり込み補正と反発の結果を
// 新しい OrbitState として双方に差し替える。
import { orbitState } from '../../physics/orbital';
import { v3 } from '../../physics/vec3';
import { GameEntity } from '../game-entity/game-entity';
import { DebrisPiece } from '../game-entity/debris-piece';
import { BeltSection } from '../player/belt-physics';
import { Player } from '../player/player';

const isCasing = (e: GameEntity): boolean => e instanceof DebrisPiece && e.kind === 'casing';

export class CollisionPhysics {
  // entities は player 以外の衝突参加エンティティ(EntityManager.all() が一本化して渡す —
  // casings/debris の配列分割は EntityManager 内部の上限管理の都合であり、ここでは扱わない)。
  resolve(dt: number, player: Player, entities: GameEntity[], onPlayerCasingImpact: () => void): void {
    const p = player;
    const beltActive = p.alive && dt > 1e-6;
    const participants = entities.filter(e => e.alive && e.collideRadius !== undefined);
    if (p.alive) participants.push(p);
    // ベルト状態を読み込み、衝突計算後に書き戻す
    if (beltActive) {
      participants.push(...p.belt.collisionSections(dt, p.state.r, p.state.v, p.att));
    }
    this.resolveCollisionPairs(participants, p, onPlayerCasingImpact);
    if (beltActive) {
      p.belt.applyCollisionSections(dt, p.state.r, p.state.v, p.att);
    }
  }

  // 全ペアの接触を解決する。自機と薬莢が衝突したら onPlayerCasingImpact を呼ぶ。
  private resolveCollisionPairs(
    entities: GameEntity[],
    player: Player,
    onPlayerCasingImpact: () => void,
  ): void {
    // O(n²) の総当たりは実測でボトルネックではない(sim フェーズ 2.7ms 程度)ため、
    // 空間分割などのアルゴリズム変更は行わない。ここでは1ペアあたりの定数コストのみを
    // 削減する: instanceof 判定・isCasing 判定・配列アクセスをループ前に一度だけ計算しておく。
    const n = entities.length;
    const isBelt = new Array<boolean>(n);
    const isCasingFlag = new Array<boolean>(n);
    for (let k = 0; k < n; k++) {
      const e = entities[k]!;
      isBelt[k] = e instanceof BeltSection;
      isCasingFlag[k] = isCasing(e);
    }
    for (let i = 0; i < entities.length; i++) {
      const a = entities[i]!;
      const aBelt = isBelt[i]!;
      const aIsPlayer = a === player;
      const aCasing = isCasingFlag[i]!;
      for (let j = i + 1; j < entities.length; j++) {
        const b = entities[j]!;
        const bBelt = isBelt[j]!;
        if (aBelt && bBelt) continue;
        const bIsPlayer = b === player;
        if ((aIsPlayer && bBelt) || (bIsPlayer && aBelt)) continue;
        const impact = this.resolveCollisionPair(a, b);
        if (impact && ((aIsPlayer && isCasingFlag[j]!) || (bIsPlayer && aCasing))) {
          onPlayerCasingImpact();
        }
      }
    }
  }

  // 接触していれば a/b の state を補正後の値へ差し替え、実際に反発したかを返す。
  // (めり込み補正だけ行い離反中で反発しなかった場合は false — 薬莢衝突音の発火条件)
  private resolveCollisionPair(a: GameEntity, b: GameEntity, restitution = 0.4): boolean {
    const rA = a.state.r, vA = a.state.v;
    const rB = b.state.r, vB = b.state.v;
    const dx = rB.x - rA.x;
    const dy = rB.y - rA.y;
    const dz = rB.z - rA.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    const minD = a.collideRadius! + b.collideRadius!;
    // 非有限値(NaN/Infinity)は比較で必ず false になるため、ガードしないと
    // 「常に接触している」と判定され、毎フレーム反発と衝突音が発生し、しかも
    // 相手側まで NaN に汚染してしまう(自機が巻き込まれると描画が全滅する)。
    // 汚染そのものの検出・報告は nan-watchdog.ts の役目で、ここでは伝播を止めるだけ。
    if (!Number.isFinite(distSq)) return false;
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
    const rA2x = rA.x - nx * cA, rA2y = rA.y - ny * cA, rA2z = rA.z - nz * cA;
    const rB2x = rB.x + nx * cB, rB2y = rB.y + ny * cB, rB2z = rB.z + nz * cB;

    const vn = (vB.x - vA.x) * nx + (vB.y - vA.y) * ny + (vB.z - vA.z) * nz;
    if (vn >= 0) {
      a.state = orbitState(a.state.t, v3(rA2x, rA2y, rA2z), vA);
      b.state = orbitState(b.state.t, v3(rB2x, rB2y, rB2z), vB);
      return false;
    }
    const j = -((1 + restitution) * vn) / invM;
    const jA = j * invMa;
    const jB = j * invMb;
    a.state = orbitState(a.state.t, v3(rA2x, rA2y, rA2z), v3(vA.x - nx * jA, vA.y - ny * jA, vA.z - nz * jA));
    b.state = orbitState(b.state.t, v3(rB2x, rB2y, rB2z), v3(vB.x + nx * jB, vB.y + ny * jB, vB.z + nz * jB));
    return true;
  }
}
