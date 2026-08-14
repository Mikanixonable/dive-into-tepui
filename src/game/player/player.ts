import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, R_EARTH, earthAltitudeOf } from '../../physics/solar-system';
import { Vec3, v3, len, sub } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { Ship } from '../game-entity/ship';
import { Bullet } from '../game-entity/bullet';
import type { GameEntity } from '../game-entity/game-entity';
import type { EntityManager } from '../simulation/entity-manager';
import type { Contact } from '../simulation/contact';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { buildPlayerShip } from '../../render/ships';
import { OrbitLine } from '../orbit-line';
import { TrajectoryLine } from '../trajectory-line';
import { Attractor, reachedBody } from '../../physics/attractor';
import { isBurnedUp } from '../../physics/atmosphere';
import type { CameraSystem } from '../camera/camera-system';
import { focusTargetId } from '../camera/focus-target';
import type { MapVisibility } from '../celestial/map-visibility';
import type { Stage } from '../stages/stage';
import { PlayerThrottle } from './player-throttle';
import { PlayerFire, type AmmoLoad } from './player-fire';
import { Belt } from './belt';
import { ThermalSystem } from './thermal';
import { EffectsSystem } from '../vfx/effects-system';
import { ThrustEffects } from './thrust-effects';
import { RcsEffects } from './rcs-effects';
import { ReentryEffects } from './reentry-effects';
import { PlayerMarkers } from './player-markers';
import type { MarkerManager } from '../marker/marker-manager';
import { RadiatorSide, RadiatorSystem } from './radiator';
import { PowerSystem } from './power';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import { Plan } from '../plan/plan';
import { PlanExecutor, type PlanExecutionMode } from '../plan/plan-executor';
import type { PlayerSaveData, PlanSaveData } from '../save-data';
import { partFromSaveData, type AnyPart } from '../game-entity/parts';
import { DIRECTION_GLYPH } from '../marker/marker-glyphs';

export type { PlanExecutionMode };

const PLAN_EXECUTION_LABELS: Record<PlanExecutionMode, string> = { off: 'OFF', instant: '瞬間移動', powered: '自動操縦' };

// mode の表示ラベル(HUDのメニュー項目・プロパティ行が共有する)。
export function planExecutionLabel(mode: PlanExecutionMode): string {
  return PLAN_EXECUTION_LABELS[mode];
}

// 新規配置は name/state/id/ammo を任意指定し、省略時は高度 INITIAL_ALT・傾斜 INITIAL_INC_DEG の
// 円軌道に機首プログレードで初期配置する。スナップショットからの再開は saved を simTime の
// epoch で展開する。
export type PlayerInit =
  | { readonly name?: string; readonly state?: KinematicState; readonly id?: string; readonly ammo?: AmmoLoad }
  | { readonly saved: PlayerSaveData; readonly simTime: number };

// プレイヤー機: 移動(PlayerThrottle)と射撃(PlayerFire)を束ね、その両方を反映した
// 見た目(モデル・エフェクトメッシュの管理と毎フレーム更新)を持つ。
export class Player extends Ship {
  readonly throttle: PlayerThrottle;
  readonly fire: PlayerFire;
  readonly belt: Belt;
  readonly thermal: ThermalSystem;
  readonly radiator: RadiatorSystem;
  readonly power: PowerSystem;

  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;
  private readonly reentryEffects: ReentryEffects;
  private readonly markers: PlayerMarkers;
  declare readonly orbitLine: OrbitLine;
  declare readonly trajectoryLine: TrajectoryLine;
  declare readonly pastTrajectoryLine: TrajectoryLine;
  // この艦自身のマニューバ計画。PlanEditor はアクティブ艦のこれを編集する。
  readonly plan = new Plan();
  readonly planExecutor: PlanExecutor;
  planExecution: PlanExecutionMode = 'off';

  private readonly _hud: Hud;
  private readonly _sfx: Sfx;
  private readonly _fx: EffectsSystem;
  private readonly playerScene: THREE.Scene;

  fineAttitude = false;

  // init 省略時は名前 'PLAYER'・既定軌道の新規艦になる。複数隻を並べるときは name/state を
  // 指定して区別する(name が艦の識別子になる)。
  constructor(
    _hud: Hud, _sfx: Sfx, _scene: THREE.Scene, _fx: EffectsSystem, markerManager: MarkerManager,
    init: PlayerInit = {},
  ) {
    const name = 'saved' in init ? (init.saved.name || init.saved.id) : (init.name ?? 'PLAYER');
    const state = 'saved' in init
      ? kinematicState(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z))
      : (init.state ?? Player.makeInitialState());
    const id = 'saved' in init ? init.saved.id : (init.id ?? name);
    const att: Attitude = 'saved' in init
      ? { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: Player.INERTIA }
      : Player.progradeAttitude(state);

    super(name, state, buildPlayerShip(), att, C.PLAYER_HULL_RADIUS, C.PLAYER_MAX_HP, _scene, id);
    this._hud = _hud;
    this._sfx = _sfx;
    this._fx = _fx;
    this.playerScene = _scene;
    this.mass = C.PLAYER_MASS;
    this.collides = true;

    const saved = 'saved' in init ? init.saved : undefined;
    this.throttle = new PlayerThrottle(_hud, saved?.throttle);
    this.fire = new PlayerFire(this, _hud, _sfx, _scene, _fx, 'saved' in init ? { saved: init.saved.fire } : { ammo: init.ammo });
    this.belt = new Belt(this.obj, this);
    this.thermal = new ThermalSystem(_hud, _sfx, saved?.thermal);
    this.radiator = new RadiatorSystem(this.obj, this, saved?.radiator);
    this.power = new PowerSystem(this.obj, saved?.power);
    this.thrustEffects = new ThrustEffects(_scene, _sfx);
    this.rcsEffects = new RcsEffects(_scene, _sfx);
    this.reentryEffects = new ReentryEffects(_scene);
    this.markers = new PlayerMarkers(markerManager, this.id);
    this.planExecutor = new PlanExecutor(_hud);

    // 自機軌道線: 明るいグレー。ターゲット(オレンジ)より目立たせない配色。
    this.orbitLine = new OrbitLine(0xbfc9d4, 0.55, C.LINE_RENDER_ORDER.shipOrbit);
    _scene.add(this.orbitLine.line);
    this.trajectoryLine = new TrajectoryLine(0xbfc9d4, 0.55, C.LINE_RENDER_ORDER.predicted);
    _scene.add(this.trajectoryLine.line);
    // 過去の軌跡は未来線と同色にし、既に通り過ぎた区間だと読めるよう不透明度だけ落とす。
    this.pastTrajectoryLine = new TrajectoryLine(0xbfc9d4, 0.3, C.LINE_RENDER_ORDER.predicted);
    _scene.add(this.pastTrajectoryLine.line);

    if (saved) {
      // 旧セーブは followPlan: boolean だった(true→'instant' / false→'off')。
      this.planExecution = saved.planExecution ?? (saved.followPlan ? 'instant' : 'off');
      this.fineAttitude = saved.fineAttitude ?? false;
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
    this.selfRepair(dt * C.HP_REGEN_RATE);
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

  // 弾薬ピックアップで得たマグ数を加算する。
  onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  // 毎フレーム、全ての自機に対して1度だけ呼ぶ。input が null の艦はこのフレーム操作されないので、
  // 次フレームへ持ち越してはならない連続指令をここで畳む。受動状態(ベルト物理・HP自然回復)は
  // 操作の可否によらず進める。
  behave(
    input: Input | null,
    dt: number,
    simDt: number,
    entities: EntityManager,
    activeStage: Stage,
    ephemeris: Ephemeris,
  ): void {
    this.updatePassive(dt);
    if (input === null) {
      this.clearTransientCommands();
      return;
    }
    this.handleEdgeInput(input);
    this.updateTorque(input, dt, simDt);

    this.fire.updateFireState(dt, input, activeStage, entities, ephemeris);

    this.throttle.updateThrustLatches(input);
    this.thrust = this.throttle.updateThrustState(input, this.att, simDt, this);
    // 噴射中は毎フレーム破棄する — 次の Predictor がその時点の実状態を種に作り直す。
    if (this.thrust !== null) this.invalidatePrediction();

    // 操作対象艦での手動並進・手動回転は 'powered' 自動実行を中断する(進行方向ホールドが
    // 手動回転で解除されるのと同じ作法)。
    if (this.planExecution === 'powered'
      && (this.thrust !== null || this.throttle.hasManualRotationInput(input))) {
      this.planExecution = 'off';
      this._hud.hint('軌道計画の自動実行を中断(手動操作)');
    }
  }

  // 表示フレーム基準の受動状態。環境(熱・電力・ラジエータ)は stepEnvironment で
  // simulation clock に合わせて進めるため、ここで重複させない。
  private updatePassive(dt: number): void {
    this.belt.update(dt, this.fire.mags, this.fire.rounds, this.att, this.throttle.thrustAccelVec);
    this.hpRegen(dt);
  }

  // 軌道・姿勢と同じsimulation clockで受動環境系を進める。Game.behaveのwall dtから
  // 分離し、各substep終端の位置・姿勢・太陽方向を使うことでwarp依存を防ぐ。
  stepEnvironment(dt: number, ephemeris: Ephemeris, simTime: number): void {
    if (!this.alive) return;
    this.radiator.update(dt, this.radiatorWear());
    const sunDir = ephemeris.sunDirFrom(this.state.r, simTime);
    const attractorsNow = ephemeris.attractorsAt(simTime);
    const star = attractorsNow.find((a) => a.id === ephemeris.starId);
    const sunlit = star ? sunlitFactor(this.state.r, star, attractorsNow) : 1;
    this.thermal.setRadiatorLoad(
      this.radiator.radiatingArea(this.totalCoolingRate),
      this.radiator.solarLoad(sunlit, sunDir, this.att, this.totalCoolingRate),
    );
    this.power.update(dt, sunlit, sunDir, this.att, this);
    this.thermal.updateThermal(dt, this.state.r, this.state.v, this);
  }

  // 操作できない間、次のフレームへ持ち越してはならない連続指令を畳む。
  // 角速度によるcoast自体は継続する。
  clearTransientCommands(): void {
    this.thrust = null;
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
  private handleEdgeInput(input: Input): void {
    input.takeKeys((code) => this.handleEdgePress(code));
  }

  // 自機側キー1個を処理する。処理したキーは true を返し input.takeKeys に消費させる。
  private handleEdgePress(code: string): boolean {
    switch (code) {
      case K.rcsDampToggle.code: this.throttle.toggleRcsDamp(); return true;
      case K.progradeReset.code: this.throttle.enableProgradeReset(); return true;
      case K.fineAttitudeToggle.code: this.toggleFineAttitude(); return true;
      case K.progradeHoldToggle.code: this.throttle.toggleProgradeHold(); return true;
      case K.throttleLow.code: this.throttle.setThrottlePreset(0); return true;
      case K.throttleMid.code: this.throttle.setThrottlePreset(1); return true;
      case K.throttleHigh.code: this.throttle.setThrottlePreset(2); return true;
      case K.throttleMax.code: this.throttle.setThrottlePreset(3); return true;
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
    this.thermal.addImpactHeat();
    const damagedPart = side === null ? undefined : this.radiatorParts[side === 'up' ? 0 : 1];
    this.applyDamageToParts(side === null ? bullet.damage : C.RADIATOR_BULLET_DAMAGE, damagedPart);
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

  // 弾は武装のダメージを、それ以外は接触の速度変化 Δv = impulse/mass を根拠にする
  // (前者はゲームバランス、後者は物理量で、統合すると前者の根拠が消える)。
  collideWith(other: GameEntity | Attractor, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;

    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, activeStage);
      return;
    }

    // 弾以外との接触は Δv ベースの物理ダメージとして、無作為なパーツへ振り分ける。
    if (!this.applyCollisionDamage(contact.impulse / this.mass)) return;
    if (this.hp > 0) {
      this._sfx.clank();
      this._fx.spawnGasPuff(this.state);
      return;
    }

    this.alive = false;
    activeStage.recordPlayerLost('高速接触により機体を喪失した');
    this.destroyEffect();
  }

  // 放熱板の接触代理(RadiatorFold)からの帰結。ダメージの割り振り先が side のパーツに
  // 固定される点だけが collideWith(機体本体)との違い。
  collideAtRadiator(side: RadiatorSide, other: GameEntity | Attractor, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;

    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, activeStage, side);
      return;
    }

    // 弾以外との接触は、collideWith と異なり side の放熱板パーツへ固定して振り分ける。
    const damagedPart = this.radiatorParts[side === 'up' ? 0 : 1];
    if (!this.applyCollisionDamage(contact.impulse / this.mass, damagedPart)) return;
    if (damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side);
    if (this.hp > 0) {
      this._sfx.clank();
      this._fx.spawnGasPuff(this.state);
      return;
    }

    this.alive = false;
    activeStage.recordPlayerLost('高速接触により機体を喪失した');
    this.destroyEffect();
  }

  // この艦の放熱板の、今フレームの接触代理一覧(展開中かつ健在な折りのみ)。
  collisionFolds(simTime: number): GameEntity[] {
    return this.radiator.collisionFolds(this.state.r, this.state.v, this.att, simTime);
  }

  // 熱防御の飽和・空力破壊・大気突入高度・天体の地表到達の判定(自然死)。
  checkLoss(dt: number, _simTime: number, activeStage: Stage, _playerPos: Vec3, attractors: readonly Attractor[]): void {
    if (!this.alive) return;
    const limit = this.thermal.updateAltitudeAlarm(dt, earthAltitudeOf(this.state.r));

    // 熱・動圧・大気突入・地表到達のいずれかを喪失理由として判定する
    let reason: string | null = null;
    if (limit === 'heat-aero') reason = '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した';
    else if (limit === 'heat-internal') reason = '排熱が追いつかず、機体は熱で機能不全に陥った';
    else if (limit === 'dynpressure') reason = '動圧が構造限界を超え、機体は空力的に分解した';
    else if (isBurnedUp(this.state.r, attractors, C.PLAYER_MIN_ALT)) reason = '大気圏に突入し機体は焼失した';
    else if (reachedBody(this.actualTrajectory.prevState, this.state, attractors, C.PLAYER_MIN_ALT) !== null) reason = '天体の地表へ到達し機体は失われた';
    if (reason === null) return;

    this.alive = false;
    this.destroyEffect();
    activeStage.recordPlayerLost(reason);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private impactEffect(bullet: Bullet, impactPoint: Vec3): void {
    this._sfx.hit();
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(kinematicState(this.state.t, impactPoint, this.state.v));
    } else {
      this._fx.spawnBulletFlash(kinematicState(this.state.t, impactPoint, this.state.v));
    }
    this._fx.spawnGasPuff(kinematicState(this.state.t, impactPoint, this.state.v));
  }

  // 機体喪失時の爆発音・爆発エフェクトを発生させる。
  private destroyEffect(): void {
    this._sfx.explosion();
    this._fx.spawnShipDestroyEffect(this.state, 1, C.COLOR_PLAYER_DESTROY_FRAG);
  }

  // ラジエーターが全損した瞬間の破片エフェクトを、そのパネル先端付近から発生させる。
  private radiatorBreakEffect(side: RadiatorSide): void {
    this._sfx.hit();
    const tipR = this.radiator.tipWorldPosition(side, this.state.r, this.att);
    this._fx.scatterFragments(this.state.t, tipR, this.state.v, 4, C.COLOR_PLAYER_DESTROY_FRAG, C.DESTROY_FRAG_SIZE_MIN, C.DESTROY_FRAG_SIZE_MAX, 8.0);
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

  // 自機のメッシュ・エフェクト・ベルト・マーカー・軌道線を displayTime の状態へ同期する。
  // isActive はこの艦が操作対象かどうか。操作対象だけがガンサイト時に隠れ、方位マーカーとRCS音を出す。
  syncPlayer(
    fo: FloatingOrigin,
    camera: CameraSystem,
    displayTime: number,
    isActive: boolean,
    ephemeris: Ephemeris,
    attractors: readonly Attractor[],
    visibility: MapVisibility | null = null,
  ): void {
    // メッシュ本体の位置・姿勢
    const displayState = this.displayState(displayTime);
    const mapEntityVisible = !camera.overviewMode || visibility === null || visibility.category;
    this.obj.visible = displayState !== null && mapEntityVisible && !(isActive && camera.zoomActive);
    if (displayState !== null) {
      this.obj.position.copy(fo.RtoThreeV3(displayState.r));
      this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    }

    // 推力/RCS エフェクトとベルト。機体メッシュと同じ displayState に載せる —
    // 揃えないと「機体は未来位置、プルームは現在位置」に割れる。表示できる状態が無いときは
    // 各エフェクトが自分で消えられるよう visible を倒して呼ぶ。
    const effectState = displayState ?? this.state;
    const effectVisible = displayState !== null && mapEntityVisible;
    const maxAccel = this.mass > 0 ? this.totalThrust / this.mass : 0;
    this.thrustEffects.sync(fo, effectState.r, this.thrust, maxAccel, effectVisible, isActive, camera);
    this.rcsEffects.sync(fo, effectState.r, this.torque, this.att, effectVisible, camera, isActive);
    this.reentryEffects.sync(fo, effectState.r, effectState.v, this.thermal.qdyn, effectVisible, camera);
    this.belt.sync();
    this.radiator.sync();
    this.power.sync();
    // マーカーと軌道線。方位マーカーは操作対象の軌道座標系を指すものなので操作対象だけが出す。
    this.markers.sync(this.state, displayState, this.att, camera.overviewMode, isActive, camera.activeCameraProjection, camera.activeCameraScale, this.name, this.roundsInMag, this.reloadTimer, this.magsLeft, this.averageMuzzleVelocity, focusTargetId(camera.overviewCamera.focus), ephemeris.registry, attractors, visibility);

    this.syncOrbitLine(true, fo, camera.activeCamera, attractors, this.thrust !== null);
  }

  // 艦は任意のタイミングで削除されうるので、Player が所有する線・ビルボード・HUD も一度だけ解放する。
  private disposed: boolean = false;

  // ターゲットとして指定された際などのマーカー。Enemy の markerItem と互換性を持たせる。
  markerItem(role: 'none' | 'primary' | 'secondary', viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean): {
    key: string; cls: string; sym: string; pos: Vec3; vel: Vec3; priority: number;
    name: string; detail: string; bearingColor: string; bearingSym: string; bearingClass: string;
    bearingVisible: boolean; color: string; symMarkup: boolean;
  } {
    const dist = len(sub(pos, viewerPos));
    const priority = role === 'primary' ? Infinity : role === 'secondary' ? Number.MAX_SAFE_INTEGER : -dist;
    return {
      key: `player-${this.id}`,
      cls: role === 'primary' ? 'mk-target' : 'mk-enemy', // player も味方ターゲットとして mk-enemy に準じる
      sym: overviewMode ? this.headingHpMarkerSvg() : this.hpMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      detail: '',
      bearingColor: C.COLOR_MARKER_ALLY,
      bearingSym: DIRECTION_GLYPH.allyBearing,
      bearingClass: 'mk-dir mk-ally-dir',
      bearingVisible: dist <= C.ALLY_BEARING_MAX_DISTANCE,
      color: C.COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  // 自身に関するメッシュやエフェクトを解放する。
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTransientCommands();
    this.markers.dispose();
    this.playerScene.remove(this.orbitLine.line);
    this.orbitLine.dispose();
    this.playerScene.remove(this.trajectoryLine.line);
    this.trajectoryLine.dispose();
    this.playerScene.remove(this.pastTrajectoryLine.line);
    this.pastTrajectoryLine.dispose();
    this.thrustEffects.dispose(this.playerScene);
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
      thermal: this.thermal.serialize(),
      radiator: this.radiator.serialize(),
      power: this.power.serialize(),
      throttle: this.throttle.serialize(),
      parts: this.parts.map(p => ({ ...p })) as AnyPart[],
      planExecution: this.planExecution,
      fineAttitude: this.fineAttitude,
      plan: this.serializePlan(),
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
