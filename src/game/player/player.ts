import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';

import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { View } from '../view/view';
import { Attitude } from '../../physics/attitude';
import { qFromBasis } from '../../math/quat';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../celestial/solar-system/constants';
import { Vec3, add, v3, len, sub } from '../../math/vec3';
import { fmtDist, fmtEnergy } from '../../hud/utils';
import { Ship, PLAYER_MASS, PLAYER_INERTIA_PITCH, PLAYER_INERTIA_YAW, PLAYER_INERTIA_ROLL } from '../dynamic/dynamic-entity/ship';
import { bulletReactionOf, type BulletType, type Shooter } from '../dynamic/dynamic-entity/bullet-reaction';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { closingSpeed, type Contact } from '../dynamic/dynamic-entity/contact';
import { contactDamageSpeed } from '../dynamic/dynamic-entity/contact-damage';
import { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { Notifier } from '../../hud/notifier';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import { generateRandomName } from '../random-name';
import type { StageOutcome } from '../stages/stage-outcome';
import { Throttle } from './throttle';
import { FireControl, type AmmoLoad } from './fire-control';
import { AltitudeAlarm } from './altitude-alarm';
import type { FlashEffects } from '../vfx/flash-effects';
import { buildDestroyFragments, playerDestroyFragments } from '../dynamic/dynamic-entity/debris-piece';
import { PlayerView } from '../../render/dynamic/player/player-view';
import type { MarkerSlots } from '../marker/marker-slots';
import type { MarkerVisibility } from '../marker/marker-visibility';
import type { RadiatorSide } from './radiator';

import { Plan, type PlanExecutionMode } from '../plan/plan';
import { savedAttitude, savedKinematicState, type PlayerSaveData, type PlanSaveData } from '../save/save-data';
import { partFromSaveData, type AnyPart } from '../dynamic/dynamic-entity/parts';
import { DIRECTION_GLYPH, ENTITY_GLYPH, COLOR_MARKER_ALLY } from '../marker/marker-identity';
import { shipMarkerSvg } from '../marker/marker-shapes';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN, PLAYER_DESTROY_FRAG_COLOR } from '../../render/vfx-style';
import { AttachedBoosters } from './attached-boosters';
import { MARKER_PRIORITY } from '../marker/crowding';
import { strongestAttractor } from '../../physics/attractor';
import { apsisAltitudes } from '../../physics/elements';
import { fmtAmmoStatus } from '../hud/ammo-status';
import { MenuCommon, type MenuAction } from '../hud/windows/menu-actions';
import { orbitRows } from '../pickable/orbit-rows';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { ControlSelection } from '../control-selection';
import type { ObjectAuthoring } from '../pickable/inspected-object';
import type { PropertyWindowOpener } from '../pickable/property-window-opener';
import type { MenuItem } from '../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window-content';
import type { MapListSection, ObjectPickerGenre } from '../pickable/pickable-listing';
import { PlayerMotion, type PlayerMotionReactions } from './player-motion';
import type { DynamicMotion, DynamicReactionServices } from '../dynamic/dynamic-motion';

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

  public declare readonly motion: PlayerMotion;
  readonly throttle: Throttle;
  readonly fire: FireControl;
  readonly altitudeAlarm: AltitudeAlarm;
  readonly boosters: AttachedBoosters;
  // この艦自身のマニューバ計画。
  readonly plan = new Plan();
  planExecution: PlanExecutionMode = 'instant';

  private readonly _notifier: Notifier;
  private readonly _worldSfx: WorldSfx;
  private readonly _fx: FlashEffects;

  fineAttitude = false;
  // 自機の操作方法は HUD とヘルプが常設で示しているので、選び直しても案内は出さない。
  readonly controlHint = null;
  readonly releaseHint = null;

  // init 省略時は無作為な名前と既定軌道の新規艦になる。id を省いたときは name がそのまま
  // 艦の識別子になるので、複数隻を並べるなら name も分ける。
  constructor(
    _notifier: Notifier,
    _worldSfx: WorldSfx,
    scene: THREE.Scene,
    _fx: FlashEffects,
    markers: MarkerSlots,
    init: PlayerInit = {},
  ) {
    const saved = 'saved' in init ? init.saved : undefined;
    const name = 'saved' in init ? (init.saved.name || init.saved.id) : (init.name ?? generateRandomName('player'));
    const state = 'saved' in init
      ? savedKinematicState(init.saved, init.simTime)
      : (init.state ?? Player.makeInitialState());
    const id = 'saved' in init ? init.saved.id : (init.id ?? name);
    const att: Attitude = 'saved' in init
      ? savedAttitude(init.saved, Player.INERTIA)
      : Player.progradeAttitude(state);

    const reactions = (owner: Player): PlayerMotionReactions => ({
      roundsInMagazine: () => owner.fire.rounds,
      thrustAcceleration: () => owner.throttle.thrustAccelVec,
      radiatorWear: () => owner.radiatorWear(),
      totalCoolingRate: () => owner.totalCoolingRate,
      totalPowerGeneration: () => owner.totalPowerGeneration,
      stepBarrelThermal: dt => owner.fire.stepBarrelThermal(dt),
      updateAltitudeAlarm: (dt, position, body, pivot) => (
        owner.altitudeAlarm.update(dt, position, body, pivot)
      ),
      receiveEntityContact: (other, contact, context) => (
        owner.receiveEntityContact(other, contact, context)
      ),
      receiveRadiatorContact: (side, other, contact, context) => (
        owner.receiveRadiatorContact(side, other, contact, context)
      ),
      receiveSurfaceContact: (contact, context) => owner.receiveSurfaceContact(contact, context),
      receiveStructuralLoss: context => owner.receiveStructuralLoss(context),
      receiveBurnUp: context => owner.receiveBurnUp(context),
    });
    super(
      name,
      state,
      owner => new PlayerView(scene, owner.id, markers),
      att,
      PLAYER_HULL_RADIUS,
      PLAYER_MAX_HP,
      id,
      owner => new PlayerMotion(
        state,
        att,
        PLAYER_HULL_RADIUS,
        saved?.thermal.hullTemp ?? HULL_START_TEMP,
        reactions(owner as Player),
        saved?.radiator,
        saved?.power,
        saved?.boosters,
      ),
    );
    this._notifier = _notifier;
    this._worldSfx = _worldSfx;
    this._fx = _fx;
    this.throttle = new Throttle(_notifier, saved?.throttle);
    this.fire = new FireControl(this, _notifier, _worldSfx, scene, _fx, 'saved' in init ? { saved: init.saved.fire } : { ammo: init.ammo });
    this.altitudeAlarm = new AltitudeAlarm(_notifier, _worldSfx);
    this.boosters = new AttachedBoosters(
      this.motion, this.motion.attachedBoosters, _notifier, _worldSfx, scene, _fx,
    );

    if (saved) {
      // 旧セーブは followPlan: boolean だった(true→'instant' / false→'off')。'powered' だった
      // セーブは廃止済みモードなので既定の 'instant' へ寄せる。
      this.planExecution = saved.planExecution === 'off' || saved.planExecution === 'instant'
        ? saved.planExecution
        : (saved.followPlan ? 'instant' : 'off');
      this.fineAttitude = saved.fineAttitude ?? false;
      this.trajectoryLineVisible = saved.showTrajectoryLine ?? false;
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
        if (rejected > 0) _notifier.hint(`${this.name}: 起点より前のマニューバノード ${rejected} 件を復元できません`);
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
  get reloadTimer(): number { return this.fire.cooldown; }

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
    activeStage: StageOutcome,
    celestialBodies: CelestialBodies,
  ): void {
    this.hpRegen(dt);
    if (input !== null) this.handleEdgeInput(input, registry);
    // ブースターの燃焼は操作の可否によらず進むので、指令を畳んだあとに進める。
    if (input === null) {
      this.clearTransientCommands();
      this.motion.attachedBoosters.step(simDt);
      this.motion.thrust = this.motion.attachedBoosters.thrust;
      return;
    }
    this.motion.attachedBoosters.step(simDt);
    this.updateTorque(input, dt, simDt);

    this.fire.updateFireState(dt, input, activeStage, registry, celestialBodies);

    this.throttle.updateThrustLatches(input);
    const rcsThrust = this.throttle.updateThrustState(input, this.motion.att, simDt, this);
    const boosterThrust = this.motion.attachedBoosters.thrust;
    this.motion.thrust = rcsThrust && boosterThrust
      ? add(rcsThrust, boosterThrust)
      : rcsThrust ?? boosterThrust;
    // 噴射中は予測が毎フレーム陳腐化するので破棄する。
    if (this.motion.thrust !== null) this.motion.invalidatePrediction();
  }

  // 次のフレームへ持ち越してはならない連続指令(推力・トルク・射撃)を畳む。角速度による
  // coast はそのまま続く。
  clearTransientCommands(): void {
    this.motion.thrust = null;
    this.motion.attachedBoosters.clearThrust();
    this.motion.torque = v3();
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }

  // 姿勢微調整モードの ON/OFF を切り替える。
  toggleFineAttitude(): void {
    this.fineAttitude = !this.fineAttitude;
    this._notifier.hint(`姿勢微調整モード: ${this.fineAttitude ? 'ON' : 'OFF'}`);
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
      case K.radiatorDeployLeft.code: this.motion.radiator.toggle('up'); return true;
      case K.radiatorDeployRight.code: this.motion.radiator.toggle('down'); return true;
      case K.solarDeployLeft.code: this.motion.power.toggle('up'); return true;
      case K.solarDeployRight.code: this.motion.power.toggle('down'); return true;
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
    bulletType: BulletType, shooter: Shooter, damage: number, impactPoint: Vec3,
    activeStage: StageOutcome, registry: EntityRegistry,
    side: RadiatorSide | null = null,
  ): void {
    this.motion.absorbHeat(BULLET_IMPACT_HEAT / PLAYER_MASS);
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    this.applyDamageToParts(side === null ? damage : RADIATOR_BULLET_DAMAGE, damagedPart);
    if (side !== null && damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side, registry);
    if (this.hp > 0) {
      this.impactEffect(bulletType, impactPoint);
      return;
    }

    this.motion.alive = false;
    const reason = shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    activeStage.recordPlayerLost(reason);
    this.destroyEffect(registry);
  }

  // 弾は武装のダメージを、それ以外は接触の接近速度と相手の種別を根拠にする(ゲームバランスの量)。
  private receiveEntityContact(
    other: DynamicMotion, contact: Contact, context: DynamicReactionServices,
  ): void {
    if (!this.motion.alive) return;

    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(
        bullet.type, bullet.shooter, bullet.damage, contact.point,
        context.activeStage, context.registry,
      );
      return;
    }

    this.damagedByContact(
      contactDamageSpeed(other, contact), null, '高速接触により機体を喪失した',
      context.activeStage, context.registry,
    );
  }

  // 天体の固体表面への接触。相手の種別による重みが無いので接近速度がそのまま根拠になる。
  private receiveSurfaceContact(contact: Contact, context: DynamicReactionServices): void {
    if (!this.motion.alive) return;
    this.damagedByContact(
      closingSpeed(contact), null, '天体の地表へ到達し機体は失われた',
      context.activeStage, context.registry,
    );
  }

  // 放熱板の接触代理(RadiatorFold)からの帰結。ダメージは side の放熱板パーツへ入る。
  private receiveRadiatorContact(
    side: RadiatorSide, other: DynamicMotion, contact: Contact, context: DynamicReactionServices,
  ): void {
    if (!this.motion.alive) return;

    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(
        bullet.type, bullet.shooter, bullet.damage, contact.point,
        context.activeStage, context.registry, side,
      );
      return;
    }

    this.damagedByContact(
      contactDamageSpeed(other, contact), side, '高速接触により機体を喪失した',
      context.activeStage, context.registry,
    );
  }

  // 接触によるダメージ・致死判定。side を指定するとその放熱板パーツへ、無指定なら無作為な
  // パーツへダメージが入る。
  private damagedByContact(
    damageSpeed: number, side: RadiatorSide | null, lossReason: string, activeStage: StageOutcome,
    registry: EntityRegistry,
  ): void {
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    if (!this.applyCollisionDamage(damageSpeed, damagedPart)) return;
    if (side !== null && damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side, registry);
    if (this.hp > 0) {
      this._worldSfx.clank();
      this._fx.spawnGasPuff(this.motion.state);
      return;
    }

    this.motion.alive = false;
    activeStage.recordPlayerLost(lossReason);
    this.destroyEffect(registry);
  }

  // 動圧が構造限界を超えたことによる喪失。
  private receiveStructuralLoss(context: DynamicReactionServices): void {
    if (!this.motion.alive) return;
    this.lose(
      '動圧が構造限界を超え、機体は空力的に分解した',
      context.activeStage, context.registry,
    );
  }

  // 外殻の温度が上限を超えたときの喪失。理由は、そこで空力加熱が効いていたかで分ける。
  private receiveBurnUp(context: DynamicReactionServices): void {
    this.lose(
      this.motion.aero.heatingAerodynamically
        ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
        : '排熱が追いつかず、機体は熱で機能不全に陥った',
      context.activeStage, context.registry,
    );
  }

  // 喪失の共通処理。reason はステージの記録に残す喪失理由。
  private lose(reason: string, activeStage: StageOutcome, registry: EntityRegistry): void {
    this.motion.alive = false;
    this.destroyEffect(registry);
    activeStage.recordPlayerLost(reason);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private impactEffect(bulletType: BulletType, impactPoint: Vec3): void {
    this._worldSfx.hit(len(sub(impactPoint, this.motion.state.r)));
    if (bulletType === 'plasma') {
      this._fx.spawnPlasmaFlash(kinematicState<'eci'>(
        this.motion.state.t, impactPoint, this.motion.state.v,
      ));
    } else {
      this._fx.spawnBulletFlash(kinematicState<'eci'>(
        this.motion.state.t, impactPoint, this.motion.state.v,
      ));
    }
    this._fx.spawnGasPuff(kinematicState<'eci'>(
      this.motion.state.t, impactPoint, this.motion.state.v,
    ));
  }

  // 機体喪失時の爆発音・爆発エフェクトを発生させる。
  private destroyEffect(registry: EntityRegistry): void {
    this._worldSfx.explosion();
    this._fx.spawnPlayerDestroyFlash(this.motion.state);
    for (const piece of playerDestroyFragments(this.motion.state, this._worldSfx, this._fx)) {
      registry.add(piece);
    }
  }

  // ラジエーターが全損した瞬間の破片エフェクトを、そのパネル先端付近から発生させる。
  private radiatorBreakEffect(side: RadiatorSide, registry: EntityRegistry): void {
    const tipR = this.motion.radiator.tipWorldPosition(side, this.motion.state.r, this.motion.att);
    this._worldSfx.hit(len(sub(tipR, this.motion.state.r)));
    for (const piece of buildDestroyFragments(
      this.motion.state.t, tipR, this.motion.state.v, 4, PLAYER_DESTROY_FRAG_COLOR,
      DESTROY_FRAG_SIZE_MIN, DESTROY_FRAG_SIZE_MAX, 8.0,
      this._worldSfx, this._fx,
    )) registry.add(piece);
  }

  // 入力から機体座標系トルクを求めて Motion へ反映し、角速度をクランプする。
  private updateTorque(input: Input, dt: number, simDt: number): void {
    // 発砲中は姿勢微調整と同じ操作精度になる
    const fine = this.fineAttitude || this.fire.isFiring;
    this.motion.torque = this.throttle.updateTorque(
      this.motion.att,
      this.motion.state.r,
      this.motion.state.v,
      input,
      fine,
      dt,
      simDt,
      this,
      () => this._notifier.hint('進行方向ホールド解除(手動操作)'),
    );
  }

  // 艦は任意のタイミングで削除されうるので、一度だけ連続指令と View を解放する。
  private disposed: boolean = false;

  // 画面マーカーと被選択判定が同じ艦を指すためのキー。
  private get markerKey(): string { return `player-${this.id}`; }

  // 画面マーカー・一覧に出すこの艦の項目。isActive はマップ上で自艦と僚艦を塗り分ける
  // ための操作対象フラグ。
  markerItem(viewerPos: Vec3, pos: Vec3, vel: Vec3, view: View, isActive: boolean): GroupedMarkerItem {
    const dist = len(sub(pos, viewerPos));
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: isActive ? 'mk-self' : 'mk-ally',
      sym: view === 'map' ? this.headingHpMarkerSvg() : this.hpMarkerSvg(),
      pos,
      vel,
      priority: MARKER_PRIORITY.PLAYER,
      name: this.name,
      bearingColor: COLOR_MARKER_ALLY,
      bearingSym: DIRECTION_GLYPH.allyBearing,
      bearingClass: 'mk-dir mk-ally-dir',
      bearingVisible: dist <= ALLY_BEARING_MAX_DISTANCE,
      color: isActive ? 'var(--color-primary)' : COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  // 自身に関するメッシュやエフェクトを解放する。
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTransientCommands();
    super.dispose();
  }

  // 現在の艦状態を保存用データへ変換する。
  public override serialize(): PlayerSaveData {
    return {
      id: this.id,
      name: this.name,
      kind: 'player',
      r: { ...this.motion.state.r },
      v: { ...this.motion.state.v },
      q: { ...this.motion.att.q },
      w: { ...this.motion.att.w },
      fire: this.fire.serialize(),
      thermal: { hullTemp: this.motion.temperature },
      radiator: this.motion.radiator.serialize(),
      power: this.motion.power.serialize(),
      throttle: this.throttle.serialize(),
      parts: this.parts.map(p => ({ ...p })) as AnyPart[],
      planExecution: this.planExecution,
      fineAttitude: this.fineAttitude,
      showTrajectoryLine: this.trajectoryLineVisible,
      plan: this.serializePlan(),
      boosters: this.motion.attachedBoosters.serialize(),
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
  public get gone(): boolean { return !this.motion.alive; }
  public get orbitState(): KinematicState { return this.motion.state; }
  public readonly glyph = ENTITY_GLYPH.ship;
  public get glyphSvg(): string { return shipMarkerSvg(true); }
  public readonly listSection: MapListSection = 'player';
  public readonly pickerGenre: ObjectPickerGenre = '自艦';
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = true;
  public listCounted(): boolean { return false; }

  // 表示時刻の ECI 位置。予測が届かない時刻では null。
  public posAt(displayTime: number): Vec3 | null {
    return this.motion.stateAt(displayTime)?.r ?? null;
  }

  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(this.markerKey); }

  // 残 HP と、いま最も強く引かれている天体を中心とした近地点高度。
  public listDetail(celestialBodies: CelestialBodies): string {
    const center = strongestAttractor(
      this.motion.state.r, celestialBodies.celestialMotions, this.motion.state.t,
    );
    const el = this.motion.orbitalElementsAround(center, this.motion.state.t);
    const pe = el ? fmtDist(apsisAltitudes(el).pe) : '—';
    return `HP ${Math.round(this.hp)}/${Math.round(this.maxHp)} · PE ${pe}`;
  }

  // 検索が照合する文字列。行の補助表示と同じ。
  public listSearchText(celestialBodies: CelestialBodies): string {
    return this.listDetail(celestialBodies);
  }

  // 操作中の自艦を一覧の先頭へ出す。
  public listPriority(viewer: OrbitingObject | null): number {
    return this === viewer ? -100 : 0;
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public menuItems(
    _celestialBodies: CelestialBodies, viewer: OrbitingObject | null, navTargetId: string | null,
  ): readonly MenuItem<MenuAction>[] {
    const isActive = this === viewer;
    const activate: MenuItem<MenuAction> = isActive
      ? { label: '操作対象を解除', act: 'deactivate' }
      : { label: '操作対象にする', act: 'activate' };
    const remove: readonly MenuItem<MenuAction>[] = isActive ? [] : [{ label: '削除', act: 'delete' }];
    const planExecLabel = `軌道計画の実行: ${planExecutionLabel(this.planExecution)}`;

    // 操作対象の自艦は予測線・過去線に固定されるので、トグルは非操作艦にだけ出す。
    const trajectoryItem: readonly MenuItem<MenuAction>[] = isActive
      ? [] : [MenuCommon.trajectoryLine(this.trajectoryLineVisible)];

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
      this.trajectoryLineVisible = !this.trajectoryLineVisible;
    } else if (act === 'activate') {
      controlSelection.select(this);
    } else if (act === 'deactivate') {
      controlSelection.release(this);
    } else if (act === 'planExecCycle') {
      const i = PLAN_EXECUTION_MODES.indexOf(this.planExecution);
      this.planExecution = PLAN_EXECUTION_MODES[(i + 1) % PLAN_EXECUTION_MODES.length]!;
    } else if (act === 'duplicate') {
      authoring?.openObjectPlacerForDuplicate(this.mapKind, this.motion.state);
    } else if (act === 'delete') {
      controlSelection.remove(this);
    }
  }

  // プロパティウィンドウに出す行。装甲・温度・電力・弾薬を主要行とし、操作対象か・計画実行は
  // 詳細トグル、軌道要素は「軌道」グループの下に畳む。
  public propertyRows(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number,
  ): readonly PropertyRow[] {
    return [
      {
        key: 'operated', label: '操作対象か',
        value: this === viewer ? 'はい' : 'いいえ', collapsible: true,
      },
      { key: 'follow', label: '計画実行', value: planExecutionLabel(this.planExecution), collapsible: true },
      { key: 'hp', label: '装甲', value: `${Math.floor(this.hp)} / ${this.maxHp}` },
      { key: 'temp', label: '温度', value: `${this.motion.temperature.toFixed(0)} K` },
      { key: 'power', label: '電力', value: fmtEnergy(this.motion.power.chargeJ) },
      { key: 'ammo', label: '弾薬', value: fmtAmmoStatus(this.roundsInMag, this.magsLeft, this.reloadTimer) },
      ...orbitRows(this, celestialBodies, simTime),
    ];
  }

  public readonly rename = (name: string): void => { this.setName(name); };

  // 単クリックはプロパティウィンドウを開くだけに留め、操作対象は変えない。
  public readonly onMapSelect = (windows: PropertyWindowOpener, clientX: number, clientY: number): void => {
    windows.openProperties(this, clientX, clientY);
  };

  // 注視されたら操作対象にもなる(操作艦を切り替える最速の手段)。
  public readonly onMapFocus = (controlSelection: ControlSelection): void => {
    controlSelection.select(this);
    this._notifier.hint(`${this.name} を操作対象に設定`);
  };
}

// この個体が自機か。顔ぶれから自機だけを絞るときに使う。
export function isPlayer(entity: DynamicEntity): entity is Player {
  return entity instanceof Player;
}
