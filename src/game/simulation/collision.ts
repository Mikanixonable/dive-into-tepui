// 剛体球どうしの接触解決(自機・敵機・薬莢・補給・デブリ・マガジンベルト)。
// collides を立てた GameEntity だけが参加し、めり込み補正と反発の結果を
// 新しい KinematicState として双方に差し替える。
import { kinematicState } from '../../physics/kinematic-state';
import { len, sub } from '../../physics/vec3';
import { SpatialGrid } from '../../physics/spatial-grid';
import { COLLISION_DAMAGE_MIN_SPEED } from '../const';
import { GameEntity } from '../game-entity/game-entity';
import { DebrisPiece } from '../game-entity/debris-piece';
import { BeltSection } from '../player/belt-physics';
import { Player } from '../player/player';
import { resolveSphereCollision } from '../../physics/collision-response';

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
    const participants = entities.filter(e => e.alive && e.collides);
    // ベルト状態を読み込み、衝突計算後に書き戻す
    if (beltActive) {
      participants.push(...p.belt.collisionSections(dt, p.state.r, p.state.v, p.att));
    }
    this.resolveCollisionPairs(participants, p, onPlayerCasingImpact, onHighSpeedImpact);
    if (beltActive) {
      p.belt.applyCollisionSections(dt, p.state.r, p.state.v, p.att);
    }
  }

  // 候補ペアを空間グリッドの27近傍列挙で絞り込んでから接触を解決する。自機と薬莢が
  // 衝突したら onPlayerCasingImpact を、高速で反発したペアがあれば onHighSpeedImpact を呼ぶ。
  private resolveCollisionPairs(
    entities: GameEntity[],
    player: Player,
    onPlayerCasingImpact: () => void,
    onHighSpeedImpact: ((a: GameEntity, b: GameEntity, speed: number) => void) | undefined,
  ): void {
    const n = entities.length;
    const isBelt = new Array<boolean>(n);
    const isCasingFlag = new Array<boolean>(n);
    let maxRadius = 0;
    let maxMove = 0;
    for (let k = 0; k < n; k++) {
      const e = entities[k]!;
      isBelt[k] = e instanceof BeltSection;
      isCasingFlag[k] = isCasing(e);
      if (e.radius > maxRadius) maxRadius = e.radius;
      const move = len(sub(e.state.r, e.prevState.r));
      if (move > maxMove) maxMove = move;
    }
    // 重なり判定(半径和)と直前substepの線分TOI判定(移動量)、双方が拾いうる最大距離の
    // 2倍ずつを足した値をセル一辺にする — これ以上離れた27近傍の外のペアは、どちらの
    // 判定式でも接触しえない。
    const cellSize = 2 * (maxRadius + maxMove) || 1;
    const grid = new SpatialGrid<number>(cellSize);
    for (let k = 0; k < n; k++) grid.insert(k, entities[k]!.state.r);

    for (let i = 0; i < n; i++) {
      const a = entities[i]!;
      const aBelt = isBelt[i]!;
      const aIsPlayer = a === player;
      const aCasing = isCasingFlag[i]!;
      for (const j of grid.neighbors(a.state.r)) {
        if (j <= i) continue;
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
    const pa = a.prevState, pb = b.prevState;
    // 直前substepの位置は、両者とも今の state より前で、かつ同一時刻に揃っているときだけ
    // 掃引TOIの入力として使える(異なる時刻の位置を組み合わせると法線が意味を失う)。
    const sweptValid = pa.t < a.state.t && pb.t < b.state.t
      && Math.abs(pa.t - pb.t) <= 1e-6 && Math.abs(a.state.t - b.state.t) <= 1e-6;
    const response = resolveSphereCollision(
      { r: a.state.r, v: a.state.v, radius: a.radius, invMass: 1 / a.mass },
      { r: b.state.r, v: b.state.v, radius: b.radius, invMass: 1 / b.mass },
      restitution,
      sweptValid ? pa.r : undefined,
      sweptValid ? pb.r : undefined,
    );
    if (response === null) return null;
    a.state = kinematicState(a.state.t, response.rA, response.vA);
    b.state = kinematicState(b.state.t, response.rB, response.vB);
    if (response.impulse === 0) return null;
    // impulse = -(1+e)·vn / invM を vn について解いた式(速度は書き戻し済みの vA/vB からは
    // もう復元できないため、力積から逆算する)。
    const invM = 1 / a.mass + 1 / b.mass;
    return response.impulse * invM / (1 + restitution);
  }
}
