// 被選択物(MapPickable)の種別ごとに、コンテキストメニュー/プロパティウィンドウの操作項目と、
// 選ばれた操作の実行先を対応づける。候補集合と表示可否は map-pickables.ts の MapPickables が
// 持つ — 「何が選べるか」と「選んだらどうなるか」を分けている。
import { Hud } from '../hud/hud';
import type { Base } from '../dynamic/dynamic-entity/base';
import { isLagrangeId, lagrangeParentId, lagrangePointOf } from '../celestial/lagrange-id';
import { MapPickable } from './map-pickable';
import { focusTargetId } from '../camera/focus-target';
import { DynamicSystem } from '../dynamic/dynamic-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import { NavTarget } from '../nav-target';
import { CameraSystem } from '../camera/camera-system';
import { PlanEditor } from '../plan/plan-editor';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { getApsisLabelSpec, ORBIT_ELEMENT_LABELS } from '../hud/orbit/orbit-labels';
import type { Docking } from '../docking/docking';
import type { ActivePlayerController } from '../active-controllable-controller';
import type { FrameControls } from '../hud/frame/frame-controls';
import type { Stage } from '../stages/stage';
import { planExecutionLabel, type PlanExecutionMode } from '../player/player';
import { MenuAction, MenuCommon, MenuItem, type PauseMenu } from '../hud/windows';
import type { ObjectType } from '../creative/object-placer-panel';
import type { KinematicState } from '../../physics/kinematic-state';
import { strongestAttractor } from '../../physics/attractor';
import type { MapPickables } from './map-pickables';

interface PickHandler {
  itemsFor(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[];
  run(act: MenuAction, target: MapPickable): void;
}

// 軌道計画の実行モードの巡回順。ボタン1つで次のモードへ進める。
const PLAN_EXECUTION_MODES: readonly PlanExecutionMode[] = ['off', 'instant'];

// 天体候補の親を解決する。通常の天体は運動の主天体から、ラグランジュ点は ID の親部分から
// 解決する。MapPickable は通常天体と派生したラグランジュ点をどちらも kind:'body' で表すため、
// 未登録の文字列を主天体の解決へ渡さない境界をここに置く。
// undefined は候補が不正/古い、null は恒星など親を持たない天体を表す。
export function bodyParentId(celestialSystem: CelestialSystem, id: string): string | null | undefined {
  const lagrangeParent = isLagrangeId(id) ? lagrangeParentId(id) : undefined;
  if (lagrangeParent !== undefined) return celestialSystem.has(lagrangeParent) ? lagrangeParent : undefined;
  const body = celestialSystem.find(id);
  if (body === null) return undefined;
  return body.motion.primary?.id ?? null;
}

export class MapPickableMenu {
  // Docking は MapContextActions より後に生成されるので、生成後に登録する。
  setDocking(docking: Docking): void {
    this.docking = docking;
  }
  private docking: Docking | null = null;

  setControlledBaseHandler(handler: (base: Base | null) => void, getControlledBase: () => Base | null): void {
    this.controlBaseHandler = handler;
    this.getControlledBase = getControlledBase;
  }
  private controlBaseHandler: ((base: Base | null) => void) | null = null;
  private getControlledBase: (() => Base | null) | null = null;

  constructor(
    private readonly hud: Hud,
    private readonly entities: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly editor: PlanEditor,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly pauseMenu: PauseMenu,
    private readonly pickables: MapPickables,
    private readonly activePlayers: ActivePlayerController,
    private readonly frameControls: FrameControls,
    private readonly activeStage: Stage,
    // 基地パネルが対象の分だけ展開中かどうか。展開状態そのものは MapContextActions の
    // ウィンドウ台帳が持つので、ここでは都度問い合わせるだけにする。
    private readonly isBaseWindowExpanded: (target: MapPickable) => boolean,
  ) {}

  // 被選択物の種別に応じたコンテキストメニュー項目。
  itemsFor(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[] {
    const handler = this.handlers[target.kind];
    return handler ? handler.itemsFor(target, simTime) : [];
  }

  // メニュー/プロパティウィンドウで選ばれた操作を実行する。対応する種別のハンドラがなければ
  // 何もしない。
  run(act: MenuAction, target: MapPickable): void {
    const handler = this.handlers[target.kind];
    if (handler) handler.run(act, target);
  }

  private readonly handlers: Record<MapPickable['kind'], PickHandler> = {
    'body': {
      itemsFor: (target, simTime) => {
        let subLabel = '天体・ラグランジュ点';
        const lagrange = lagrangePointOf(target.id);
        if (lagrange !== null) {
          const secondary = lagrange.parentId;
          const primary = bodyParentId(this.celestialSystem, secondary);
          subLabel = primary === undefined || primary === null
            ? 'ラグランジュ点'
            : `${this.celestialSystem.nameOf(primary)}-${this.celestialSystem.nameOf(secondary)} ラグランジュ点`;
        } else if (target.id === this.celestialSystem.origin.id) subLabel = '母星 (中心天体)';
        else if (target.id === 'moon') subLabel = '衛星 (月)';
        else if (target.id === this.celestialSystem.star?.id) subLabel = `恒星 (${target.name})`;
        return [
          { type: 'header', label: target.name, subLabel },
          MenuCommon.focus(),
          ...this.targetItems(target, simTime),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runBodyShip(act, target),
    },
    'ship': {
      itemsFor: (target, simTime) => {
        const enemy = this.entities.findEnemy(target.id);
        const trajectoryItem: readonly MenuItem<MenuAction>[] = enemy
          ? [MenuCommon.trajectoryLine(enemy.showTrajectoryLine)] : [];
        return [
          ...this.targetItems(target, simTime),
          MenuCommon.focus(),
          ...trajectoryItem,
          ...this.duplicateItems(),
          { label: '削除', act: 'delete' },
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        const enemy = this.entities.findEnemy(target.id);
        if (act === 'delete') {
          if (enemy) enemy.alive = false;
        } else if (act === 'toggleTrajectoryLine') {
          if (enemy) enemy.showTrajectoryLine = !enemy.showTrajectoryLine;
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'ammo': {
      itemsFor: (target, simTime) => [
        MenuCommon.focus(),
        ...this.targetItems(target, simTime),
        ...this.duplicateItems(),
        { label: '削除', act: 'delete' },
        MenuCommon.cancel(),
      ],
      run: (act, target) => {
        if (act === 'delete') {
          const ammoPickup = this.entities.ammoPickups.find((candidate) => candidate.id === target.id);
          if (ammoPickup) ammoPickup.alive = false;
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'fuel': {
      itemsFor: (target, simTime) => [
        MenuCommon.focus(),
        ...this.targetItems(target, simTime),
        ...this.duplicateItems(),
        { label: '削除', act: 'delete' },
        MenuCommon.cancel(),
      ],
      run: (act, target) => {
        if (act === 'delete') {
          const pickup = this.entities.rcsFuelPickups.find((candidate) => candidate.id === target.id);
          if (pickup) pickup.alive = false;
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'apsis': {
      itemsFor: (target, simTime) => {
        const centerId = strongestAttractor(
          target.pos, this.celestialSystem.celestialMotions, simTime).id;
        const peOrAp = target.id === 'apsisAp' ? 'ap' : 'pe';
        const spec = getApsisLabelSpec(peOrAp, centerId);
        return [
          { type: 'header', label: spec.nameJa, subLabel: spec.nameEn },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'relnode': {
      itemsFor: (target) => {
        const spec = target.id === 'nav-an' ? ORBIT_ELEMENT_LABELS.an
          : target.id === 'nav-dn' ? ORBIT_ELEMENT_LABELS.dn : ORBIT_ELEMENT_LABELS.ca;
        return [
          { type: 'header', label: spec.nameJa, subLabel: spec.nameEn },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'eqnode': {
      itemsFor: (target, simTime) => {
        const isAn = target.id.startsWith('eqan-');
        const spec = isAn ? ORBIT_ELEMENT_LABELS.eqAn : ORBIT_ELEMENT_LABELS.eqDn;
        const centerName = this.celestialSystem.nameOf(
          strongestAttractor(target.pos, this.celestialSystem.celestialMotions, simTime).id);
        const label = `${centerName}${spec.nameJa}`;
        return [
          { type: 'header', label, subLabel: spec.nameEn },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'player': {
      itemsFor: (target, simTime) => {
        const ship = this.entities.findPlayer(target.id);
        const activeShip = this.activePlayers.current;
        const isActive = ship === activeShip;
        const activate: readonly MenuItem<MenuAction>[] = [
          isActive ? { label: '操作対象を解除', act: 'deactivate' } : { label: '操作対象にする', act: 'activate' },
        ];
        const remove: readonly MenuItem<MenuAction>[] = isActive ? [] : [{ label: '削除', act: 'delete' }];
        const mode = ship?.planExecution ?? 'off';
        const planExec: readonly MenuItem<MenuAction>[] = this.activeStage.executesPlans
          ? [{ label: `軌道計画の実行: ${planExecutionLabel(mode)}`, act: 'planExecCycle', keepOpen: true }]
          : [];

        const dockItems: MenuItem<MenuAction>[] = [];
        if (activeShip && ship && !isActive && this.docking) {
          const isDocked = this.docking.getDockedTarget(activeShip) === ship;
          if (isDocked) {
            dockItems.push(MenuCommon.transferResources(), MenuCommon.undock());
          } else if (this.docking.canDock(activeShip, ship)) {
            dockItems.push(MenuCommon.dock());
          }
        }
        // 操作対象の自艦は常に予測線・過去線固定なのでトグル自体を出さない。
        const trajectoryItem: readonly MenuItem<MenuAction>[] = (!isActive && ship)
          ? [MenuCommon.trajectoryLine(ship.showTrajectoryLine)] : [];

        return [
          ...this.targetItems(target, simTime),
          ...dockItems,
          ...planExec,
          ...activate,
          MenuCommon.focus(),
          ...trajectoryItem,
          ...this.duplicateItems(),
          ...remove,
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        const activeShip = this.activePlayers.current;
        const ship = this.entities.findPlayer(target.id);
        if (act === 'toggleTrajectoryLine') {
          if (ship) ship.showTrajectoryLine = !ship.showTrajectoryLine;
        } else if (act === 'dock') {
          if (activeShip && ship) this.docking?.dockTo(activeShip, ship);
        } else if (act === 'undock') {
          if (activeShip) this.docking?.undock(activeShip);
        } else if (act === 'transferResources') {
          if (activeShip && ship) this.docking?.openTransfer(activeShip, ship);
        } else if (act === 'activate') {
          if (ship) this.activePlayers.set(ship);
        } else if (act === 'deactivate') {
          if (ship === this.activePlayers.current) this.activePlayers.setOrNull(null);
        } else if (act === 'planExecCycle') {
          if (ship) {
            const next = PLAN_EXECUTION_MODES[(PLAN_EXECUTION_MODES.indexOf(ship.planExecution) + 1) % PLAN_EXECUTION_MODES.length]!;
            ship.planExecution = next;
          }
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else if (act === 'delete') {
          if (ship) this.activePlayers.remove(ship);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'empty-space': {
      itemsFor: () => {
        const placeItem: readonly MenuItem<MenuAction>[] = this.activeStage.authoring && this.cameraSystem.overviewMode
          ? [{ label: 'オブジェクトを配置する', act: 'openObjectPlacer', shortcut: 'Enter' }]
          : [];
        return [
          ...placeItem,
          { label: '設定メニューを開く', act: 'openSettings' },
          MenuCommon.cancel(),
        ];
      },
      run: (act) => {
        if (act === 'openObjectPlacer') {
          this.activeStage.authoring?.openObjectPlacer(
            focusTargetId(this.cameraSystem.mapCamera.focus));
        } else if (act === 'openSettings') {
          this.pauseMenu.toggle(true);
        }
      },
    },
    'base': {
      itemsFor: (target, simTime) => {
        const base = this.entities.findBase(target.id);
        const activeShip = this.activePlayers.current;
        const isControlled = base && this.getControlledBase ? this.getControlledBase() === base : false;
        const subLabel = base
          ? `基地 / 所持金: ${base.baseState.money.toLocaleString()} Cr / 格納艦艇: ${base.baseState.dockedVessels.length}隻`
          : '基地';

        const dockItems: MenuItem<MenuAction>[] = [];
        if (activeShip && base && this.docking) {
          if (this.docking.canDock(activeShip, base)) {
            dockItems.push(MenuCommon.dock());
          }
        }

        const controlItem: readonly MenuItem<MenuAction>[] = base
          ? [isControlled
            ? { label: '操作対象を解除', act: 'deactivate' }
            : { label: '操作対象にする', act: 'activate' }]
          : [];
        const trajectoryItem: readonly MenuItem<MenuAction>[] = base
          ? [MenuCommon.trajectoryLine(base.showTrajectoryLine)] : [];

        return [
          { type: 'header', label: base?.name ?? target.name, subLabel },
          ...this.targetItems(target, simTime),
          ...controlItem,
          ...dockItems,
          {
            label: this.isBaseWindowExpanded(target) ? '基地パネルを収納' : '基地パネルを展開',
            act: 'toggleBasePanel', keepOpen: true,
          },
          MenuCommon.focus(),
          ...trajectoryItem,
          ...this.duplicateItems(),
          { label: '削除', act: 'delete' },
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        const base = this.entities.findBase(target.id);
        const activeShip = this.activePlayers.current;
        if (act === 'activate') {
          if (base) this.activePlayers.setBase(base);
        } else if (act === 'deactivate') {
          if (base && this.activePlayers.controlledBase === base) this.activePlayers.setBase(null);
        } else if (act === 'activateBase') {
          if (base && this.controlBaseHandler) this.controlBaseHandler(base);
        } else if (act === 'deactivateBase') {
          if (this.controlBaseHandler) this.controlBaseHandler(null);
        } else if (act === 'toggleTrajectoryLine') {
          if (base) base.showTrajectoryLine = !base.showTrajectoryLine;
        } else if (act === 'dock') {
          if (activeShip && base) this.docking?.dockTo(activeShip, base);
        } else if (act === 'delete') {
          if (base) {
            if (this.getControlledBase?.() === base) this.controlBaseHandler?.(null);
            this.docking?.clearActiveBaseIf(base);
            base.alive = false;
          }
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
  };

  // ターゲットに設定/解除する項目。軌道面が定まらない対象(地球・太陽自身など)では選んでも
  // AN/DN が出ないので項目自体を出さない。マップビュー・戦闘ビューどちらでも同じ項目を出す。
  private targetItems(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[] {
    if (target.id === this.navTarget.id) return [MenuCommon.target(true)];
    const canTarget = this.navTarget.canTarget(target.id, this.entities, this.celestialSystem, simTime);
    return canTarget ? [MenuCommon.target(false)] : [];
  }

  // 「複製」項目。複製先が物体配置パネルなので、それを持つステージだけに出す。
  private duplicateItems(): readonly MenuItem<MenuAction>[] {
    return this.activeStage.authoring ? [MenuCommon.duplicate()] : [];
  }

  // 対象の現在状態を軌道要素へ逆算し、その値をプリセットして物体配置パネルを開く。
  private runDuplicate(target: MapPickable): void {
    const authoring = this.activeStage.authoring;
    if (!authoring) return;
    const source = this.duplicateSourceFor(target);
    if (!source) return;
    authoring.openObjectPlacerForDuplicate(source.objectType, source.state);
  }

  // MapPickable を、複製できる実体の種類とその現在状態へ解決する。複製できない種別(天体・
  // 近点/遠点アイコン・相対AN/DN)ではメニュー自体を出していないので、ここに到達しない。
  private duplicateSourceFor(target: MapPickable): { objectType: ObjectType; state: KinematicState } | null {
    switch (target.kind) {
      case 'player': {
        const ship = this.entities.findPlayer(target.id);
        return ship ? { objectType: 'player', state: ship.state } : null;
      }
      case 'ship': {
        const enemy = this.entities.findEnemy(target.id);
        return enemy ? { objectType: 'enemy', state: enemy.state } : null;
      }
      case 'ammo': {
        const ammoPickup = this.entities.ammoPickups.find((candidate) => candidate.id === target.id);
        return ammoPickup ? { objectType: 'ammo', state: ammoPickup.state } : null;
      }
      case 'fuel': {
        const pickup = this.entities.rcsFuelPickups.find((candidate) => candidate.id === target.id);
        return pickup ? { objectType: 'fuel', state: pickup.state } : null;
      }
      case 'base': {
        const base = this.entities.findBase(target.id);
        return base ? { objectType: 'base', state: base.state } : null;
      }
      default:
        return null;
    }
  }

  private runBodyShip(act: MenuAction, target: MapPickable): void {
    if (act === 'focus') {
      this.frameControls.setFocus({ kind: 'object', id: target.id });
      this.hud.hint(`${target.name} にフォーカス`);
    } else if (act === 'target') {
      this.navTarget.toggleTarget(target.id, target.name);
    }
  }

  private runApsisRelnode(act: MenuAction, target: MapPickable): void {
    if (act === 'warp') {
      const t = target.time ?? (target.kind === 'apsis'
        ? this.editor.planDisplay.apsisTimeOf(target.id)
        : this.navTarget.passTimeOf(target.id));
      if (t !== null && !this.simSpeedManager.startAutoWarpTo(t, this.pickables.lastSimTime)) {
        this.hud.hint('この時刻は既に通過しています');
      }
    } else if (act === 'addNode') {
      const t = target.time ?? (target.kind === 'apsis'
        ? this.editor.planDisplay.apsisTimeOf(target.id)
        : this.navTarget.passTimeOf(target.id));
      if (t !== null) this.editor.addNodeAt(t);
      else this.hud.hint('この時刻の計画軌道が求まりません');
    } else {
      this.runBodyShip(act, target);
    }
  }
}
