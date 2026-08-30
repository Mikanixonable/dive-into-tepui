import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp, qRotate } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../celestial/solar-system/constants';
import { Vec3, add, scale, v3, len, sub } from '../../math/vec3';
import { fmtMarkerDist } from '../hud/utils';
import { FloatingOrigin } from '../camera/floating-origin';
import * as C from '../const';
import { Ship } from '../dynamic/dynamic-entity/ship';
import { Bullet } from '../dynamic/dynamic-entity/bullet';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import { closingSpeed, type Contact } from '../dynamic/dynamic-entity/contact';
import { contactDamageSpeed } from '../dynamic/dynamic-entity/contact-damage';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { buildPlayerShip } from '../../render/ships';
import { CelestialBody } from '../../physics/celestial-body';
import type { CameraSystem } from '../camera/camera-system';
import type { RenderStyle } from '../../render/render-style';
import type { MapVisibility } from '../map/visibility-policy';
import { generateRandomName } from '../random-name';
import type { Stage } from '../stages/stage';
import { PlayerThrottle } from './player-throttle';
import { PlayerFire, type AmmoLoad } from './player-fire';
import { Belt } from './belt';
import { AeroLoad } from './aero-load';
import { AltitudeAlarm } from './altitude-alarm';
import { currentThemePalette } from '../theme';
import { EffectsSystem } from '../vfx/effects-system';
import { ThrustEffects } from './thrust-effects';
import { RcsEffects } from './rcs-effects';
import { ReentryEffects } from './reentry-effects';
import { PlayerMarkers } from './player-markers';
import type { OrbitReference } from '../orbit-reference';
import type { MarkerManager } from '../marker/marker-manager';
import { RadiatorSide, RadiatorSystem } from './radiator';
import { PowerSystem } from './power';
import type { CelestialSystem } from '../celestial/celestial-system';
import { Plan } from '../plan/plan';
import type { PlayerSaveData, PlanSaveData } from '../save/save-data';
import { partFromSaveData, type AnyPart } from '../dynamic/dynamic-entity/parts';
import { DIRECTION_GLYPH } from '../marker/marker-glyphs';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import {
  DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN, PLAYER_DESTROY_FRAG_COLOR,
} from '../../render/vfx-style';
import { BoosterStack, boosterAverageAcceleration, type BoosterStage } from './booster-stack';
import { nextBoosterId } from './booster-id';
import { boosterSeparationVelocities } from './booster-separation';
import { DetachedBooster } from '../dynamic/dynamic-entity/detached-booster';
import {
  BOOSTER_STAGE_DIMENSIONS,
  BoosterPlumeSet,
  buildBoosterStage,
  type BoosterStage as BoosterStageModel,
} from '../../render/booster';
import type { BurnManagementViewModel } from '../hud/panels/burn-management-panel';

// 艦首(+Z)の船体外側に置く単一の接続ポート。位置は姿勢から導出し、保存しない。
const SHIP_PORT_OFFSET = v3(0, 0, 3.0);

// 展開中の放熱板に当たった1発が放熱板パーツへ与えるダメージ [HP]。薄く大きい構造物なので
// 船体への直撃(PLAYER_BULLET_DAMAGE)より軽い。損耗はドックで修理するまで戻らない。
const RADIATOR_BULLET_DAMAGE = 0.25;

const BULLET_IMPACT_HEAT = 3.0e5; // 自機が被弾1発あたりに受ける熱量 [J]

// 分離式ブースターの標準段。自機 1,000 kg と並べたとき、1段あたりの乾燥+満載質量
// 1,000 kg、推力 0.6 MN で約 300 m/s² となるようにする。燃料 800 kg を 80 kg/s
// で燃やし切るので、通常のフレーム刻みでも十数秒の燃焼と最後の燃料切れを扱える。
const BOOSTER_DEFAULT_DRY_MASS = 200; // [kg]
const BOOSTER_DEFAULT_MAX_FUEL = 800; // [kg]
const BOOSTER_DEFAULT_THRUST = 6e5; // [N]
const BOOSTER_DEFAULT_FUEL_RATE = 80; // [kg/s]
const BOOSTER_MAX_ATTACHED = 4;
const BOOSTER_MOUNT_Z = -4.0; // 船体中心から最初の段の前端まで [m]
const BOOSTER_SEPARATION_SPEED = 8; // 爆砕ボルトによる相対分離速度 [m/s]
const BOOSTER_COLLISION_GRACE = 0.5; // 分離直後に接続面同士が再衝突しない猶予 [s]

const ALLY_BEARING_MAX_DISTANCE = 20e3; // 味方機の画面外方位マーカーを表示する上限距離 [m]

const PLAYER_MAX_HP = 1000;
const HP_REGEN_RATE = 1; // HP自動回復速度 [HP/s]

// 'off': ノードを消化しない。'instant': ノード時刻ちょうどで絶対状態へ乗り移る(自動実行)。
export type PlanExecutionMode = 'off' | 'instant';

const PLAN_EXECUTION_LABELS: Record<PlanExecutionMode, string> = { off: 'OFF', instant: '自動実行' };

// mode の表示ラベル(HUDのメニュー項目・プロパティ行が共有する)。
export function planExecutionLabel(mode: PlanExecutionMode): string {
  return PLAN_EXECUTION_LABELS[mode];
}

// 新規配置は name/state/id/ammo を任意指定し、省略時は高度 INITIAL_ALT・傾斜 INITIAL_INC_DEG の
// 円軌道に機首プログレードで初期配置する。スナップショットからの再開は saved を simTime 付きの
// 状態として展開する。
export type PlayerInit =
  | { readonly name?: string; readonly state?: KinematicState; readonly id?: string; readonly ammo?: AmmoLoad }
  | { readonly saved: PlayerSaveData; readonly simTime: number };

// プレイヤー機: 移動(PlayerThrottle)と射撃(PlayerFire)を束ね、その両方を反映した
// 見た目(モデル・エフェクトメッシュの管理と毎フレーム更新)を持つ。
export class Player extends Ship {
  readonly throttle: PlayerThrottle;
  readonly fire: PlayerFire;
  readonly belt: Belt;
  readonly aero: AeroLoad;
  readonly altitudeAlarm: AltitudeAlarm;
  readonly radiator: RadiatorSystem;
  readonly power: PowerSystem;
  readonly boosters: BoosterStack;

  private readonly thrustEffects: ThrustEffects;
  private readonly boosterPlumes: BoosterPlumeSet;
  private readonly boosterModels: BoosterStageModel[] = [];
  private rcsThrust: Vec3 | null = null;
  private boosterThrust: Vec3 | null = null;
  private lastBoosterBurnRatio = 0;
  private readonly rcsEffects: RcsEffects;
  private readonly reentryEffects: ReentryEffects;
  private readonly markers: PlayerMarkers;
  // この艦自身のマニューバ計画。PlanEditor はアクティブ艦のこれを編集する。
  readonly plan = new Plan();
  planExecution: PlanExecutionMode = 'instant';

  private readonly _hud: Hud;
  private readonly _worldSfx: WorldSfx;
  private readonly _fx: EffectsSystem;
  private readonly playerScene: THREE.Scene;

  fineAttitude = false;

  // init 省略時は名前 'PLAYER'・既定軌道の新規艦になる。複数隻を並べるときは name/state を
  // 指定して区別する(name が艦の識別子になる)。
  constructor(
    _hud: Hud, _worldSfx: WorldSfx, _scene: THREE.Scene, _fx: EffectsSystem, markerManager: MarkerManager,
    init: PlayerInit = {},
  ) {
    const name = 'saved' in init ? (init.saved.name || init.saved.id) : (init.name ?? generateRandomName('player'));
    const state = 'saved' in init
      ? kinematicState(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z))
      : (init.state ?? Player.makeInitialState());
    const id = 'saved' in init ? init.saved.id : (init.id ?? name);
    const att: Attitude = 'saved' in init
      ? { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: Player.INERTIA }
      : Player.progradeAttitude(state);

    super(name, state, buildPlayerShip(), att, C.PLAYER_HULL_RADIUS, PLAYER_MAX_HP, _scene, id);
    this._hud = _hud;
    this._worldSfx = _worldSfx;
    this._fx = _fx;
    this.playerScene = _scene;
    this.mass = C.PLAYER_MASS;
    this.collides = true;
    this.doPreciseReentry = true;

    const saved = 'saved' in init ? init.saved : undefined;
    this.boosters = saved?.boosters
      ? BoosterStack.importData(saved.boosters)
      : new BoosterStack();
    for (const stage of this.boosters.stages) nextBoosterId(stage.id);
    this.throttle = new PlayerThrottle(_hud, saved?.throttle);
    this.fire = new PlayerFire(this, _hud, _worldSfx, _scene, _fx, 'saved' in init ? { saved: init.saved.fire } : { ammo: init.ammo });
    this.belt = new Belt(this.renderObject, this);
    this.aero = new AeroLoad();
    this.altitudeAlarm = new AltitudeAlarm(_hud, _worldSfx);
    this.temperature = saved?.thermal.hullTemp ?? C.HULL_START_TEMP;
    this.radiator = new RadiatorSystem(this.renderObject, this, saved?.radiator);
    this.power = new PowerSystem(this.renderObject, saved?.power);
    this.thrustEffects = new ThrustEffects(_scene, _worldSfx);
    this.boosterPlumes = new BoosterPlumeSet(_scene);
    this.rcsEffects = new RcsEffects(_scene, _worldSfx);
    this.reentryEffects = new ReentryEffects(_scene);
    this.markers = new PlayerMarkers(markerManager, this.id);
    this.rebuildBoosterModels();
    this.refreshBoosterMassAndInertia();

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
        // 保存された起点を addNode の from として与える。最初の1件が通った時点でその起点が
        // 凍結され、2件目以降は凍結済みの起点に対して判定される。
        const anchor = kinematicState(
          saved.plan.anchor.t,
          v3(saved.plan.anchor.r.x, saved.plan.anchor.r.y, saved.plan.anchor.r.z),
          v3(saved.plan.anchor.v.x, saved.plan.anchor.v.y, saved.plan.anchor.v.z),
        );
        let rejected = 0;
        for (const n of saved.plan.nodes) {
          const idx = this.plan.addNode(kinematicState(n.t, v3(n.r.x, n.r.y, n.r.z), v3(n.v.x, n.v.y, n.v.z)), anchor);
          if (idx < 0) rejected++;
        }
        if (rejected > 0) _hud.hint(`${this.name}: 起点より前のマニューバノード ${rejected} 件を復元できません`);
      }
    }
  }

  // 高度 INITIAL_ALT、傾斜角 INITIAL_INC_DEG の円軌道状態を返す。
  private static makeInitialState(): KinematicState {
    const r0 = R_EARTH + C.INITIAL_ALT;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const inc = (C.INITIAL_INC_DEG * Math.PI) / 180;
    return kinematicState(0, v3(r0, 0, 0), v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)));
  }

  // 3軸を非対称にし、中間軸(ピッチ)周りの回転にジャニベコフ効果(中間軸不安定性)が
  // 起こるようにする。ロール軸(機体前後方向)は細長い形状に見合って最小にする。
  private static readonly INERTIA = v3(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL);

  // state の速度方向を機首、位置方向を上として姿勢を組む。
  private static progradeAttitude(state: KinematicState): Attitude {
    return {
      q: qFromForwardUp(state.v, state.r) ?? { x: 0, y: 0, z: 0, w: 1 },
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
  get rcsDamp(): boolean { return this.throttle.rcsDamp; }
  get throttleIdx(): number { return this.throttle.throttleIdx; }
  get progradeHold(): boolean { return this.throttle.progradeHold; }

  get roundsInMag(): number { return this.fire.rounds; }
  get magsLeft(): number { return this.fire.mags; }
  get magsLeftInBarrel(): number { return this.fire.barrel; }
  get reloadTimer(): number { return this.fire.cooldown; }
  get isFiring(): boolean { return this.fire.isFiring; }

  // 機首(+Z)に固定された単一ドッキングポート。ポートは姿勢から毎回導出するため、
  // セーブデータへ新しい状態を追加しない。
  getPortWorldPos(): Vec3 {
    return add(this.state.r, qRotate(this.att.q, SHIP_PORT_OFFSET));
  }

  getPortWorldNormal(): Vec3 {
    return qRotate(this.att.q, v3(0, 0, 1));
  }

  // 弾薬ピックアップで得たマグ数を加算する。
  onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  // 弾薬を初期積載の状態まで満タンにする。
  refillAmmo(): void {
    this.fire.refillFull();
  }

  // 暫定の燃焼管理パネルから標準ブースターを最後尾へ追加する。
  attachBooster(): boolean {
    if (this.boosters.stages.length >= BOOSTER_MAX_ATTACHED) {
      this._hud.hint(`ブースターは最大 ${BOOSTER_MAX_ATTACHED} 段です`);
      return false;
    }
    const stage: BoosterStage = {
      id: nextBoosterId(),
      dryMass: BOOSTER_DEFAULT_DRY_MASS,
      fuel: BOOSTER_DEFAULT_MAX_FUEL,
      maxFuel: BOOSTER_DEFAULT_MAX_FUEL,
      thrust: BOOSTER_DEFAULT_THRUST,
      fuelRate: BOOSTER_DEFAULT_FUEL_RATE,
      ignited: false,
    };
    this.boosters.attach(stage);
    this.rebuildBoosterModels();
    this.refreshBoosterMassAndInertia();
    this.invalidatePrediction();
    this._hud.hint(`ブースターを追加: ${this.boosters.stages.length} 段`);
    return true;
  }

  toggleBoosterIgnition(): boolean {
    const active = this.activeBooster();
    if (!active) {
      this._hud.hint('点火できるブースターがありません');
      return false;
    }
    const ignited = this.boosters.toggleIgnition();
    this.invalidatePrediction();
    this._hud.hint(active.fuel <= 0
      ? '最後尾ブースターは燃料切れです'
      : `ブースター燃焼: ${ignited ? 'ON' : 'OFF'}`);
    return ignited;
  }

  // 最後尾の段だけを独立エンティティへ移し、爆砕ボルトの相対速度を質量比で配る。
  decoupleBooster(entities: DynamicSystem): boolean {
    const stageIndex = this.boosters.stages.length - 1;
    if (stageIndex < 0) {
      this._hud.hint('分離できるブースターがありません');
      return false;
    }
    const frontZ = BOOSTER_MOUNT_Z - stageIndex * BOOSTER_STAGE_DIMENSIONS.length;
    const centerZ = frontZ
      + (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;
    const jointR = add(this.state.r, qRotate(this.att.q, v3(0, 0, frontZ)));
    const boosterR = add(this.state.r, qRotate(this.att.q, v3(0, 0, centerZ)));
    const detachedStage = this.boosters.detachOutermost()!;
    const boosterMass = detachedStage.dryMass + detachedStage.fuel;
    this.refreshBoosterMassAndInertia();

    const forward = qRotate(this.att.q, v3(0, 0, 1));
    const separated = boosterSeparationVelocities(
      this.state.v,
      forward,
      this.mass,
      boosterMass,
      BOOSTER_SEPARATION_SPEED,
    );
    const t = this.state.t;
    this.state = kinematicState(t, this.state.r, separated.player);
    this._fx.spawnBoosterSeparation(t, jointR, separated.player, separated.booster, this.att);
    const detached = new DetachedBooster({
      stage: detachedStage,
      state: kinematicState(t, boosterR, separated.booster),
      att: {
        // 爆砕ボルトは中心軸上でトルクを与えない。姿勢モデルの inertia は操縦応答用の
        // 相対値で kg·m² ではないため、分離時は角速度をそのまま引き継ぐ。
        q: { ...this.att.q },
        w: { ...this.att.w },
        inertia: v3(1, 1, 0.4),
      },
      collisionEnableAt: t + BOOSTER_COLLISION_GRACE,
    }, this.playerScene);
    entities.addDetachedBooster(detached);

    this.boosterThrust = null;
    this.lastBoosterBurnRatio = 0;
    this.rebuildBoosterModels();
    this._fx.spawnGasPuff(kinematicState(t, jointR, this.state.v));
    this._worldSfx.decouple();
    this.invalidatePrediction();
    this._hud.hint(`ブースター分離: 残り ${this.boosters.stages.length} 段`);
    return true;
  }

  boosterManagementViewModel(): BurnManagementViewModel {
    const active = this.activeBooster();
    return {
      stageCount: this.boosters.stages.length,
      maxStages: BOOSTER_MAX_ATTACHED,
      totalMass: this.mass,
      activeFuel: active?.fuel ?? 0,
      activeFuelMax: active?.maxFuel ?? 0,
      burnState: !active ? 'idle' : active.fuel <= 0 ? 'empty' : active.ignited ? 'burning' : 'ready',
      ignitionOn: active?.ignited ?? false,
      canAttach: this.boosters.stages.length < BOOSTER_MAX_ATTACHED,
      canToggleIgnition: active !== undefined && active.fuel > 0,
      canDecouple: active !== undefined,
    };
  }

  private activeBooster(): BoosterStage | undefined {
    const stages = this.boosters.stages;
    return stages[stages.length - 1];
  }

  private rebuildBoosterModels(): void {
    for (const model of this.boosterModels) model.dispose();
    this.boosterModels.length = 0;
    for (let i = 0; i < this.boosters.stages.length; i++) {
      // 段間カバーは内側段の後端にだけ残す。最後尾段にはカバーが無く、
      // 分離時はこの接続部を爆砕ボルトと一緒にデブリへ移す。
      const model = buildBoosterStage({ interstageCover: i < this.boosters.stages.length - 1 });
      model.position.z = BOOSTER_MOUNT_Z - i * BOOSTER_STAGE_DIMENSIONS.length;
      this.renderObject.add(model);
      this.boosterModels.push(model);
    }
  }

  private refreshBoosterMassAndInertia(): void {
    this.mass = C.PLAYER_MASS + this.boosters.totalMass;
    const massRatio = this.mass / C.PLAYER_MASS;
    const lengthFactor = 1 + 0.35 * this.boosters.stages.length ** 2;
    this.att = {
      ...this.att,
      inertia: v3(
        C.PLAYER_INERTIA_PITCH * massRatio * lengthFactor,
        C.PLAYER_INERTIA_YAW * massRatio * lengthFactor,
        C.PLAYER_INERTIA_ROLL * massRatio,
      ),
    };
  }

  private stepAttachedBooster(simDt: number): Vec3 | null {
    const massBefore = C.PLAYER_MASS + this.boosters.totalMass;
    const burn = this.boosters.step(simDt);
    this.refreshBoosterMassAndInertia();
    this.lastBoosterBurnRatio = burn.burnRatio;
    const averageAcceleration = boosterAverageAcceleration(burn, massBefore, this.mass);
    if (averageAcceleration <= 0) return null;
    return scale(qRotate(this.att.q, v3(0, 0, 1)), averageAcceleration);
  }

  private combinedThrust(rcs: Vec3 | null, booster: Vec3 | null): Vec3 | null {
    if (rcs && booster) return add(rcs, booster);
    return rcs ?? booster;
  }

  // 毎フレーム、全ての自機に対して1度だけ呼ぶ。input が null の艦はこのフレーム操作されないので、
  // 次フレームへ持ち越してはならない連続指令をここで畳む。受動状態(ベルト物理・HP自然回復)は
  // 操作の可否によらず進める。
  public updatePlayerControls(
    input: Input | null,
    dt: number,
    simDt: number,
    entities: DynamicSystem,
    activeStage: Stage,
    celestialSystem: CelestialSystem,
  ): void {
    this.updatePassive(dt);
    if (input !== null) this.handleEdgeInput(input, entities);
    const boosterThrust = this.stepAttachedBooster(simDt);
    if (input === null) {
      this.clearTransientCommands();
      this.boosterThrust = boosterThrust;
      this.thrust = boosterThrust;
      return;
    }
    this.updateTorque(input, dt, simDt);

    this.fire.updateFireState(dt, input, activeStage, entities, celestialSystem);

    this.throttle.updateThrustLatches(input);
    this.rcsThrust = this.throttle.updateThrustState(input, this.att, simDt, this);
    this.boosterThrust = boosterThrust;
    this.thrust = this.combinedThrust(this.rcsThrust, this.boosterThrust);
    // 噴射中は毎フレーム破棄する — 次の Predictor がその時点の実状態を種に作り直す。
    if (this.thrust !== null) this.invalidatePrediction();
  }

  // 表示フレーム基準の受動状態。環境(熱・電力・ラジエータ)は stepEnvironment で
  // simulation clock に合わせて進めるため、ここで重複させない。
  private updatePassive(dt: number): void {
    this.belt.update(dt, this.fire.mags, this.fire.rounds, this.att, this.throttle.thrustAccelVec);
    this.hpRegen(dt);
  }

  protected override stepEnvironment(
    dt: number, atmosphereBody: CelestialBody | null, sunlit: number, sunDir: Vec3,
  ): void {
    if (!this.alive) return;
    this.radiator.update(dt, this.radiatorWear());
    this.fire.stepBarrelThermal(dt);
    this.aero.update(this.state.r, this.state.v, atmosphereBody);
    this.altitudeAlarm.update(dt, this.state.r, atmosphereBody);
    this.power.update(dt, sunlit, sunDir, this.att, this);
  }

  // 艦体自体の放熱面積に、展開した放熱板のぶんを上乗せする。
  protected override get radiatingAreaPerMass(): number {
    return C.SHIP_RADIATING_AREA_PER_MASS
      + this.radiator.radiatingArea(this.totalCoolingRate) / C.PLAYER_MASS;
  }

  // 艦体の断面積に、展開した放熱板の日照面を上乗せする。
  protected override solarAbsorbAreaPerMass(sunDir: Vec3): number {
    return super.solarAbsorbAreaPerMass(sunDir)
      + this.radiator.solarAbsorbArea(sunDir, this.att, this.totalCoolingRate) / C.PLAYER_MASS;
  }

  // 操作できない間、次のフレームへ持ち越してはならない連続指令を畳む。
  // 角速度によるcoast自体は継続する。
  clearTransientCommands(): void {
    this.thrust = null;
    this.rcsThrust = null;
    this.boosterThrust = null;
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
  private handleEdgeInput(input: Input, entities: DynamicSystem): void {
    input.takeKeys((code) => this.handleEdgePress(code, entities));
  }

  // 自機側キー1個を処理する。処理したキーは true を返し input.takeKeys に消費させる。
  private handleEdgePress(code: string, entities: DynamicSystem): boolean {
    switch (code) {
      case K.rcsDampToggle.code: this.throttle.toggleRcsDamp(); return true;
      case K.progradeReset.code: this.throttle.enableProgradeReset(); return true;
      case K.fineAttitudeToggle.code: this.toggleFineAttitude(); return true;
      case K.progradeHoldToggle.code: this.throttle.toggleProgradeHold(); return true;
      case K.throttleLow.code: this.throttle.setThrottlePreset(0); return true;
      case K.throttleMid.code: this.throttle.setThrottlePreset(1); return true;
      case K.throttleHigh.code: this.throttle.setThrottlePreset(2); return true;
      case K.throttleMax.code: this.throttle.setThrottlePreset(3); return true;
      case K.boosterDecouple.code: this.decoupleBooster(entities); return true;
      case K.boosterIgnitionToggle.code: this.toggleBoosterIgnition(); return true;
      case K.radiatorDeployLeft.code: this.radiator.toggle('up'); return true;
      case K.radiatorDeployRight.code: this.radiator.toggle('down'); return true;
      case K.solarDeployLeft.code: this.power.toggle('up'); return true;
      case K.solarDeployRight.code: this.power.toggle('down'); return true;
      // マニュアルリロードに成功した場合だけキーを消費する
      case K.reload.code: return this.fire.manualReload();
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
  private attackedByBullet(bullet: Bullet, impactPoint: Vec3, activeStage: Stage, side: RadiatorSide | null = null): void {
    this.absorbHeat(BULLET_IMPACT_HEAT / C.PLAYER_MASS);
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    this.applyDamageToParts(side === null ? bullet.damage : RADIATOR_BULLET_DAMAGE, damagedPart);
    if (side !== null && damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side);
    if (this.hp > 0) {
      // 生存していれば被弾エフェクトのみ
      this.impactEffect(bullet, impactPoint);
      return;
    }

    // HP が尽きたら破壊
    this.alive = false;
    const reason = bullet.shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    activeStage.recordPlayerLost(reason);
    this.destroyEffect();
  }

  // 弾は武装のダメージを、それ以外は接触の接近速度と相手の種別を根拠にする
  // (どちらもゲームバランスの量で、物理の質量からは導かない)。
  collideWithEntity(other: DynamicEntity, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;

    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, activeStage);
      return;
    }

    this.damagedByContact(contactDamageSpeed(other, contact), null, '高速接触により機体を喪失した', activeStage);
  }

  // 天体の固体表面への接触。相手の種別による重みが無いので接近速度がそのまま根拠になる。
  collideWithCelestialBody(_body: CelestialBody, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;
    this.damagedByContact(closingSpeed(contact), null, '天体の地表へ到達し機体は失われた', activeStage);
  }

  // 放熱板の接触代理(RadiatorFold)からの帰結。ダメージの割り振り先が side のパーツに
  // 固定される点だけが collideWithEntity(機体本体)との違い。
  collideAtRadiatorWithEntity(side: RadiatorSide, other: DynamicEntity, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;

    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, activeStage, side);
      return;
    }

    this.damagedByContact(contactDamageSpeed(other, contact), side, '高速接触により機体を喪失した', activeStage);
  }

  // 接触によるダメージ・致死判定。side を指定するとその放熱板パーツへ、無指定なら無作為な
  // パーツへダメージが入る。
  private damagedByContact(
    damageSpeed: number, side: RadiatorSide | null, lossReason: string, activeStage: Stage,
  ): void {
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    if (!this.applyCollisionDamage(damageSpeed, damagedPart)) return;
    if (side !== null && damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side);
    if (this.hp > 0) {
      this._worldSfx.clank();
      this._fx.spawnGasPuff(this.state);
      return;
    }

    this.alive = false;
    activeStage.recordPlayerLost(lossReason);
    this.destroyEffect();
  }

  // この艦の放熱板の、今フレームの接触代理一覧(展開中かつ健在な折りのみ)。
  collisionFolds(simTime: number): DynamicEntity[] {
    return this.radiator.collisionFolds(this.state.r, this.state.v, this.att, simTime);
  }

  // 動圧が構造限界を超えたことによる喪失。熱による焼失は burnUp が、天体の地表への到達は
  // collideWithCelestialBody が扱う。
  checkLoss(
    _dt: number, _simTime: number, activeStage: Stage, _playerPos: Vec3,
    _atmosphereBodies: readonly CelestialBody[],
  ): void {
    if (!this.alive) return;
    if (!this.aero.overStructuralLimit) return;
    this.lose('動圧が構造限界を超え、機体は空力的に分解した', activeStage);
  }

  // 外殻の温度が上限を超えたときの喪失。理由は、そこで空力加熱が効いていたかで分ける。
  protected override burnUp(activeStage: Stage): void {
    this.lose(
      this.aero.heatingAerodynamically
        ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
        : '排熱が追いつかず、機体は熱で機能不全に陥った',
      activeStage);
  }

  // 喪失の共通処理。理由の文言だけが呼び出し側ごとに違う。
  private lose(reason: string, activeStage: Stage): void {
    this.alive = false;
    this.destroyEffect();
    activeStage.recordPlayerLost(reason);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private impactEffect(bullet: Bullet, impactPoint: Vec3): void {
    this._worldSfx.hit(len(sub(impactPoint, this.state.r)));
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(kinematicState(this.state.t, impactPoint, this.state.v));
    } else {
      this._fx.spawnBulletFlash(kinematicState(this.state.t, impactPoint, this.state.v));
    }
    this._fx.spawnGasPuff(kinematicState(this.state.t, impactPoint, this.state.v));
  }

  // 機体喪失時の爆発音・爆発エフェクトを発生させる。
  private destroyEffect(): void {
    this._worldSfx.explosion();
    this._fx.spawnShipDestroyEffect(this.state, 1, PLAYER_DESTROY_FRAG_COLOR);
  }

  // ラジエーターが全損した瞬間の破片エフェクトを、そのパネル先端付近から発生させる。
  private radiatorBreakEffect(side: RadiatorSide): void {
    const tipR = this.radiator.tipWorldPosition(side, this.state.r, this.att);
    this._worldSfx.hit(len(sub(tipR, this.state.r)));
    this._fx.scatterFragments(this.state.t, tipR, this.state.v, 4, PLAYER_DESTROY_FRAG_COLOR, DESTROY_FRAG_SIZE_MIN, DESTROY_FRAG_SIZE_MAX, 8.0);
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

  // 自機のメッシュ・エフェクト・ベルト・マーカーを displayTime の状態へ同期する。
  // isActive はこの艦が操作対象かどうか。操作対象だけがガンサイト時に隠れ、方位マーカーとRCS音を出す。
  syncPlayer(
    fo: FloatingOrigin,
    camera: CameraSystem,
    displayTime: number,
    isActive: boolean,
    style: RenderStyle,
    visibility: MapVisibility | null = null,
    orbitRef?: OrbitReference,
  ): void {
    // メッシュ本体の位置・姿勢
    const displayState = this.displayState(displayTime);
    const mapEntityVisible = !camera.overviewMode || visibility === null || visibility.category;
    this.renderObject.visible = displayState !== null && mapEntityVisible && !(isActive && camera.zoomActive);
    if (displayState !== null) {
      this.renderObject.position.copy(fo.RtoThreeV3(displayState.r));
      this.renderObject.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
      this.syncThermalAppearance();
    }

    // 推力/RCS エフェクトとベルト。機体メッシュと同じ displayState に載せる —
    // 揃えないと「機体は未来位置、プルームは現在位置」に割れる。表示できる状態が無いときは
    // 各エフェクトが自分で消えられるよう visible を倒して呼ぶ。
    const effectState = displayState ?? this.state;
    const effectVisible = displayState !== null && mapEntityVisible;
    const maxAccel = this.mass > 0 ? this.totalThrust / this.mass : 0;
    this.thrustEffects.sync(fo, effectState.r, this.rcsThrust, maxAccel, effectVisible, false, camera, style);
    const activeIndex = this.boosters.stages.length - 1;
    const boosterEffectAtCurrentTime = Math.abs(displayTime - this.state.t) <= 1e-6;
    if (activeIndex >= 0 && this.boosterThrust !== null && effectVisible
      && boosterEffectAtCurrentTime && !camera.zoomActive) {
      const nozzleZ = BOOSTER_MOUNT_Z
        - activeIndex * BOOSTER_STAGE_DIMENSIONS.length
        + BOOSTER_STAGE_DIMENSIONS.nozzleExitZ;
      const nozzleWorld = add(effectState.r, qRotate(this.att.q, v3(0, 0, nozzleZ)));
      const tail = qRotate(this.att.q, v3(0, 0, -1));
      this.boosterPlumes.sync([{
        position: fo.RtoThreeV3(nozzleWorld),
        direction: new THREE.Vector3(tail.x, tail.y, tail.z),
        intensity: Math.max(0.25, this.lastBoosterBurnRatio),
        visible: true,
      }], camera.activeCamera.quaternion, style);
    } else {
      this.boosterPlumes.sync([], camera.activeCamera.quaternion, style);
    }
    if (isActive) {
      this._worldSfx.setThrust(effectVisible && (this.rcsThrust !== null || this.boosterThrust !== null));
    }
    this.rcsEffects.sync(fo, effectState.r, this.torque, this.att, effectVisible, camera, isActive);
    this.reentryEffects.sync(fo, effectState.r, effectState.v, this.aero.qdyn, effectVisible, camera);
    this.belt.sync();
    this.radiator.sync();
    this.power.sync();
    // マーカー。方位マーカーは操作対象の軌道座標系を指すものなので操作対象だけが出す。
    this.markers.sync(
      this.state, this.att, camera.overviewMode, isActive, camera.activeCameraProjection,
      this.roundsInMag, this.magsLeft, this.averageMuzzleVelocity, orbitRef,
    );
  }

  // 艦は任意のタイミングで削除されうるので、Player が所有する線・ビルボード・HUD も一度だけ解放する。
  private disposed: boolean = false;

  // ターゲットとして指定された際などのマーカー。Enemy の markerItem と互換性を持たせる。
  // isActive はこの艦が操作対象かどうか(マップ上の自艦マーカーを他の僚艦と塗り分けるため)。
  markerItem(role: 'none' | 'primary', viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean, isActive: boolean): GroupedMarkerItem {
    const dist = len(sub(pos, viewerPos));
    const priority = role === 'primary' ? C.MARKER_PRIORITY.PRIMARY_TARGET : C.MARKER_PRIORITY.PLAYER;
    const kindCls = isActive ? 'mk-self' : 'mk-ally';
    const color = role === 'primary' ? currentThemePalette().signal : isActive ? 'var(--color-primary)' : C.COLOR_MARKER_ALLY;
    return {
      key: `player-${this.id}`,
      cls: role === 'primary' ? `${kindCls} mk-target` : kindCls,
      sym: overviewMode ? this.headingHpMarkerSvg() : this.hpMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      detail: overviewMode ? '' : fmtMarkerDist(dist),
      bearingColor: role === 'primary' ? currentThemePalette().signal : C.COLOR_MARKER_ALLY,
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
    this.boosterPlumes.dispose();
    for (const model of this.boosterModels) model.dispose();
    this.boosterModels.length = 0;
    this.rcsEffects.dispose(this.playerScene);
    this.reentryEffects.dispose(this.playerScene);
    super.dispose();
  }

  // 現在の艦状態を保存用データへ変換する。
  serialize(): PlayerSaveData {
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
      boosters: this.boosters.exportData(),
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
}
