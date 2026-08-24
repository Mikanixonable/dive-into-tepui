import * as THREE from 'three/webgpu';
import * as C from './const';
import { v3, len, sub, dot, norm } from '../physics/vec3';
import { kinematicState } from '../physics/kinematic-state';
import { Hud } from './hud/hud';
import { BaseView } from './hud/panels/base-view';
import { ResourceTransferDialog } from './hud/windows/resource-transfer-dialog';
import { Base } from './game-entity/base';
import { Player } from './player/player';
import type { GameEntity } from './game-entity/game-entity';
import type { EntityManager } from './simulation/entity-manager';
import type { MapContextActions } from './map-context-actions';
import type { CameraSystem } from './camera/camera-system';
import type { ViewManager } from './view-manager';
import type { WorldSfx } from '../audio/sfx/world-sfx';
import type { EffectsSystem } from './vfx/effects-system';
import type { MarkerManager } from './marker/marker-manager';
import type { ActivePlayerController } from './active-controllable-controller';
import type { Stage } from './stages/stage';
import { generateRandomName } from './random-name';

export class Docking {
  // アクティブな基地が変わるたびに通知する — 物体一覧パネルのハイライトを追随させる用途。
  onSelect: ((id: string | null) => void) | null = null;

  readonly baseView: BaseView;
  readonly transferDialog: ResourceTransferDialog;
  // 選択中/ドックビューの対象基地。設定されている間だけドックビューへ遷移できる。
  private _activeBase: Base | null = null;
  // 新造艦艇の連番。基地をまたいで一意な id/表示名を割り振るだけの用途。
  private nextBuiltVesselNo = 0;

  // 船と船、船と基地の物理ドッキングペア (shipId -> targetEntity)
  private readonly dockedPairs = new Map<string, GameEntity>();

  get activeBase(): Base | null { return this._activeBase; }

  constructor(
    private readonly pauseGame: () => void,
    private readonly resumeGame: () => void,
    private readonly hud: Hud,
    private readonly worldSfx: WorldSfx,
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
    this.baseView = new BaseView(this.hud.layers.view);
    this.baseView.onClose = () => this.viewManager.leaveDock();
    this.baseView.onLaunchVessel = (ship, base) => this.launch(ship, base);
    this.baseView.onBuildVessel = (base) => this.buildVessel(base);
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

  // ドッキング可能判定 (距離・ドックスロット前方正面判定・相対速度)
  canDock(ship: Player, target: GameEntity): boolean {
    if (!ship.alive || !target.alive || ship === target) return false;
    if (this.getDockedTarget(ship) === target) return false;
    const relSpeed = len(sub(ship.state.v, target.state.v));
    if (relSpeed > C.DOCK_CAPTURE_REL_V) return false;

    if (target instanceof Base) {
      if (target.baseState.dockedVessels.length >= C.BASE_MAX_VESSELS) return false;

      // 1) 基地の 4 箇所のドックスロットのいずれかの前方エリア判定
      for (let i = 0; i < C.BASE_MAX_VESSELS; i++) {
        const slotPos = target.getSlotWorldPos(i);
        const slotNormal = target.getSlotWorldNormal(i);
        const distToSlot = len(sub(ship.state.r, slotPos));
        if (distToSlot <= C.SLOT_DOCK_MAX_DIST) {
          const dirToShip = norm(sub(ship.state.r, slotPos));
          const alignment = dot(dirToShip, slotNormal);
          if (alignment >= C.SLOT_DOCK_MIN_ALIGNMENT) return true;
        }
      }

      // 2) または中央ハッチ前方エリア判定
      const hatchPos = target.getHatchWorldPos();
      const hatchNormal = target.getHatchWorldNormal();
      const distToHatch = len(sub(ship.state.r, hatchPos));
      if (distToHatch <= C.HATCH_DOCK_MAX_DIST) {
        const dirToShip = norm(sub(ship.state.r, hatchPos));
        const alignment = dot(dirToShip, hatchNormal);
        if (alignment >= C.HATCH_DOCK_MIN_ALIGNMENT) return true;
      }

      return false;
    }

    // 船対船ドッキングは従来の距離判定
    const dist = len(sub(ship.state.r, target.state.r));
    return dist <= C.DOCK_CAPTURE_DIST;
  }

  // 船または基地への物理ドッキングを実行。
  dockTo(ship: Player, target: GameEntity): void {
    if (!this.canDock(ship, target)) return;
    if (target instanceof Base) {
      this.storeInBase(ship, target);
    } else {
      this.dockedPairs.set(ship.id, target);
      // 相対速度をゼロにする
      ship.state = kinematicState(ship.state.t, ship.state.r, target.state.v);
      this.hud.hint(`${ship.name} が ${target.name || '対象'} にドッキングしました`);
    }
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
    this.setActiveBase(base);
  }

  private setActiveBase(base: Base | null): void {
    this._activeBase = base;
    this.onSelect?.(base?.id ?? null);
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
    this.setActiveBase(null);
    this.viewManager.leaveDock();
  }

  enterDock(): void {
    if (!this._activeBase || !this._activeBase.alive) {
      const available = this.getAvailableBases();
      if (available.length === 0) return;
      this.setActiveBase(available[0]!);
    }
    const base = this._activeBase!;
    this.pauseGame();
    this.baseView.open(base, this.activePlayers.current, this.activeStage.freeProcurement);
  }

  leaveDock(): void {
    this.baseView.close();
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

  // 手動で艦を基地へ収容する
  storeInBase(ship: Player, base: Base): void {
    if (!ship.alive || !base.alive) return;
    if (!this.entities.players.includes(ship)) return;
    if (this.entities.bases.some((candidate) =>
      candidate.baseState.dockedVessels.some((entry) => entry.id === ship.id || entry.player === ship))) return;
    if (base.baseState.dockedVessels.length >= C.BASE_MAX_VESSELS) {
      this.hud.hint(`基地のドックが満杯です (最大 ${C.BASE_MAX_VESSELS} 隻)`);
      return;
    }
    if (!this.canDock(ship, base)) return;
    const slotIndex = base.getAvailableSlotIndex() ?? 0;
    this.undock(ship);
    base.baseState.dockedVessels.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      player: ship,
      slotIndex,
    });
    base.attachDockedVesselMesh(ship, slotIndex);

    const wasActive = this.activePlayers.current === ship;
    this.mapActions.close();
    this.cameraSystem.mapCamera.clearFocusIf(ship.id);
    if (wasActive) {
      ship.clearTransientCommands();
      this.worldSfx.setThrust(false);
      this.worldSfx.setRcs(false);
    }
    this.entities.parkPlayer(ship);
    if (wasActive) {
      this.activePlayers.setOrNull(this.entities.players.find((p) => p.alive) ?? null);
      if (this.activePlayers.current === null) this.viewManager.setView('map');
    }
    this.hud.hint(`${ship.name} を基地のドック ${slotIndex + 1} に収納しました`);
  }

  private buildVessel(base: Base): void {
    if (base.baseState.dockedVessels.length >= C.BASE_MAX_VESSELS) {
      this.hud.hint(`基地のドックが満杯です (最大 ${C.BASE_MAX_VESSELS} 隻)`);
      return;
    }
    const slotIndex = base.getAvailableSlotIndex() ?? 0;
    const no = ++this.nextBuiltVesselNo;
    const id = `${base.id}-built-${no}`;
    const shipName = generateRandomName('player');
    const ship = new Player(this.hud, this.worldSfx, this.scene, this.effects, this.markerManager, { name: shipName, state: base.state, id });
    base.baseState.dockedVessels.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      player: ship,
      slotIndex,
    });
    base.attachDockedVesselMesh(ship, slotIndex);
    this.hud.hint(`${ship.name} を建造しました (ドック ${slotIndex + 1})`);
  }

  private launch(ship: Player, base: Base): void {
    const idx = base.baseState.dockedVessels.findIndex((s) => s.player === ship || s.id === ship.id);
    const slotIndex = idx >= 0 ? base.baseState.dockedVessels[idx]!.slotIndex : 0;

    if (idx >= 0) {
      base.baseState.dockedVessels.splice(idx, 1);
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
    this.entities.addPlayer(ship);
    this.activePlayers.set(ship);
    this.viewManager.setView('combat');
    this.hud.hint(`${ship.name} がドック ${slotIndex + 1} から切り離され発進しました`);
  }

  // 基地ビューの DOM を片付ける。
  dispose(): void {
    this.baseView.dispose();
  }
}
