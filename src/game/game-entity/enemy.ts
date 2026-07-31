
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Ship } from './game-entity';
import { Attitude } from '../../physics/attitude';
import { altitudeOf, OrbitState, orbitState } from '../../physics/orbital';
import { OrbitLine } from '../../render/orbitline';
import { add, len, norm, randPerp, rotateAxis, scale, sub, Vec3 } from '../../physics/vec3';
import { solveLeadTime } from '../../physics/intercept';
import { fmtMarkerDist } from '../hud/utils';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { buildEnemyShip, buildStage0EnemyShip } from '../../render/ships';
import { EffectsSystem } from '../vfx/effects-system';
import { Player } from '../player/player';
import { Bullet } from './bullet';
import type { Stage } from '../stages/stage';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import type { EntityManager } from './entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';

// Enemy の見た目の種別。どの build を呼ぶかをコンストラクタ内部で選ぶための判別用。
export type EnemyKind = { kind: 'drifting' } | { kind: 'stage0'; typeIndex: number };

function buildEnemyObj(enemyKind: EnemyKind, accent: number): THREE.Object3D {
  return enemyKind.kind === 'stage0' ? buildStage0EnemyShip(accent, enemyKind.typeIndex) : buildEnemyShip(accent);
}

export class Enemy extends Ship {
  accent: number; // マーカー色・集団識別。全敵が保持する
  waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う
  readonly orbitLine: OrbitLine;

  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  burstLeft?: number; // バースト射撃の残弾
  burstDelay?: number; // 次のバースト弾までの残り時間

  // hud は現状 Enemy 自身のメソッドからは未使用だが、hud/sfx は必ず対で注入する方針のため
  // 受け取る(hud はフィールドとしては保持しない)。
  private readonly _sfx: Sfx;
  private readonly _fx: EffectsSystem;

  constructor(
    name: string,
    state: OrbitState,
    enemyKind: EnemyKind,
    att: Attitude,
    hp: number,
    accent: number,
    orbitLineColor: number,
    _hud: Hud,
    sfx: Sfx,
    fx: EffectsSystem,
    waveId?: number,
    scene?: THREE.Scene,
  ) {
    super(name, state, buildEnemyObj(enemyKind, accent), att, C.ENEMY_RADIUS, hp, scene);
    this._sfx = sfx;
    this._fx = fx;
    this.accent = accent;
    this.waveId = waveId;
    this.mass = 10000;
    this.collideRadius = C.ENEMY_RADIUS;
    this.obj.scale.setScalar(C.ENEMY_SCALE);
    this.orbitLine = new OrbitLine(orbitLineColor, 0.35);
    scene?.add(this.orbitLine.line);
  }

  dispose(): void {
    super.dispose();
    this.scene?.remove(this.orbitLine.line);
    this.orbitLine.dispose();
  }

  // 個体色の CSS 表記。方位マーカー・LEAD マーカーの着色に使う。
  get accentColor(): string {
    return '#' + this.accent.toString(16).padStart(6, '0');
  }

  // 画面マーカー集合(GroupedMarkers)へ渡す自分の見た目とラベル。近接する敵をまとめる
  // 判断は集合側の責務なので、ここでは「まとめられたら代表になりたい度」を priority で示す
  // だけにする(ターゲット最優先、次いで近い順)。pos は呼び出し側(Game.sync)が
  // displayState から渡す — 機体メッシュと同じ表示時刻の位置を使わないと、未来ゴースト表示中に
  // 「機体は未来位置、◇マーカーは現在位置」で明確に壊れて見える(better_predict.md Step 4)。
  markerItem(isTarget: boolean, viewerPos: Vec3, pos: Vec3): GroupedMarkerItem {
    const dist = len(sub(pos, viewerPos));
    return {
      key: `enemy-${this.name}`,
      cls: isTarget ? 'mk-target' : 'mk-enemy',
      sym: '◇',
      pos,
      priority: isTarget ? Infinity : -dist,
      name: this.name,
      detail: fmtMarkerDist(dist),
      bearingColor: this.accentColor,
    };
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。attacked からのみ呼ばれる。
  private hitEffect(bullet: Bullet): void {
    this._sfx.hit();
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(bullet.state.r, this.state.v);
    } else {
      this._fx.spawnBulletFlash(bullet.state.r, this.state.v);
    }
    this._fx.scatterFragments(this.state.t, bullet.state.r, this.state.v, C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
  }

  private destroyEffect(): void {
    this._sfx.explosion();
    // 敵機は自機の ENEMY_SCALE 倍サイズなので、撃破エフェクトも見合った大きさにする
    this._fx.spawnShipDestroyEffect(this.state, C.ENEMY_SCALE, 0xff6a4a);
  }

  // 被弾によるダメージ・致死判定。
  attacked(bullet: Bullet, simTime: number, activeStage: Stage): void {
    if (!this.alive) return;
    if (bullet.shooter === 'enemy') return; // 敵弾の被弾は無効化

    activeStage.scoreCounter.recordHit();

    this.hp -= C.ENEMY_HIT_DAMAGE;
    if (this.hp > 0) {
      this.hitEffect(bullet);
      return;
    }

    this.alive = false;
    activeStage.recordEnemyDeath(this, simTime, 'killed');
    this.destroyEffect();
  }

  // 交戦圏外への離脱によるデスポーン。
  despawn(simTime: number, activeStage: Stage): void {
    if (!this.alive) return;
    this.alive = false;
    activeStage.recordEnemyDeath(this, simTime, 'despawn');
  }

  // 再突入による自然死。alive がすでに false なら何もしない(多重処理防止)。
  checkLoss(_dt: number, simTime: number, activeStage: Stage, _playerPos: Vec3): void {
    if (!this.alive) return;
    if (altitudeOf(this.state.r) >= C.REENTRY_ALT) return;
    this.alive = false;
    this.destroyEffect();
    activeStage.recordEnemyDeath(this, simTime, 'reentry');
  }

  // 行動関数(同一集団の同時攻撃数カウント・弾追加は entities を使う)。
  behave(dt: number, simTime: number, player: Player, entities: EntityManager, simSpeed: SimSpeedManager): void {
    if (!player.alive) return;
    if (!simSpeed.canEnemyFire) return;
    const dist = len(sub(player.state.r, this.state.r));
    if (!(dist < C.STAGE00_MAX_RANGE && dist > C.ENEMY_AI_MIN_RANGE)) return;

    if (this.burstLeft && this.burstLeft > 0) {
      this.burstDelay = (this.burstDelay ?? 0) - dt;
      if (this.burstDelay <= 0) {
        this.firePlasma(simTime, player, entities);
        this.burstLeft--;
        this.burstDelay = C.ENEMY_BURST_INTERVAL;
      }
      return;
    }

    if (this.lastFireSim === undefined) this.lastFireSim = simTime - Math.random() * C.ENEMY_FIRE_INTERVAL;
    if (simTime - this.lastFireSim <= C.ENEMY_FIRE_INTERVAL) return;
    this.lastFireSim = simTime;

    const countInGroup = this.attackingCountInGroup(entities.enemies);
    if (countInGroup >= C.ENEMY_MAX_ATTACKERS_PER_GROUP || Math.random() >= C.ENEMY_ATTACK_CHANCE) return;
    const counts = C.ENEMY_BURST_COUNTS;
    this.burstLeft = counts[Math.floor(Math.random() * counts.length)]! - 1;
    this.burstDelay = C.ENEMY_BURST_INTERVAL;
    this.firePlasma(simTime, player, entities);
  }

  private attackingCountInGroup(enemies: readonly Enemy[]): number {
    let n = 0;
    for (const e of enemies) {
      if (e.alive && e.accent === this.accent && e.burstLeft && e.burstLeft > 0) n++;
    }
    return n;
  }

  private firePlasma(simTime: number, player: Player, entities: EntityManager): void {
    const r = this.state.r;
    const v = this.state.v;
    const toPlayer = sub(player.state.r, r);
    const relV = sub(player.state.v, v);

    // 正確な見越し時間を計算
    let timeToHit = solveLeadTime(toPlayer, relV, C.PLASMA_BULLET_SPEED);
    if (timeToHit === null || timeToHit < 0) {
      timeToHit = len(toPlayer) / C.PLASMA_BULLET_SPEED; // フォールバック
    }

    const predictedRelPos = add(toPlayer, scale(relV, timeToHit));
    const aimDir = norm(predictedRelPos);

    // 散布界を非常に小さくして、正確に狙う
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * C.PLASMA_SPREAD_DEG * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);

    const bV = add(v, scale(actualAim, C.PLASMA_BULLET_SPEED));

    const pb = new Bullet(orbitState(simTime, r, bV), C.PLASMA_LIFETIME, 'enemy', 'plasma', this.scene, this.accent);
    pb.obj.position.set(r.x, r.y, r.z);
    // 進行方向に向ける
    const mz = new THREE.Matrix4().lookAt(
      new THREE.Vector3(),
      new THREE.Vector3(actualAim.x, actualAim.y, actualAim.z),
      new THREE.Vector3(0, 1, 0),
    );
    pb.obj.quaternion.setFromRotationMatrix(mz);

    entities.addBullet(pb);
  }
}
