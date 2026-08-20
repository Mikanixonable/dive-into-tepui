// 基地まわりの2つの関心事: 艦と基地・艦どうしの物理ドッキング、そして基地操作ウィンドウの開閉。
// 艦体の組立セッションは AssemblySessionController が持つ —— このクラスはそこへの窓口
// (開始・入力・sync・破棄の委譲)だけを持つ。
import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3, len, sub } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { Hud } from './hud/hud';
import { BaseOperationsWindow } from './hud/base-operations-window';
import { ResourceTransferDialog } from './hud/resource-transfer-dialog';
import { Vessel, type VesselDeps } from './vessel/vessel';
import { hasBaseModule } from './vessel/capabilities';
import type { GameEntity } from './game-entity/game-entity';
import type { Input } from './input/input';
import type { EntityManager } from './simulation/entity-manager';
import type { MapContextActions } from './map-context-actions';
import type { CameraSystem } from './camera/camera-system';
import type { ViewManager } from './view-manager';
import type { WorldSfx } from '../audio/sfx/world-sfx';
import type { EffectsSystem } from './vfx/effects-system';
import type { MarkerManager } from './marker/marker-manager';
import type { ActiveVesselController } from './active-vessel-controller';
import type { GraphicsSettings } from '../render/graphics-settings';
import type { FloatingOrigin } from './floating-origin';
import { AssemblySessionController } from './assembly-session-controller';

// 基地操作ウィンドウを座標指定なしで開くときの左上角 [px]。
const DEFAULT_WINDOW_X = 120;
const DEFAULT_WINDOW_Y = 120;

// クリップされていない基地操作ウィンドウを同時に高々1枚に保つための排他グループ名。
const BASE_WINDOW_TEMP_GROUP = 'base-operations-temp';

export class Docking {
  readonly transferDialog: ResourceTransferDialog;
  private readonly assemblySession: AssemblySessionController;
  // 選択中の基地。基地操作ウィンドウ・組立の既定の対象になる。
  private _activeBase: Vessel | null = null;

  // 船と船、船と基地の物理ドッキングペア (shipId -> targetEntity)
  private readonly dockedPairs = new Map<string, GameEntity>();

  get activeBase(): Vessel | null { return this._activeBase; }

  // 基地 id ごとの操作ウィンドウ。1つの基地に2枚開かない。
  private readonly baseWindows = new Map<string, BaseOperationsWindow>();

  // 基地に関わる各所有者への参照を受け取る。ポーズだけは Game の状態なので、必要な2つの
  // 操作を関数として受ける —— どちらも組立セッションでしか使わないので、そのまま
  // AssemblySessionController へ渡す。
  constructor(
    pauseGame: () => void,
    resumeGame: () => void,
    private readonly hud: Hud,
    private readonly worldSfx: WorldSfx,
    scene: THREE.Scene,
    effects: EffectsSystem,
    markerManager: MarkerManager,
    graphics: GraphicsSettings,
    private readonly entities: EntityManager,
    private readonly mapActions: MapContextActions,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly activeVessels: ActiveVesselController,
  ) {
    this.viewManager.setDocking(this);
    this.transferDialog = new ResourceTransferDialog(this.hud.layers.view, this.hud.overlayManager);
    const vesselDeps: VesselDeps = { hud, worldSfx, scene, fx: effects, markerManager, graphics };
    this.assemblySession = new AssemblySessionController(
      pauseGame, resumeGame, this.hud, scene, vesselDeps, this.cameraSystem,
      (base) => this.selectBase(base),
    );
  }

  // 生存中の全基地を返す。
  getAvailableBases(): readonly Vessel[] {
    return this.entities.baseVessels().filter((b) => b.alive);
  }

  // 指定艦がドッキングしている対象を取得。ドッキングしていなければ null。
  getDockedTarget(ship: Vessel): GameEntity | null {
    const target = this.dockedPairs.get(ship.id);
    if (!target || !target.alive) {
      if (target) this.dockedPairs.delete(ship.id);
      return null;
    }
    return target;
  }

  // ドッキング可能判定 (距離・ドックスロット前方正面判定・相対速度)
  canDock(ship: Vessel, target: GameEntity): boolean {
    if (!ship.alive || !target.alive || ship === target) return false;
    if (this.getDockedTarget(ship) === target) return false;
    const relSpeed = len(sub(ship.state.v, target.state.v));
    if (relSpeed > C.DOCK_CAPTURE_REL_V) return false;

    // 基地モジュールを積んだ相手は、そのモジュールが定める口と閾値で受け入れを判定する。
    if (target instanceof Vessel && hasBaseModule(target)) return target.canCapture(ship);

    // 船対船のドッキングは距離だけで判定する
    const dist = len(sub(ship.state.r, target.state.r));
    return dist <= C.DOCK_CAPTURE_DIST;
  }

  // 船または基地への物理ドッキングを実行。
  dockTo(ship: Vessel, target: GameEntity): void {
    if (!ship.alive || !target.alive) return;
    if (target instanceof Vessel && hasBaseModule(target)) {
      this.storeInBase(ship, target);
    } else {
      this.dockedPairs.set(ship.id, target);
      // 相対速度をゼロにする
      ship.state = kinematicState(ship.state.t, ship.state.r, target.state.v);
      this.hud.hint(`${ship.name} が ${target.name || '対象'} にドッキングしました`);
    }
  }

  // ドッキング解除
  undock(ship: Vessel): void {
    const target = this.dockedPairs.get(ship.id);
    if (target) {
      this.dockedPairs.delete(ship.id);
      this.hud.hint(`${ship.name} のドッキングを解除しました`);
    }
  }

  // ドッキング中の相手との物資・電力融通ダイアログを開く
  openTransfer(ship: Vessel, target: GameEntity): void {
    this.transferDialog.open(ship, target);
  }

  // 基地を選択状態にする
  selectBase(base: Vessel): void {
    this._activeBase = base;
  }

  // ------------------------------------------------------------ 基地操作ウィンドウ

  // 基地の操作ウィンドウ(格納艦艇・部品・生産)を開く。既に開いていれば指定位置へ動かして
  // 最前面へ出す。接岸の有無は問わない — 他の対象のプロパティウィンドウと同じく、基地が
  // 在れば常に開ける。
  openBaseOperations(base: Vessel, clientX = DEFAULT_WINDOW_X, clientY = DEFAULT_WINDOW_Y): void {
    this.selectBase(base);
    const existing = this.baseWindows.get(base.id);
    if (existing) {
      existing.open(base, clientX, clientY);
      return;
    }
    const win = new BaseOperationsWindow(
      this.hud.layers.window, this.hud.layers.popup, this.hud.overlayManager, BASE_WINDOW_TEMP_GROUP,
    );
    win.onLaunchVessel = (ship, from) => this.launch(ship, from);
    win.onClose = () => { this.baseWindows.delete(base.id); };
    this.baseWindows.set(base.id, win);
    win.open(base, clientX, clientY);
  }

  // 消えた基地のウィンドウを閉じる。毎フレームの sync から呼ぶ。
  private syncBaseWindows(): void {
    for (const [id, win] of [...this.baseWindows.entries()]) {
      const base = this.entities.findBaseVessel(id);
      if (base && base.alive) continue;
      this.baseWindows.delete(id);
      win.dispose();
    }
  }

  // 基地が世界から消えるときに、それを指していた選択とウィンドウを畳む。
  clearActiveBaseIf(base: Vessel): void {
    this.assemblySession.cancelIfBase(base);
    const win = this.baseWindows.get(base.id);
    if (win) {
      this.baseWindows.delete(base.id);
      win.dispose();
    }
    if (this._activeBase !== base) return;
    this._activeBase = null;
  }

  // ------------------------------------------------------------ 組立セッション

  // 組立セッションが進行中か。発進・生産など、構成が固まっている前提の操作の門になる。
  get assemblyInProgress(): boolean { return this.assemblySession.inProgress; }

  // 基地とその格納艦・下書きを対象にした組立セッションを開き、部品棚ウィンドウを出す。
  startAssembly(base: Vessel, preferredTargetId?: string): void {
    this.selectBase(base);
    this.assemblySession.startAssembly(base, preferredTargetId);
  }

  // セッションの編集を捨てて閉じる。実機は一度も触られていないので戻す作業は要らない。
  cancelAssembly(): void {
    this.assemblySession.cancelAssembly();
  }

  // このフレームの3Dクリック・ドラッグを組立セッションへ渡す。セッションが無ければ何もしない。
  updateAssembly(input: Input): void {
    this.assemblySession.updateAssembly(input);
  }

  // 組立セッションの論理状態を見た目へ押し込み、消えた基地のウィンドウを閉じる。
  syncAssembly(fo: FloatingOrigin): void {
    this.syncBaseWindows();
    this.assemblySession.syncAssembly(fo);
  }

  // ドッキング中の運動状態を同期 (毎フレーム call)
  updateDockedPhysics(): void {
    for (const [shipId, target] of [...this.dockedPairs.entries()]) {
      const ship = this.entities.findOwnShip(shipId);
      if (!ship || !ship.alive || !target.alive) {
        this.dockedPairs.delete(shipId);
        continue;
      }
      // 速度を完全同期
      ship.state = kinematicState(ship.state.t, ship.state.r, target.state.v);
    }
  }

  // 近接判定。自動収容は行わず、死んだペアの掃除と状況維持を行う。
  checkProximity(): void {
    this.updateDockedPhysics();
  }

  // 手動で艦を基地へ収容する
  storeInBase(ship: Vessel, base: Vessel): void {
    if (base.baseState!.dockedVessels.length >= base.dockCapacity) {
      this.hud.hint(`基地のドックが満杯です (最大 ${base.dockCapacity} 隻)`);
      return;
    }
    const slotIndex = base.getAvailableSlotIndex() ?? 0;
    this.undock(ship);
    base.baseState!.dockedVessels.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      vessel: ship,
      slotIndex,
    });
    base.attachDockedVesselMesh(ship, slotIndex);

    const wasActive = this.activeVessels.current === ship;
    this.mapActions.close();
    this.cameraSystem.mapCamera.clearFocusIf(ship.id);
    if (wasActive) {
      ship.clearTransientCommands();
      this.worldSfx.setThrust(false);
      this.worldSfx.setRcs(false);
    }
    this.entities.parkVessel(ship);
    if (wasActive) {
      this.activeVessels.setOrNull(this.entities.ownShips().find((p) => p.alive) ?? null);
      if (this.activeVessels.current === null) this.viewManager.setView('map');
    }
    this.hud.hint(`${ship.name} を基地のドック ${slotIndex + 1} に収納しました`);
  }

  // 格納艦をドックから切り離して発進させ、操作対象にする。
  private launch(ship: Vessel, base: Vessel): void {
    if (this.assemblySession.inProgress) {
      this.hud.hint('組立中の構成を先に確定または取消してください');
      return;
    }
    const idx = base.baseState!.dockedVessels.findIndex((s) => s.vessel === ship || s.id === ship.id);
    const slotIndex = idx >= 0 ? base.baseState!.dockedVessels[idx]!.slotIndex : 0;

    if (idx >= 0) {
      base.baseState!.dockedVessels.splice(idx, 1);
    }
    base.detachDockedVesselMesh(ship);

    // ドックスロットの位置・法線からワールド座標・分離速度を算出
    const slotPos = base.getSlotWorldPos(slotIndex);
    const slotNormal = base.getSlotWorldNormal(slotIndex);

    const launchPos = v3(
      slotPos.x + slotNormal.x * 15,
      slotPos.y + slotNormal.y * 15,
      slotPos.z + slotNormal.z * 15,
    );
    const launchVel = v3(
      base.state.v.x + slotNormal.x * 2.5,
      base.state.v.y + slotNormal.y * 2.5,
      base.state.v.z + slotNormal.z * 2.5,
    );

    ship.state = kinematicState(base.state.t, launchPos, launchVel);
    this.entities.addVessel(ship);
    this.activeVessels.set(ship);
    this.viewManager.setView('combat');
    this.hud.hint(`${ship.name} がドック ${slotIndex + 1} から切り離され発進しました`);
  }

  // 開いているウィンドウ・進行中のセッション・掴んだままの部品を片付ける。
  dispose(): void {
    this.assemblySession.dispose();
    for (const win of this.baseWindows.values()) win.dispose();
    this.baseWindows.clear();
  }
}
