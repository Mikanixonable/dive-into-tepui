import * as THREE from 'three/webgpu';
import { v3, len, sub, dot, norm } from '../../math/vec3';
import { kinematicState } from '../../physics/kinematic-state';
import { Hud } from '../hud/hud';
import { BasePanel } from '../hud/panels/base-view';
import { ResourceTransferDialog } from '../hud/windows/resource-transfer-dialog';
import { Base, BASE_MAX_VESSELS } from '../dynamic/dynamic-entity/base';
import { Player } from '../player/player';
import { DockingGuide } from './docking-guide';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { ObjectWindows } from '../pickable/object-windows';
import type { CameraSystem } from '../camera/camera-system';
import type { WorldView } from '../world-view';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { ActivePlayerController } from '../active-controllable-controller';
import type { Stage } from '../stages/stage';
import { generateRandomName } from '../random-name';

const DOCK_CAPTURE_REL_V = 20;   // [m/s]

const PORT_DOCK_MAX_DIST = 50;          // [m] 船対船ポート間の最大捕捉距離
const PORT_DOCK_MIN_ALIGNMENT = 0.5;    // ポート軸の最小内積 (cos 60°)
const HATCH_DOCK_MAX_DIST = 80;        // 基地ハッチ前での最大ドッキング距離 [m]
const HATCH_DOCK_MIN_ALIGNMENT = 0.5;  // ハッチ正面コーンの最小内積 (cos 60° = 0.5)
const SLOT_DOCK_MAX_DIST = 50;         // 各ドックスロット前での最大ドッキング距離 [m]
const SLOT_DOCK_MIN_ALIGNMENT = 0.5;   // スロット正面コーンの最小内積 (cos 60° = 0.5)

type DockingCandidateKind = 'slot' | 'hatch' | 'ship';

// 判定とガイドが共有する接続点の評価結果。canDock だけでなく各残差を公開することで、
// 未整合・速度超過の接近もガイドに表示できる。
export interface DockingCandidate {
  readonly target: DynamicEntity;
  readonly kind: DockingCandidateKind;
  readonly position: ReturnType<typeof v3>;
  readonly normal: ReturnType<typeof v3>;
  readonly distance: number;
  readonly axisAlignment: number;
  readonly axisErrorDeg: number;
  readonly relSpeed: number;
  readonly distanceOk: boolean;
  readonly approachOk: boolean;
  readonly alignmentOk: boolean;
  readonly speedOk: boolean;
  readonly canDock: boolean;
  readonly slotIndex: number | null;
}

const alignmentErrorDeg = (alignment: number): number =>
  Math.acos(Math.max(-1, Math.min(1, alignment))) * 180 / Math.PI;

export class Docking {
  readonly basePanel: BasePanel;
  readonly transferDialog: ResourceTransferDialog;
  // 接続点ガイド。出すのは戦闘ビューの間だけなので、sync/hide はビュー側から呼ぶ。
  private readonly _guide: DockingGuide;
  get guide(): DockingGuide { return this._guide; }
  // 選択中/基地パネルの対象基地。
  private _activeBase: Base | null = null;
  // 新造艦艇の連番。基地をまたいで一意な id/表示名を割り振るだけの用途。
  private nextBuiltVesselNo = 0;

  // 船と船、船と基地の物理ドッキングペア (shipId -> targetEntity)
  private readonly dockedPairs = new Map<string, DynamicEntity>();

  get activeBase(): Base | null { return this._activeBase; }

  constructor(
    private readonly hud: Hud,
    private readonly worldSfx: WorldSfx,
    private readonly scene: THREE.Scene,
    private readonly effects: EffectsSystem,
    private readonly markerManager: MarkerManager,
    private readonly entities: DynamicSystem,
    private readonly objectWindows: ObjectWindows,
    private readonly cameraSystem: CameraSystem,
    // ビュー遷移の口(ViewManager.setView)。ViewManager より先に生成されるため、
    // 参照でなく閉包で受ける。
    private readonly setView: (view: WorldView) => void,
    private readonly activePlayers: ActivePlayerController,
    private readonly activeStage: Stage,
  ) {
    this.basePanel = new BasePanel();
    this.basePanel.onLaunchVessel = (ship, base) => this.launch(ship, base);
    this.basePanel.onBuildVessel = (base) => this.buildVessel(base);

    this.transferDialog = new ResourceTransferDialog(this.hud.layers.view, this.hud.overlayManager);
    this._guide = new DockingGuide(scene, markerManager, entities, this);
  }

  // 指定艦がドッキングしている対象を取得。ドッキングしていなければ null。
  getDockedTarget(ship: Player): DynamicEntity | null {
    const target = this.dockedPairs.get(ship.id);
    if (!target || !target.alive) {
      if (target) this.dockedPairs.delete(ship.id);
      return null;
    }
    return target;
  }

  // 候補評価を正本にしたドッキング可能判定。
  canDock(ship: Player, target: DynamicEntity): boolean {
    return this.evaluateCandidates(ship, target).some((candidate) => candidate.canDock);
  }

  // 指定対象の候補を返す。基地の占有済みスロットは候補から除外し、ハッチは常に
  // 評価する(ただし満杯なら canDock は false)。
  evaluateCandidates(ship: Player, target: DynamicEntity): DockingCandidate[] {
    if (!ship.alive || !target.alive || ship === target || this.getDockedTarget(ship) === target) return [];
    const portPos = ship.getPortWorldPos();
    const portNormal = norm(ship.getPortWorldNormal());
    const relSpeed = len(sub(ship.state.v, target.state.v));
    const speedOk = relSpeed <= DOCK_CAPTURE_REL_V;
    const candidates: DockingCandidate[] = [];
    const make = (
      kind: DockingCandidateKind,
      position: ReturnType<typeof v3>, normal: ReturnType<typeof v3>,
      maxDist: number, approachMinAlignment: number,
      slotIndex: number | null, approach: number,
      alignment: number, capacityOk: boolean,
    ): void => {
      const distance = len(sub(portPos, position));
      const distanceOk = distance <= maxDist;
      const approachOk = approach >= approachMinAlignment;
      const alignmentOk = alignment >= PORT_DOCK_MIN_ALIGNMENT;
      candidates.push({
        target, kind, position, normal, distance, axisAlignment: alignment,
        axisErrorDeg: alignmentErrorDeg(alignment), relSpeed,
        distanceOk, approachOk, alignmentOk, speedOk, slotIndex,
        canDock: capacityOk && distanceOk && approachOk && alignmentOk && speedOk,
      });
    };

    if (target instanceof Base) {
      const occupied = new Set(target.baseState.dockedVessels.map((entry) => entry.slotIndex));
      const capacityOk = target.baseState.dockedVessels.length < BASE_MAX_VESSELS;
      for (let i = 0; i < BASE_MAX_VESSELS; i++) {
        if (occupied.has(i)) continue;
        const position = target.getSlotWorldPos(i);
        const normal = norm(target.getSlotWorldNormal(i));
        const toShip = norm(sub(portPos, position));
        // 基地接続面の正面側 (位置) と、船軸の進入方向 (姿勢) は別条件。
        make('slot', position, normal, SLOT_DOCK_MAX_DIST, SLOT_DOCK_MIN_ALIGNMENT, i,
          dot(toShip, normal), -dot(portNormal, normal), capacityOk);
      }
      const position = target.getHatchWorldPos();
      const normal = norm(target.getHatchWorldNormal());
      const toShip = norm(sub(portPos, position));
      make('hatch', position, normal, HATCH_DOCK_MAX_DIST, HATCH_DOCK_MIN_ALIGNMENT, null,
        dot(toShip, normal), -dot(portNormal, normal), capacityOk);
      return candidates;
    }

    if (target instanceof Player) {
      const targetPortPos = target.getPortWorldPos();
      const targetPortNormal = norm(target.getPortWorldNormal());
      const toTarget = norm(sub(targetPortPos, portPos));
      const toShip = norm(sub(portPos, targetPortPos));
      const facing = -dot(portNormal, targetPortNormal);
      // 船対船では各ポートの法線が相手方向を向くことも必要にする。
      const approach = Math.min(dot(portNormal, toTarget), dot(targetPortNormal, toShip));
      make('ship', targetPortPos, targetPortNormal, PORT_DOCK_MAX_DIST, PORT_DOCK_MIN_ALIGNMENT,
        null, approach, facing, true);
    }
    return candidates;
  }

  private bestDockingCandidate(ship: Player, target: DynamicEntity): DockingCandidate | null {
    return this.evaluateCandidates(ship, target)
      .filter((candidate) => candidate.canDock)
      .sort((a, b) => a.distance - b.distance)[0] ?? null;
  }

  // 船または基地への物理ドッキングを実行。
  dockTo(ship: Player, target: DynamicEntity): void {
    const candidate = this.bestDockingCandidate(ship, target);
    if (!candidate) return;
    if (target instanceof Base) {
      this.storeInBase(ship, target, candidate.slotIndex);
    } else {
      this.dockedPairs.set(ship.id, target);
      // 相対速度をゼロにする
      ship.state = kinematicState<'eci'>(ship.state.t, ship.state.r, target.state.v);
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
  openTransfer(ship: Player, target: Player): void {
    this.transferDialog.open(ship, target);
  }

  // 基地を選択状態にする
  selectBase(base: Base): void {
    this.setActiveBase(base);
  }

  private setActiveBase(base: Base | null): void {
    this._activeBase = base;
  }

  // 基地を選択し、プロパティウィンドウへ埋め込むパネルを開く。
  openPanel(base: Base): HTMLElement {
    this.selectBase(base);
    this.basePanel.open(base, this.activePlayers.current, this.activeStage.freeProcurement);
    return this.basePanel.element;
  }

  clearActiveBaseIf(base: Base): void {
    if (this._activeBase !== base) return;
    this.setActiveBase(null);
    this.basePanel.close();
  }

  closePanel(): void {
    this.basePanel.close();
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
      ship.state = kinematicState<'eci'>(ship.state.t, ship.state.r, target.state.v);
    }
  }

  // 手動で艦を基地へ収容する
  storeInBase(ship: Player, base: Base, slotIndex: number | null = null): void {
    if (!ship.alive || !base.alive) return;
    if (!this.entities.players.includes(ship)) return;
    if (this.entities.bases.some((candidate) =>
      candidate.baseState.dockedVessels.some((entry) => entry.id === ship.id || entry.player === ship))) return;
    if (base.baseState.dockedVessels.length >= BASE_MAX_VESSELS) {
      this.hud.hint(`基地のドックが満杯です (最大 ${BASE_MAX_VESSELS} 隻)`);
      return;
    }
    const candidate = this.bestDockingCandidate(ship, base);
    if (!candidate) return;
    // スロットへ直接入る候補はそのスロットを保持し、ハッチ候補だけ格納時に空きを選ぶ。
    const selectedSlot = slotIndex ?? candidate.slotIndex ?? base.getAvailableSlotIndex();
    if (selectedSlot === null || selectedSlot === undefined) return;
    if (base.baseState.dockedVessels.some((entry) => entry.slotIndex === selectedSlot)) return;
    this.undock(ship);
    base.baseState.dockedVessels.push({
      id: ship.id,
      name: ship.name,
      hp: ship.hp,
      maxHp: ship.maxHp,
      parts: ship.parts,
      player: ship,
      slotIndex: selectedSlot,
    });
    base.attachDockedVesselMesh(ship, selectedSlot);

    const wasActive = this.activePlayers.current === ship;
    this.objectWindows.close();
    this.cameraSystem.mapCamera.clearFocusIf(ship.id);
    if (wasActive) {
      ship.clearTransientCommands();
      this.worldSfx.setThrust(false);
      this.worldSfx.setRcs(false);
    }
    this.entities.parkPlayer(ship);
    if (wasActive) {
      this.activePlayers.setOrNull(this.entities.players.find((p) => p.alive) ?? null);
      if (this.activePlayers.current === null) this.setView('map');
    }
    this.hud.hint(`${ship.name} を基地のドック ${selectedSlot + 1} に収納しました`);
  }

  private buildVessel(base: Base): void {
    if (base.baseState.dockedVessels.length >= BASE_MAX_VESSELS) {
      this.hud.hint(`基地のドックが満杯です (最大 ${BASE_MAX_VESSELS} 隻)`);
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

    ship.state = kinematicState<'eci'>(base.state.t, launchPos, launchVel);
    this.entities.addPlayer(ship);
    this.activePlayers.set(ship);
    this.setView('combat');
    this.hud.hint(`${ship.name} がドック ${slotIndex + 1} から切り離され発進しました`);
  }

  dispose(): void {
    this.basePanel.dispose();
    this._guide.dispose();
  }
}
