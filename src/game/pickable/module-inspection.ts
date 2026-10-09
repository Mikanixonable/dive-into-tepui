// 船体の搭載モジュールから、検査ウィンドウの表示内容と選べる操作を導出する。
import type { PropertyWindowContent, PropertyWindowItem } from '../../hud/windows/property-window-content';
import type { ShipAssembly } from '../ship/ship-assembly';
import type { ShipDockState } from '../ship/ship-dock-state';
import type { ShipModuleInstance } from '../ship/ship-module-instance';

// 検査に必要な船体の読み取り面。
export interface ModuleInspectionShip {
  readonly name: string;
  readonly assembly: ShipAssembly;
  readonly docks: Pick<ShipDockState, 'status'>;
  readonly capabilities: { readonly operatingCockpitId: string | null };
}

export type ModuleInspectionAction =
  | 'deployModule' | 'stowModule' | 'toggleBoosterModule' | 'decoupleModule' | 'selectCockpitModule'
  | 'repairDockedModules' | 'undockModule' | 'startConstructionModule' | 'dockModule';

// 損耗率を0〜100%へ収め、残存HPを併記する。
function wearText(module: ShipModuleInstance, maxHp: number): string {
  const wear = maxHp > 0 ? Math.max(0, Math.min(1, 1 - module.hp / maxHp)) : 1;
  return `${(wear * 100).toFixed(1)}% (${Math.floor(module.hp)} / ${maxHp})`;
}

// モジュールの種別と接続状態に応じた操作項目を返す。
export function moduleItems(ship: ModuleInspectionShip, module: ShipModuleInstance): PropertyWindowItem<ModuleInspectionAction>[] {
  if (module.kind === 'radiator' || module.kind === 'solar_panel') return [
    { label: '展開', act: 'deployModule', keepOpen: true },
    { label: '収納', act: 'stowModule', keepOpen: true },
  ];
  if (module.kind === 'booster') return [{
    label: module.ignited ? '燃焼停止' : '点火', act: 'toggleBoosterModule', keepOpen: true,
  }];
  if (module.kind === 'decoupler') return [{ label: 'この接続を分離', act: 'decoupleModule' }];
  if (module.kind === 'cockpit') return [{
    label: ship.capabilities.operatingCockpitId === module.id ? '操作基準コックピット' : '操作基準に設定',
    act: 'selectCockpitModule', keepOpen: true,
  }];
  // 接続状態に応じて接舷・建造・発進を提示する。
  if (module.kind === 'dock' || module.kind === 'docking_port') {
    const status = ship.docks.status(ship.assembly, module.id);
    return status === 'connected'
      ? [
        ...(module.kind === 'dock' && ship.assembly.isDockingPortOccupied(module.id)
          ? [{ label: '接続船体を修理', act: 'repairDockedModules' as const, keepOpen: true }]
          : []),
        { label: '接続を解除して発進', act: 'undockModule' as const },
      ]
      : [
        ...(module.kind === 'dock'
          ? [{ label: status === 'building' ? '建造を再開' : '船体を建造', act: 'startConstructionModule' as const }]
          : []),
        ...(status === 'empty'
          ? [{ label: '近傍船を接舷', act: 'dockModule' as const }]
          : []),
      ];
  }
  return [];
}

// モジュールの見出し・状態・操作項目を、その時点の船体から導出する。
export function moduleContent(ship: ModuleInspectionShip, module: ShipModuleInstance): PropertyWindowContent<ModuleInspectionAction> {
  const definition = ship.assembly.definition(module.id);
  const label = definition?.name ?? module.definitionId;
  // 資源を持つ部品には残量と容量を併記する。
  const resource = module.kind === 'tank' || module.kind === 'booster'
    ? [{
      key: 'fuel', label: '燃料',
      value: `${module.fuel.toFixed(1)} / ${definition?.abilities.fuelCapacity ?? 0}`,
      presentation: 'major' as const,
    }]
    : [];
  // 部品の識別と状態を継続観察できる内容へ写す。
  return {
    title: label,
    subtitle: `取り付け艦: ${ship.name}`,
    kindCode: 'MOD',
    kindLabel: 'MODULE',
    monitorWhenClipped: true,
    rows: [
      {
        key: 'wear', label: '損耗度', value: wearText(module, definition?.maxHp ?? 0),
        presentation: 'hero',
      },
      {
        key: 'temperature', label: '温度', value: `${module.temperature.toFixed(0)} K`,
        presentation: 'major',
      },
      ...resource,
      { key: 'kind', label: '種別', value: module.kind },
      { key: 'ship', label: '取り付け艦', value: ship.name },
    ],
    items: moduleItems(ship, module),
  };
}
