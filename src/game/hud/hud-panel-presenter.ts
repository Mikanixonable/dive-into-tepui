// ビューバッジ・常設パネル・軌道分析窓へ、このランの状態から組んだ値と操作インターフェースを毎フレーム渡す。
import { len, sub } from '../../math/vec3';
import { frameRoleOf } from '../../physics/frame';
import { orbitInfo, relativeInfo } from '../orbit-info';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { isProteinEnemy } from '../dynamic/dynamic-entity/protein-enemy';
import { aliveCombatTarget } from '../dynamic/dynamic-entity/combat-target';
import { isModularShip } from '../ship/modular-ship';
import { simSpeedCommands, type SimSpeedCommands } from '../dynamic/sim-speed-commands';
import { deployableCommands, type DeployableCommands } from '../player/deployable-commands';
import { orbitReferenceCommands, type OrbitReferenceCommands } from '../viewer/orbit-reference-commands';
import { viewCommands } from '../viewer/view-commands';
import { focusTargetId } from '../viewer/focus-target';
import { ViewBadge } from './view-badge';
import { frameRoleName } from './frame/frame-labels';
import type { Hud, HudPanelViewModels } from './hud';
import type { BurnManagementPanelHandlers } from './panels/burn-management-panel';
import type { VesselPanelViewModel } from './panels/vessel-panel';
import type { OrbitPanelViewModel } from './orbit/orbit-panel';
import type { TargetPanelViewModel } from './panels/target-panel';
import type { EnemyContact } from './panels/enemies-panel';
import type { ApproachTargetSource } from './orbit/orbit-analysis-data';
import type { CommandQueue } from '../command-queue';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { ControlSelection } from '../control-selection';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { Stage } from '../stages/stage';
import type { Viewer } from '../viewer/viewer';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { Targeter } from '../targeter';
import type { ObjectWindows } from '../pickable/object-windows';
import type { CameraSystem } from '../camera/camera-system';
import type { DisplayWindow } from '../display-window-manager';
import type { OrbitReference } from '../orbit-reference';
import type { ViewMode } from '../view/view-mode';
import type { Input } from '../../input/input';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { ThemePalette } from '../../theme';

export class HudPanelPresenter {
  private readonly viewBadge: ViewBadge;
  // パネル操作コマンドをキューへエンキューするインターフェース。
  private readonly simSpeedCommands: SimSpeedCommands;
  private readonly deployableCommands: DeployableCommands;
  private readonly orbitReferenceCommands: OrbitReferenceCommands;
  // ブースターの取り付け・点火・切り離しを扱うハンドラ。
  private readonly burnHandlers: BurnManagementPanelHandlers;

  // ビューバッジを組む。パネルの操作は commands へ積み、値は残りの持ち主から毎フレーム読む。
  public constructor(
    private readonly hud: Hud,
    commands: CommandQueue,
    private readonly celestialSystem: CelestialSystem,
    private readonly dynamicSystem: DynamicSystem,
    private readonly controlSelection: ControlSelection,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly stage: Stage,
    private readonly viewer: Viewer,
    private readonly input: Input,
    private readonly targeter: Targeter,
    private readonly objectWindows: ObjectWindows,
    private readonly cameraSystem: CameraSystem,
  ) {
    this.viewBadge = new ViewBadge(
      hud.viewBadgeRow, hud.overlayManager, viewCommands(commands, viewer.view),
    );
    this.simSpeedCommands = simSpeedCommands(commands, simSpeedManager);
    this.deployableCommands = deployableCommands(commands);
    this.orbitReferenceCommands = orbitReferenceCommands(commands, viewer.orbitReference);
    // 燃焼表示は船体が提供する読み取り専用 view model を参照し、ハンドラ側では命令を発行しない。
    this.burnHandlers = {};
  }

  // ビューバッジを取り除く。
  public dispose(): void {
    this.viewBadge.dispose();
  }

  // ビューバッジを、表に出ているビュー view・選べるビュー selectableViews・見せ方 style と、このランの
  // 注視・操作対象・航法ターゲットの名前へ合わせる。pickables は表のビューの被選択物候補。
  public syncViewBadge(
    view: ViewMode, selectableViews: readonly ViewMode[], pickables: readonly ObjectPickable[],
  ): void {
    this.viewBadge.sync({
      modeLabel: this.stage.stageClass.selectLabel,
      view,
      selectableViews,
      focusName: this.focusName(pickables),
      controlName: this.controlSelection.current?.name ?? null,
      targetName: this.viewer.navTarget.name,
    });
  }

  // 注視対象の表示名。アプシス/交点などの一時マーカーも指しうるので、座標系の役割・被選択物
  // 候補・実体・天体名(未登録なら id)の順に引く。
  private focusName(pickables: readonly ObjectPickable[]): string {
    const id = focusTargetId(this.cameraSystem.activeFocus);
    if (id === undefined) return '固定点';
    const role = frameRoleOf(id);
    if (role !== null) return frameRoleName(role);
    const pickable = pickables.find((item) => item.id === id);
    if (pickable) return pickable.name;
    const entity: DynamicEntity | undefined = this.dynamicSystem.all().find((item) => item.id === id);
    if (entity) return entity.name;
    return this.celestialSystem.nameOf(id);
  }

  // view で表に出ている常設パネルを、表示窓 displayWindow・軌道要素の基準 orbitRef・配色 palette で
  // 組んだ値へ合わせる。camera はこのフレームの表示カメラ、nowMs はフレームの実時刻 [ms]。
  public sync(
    view: ViewMode, displayWindow: DisplayWindow, orbitRef: OrbitReference | undefined, palette: ThemePalette,
    camera: CameraFrame, nowMs: number,
  ): void {
    this.hud.syncPanels(view, this.viewModels(view, displayWindow, orbitRef, palette), camera, nowMs);
  }

  // 常設パネルの値を束ねる。表に出ているビューのパネルのぶんだけを組む。
  private viewModels(
    view: ViewMode, displayWindow: DisplayWindow, orbitRef: OrbitReference | undefined, palette: ThemePalette,
  ): HudPanelViewModels {
    const controlled = this.controlSelection.current;
    // 戦闘ビューにしか出ないパネルは、マップでは値を組まない。
    const combatControlled = view === 'map' ? null : controlled;
    const { simTime } = displayWindow;
    // 操作対象が要るパネルは、対象が無い間 null で畳む。
    return {
      topBar: {
        epochUnixSec: displayWindow.epochUnixSec,
        simTime,
        simSpeed: this.simSpeedManager.simSpeed,
        isPaused: this.hud.overlayManager.isGamePaused(),
        autoWarpRealRemainSec: this.simSpeedManager.estimatedRealSecondsToWarpEnd(simTime),
        autoWarpSimRemainSec: this.simSpeedManager.remainingSimulationSeconds(simTime),
        setSimSpeed: (speed) => this.simSpeedCommands.setSpeed(speed),
      },
      vessel: combatControlled === null ? null : this.vesselViewModel(combatControlled),
      orbit: controlled === null || orbitRef === undefined
        ? null
        : this.orbitViewModel(controlled, orbitRef),
      target: this.targetViewModel(combatControlled),
      enemies: combatControlled === null ? null : {
        remainingCount: this.stage.enemiesAppeared - this.stage.scoreCounter.kills,
        totalCount: this.stage.enemiesAppeared,
        contacts: this.enemyContacts(combatControlled),
        onSelectRight: (id, x, y) => this.objectWindows.openEnemy(id, x, y),
      },
      burnManagement: controlled !== null && isModularShip(controlled)
        ? controlled.burnManagementViewModel() : null,
      burnHandlers: this.burnHandlers,
      mapFocus: this.cameraSystem.mapResolvedFocus,
      analysisSource: {
        celestialSystem: this.celestialSystem,
        windowDurationSec: displayWindow.duration,
        palette,
      },
      analysisSubject: controlled === null || orbitRef === undefined
        ? null
        : { entity: controlled, reference: orbitRef, target: this.approachTarget() },
    };
  }

  // 操作対象の装備・燃料・姿勢の状態と、代替操作用のコールバック。
  private vesselViewModel(controlled: Controllable): VesselPanelViewModel {
    const ship = isModularShip(controlled) ? controlled : null;
    const motion = ship?.motion ?? null;
    const power = motion?.power ?? null;
    const radiator = motion?.radiator ?? null;
    const fire = controlled.fire ?? null;
    // 搭載していない装備は null を返す。
    return {
      rcsDamp: controlled.throttle.rcsDamp,
      throttleIdx: controlled.throttle.throttleIdx,
      dynamicPressurePa: motion?.aero.qdyn ?? null,
      fineAttitude: controlled.fineAttitude,
      cameraFollowsAttitude: this.viewer.camera.combat.rotationFollow?.kind === 'attitude',
      progradeHold: controlled.throttle.progradeHold,
      totalFuel: controlled.totalFuel,
      totalMaxFuel: controlled.totalMaxFuel,
      ammo: fire === null ? null : { rounds: fire.rounds, mags: fire.mags, cooldown: fire.cooldown },
      solar: power === null ? null : {
        up: { deploy: power.deployOf('up'), wear: 0 },
        down: { deploy: power.deployOf('down'), wear: 0 },
      },
      radiator: radiator === null ? null : {
        up: { deploy: radiator.deployOf('up'), wear: radiator.wearOf('up') },
        down: { deploy: radiator.deployOf('down'), wear: radiator.wearOf('down') },
      },
      tapKey: (key) => this.input.tapKey(key),
      toggleSolar: (side) => { if (power !== null) this.deployableCommands.toggleSolar(power, side); },
      toggleRadiator: (side) => { if (radiator !== null) this.deployableCommands.toggleRadiator(radiator, side); },
    };
  }

  // 操作対象の軌道要素と、基準切替用のインターフェース。航法ターゲット基準で対象が重力天体でない(艦・基地・
  // ラグランジュ点)場合は、天体名の生 ID フォールバックより航法ターゲットの表示名を優先する。
  private orbitViewModel(controlled: Controllable, reference: OrbitReference): OrbitPanelViewModel {
    const info = orbitInfo(
      controlled, reference, controlled.motion.state.t, (id: string) => this.celestialSystem.nameOf(id),
    );
    const motion = controlled.motion;
    const ship = isModularShip(controlled) ? controlled : null;
    const targetName = this.viewer.navTarget.name;
    // 軌道の数値は基準に対して解き、警告と切替の状態は操作対象から直に引く。
    return {
      selectedMode: this.viewer.orbitReference.mode,
      centerId: info.centerId,
      centerName: !reference.attractor && targetName ? targetName : info.centerName,
      altitudeM: info.alt,
      descendWarned: controlled.altitudeAlarm?.descendWarned ?? false,
      speedMps: info.spd,
      apAltitudeM: info.apAlt,
      peAltitudeM: info.peAlt,
      inclinationDeg: info.incDeg,
      periodSec: info.period,
      dynamicPressurePa: ship?.motion.aero.qdyn ?? null,
      temperatureK: motion.temperature,
      setReferenceMode: (mode) => this.orbitReferenceCommands.setMode(mode),
    };
  }

  // 固定中のターゲットの読み値。操作対象かターゲットが無ければ null。
  private targetViewModel(controlled: Controllable | null): TargetPanelViewModel | null {
    const target = controlled === null ? null : this.targeter.aliveTarget;
    if (controlled === null || target === null) return null;
    const relative = relativeInfo(
      controlled, target, this.celestialSystem.celestialMotions, controlled.motion.state.t,
    );
    // 距離および接近速度は、双方の基準天体に依存しない相対量として算出する。
    return {
      name: target.name,
      distanceM: relative.dist,
      closingMps: relative.closing,
      relativeSpeedMps: relative.relSpeed,
      hp: target.hp,
      maxHp: target.maxHp,
      protein: isProteinEnemy(target) ? target.combatReadout : null,
      onSelectRight: (x, y) => this.objectWindows.openTarget(x, y),
    };
  }

  // 生存中の敵情報に、操作対象からの距離とロック状態を付与してリスト形式へ変換する。
  private enemyContacts(controlled: Controllable): readonly EnemyContact[] {
    const viewerPos = controlled.motion.state.r;
    const primaryTarget = this.targeter.aliveTarget;
    return this.dynamicSystem.all()
      .filter(isEnemy)
      .filter((enemy) => enemy.motion.alive)
      .map((enemy) => ({
        id: enemy.id,
        name: enemy.name,
        distanceM: len(sub(enemy.motion.state.r, viewerPos)),
        waveId: enemy.waveId,
        targeted: enemy === primaryTarget,
      }));
  }

  // 現在の航法ターゲットを、接近・投影タブが扱える形(天体 or 個体)へ解決する。
  // 質量を持たない対象(ラグランジュ点など)と、ターゲット未選択のときは null。
  private approachTarget(): ApproachTargetSource | null {
    const id = this.viewer.navTarget.id;
    if (id === null) return null;
    const body = this.celestialSystem.find(id)?.motion;
    if (body !== undefined) return { kind: 'celestialBody', body };
    const entity = aliveCombatTarget(this.dynamicSystem.all(), id);
    return entity ? { kind: 'entity', entity } : null;
  }
}
