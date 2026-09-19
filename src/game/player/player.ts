import type * as THREE from 'three/webgpu';

import type { ViewMode } from '../view/view-mode';
import { type Attitude, deserializeAttitude } from '../../physics/attitude';
import { qFromBasis } from '../../math/quat';
import { type KinematicState, deserializeKinematicState } from '../../physics/kinematic-state';
import { type Vec3, add, v3, len, sub } from '../../math/vec3';
import { Ship } from '../dynamic/dynamic-entity/ship';
import { bulletReactionOf, type BulletType, type Shooter } from '../dynamic/dynamic-entity/bullet-reaction';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { DynamicEntity, SerializedDynamicEntityFields } from '../dynamic/dynamic-entity/dynamic-entity';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { closingSpeed, type Contact } from '../dynamic/dynamic-entity/contact';
import { generateRandomName } from '../random-name';
import { Throttle, type SerializedThrottle } from './throttle';
import { FireControl, type SerializedFireControl } from './fire-control';
import { WeaponState, type AmmoLoad } from './weapon-state';
import { AltitudeAlarm, type SerializedAltitudeAlarm } from './altitude-alarm';
import { BeltController, type SerializedBeltController } from './belt';
import { PlayerView, type PlayerRenderSource } from '../../render/dynamic/player/player-view';
import type { DynamicViewFrame } from '../../render/dynamic/dynamic-view';
import type { OrbitReference } from '../orbit-reference';
import type { RadiatorSide, SerializedRadiatorSystem } from './radiator';
import { DeployablePanelState } from './deployable-panel-state';
import { PowerSystem, type SerializedPowerSystem } from './power';
import { BoosterStack, type SerializedBoosterStack } from './booster-stack';

import { Plan, type PlanExecutionMode, type SerializedPlan } from '../plan/plan';
import {
  deserializeParts, type Part, type RadiatorPart, type AnyPart,
} from '../dynamic/dynamic-entity/parts';
import { DIRECTION_GLYPH, COLOR_MARKER_ALLY } from '../marker/marker-identity';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { contactDamageSpeed } from '../dynamic/dynamic-entity/contact-damage';
import { AttachedBoosters } from './attached-boosters';
import { frameOfCelestialBody, toFrameState } from '../../physics/frame';
import type { CelestialBody } from '../../physics/celestial-body';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { PilotCommand, PilotControls } from '../dynamic/dynamic-entity/pilot-controls';
import { PlayerMotion, type PlayerMotionReactions } from './player-motion';
import type { DynamicMotionThermal } from '../dynamic/dynamic-motion';
import type { EntityContactParticipant } from '../dynamic/dynamic-simulation-participant';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { StageOutcome } from '../stages/stage-outcome';
import type { StageRules } from '../stages/stage-rules';
import type { DamageOutcomeSink } from './damage-outcome';
import { PlayerInspection } from '../pickable/player-inspection';
import { PlayerEffects } from './player-effects';
import { createPlayerParts, PLAYER_INERTIA_PITCH, PLAYER_INERTIA_YAW, PLAYER_INERTIA_ROLL } from './player-loadout';
import type { PartDamageTarget } from '../dynamic/dynamic-entity/damage-capabilities';

export const PLAYER_HULL_RADIUS = 2.6; // 剛体接触(被弾判定を含む)に使う実寸に近い半径 [m]

// 展開中の放熱板に当たった1発が放熱板パーツへ与えるダメージ [HP]。薄く大きい構造物なので
// 船体への直撃(PLASMA_BULLET_DAMAGE)より軽い。
const RADIATOR_BULLET_DAMAGE = 0.25;

const BULLET_IMPACT_HEAT = 3.0e5; // 自機が被弾1発あたりに受ける熱量 [J]

const ALLY_BEARING_MAX_DISTANCE = 20e3; // 味方機の画面外方位マーカーを表示する上限距離 [m]

const PLAYER_MAX_HP = 1000; // 既定パーツ一式へ割り振る装甲値の合計 [HP]
const HP_REGEN_RATE = 1; // HP自動回復速度 [HP/s]


// 給弾ベルトの節点数。たわみ物理の鎖の長さと、表示するリンクメッシュの本数を揃える。
const BELT_MAX_VISIBLE = 18;

// 新規配置の艦。state に機首プログレードで置き、name/id/ammo は任意指定する。
export interface PlayerPlacement {
  readonly name?: string;
  readonly state: KinematicState;
  readonly id?: string;
  readonly ammo?: AmmoLoad;
}

export interface SerializedPlayer extends SerializedDynamicEntityFields {
  readonly kind: 'player';
  readonly name: string;
  readonly thermal: DynamicMotionThermal;
  readonly fire: SerializedFireControl;
  readonly radiator: SerializedRadiatorSystem;
  readonly power: SerializedPowerSystem;
  readonly belt: SerializedBeltController;
  readonly throttle: SerializedThrottle;
  readonly altitudeAlarm: SerializedAltitudeAlarm;
  readonly parts: AnyPart[];
  readonly plan: SerializedPlan | null;
  readonly planExecution: PlanExecutionMode;
  readonly fineAttitude: boolean;
  readonly boosters: SerializedBoosterStack;
}

// プレイヤー機: 操縦・射撃・ブースターなどの下位系を合成し、被弾・接触の帰結と直列化を持つ。
export class Player extends Ship implements Controllable, PartDamageTarget {
  public static readonly kind = 'player';
  public static spawnGate(): null { return null; }

  public override readonly mapKind: DynamicEntityKind = 'player';
  public override readonly controllable = true;
  public override readonly pickable = true;
  public readonly inspection = new PlayerInspection(this);
  public readonly objectPickable = this.inspection;
  // 除去の前に注視・操作対象の参照を次の艦へ引き継ぐ必要があるので、所有者側に回収させる。
  public override readonly reclaimedByOwner = true;

  public declare readonly motion: PlayerMotion;
  public readonly fire: FireControl;
  public readonly boosters: AttachedBoosters;
  private readonly effects: PlayerEffects;
  public override get parts(): readonly Part[] { return super.parts; }

  // registry は出来事と生んだ実体を積む先。name は表示名、id は採番器が配った識別子、state と
  // attitude は運動状態。weapon から後ろは下位系の状態・生死・部品で、省いたものは新しく作ったときの
  // 状態で始める。plan はこの艦自身のマニューバ計画。
  private constructor(
    private readonly registry: EntityRegistry,
    scene: THREE.Scene,
    name: string,
    id: string,
    state: KinematicState,
    attitude: Attitude,
    weapon?: WeaponState,
    thermal?: DynamicMotionThermal,
    alive?: boolean,
    radiatorUp?: DeployablePanelState,
    radiatorDown?: DeployablePanelState,
    power?: PowerSystem,
    boosters?: BoosterStack,
    belt?: BeltController,
    public readonly throttle = new Throttle(),
    public readonly altitudeAlarm = new AltitudeAlarm(registry.events),
    parts: readonly Part[] = createPlayerParts(PLAYER_MAX_HP),
    public readonly plan = Plan.create(),
    private _planExecution: PlanExecutionMode = 'instant',
    private _fineAttitude = false,
  ) {
    // Motion が読む値と、接触・喪失の通知先をこの艦へ結ぶ
    const reactions = (owner: Player): PlayerMotionReactions => ({
      weapon: {
        roundsInMagazine: () => owner.fire.rounds,
        stepBarrelThermal: dt => owner.fire.stepBarrelThermal(dt),
      },
      environment: {
        thrustAcceleration: () => owner.throttle.thrust ?? v3(),
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
        receiveEntityContact: (other, contact, activeStage) => (
          owner.receiveEntityContact(other, contact, activeStage)
        ),
        receiveRadiatorContact: (side, other, contact, activeStage) => (
          owner.receiveRadiatorContact(side, other, contact, activeStage)
        ),
        receiveSurfaceContact: (contact, activeStage) => owner.receiveSurfaceContact(contact, activeStage),
      },
      loss: {
        receiveStructuralLoss: activeStage => owner.receiveStructuralLoss(activeStage),
        receiveBurnUp: activeStage => owner.receiveBurnUp(activeStage),
      },
    });
    // 運動・表示・部品を組んでから、この艦を参照する下位系を組む
    super(
      name,
      PLAYER_MAX_HP,
      owner => new PlayerMotion(
        state,
        attitude,
        PLAYER_HULL_RADIUS,
        BELT_MAX_VISIBLE,
        reactions(owner as Player),
        thermal,
        alive,
        radiatorUp,
        radiatorDown,
        power,
        boosters,
        belt,
      ),
      new PlayerView(scene, id, BELT_MAX_VISIBLE),
      id,
      parts,
    );
    this.effects = new PlayerEffects(registry);
    this.fire = new FireControl(this, registry, scene, weapon);
    this.boosters = new AttachedBoosters(this.motion, this.motion.attachedBoosters, registry, scene);
  }

  // placement に新しく置く。機首は center に対する速度の向き、上面は center から見た位置の向き。
  // name を省くと無作為な名前になる。id を省くと name がそのまま艦の識別子になるので、複数隻を
  // 並べるなら name も分ける。
  public static create(
    placement: PlayerPlacement,
    center: CelestialBody,
    registry: EntityRegistry,
    scene: THREE.Scene,
  ): Player {
    const name = placement.name ?? generateRandomName('player');
    return new Player(
      registry, scene, name, registry.idAllocators.entity.next(placement.id ?? name),
      placement.state, Player.progradeAttitude(placement.state, center),
      placement.ammo ? WeaponState.create(placement.ammo) : undefined,
    );
  }

  // 直列化した艦を復元する。計画のうち起点より前のノードは戻せないので、その数を registry の出来事へ
  // 記録する。
  public static deserialize(
    serialized: SerializedPlayer,
    registry: EntityRegistry,
    scene: THREE.Scene,
  ): Player {
    const { radiator, plan, belt, altitudeAlarm } = serialized;
    const player = new Player(
      registry, scene,
      serialized.name || serialized.id,
      registry.idAllocators.entity.next(serialized.id),
      deserializeKinematicState(serialized),
      deserializeAttitude(serialized, Player.INERTIA),
      serialized.fire ? WeaponState.deserialize(serialized.fire) : undefined,
      // null も欠けと同じく既定へ落とす(既定引数は undefined でしか働かない)。
      serialized.thermal ?? undefined,
      serialized.alive,
      (radiator?.up && DeployablePanelState.deserialize(radiator.up)) ?? undefined,
      (radiator?.down && DeployablePanelState.deserialize(radiator.down)) ?? undefined,
      serialized.power ? PowerSystem.deserialize(serialized.power) : undefined,
      serialized.boosters ? BoosterStack.deserialize(serialized.boosters) : undefined,
      belt ? BeltController.deserialize(belt) : undefined,
      serialized.throttle ? Throttle.deserialize(serialized.throttle) : undefined,
      altitudeAlarm ? AltitudeAlarm.deserialize(altitudeAlarm, registry.events) : undefined,
      deserializeParts(serialized.parts),
      plan ? Plan.deserialize(plan) : undefined,
      // 記録に無い計画の実行は、新しく作ったときと違って止めておく。
      serialized.planExecution ?? 'off',
      serialized.fineAttitude ?? undefined,
    );
    const dropped = plan ? Plan.droppedNodeCount(plan) : 0;
    if (dropped > 0) registry.events.record({ kind: 'planNodesDropped', ship: player.name, count: dropped });
    return player;
  }

  // 自機の主慣性モーメント(ピッチ・ヨー・ロール)。
  private static readonly INERTIA = v3(PLAYER_INERTIA_PITCH, PLAYER_INERTIA_YAW, PLAYER_INERTIA_ROLL);

  // 機首を center に対する速度の向きへ、上面を center から見た位置の向きへ向けた静止姿勢。
  private static progradeAttitude(state: KinematicState, center: CelestialBody): Attitude {
    const rel = toFrameState(frameOfCelestialBody(center, state.t), state);
    return {
      q: qFromBasis(rel.v, rel.r),
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

  // 弾薬ピックアップで得たマグ数を加算する。
  public onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  // 毎フレーム、全ての自機に対して1度だけ呼ぶ。controls はこのフレームの操作量で、null の艦は
  // 操作されない艦として畳む。dt [s] は実時間、simDt [sim s] はシミュレーション時間の刻み。
  public updateControls(
    controls: PilotControls | null, dt: number, simDt: number,
    activeStage: StageOutcome, stageRules: StageRules, celestialBodies: CelestialBodies,
  ): void {
    if (stageRules.selfRepair) this.hpRegen(dt);
    // ブースターの燃焼は操作の可否によらず進むので、指令を畳んだあとに進める。
    if (controls === null) {
      this.clearTransientCommands();
      this.motion.attachedBoosters.step(simDt);
      this.motion.setThrust(this.motion.attachedBoosters.thrust);
      return;
    }
    this.motion.attachedBoosters.step(simDt);
    this.updateTorque(controls, dt, simDt);

    this.fire.updateFireState(dt, controls, activeStage, celestialBodies);

    this.throttle.updateThrustLatches(controls);
    this.throttle.updateThrustState(controls, this.motion.att, simDt, this);
    const rcsThrust = this.throttle.thrust;
    const boosterThrust = this.motion.attachedBoosters.thrust;
    this.motion.setThrust(rcsThrust && boosterThrust
      ? add(rcsThrust, boosterThrust)
      : rcsThrust ?? boosterThrust);
  }

  // 次のフレームへ持ち越してはならない連続指令(推力・トルク・射撃)を畳む。角速度による
  // coast はそのまま続く。
  public clearTransientCommands(): void {
    this.motion.setThrust(null);
    this.motion.attachedBoosters.clearThrust();
    this.motion.setTorque(v3());
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }

  // 受け付けた単発の命令を自機の状態へ適用する。
  public handleCommand(command: PilotCommand): void {
    const events = this.registry.events;
    switch (command.kind) {
      // 操縦の設定
      case 'thrustLatchToggle': this.throttle.toggleThrustLatch(command.direction); return;
      case 'rcsDampToggle': this.throttle.toggleRcsDamp(events); return;
      case 'progradeReset': this.throttle.enableProgradeReset(events); return;
      case 'fineAttitudeToggle': this.toggleFineAttitude(); return;
      case 'progradeHoldToggle': this.throttle.toggleProgradeHold(events); return;
      case 'throttleLow': this.throttle.setThrottlePreset(0, events); return;
      case 'throttleMid': this.throttle.setThrottlePreset(1, events); return;
      case 'throttleHigh': this.throttle.setThrottlePreset(2, events); return;
      case 'throttleMax': this.throttle.setThrottlePreset(3, events); return;
      // 装備の操作
      case 'boosterDecouple': this.boosters.decouple(); return;
      case 'boosterIgnitionToggle': this.boosters.toggleIgnition(); return;
      case 'radiatorDeployLeft': this.motion.radiator.toggle('up'); return;
      case 'radiatorDeployRight': this.motion.radiator.toggle('down'); return;
      case 'solarDeployLeft': this.motion.power.toggle('up'); return;
      case 'solarDeployRight': this.motion.power.toggle('down'); return;
      case 'reload': this.fire.manualReload(); return;
    }
  }

  // 計画の実行方法。
  public get planExecution(): PlanExecutionMode { return this._planExecution; }
  // 姿勢微調整モードか。
  public get fineAttitude(): boolean { return this._fineAttitude; }

  // 計画の実行方法を mode へ切り替える。
  public setPlanExecution(mode: PlanExecutionMode): void {
    this._planExecution = mode;
  }

  // 計画を 'instant' で実行しているとき、次に消化するノードの時刻。それ以外や、待っているノードが
  // 無ければ null。
  public get instantNodeTime(): number | null {
    if (this._planExecution !== 'instant') return null;
    return this.plan.firstNode()?.t ?? null;
  }

  // 計画を 'instant' で実行しているとき、時刻 simTime までに来たノードを消化し、消化した最後のノードの
  // 絶対状態へそのまま乗り移る(誤差が無い)。
  public executeInstantNodesUpTo(simTime: number): void {
    if (this._planExecution !== 'instant') return;
    const first = this.plan.firstNode();
    if (!first || first.t > simTime + 1e-9) return;
    // ノードは実行時刻順に並ぶので、来たもののうち最後が到達状態になる。
    const due = this.plan.nodes.filter((node) => node.t <= simTime);
    const reached = due[due.length - 1];
    if (reached === undefined) return;
    this.plan.consumeNodesUpTo(simTime, reached);
    this.motion.reset(reached);
  }

  // 姿勢微調整モードの ON/OFF を切り替える。
  private toggleFineAttitude(): void {
    this._fineAttitude = !this._fineAttitude;
    this.registry.events.record({ kind: 'fineAttitudeToggled', on: this._fineAttitude });
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
    outcome: DamageOutcomeSink,
    side: RadiatorSide | null = null,
  ): void {
    // 熱とダメージを入れ、放熱板パーツが壊れたらその場で破片を出す
    this.motion.absorbHeat(BULLET_IMPACT_HEAT / Math.max(this.motion.mass, 1e-9));
    this.applyDamageToParts(side === null ? damage : RADIATOR_BULLET_DAMAGE, this.radiatorPartOf(side));
    this.scatterBrokenRadiator(side);
    if (this.hp > 0) {
      this.effects.impact(bulletType, this.motion.state, impactPoint);
      return;
    }

    // HP が尽きたら喪失させる
    this.motion.kill();
    const reason = shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    outcome.playerLost(reason);
    this.effects.destroy(this.motion.state);
  }

  // 他の動体との接触の帰結。弾なら武装のダメージを、それ以外は接近速度と相手の種別を根拠に
  // 無作為なパーツへダメージを入れる(ゲームバランスの量)。
  private receiveEntityContact(other: EntityContactParticipant, contact: Contact, activeStage: StageOutcome): void {
    if (!this.motion.alive) return;

    // 弾の命中
    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(
        bullet.type, bullet.shooter, bullet.damage, contact.point, this.outcomeOf(activeStage),
      );
      return;
    }

    // 弾以外との衝突
    this.damagedByContact(
      contactDamageSpeed(other, contact), null, '高速接触により機体を喪失した', this.outcomeOf(activeStage),
    );
  }

  // 天体の固体表面への接触。相手の種別による重みが無いので接近速度がそのまま根拠になる。
  private receiveSurfaceContact(contact: Contact, activeStage: StageOutcome): void {
    if (!this.motion.alive) return;
    this.damagedByContact(
      closingSpeed(contact), null, '天体の地表へ到達し機体は失われた', this.outcomeOf(activeStage),
    );
  }

  // 放熱板の接触代理からの帰結。ダメージは side の放熱板パーツへ入る。
  private receiveRadiatorContact(
    side: RadiatorSide, other: EntityContactParticipant, contact: Contact, activeStage: StageOutcome,
  ): void {
    if (!this.motion.alive) return;

    // 弾の命中
    const bullet = bulletReactionOf(other);
    if (bullet !== null) {
      this.attackedByBullet(
        bullet.type, bullet.shooter, bullet.damage, contact.point, this.outcomeOf(activeStage), side,
      );
      return;
    }

    // 弾以外との衝突
    this.damagedByContact(
      contactDamageSpeed(other, contact), side, '高速接触により機体を喪失した', this.outcomeOf(activeStage),
    );
  }

  // 接触によるダメージ・致死判定。side を指定するとその放熱板パーツへ、無指定なら無作為な
  // パーツへダメージが入る。
  private damagedByContact(
    damageSpeed: number, side: RadiatorSide | null, lossReason: string, outcome: DamageOutcomeSink,
  ): void {
    // ダメージを入れ、放熱板パーツが壊れたらその場で破片を出す
    if (!this.applyCollisionDamage(damageSpeed, this.radiatorPartOf(side))) return;
    this.scatterBrokenRadiator(side);
    if (this.hp > 0) {
      this.effects.contact(this.motion.state);
      return;
    }

    // HP が尽きたら喪失させる
    this.motion.kill();
    outcome.playerLost(lossReason);
    this.effects.destroy(this.motion.state);
  }

  // side の放熱板パーツ。side が null(船体)か、パーツが欠けていれば undefined。
  private radiatorPartOf(side: RadiatorSide | null): RadiatorPart | undefined {
    return side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
  }

  // side の放熱板パーツが全損していれば、そのパネル先端から破片を出す。
  private scatterBrokenRadiator(side: RadiatorSide | null): void {
    const part = this.radiatorPartOf(side);
    if (side === null || !part || part.hp > 0) return;
    const tip = this.motion.radiator.tipWorldPosition(side, this.motion.state.r, this.motion.att);
    this.effects.radiatorBreak(this.motion.state, tip);
  }

  // 動圧が構造限界を超えたことによる喪失。
  private receiveStructuralLoss(activeStage: StageOutcome): void {
    if (!this.motion.alive) return;
    this.lose('動圧が構造限界を超え、機体は空力的に分解した', this.outcomeOf(activeStage));
  }

  // 外殻の温度が上限を超えたときの喪失。理由は、そこで空力加熱が効いていたかで分ける。
  private receiveBurnUp(activeStage: StageOutcome): void {
    this.lose(
      this.motion.aero.heatingAerodynamically
        ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
        : '排熱が追いつかず、機体は熱で機能不全に陥った',
      this.outcomeOf(activeStage),
    );
  }

  // 喪失の共通処理。reason はステージの記録に残す喪失理由。
  private lose(reason: string, outcome: DamageOutcomeSink): void {
    this.motion.kill();
    this.effects.destroy(this.motion.state);
    outcome.playerLost(reason);
  }

  // 機体の喪失を activeStage の記録へ届ける通知先。
  private outcomeOf(activeStage: StageOutcome): DamageOutcomeSink {
    return { playerLost: reason => activeStage.recordPlayerLost(reason) };
  }

  // 操作量から機体座標系トルクを求めて Motion へ反映し、角速度をクランプする。
  private updateTorque(controls: PilotControls, dt: number, simDt: number): void {
    // 発砲中は姿勢微調整と同じ操作精度になる
    const fine = this._fineAttitude || this.fire.isFiring;
    this.throttle.updateTorque(
      this.motion.att,
      this.motion.state.r,
      this.motion.state.v,
      controls,
      fine,
      dt,
      simDt,
      this,
      this.registry.events,
    );
    this.motion.setTorque(this.throttle.torque);
  }

  // 艦は任意のタイミングで削除されうるので、一度だけ連続指令と View を解放する。
  private disposed: boolean = false;

  // 画面マーカーと被選択判定が同じ艦を指すためのキー。
  private get markerKey(): string { return `player-${this.id}`; }

  // 画面マーカー・一覧に出すこの艦の項目。isActive はマップ上で自艦と僚艦を塗り分ける
  // ための操作対象フラグ。
  public markerItem(viewerPos: Vec3 | null, pos: Vec3, vel: Vec3, view: ViewMode, isActive: boolean): GroupedMarkerItem {
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: isActive ? 'mk-self' : 'mk-ally',
      sym: view === 'map' ? this.headingHpMarkerSvg() : this.hpMarkerSvg(),
      pos,
      vel,
      priority: MARKER_PRIORITY.PLAYER,
      name: this.name,
      // 画面外の方位マーカーは、視点から ALLY_BEARING_MAX_DISTANCE 以内の艦にだけ出す
      bearing: {
        cls: 'mk-dir mk-ally-dir', sym: DIRECTION_GLYPH.allyBearing, color: COLOR_MARKER_ALLY,
        visible: viewerPos !== null && len(sub(pos, viewerPos)) <= ALLY_BEARING_MAX_DISTANCE,
        clustered: true,
      },
      color: isActive ? 'var(--color-primary)' : COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  // 自機の View が読む値を、このフレームの Motion と装備の現在値から組み、共通の表示入力へ足す。
  protected override renderSource(
    viewFrame: DynamicViewFrame, active: boolean, orbitReference: OrbitReference | undefined,
  ): PlayerRenderSource {
    const motion = this.motion;
    const { attachedBoosters: boosters, belt, power, radiator } = motion;
    const radiatorPanel = (side: RadiatorSide) => ({ wear: radiator.wearOf(side), ...radiator.foldThetas(side) });
    return {
      ...super.renderSource(viewFrame, active, orbitReference),
      state: motion.state,
      active,
      // 噴射と空力の表現
      thrustAcceleration: this.throttle.thrust,
      maximumAcceleration: motion.mass > 0 ? this.totalThrust / motion.mass : 0,
      torque: motion.torque,
      dynamicPressure: motion.aero.qdyn,
      // 可動部と装備
      boosters: {
        stageIds: boosters.stageIds,
        firing: boosters.thrust !== null,
        burnRatio: boosters.burnRatio,
      },
      belt: { anchor: belt.anchor, positions: belt.positions, twists: belt.twists },
      magsLeft: this.magsLeft,
      solar: { up: power.deployOf('up'), down: power.deployOf('down') },
      radiator: { up: radiatorPanel('up'), down: radiatorPanel('down') },
    };
  }

  // 自身に関するメッシュやエフェクトを解放する。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTransientCommands();
    super.dispose();
  }

  // 現在の艦状態を直列化した形へ変換する。
  // 例外(ARCHITECTURE R12): 運動の部品(放熱板・電力・給弾ベルト・ブースター)の記録を、自機の記録へ
  // 並べる。運動の記録として分けると保存の形式が変わり、版 4 の記録が読めなくなる。
  public override serialize(): SerializedPlayer {
    return {
      ...this.serializeEntityFields(Player.kind),
      name: this.name,
      thermal: this.motion.thermal,
      // 下位系の状態
      fire: this.fire.serialize(),
      radiator: this.motion.radiator.serialize(),
      power: this.motion.power.serialize(),
      belt: this.motion.belt.serialize(),
      throttle: this.throttle.serialize(),
      altitudeAlarm: this.altitudeAlarm.serialize(),
      parts: this.serializeParts(),
      // 操作の設定と計画
      planExecution: this._planExecution,
      fineAttitude: this._fineAttitude,
      plan: this.plan.serialize(),
      boosters: this.motion.attachedBoosters.serialize(),
    };
  }

  public rename(name: string): void { this.setName(name); }
}

// entity を自機へ絞り込む型ガード。
export function isPlayer(entity: DynamicEntity): entity is Player {
  return entity instanceof Player;
}
