
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Ship } from './ship';
import { CelestialBody } from '../../physics/celestial-body';

import { GameEntity } from './game-entity';
import { closingSpeed, type Contact } from './contact';
import { contactDamageSpeed } from './contact-damage';
import { Attitude } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { R_EARTH_EQ } from '../../physics/solar-system';
import { add, addScaled, dot, len, lenSq, norm, randPerp, rotateAxis, scale, sub, Vec3, v3 } from '../../physics/vec3';
import { solveLeadTime } from '../../physics/intercept';
import { fmtMarkerDist } from '../hud/utils';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import { buildEnemyShip, buildStage0EnemyShip } from '../../render/ships';
import type { Ephemeris } from '../../physics/ephemeris';
import { EffectsSystem } from '../vfx/effects-system';
import { Player } from '../player/player';
import { Bullet } from './bullet';
import type { EnemyDeathCause, Stage } from '../stages/stage';
import { Hud } from '../hud/hud';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';
import type { EnemySaveData } from '../save-data';
import { currentThemePalette } from '../theme';

// Enemy の見た目の種別。どの build を呼ぶかをコンストラクタ内部で選ぶための判別用。
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

// enemyKind の種別に応じたメッシュを組む。
function buildEnemyRenderObject(enemyKind: EnemyKind, accent: string | number): THREE.Object3D {
  return enemyKind.kind === 'stage0' ? buildStage0EnemyShip(accent, enemyKind.typeIndex) : buildEnemyShip(accent);
}

// 新規配置は各フィールドを直接渡し、スナップショットからの再開は saved を simTime の
// epoch で展開する(accent/orbitLineColor は保存された accent 1つから両方導く)。
export type EnemyInit =
  | {
    readonly name: string;
    readonly state: KinematicState;
    readonly enemyKind: EnemyKind;
    readonly att: Attitude;
    readonly accent: string | number;
    readonly orbitLineColor: string | number;
    readonly waveId?: number;
    readonly id?: string;
  }
  | { readonly saved: EnemySaveData; readonly simTime: number };

export class Enemy extends Ship {
  // 敵機は熱防御を持たないので、自機より低い温度で構造が保たなくなる。
  protected readonly maxTemperature = C.ENEMY_MAX_TEMP;
  accent: string | number; // マーカー色・集団識別。全敵が保持する
  waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う
  readonly orbitLineColor: string | number;

  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  burstLeft?: number; // バースト射撃の残弾
  burstDelay?: number; // 次のバースト弾までの残り時間
  private lastBehaviorSim?: number;
  // false の間はこの機体が射撃を行わない。移動・AI の他の判定には影響しない。
  fireEnabled = true;

  private readonly _worldSfx: WorldSfx;
  private readonly _fx: EffectsSystem;
  public readonly enemyKind: EnemyKind;

  // init の enemyKind に応じたメッシュで Ship を初期化し、専用の軌道線をシーンへ追加する。
  constructor(
    init: EnemyInit,
    _hud: Hud,
    worldSfx: WorldSfx,
    fx: EffectsSystem,
    scene?: THREE.Scene,
  ) {
    const { name, state, enemyKind, att, accent, orbitLineColor, waveId, id } = 'saved' in init
      ? {
        name: init.saved.name || '',
        state: kinematicState(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        enemyKind: init.saved.enemyKind,
        att: { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: inertiaForEnemyKind(init.saved.enemyKind) } as Attitude,
        accent: init.saved.accent,
        orbitLineColor: init.saved.accent,
        waveId: init.saved.waveId,
        id: init.saved.id || undefined,
      }
      : init;
    const renderObject = buildEnemyRenderObject(enemyKind, accent);
    super(name, state, renderObject, att, C.ENEMY_RADIUS, C.ENEMY_MAX_HP, scene, id);
    this._worldSfx = worldSfx;
    this._fx = fx;
    this.enemyKind = enemyKind;
    this.accent = accent;
    this.waveId = waveId;
    this.mass = 10000;
    this.collides = true;
    this.doPreciseReentry = true;
    this.renderObject.scale.setScalar(C.ENEMY_SCALE);
    // 描画メッシュの実スケール後バウンディング球を、弾丸・物理接触の両判定に共有する。
    const visualBounds = new THREE.Box3().setFromObject(this.renderObject);
    const visualSphere = visualBounds.getBoundingSphere(new THREE.Sphere());
    this.radius = visualSphere.radius;
    this.orbitLineColor = orbitLineColor;

    if ('saved' in init) {
      this.setOverallHp(init.saved.health);
      this.burstLeft = init.saved.burstLeft;
      this.burstDelay = init.saved.burstDelay;
      this.alive = init.saved.alive;
      if (!this.alive) this.renderObject.visible = false;
    }
  }

  // 個体色の CSS 表記。方位マーカー・LEAD マーカーの着色に使う。
  get accentColor(): string {
    if (typeof this.accent === 'string') return this.accent;
    return '#' + this.accent.toString(16).padStart(6, '0');
  }



  // pos/vel は機体メッシュと同じ表示時刻の状態(displayState 経由)を使う。role がターゲットで
  // なければ通常の敵マーカーになる。overviewMode では進行方向へ回るヘッダーアイコンを、
  // 戦闘ビューでは従来の切り欠き三角形を使う。
  markerItem(role: 'none' | 'primary', viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean): GroupedMarkerItem {
    // 距離は優先度(近いほど高)とラベル表示の両方に使う
    const dist = len(sub(pos, viewerPos));
    // 代表選出の優先度: ターゲット > 距離が近い順 (天体 > 船・エンティティ)
    const priority = role === 'primary' ? C.MARKER_PRIORITY.PRIMARY_TARGET : C.MARKER_PRIORITY.ENEMY - dist / 1e9;
    return {
      key: `enemy-${this.name}`,
      cls: role === 'primary' ? 'mk-enemy mk-target' : 'mk-enemy',
      sym: overviewMode ? this.headingHpMarkerSvg(true) : this.hpMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      detail: overviewMode ? '' : fmtMarkerDist(dist),
      // 敵本体・距離ラベル・画面外方位マーカーは同じ色で統一する。ターゲット中は第二アクセントカラーで強調する。
      bearingColor: role === 'primary' ? currentThemePalette().secondary : C.COLOR_MARKER_ENEMY,
      bearingSym: ENTITY_GLYPH.enemyShip,
      bearingClass: 'mk-dir mk-bearing-triangle',
      color: role === 'primary' ? currentThemePalette().secondary : C.COLOR_MARKER_ENEMY,
      symMarkup: true,
    };
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private impactEffect(bullet: Bullet, impactPoint: Vec3): void {
    this._worldSfx.enemyHit();
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(kinematicState(this.state.t, impactPoint, this.state.v));
    } else {
      this._fx.spawnBulletFlash(kinematicState(this.state.t, impactPoint, this.state.v));
    }
    this._fx.spawnGasPuff(kinematicState(this.state.t, impactPoint, this.state.v));
  }

  // 撃破時の爆発音・エフェクトを発生させる。
  private destroyEffect(): void {
    this._worldSfx.explosion();
    // 敵機は自機の ENEMY_SCALE 倍サイズなので、撃破エフェクトも見合った大きさにする
    this._fx.spawnShipDestroyEffect(this.state, C.ENEMY_SCALE, C.COLOR_ENEMY_DESTROY_FRAG);
  }

  // 被弾によるダメージ・致死判定。
  private attackedByBullet(bullet: Bullet, impactPoint: Vec3, simTime: number, activeStage: Stage): void {
    activeStage.scoreCounter.recordHit();

    this.applyDamageToParts(bullet.damage);
    if (this.hp > 0) {
      this.impactEffect(bullet, impactPoint);
      return;
    }

    // HP が尽きたので撃破処理へ
    this.alive = false;
    activeStage.recordEnemyDeath(this, simTime, 'killed');
    this.destroyEffect();
  }

  // 弾は武装のダメージを、それ以外は接触の接近速度と相手の種別を根拠にする
  // (どちらもゲームバランスの量で、物理の質量からは導かない)。
  collideWithEntity(other: GameEntity, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;
    const simTime = contact.selfState.t;

    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, simTime, activeStage);
      return;
    }

    // 他の実体との接触で沈めば、交戦の結果として記録する。
    this.damagedByContact(contactDamageSpeed(other, contact), simTime, 'killed', activeStage);
  }

  // 天体の固体表面への接触。相手の種別による重みが無いので接近速度がそのまま根拠になり、
  // 沈めば自然損耗として記録する。
  collideWithCelestialBody(_body: CelestialBody, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;
    this.damagedByContact(closingSpeed(contact), contact.selfState.t, 'collision', activeStage);
  }

  // 接触ダメージを当て、HP が残れば音とパフ、尽きたら cause の撃破として記録する。
  private damagedByContact(
    damageSpeed: number, simTime: number, cause: EnemyDeathCause, activeStage: Stage,
  ): void {
    if (!this.applyCollisionDamage(damageSpeed)) return;
    if (this.hp > 0) {
      this._worldSfx.clank();
      this._fx.spawnGasPuff(this.state);
      return;
    }

    this.alive = false;
    activeStage.recordEnemyDeath(this, simTime, cause);
    this.destroyEffect();
  }

  // 交戦圏外への離脱によるデスポーン。
  despawn(simTime: number, activeStage: Stage): void {
    if (!this.alive) return;
    this.alive = false;
    activeStage.recordEnemyDeath(this, simTime, 'despawn');
  }

  // 大気での焼失による自然死。固体表面への接触は collideWithCelestialBody が扱う。
  protected override burnUp(activeStage: Stage): void {
    this.alive = false;
    this.destroyEffect();
    activeStage.recordEnemyDeath(this, this.state.t, 'burnup');
  }

  // 行動関数(同一集団の同時攻撃数カウント・弾追加は entities を使う)。
  behave(_dt: number, simTime: number, player: Player, entities: EntityManager, simSpeed: SimSpeedManager, ephemeris: Ephemeris): void {
    // 射撃間隔はsimulation timeで統一する。wall dtを混ぜると×4時だけバースト間隔が
    // 4倍に引き伸ばされ、同じゲーム内時間でもwarp段によって弾数が変わっていた。
    const behaviorDt = this.lastBehaviorSim === undefined ? 0 : Math.max(0, simTime - this.lastBehaviorSim);
    this.lastBehaviorSim = simTime;
    if (!simSpeed.canShipAct) return;
    if (!this.fireEnabled) return;
    const dist = len(sub(player.state.r, this.state.r));
    if (!(dist < C.STAGE00_MAX_RANGE && dist > C.ENEMY_AI_MIN_RANGE)) return;

    // バースト継続中なら次弾のタイミングだけ見る
    if (this.burstLeft && this.burstLeft > 0) {
      this.burstDelay = (this.burstDelay ?? 0) - behaviorDt;
      if (this.burstDelay <= 0) {
        this.firePlasma(simTime, player, entities, ephemeris);
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
    this.firePlasma(simTime, player, entities, ephemeris);
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
  private firePlasma(simTime: number, player: Player, entities: EntityManager, ephemeris: Ephemeris): void {
    const r = this.state.r;
    const v = this.state.v;
    const toPlayer = sub(player.state.r, r);
    const relV = sub(player.state.v, v);

    // 正確な見越し時間を計算
    let leadTime = solveLeadTime(toPlayer, relV, C.PLASMA_BULLET_SPEED);
    if (leadTime === null || leadTime < 0) {
      leadTime = len(toPlayer) / C.PLASMA_BULLET_SPEED; // フォールバック
    }

    const predictedRelPos = add(toPlayer, scale(relV, leadTime));
    const aimDir = norm(predictedRelPos);

    const sunDir = ephemeris.sunDirFrom(r, simTime);
    const spreadScale = sunGlareSpreadScale(r, aimDir, sunDir);

    // 散布界をスケール適用
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * C.PLASMA_SPREAD_DEG * spreadScale * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);

    const bV = add(v, scale(actualAim, C.PLASMA_BULLET_SPEED));

    const pb = new Bullet(kinematicState(simTime, r, bV), C.PLASMA_LIFETIME, 'enemy', 'plasma', C.PLAYER_BULLET_DAMAGE, this._worldSfx, this.scene);
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

  // セーブデータへ変換する。
  serialize(): EnemySaveData {
    return {
      id: this.id,
      name: this.name,
      kind: 'enemy',
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      enemyKind: this.enemyKind,
      alive: this.alive,
      health: this.hp,
      accent: this.accent,
      waveId: this.waveId,
      burstLeft: this.burstLeft,
      burstDelay: this.burstDelay,
    };
  }
}
