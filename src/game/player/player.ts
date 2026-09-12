import type * as THREE from 'three/webgpu';
import type { ViewMode } from '../../render/view-mode';
import { Attitude } from '../../physics/attitude';
import { qFromBasis } from '../../math/quat';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../celestial/solar-system/constants';
import { Vec3, add, v3, len, sub } from '../../math/vec3';
import { Ship } from '../dynamic/dynamic-entity/ship';
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
import { Throttle } from './throttle';
import { FireControl, type AmmoLoad } from './fire-control';
import { AltitudeAlarm } from './altitude-alarm';
import type { FlashEffects } from '../vfx/flash-effects';
import { PlayerView, type PlayerRenderSource } from '../../render/dynamic/player/player-view';
import type { DynamicViewFrame } from '../../render/dynamic/dynamic-view';
import type { OrbitReference } from '../orbit-reference';
import type { MarkerSlots } from '../marker/marker-slots';
import type { RadiatorSide } from './radiator';

import { Plan, type PlanExecutionMode } from '../plan/plan';
import { savedAttitude, savedKinematicState, type PlayerSaveData, type PlanSaveData } from '../save/save-data';
import { partFromSaveData, type AnyPart, type Part } from '../dynamic/dynamic-entity/parts';
import { DIRECTION_GLYPH, COLOR_MARKER_ALLY } from '../marker/marker-identity';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { AttachedBoosters } from './attached-boosters';
import { MARKER_PRIORITY } from '../marker/crowding';
import type { Controllable, PilotCommandFrame } from '../dynamic/dynamic-entity/controllable';
import { PlayerMotion, type PlayerMotionReactions } from './player-motion';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import type { DynamicReactionServices } from '../dynamic/dynamic-simulation-participant';
import type { PlayerStatusSnapshot } from './player-status-snapshot';
import type { DamageOutcomeSink } from './damage-outcome';
import { PlayerInspection } from '../pickable/player-inspection';
import { DefaultPlayerEffects, type PlayerEffects } from './player-effects';
import { createPlayerParts, PLAYER_INERTIA_PITCH, PLAYER_INERTIA_YAW, PLAYER_INERTIA_ROLL } from './player-loadout';
import type { PartDamageTarget } from '../dynamic/dynamic-entity/damage-capabilities';

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

// 給弾ベルトの節点数。たわみ物理の鎖の長さと、表示するリンクメッシュの本数を揃える。
const BELT_MAX_VISIBLE = 18;

// 軌道計画の実行モードの巡回順。ボタン1つで次のモードへ進める。
// 新規配置は name/state/id/ammo を任意指定し、省略時は高度 INITIAL_ALT・傾斜 INITIAL_INC_DEG の
// 円軌道に機首プログレードで初期配置する。スナップショットからの再開は saved を simTime 付きの
// 状態として展開する。
export type PlayerInit =
  | { readonly name?: string; readonly state?: KinematicState; readonly id?: string; readonly ammo?: AmmoLoad }
  | { readonly saved: PlayerSaveData; readonly simTime: number };

// プレイヤー機: 操縦・射撃・ブースターなどの下位系を合成し、被弾・接触の帰結と保存を持つ。
export class Player extends Ship implements Controllable, PartDamageTarget {
  public override readonly mapKind: DynamicEntityKind = 'player';
  public override readonly controllable = true;
  public override readonly pickable = true;
  public readonly inspection = new PlayerInspection(this);
  public readonly objectPickable = this.inspection;
  // 除去の前に注視・操作対象の参照を次の艦へ引き継ぐ必要があるので、所有者側に回収させる。
  public override readonly reclaimedByOwner = true;

  public declare readonly motion: PlayerMotion;
  public readonly throttle: Throttle;
  public readonly fire: FireControl;
  public readonly altitudeAlarm: AltitudeAlarm;
  public readonly boosters: AttachedBoosters;
  private readonly effects: PlayerEffects;
  public override get parts(): readonly Part[] { return super.parts; }
  // この艦自身のマニューバ計画。
  public readonly plan = new Plan();
  public planExecution: PlanExecutionMode = 'instant';

  public fineAttitude = false;
  // 自機の操作方法は HUD とヘルプが常設で示しているので、選び直しても案内は出さない。
  public readonly controlHint = null;
  public readonly releaseHint = null;
  public readonly toggleSolarPanel = (side: 'up' | 'down'): void => this.motion.power.toggle(side);
  public readonly toggleRadiator = (side: 'up' | 'down'): void => this.motion.radiator.toggle(side);

  // init 省略時は無作為な名前と既定軌道の新規艦になる。id を省いたときは name がそのまま
  // 艦の識別子になるので、複数隻を並べるなら name も分ける。
  public constructor(
    private readonly notifier: Notifier,
    worldSfx: WorldSfx,
    scene: THREE.Scene,
    fx: FlashEffects,
    markers: MarkerSlots,
    init: PlayerInit = {},
  ) {
    const effects: PlayerEffects = new DefaultPlayerEffects(worldSfx, fx);
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
      weapon: {
        roundsInMagazine: () => owner.fire.rounds,
        stepBarrelThermal: dt => owner.fire.stepBarrelThermal(dt),
      },
      environment: {
        thrustAcceleration: () => owner.throttle.thrustAccelVec,
        radiatorWear: () => owner.radiatorWear(),
        totalCoolingRate: () => owner.totalCoolingRate,
        totalPowerGeneration: () => owner.totalPowerGeneration,
      },
      altitudeAlarm: {
        updateAltitudeAlarm: (dt, position, body, pivot) => (
          owner.altitudeAlarm.update(dt, position, body, pivot)
        ),
      },
      contact: {
        receiveEntityContact: (other, contact, services) => (
          owner.receiveEntityContact(other, contact, services)
        ),
        receiveRadiatorContact: (side, other, contact, services) => (
          owner.receiveRadiatorContact(side, other, contact, services)
        ),
        receiveSurfaceContact: (contact, services) => owner.receiveSurfaceContact(contact, services),
      },
      loss: {
        receiveStructuralLoss: services => owner.receiveStructuralLoss(services),
        receiveBurnUp: services => owner.receiveBurnUp(services),
      },
    });
    super(
      name,
      PLAYER_MAX_HP,
      owner => new PlayerMotion(
        state,
        att,
        PLAYER_HULL_RADIUS,
        saved?.thermal.hullTemp ?? HULL_START_TEMP,
        BELT_MAX_VISIBLE,
        reactions(owner as Player),
        saved?.radiator,
        saved?.power,
        saved?.boosters,
      ),
      new PlayerView(scene, id, markers, BELT_MAX_VISIBLE),
      id,
      createPlayerParts(PLAYER_MAX_HP),
    );
    this.throttle = new Throttle(notifier, saved?.throttle);
    this.effects = effects;
    this.fire = new FireControl(this, notifier, worldSfx, scene, fx, 'saved' in init ? { saved: init.saved.fire } : { ammo: init.ammo });
    this.altitudeAlarm = new AltitudeAlarm(notifier, worldSfx);
    this.boosters = new AttachedBoosters(
      this.motion, this.motion.attachedBoosters, notifier, worldSfx, scene, fx,
    );

    if (saved) {
      // 現行のモードでない planExecution は、保存形の followPlan(boolean)から読み替える。
      this.planExecution = saved.planExecution === 'off' || saved.planExecution === 'instant'
        ? saved.planExecution
        : (saved.followPlan ? 'instant' : 'off');
      this.fineAttitude = saved.fineAttitude ?? false;
      this.trajectoryLineVisible = saved.showTrajectoryLine ?? false;
      if (Array.isArray(saved.parts)) {
        const restoredParts = saved.parts.map(partFromSaveData).filter((part) => part !== null);
        // 部品が壊れているスナップショットは、初期部品を残して船体を空にしない。
        if (restoredParts.length > 0) {
          this.replaceParts(restoredParts);
        }
      }

      if (saved.plan) {
        // 計画を保存時の起点から組み直す。起点より前のノードは復元できない。
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
        if (rejected > 0) notifier.hint(`${this.name}: 起点より前のマニューバノード ${rejected} 件を復元できません`);
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
  public get roundsInMag(): number { return this.fire.rounds; }
  public get magsLeft(): number { return this.fire.mags; }
  public get reloadTimer(): number { return this.fire.cooldown; }

  public statusSnapshot(): PlayerStatusSnapshot {
    return {
      throttleIdx: this.throttle.throttleIdx,
      rcsDamp: this.throttle.rcsDamp,
      progradeHold: this.throttle.progradeHold,
      fineAttitude: this.fineAttitude,
      totalFuel: this.totalFuel,
      totalMaxFuel: this.totalMaxFuel,
      aero: { qdyn: this.motion.aero.qdyn },
      power: {
        chargeJ: this.motion.power.chargeJ,
        deploy: { up: this.motion.power.deployOf('up'), down: this.motion.power.deployOf('down') },
      },
      radiator: {
        up: { deploy: this.motion.radiator.deployOf('up'), wear: this.motion.radiator.wearOf('up') },
        down: { deploy: this.motion.radiator.deployOf('down'), wear: this.motion.radiator.wearOf('down') },
      },
      fire: { rounds: this.fire.rounds, mags: this.fire.mags, cooldown: this.fire.cooldown },
    };
  }

  // 弾薬ピックアップで得たマグ数を加算する。
  public onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  // 毎フレーム、全ての自機に対して1度だけ呼ぶ。input が null の艦は、このフレーム操作されない
  // 艦として畳む。
  public updateControls(frame: PilotCommandFrame): void {
    const { input, dt, simDt, registry, activeStage, celestialBodies } = frame;
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
  public clearTransientCommands(): void {
    this.motion.thrust = null;
    this.motion.attachedBoosters.clearThrust();
    this.motion.torque = v3();
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }

  // 姿勢微調整モードの ON/OFF を切り替える。
  private toggleFineAttitude(): void {
    this.fineAttitude = !this.fineAttitude;
    this.notifier.hint(`姿勢微調整モード: ${this.fineAttitude ? 'ON' : 'OFF'}`);
  }

  // 自機側のキー(RCS減衰・プログレード・スロットル等)を1フレーム分消費する。
  private handleEdgeInput(input: Input, registry: EntityRegistry): void {
    input.takeKeys((code) => this.handleEdgePress(code, registry));
  }

  // 自機側キー1個を処理する。処理したキーは true を返し input.takeKeys に消費させる。
  private handleEdgePress(code: string, registry: EntityRegistry): boolean {
    // キーごとに姿勢・スロットル・ブースター・放熱板・太陽電池・装填の各系へ振り分ける
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
    outcome: DamageOutcomeSink, registry: EntityRegistry,
    side: RadiatorSide | null = null,
  ): void {
    // 熱とダメージを入れ、放熱板パーツが壊れたらその場で破片を出す
    this.motion.absorbHeat(BULLET_IMPACT_HEAT / Math.max(this.motion.mass, 1e-9));
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    this.applyDamageToParts(side === null ? damage : RADIATOR_BULLET_DAMAGE, damagedPart);
    if (side !== null && damagedPart && damagedPart.hp <= 0) {
      const tip = this.motion.radiator.tipWorldPosition(side, this.motion.state.r, this.motion.att);
      this.effects.radiatorBreak(side, this.motion.state, tip, registry);
    }
    if (this.hp > 0) {
      this.effects.impact(bulletType, this.motion.state, impactPoint);
      return;
    }

    // HP が尽きたら喪失させる
    this.motion.alive = false;
    const reason = shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    outcome.playerLost(reason);
    this.effects.destroy(this.motion.state, registry);
  }

  // 他の動体との接触の帰結。弾なら武装のダメージを、それ以外は接近速度と相手の種別を根拠に
  // 無作為なパーツへダメージを入れる(ゲームバランスの量)。
  private receiveEntityContact(
    other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    if (!this.motion.alive) return;

    // 弾の命中
    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(
        bullet.type, bullet.shooter, bullet.damage, contact.point,
        this.outcomeOf(services), services.registry,
      );
      return;
    }

    // 弾以外との衝突
    this.damagedByContact(
      contactDamageSpeed(other, contact), null, '高速接触により機体を喪失した',
      this.outcomeOf(services), services.registry,
    );
  }

  // 天体の固体表面への接触。相手の種別による重みが無いので接近速度がそのまま根拠になる。
  private receiveSurfaceContact(contact: Contact, services: DynamicReactionServices): void {
    if (!this.motion.alive) return;
    this.damagedByContact(
      closingSpeed(contact), null, '天体の地表へ到達し機体は失われた',
      this.outcomeOf(services), services.registry,
    );
  }

  // 放熱板の接触代理(RadiatorFold)からの帰結。ダメージは side の放熱板パーツへ入る。
  private receiveRadiatorContact(
    side: RadiatorSide, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    if (!this.motion.alive) return;

    // 弾の命中
    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(
        bullet.type, bullet.shooter, bullet.damage, contact.point,
        this.outcomeOf(services), services.registry, side,
      );
      return;
    }

    // 弾以外との衝突
    this.damagedByContact(
      contactDamageSpeed(other, contact), side, '高速接触により機体を喪失した',
      this.outcomeOf(services), services.registry,
    );
  }

  // 接触によるダメージ・致死判定。side を指定するとその放熱板パーツへ、無指定なら無作為な
  // パーツへダメージが入る。
  private damagedByContact(
    damageSpeed: number, side: RadiatorSide | null, lossReason: string, outcome: DamageOutcomeSink,
    registry: EntityRegistry,
  ): void {
    // ダメージを入れ、放熱板パーツが壊れたらその場で破片を出す
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    if (!this.applyCollisionDamage(damageSpeed, damagedPart)) return;
    if (side !== null && damagedPart && damagedPart.hp <= 0) {
      const tip = this.motion.radiator.tipWorldPosition(side, this.motion.state.r, this.motion.att);
      this.effects.radiatorBreak(side, this.motion.state, tip, registry);
    }
    if (this.hp > 0) {
      this.effects.contact(this.motion.state);
      return;
    }

    // HP が尽きたら喪失させる
    this.motion.alive = false;
    outcome.playerLost(lossReason);
    this.effects.destroy(this.motion.state, registry);
  }

  // 動圧が構造限界を超えたことによる喪失。
  private receiveStructuralLoss(services: DynamicReactionServices): void {
    if (!this.motion.alive) return;
    this.lose(
      '動圧が構造限界を超え、機体は空力的に分解した',
      this.outcomeOf(services), services.registry,
    );
  }

  // 外殻の温度が上限を超えたときの喪失。理由は、そこで空力加熱が効いていたかで分ける。
  private receiveBurnUp(services: DynamicReactionServices): void {
    this.lose(
      this.motion.aero.heatingAerodynamically
        ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
        : '排熱が追いつかず、機体は熱で機能不全に陥った',
      this.outcomeOf(services), services.registry,
    );
  }

  // 喪失の共通処理。reason はステージの記録に残す喪失理由。
  private lose(reason: string, outcome: DamageOutcomeSink, registry: EntityRegistry): void {
    this.motion.alive = false;
    this.effects.destroy(this.motion.state, registry);
    outcome.playerLost(reason);
  }

  private outcomeOf(services: DynamicReactionServices): DamageOutcomeSink {
    return { playerLost: reason => services.activeStage.recordPlayerLost(reason) };
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
      () => this.notifier.hint('進行方向ホールド解除(手動操作)'),
    );
  }

  // 艦は任意のタイミングで削除されうるので、一度だけ連続指令と View を解放する。
  private disposed: boolean = false;

  // 画面マーカーと被選択判定が同じ艦を指すためのキー。
  private get markerKey(): string { return `player-${this.id}`; }

  // 画面マーカー・一覧に出すこの艦の項目。isActive はマップ上で自艦と僚艦を塗り分ける
  // ための操作対象フラグ。
  public markerItem(viewerPos: Vec3, pos: Vec3, vel: Vec3, view: ViewMode, isActive: boolean): GroupedMarkerItem {
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
      // 画面外の方位マーカーは ALLY_BEARING_MAX_DISTANCE 以内の艦にだけ出す
      bearingColor: COLOR_MARKER_ALLY,
      bearingSym: DIRECTION_GLYPH.allyBearing,
      bearingClass: 'mk-dir mk-ally-dir',
      bearingVisible: dist <= ALLY_BEARING_MAX_DISTANCE,
      color: isActive ? 'var(--color-primary)' : COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  // 自機の View が読む値を、共通の表示入力へ足す。可動部と噴射は Motion の現在値、
  // マーカーの弾数と初速は装備の現在値から、このフレームぶんだけを組む。
  protected override renderSource(
    viewFrame: DynamicViewFrame, visible: boolean, active: boolean,
    orbitReference: OrbitReference | undefined,
  ): PlayerRenderSource {
    const motion = this.motion;
    const { attachedBoosters: boosters, belt, power, radiator } = motion;
    // 指令の有無は加速度の大きさで決まるので、噴射していないフレームは null として渡す。
    const thrustAcceleration = this.throttle.thrustAccelVec;
    const radiatorPanel = (side: RadiatorSide) => ({ wear: radiator.wearOf(side), ...radiator.foldThetas(side) });
    return {
      ...super.renderSource(viewFrame, visible, active, orbitReference),
      state: motion.state,
      active,
      thrustAcceleration: len(thrustAcceleration) > 0 ? thrustAcceleration : null,
      maximumAcceleration: motion.mass > 0 ? this.totalThrust / motion.mass : 0,
      torque: motion.torque,
      dynamicPressure: motion.aero.qdyn,
      boosters: {
        stageIds: boosters.stageIds,
        firing: boosters.thrust !== null,
        burnRatio: boosters.burnRatio,
      },
      belt: { anchor: belt.anchor, positions: belt.positions, twists: belt.twists },
      magsLeft: this.magsLeft,
      roundsInMag: this.roundsInMag,
      averageMuzzleVelocity: this.averageMuzzleVelocity,
      solar: { up: power.deployOf('up'), down: power.deployOf('down') },
      radiator: { up: radiatorPanel('up'), down: radiatorPanel('down') },
      orbitAxesReference: orbitReference?.state ?? null,
    };
  }

  // 自身に関するメッシュやエフェクトを解放する。
  public dispose(): void {
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
      // 運動状態
      r: { ...this.motion.state.r },
      v: { ...this.motion.state.v },
      q: { ...this.motion.att.q },
      w: { ...this.motion.att.w },
      // 下位系の状態
      fire: this.fire.serialize(),
      thermal: { hullTemp: this.motion.temperature },
      radiator: this.motion.radiator.serialize(),
      power: this.motion.power.serialize(),
      throttle: this.throttle.serialize(),
      parts: this.parts.map(p => ({ ...p })) as AnyPart[],
      // 操作・表示の設定と計画
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

  public rename(name: string): void { this.setName(name); }
}

// この個体が自機か。顔ぶれから自機だけを絞るときに使う。
export function isPlayer(entity: DynamicEntity): entity is Player {
  return entity instanceof Player;
}
