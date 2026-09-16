// 自艦の搭載モジュールのプロパティウィンドウ。モジュール1つにつき高々1枚を保ち、展開できるものの
// 展開/収納を実行する。排他グループを持たせず、被選択物のウィンドウと共存させる。
import { PropertyWindow } from '../../hud/windows/property-window';
import type { PropertyWindowContent, PropertyWindowItem } from '../../hud/windows/property-window-content';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { ControlSelection } from '../control-selection';
import type { HudLayers } from '../hud/hud-layers';
import type { ModularShip } from '../ship/modular-ship';
import type { ShipModuleInstance } from '../ship/ship-module-instance';

interface ModuleWindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  readonly ship: ModularShip;
  readonly moduleId: string;
}

function wearText(module: ShipModuleInstance, maxHp: number): string {
  const wear = maxHp > 0 ? Math.max(0, Math.min(1, 1 - module.hp / maxHp)) : 1;
  return `${(wear * 100).toFixed(1)}% (${Math.floor(module.hp)} / ${maxHp})`;
}

// 展開・収納を選べるモジュールにだけ操作項目を出す。
function deploymentItems(module: ShipModuleInstance): PropertyWindowItem<MenuAction>[] {
  if (module.kind !== 'radiator' && module.kind !== 'solar_panel') return [];
  return [
    { label: '展開', act: 'deployModule', keepOpen: true },
    { label: '収納', act: 'stowModule', keepOpen: true },
  ];
}

export class ModuleWindows {
  private readonly windows = new Map<string, ModuleWindowEntry>();

  constructor(
    private readonly hud: HudLayers,
    private readonly controlSelection: ControlSelection,
  ) {}

  // モジュールのウィンドウを開く。既に開いていればクリック位置へ動かして最前面に出すだけにする。
  open(ship: ModularShip, moduleId: string, clientX: number, clientY: number): void {
    const module = ship.assembly.module(moduleId);
    if (module === null) return;
    const key = `${ship.id}:${moduleId}`;
    const existing = this.windows.get(key);
    if (existing) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const win = new PropertyWindow<MenuAction>(
      this.hud.layers.window, clientX, clientY, this.content(ship, module), this.hud.overlayManager,
    );
    this.windows.set(key, { win, ship, moduleId });
    win.onSelect = (act) => {
      if (ship.inspection.hasModule(moduleId)) {
        ship.inspection.setModuleDeployment(moduleId, act === 'deployModule');
      }
    };
    win.onClose = () => { this.windows.delete(key); };
  }

  // その艦のモジュールウィンドウをすべて畳む。
  closeFor(shipId: string): void {
    for (const entry of [...this.windows.values()]) {
      if (entry.ship.id === shipId) entry.win.close();
    }
  }

  // 開いている各ウィンドウの値を最新化する。操作対象から外れた艦・失われたモジュールは閉じる。
  sync(): void {
    for (const entry of [...this.windows.values()]) {
      const { ship, moduleId } = entry;
      const module = ship.assembly.module(moduleId);
      if (!ship.motion.alive
        || ship !== this.controlSelection.current
        || module === null) {
        entry.win.close();
        continue;
      }
      const label = ship.assembly.definition(moduleId)?.name ?? module.definitionId;
      entry.win.syncHeader(label, `取り付け艦: ${ship.name}`);
      entry.win.syncRows(this.content(ship, module).rows);
      entry.win.syncItems(deploymentItems(module));
    }
  }

  // 開いているウィンドウをすべて畳む。
  close(): void {
    for (const entry of [...this.windows.values()]) entry.win.close();
  }

  // ウィンドウ1枚ぶんの見出し・行・操作項目。
  private content(ship: ModularShip, module: ShipModuleInstance): PropertyWindowContent<MenuAction> {
    const definition = ship.assembly.definition(module.id);
    const label = definition?.name ?? module.definitionId;
    const resource = module.kind === 'tank' || module.kind === 'booster'
      ? [{ key: 'fuel', label: '燃料', value: `${module.fuel.toFixed(1)} / ${definition?.abilities.fuelCapacity ?? 0}` }]
      : [];
    return {
      title: label,
      subtitle: `取り付け艦: ${ship.name}`,
      rows: [
        { key: 'name', label: 'モジュール', value: label },
        { key: 'kind', label: '種別', value: module.kind },
        { key: 'ship', label: '取り付け艦', value: ship.name },
        { key: 'wear', label: '損耗度', value: wearText(module, definition?.maxHp ?? 0) },
        { key: 'temperature', label: '温度', value: `${module.temperature.toFixed(0)} K` },
        ...resource,
      ],
      items: deploymentItems(module),
    };
  }
}
