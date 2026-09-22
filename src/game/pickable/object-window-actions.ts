// 物体窓が扱う共通操作の規則。対象固有の表示台帳から切り離し、メニューの可否・命令の振り分け・
// 関連対象の導出をここへ集める。
import type { PauseMenu } from '../../hud/windows/pause-menu';
import type {
  PropertyWindowContent, PropertyWindowItem, PropertyWindowRelatedItem,
} from '../../hud/windows/property-window-content';
import type { MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { CelestialEntity } from '../celestial/celestial-entity/celestial-entity';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { NavTargetPresenter } from '../nav-target-presenter';
import type { NavTargetSource } from '../viewer/nav-target-selection';
import type { NavTargetCommands } from '../viewer/nav-target-commands';
import type { EntityDisplaySource } from '../viewer/entity-display-selection';
import type { EntityDisplayCommands } from '../viewer/entity-display-commands';
import type { MapCameraSource } from '../viewer/camera-selection';
import type { FocusCameraCommands } from '../viewer/camera-commands';
import type { ViewSelectionSource } from '../viewer/view-selection';
import { focusTargetId } from '../viewer/focus-target';
import type { PlanEditor } from '../plan/plan-editor';
import type { ControlSelection } from '../control-selection';
import type { Stage } from '../stages/stage';
import { isModularShip } from '../ship/modular-ship';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import type { Targeter } from '../targeter';
import { orbitingAttractorOf } from '../../physics/attractor';
import type { ViewFrame } from '../view/view-frame';
import type { InspectedObject, ObjectAuthoring } from './inspected-object';
import { ShipInspection } from './ship-inspection';
import { EnemyInspection } from './enemy-inspection';
import { Pickup } from '../dynamic/dynamic-entity/pickup';
import { LagrangePointMarker } from '../marker/lagrange-point-marker';
import { OrbitPointMarker } from '../marker/orbit-point-marker';
import type { ObjectMenuCommands } from './object-menu-commands';
import type { PropertyWindowOpener } from './property-window-opener';
import { objectPickableOf } from './object-pickable';
import type { ModuleWindowOpener } from './module-windows';

export interface ObjectWindowParts {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly PropertyWindowItem<MenuAction>[];
}

export class ObjectWindowActions {
  public constructor(
    private readonly roster: EntityRoster,
    private readonly celestialBodies: CelestialBodies,
    private readonly navTarget: NavTargetSource,
    private readonly navTargetPresenter: NavTargetPresenter,
    private readonly navTargetCommands: NavTargetCommands,
    private readonly entityDisplay: EntityDisplaySource,
    private readonly entityDisplayCommands: Pick<EntityDisplayCommands, 'toggleTrajectoryLine'>,
    private readonly camera: MapCameraSource,
    private readonly view: Pick<ViewSelectionSource, 'current'>,
    private readonly activeView: () => ViewFrame,
    private readonly pauseMenu: PauseMenu,
    private readonly controlSelection: ControlSelection,
    private readonly mapFocusCommands: Pick<FocusCameraCommands, 'setFocus'>,
    private readonly combatFocusCommands: Pick<FocusCameraCommands, 'setFocus'>,
    private readonly activeStage: Stage,
    private readonly targeter: Targeter,
    private readonly moduleWindows: ModuleWindowOpener,
    private readonly commands: ObjectMenuCommands,
    private readonly hint: (message: string) => void,
  ) {}

  public inspectedEnemy(id: string): InspectedObject | null {
    const enemy = this.roster.all().filter(isEnemy).find((candidate) => candidate.id === id);
    return enemy ? objectPickableOf(enemy) : null;
  }

  public inspectedTarget(): InspectedObject | null {
    const target = this.targeter.aliveTarget;
    return target ? objectPickableOf(target) : null;
  }

  // 対象が組んだ項目のうち、いま実際に選べるものだけを残す。
  public offeredItems(target: InspectedObject, simTime: number): readonly MenuItem<MenuAction>[] {
    const all = target.menuItems(
      this.celestialBodies, this.controlSelection.current, this.navTarget.id,
      this.entityDisplay.showsTrajectoryLine(target.id));
    return all.filter((it) => {
      switch (it.act) {
        case 'target':
          return this.navTargetPresenter.canTarget(
            target.id, this.roster, this.celestialBodies, simTime);
        case 'duplicate':
        case 'openObjectPlacer':
          return this.authoring !== null;
        case 'planExecCycle':
          return this.activeStage.executesPlans;
        default:
          return true;
      }
    });
  }

  // 対象が差し出す項目を、窓のタイトル・サブタイトルと操作項目へ振り分ける。
  public windowParts(target: InspectedObject, simTime: number): ObjectWindowParts {
    const all = this.offeredItems(target, simTime);
    const header = all.find((it) => it.type === 'header');
    // 戦闘ビューで開いたウィンドウは項目ショートカットを持たせない — [F]/[T] は自機の
    // 進行方向リセット/ターゲット選択が既に使っており、同じキーを両方へは配れない。
    const showShortcuts = this.view.current === 'map';
    const items = all
      .filter((it) => it.type !== 'header' && it.act !== undefined)
      .map((it) => ({
        label: it.label, act: it.act as MenuAction,
        shortcut: showShortcuts ? it.shortcut : undefined,
        selected: it.selected, keepOpen: it.keepOpen,
      }));
    return { title: header?.label ?? target.name, subtitle: header?.subLabel, items };
  }

  public buildContent(
    target: InspectedObject, simTime: number, opener: PropertyWindowOpener,
  ): PropertyWindowContent<MenuAction> {
    const { title, subtitle, items } = this.windowParts(target, simTime);
    const kind = target instanceof CelestialEntity
      ? { kindCode: 'BDY', kindLabel: 'CELESTIAL BODY' }
      : target instanceof ShipInspection
        ? { kindCode: 'VSL', kindLabel: 'SPACECRAFT' }
        : target instanceof EnemyInspection
          ? { kindCode: 'CNT', kindLabel: 'CONTACT' }
          : target instanceof Pickup
            ? { kindCode: 'SUP', kindLabel: 'SUPPLY' }
            : target instanceof LagrangePointMarker
              ? { kindCode: 'POI', kindLabel: 'REFERENCE POINT' }
              : target instanceof OrbitPointMarker
                ? { kindCode: 'EVT', kindLabel: 'ORBIT EVENT' }
                : { kindCode: 'OBJ', kindLabel: 'OBJECT' };
    return {
      title,
      subtitle,
      ...kind,
      monitorWhenClipped: true,
      icon: target.glyphSvg ?? target.glyph,
      rows: [],
      items,
      relatedItems: this.relatedItemsFor(target, simTime, opener),
      relatedTitle: this.relatedTitleFor(target),
      onRename: target.rename === null ? undefined : (name) => this.commands.rename(target, name),
    };
  }

  // 選択された操作を処理する。視点や画面表示で完結する操作はその場で実行し、対象固有の操作は
  // 当該フレームの編集インターフェイスとともにコマンドキューへ積む。
  public runAct(target: InspectedObject, act: MenuAction): void {
    if (act === 'focus') this.focus(target.id, target.name);
    else if (act === 'target') this.navTargetCommands.toggle(target.id, target.name);
    else if (act === 'toggleTrajectoryLine') this.entityDisplayCommands.toggleTrajectoryLine(target.id);
    else if (act === 'openSettings') this.pauseMenu.toggle(true);
    else if (act === 'openObjectPlacer') {
      this.authoring?.openObjectPlacer(focusTargetId(this.camera.map.focus));
    } else {
      this.commands.runMenu(target, act, this.authoring, this.planEditor);
    }
  }

  // 窓の先頭に出す関連一覧。操作中の艦自身なら搭載部品、天体ならいまその天体を周回している物体、
  // それ以外は空。
  public relatedItemsFor(
    target: InspectedObject, pivot: number, opener: PropertyWindowOpener,
  ): readonly PropertyWindowRelatedItem[] {
    const controlled = this.controlSelection.current;
    if (controlled !== null && isModularShip(controlled) && target.id === controlled.id) {
      return controlled.assembly.modules.map((module) => {
        const label = controlled.assembly.definition(module.id)?.name ?? module.definitionId;
        return {
          id: `module:${controlled.id}:${module.id}`,
          label,
          onFocus: () => this.moduleWindows.openAtDefault(controlled, module.id),
          onContextMenu: (clientX: number, clientY: number) => {
            this.moduleWindows.open(controlled, module.id, clientX, clientY);
          },
        };
      });
    }
    if (!(target instanceof CelestialEntity)) return [];
    const related: { item: InspectedObject; label: string }[] = [];
    for (const item of this.activeView().pickables) {
      if (item.id === target.id) continue;
      const state = item.orbitState;
      const isOrbiting = state === null
        ? this.celestialBodies.bodyParentId(item.id) === target.id
        : orbitingAttractorOf(state, this.celestialBodies.celestialMotions, pivot)?.id === target.id;
      if (isOrbiting) related.push({ item, label: item.name });
    }
    related.sort((a, b) => a.label.localeCompare(b.label));
    return related.map(({ item, label }) => ({
      id: item.id,
      label,
      onFocus: () => {
        this.mapFocusCommands.setFocus({ kind: 'object', id: item.id });
        this.hint(`${label} にフォーカス`);
      },
      onContextMenu: (clientX, clientY) => {
        const current = this.activeView().pickables.find((candidate) => candidate.id === item.id);
        if (current) opener.openProperties(current, clientX, clientY);
      },
    }));
  }

  public relatedTitleFor(target: InspectedObject): string {
    const controlled = this.controlSelection.current;
    return controlled !== null && isModularShip(controlled) && target.id === controlled.id
      ? 'MODULES' : 'ORBITING';
  }

  // 表示中のビューのカメラの注視を id の対象へ移し、name で知らせる。
  private focus(id: string, name: string): void {
    if (this.view.current === 'map') {
      this.mapFocusCommands.setFocus({ kind: 'object', id });
    } else {
      this.combatFocusCommands.setFocus({ kind: 'object', id });
    }
    this.hint(`${name} にフォーカス`);
  }

  private get authoring(): ObjectAuthoring | null {
    return this.view.current === 'map' ? this.activeStage.authoring : null;
  }

  private get planEditor(): PlanEditor | null {
    return this.activeView().planEditor;
  }
}
