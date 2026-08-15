import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3, len, sub, dot, norm } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { Hud } from './hud/hud';
import { DockView } from './hud/dock-view';
import { ResourceTransferDialog } from './hud/resource-transfer-dialog';
import { Base } from './game-entity/base';
import { Player } from './player/player';
import type { GameEntity } from './game-entity/game-entity';
import type { EntityManager } from './simulation/entity-manager';
import type { MapContextActions } from './map-context-actions';
import type { CameraSystem } from './camera/camera-system';
import type { ViewManager } from './view-manager';
import type { Sfx } from '../audio/sfx';
import type { EffectsSystem } from './vfx/effects-system';
import type { MarkerManager } from './marker/marker-manager';
import type { ActivePlayerController } from './active-player-controller';
import type { Stage } from './stages/stage';

export class Docking {
  readonly dockView: DockView;
  readonly transferDialog: ResourceTransferDialog;
  // 選択中/ドックビューの対象基地。設定されている間だけドックビューへ遷移できる。
  private _activeBase: Base | null = null;
  // 新造艦の連番。基地をまたいで一意な id/表示名を割り振るだけの用途。
  private nextBuiltShipNo = 0;

  // 船と船、船と基地の物理ドッキングペア (shipId -> targetEntity)
  private readonly dockedPairs = new Map<string, GameEntity>();

  get activeBase(): Base | null { return this._activeBase; }

  constructor(
    private readonly pauseGame: () => void,
    private readonly resumeGame: () => void,
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly scene: THREE.Scene,
    private readonly effects: EffectsSystem,
    private readonly markerManager: MarkerManager,
    private readonly entities: EntityManager,
    private readonly mapActions: MapContextActions,
    private readonly cameraSystem: CameraSystem,
    private readonly viewManager: ViewManager,
    private readonly activePlayers: ActivePlayerController,
    private readonly activeStage: Stage,
  ) {
    this.dockView = new DockView(this.hud.layers.view);
    this.dockView.onClose = () => this.viewManager.leaveDock();
    this.dockView.onLaunchShip = (ship, base) => this.launch(ship, base);
    this.dockView.onBuildShip = (base) => this.buildShip(base);
    this.viewManager.setDocking(this);

    this.transferDialog = new ResourceTransferDialog(this.hud.layers.view, this.hud.overlayManager);
  }

  // 生存中の全基地を返す。
  getAvailableBases(): readonly Base[] {
    return this.entities.bases.filter((b) => b.alive);
  }

  // 指定艦がドッキングしている対象を取得。ドッキングしていなければ null。
  getDockedTarget(ship: Player): GameEntity | null {
    const target = this.dockedPairs.get(ship.id);
    if (!target || !target.alive) {
      if (target) this.dockedPairs.delete(ship.id);
      return null;
    }
    return target;
  }

  // ドッキング可能判定 (距離・ハッチ前方正面判定・相対速度)
  canDock(ship: Player, target: GameEntity): boolean {
    if (!ship.alive || !target.alive || ship === target) return false;
    if (this.getDockedTarget(ship) === target) return false;
    const relSpeed = len(sub(ship.state.v, target.state.v));
    if (relSpeed > C.DOCK_CAPTURE_REL_V) return false;

    if (target instanceof Base) {
      // 基地の場合は特定のドッキングハッチ前方エリア(距離80m以内・正面60度コーン内)でのみドッキング可能
      const hatchPos = target.getHatchWorldPos();
      const hatchNormal = target.getHatchWorldNormal();
      const distToHatch = len(sub(ship.state.r, hatchPos));
      if (distToHatch > C.HATCH_DOCK_MAX_DIST) return false;

      const dirToShip = norm(sub(ship.state.r, hatchPos));
      const alignment = dot(dirToShip, hatchNormal);
      return alignment >= C.HATCH_DOCK_MIN_ALIGNMENT;
    }

    // 船対船ドッキングは従来の距離判定
    const dist = len(sub(ship.state.r, target.state.r));
    return dist <= C.DOCK_CAPTURE_DIST;
  }

  // 船または基地への物理ドッキングを実行。
  dockTo(ship: Player, target: GameEntity): void {
    if (!ship.alive || !target.alive) return;
    this.dockedPairs.set(ship.id, target);
    // 相対速度をゼロにする
    ship.state = kinematicState(ship.state.t, ship.state.r, target.state.v);
    this.hud.hint(`${ship.name} が ${target.name || '対象'} にドッキングしました`);
  }

  // ドッキング解除
  undock(ship: Player): void {
    const target = this.dockedPairs.get(ship.id);
    if (target) {
      this.dockedPairs.delete(ship.id);
      this.hud.hint(`${ship.name} のドッキングを解除しました`);
    }
  }

  // ドッキング中の相手との物資・電力融通ダイアログを開く
  openTransfer(ship: Player, target: GameEntity): void {
    this.transferDialog.open(ship, target);
  }

  // 基地を選択状態にする
  selectBase(base: Base): void {
    this._activeBase = base;
  }

  // 基地を選択し、ドックビューへ遷移する
  activate(base: Base): void {
    const isSameBase = this._activeBase === base;
    this.selectBase(base);
    if (this.viewManager.current === 'dock') {
      if (!isSameBase) this.enterDock();
    } else {
      this.viewManager.setView('dock');
    }
  }

  canEnterDock(): boolean {
    return this.getAvailableBases().length > 0;
  }

  clearActiveBaseIf(base: Base): void {
    if (this._activeBase !== base) return;
    this._activeBase = null;
    this.viewManager.leaveDock();
  }

  enterDock(): void {
    if (!this._activeBase || !this._activeBase.alive) {
      const available = this.getAvailableBases();
      if (available.length === 0) return;
      this._activeBase = available[0]!;
    }
    this.pauseGame();
    this.dockView.open(this._activeBase, this.activePlayers.current, this.activeStage.freeProcurement);
  }

  leaveDock(): void {
    this.dockView.close();
    this.resumeGame();
  }

  // ドッキング中の運動状態を同期 (毎フレーム call)
  updateDockedPhysics(): void {
    for (const [shipId, target] of [...this.dockedPairs.entries()]) {
      const ship = this.entities.findPlayer(shipId);
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
    if (this.viewManager.current === 'dock') return;
    this.updateDockedPhysics();
  }

  // 手動で艦を基地へ収容する
  storeInBase(ship: Player, base: Base): void {
    this.undock(ship);
    base.baseState.dockedShips.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      player: ship,
    });
    ship.renderObject.visible = false;
    const wasActive = this.activePlayers.current === ship;
    this.mapActions.close();
    this.cameraSystem.mapCamera.clearFocusIf(ship.id);
    if (wasActive) {
      ship.clearTransientCommands();
      this.sfx.setThrust(false);
      this.sfx.setRcs(false);
    }
    this.entities.parkPlayer(ship);
    if (wasActive) {
      this.activePlayers.setOrNull(this.entities.players.find((p) => p.alive) ?? null);
      if (this.activePlayers.current === null) this.viewManager.setView('map');
    }
    this.hud.hint(`${ship.name} を基地に収納しました`);
  }

  private buildShip(base: Base): void {
    const no = ++this.nextBuiltShipNo;
    const id = `${base.id}-built-${no}`;
    const ship = new Player(this.hud, this.sfx, this.scene, this.effects, this.markerManager, { name: `新造艦-${no}`, state: base.state, id });
    ship.renderObject.visible = false;
    base.baseState.dockedShips.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      player: ship,
    });
    this.hud.hint(`${ship.name} を建造しました`);
  }

  private launch(ship: Player, base: Base): void {
    const br = base.state.r;
    ship.state = kinematicState(base.state.t, v3(br.x + 600, br.y, br.z), base.state.v);
    this.entities.addPlayer(ship);
    this.activePlayers.set(ship);
    this.viewManager.setView('combat');
    this.hud.hint(`${ship.name} を発進しました`);
  }
}

