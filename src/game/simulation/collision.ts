// 剛体球どうしの接触解決(自機・敵機・薬莢・補給・デブリ・マガジンベルト)。
// collideRadius を持つ GameEntity だけが参加し、めり込み補正と反発の結果を
// 新しい OrbitState として双方に差し替える。
import { orbitState } from '../../physics/orbital-state';
import { v3 } from '../../physics/vec3';
import { COLLISION_DAMAGE_MIN_SPEED } from '../const';
import { GameEntity } from '../game-entity/game-entity';
import { DebrisPiece } from '../game-entity/debris-piece';
import { BeltSection } from '../player/belt-physics';
import { Player } from '../player/player';
import { sweptSphereToi } from '../../physics/swept-sphere';

const isCasing = (e: GameEntity): boolean => e instanceof DebrisPiece && e.kind === 'casing';

export class CollisionPhysics {
  // entities は衝突参加エンティティ(EntityManager.all() が一本化して渡す — casings/debris の
  // 配列分割は EntityManager 内部の上限管理の都合であり、ここでは扱わない)。player はその中の
  // 操作対象で、マガジンベルトと薬莢接触音を持つ艦としてだけ別に渡す。
  // onHighSpeedImpact は COLLISION_DAMAGE_MIN_SPEED 以上の接触速度で反発したペアにのみ呼ばれる
  // (毎ペア呼び出しのコストを避けるため、足切りはここで行う)。
  resolve(
    dt: number,
    player: Player,
    entities: GameEntity[],
    onPlayerCasingImpact: () => void,
    onHighSpeedImpact?: (a: GameEntity, b: GameEntity, speed: number) => void,
  ): void {
    const p = player;
    const beltActive = p.alive && dt > 1e-6;
    const participants = entities.filter(e => e.alive && e.collideRadius !== undefined);
    // ベルト状態を読み込み、衝突計算後に書き戻す
    if (beltActive) {
      participants.push(...p.belt.collisionSections(dt, p.state.r, p.state.v, p.att));
    }
    this.resolveCollisionPairs(participants, p, onPlayerCasingImpact, onHighSpeedImpact);
    if (beltActive) {
      p.belt.applyCollisionSections(dt, p.state.r, p.state.v, p.att);
    }
  }

  // 全ペアの接触を解決する。自機と薬莢が衝突したら onPlayerCasingImpact を、
  // 高速で反発したペアがあれば onHighSpeedImpact を呼ぶ。
  private resolveCollisionPairs(
    entities: GameEntity[],
    player: Player,
    onPlayerCasingImpact: () => void,
    onHighSpeedImpact: ((a: GameEntity, b: GameEntity, speed: number) => void) | undefined,
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
        const speed = this.resolveCollisionPair(a, b);
        if (speed !== null && ((aIsPlayer && isCasingFlag[j]!) || (bIsPlayer && aCasing))) {
          onPlayerCasingImpact();
        }
        if (speed !== null && speed >= COLLISION_DAMAGE_MIN_SPEED) {
          onHighSpeedImpact?.(a, b, speed);
        }
      }
    }
  }

  // 接触していれば a/b の state を補正後の値へ差し替え、反発が起きたときの接触速度を返す
  // (めり込み補正だけ行い離反中で反発しなかった場合は null — 薬莢衝突音の発火条件)。
  private resolveCollisionPair(a: GameEntity, b: GameEntity, restitution = 0.4): number | null {
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
    if (!Number.isFinite(distSq)) return null;
    let nx: number, ny: number, nz: number;
    let rA2x: number, rA2y: number, rA2z: number;
    let rB2x: number, rB2y: number, rB2z: number;
    const invMa = 1 / a.mass;
    const invMb = 1 / b.mass;
    const invM = invMa + invMb;

    if (distSq > 0 && distSq < minD * minD) {
      // 従来の静止overlap解決。
      const dist = Math.sqrt(distSq);
      nx = dx / dist; ny = dy / dist; nz = dz / dist;
      const pen = minD - dist;
      const pCorr = (pen / invM) * 0.8;
      const cA = pCorr * invMa;
      const cB = pCorr * invMb;
      rA2x = rA.x - nx * cA; rA2y = rA.y - ny * cA; rA2z = rA.z - nz * cA;
      rB2x = rB.x + nx * cB; rB2y = rB.y + ny * cB; rB2z = rB.z + nz * cB;
    } else {
      // 最終位置が離れていても直前substepの線分間で交差していればTOI接触を採用する。
      // 完全な残時間再積分ではなく、両中心をTOI位置へ決定的に戻して現在速度へimpulseを適用する近似。
      const pa = a.prevState, pb = b.prevState;
      if (!(pa.t < a.state.t && pb.t < b.state.t)) return null;
      if (Math.abs(pa.t - pb.t) > 1e-6 || Math.abs(a.state.t - b.state.t) > 1e-6) return null;
      const hit = sweptSphereToi(pa.r, rA, pb.r, rB, minD);
      if (hit === null) return null;
      nx = hit.normal.x; ny = hit.normal.y; nz = hit.normal.z;
      const u = hit.toi;
      rA2x = pa.r.x + (rA.x - pa.r.x) * u;
      rA2y = pa.r.y + (rA.y - pa.r.y) * u;
      rA2z = pa.r.z + (rA.z - pa.r.z) * u;
      rB2x = pb.r.x + (rB.x - pb.r.x) * u;
      rB2y = pb.r.y + (rB.y - pb.r.y) * u;
      rB2z = pb.r.z + (rB.z - pb.r.z) * u;
    }

    const vn = (vB.x - vA.x) * nx + (vB.y - vA.y) * ny + (vB.z - vA.z) * nz;
    if (vn >= 0) {
      a.state = orbitState(a.state.t, v3(rA2x, rA2y, rA2z), vA);
      b.state = orbitState(b.state.t, v3(rB2x, rB2y, rB2z), vB);
      return null;
    }
    const j = -((1 + restitution) * vn) / invM;
    const jA = j * invMa;
    const jB = j * invMb;
    a.state = orbitState(a.state.t, v3(rA2x, rA2y, rA2z), v3(vA.x - nx * jA, vA.y - ny * jA, vA.z - nz * jA));
    b.state = orbitState(b.state.t, v3(rB2x, rB2y, rB2z), v3(vB.x + nx * jB, vB.y + ny * jB, vB.z + nz * jB));
    return Math.abs(vn);
  }
}
