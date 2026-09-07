import * as THREE from 'three/webgpu';
import type { Viewer } from '../dynamic/dynamic-entity/viewer';
import type { View } from '../view/view';
import { Attitude } from '../../physics/attitude';
import { qFromBasis } from '../../math/quat';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../celestial/solar-system/constants';
import { Vec3, add, v3, len, sub } from '../../math/vec3';
import { fmtMarkerDist } from '../../hud/utils';
import { FloatingOrigin } from '../camera/floating-origin';
import { Ship, SHIP_RADIATING_AREA_PER_MASS, PLAYER_MASS, PLAYER_INERTIA_PITCH, PLAYER_INERTIA_YAW, PLAYER_INERTIA_ROLL } from '../dynamic/dynamic-entity/ship';
import { Bullet } from '../dynamic/dynamic-entity/bullet';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { closingSpeed, type Contact } from '../dynamic/dynamic-entity/contact';
import { contactDamageSpeed } from '../dynamic/dynamic-entity/contact-damage';
import { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { Notifier } from '../../hud/notifier';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { buildPlayerShip } from '../../render/ships';
import type { CelestialBody } from '../../physics/celestial-body';
import type { CameraSystem } from '../camera/camera-system';
import type { RenderStyle } from '../../render/render-style';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { InstancedPools } from '../dynamic/instanced-pools';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import { generateRandomName } from '../random-name';
import type { Stage } from '../stages/stage';
import { Throttle } from './throttle';
import { FireControl, type AmmoLoad } from './fire-control';
import { Belt } from './belt';
import { AeroLoad } from './aero-load';
import { AltitudeAlarm } from './altitude-alarm';
import { currentThemePalette } from '../../theme';
import { FlashEffects } from '../vfx/flash-effects';
import { buildDestroyFragments } from '../dynamic/dynamic-entity/debris-piece';
import { ThrustEffects } from './thrust-effects';
import { RcsEffects } from './rcs-effects';
import { ReentryEffects } from './reentry-effects';
import { PlayerMarkers } from './player-markers';
import type { OrbitReference } from '../orbit-reference';
import type { MarkerManager } from '../marker/marker-manager';
import { RadiatorSide, RadiatorSystem } from './radiator';
import { PowerSystem } from './power';
import type { CelestialSystem } from '../celestial/celestial-system';
import { Plan, type PlanExecutionMode } from '../plan/plan';
import type { PlayerSaveData, PlanSaveData } from '../save/save-data';
import { partFromSaveData, type AnyPart } from '../dynamic/dynamic-entity/parts';
import { DIRECTION_GLYPH, ENTITY_GLYPH, COLOR_MARKER_ALLY } from '../marker/marker-identity';
import { shipMarkerSvg } from '../marker/marker-shapes';
import type { GroupedMarkerItem, MarkerRole } from '../marker/grouped-markers';
import {
  DESTROY_FLASH1_DURATION, DESTROY_FLASH1_SIZE0, DESTROY_FLASH1_SIZE1,
  DESTROY_FLASH2_DURATION, DESTROY_FLASH2_SIZE0, DESTROY_FLASH2_SIZE1,
  DESTROY_FLASH_COLOR_1, DESTROY_FLASH_COLOR_2,
  DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN, PLAYER_DESTROY_FRAG_COLOR,
} from '../../render/vfx-style';
import { AttachedBoosters } from './attached-boosters';
import { MARKER_PRIORITY } from '../marker/crowding';
import { strongestAttractor } from '../../physics/attractor';
import { apsisAltitudes } from '../../physics/elements';
import { fmtAmmoStatus } from '../hud/ammo-status';
import { fmtDist, fmtEnergy } from '../../hud/utils';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import { orbitRows } from '../pickable/orbit-rows';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { ControlSelection } from '../control-selection';
import type { ObjectAuthoring } from '../stages/stage';
import type { ObjectWindows } from '../pickable/object-windows';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { MapListSection, ObjectPickerGenre } from '../pickable/pickable-listing';

export const PLAYER_HULL_RADIUS = 2.6; // 剛体接触(被弾判定を含む)に使う実寸に近い半径 [m]
const HULL_START_TEMP = 273; // 初期機体温度 [K]

const INITIAL_ALT = 420e3; // 初期高度 [m]
const INITIAL_INC_DEG = 97.0; // 初期軌道傾斜角 [deg]
// 展開中の放熱板に当たった1発が放熱板パーツへ与えるダメージ [HP]。薄く大きい構造物なので
// 船体への直撃(PLASMA_BULLET_DAMAGE)より軽い。
const RADIATOR_BULLET_DAMAGE = 0.25;

const BULLET_IMPACT_HEAT = 3.0e5; // 自機が被弾1発あたりに受ける熱量 [J]

const ALLY_BEARING_MAX_DISTANCE = 20e3; // 味方機の画面外方位マーカーを表示する上限距離 [m]

const PLAYER_MAX_HP = 1000;
const HP_REGEN_RATE = 1; // HP自動回復速度 [HP/s]

// 軌道計画の実行モードの巡回順。ボタン1つで次のモードへ進める。
const PLAN_EXECUTION_MODES: readonly PlanExecutionMode[] = ['off', 'instant'];

const PLAN_EXECUTION_LABELS: Record<PlanExecutionMode, string> = { off: 'OFF', instant: '自動実行' };

// mode の表示ラベル(HUDのメニュー項目・プロパティ行が共有する)。
function planExecutionLabel(mode: PlanExecutionMode): string {
  return PLAN_EXECUTION_LABELS[mode];
}

// 新規配置は name/state/id/ammo を任意指定し、省略時は高度 INITIAL_ALT・傾斜 INITIAL_INC_DEG の
// 円軌道に機首プログレードで初期配置する。スナップショットからの再開は saved を simTime 付きの
// 状態として展開する。
export type PlayerInit =
  | { readonly name?: string; readonly state?: KinematicState; readonly id?: string; readonly ammo?: AmmoLoad }
  | { readonly saved: PlayerSaveData; readonly simTime: number };

// プレイヤー機: 操縦・射撃・ブースターなどの下位系を合成し、それらを反映した
// 見た目(モデル・エフェクトメッシュの管理と毎フレーム更新)を持つ。
export class Player extends Ship implements Controllable, ObjectPickable {
  public override readonly mapKind: DynamicEntityKind = 'player';
  public override readonly controllable = true;
  public override readonly pickable = true;
  // 除去の前に注視・操作対象の参照を次の艦へ引き継ぐ必要があるので、所有者側に回収させる。
  public override readonly reclaimedByOwner = true;

  readonly throttle: Throttle;
  readonly fire: FireControl;
  readonly belt: Belt;
  readonly aero: AeroLoad;
  readonly altitudeAlarm: AltitudeAlarm;
  readonly radiator: RadiatorSystem;
  readonly power: PowerSystem;
  readonly boosters: AttachedBoosters;

  // contactProxies が返す一覧。区間ごとに置き直すので使い回す。
  private readonly contactProxyScratch: DynamicEntity[] = [];

  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;
  private readonly reentryEffects: ReentryEffects;
  private readonly markers: PlayerMarkers;
  // この艦自身のマニューバ計画。
  readonly plan = new Plan();
  planExecution: PlanExecutionMode = 'instant';

  private readonly _hud: Notifier;
  private readonly _worldSfx: WorldSfx;
  private readonly _fx: FlashEffects;
  private readonly playerScene: THREE.Scene;

  fineAttitude = false;
  // 自機の操作方法は HUD とヘルプが常設で示しているので、選び直しても案内は出さない。
  readonly controlHint = null;
  readonly releaseHint = null;

  // init 省略時は無作為な名前と既定軌道の新規艦になる。id を省いたときは name がそのまま
  // 艦の識別子になるので、複数隻を並べるなら name も分ける。
  constructor(
    _hud: Notifier, _worldSfx: WorldSfx, _scene: THREE.Scene, _fx: FlashEffects, markerManager: MarkerManager,
    init: PlayerInit = {},
  ) {
    const name = 'saved' in init ? (init.saved.name || init.saved.id) : (init.name ?? generateRandomName('player'));
    const state = 'saved' in init
      ? kinematicState<'eci'>(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z))
      : (init.state ?? Player.makeInitialState());
    const id = 'saved' in init ? init.saved.id : (init.id ?? name);
    const att: Attitude = 'saved' in init
      ? { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: Player.INERTIA }
      : Player.progradeAttitude(state);

    super(name, state, buildPlayerShip(), att, PLAYER_HULL_RADIUS, PLAYER_MAX_HP, _scene, id);
    this._hud = _hud;
    this._worldSfx = _worldSfx;
    this._fx = _fx;
    this.playerScene = _scene;
    this.mass = PLAYER_MASS;
    this.collides = true;
    this.engagementAnchor = true;
    this.doPreciseReentry = true;

    const saved = 'saved' in init ? init.saved : undefined;
    this.throttle = new Throttle(_hud, saved?.throttle);
    this.fire = new FireControl(this, _hud, _worldSfx, _scene, _fx, 'saved' in init ? { saved: init.saved.fire } : { ammo: init.ammo });
    this.belt = new Belt(this.renderObject, this);
    this.aero = new AeroLoad();
    this.altitudeAlarm = new AltitudeAlarm(_hud, _worldSfx);
    this.temperature = saved?.thermal.hullTemp ?? HULL_START_TEMP;
    this.radiator = new RadiatorSystem(this.renderObject, this, saved?.radiator);
    this.power = new PowerSystem(this.renderObject, saved?.power);
    this.thrustEffects = new ThrustEffects(_scene, _worldSfx);
    this.rcsEffects = new RcsEffects(_scene, _worldSfx);
    this.reentryEffects = new ReentryEffects(_scene);
    this.markers = new PlayerMarkers(markerManager, this.id);
    // 段の模型を船体へ足し、段のぶんの質量と慣性を載せるので、船体側の部品より後に組む。
    this.boosters = new AttachedBoosters(this, _hud, _worldSfx, _scene, _fx, saved?.boosters);

    if (saved) {
      // 旧セーブは followPlan: boolean だった(true→'instant' / false→'off')。'powered' だった
      // セーブは廃止済みモードなので既定の 'instant' へ寄せる。
      this.planExecution = saved.planExecution === 'off' || saved.planExecution === 'instant'
        ? saved.planExecution
        : (saved.followPlan ? 'instant' : 'off');
      this.fineAttitude = saved.fineAttitude ?? false;
      this.showTrajectoryLine = saved.showTrajectoryLine ?? false;
      this.parts.splice(0, this.parts.length, ...saved.parts.map(partFromSaveData));
      this.refreshFromParts();

      if (saved.plan) {
        // 保存された起点を addNode の from として与える。
        const anchor = kinematicState<'eci'>(
          saved.plan.anchor.t,
          v3(saved.plan.anchor.r.x, saved.plan.anchor.r.y, saved.plan.anchor.r.z),
          v3(saved.plan.anchor.v.x, saved.plan.anchor.v.y, saved.plan.anchor.v.z),
        );
        let rejected = 0;
        for (const n of saved.plan.nodes) {
          const idx = this.plan.addNode(kinematicState<'eci'>(n.t, v3(n.r.x, n.r.y, n.r.z), v3(n.v.x, n.v.y, n.v.z)), anchor);
          if (idx < 0) rejected++;
        }
        if (rejected > 0) _hud.hint(`${this.name}: 起点より前のマニューバノード ${rejected} 件を復元できません`);
      }
    }
  }

  // 高度 INITIAL_ALT、傾斜角 INITIAL_INC_DEG の円軌道状態を返す。
  private static makeInitialState(): KinematicState {
    const r0 = R_EARTH + INITIAL_ALT;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const inc = (INITIAL_INC_DEG * Math.PI) / 180;
    return kinematicState<'eci'>(0, v3(r0, 0, 0), v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)));
  }

  // 3軸を非対称にし、中間軸(ピッチ)周りの回転にジャニベコフ効果(中間軸不安定性)が
  // 起こるようにする。ロール軸(機体前後方向)は細長い形状に見合って最小にする。
  private static readonly INERTIA = v3(PLAYER_INERTIA_PITCH, PLAYER_INERTIA_YAW, PLAYER_INERTIA_ROLL);

  // state の速度方向を機首、位置方向を上として姿勢を組む。
  private static progradeAttitude(state: KinematicState): Attitude {
    return {
      q: qFromBasis(state.v, state.r),
      w: v3(),
      inertia: Player.INERTIA,
    };
  }

  // HP を HP_REGEN_RATE で maxHp まで自然回復させる。
  private hpRegen(dt: number): void {
    if (this.hp <= 0 || this.hp >= this.maxHp) return;
    this.selfRepair(dt * HP_REGEN_RATE);
  }

  // -------------------------------------------------------- 移動/射撃 状態
  get roundsInMag(): number { return this.fire.rounds; }
  get magsLeft(): number { return this.fire.mags; }
  get magsLeftInBarrel(): number { return this.fire.barrel; }
  get reloadTimer(): number { return this.fire.cooldown; }
  get isFiring(): boolean { return this.fire.isFiring; }

  // 弾薬ピックアップで得たマグ数を加算する。
  onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  // 弾薬を初期積載の状態まで満タンにする。
  refillAmmo(): void {
    this.fire.refillFull();
  }

  // 毎フレーム、全ての自機に対して1度だけ呼ぶ。input が null の艦は、このフレーム操作されない
  // 艦として畳む。
  public updateControls(
    input: Input | null,
    dt: number,
    simDt: number,
    registry: EntityRegistry,
    activeStage: Stage,
    celestialSystem: CelestialSystem,
  ): void {
    this.hpRegen(dt);
    if (input !== null) this.handleEdgeInput(input, registry);
    // ブースターの燃焼は操作の可否によらず進むので、指令を畳んだあとに進める。
    if (input === null) {
      this.clearTransientCommands();
      this.boosters.step(simDt);
      this.thrust = this.boosters.thrust;
      return;
    }
    this.boosters.step(simDt);
    this.updateTorque(input, dt, simDt);

    this.fire.updateFireState(dt, input, activeStage, registry, celestialSystem);

    this.throttle.updateThrustLatches(input);
    const rcsThrust = this.throttle.updateThrustState(input, this.att, simDt, this);
    const boosterThrust = this.boosters.thrust;
    this.thrust = rcsThrust && boosterThrust
      ? add(rcsThrust, boosterThrust)
      : rcsThrust ?? boosterThrust;
    // 噴射中は予測が毎フレーム陳腐化するので破棄する。
    if (this.thrust !== null) this.invalidatePrediction();
  }

  // 艦の各下位系を1フレーム分進める。喪失した艦では何も進めない。
  protected override stepEnvironment(
    dt: number, atmosphereBody: CelestialBody | null, atmospherePivot: number,
    sunlit: number, sunDir: Vec3,
  ): void {
    if (!this.alive) return;
    this.belt.update(dt, this.fire.rounds, this.att, this.throttle.thrustAccelVec);
    this.radiator.update(dt, this.radiatorWear());
    this.fire.stepBarrelThermal(dt);
    this.aero.update(this.state.r, this.state.v, atmosphereBody, atmospherePivot);
    this.altitudeAlarm.update(dt, this.state.r, atmosphereBody, atmospherePivot);
    this.power.update(dt, sunlit, sunDir, this.att, this);
  }

  // 艦体自体の放熱面積に、展開した放熱板のぶんを上乗せする。
  protected override get radiatingAreaPerMass(): number {
    return SHIP_RADIATING_AREA_PER_MASS
      + this.radiator.radiatingArea(this.totalCoolingRate) / PLAYER_MASS;
  }

  // 艦体の断面積に、展開した放熱板の日照面を上乗せする。
  protected override solarAbsorbAreaPerMass(sunDir: Vec3): number {
    return super.solarAbsorbAreaPerMass(sunDir)
      + this.radiator.solarAbsorbArea(sunDir, this.att, this.totalCoolingRate) / PLAYER_MASS;
  }

  // 次のフレームへ持ち越してはならない連続指令(推力・トルク・射撃)を畳む。角速度による
  // coast はそのまま続く。
  clearTransientCommands(): void {
    this.thrust = null;
    this.boosters.clearThrust();
    this.torque = v3();
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }

  // 姿勢微調整モードの ON/OFF を切り替える。
  toggleFineAttitude(): void {
    this.fineAttitude = !this.fineAttitude;
    this._hud.hint(`姿勢微調整モード: ${this.fineAttitude ? 'ON' : 'OFF'}`);
  }

  // 自機側のキー(RCS減衰・プログレード・スロットル等)を1フレーム分消費する。
  private handleEdgeInput(input: Input, registry: EntityRegistry): void {
    input.takeKeys((code) => this.handleEdgePress(code, registry));
  }

  // 自機側キー1個を処理する。処理したキーは true を返し input.takeKeys に消費させる。
  private handleEdgePress(code: string, registry: EntityRegistry): boolean {
    switch (code) {
      case K.rcsDampToggle.code: this.throttle.toggleRcsDamp(); return true;
      case K.progradeReset.code: this.throttle.enableProgradeReset(); return true;
      case K.fineAttitudeToggle.code: this.toggleFineAttitude(); return true;
      case K.progradeHoldToggle.code: this.throttle.toggleProgradeHold(); return true;
      case K.throttleLow.code: this.throttle.setThrottlePreset(0); return true;
      case K.throttleMid.code: this.throttle.setThrottlePreset(1); return true;
      case K.throttleHigh.code: this.throttle.setThrottlePreset(2); return true;
      case K.throttleMax.code: this.throttle.setThrottlePreset(3); return true;
      case K.boosterDecouple.code: this.boosters.decouple(registry); return true;
      case K.boosterIgnitionToggle.code: this.boosters.toggleIgnition(); return true;
      case K.radiatorDeployLeft.code: this.radiator.toggle('up'); return true;
      case K.radiatorDeployRight.code: this.radiator.toggle('down'); return true;
      case K.solarDeployLeft.code: this.power.toggle('up'); return true;
      case K.solarDeployRight.code: this.power.toggle('down'); return true;
      case K.reload.code: return this.fire.manualReload(registry);
      default: return false;
    }
  }

  // 放熱板パーツの残 HP から side ごとの損耗率を組む。パーツが欠けている側は全損扱い。
  private radiatorWear(): Record<RadiatorSide, number> {
    const [up, down] = this.radiatorParts;
    const wearOf = (part: typeof up): number =>
      part && part.maxHp > 0 ? 1 - part.hp / part.maxHp : 1;
    return { up: wearOf(up), down: wearOf(down) };
  }

  // 被弾によるダメージ・致死判定。side を指定するとその放熱板パーツへ、無指定なら
  // 無作為なパーツへダメージが入る。
  private attackedByBullet(
    bullet: Bullet, impactPoint: Vec3, activeStage: Stage, registry: EntityRegistry,
    side: RadiatorSide | null = null,
  ): void {
    this.absorbHeat(BULLET_IMPACT_HEAT / PLAYER_MASS);
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    this.applyDamageToParts(side === null ? bullet.damage : RADIATOR_BULLET_DAMAGE, damagedPart);
    if (side !== null && damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side, registry);
    if (this.hp > 0) {
      this.impactEffect(bullet, impactPoint);
      return;
    }

    this.alive = false;
    const reason = bullet.shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    activeStage.recordPlayerLost(reason);
    this.destroyEffect(registry);
  }

  // 弾は武装のダメージを、それ以外は接触の接近速度と相手の種別を根拠にする(ゲームバランスの量)。
  collideWithEntity(
    other: DynamicEntity, contact: Contact, activeStage: Stage, registry: EntityRegistry,
  ): void {
    if (!this.alive) return;

    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, activeStage, registry);
      return;
    }

    this.damagedByContact(
      contactDamageSpeed(other, contact), null, '高速接触により機体を喪失した', activeStage, registry);
  }

  // 天体の固体表面への接触。相手の種別による重みが無いので接近速度がそのまま根拠になる。
  collideWithCelestialBody(
    _body: CelestialBody, contact: Contact, activeStage: Stage, registry: EntityRegistry,
  ): void {
    if (!this.alive) return;
    this.damagedByContact(
      closingSpeed(contact), null, '天体の地表へ到達し機体は失われた', activeStage, registry);
  }

  // 放熱板の接触代理(RadiatorFold)からの帰結。ダメージは side の放熱板パーツへ入る。
  collideAtRadiatorWithEntity(
    side: RadiatorSide, other: DynamicEntity, contact: Contact, activeStage: Stage,
    registry: EntityRegistry,
  ): void {
    if (!this.alive) return;

    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, activeStage, registry, side);
      return;
    }

    this.damagedByContact(
      contactDamageSpeed(other, contact), side, '高速接触により機体を喪失した', activeStage, registry);
  }

  // 接触によるダメージ・致死判定。side を指定するとその放熱板パーツへ、無指定なら無作為な
  // パーツへダメージが入る。
  private damagedByContact(
    damageSpeed: number, side: RadiatorSide | null, lossReason: string, activeStage: Stage,
    registry: EntityRegistry,
  ): void {
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    if (!this.applyCollisionDamage(damageSpeed, damagedPart)) return;
    if (side !== null && damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side, registry);
    if (this.hp > 0) {
      this._worldSfx.clank();
      this._fx.spawnGasPuff(this.state);
      return;
    }

    this.alive = false;
    activeStage.recordPlayerLost(lossReason);
    this.destroyEffect(registry);
  }

  // この艦の接触代理一覧 — 放熱板の折り(展開中かつ健在なものだけ)と、ベルトの節点。
  override contactProxies(simTime: number, dt: number): readonly DynamicEntity[] {
    this.contactProxyScratch.length = 0;
    for (const fold of this.radiator.contactFolds(this.state.r, this.state.v, this.att, simTime)) {
      this.contactProxyScratch.push(fold);
    }
    for (const section of this.belt.contactSections(simTime, dt, this.state.r, this.state.v, this.att)) {
      this.contactProxyScratch.push(section);
    }
    return this.contactProxyScratch;
  }

  // ベルトは反発を節点の側で受け止めるので、解決後の状態を機体座標系の鎖へ書き戻す。
  override applyContactProxies(dt: number): void {
    this.belt.applyContactSections(dt, this.state.r, this.state.v, this.att);
  }

  // 動圧が構造限界を超えたことによる喪失。
  checkLoss(
    _dt: number, _simTime: number, activeStage: Stage, registry: EntityRegistry,
    _viewerPos: Vec3, _atmosphereBodies: readonly CelestialBody[],
  ): void {
    if (!this.alive) return;
    if (!this.aero.overStructuralLimit) return;
    this.lose('動圧が構造限界を超え、機体は空力的に分解した', activeStage, registry);
  }

  // 外殻の温度が上限を超えたときの喪失。理由は、そこで空力加熱が効いていたかで分ける。
  protected override burnUp(activeStage: Stage, registry: EntityRegistry): void {
    this.lose(
      this.aero.heatingAerodynamically
        ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
        : '排熱が追いつかず、機体は熱で機能不全に陥った',
      activeStage, registry);
  }

  // 喪失の共通処理。reason はステージの記録に残す喪失理由。
  private lose(reason: string, activeStage: Stage, registry: EntityRegistry): void {
    this.alive = false;
    this.destroyEffect(registry);
    activeStage.recordPlayerLost(reason);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private impactEffect(bullet: Bullet, impactPoint: Vec3): void {
    this._worldSfx.hit(len(sub(impactPoint, this.state.r)));
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(kinematicState<'eci'>(this.state.t, impactPoint, this.state.v));
    } else {
      this._fx.spawnBulletFlash(kinematicState<'eci'>(this.state.t, impactPoint, this.state.v));
    }
    this._fx.spawnGasPuff(kinematicState<'eci'>(this.state.t, impactPoint, this.state.v));
  }

  // 機体喪失時の爆発音・爆発エフェクトを発生させる。
  private destroyEffect(registry: EntityRegistry): void {
    this._worldSfx.explosion();
    const { t, r, v } = this.state;
    this._fx.spawnFlash(this.state, DESTROY_FLASH1_SIZE0, DESTROY_FLASH1_SIZE1, DESTROY_FLASH1_DURATION, DESTROY_FLASH_COLOR_1);
    this._fx.spawnFlash(this.state, DESTROY_FLASH2_SIZE0, DESTROY_FLASH2_SIZE1, DESTROY_FLASH2_DURATION, DESTROY_FLASH_COLOR_2);
    for (const piece of buildDestroyFragments(
      t, r, v, 11, PLAYER_DESTROY_FRAG_COLOR, DESTROY_FRAG_SIZE_MIN / 3, DESTROY_FRAG_SIZE_MAX / 3, 20.0,
      this._worldSfx, this._fx, this.scene,
    )) registry.add(piece);
  }

  // ラジエーターが全損した瞬間の破片エフェクトを、そのパネル先端付近から発生させる。
  private radiatorBreakEffect(side: RadiatorSide, registry: EntityRegistry): void {
    const tipR = this.radiator.tipWorldPosition(side, this.state.r, this.att);
    this._worldSfx.hit(len(sub(tipR, this.state.r)));
    for (const piece of buildDestroyFragments(
      this.state.t, tipR, this.state.v, 4, PLAYER_DESTROY_FRAG_COLOR,
      DESTROY_FRAG_SIZE_MIN, DESTROY_FRAG_SIZE_MAX, 8.0,
      this._worldSfx, this._fx, this.scene,
    )) registry.add(piece);
  }

  // 入力から機体座標系トルクを求めて this.torque へ反映し、角速度をクランプする。
  private updateTorque(input: Input, dt: number, simDt: number): void {
    // 発砲中は姿勢微調整と同じ操作精度になる
    const fine = this.fineAttitude || this.fire.isFiring;
    this.torque = this.throttle.updateTorque(
      this.att,
      this.state.r,
      this.state.v,
      input,
      fine,
      dt,
      simDt,
      this,
      () => this._hud.hint('進行方向ホールド解除(手動操作)'),
    );
  }

  // 自機のメッシュ・エフェクト・ベルト・マーカーを displayTime の状態へ同期する。ガンサイト時の
  // 非表示・方位マーカー・RCS 音は操作対象かどうかで変わるので、それを active から引く。
  protected override syncModel(
    fo: FloatingOrigin,
    displayTime: number,
    active: Controllable | null,
    visibilityPolicy: MapVisibilityPolicy | null,
    _pools: InstancedPools,
    camera: CameraSystem,
    style: RenderStyle,
    _graphics: GraphicsSettingsData,
    orbitRef: OrbitReference | undefined,
  ): void {
    const displayState = this.placeModel(fo, displayTime, active, visibilityPolicy);
    const isActive = this === active;
    // 推力/RCS エフェクトとベルト。機体メッシュと同じ displayState に載せる —
    // 揃えないと「機体は未来位置、プルームは現在位置」に割れる。エフェクトはガンサイト中も
    // 出したままなので、機体だけを伏せるのはこれを控えた後。
    const effectState = displayState ?? this.state;
    const effectVisible = this.renderObject.visible;
    if (isActive && camera.zoomActive) this.renderObject.visible = false;
    const maxAccel = this.mass > 0 ? this.totalThrust / this.mass : 0;
    const rcsThrust = len(this.throttle.thrustAccelVec) > 0 ? this.throttle.thrustAccelVec : null;
    this.thrustEffects.sync(fo, effectState.r, rcsThrust, maxAccel, effectVisible, false, camera, style);
    this.boosters.sync(fo, effectState.r, displayTime, effectVisible, camera, style);
    if (isActive) {
      this._worldSfx.setThrust(effectVisible && (rcsThrust !== null || this.boosters.thrust !== null));
    }
    this.rcsEffects.sync(fo, effectState.r, this.torque, this.att, effectVisible, camera, isActive);
    this.reentryEffects.sync(fo, effectState.r, effectState.v, this.aero.qdyn, effectVisible, camera);
    this.belt.sync(this.magsLeft);
    this.radiator.sync();
    this.power.sync();
    // マーカー。方位マーカーは操作対象の軌道座標系を指す。
    this.markers.sync(
      this.state, this.att, camera.view, isActive, camera.activeCameraProjection,
      this.roundsInMag, this.magsLeft, this.averageMuzzleVelocity, orbitRef,
    );
  }

  // 艦は任意のタイミングで削除されうるので、Player が所有する線・ビルボード・HUD も一度だけ解放する。
  private disposed: boolean = false;

  // 画面マーカーと被選択判定が同じ艦を指すためのキー。
  private get markerKey(): string { return `player-${this.id}`; }

  // 画面マーカー・一覧に出すこの艦の項目。role はターゲット強調の有無、isActive は
  // マップ上で自艦と僚艦を塗り分けるための操作対象フラグ。
  markerItem(role: MarkerRole, viewerPos: Vec3, pos: Vec3, vel: Vec3, view: View, isActive: boolean): GroupedMarkerItem {
    const dist = len(sub(pos, viewerPos));
    const priority = role === 'primary' ? MARKER_PRIORITY.PRIMARY_TARGET : MARKER_PRIORITY.PLAYER;
    const kindCls = isActive ? 'mk-self' : 'mk-ally';
    const color = role === 'primary' ? currentThemePalette().signal : isActive ? 'var(--color-primary)' : COLOR_MARKER_ALLY;
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: role === 'primary' ? `${kindCls} mk-target` : kindCls,
      sym: view === 'map' ? this.headingHpMarkerSvg() : this.hpMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      detail: view === 'map' ? '' : fmtMarkerDist(dist),
      bearingColor: role === 'primary' ? currentThemePalette().signal : COLOR_MARKER_ALLY,
      bearingSym: DIRECTION_GLYPH.allyBearing,
      bearingClass: 'mk-dir mk-ally-dir',
      bearingVisible: dist <= ALLY_BEARING_MAX_DISTANCE,
      color,
      symMarkup: true,
    };
  }

  // 自身に関するメッシュやエフェクトを解放する。
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTransientCommands();
    this.markers.dispose();
    this.thrustEffects.dispose(this.playerScene);
    this.boosters.dispose();
    this.rcsEffects.dispose(this.playerScene);
    this.reentryEffects.dispose(this.playerScene);
    super.dispose();
  }

  // 現在の艦状態を保存用データへ変換する。
  public override serialize(): PlayerSaveData {
    return {
      id: this.id,
      name: this.name,
      kind: 'player',
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      fire: this.fire.serialize(),
      thermal: { hullTemp: this.temperature },
      radiator: this.radiator.serialize(),
      power: this.power.serialize(),
      throttle: this.throttle.serialize(),
      parts: this.parts.map(p => ({ ...p })) as AnyPart[],
      planExecution: this.planExecution,
      fineAttitude: this.fineAttitude,
      showTrajectoryLine: this.showTrajectoryLine,
      plan: this.serializePlan(),
      boosters: this.boosters.serialize(),
    };
  }

  // 計画の保存形。凍結された計画が無ければ null。
  private serializePlan(): PlanSaveData | null {
    const frozen = this.plan.frozenData();
    if (!frozen) return null;
    const { anchor, nodes } = frozen;
    return {
      anchor: { t: anchor.t, r: { ...anchor.r }, v: { ...anchor.v } },
      nodes: nodes.map((n) => ({ t: n.t, r: { ...n.r }, v: { ...n.v } })),
    };
  }

  // 被選択物(ObjectPickable)としての振る舞い。
  public get gone(): boolean { return !this.alive; }
  public get orbitState(): KinematicState { return this.state; }
  public readonly glyph = ENTITY_GLYPH.ship;
  public get glyphSvg(): string { return shipMarkerSvg(true); }
  public readonly listSection: MapListSection = 'player';
  public readonly pickerGenre: ObjectPickerGenre = '自艦';
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = true;
  public listCounted(): boolean { return false; }

  // 表示時刻の ECI 位置。予測が届かない時刻では null。
  public posAt(displayTime: number): Vec3 | null {
    return this.stateAt(displayTime)?.r ?? null;
  }

  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.markerKey); }

  // 残 HP と、いま最も強く引かれている天体を中心とした近地点高度。
  public listDetail(celestialSystem: CelestialSystem): string {
    const center = strongestAttractor(this.state.r, celestialSystem.celestialMotions, this.state.t);
    const el = this.orbitalElementsAround(center, this.state.t);
    const pe = el ? fmtDist(apsisAltitudes(el).pe) : '—';
    return `HP ${Math.round(this.hp)}/${Math.round(this.maxHp)} · PE ${pe}`;
  }

  // 検索が照合する文字列。行の補助表示と同じ。
  public listSearchText(celestialSystem: CelestialSystem): string {
    return this.listDetail(celestialSystem);
  }

  // 操作中の自艦を一覧の先頭へ出す。
  public listPriority(viewer: Viewer | null): number {
    return this === viewer ? -100 : 0;
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public menuItems(
    _celestialSystem: CelestialSystem, viewer: Viewer | null, navTargetId: string | null,
  ): readonly MenuItem<MenuAction>[] {
    const isActive = this === viewer;
    const activate: MenuItem<MenuAction> = isActive
      ? { label: '操作対象を解除', act: 'deactivate' }
      : { label: '操作対象にする', act: 'activate' };
    const remove: readonly MenuItem<MenuAction>[] = isActive ? [] : [{ label: '削除', act: 'delete' }];
    const planExecLabel = `軌道計画の実行: ${planExecutionLabel(this.planExecution)}`;

    // 操作対象の自艦は予測線・過去線に固定されるので、トグルは非操作艦にだけ出す。
    const trajectoryItem: readonly MenuItem<MenuAction>[] = isActive
      ? [] : [MenuCommon.trajectoryLine(this.showTrajectoryLine)];

    return [
      MenuCommon.target(navTargetId === this.id),
      { label: planExecLabel, act: 'planExecCycle', keepOpen: true },
      activate,
      MenuCommon.focus(),
      ...trajectoryItem,
      MenuCommon.duplicate(),
      ...remove,
      MenuCommon.cancel(),
    ];
  }

  // 軌道線の表示と計画実行モードは自分の状態を書き換える。
  public runMenu(
    act: MenuAction, controlSelection: ControlSelection, authoring: ObjectAuthoring | null,
  ): void {
    if (act === 'toggleTrajectoryLine') {
      this.showTrajectoryLine = !this.showTrajectoryLine;
    } else if (act === 'activate') {
      controlSelection.select(this);
    } else if (act === 'deactivate') {
      controlSelection.release(this);
    } else if (act === 'planExecCycle') {
      const i = PLAN_EXECUTION_MODES.indexOf(this.planExecution);
      this.planExecution = PLAN_EXECUTION_MODES[(i + 1) % PLAN_EXECUTION_MODES.length]!;
    } else if (act === 'duplicate') {
      authoring?.openObjectPlacerForDuplicate(this.mapKind, this.state);
    } else if (act === 'delete') {
      controlSelection.remove(this);
    }
  }

  // プロパティウィンドウに出す行。装甲・温度・電力・弾薬を主要行とし、操作対象か・計画実行は
  // 詳細トグル、軌道要素は「軌道」グループの下に畳む。
  public propertyRows(
    celestialSystem: CelestialSystem, viewer: Viewer | null, simTime: number,
  ): readonly PropertyRow[] {
    return [
      {
        key: 'operated', label: '操作対象か',
        value: this === viewer ? 'はい' : 'いいえ', collapsible: true,
      },
      { key: 'follow', label: '計画実行', value: planExecutionLabel(this.planExecution), collapsible: true },
      { key: 'hp', label: '装甲', value: `${Math.floor(this.hp)} / ${this.maxHp}` },
      { key: 'temp', label: '温度', value: `${this.temperature.toFixed(0)} K` },
      { key: 'power', label: '電力', value: fmtEnergy(this.power.chargeJ) },
      { key: 'ammo', label: '弾薬', value: fmtAmmoStatus(this.roundsInMag, this.magsLeft, this.reloadTimer) },
      ...orbitRows(this, celestialSystem, simTime),
    ];
  }

  public readonly rename = (name: string): void => { this.setName(name); };

  // 単クリックはプロパティウィンドウを開くだけに留め、操作対象は変えない。
  public readonly onMapSelect = (windows: ObjectWindows, clientX: number, clientY: number): void => {
    windows.openProperties(this, clientX, clientY);
  };

  // 注視されたら操作対象にもなる(操作艦を切り替える最速の手段)。
  public readonly onMapFocus = (controlSelection: ControlSelection): void => {
    controlSelection.select(this);
    this._hud.hint(`${this.name} を操作対象に設定`);
  };
}

// この個体が自機か。顔ぶれから自機だけを絞るときに使う。
export function isPlayer(entity: DynamicEntity): entity is Player {
  return entity instanceof Player;
}
