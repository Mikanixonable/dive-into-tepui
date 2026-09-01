
import * as THREE from 'three/webgpu';
import * as C from '../../const';
import { Ship } from './ship';
import { CelestialMotion } from '../../../physics/celestial-motion';

import { DynamicEntity } from './dynamic-entity';
import { closingSpeed, type Contact } from './contact';
import { collisionDamageFraction, contactDamageSpeed } from './contact-damage';
import { Attitude } from '../../../physics/attitude';
import { KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { add, addScaled, dot, len, lenSq, norm, randPerp, rotateAxis, scale, sub, Vec3, v3 } from '../../../math/vec3';
import { apparentSizePx, metersPerPixel, type Viewpoint } from '../../../math/projection';
import { solveLeadTime } from '../../../physics/intercept';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { CelestialSystem } from '../../celestial/celestial-system';
import { EffectsSystem } from '../../vfx/effects-system';
import { Player } from '../../player/player';
import { Bullet } from './bullet';
import type { EnemyDeathCause, Stage } from '../../stages/stage';
import { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { DynamicSystem } from '../../dynamic/dynamic-system';
import type { SimSpeedManager } from '../../dynamic/sim-speed-manager';
import type { EnemySaveData, FormationRole } from '../../save/save-data';
import { proteinEnemyDefinitionFor } from '../../protein/protein-enemy-registry';
import { proteinMotionModeDisplacements } from '../../protein/protein-motion-modes';
import { ProteinRuntime } from '../../protein/protein-runtime';
import { ProteinRibbonCollisionGeometry } from '../../protein/protein-ribbon-collision';
import { createProteinMotionBinding, type ProteinMotionBinding } from '../../../render/protein-motion-material';
import { disposeOwnedRenderResources } from '../../../render/dispose-owned-render-resources';
import type { ProteinDamageResult } from '../../protein/protein-combat-state';
import {
  DEFAULT_PROTEIN_DISPLAY, isProteinDisplaySettings, proteinDisplayFromLegacyColorMode,
  type ProteinColorMode, type ProteinDisplaySettings,
} from '../../protein/protein-display';
import type { ProteinAssetId } from '../../protein/protein-asset-loader';
import {
  ENEMY_DESTROY_FRAG_COLOR,
} from '../../../render/vfx-style';
import { buildEnemyShip, buildStage0EnemyShip } from '../../../render/ships';
import { R_EARTH_EQ } from '../../celestial/solar-system/constants';
import { fmtMarkerDist } from '../../hud/utils';
import { ENTITY_GLYPH } from '../../marker/marker-glyphs';
import { currentThemePalette } from '../../theme';

// 敵機は熱防御を持たないので、艦より低い温度で構造が保たなくなる。降下してくる艦がこの温度に
// 達するのは、地球の大気では高度 80 km 付近。
const ENEMY_MAX_TEMP = 500; // [K]

const ENEMY_SCALE = 20; // buildEnemyShip() の見た目メッシュに掛けるスケール

const PLAYER_BULLET_DAMAGE = 1.25; // 自機が被弾(自弾・プラズマ弾とも)した際のダメージ [HP]

const PLASMA_BULLET_SPEED = C.MUZZLE_SPEED * 2 / 3; // MUZZLE_SPEED の 2/3
const PLASMA_LIFETIME = 300; // プラズマ弾の寿命 [sim s]
const ENEMY_FIRE_INTERVAL = 1.0; // 敵の射撃間隔 [s]
const ENEMY_BURST_INTERVAL = 0.08; // 敵のバースト射撃時の連射間隔 [s]
const ENEMY_AI_MIN_RANGE = 50; // これより近いと射撃しない(至近距離) [m]
const ENEMY_MAX_ATTACKERS_PER_GROUP = 3; // 同一集団内で同時に攻撃する最大機数
const ENEMY_ATTACK_CHANCE = 0.6; // 各機が攻撃(バースト)を開始する確率
const ENEMY_BURST_COUNTS = [3, 5, 7, 20]; // バースト射撃弾数の候補
const PLASMA_SPREAD_DEG = 0.05; // プラズマ弾の散布角 [deg]

// 敵の外見・生成方法を表す種別と、そこから導かれる値。
type LegacyPdb5i4rEnemyKind = {
  kind: 'pdb-5i4r';
  colorMode?: ProteinColorMode;
  display?: ProteinDisplaySettings;
};

export type EnemyKind =
  | { kind: 'drifting' }
  | { kind: 'stage0'; typeIndex: number }
  | { kind: 'protein'; assetId: ProteinAssetId; display?: ProteinDisplaySettings }
  | LegacyPdb5i4rEnemyKind;

// タンパク質型の敵が使うタンパク質アセットの id。タンパク質型でなければ null。
export function proteinAssetIdForEnemyKind(enemyKind: EnemyKind): ProteinAssetId | null {
  if (enemyKind.kind === 'protein') return enemyKind.assetId;
  if (enemyKind.kind === 'pdb-5i4r') return 'pdb-5i4r';
  return null;
}

// 旧セーブデータの 'pdb-5i4r' 種別を、現行の 'protein' 種別へ読み替える。
function normalizeEnemyKind(enemyKind: EnemyKind): EnemyKind {
  if (enemyKind.kind !== 'pdb-5i4r') return enemyKind;
  return {
    kind: 'protein',
    assetId: 'pdb-5i4r',
    display: isProteinDisplaySettings(enemyKind.display)
      ? enemyKind.display
      : proteinDisplayFromLegacyColorMode(enemyKind.colorMode),
  };
}

// enemyKind ごとの主慣性モーメント。'drifting' は非対称にしてジャニベコフ効果(中間軸不安定性)
// を起こし、'stage0' は機首をプログレードへ向けたまま飛ぶので等方でよい。
export function inertiaForEnemyKind(enemyKind: EnemyKind): Vec3 {
  return enemyKind.kind === 'stage0' ? v3(1, 1, 1) : v3(1, 1.1, 1.05);
}

// 敵の見た目を組み立てる。
function buildEnemyRenderObject(
  enemyKind: EnemyKind, accent: string | number, motionBinding?: ProteinMotionBinding,
): THREE.Object3D {
  if (enemyKind.kind === 'stage0') return buildStage0EnemyShip(accent, enemyKind.typeIndex);
  // タンパク質型はカタログの登録アセットから、実際のタンパク質構造モデルを組む。
  const proteinId = proteinAssetIdForEnemyKind(enemyKind);
  if (proteinId !== null) {
    const definition = proteinEnemyDefinitionFor(proteinId);
    if (!definition) throw new Error(`No protein enemy definition registered for ${proteinId}`);
    const display: ProteinDisplaySettings = enemyKind.kind === 'protein' && isProteinDisplaySettings(enemyKind.display)
      ? enemyKind.display
      : DEFAULT_PROTEIN_DISPLAY;
    return definition.buildRenderObject(display, motionBinding);
  }
  // それ以外(drifting)は従来型の艦体メッシュ。
  return buildEnemyShip(accent);
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

// 陣形の攻撃担当だけが必要とする、同じ陣形内の生存エネルギー役を都度集計する。
// formationId が無い敵は単体敵として、従来どおり供給条件を満たすものとする。
export function isFormationEnergyAvailable(
  formationRole: FormationRole | undefined,
  formationId: string | undefined,
  enemies: readonly { readonly alive: boolean; readonly formationId?: string; readonly formationRole?: FormationRole }[],
): boolean {
  if (formationRole !== 'attacker' || formationId === undefined) return true;
  return enemies.some((enemy) => (
    enemy.alive && enemy.formationId === formationId && enemy.formationRole === 'energy'
  ));
}

// 新規配置は各フィールドを直接渡し、スナップショットからの再開は saved を simTime 付きの
// 状態として展開する。orbitLineColor は旧セーブデータには無いため、無ければ accent から導く。
type EnemyInit =
  | {
    readonly name: string;
    readonly state: KinematicState;
    readonly enemyKind: EnemyKind;
    readonly att: Attitude;
    readonly accent: string | number;
    readonly orbitLineColor: string | number;
    readonly waveId?: number;
    readonly id?: string;
    readonly formationId?: string;
    readonly formationRole?: FormationRole;
  }
  | { readonly saved: EnemySaveData; readonly simTime: number };

export class Enemy extends Ship {
  // 敵機は熱防御を持たないので、自機より低い温度で構造が保たなくなる。
  protected readonly maxTemperature = ENEMY_MAX_TEMP;
  readonly accent: string | number; // マーカー色・集団識別。全敵が保持する
  readonly waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
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
  readonly proteinRuntime: ProteinRuntime | null;
  private readonly proteinRibbonCollision: ProteinRibbonCollisionGeometry | null;

  override get hp(): number {
    return this.proteinRuntime?.combat.integrityHp ?? super.hp;
  }

  override set hp(value: number) {
    // Ship's constructor initializes the legacy backing value before the protein
    // runtime exists. Once the runtime is attached, integrityHp is authoritative.
    if (!this.proteinRuntime) super.hp = value;
  }

  override get maxHp(): number {
    return this.proteinRuntime?.combat.integrityMaxHp ?? super.maxHp;
  }

  override set maxHp(value: number) {
    if (!this.proteinRuntime) super.maxHp = value;
  }

  // init の enemyKind に応じたメッシュで Ship を初期化し、専用の軌道線をシーンへ追加する。
  constructor(
    init: EnemyInit,
    worldSfx: WorldSfx,
    fx: EffectsSystem,
    scene?: THREE.Scene,
  ) {
    const { name, state, enemyKind: rawEnemyKind, att, accent, orbitLineColor, waveId, id, formationId, formationRole } = 'saved' in init
      ? {
        name: init.saved.name || '',
        state: kinematicState<'eci'>(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        enemyKind: init.saved.enemyKind,
        att: { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: inertiaForEnemyKind(init.saved.enemyKind) } as Attitude,
        accent: init.saved.accent,
        orbitLineColor: init.saved.orbitLineColor ?? init.saved.accent,
        waveId: init.saved.waveId,
        id: init.saved.id || undefined,
        formationId: init.saved.formationId,
        formationRole: init.saved.formationRole,
      }
      : init;
    const enemyKind = normalizeEnemyKind(rawEnemyKind);
    const proteinId = proteinAssetIdForEnemyKind(enemyKind);
    const proteinDefinition = proteinId === null ? null : proteinEnemyDefinitionFor(proteinId);
    if (proteinId !== null && proteinDefinition === null) {
      throw new Error(`No protein enemy definition registered for ${proteinId}`);
    }
    const motionBinding = proteinDefinition
      ? createProteinMotionBinding(
        proteinDefinition.motion.residueCount,
        proteinMotionModeDisplacements(proteinDefinition.motion),
        proteinDefinition.motion.modes.length,
      )
      : undefined;
    const renderObject = buildEnemyRenderObject(enemyKind, accent, motionBinding);
    // 保存データからの復元は保存済みの名前をそのまま使う。新規生成のときだけ、タンパク質固有の
    // 名称を陣形役割・識別番号などの既存識別子の前へ冠する。
    const displayName = !('saved' in init) && proteinDefinition ? `${proteinDefinition.asset.displayName} ${name}` : name;
    super(displayName, state, renderObject, att, C.ENEMY_RADIUS, C.ENEMY_MAX_HP, scene, id);
    this._worldSfx = worldSfx;
    this._fx = fx;
    this.enemyKind = enemyKind;
    this.proteinRuntime = proteinDefinition
      ? new ProteinRuntime(
        this.renderObject,
        proteinDefinition.asset,
        proteinDefinition.motion,
        'saved' in init ? init.saved.protein : undefined,
        'saved' in init ? init.saved.health : undefined,
        this.id,
        motionBinding,
      )
      : null;
    this.accent = accent;
    this.waveId = waveId;
    this.formationId = formationId;
    this.formationRole = formationRole;
    this.mass = 10000;
    this.collides = true;
    this.doPreciseReentry = true;
    this.renderObject.scale.setScalar(ENEMY_SCALE);
    if (this.proteinRuntime) {
      // 表示が原子模型へ切り替わっていても判定形状は常に同じリボンに固定する。専用の
      // 一時メッシュから三角形を抽出し、抽出後は GPU/CPU 資源をただちに解放する。
      const collisionSource = proteinDefinition?.buildCollisionObject();
      if (!collisionSource) throw new Error(`No protein collision definition registered for ${proteinId}`);
      this.proteinRibbonCollision = new ProteinRibbonCollisionGeometry(collisionSource, ENEMY_SCALE);
      disposeOwnedRenderResources(collisionSource);
    } else {
      this.proteinRibbonCollision = null;
    }
    // 描画メッシュの実スケール後バウンディング球を、弾丸・物理接触の両判定に共有する。
    const visualBounds = new THREE.Box3().setFromObject(this.renderObject);
    const visualSphere = visualBounds.getBoundingSphere(new THREE.Sphere());
    this.radius = this.proteinRibbonCollision?.outerRadius ?? visualSphere.radius;
    this.orbitLineColor = orbitLineColor;

    if ('saved' in init) {
      if (!this.proteinRuntime) {
        this.setOverallHp(init.saved.health);
      }
      this.burstLeft = init.saved.burstLeft;
      this.burstDelay = init.saved.burstDelay;
      this.alive = init.saved.alive;
      if (!this.alive) this.renderObject.visible = false;
      this.showTrajectoryLine = init.saved.showTrajectoryLine ?? false;
    }
  }

  override testCustomSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, selfState: KinematicState,
  ) {
    if (this.proteinRibbonCollision === null) return null;
    return this.proteinRibbonCollision.testSphereCollision(
      sphereCenter, sphereRadius, selfState.r, this.att.q,
    );
  }

  override testCustomSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
  ) {
    if (this.proteinRibbonCollision === null) return null;
    return this.proteinRibbonCollision.testSweptSphereCollision(
      previousSphereCenter, sphereCenter, sphereRadius,
      previousSelfState, selfState, this.att.q,
    );
  }

  override usesCustomSphereCollision(): boolean {
    return this.proteinRibbonCollision !== null;
  }

  // ステージ操作の表示形態・着色変更を既存のタンパク質型敵へ反映する。
  setProteinDisplay(display: ProteinDisplaySettings): void {
    const proteinId = proteinAssetIdForEnemyKind(this.enemyKind);
    if (proteinId === null || this.enemyKind.kind !== 'protein') return;
    const definition = proteinEnemyDefinitionFor(proteinId);
    if (!definition) return;
    this.enemyKind.display = display;
    this.proteinRuntime?.clearVisuals();
    definition.recolorRenderObject(this.renderObject, display, this.proteinRuntime?.motionBinding);
    this.proteinRuntime?.rebuildVisuals();
  }

  get proteinHudSnapshot() {
    return this.proteinRuntime?.hudSnapshot ?? null;
  }

  // 3km 以内マーカー用に、各機能部位の投影元位置と HUD 表示情報を並べる。displayPos は
  // markerItem と同じ表示時刻の位置(displayState 経由)を渡すこと。
  proteinSiteMarkers(displayPos: Vec3): readonly {
    readonly id: string; readonly worldPos: Vec3; readonly abbreviation: string;
    readonly hp: number; readonly maxHp: number; readonly disabled: boolean; readonly attackable: boolean;
  }[] {
    const runtime = this.proteinRuntime;
    if (!runtime) return [];
    return runtime.hudSnapshot.sites.map((site) => ({
      id: site.id,
      worldPos: runtime.siteWorldPositionById(site.id, displayPos, this.att.q),
      abbreviation: site.abbreviation,
      hp: site.hp,
      maxHp: site.maxHp,
      disabled: site.disabled,
      attackable: site.attackable,
    }));
  }

  override sync(
    fo: import('../../camera/floating-origin').FloatingOrigin, displayTime: number, viewer?: Viewpoint,
    proteinVibrationEnabled = true,
  ): void {
    super.sync(fo, displayTime);
    if (this.proteinRuntime && this.renderObject.visible) {
      const displayed = this.displayState(displayTime);
      const projectedDiameterPx = viewer && displayed
        ? apparentSizePx(this.radius * 2, metersPerPixel(viewer, displayed.r, window.innerHeight))
        : Number.POSITIVE_INFINITY;
      // marker LOD(投影サイズがゆらぎを描かない大きさ)まで落ちた敵は、部位・修飾・
      // 結合線の更新と残基投影を止める。LOD 判定自体は ProteinRuntime に一本化してある。
      if (this.proteinRuntime.updateLod(projectedDiameterPx) !== 'marker') {
        this.proteinRuntime.updateVisual(displayTime, proteinVibrationEnabled);
      }
    }
  }

  // 個体色の CSS 表記。方位マーカー・LEAD マーカーの着色に使う。
  get accentColor(): string {
    if (typeof this.accent === 'string') return this.accent;
    return '#' + this.accent.toString(16).padStart(6, '0');
  }



  // 敵のマーカー表示項目を組み立てる。pos/vel は機体メッシュと同じ表示時刻の状態(displayState
  // 経由)を使う。role がターゲットでなければ通常の敵マーカーになる。overviewMode では進行方向へ
  // 回るヘッダーアイコンを、戦闘ビューでは従来の切り欠き三角形を使う。key は id(一意)から、
  // ラベルは name(表示名)から作る — 複数の敵が同じ表示名を持ちうるため。
  markerItem(role: 'none' | 'primary', viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean): GroupedMarkerItem {
    // 距離は優先度(近いほど高)とラベル表示の両方に使う
    const dist = len(sub(pos, viewerPos));
    // 代表選出の優先度: ターゲット > 距離が近い順 (天体 > 船・エンティティ)
    const priority = role === 'primary' ? C.MARKER_PRIORITY.PRIMARY_TARGET : C.MARKER_PRIORITY.ENEMY - dist / 1e9;
    return {
      key: `enemy-${this.id}`,
      cls: role === 'primary' ? 'mk-enemy mk-target' : 'mk-enemy',
      sym: overviewMode ? this.headingHpMarkerSvg(true) : this.hpMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      detail: overviewMode ? '' : fmtMarkerDist(dist),
      // 敵本体・距離ラベル・画面外方位マーカーは同じ色で統一する。ターゲット中は第二アクセントカラーで強調する。
      bearingColor: role === 'primary' ? currentThemePalette().signal : C.COLOR_MARKER_ENEMY,
      bearingSym: ENTITY_GLYPH.enemyShip,
      bearingClass: 'mk-dir mk-bearing-triangle',
      color: role === 'primary' ? currentThemePalette().signal : C.COLOR_MARKER_ENEMY,
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

    const proteinResult = this.proteinRuntime ? this.applyProteinDamage(bullet.damage, impactPoint) : null;
    if (proteinResult) {
      this.handleProteinDamage(proteinResult, impactPoint);
    } else {
      this.applyDamageToParts(bullet.damage);
    }
    if (this.hp > 0) {
      this.impactEffect(bullet, impactPoint);
      return;
    }

    // HP が尽きたので撃破処理へ
    this.alive = false;
    activeStage.recordEnemyDeath(this, simTime, 'killed');
    this.destroyEffect();
  }

  private applyProteinDamage(amount: number, impactPoint: Vec3): ProteinDamageResult | null {
    const runtime = this.proteinRuntime;
    if (!runtime) return null;
    const localPoint = runtime.localImpactPoint(impactPoint, this.state.r, this.att.q);
    const result = runtime.combat.applyDamage(amount, localPoint);
    return result;
  }

  private handleProteinDamage(result: ProteinDamageResult, impactPoint: Vec3): void {
    if (!this.proteinRuntime) return;
    if (result.siteDisabled || result.phaseChanged) {
      this._fx.spawnProteinStateFlash(kinematicState<'eci'>(this.state.t, impactPoint, this.state.v), result.phaseChanged ? result.phase : 'site-disabled');
    }
  }

  // 弾は武装のダメージを、それ以外は接触の接近速度と相手の種別を根拠にする
  // (どちらもゲームバランスの量で、物理の質量からは導かない)。
  collideWithEntity(other: DynamicEntity, contact: Contact, activeStage: Stage): void {
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
  collideWithCelestialBody(_body: CelestialMotion, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;
    this.damagedByContact(closingSpeed(contact), contact.selfState.t, 'collision', activeStage);
  }

  // 接触ダメージを当て、HP が残れば音とパフ、尽きたら cause の撃破として記録する。
  private damagedByContact(
    damageSpeed: number, simTime: number, cause: EnemyDeathCause, activeStage: Stage,
  ): void {
    if (this.proteinRuntime) {
      const damageFraction = collisionDamageFraction(damageSpeed);
      if (damageFraction <= 0) return;
      const result = this.proteinRuntime.combat.applyContactDamage(this.maxHp * damageFraction);
      if (result.defeated) {
        this.alive = false;
        activeStage.recordEnemyDeath(this, simTime, cause);
        this.destroyEffect();
      } else {
        this._worldSfx.clank();
        this._fx.spawnGasPuff(this.state);
      }
      return;
    }
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
  behave(simTime: number, player: Player, entities: DynamicSystem, simSpeed: SimSpeedManager, celestialSystem: CelestialSystem): void {
    // 射撃間隔はsimulation timeで統一する。wall dtを混ぜると×4時だけバースト間隔が
    // 4倍に引き伸ばされ、同じゲーム内時間でもwarp段によって弾数が変わっていた。
    const behaviorDt = this.lastBehaviorSim === undefined ? 0 : Math.max(0, simTime - this.lastBehaviorSim);
    this.lastBehaviorSim = simTime;
    if (!simSpeed.canShipAct) return;
    if (!this.fireEnabled) return;
    if (this.proteinRuntime) {
      const attackAction = this.proteinRuntime.combat.attackAction;
      const energyAvailable = isFormationEnergyAvailable(this.formationRole, this.formationId, entities.enemies);
      if (attackAction === null || !this.proteinRuntime.combat.isActionEnabled(attackAction.id, energyAvailable)) {
        this.burstLeft = undefined;
        this.burstDelay = undefined;
        return;
      }
    }
    const dist = len(sub(player.state.r, this.state.r));
    if (!(dist < C.STAGE00_MAX_RANGE && dist > ENEMY_AI_MIN_RANGE)) return;

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

  // player へ向けた見越し射撃でプラズマ弾を1発生成し、entities に追加する。
  private firePlasma(simTime: number, player: Player, entities: DynamicSystem, celestialSystem: CelestialSystem, origin?: Vec3): void {
    const r = origin ?? (this.proteinRuntime
      ? this.proteinRuntime.nextAttackSiteWorldPosition(this.state.r, this.att.q)
      : this.state.r);
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

    const bulletDamage = this.proteinRuntime
      ? this.proteinRuntime.combat.projectileDamage(PLAYER_BULLET_DAMAGE)
      : PLAYER_BULLET_DAMAGE;
    const pb = new Bullet(
      kinematicState<'eci'>(simTime, r, bV), PLASMA_LIFETIME, 'enemy', 'plasma', bulletDamage,
      this._worldSfx, this.scene, this,
    );
    // 弾の姿勢は Bullet.sync() に一本化する。プラズマの長軸(+Z)を、
    // 浮動原点に対する実際の相対速度へ向けるため、発射方向(actualAim)を
    // 直接 lookAt() するよりも、敵自身の速度を含む軌道と一致する。

    if (this.proteinRuntime) {
      this._fx.spawnMuzzleFlash(kinematicState<'eci'>(simTime, r, v));
    }

    entities.addBullet(pb);
  }

  // セーブデータへ変換する。
  serialize(): EnemySaveData {
    return {
      id: this.id,
      name: this.name,
      kind: 'enemy',
      // 運動状態・姿勢。
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      enemyKind: this.enemyKind,
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
      protein: this.proteinRuntime?.combat.serialize(),
    };
  }

  override dispose(): void {
    this.proteinRuntime?.dispose();
    super.dispose();
  }
}
