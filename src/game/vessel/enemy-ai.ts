// 敵対勢力の機体が積む行動則。バースト射撃の抽選と、見越し射撃によるプラズマ弾の生成。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { kinematicState } from '../../physics/kinematic-state';
import { R_EARTH_EQ } from '../../physics/solar-system';
import { add, addScaled, dot, len, lenSq, norm, randPerp, rotateAxis, scale, sub, Vec3, v3 } from '../../physics/vec3';
import { solveLeadTime } from '../../physics/intercept';
import type { Ephemeris } from '../../physics/ephemeris';
import { Bullet } from '../game-entity/bullet';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { Vessel } from './vessel';

// 敵機の見た目の種別。どのメッシュを組むかをこれで選ぶ。
export type EnemyKind = { kind: 'drifting' } | { kind: 'stage0'; typeIndex: number };

// enemyKind ごとの主慣性モーメント。'drifting' は非対称にしてジャニベコフ効果(中間軸不安定性)
// を起こし、'stage0' は機首をプログレードへ向けたまま飛ぶので等方でよい。
export function inertiaForEnemyKind(enemyKind: EnemyKind): Vec3 {
  return enemyKind.kind === 'stage0' ? v3(1, 1, 1) : v3(1, 1.1, 1.05);
}

// 太陽グレアによるプラズマ弾の散布界の倍率。逆光(照準方向に太陽がある)ほど狙いが甘くなり、
// 順光では締まる。難易度調整のための経験則であって物理計算ではない。
// pos が地球の影(簡易円柱モデル)に入っていれば太陽光が届かないので倍率は 1。
function sunGlareSpreadScale(pos: Vec3, aimDir: Vec3, sunDir: Vec3): number {
  const along = dot(pos, sunDir);
  if (along < 0 && lenSq(addScaled(pos, sunDir, -along)) < R_EARTH_EQ * R_EARTH_EQ) return 1;

  const angle = (Math.acos(Math.max(-1, Math.min(1, dot(aimDir, sunDir)))) * 180) / Math.PI;
  if (angle <= 5) return 2;
  if (angle <= 30) return 1 + (30 - angle) / 25;
  if (angle >= 160) return 0.5;
  if (angle >= 130) return 1 - ((angle - 130) / 30) * 0.5;
  return 1;
}

export class EnemyAi {
  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  public lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  public burstLeft?: number; // バースト射撃の残弾
  public burstDelay?: number; // 次のバースト弾までの残り時間
  private lastBehaviorSim?: number;
  // 射撃の可否。false の間、behave は弾を撃たない。
  public fireEnabled = true;

  public constructor(
    private readonly owner: Vessel,
    private readonly worldSfx: WorldSfx,
    private readonly scene?: THREE.Scene,
  ) {}

  // 行動関数(同一集団の同時攻撃数カウント・弾追加は entities を使う)。
  public behave(simTime: number, target: Vessel, entities: EntityManager, simSpeed: SimSpeedManager, ephemeris: Ephemeris): void {
    // 射撃間隔は simulation time で計る。wall dt で計ると、同じゲーム内時間あたりの弾数が
    // 時間加速の段によって変わってしまう。
    const behaviorDt = this.lastBehaviorSim === undefined ? 0 : Math.max(0, simTime - this.lastBehaviorSim);
    this.lastBehaviorSim = simTime;
    if (!simSpeed.canShipAct) return;
    if (!this.fireEnabled) return;
    const dist = len(sub(target.state.r, this.owner.state.r));
    if (!(dist < C.STAGE00_MAX_RANGE && dist > C.ENEMY_AI_MIN_RANGE)) return;

    // バースト継続中なら次弾のタイミングだけ見る
    if (this.burstLeft && this.burstLeft > 0) {
      this.burstDelay = (this.burstDelay ?? 0) - behaviorDt;
      if (this.burstDelay <= 0) {
        this.firePlasma(simTime, target, entities, ephemeris);
        this.burstLeft--;
        this.burstDelay = C.ENEMY_BURST_INTERVAL;
      }
      return;
    }

    if (this.lastFireSim === undefined) this.lastFireSim = simTime - Math.random() * C.ENEMY_FIRE_INTERVAL;
    if (simTime - this.lastFireSim <= C.ENEMY_FIRE_INTERVAL) return;
    this.lastFireSim = simTime;

    // 新規バーストを始めるかどうかを抽選する
    if (this.attackingCountInGroup(entities) >= C.ENEMY_MAX_ATTACKERS_PER_GROUP) return;
    if (Math.random() >= C.ENEMY_ATTACK_CHANCE) return;
    const counts = C.ENEMY_BURST_COUNTS;
    this.burstLeft = counts[Math.floor(Math.random() * counts.length)]! - 1;
    this.burstDelay = C.ENEMY_BURST_INTERVAL;
    this.firePlasma(simTime, target, entities, ephemeris);
  }

  // 自分と同じ accent でバースト射撃中の個体数を数える。
  private attackingCountInGroup(entities: EntityManager): number {
    let n = 0;
    for (const v of entities.hostileVessels()) {
      if (v.alive && v.accent === this.owner.accent && v.ai && v.ai.burstLeft && v.ai.burstLeft > 0) n++;
    }
    return n;
  }

  // target へ向けた見越し射撃でプラズマ弾を1発生成し、entities に追加する。
  private firePlasma(simTime: number, target: Vessel, entities: EntityManager, ephemeris: Ephemeris): void {
    const r = this.owner.state.r;
    const v = this.owner.state.v;
    const toTarget = sub(target.state.r, r);
    const relV = sub(target.state.v, v);

    // 正確な見越し時間を計算
    let leadTime = solveLeadTime(toTarget, relV, C.PLASMA_BULLET_SPEED);
    if (leadTime === null || leadTime < 0) {
      leadTime = len(toTarget) / C.PLASMA_BULLET_SPEED; // フォールバック
    }

    const aimDir = norm(add(toTarget, scale(relV, leadTime)));
    const sunDir = ephemeris.sunDirFrom(r, simTime);
    const spreadScale = sunGlareSpreadScale(r, aimDir, sunDir);

    // 散布界をスケール適用
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * C.PLASMA_SPREAD_DEG * spreadScale * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);

    const bV = add(v, scale(actualAim, C.PLASMA_BULLET_SPEED));

    const pb = new Bullet(kinematicState(simTime, r, bV), C.PLASMA_LIFETIME, 'enemy', 'plasma', C.PLAYER_BULLET_DAMAGE, this.worldSfx, this.scene);
    pb.renderObject.position.set(r.x, r.y, r.z);
    // 進行方向に向ける
    const mz = new THREE.Matrix4().lookAt(
      new THREE.Vector3(),
      new THREE.Vector3(actualAim.x, actualAim.y, actualAim.z),
      new THREE.Vector3(0, 1, 0),
    );
    pb.renderObject.quaternion.setFromRotationMatrix(mz);

    entities.addBullet(pb);
  }
}
