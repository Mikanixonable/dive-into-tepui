import * as THREE from 'three/webgpu';
import { Ship, MUZZLE_SPEED } from './ship';
import { CelestialMotion } from '../../../physics/celestial-motion';
import { DynamicEntity } from './dynamic-entity';
import { closingSpeed, type Contact } from './contact';
import { contactDamageSpeed } from './contact-damage';
import { KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { add, addScaled, dot, len, lenSq, norm, randPerp, rotateAxis, scale, sub, Vec3, v3 } from '../../../math/vec3';
import { solveLeadTime } from '../../../physics/intercept';
import { EffectsSystem } from '../../vfx/effects-system';
import { Player } from '../../player/player';
import { Bullet } from './bullet';
import { WorldSfx } from '../../../audio/sfx/world-sfx';
import { R_EARTH_EQ } from '../../celestial/solar-system/constants';
import { fmtDist, fmtMarkerDist, fmtSpeed } from '../../hud/utils';
import { relativeInfo } from '../../hud/orbit/orbit-info';
import { orbitRows } from '../../pickable/orbit-rows';
import { ENTITY_GLYPH, COLOR_MARKER_ENEMY } from '../../marker/marker-identity';
import { currentThemePalette } from '../../theme';
import { ENEMY_DESTROY_FRAG_COLOR } from '../../../render/vfx-style';
import type { Quat } from '../../../physics/attitude';
import type { DynamicEntityKind } from './entity-kind';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { EnemyDeathCause, Stage } from '../../stages/stage';
import type { DynamicSystem } from '../../dynamic/dynamic-system';
import type { SimSpeedManager } from '../../dynamic/sim-speed-manager';
import type { EnemySaveData } from '../../save/save-data';
import type { ProteinAssetId } from '../../protein/protein-asset-loader';
import { MARKER_PRIORITY, type MarkerManager } from '../../marker/marker-manager';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import type { MapPickKind, MapPickable } from '../../pickable/map-pickable';
import type { MapCommands } from '../../pickable/map-commands';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window';
import type { MapVisibility, MapVisibilityPolicy } from '../../map/visibility-policy';

// 敵機は熱防御を持たないので、艦より低い温度で構造が保たなくなる。降下してくる艦がこの温度に
// 達するのは、地球の大気では高度 80 km 付近。
const ENEMY_MAX_TEMP = 500; // [K]

const ENEMY_MAX_HP = 6; // 敵機の総 HP
const ENEMY_MASS = 10000; // 敵機の質量 [kg]

export const ENEMY_SCALE = 20; // 見た目メッシュに掛けるスケール

export const PLASMA_BULLET_DAMAGE = 1.25; // 自機がプラズマ弾で被弾した際のダメージ [HP]

const PLASMA_BULLET_SPEED = MUZZLE_SPEED * 2 / 3; // MUZZLE_SPEED の 2/3
const PLASMA_LIFETIME = 300; // プラズマ弾の寿命 [sim s]
const ENEMY_FIRE_INTERVAL = 1.0; // 敵の射撃間隔 [s]
const ENEMY_BURST_INTERVAL = 0.08; // 敵のバースト射撃時の連射間隔 [s]
const ENEMY_AI_MIN_RANGE = 50; // これより近いと射撃しない(至近距離) [m]
// 交戦圏の半径 [m]。これより遠い自機は撃たず、ステージ00 の湧きもこの外へ出た敵を消す。
export const STAGE00_MAX_RANGE = 30000;
const ENEMY_MAX_ATTACKERS_PER_GROUP = 3; // 同一集団内で同時に攻撃する最大機数
const ENEMY_ATTACK_CHANCE = 0.6; // 各機が攻撃(バースト)を開始する確率
const ENEMY_BURST_COUNTS = [3, 5, 7, 20]; // バースト射撃弾数の候補
const PLASMA_SPREAD_DEG = 0.05; // プラズマ弾の散布角 [deg]

// 軌道物体一覧で接近中として扱う、自艦との距離 [m]。
const ENEMY_APPROACH_DIST = 2e5;

// タンパク質陣形における敵の役割。
export type FormationRole = 'attacker' | 'shield' | 'energy';

// スナップショットからの再開。復元の腕は全具象で共通でなければならない。
export type EnemyRestore = { readonly saved: EnemySaveData; readonly simTime: number };

// 新規配置。具象ごとに固有の項目(機体テンプレート番号・タンパク質アセット)を足して使う。
export type EnemyPlacement = {
  readonly name: string;
  readonly state: KinematicState;
  readonly q: Quat;
  readonly w: Vec3;
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly waveId?: number;
  readonly id?: string;
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
};

// 敵クラスの静的側。セーブからの復元はここから読む。
export interface EnemyClass {
  // セーブへ書く具象タグ。
  readonly kind: EnemySaveData['kind'];
  // 復元に fetch 済みアセットが要るなら、その id。要らなければ null。
  pendingAssetId(saved: EnemySaveData): ProteinAssetId | null;
  new (init: EnemyRestore, worldSfx: WorldSfx, fx: EffectsSystem, scene?: THREE.Scene): Enemy;
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

// 敵に共通するもの — 識別・色・陣形所属、バースト射撃の AI、マーカー、被弾と撃破の演出、交戦圏
// 離脱・焼失・衝突の記録。機体が何でできているか(メッシュ・被弾モデル・判定形状)は具象が持つ。
export abstract class Enemy extends Ship implements MapPickable {
  public readonly mapKind: DynamicEntityKind = 'enemy';

  // 敵機は熱防御を持たないので、自機より低い温度で構造が保たなくなる。
  protected readonly maxTemperature = ENEMY_MAX_TEMP;
  public readonly accent: string | number; // マーカー色・集団識別。全敵が保持する
  public readonly waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う
  public readonly formationId?: string;
  public readonly formationRole?: FormationRole;
  public readonly orbitLineColor: string | number;

  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  private lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  private burstLeft?: number; // バースト射撃の残弾
  private burstDelay?: number; // 次のバースト弾までの残り時間
  private lastBehaviorSim?: number;
  // false の間はこの機体が射撃を行わない。移動・AI の他の判定には影響しない。
  public fireEnabled = true;

  protected readonly _worldSfx: WorldSfx;
  protected readonly _fx: EffectsSystem;

  // 具象が組み終えた機体(スケール適用済みのメッシュ・主慣性モーメント・接触半径)を受けて、
  // 敵に共通する識別・色・陣形所属を初期化する。復元時は保存済みの生死・バースト状態も戻す。
  protected constructor(
    init: EnemyPlacement | EnemyRestore,
    renderObject: THREE.Object3D,
    inertia: Vec3,
    radius: number,
    worldSfx: WorldSfx,
    fx: EffectsSystem,
    scene?: THREE.Scene,
  ) {
    // 復元と新規配置を同じ形へ均してから基底へ渡す。
    const placed: EnemyPlacement = 'saved' in init
      ? {
        name: init.saved.name || '',
        state: kinematicState<'eci'>(
          init.simTime,
          v3(init.saved.r.x, init.saved.r.y, init.saved.r.z),
          v3(init.saved.v.x, init.saved.v.y, init.saved.v.z),
        ),
        q: { ...init.saved.q },
        w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z),
        accent: init.saved.accent,
        orbitLineColor: init.saved.orbitLineColor,
        waveId: init.saved.waveId,
        id: init.saved.id || undefined,
        formationId: init.saved.formationId,
        formationRole: init.saved.formationRole,
      }
      : init;
    super(
      placed.name, placed.state, renderObject, { q: placed.q, w: placed.w, inertia },
      radius, ENEMY_MAX_HP, scene, placed.id,
    );
    this._worldSfx = worldSfx;
    this._fx = fx;
    this.accent = placed.accent;
    this.orbitLineColor = placed.orbitLineColor;
    this.waveId = placed.waveId;
    this.formationId = placed.formationId;
    this.formationRole = placed.formationRole;
    this.mass = ENEMY_MASS;
    this.collides = true;
    this.doPreciseReentry = true;

    if ('saved' in init) {
      this.burstLeft = init.saved.burstLeft;
      this.burstDelay = init.saved.burstDelay;
      this.alive = init.saved.alive;
      if (!this.alive) this.renderObject.visible = false;
      this.showTrajectoryLine = init.saved.showTrajectoryLine ?? false;
    }
  }

  // 自身のクラス。復元タグはここから読む。
  public get enemyClass(): EnemyClass {
    return this.constructor as unknown as EnemyClass;
  }

  // 射撃が今できるか。enemies は同じ陣形の生存状況を見るために渡す。
  protected abstract canFire(enemies: readonly Enemy[]): boolean;
  // プラズマ弾を撃ち出す位置。
  protected abstract muzzlePosition(): Vec3;
  // プラズマ弾1発のダメージ [HP]。
  protected abstract plasmaDamage(): number;
  // 弾の被弾ダメージを当てる。撃破判定は呼び出し側が hp で行う。
  protected abstract applyBulletDamage(damage: number, impactPoint: Vec3): void;
  // 接触ダメージを当て、ダメージが発生したかを返す。しきい値未満なら false。
  protected abstract applyImpactDamage(damageSpeed: number): boolean;

  // 個体色の CSS 表記。方位マーカー・LEAD マーカーの着色に使う。
  public get accentColor(): string {
    if (typeof this.accent === 'string') return this.accent;
    return '#' + this.accent.toString(16).padStart(6, '0');
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。表示名は敵どうしで重なりうるので id から作る。
  private get markerKey(): string { return `enemy-${this.id}`; }

  // 敵のマーカー表示項目を組み立てる。pos/vel には機体メッシュと同じ表示時刻の状態
  // (stateAt 経由)を渡すこと。
  public markerItem(role: 'none' | 'primary', viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean): GroupedMarkerItem {
    // 距離は優先度(近いほど高)とラベル表示の両方に使う
    const dist = len(sub(pos, viewerPos));
    // 代表選出の優先度: ターゲット > 距離が近い順 (天体 > 船・エンティティ)
    const priority = role === 'primary' ? MARKER_PRIORITY.PRIMARY_TARGET : MARKER_PRIORITY.ENEMY - dist / 1e9;
    return {
      key: this.markerKey,
      cls: role === 'primary' ? 'mk-enemy mk-target' : 'mk-enemy',
      sym: overviewMode ? this.headingHpMarkerSvg(true) : this.hpMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      detail: overviewMode ? '' : fmtMarkerDist(dist),
      // 敵本体・距離ラベル・画面外方位マーカーは同じ色で統一する。ターゲット中は第二アクセントカラーで強調する。
      bearingColor: role === 'primary' ? currentThemePalette().signal : COLOR_MARKER_ENEMY,
      bearingSym: ENTITY_GLYPH.enemyShip,
      bearingClass: 'mk-dir mk-bearing-triangle',
      color: role === 'primary' ? currentThemePalette().signal : COLOR_MARKER_ENEMY,
      symMarkup: true,
    };
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private impactEffect(bullet: Bullet, impactPoint: Vec3): void {
    this._worldSfx.enemyHit();
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(kinematicState<'eci'>(this.state.t, impactPoint, this.state.v));
    } else {
      this._fx.spawnBulletFlash(kinematicState<'eci'>(this.state.t, impactPoint, this.state.v));
    }
    this._fx.spawnGasPuff(kinematicState<'eci'>(this.state.t, impactPoint, this.state.v));
  }

  // 撃破時の爆発音・エフェクトを発生させる。
  private destroyEffect(): void {
    this._worldSfx.explosion();
    // 敵機は自機の ENEMY_SCALE 倍サイズなので、撃破エフェクトも見合った大きさにする
    this._fx.spawnShipDestroyEffect(this.state, ENEMY_SCALE, ENEMY_DESTROY_FRAG_COLOR);
  }

  // 被弾によるダメージ・致死判定。
  private attackedByBullet(bullet: Bullet, impactPoint: Vec3, simTime: number, activeStage: Stage): void {
    activeStage.scoreCounter.recordHit();
    this.applyBulletDamage(bullet.damage, impactPoint);
    if (this.hp > 0) {
      this.impactEffect(bullet, impactPoint);
      return;
    }

    // HP が尽きたので撃破処理へ
    this.alive = false;
    activeStage.recordEnemyDeath(this, simTime, 'killed');
    this.destroyEffect();
  }

  // 他の実体との接触。ダメージはゲームバランスの量で、物理の質量からは導かない。
  public collideWithEntity(other: DynamicEntity, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;
    const simTime = contact.selfState.t;

    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, simTime, activeStage);
      return;
    }

    // 他の実体との接触で沈めば、交戦の結果として記録する。
    this.damagedByContact(contactDamageSpeed(other, contact), simTime, 'killed', activeStage);
  }

  // 天体の固体表面への接触。沈めば自然損耗(collision)として記録する。
  public collideWithCelestialBody(_body: CelestialMotion, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;
    this.damagedByContact(closingSpeed(contact), contact.selfState.t, 'collision', activeStage);
  }

  // 接触ダメージを当て、HP が残れば音とパフ、尽きたら cause の撃破として記録する。
  private damagedByContact(
    damageSpeed: number, simTime: number, cause: EnemyDeathCause, activeStage: Stage,
  ): void {
    if (!this.applyImpactDamage(damageSpeed)) return;
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
  public despawn(simTime: number, activeStage: Stage): void {
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
  public behave(simTime: number, player: Player, entities: DynamicSystem, simSpeed: SimSpeedManager, celestialSystem: CelestialSystem): void {
    // 射撃間隔は simulation time で測る。wall dt を混ぜると、同じゲーム内時間でも
    // warp 段によって弾数が変わる。
    const behaviorDt = this.lastBehaviorSim === undefined ? 0 : Math.max(0, simTime - this.lastBehaviorSim);
    this.lastBehaviorSim = simTime;
    if (!simSpeed.canShipAct) return;
    if (!this.fireEnabled) return;
    if (!this.canFire(entities.enemies)) {
      this.burstLeft = undefined;
      this.burstDelay = undefined;
      return;
    }
    const dist = len(sub(player.state.r, this.state.r));
    if (!(dist < STAGE00_MAX_RANGE && dist > ENEMY_AI_MIN_RANGE)) return;

    // バースト継続中なら次弾のタイミングだけ見る
    if (this.burstLeft && this.burstLeft > 0) {
      this.burstDelay = (this.burstDelay ?? 0) - behaviorDt;
      if (this.burstDelay <= 0) {
        this.firePlasma(simTime, player, entities, celestialSystem);
        this.burstLeft--;
        this.burstDelay = ENEMY_BURST_INTERVAL;
      }
      return;
    }

    if (this.lastFireSim === undefined) this.lastFireSim = simTime - Math.random() * ENEMY_FIRE_INTERVAL;
    if (simTime - this.lastFireSim <= ENEMY_FIRE_INTERVAL) return;
    this.lastFireSim = simTime;

    // 新規バーストを始めるかどうかを抽選する
    const countInGroup = this.attackingCountInGroup(entities.enemies);
    if (countInGroup >= ENEMY_MAX_ATTACKERS_PER_GROUP || Math.random() >= ENEMY_ATTACK_CHANCE) return;
    const counts = ENEMY_BURST_COUNTS;
    this.burstLeft = counts[Math.floor(Math.random() * counts.length)]! - 1;
    this.burstDelay = ENEMY_BURST_INTERVAL;
    this.firePlasma(simTime, player, entities, celestialSystem);
  }

  // enemies のうち、自分と同じ accent でバースト射撃中の個体数を数える。
  private attackingCountInGroup(enemies: readonly Enemy[]): number {
    let n = 0;
    for (const e of enemies) {
      if (e.alive && e.accent === this.accent && e.burstLeft && e.burstLeft > 0) n++;
    }
    return n;
  }

  // 発砲の演出。既定では何も出さない。
  protected muzzleEffect(_muzzleState: KinematicState): void {}

  // player へ向けた見越し射撃でプラズマ弾を1発生成し、entities に追加する。
  private firePlasma(simTime: number, player: Player, entities: DynamicSystem, celestialSystem: CelestialSystem): void {
    const r = this.muzzlePosition();
    const v = this.state.v;
    const toPlayer = sub(player.state.r, r);
    const relV = sub(player.state.v, v);

    // 正確な見越し時間を計算
    let leadTime = solveLeadTime(toPlayer, relV, PLASMA_BULLET_SPEED);
    if (leadTime === null || leadTime < 0) {
      leadTime = len(toPlayer) / PLASMA_BULLET_SPEED; // フォールバック
    }

    const predictedRelPos = add(toPlayer, scale(relV, leadTime));
    const aimDir = norm(predictedRelPos);

    const sunDir = celestialSystem.sunDirFrom(r, simTime);
    const spreadScale = sunGlareSpreadScale(r, aimDir, sunDir);

    // 散布界をスケール適用
    const perp = randPerp(aimDir);
    const spreadAng = (Math.random() * PLASMA_SPREAD_DEG * spreadScale * Math.PI) / 180;
    const actualAim = rotateAxis(aimDir, perp, spreadAng);

    const relativeBulletVelocity = scale(actualAim, PLASMA_BULLET_SPEED);
    const bV = add(v, relativeBulletVelocity);

    const pb = new Bullet(
      kinematicState<'eci'>(simTime, r, bV), PLASMA_LIFETIME, 'enemy', 'plasma', this.plasmaDamage(),
      this._worldSfx, this.scene, this,
    );
    this.muzzleEffect(kinematicState<'eci'>(simTime, r, v));

    entities.addBullet(pb);
  }

  // セーブデータへ変換する。具象は super.serialize() へ自分の項目を足して override する。
  public serialize(): EnemySaveData {
    return {
      id: this.id,
      name: this.name,
      kind: this.enemyClass.kind,
      // 運動状態・姿勢。
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      alive: this.alive,
      health: this.hp,
      accent: this.accent,
      orbitLineColor: this.orbitLineColor,
      waveId: this.waveId,
      // 陣形所属は無所属の単体敵も多いため、値がある場合だけキーを持たせる。
      ...(this.formationId === undefined ? {} : { formationId: this.formationId }),
      ...(this.formationRole === undefined ? {} : { formationRole: this.formationRole }),
      burstLeft: this.burstLeft,
      burstDelay: this.burstDelay,
      showTrajectoryLine: this.showTrajectoryLine,
    };
  }

  // マップ上の被選択物としての振る舞い。
  public readonly kind: MapPickKind = 'enemy';
  public readonly ownerName = null;
  public readonly mapTime = null;
  public get gone(): boolean { return !this.alive; }
  public get mapState(): KinematicState { return this.state; }
  public listPriority(): number { return 0; }

  // 表示時刻の ECI 位置。予測が届かない時刻では null。
  public mapPosAt(displayTime: number): Vec3 | null {
    return this.stateAt(displayTime)?.r ?? null;
  }

  // 敵カテゴリの表示トグルによる可否。
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility {
    return policy.entity(this.mapKind);
  }

  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.markerKey); }

  // 自艦から見た距離と相対速度。自艦がいなければ空。
  public listDetail(
    _celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    if (activePlayer === null) return '';
    const viewer = activePlayer.state;
    const d = len(sub(this.mapPosAt(displayTime) ?? this.state.r, viewer.r));
    const label = this.listCounted(activePlayer, displayTime) ? '接近' : '距離';
    return `${label} ${fmtDist(d)} · ${fmtSpeed(len(sub(this.state.v, viewer.v)))}`;
  }

  // 検索が照合する文字列。行の補助表示と同じ。
  public listSearchText(
    celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    return this.listDetail(celestialSystem, activePlayer, displayTime);
  }

  // 自艦へ接近中と扱う距離まで寄っているか。
  public listCounted(activePlayer: Player | null, displayTime: number): boolean {
    if (activePlayer === null) return false;
    const d = len(sub(this.mapPosAt(displayTime) ?? this.state.r, activePlayer.state.r));
    return d < ENEMY_APPROACH_DIST;
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public mapMenuItems(
    commands: MapCommands, _celestialSystem: CelestialSystem, simTime: number,
  ): readonly MenuItem<MenuAction>[] {
    return [
      ...MenuCommon.targetItems(commands, this.id, simTime),
      MenuCommon.focus(),
      MenuCommon.trajectoryLine(this.showTrajectoryLine),
      ...MenuCommon.duplicateItems(commands),
      { label: '削除', act: 'delete' },
      MenuCommon.cancel(),
    ];
  }

  // 選ばれた操作を実行する。自分が出していない act では何もしない。
  public runMapMenu(act: MenuAction, commands: MapCommands): void {
    if (act === 'delete') this.alive = false;
    else if (act === 'toggleTrajectoryLine') this.showTrajectoryLine = !this.showTrajectoryLine;
    else if (act === 'duplicate') commands.duplicate(this.mapKind, this.state);
    else if (act === 'focus') commands.focus(this.id, this.name);
    else if (act === 'target') commands.toggleNavTarget(this.id, this.name);
  }

  // プロパティウィンドウに出す行。装甲・距離・接近速度を主要行とし、相対速度は詳細トグル、
  // 軌道要素と相対傾斜角は「軌道」グループの下に畳む。viewer が null なら相対量の行は落ちる。
  public mapPropertyRows(
    commands: MapCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    const viewer = commands.activePlayer;
    const rel = viewer ? relativeInfo(viewer, this, celestialSystem.celestialMotions, simTime) : null;
    const rows: PropertyRow[] = [{ key: 'hp', label: '装甲', value: `${Math.floor(this.hp)} / ${this.maxHp}` }];
    // 自艦との相対量。
    if (rel) {
      rows.push(
        { key: 'dist', label: '距離', value: fmtDist(rel.dist) },
        { key: 'closing', label: '接近速度', value: fmtSpeed(rel.closing) },
        { key: 'relspeed', label: '相対速度', value: fmtSpeed(rel.relSpeed), collapsible: true },
      );
    }
    rows.push(...orbitRows(this, celestialSystem, simTime));
    // 相対傾斜角は自艦の軌道面が基準なので、軌道要素と同じグループへ並べる。
    if (rel) {
      rows.push({
        key: 'relinc', label: '相対傾斜 [AN/DN]',
        value: isFinite(rel.relIncDeg) ? `${rel.relIncDeg.toFixed(2)}°` : '---', group: '軌道',
      });
    }
    return rows;
  }

  public readonly mapRename = null;
}
