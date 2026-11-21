// ビューバッジ・常設パネル・軌道分析窓へ、このランの状態から組んだ値と操作インターフェースを毎フレーム渡す。
import { len, sub } from '../../math/vec3';
import { frameRoleOf } from '../../physics/frame';
import { orbitInfo, relativeInfo } from '../orbit-info';
import { aliveCombatTarget } from '../dynamic/entity/combat-target';
import { hasUsableConstructionDock } from '../ship/construction-entry';
import { simSpeedCommands, type SimSpeedCommands } from '../dynamic/sim-speed-commands';
import { shipSystemCommands, type ShipSystemCommands } from '../player/ship-system-commands';
import { orbitReferenceCommands, type OrbitReferenceCommands } from '../viewer/orbit-reference-commands';
import { viewCommands } from '../viewer/view-commands';
import { focusTargetId } from '../viewer/focus-target';
import { isPresentationEnemy, isPresentationShip } from '../presentation-ports';
import { ViewBadge } from './view-badge';
import { frameRoleName } from './frame/frame-labels';
import type { Hud, HudPanelViewModels } from './hud';
import type { VesselPanelViewModel } from './panels/vessel-panel';
import type { ArmamentBandViewModel } from './panels/armament-band';
import type { AmmoViewModel } from './ammo-status';
import type { OrbitPanelViewModel } from './orbit/orbit-panel';
import type { TargetPanelViewModel } from './panels/target-panel';
import type { EnemyContact } from './panels/enemies-panel';
import type { ApproachTargetSource } from './orbit/orbit-analysis-data';
import type { CommandQueue } from '../command-queue';
import type { ControlSelection } from '../control-selection';
import type { Controllable } from '../dynamic/entity/controllable';
import type { ObjectPickable } from '../pickable/object-pickable';
import type {
  PresentationCameraSystem, PresentationCelestialSystem, PresentationDisplayWindow,
  PresentationDynamicSystem, PresentationInput, PresentationNavigationCommand,
  PresentationObjectWindows, PresentationSimSpeed, PresentationStage, PresentationTargeter,
  PresentationViewer,
} from '../presentation-ports';
import type { OrbitReference } from '../orbit-reference';
import type { ViewMode } from '../view/view-mode';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { ThemePalette } from '../../theme';
import type { ShipAlarms } from '../ship-alarms';

export class HudPanelPresenter {
  private readonly viewBadge: ViewBadge;
  // パネル操作コマンドをキューへ積むインターフェース。
  private readonly simSpeedCommands: SimSpeedCommands;
  private readonly shipSystemCommands: ShipSystemCommands;
  private readonly orbitReferenceCommands: OrbitReferenceCommands;

  // ビューバッジを組む。パネルの操作は commands へ積み、値は残りの持ち主から毎フレーム読む。
  public constructor(
    private readonly hud: Hud,
    commands: CommandQueue,
    private readonly celestialSystem: PresentationCelestialSystem,
    private readonly dynamicSystem: PresentationDynamicSystem,
    private readonly controlSelection: ControlSelection,
    private readonly simSpeedManager: PresentationSimSpeed,
    private readonly stage: PresentationStage,
    private readonly viewer: PresentationViewer,
    private readonly input: PresentationInput,
    private readonly targeter: PresentationTargeter,
    private readonly objectWindows: PresentationObjectWindows,
    private readonly cameraSystem: PresentationCameraSystem,
    private readonly navigationCommand: PresentationNavigationCommand,
    // 艦のステータスパネルの「建造」の押下先と、建造中かどうかの読み取り。
    private readonly startConstruction: () => void,
    private readonly constructionActive: () => boolean,
  ) {
    this.viewBadge = new ViewBadge(
      hud.viewBadgeRow, hud.overlayManager, viewCommands(commands, viewer.view),
    );
    this.simSpeedCommands = simSpeedCommands(commands, simSpeedManager);
    this.shipSystemCommands = shipSystemCommands(commands);
    this.orbitReferenceCommands = orbitReferenceCommands(commands, viewer.orbitReference);
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
    if (id === null) return '固定点';
    const role = frameRoleOf(id);
    if (role !== null) return frameRoleName(role);
    const pickable = pickables.find((item) => item.id === id);
    if (pickable) return pickable.name;
    const entity = this.dynamicSystem.all().find((item) => item.id === id);
    if (entity) return entity.name;
    return this.celestialSystem.nameOf(id);
  }

  // view で表に出ている常設パネルと警報帯を、表示窓 displayWindow・軌道要素の基準 orbitRef・配色
  // palette で組んだ値へ合わせる。camera はこのフレームの表示カメラ、alarms は鳴っている警報、
  // nowMs はフレームの実時刻 [ms]。
  public sync(
    view: ViewMode, displayWindow: PresentationDisplayWindow, orbitRef: OrbitReference | null, palette: ThemePalette,
    camera: CameraFrame, alarms: ShipAlarms, nowMs: number,
  ): void {
    this.hud.syncPanels(view, this.viewModels(view, displayWindow, orbitRef, palette), alarms, camera, nowMs);
  }

  // 常設パネルの値を束ねる。表に出ているビューのパネルのぶんだけを組む。
  private viewModels(
    view: ViewMode, displayWindow: PresentationDisplayWindow, orbitRef: OrbitReference | null, palette: ThemePalette,
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
      vessel: combatControlled === null ? null : this.vesselViewModel(combatControlled, view),
      armament: combatControlled === null ? null : this.armamentViewModel(combatControlled),
      orbit: controlled === null || orbitRef === null
        ? null
        : this.orbitViewModel(controlled, orbitRef),
      target: this.targetViewModel(combatControlled),
      enemies: combatControlled === null ? null : {
        remainingCount: this.stage.enemiesAppeared - this.stage.scoreCounter.kills,
        totalCount: this.stage.enemiesAppeared,
        contacts: this.enemyContacts(combatControlled),
        onSelectRight: (id, x, y) => this.objectWindows.openEnemy(id, x, y),
      },
      burnManagement: controlled !== null && isPresentationShip(controlled)
        ? controlled.burnManagementViewModel() : null,
      mapFocus: this.cameraSystem.mapResolvedFocus,
      analysisSource: {
        celestialSystem: this.celestialSystem,
        windowDurationSec: displayWindow.duration,
        palette,
      },
      analysisSubject: controlled === null || orbitRef === null
        ? null
        : { entity: controlled, reference: orbitRef, target: this.approachTarget() },
    };
  }

  // 操作対象の装備・燃料・姿勢の状態と、建造の入口・代替操作用のコールバック。
  private vesselViewModel(controlled: Controllable, view: ViewMode): VesselPanelViewModel {
    const ship = isPresentationShip(controlled) ? controlled : null;
    const motion = ship?.motion ?? null;
    const power = motion?.power ?? null;
    const radiator = motion?.radiator ?? null;
    const coolingDump = motion?.coolingDump ?? null;
    // 搭載していない装備は null を返す。
    return {
      rcsDamp: controlled.throttle.rcsDamp,
      throttleIdx: controlled.throttle.throttleIdx,
      dynamicPressurePa: motion?.aero.qdyn ?? null,
      fineAttitude: controlled.fineAttitude,
      progradeHold: controlled.throttle.progradeHold,
      mainFuel: controlled.totalFuel,
      maxMainFuel: controlled.totalMaxFuel,
      rcsFuel: ship?.totalRcsFuel ?? controlled.totalFuel,
      maxRcsFuel: ship?.totalMaxRcsFuel ?? controlled.totalMaxFuel,
      solar: power === null || !power.hasPanels() ? null : {
        up: power.hasPanel('up') ? { deploy: power.deployOf('up'), wear: 0 } : null,
        down: power.hasPanel('down') ? { deploy: power.deployOf('down'), wear: 0 } : null,
      },
      radiator: radiator === null || !radiator.hasPanels() ? null : {
        up: radiator.hasPanel('up') ? { deploy: radiator.deployOf('up'), wear: radiator.wearOf('up') } : null,
        down: radiator.hasPanel('down') ? { deploy: radiator.deployOf('down'), wear: radiator.wearOf('down') } : null,
      },
      // 建造の入口は、戦闘ビューで船体に使えるドックがあり、建造中でない間だけ。
      startConstruction:
        view === 'combat' && !this.constructionActive() && ship !== null && hasUsableConstructionDock(ship)
          ? () => this.startConstruction()
          : null,
      tapKey: (key) => this.input.tapKey(key),
      toggleSolar: (side) => { if (power !== null) this.shipSystemCommands.toggleSolar(power, side); },
      toggleRadiator: (side) => { if (radiator !== null) this.shipSystemCommands.toggleRadiator(radiator, side); },
      coolingDumpRunning: coolingDump === null ? null : coolingDump.running,
      toggleCoolingDump: () => {
        if (coolingDump !== null) this.shipSystemCommands.toggleCoolingDump(coolingDump);
      },
    };
  }

  // 武装の帯の値と装填操作。機関砲を積んでいない操作対象では null。
  private armamentViewModel(controlled: Controllable): ArmamentBandViewModel | null {
    const ammo = this.ammoViewModel(controlled);
    if (ammo === null) return null;
    return { ammo, tapKey: (key) => this.input.tapKey(key) };
  }

  // 操作対象の機関砲の弾薬状態と弾速。機関砲を積んでいなければ null。
  private ammoViewModel(controlled: Controllable): AmmoViewModel | null {
    const fire = controlled.fire;
    if (fire === null) return null;
    const ship = isPresentationShip(controlled) ? controlled : null;
    return {
      rounds: fire.rounds,
      mags: fire.mags,
      cooldown: fire.cooldown,
      muzzleVelocityMps: ship === null ? null : ship.capabilities.averageMuzzleVelocity,
    };
  }

  // 操作対象の軌道要素と、基準切替用のインターフェース。航法ターゲット基準で対象が重力天体でない(艦・基地・
  // ラグランジュ点)場合は、天体名の生 ID フォールバックより航法ターゲットの表示名を優先する。
  private orbitViewModel(controlled: Controllable, reference: OrbitReference): OrbitPanelViewModel {
    const info = orbitInfo(
      controlled, reference, controlled.motion.state.t, (id: string) => this.celestialSystem.nameOf(id),
    );
    const motion = controlled.motion;
    const ship = isPresentationShip(controlled) ? controlled : null;
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
      onOpenNavigationCommand: () => this.openNavigationCommand(),
    };
  }

  // 「航行指令…」: 現在の航法ターゲットへ向かう候補の求解窓を開く。
  private openNavigationCommand(): void {
    this.navigationCommand.open(this.viewer.navTarget.id, this.viewer.navTarget.name ?? '');
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
      onSelectRight: (x, y) => this.objectWindows.openTarget(x, y),
    };
  }

  // 生存中の敵情報に、操作対象からの距離とロック状態を付与してリスト形式へ変換する。
  private enemyContacts(controlled: Controllable): readonly EnemyContact[] {
    const viewerPos = controlled.motion.state.r;
    const primaryTarget = this.targeter.aliveTarget;
    return this.dynamicSystem.all()
      .filter(isPresentationEnemy)
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
