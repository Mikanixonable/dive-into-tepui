
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Ship } from './ship';
import { Attitude } from '../../physics/attitude';
import { altitudeOf, OrbitState, orbitState, R_EARTH_EQ } from '../../physics/orbital';
import { OrbitLine } from '../../render/orbitline';
import { add, addScaled, dot, len, lenSq, norm, randPerp, rotateAxis, scale, sub, Vec3 } from '../../physics/vec3';
import { solveLeadTime } from '../../physics/intercept';
import { fmtMarkerDist } from '../hud/utils';
import { ACCENT_SECONDARY } from '../theme';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { buildEnemyShip, buildStage0EnemyShip } from '../../render/ships';
import { sunPosition } from '../../physics/ephemeris';
import { EffectsSystem } from '../vfx/effects-system';
import { Player } from '../player/player';
import { Bullet } from './bullet';
import type { Stage } from '../stages/stage';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';

// Enemy の見た目の種別。どの build を呼ぶかをコンストラクタ内部で選ぶための判別用。
export type EnemyKind = { kind: 'drifting' } | { kind: 'stage0'; typeIndex: number };

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

// enemyKind の種別に応じたメッシュを組む。
function buildEnemyObj(enemyKind: EnemyKind, accent: string | number): THREE.Object3D {
  return enemyKind.kind === 'stage0' ? buildStage0EnemyShip(accent, enemyKind.typeIndex) : buildEnemyShip(accent);
}

export class Enemy extends Ship {
  accent: string | number; // マーカー色・集団識別。全敵が保持する
  waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う
  readonly orbitLine: OrbitLine;

  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  burstLeft?: number; // バースト射撃の残弾
  burstDelay?: number; // 次のバースト弾までの残り時間
  private lastBehaviorSim?: number;
  // false の間はこの機体が射撃を行わない。移動・AI の他の判定には影響しない。
  fireEnabled = true;

  private readonly _sfx: Sfx;
  private readonly _fx: EffectsSystem;

  // enemyKind に応じたメッシュで Ship を初期化し、専用の軌道線をシーンへ追加する。
  constructor(
    name: string,
    state: OrbitState,
    enemyKind: EnemyKind,
    att: Attitude,
    hp: number,
    accent: string | number,
    orbitLineColor: string | number,
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
    // 自身の軌道線を作ってシーンへ登録する
    this.orbitLine = new OrbitLine(orbitLineColor, 0.35);
    scene?.add(this.orbitLine.line);
  }

  // メッシュと軌道線をシーンから取り除く。
  dispose(): void {
    super.dispose();
    this.scene?.remove(this.orbitLine.line);
    this.orbitLine.dispose();
  }

  // 個体色の CSS 表記。方位マーカー・LEAD マーカーの着色に使う。
  get accentColor(): string {
    if (typeof this.accent === 'string') return this.accent;
    return '#' + this.accent.toString(16).padStart(6, '0');
  }

  // 逆三角形を辺中央の切り欠きで分割し、残HPに応じて発光するSVGを生成する。
  // 分割数は3の倍数へ丸めるため、将来HPが12/18になっても多重リングへ拡張しやすい。
  private hpMarkerSvg(): string {
    const segments = Math.max(3, Math.round(this.maxHp / 3) * 3);
    const lit = Math.max(0, Math.min(segments, Math.round((this.hp / this.maxHp) * segments)));
    const points: [number, number][] = [[12, 3], [3, 21], [21, 21]];
    const lines: string[] = [];
    const emit = (i: number, j: number, k: number, a: number, b: number): void => {
      if (b <= a) return;
      const [x1, y1] = points[i]!;
      const [x2, y2] = points[(i + 1) % 3]!;
      const color = (i * k + j) < lit ? 'currentColor' : 'rgba(120,125,130,.2)';
      lines.push(`<line x1="${x1 + (x2 - x1) * a}" y1="${y1 + (y2 - y1) * a}" x2="${x1 + (x2 - x1) * b}" y2="${y1 + (y2 - y1) * b}" stroke="${color}" stroke-width="1.5" stroke-linecap="butt"/>`);
    };
    for (let i = 0; i < 3; i++) {
      const k = segments / 3;
      // 頂点は連続させ、各辺の中央だけを切り欠く。
      for (let j = 0; j < k; j++) {
        const a = j / k;
        const b = (j + 1) / k;
        const notch = 0.09;
        if (a < 0.5 && b > 0.5) {
          emit(i, j, k, a, 0.5 - notch / 2);
          emit(i, j, k, 0.5 + notch / 2, b);
        } else {
          emit(i, j, k, a, b);
        }
      }
    }
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">${lines.join('')}</svg>`;
  }

  // pos は機体メッシュと同じ表示時刻の位置(displayState 経由)を使う。role が第一/第二
  // ターゲットのどちらでもなければ通常の敵マーカーになる。
  markerItem(role: 'none' | 'primary' | 'secondary', viewerPos: Vec3, pos: Vec3): GroupedMarkerItem {
    // 距離は優先度(近いほど高)とラベル表示の両方に使う
    const dist = len(sub(pos, viewerPos));
    // 代表選出の優先度: 第一ターゲット > 第二ターゲット > 距離が近い順
    const priority = role === 'primary' ? Infinity : role === 'secondary' ? Number.MAX_SAFE_INTEGER : -dist;
    const color = role === 'secondary' ? ACCENT_SECONDARY : undefined;
    return {
      key: `enemy-${this.name}`,
      cls: role === 'primary' ? 'mk-target' : 'mk-enemy',
      sym: this.hpMarkerSvg(),
      pos,
      priority,
      name: this.name,
      detail: fmtMarkerDist(dist),
      bearingColor: role === 'secondary' ? ACCENT_SECONDARY : this.accentColor,
      color,
      symMarkup: true,
    };
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private hitEffect(bullet: Bullet, hitR: Vec3): void {
    this._sfx.hit();
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(hitR, this.state.v);
    } else {
      this._fx.spawnBulletFlash(hitR, this.state.v);
    }
    this._fx.spawnGasPuff(hitR, this.state.v);
  }

  // 撃破時の爆発音・エフェクトを発生させる。
  private destroyEffect(): void {
    this._sfx.explosion();
    // 敵機は自機の ENEMY_SCALE 倍サイズなので、撃破エフェクトも見合った大きさにする
    this._fx.spawnShipDestroyEffect(this.state, C.ENEMY_SCALE, C.COLOR_ENEMY_DESTROY_FRAG);
  }

  // 被弾によるダメージ・致死判定。
  attacked(bullet: Bullet, simTime: number, activeStage: Stage, hitR: Vec3): void {
    if (!this.alive) return;
    if (bullet.shooter === 'enemy') return; // 敵弾の被弾は無効化

    activeStage.scoreCounter.recordHit();

    this.hp -= C.ENEMY_HIT_DAMAGE;
    if (this.hp > 0) {
      this.hitEffect(bullet, hitR);
      return;
    }

    // HP が尽きたので撃破処理へ
    this.alive = false;
    activeStage.recordEnemyDeath(this, simTime, 'killed');
    this.destroyEffect();
  }

  // 自機との高速接触によるダメージ・致死判定。speed は接触時の相対速度 [m/s]。
  collidedAtSpeed(speed: number, simTime: number, activeStage: Stage): void {
    if (!this.alive) return;

    if (!this.applyCollisionDamage(speed)) return;
    if (this.hp > 0) {
      this._sfx.clank();
      this._fx.spawnGasPuff(this.state.r, this.state.v);
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
  behave(_dt: number, simTime: number, player: Player, entities: EntityManager, simSpeed: SimSpeedManager): void {
    // 射撃間隔はsimulation timeで統一する。wall dtを混ぜると×4時だけバースト間隔が
    // 4倍に引き伸ばされ、同じゲーム内時間でもwarp段によって弾数が変わっていた。
    const behaviorDt = this.lastBehaviorSim === undefined ? 0 : Math.max(0, simTime - this.lastBehaviorSim);
    this.lastBehaviorSim = simTime;
    if (!player.alive) return;
    if (!simSpeed.canEnemyFire) return;
    if (!this.fireEnabled) return;
    const dist = len(sub(player.state.r, this.state.r));
    if (!(dist < C.STAGE00_MAX_RANGE && dist > C.ENEMY_AI_MIN_RANGE)) return;

    // バースト継続中なら次弾のタイミングだけ見る
    if (this.burstLeft && this.burstLeft > 0) {
      this.burstDelay = (this.burstDelay ?? 0) - behaviorDt;
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

    // 新規バーストを始めるかどうかを抽選する
    const countInGroup = this.attackingCountInGroup(entities.enemies);
    if (countInGroup >= C.ENEMY_MAX_ATTACKERS_PER_GROUP || Math.random() >= C.ENEMY_ATTACK_CHANCE) return;
    const counts = C.ENEMY_BURST_COUNTS;
    this.burstLeft = counts[Math.floor(Math.random() * counts.length)]! - 1;
    this.burstDelay = C.ENEMY_BURST_INTERVAL;
    this.firePlasma(simTime, player, entities);
  }

  // enemies のうち、自分と同じ accent でバースト射撃中の個体数を数える。
  private attackingCountInGroup(enemies: readonly Enemy[]): number {
    let n = 0;
    for (const e of enemies) {
      if (e.alive && e.accent === this.accent && e.burstLeft && e.burstLeft > 0) n++;
    }
    return n;
  }

  // player へ向けた見越し射撃でプラズマ弾を1発生成し、entities に追加する。
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

    const sunDir = norm(sunPosition(simTime, 0));
    const spreadScale = sunGlareSpreadScale(r, aimDir, sunDir);

    // 散布界をスケール適用
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * C.PLASMA_SPREAD_DEG * spreadScale * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);

    const bV = add(v, scale(actualAim, C.PLASMA_BULLET_SPEED));

    const pb = new Bullet(orbitState(simTime, r, bV), C.PLASMA_LIFETIME, 'enemy', 'plasma', this.scene);
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
