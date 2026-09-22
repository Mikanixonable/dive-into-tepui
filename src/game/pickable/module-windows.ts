// 自艦の搭載モジュールに関するプロパティウィンドウ。モジュール1つにつき最大1枚を維持し、
// 展開可能なモジュールの展開や収納を制御する。排他グループは持たせず、選択対象ウィンドウと共存させる。
import { PropertyWindow } from '../../hud/windows/property-window';
import type { PropertyWindowContent, PropertyWindowItem } from '../../hud/windows/property-window-content';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { ControlSelection } from '../control-selection';
import type { HudLayers } from '../hud/hud-layers';
import { ModularShip } from '../ship/modular-ship';
import type { ShipModuleInstance } from '../ship/ship-module-instance';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { Notifier } from '../../hud/notifier';
import { dockingEligibility } from '../ship/ship-docking';
import type { ShipConstruction } from '../ship/ship-construction';
import type { ConfirmationOverlay } from '../../hud/windows/confirmation-overlay';

type ModuleAction = MenuAction | `dockCandidate:${number}`;

interface DockingCandidate {
  readonly ship: ModularShip;
  readonly moduleId: string;
  readonly label: string;
  readonly distance: number;
  readonly angle: number;
  readonly relativeSpeed: number;
  readonly eligible: boolean;
  readonly reason: string | null;
}

interface ModuleWindowEntry {
  readonly win: PropertyWindow<ModuleAction>;
  readonly ship: ModularShip;
  readonly moduleId: string;
  candidates: readonly DockingCandidate[] | null;
}

export interface ModuleWindowOpener {
  open(ship: ModularShip, moduleId: string, clientX: number, clientY: number): void;
  openAtDefault(ship: ModularShip, moduleId: string): void;
}

function wearText(module: ShipModuleInstance, maxHp: number): string {
  const wear = maxHp > 0 ? Math.max(0, Math.min(1, 1 - module.hp / maxHp)) : 1;
  return `${(wear * 100).toFixed(1)}% (${Math.floor(module.hp)} / ${maxHp})`;
}

// 展開・収納を選べるモジュールにだけ操作項目を出す。
function moduleItems(ship: ModularShip, module: ShipModuleInstance): PropertyWindowItem<ModuleAction>[] {
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

export class ModuleWindows implements ModuleWindowOpener {
  private readonly windows = new Map<string, ModuleWindowEntry>();

  public constructor(
    private readonly hud: HudLayers & Notifier,
    private readonly controlSelection: ControlSelection,
    private readonly roster: EntityRoster & EntityRegistry,
    private readonly construction: ShipConstruction,
    private readonly confirmation: ConfirmationOverlay,
    private readonly enterCombatView: () => boolean,
    private readonly closeOtherWindows: () => void = () => {},
  ) {}

  // モジュールのウィンドウを開く。既に開いていればクリック位置へ動かして最前面に出すだけにする。
  public open(ship: ModularShip, moduleId: string, clientX: number, clientY: number): void {
    const module = ship.assembly.module(moduleId);
    if (module === null) return;
    const key = `${ship.id}:${moduleId}`;
    const existing = this.windows.get(key);
    if (existing) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const win = new PropertyWindow<ModuleAction>(
      this.hud.layers.window, clientX, clientY, this.content(ship, module), this.hud.overlayManager,
    );
    const entry: ModuleWindowEntry = { win, ship, moduleId, candidates: null };
    this.windows.set(key, entry);
    win.onSelect = (act) => {
      if (!ship.inspection.hasModule(moduleId)) return;
      if (act === 'deployModule' || act === 'stowModule') {
        ship.inspection.setModuleDeployment(moduleId, act === 'deployModule');
      } else if (act === 'toggleBoosterModule') {
        ship.toggleBoosterIgnition(moduleId);
      } else if (act === 'decoupleModule') {
        this.confirmation.open(`${moduleId} を作動させますか？`, () => {
          try {
            ship.decouple(moduleId, this.roster);
          } catch (error) {
            this.hud.hint(error instanceof Error ? error.message : '分離できません');
          }
        });
      } else if (act === 'dockModule') {
        if (entry.candidates === null) this.showDockCandidates(entry);
        else entry.candidates = null;
        this.syncEntry(entry);
      } else if (act === 'cancelDockCandidates') {
        entry.candidates = null;
        this.syncEntry(entry);
      } else if (act.startsWith('dockCandidate:')) {
        const index = Number(act.slice('dockCandidate:'.length));
        const candidate = entry.candidates?.[index];
        if (candidate === undefined) return;
        const eligibility = !ship.motion.alive || !candidate.ship.motion.alive
          || !this.roster.all().includes(candidate.ship)
          ? { eligible: false, reasons: ['対象船体が存在しません'] }
          : dockingEligibility(ship, moduleId, candidate.ship, candidate.moduleId);
        if (!eligibility.eligible) {
          this.hud.hint(eligibility.reasons[0] ?? '接舷条件を満たしていません');
          this.showDockCandidates(entry);
          this.syncEntry(entry);
          return;
        }
        try {
          ship.dock(candidate.ship, moduleId, candidate.moduleId, this.controlSelection);
          this.close();
        } catch (error) {
          this.hud.hint(error instanceof Error ? error.message : '接舷できません');
        }
      } else if (act === 'startConstructionModule') {
        try {
          if (!this.enterCombatView()) throw new Error('戦闘ビューへ切り替えられません');
          this.construction.start(ship, moduleId);
          this.close();
          this.closeOtherWindows();
        } catch (error) {
          this.hud.hint(error instanceof Error ? error.message : '建造を開始できません');
        }
      } else if (act === 'undockModule') {
        if (this.undockProducesMaterial(ship, moduleId)) {
          this.confirmation.open(
            'コックピットがないため操縦不能な物資として分離します。続けますか？',
            () => this.undock(ship, moduleId),
          );
        } else this.undock(ship, moduleId);
      } else if (act === 'repairDockedModules') {
        try {
          ship.repairAtDock(moduleId);
        } catch (error) {
          this.hud.hint(error instanceof Error ? error.message : '修理できません');
        }
      } else if (act === 'selectCockpitModule') {
        if (!ship.capabilities.selectOperatingCockpit(moduleId)) this.hud.hint('全損したコックピットは選択できません');
      }
    };
    win.onClose = () => { this.windows.delete(key); };
  }

  // キーボード/タッチからモジュール行を開くときの既定位置。マウス右クリックは位置を直接渡す。
  public openAtDefault(ship: ModularShip, moduleId: string): void {
    const bounds = this.hud.root.getBoundingClientRect();
    const x = bounds.left + Math.max(0, (bounds.width - 320) * 0.5);
    const y = bounds.top + Math.max(0, (bounds.height - 240) * 0.5);
    this.open(ship, moduleId, x, y);
  }

  // その艦のモジュールウィンドウをすべて畳む。
  public closeFor(shipId: string): void {
    for (const entry of [...this.windows.values()]) {
      if (entry.ship.id === shipId) entry.win.close();
    }
  }

  // 開いている各ウィンドウの値を最新化する。操作対象から外れた艦・失われたモジュールは閉じる。
  public sync(): void {
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
      this.syncEntry(entry, module);
    }
  }

  // 開いているウィンドウをすべて畳む。
  public close(): void {
    for (const entry of [...this.windows.values()]) entry.win.close();
  }

  // ウィンドウ1枚ぶんの見出し・行・操作項目。
  private content(ship: ModularShip, module: ShipModuleInstance): PropertyWindowContent<ModuleAction> {
    const definition = ship.assembly.definition(module.id);
    const label = definition?.name ?? module.definitionId;
    const resource = module.kind === 'tank' || module.kind === 'booster'
      ? [{ key: 'fuel', label: '燃料', value: `${module.fuel.toFixed(1)} / ${definition?.abilities.fuelCapacity ?? 0}` }]
      : [];
    return {
      title: label,
      subtitle: `取り付け艦: ${ship.name}`,
      kindCode: 'MOD',
      kindLabel: 'MODULE',
      rows: [
        { key: 'name', label: 'モジュール', value: label },
        { key: 'kind', label: '種別', value: module.kind },
        { key: 'ship', label: '取り付け艦', value: ship.name },
        { key: 'wear', label: '損耗度', value: wearText(module, definition?.maxHp ?? 0) },
        { key: 'temperature', label: '温度', value: `${module.temperature.toFixed(0)} K` },
        ...resource,
      ],
      items: moduleItems(ship, module),
    };
  }

  private showDockCandidates(entry: ModuleWindowEntry): void {
    entry.candidates = this.dockingCandidates(entry.ship, entry.moduleId);
  }

  private dockingCandidates(ship: ModularShip, moduleId: string): readonly DockingCandidate[] {
    const candidates: DockingCandidate[] = [];
    for (const entity of this.roster.all()) {
      if (!(entity instanceof ModularShip) || entity === ship || !entity.motion.alive) continue;
      for (const module of entity.assembly.modules) {
        if (module.kind !== 'dock' && module.kind !== 'docking_port') continue;
        const eligibility = dockingEligibility(ship, moduleId, entity, module.id);
        const definition = entity.assembly.definition(module.id);
        candidates.push({
          ship: entity, moduleId: module.id,
          label: `${entity.name} / ${definition?.name ?? module.id}`,
          distance: eligibility.distance, angle: eligibility.angle,
          relativeSpeed: eligibility.relativeSpeed, eligible: eligibility.eligible,
          reason: eligibility.reasons[0] ?? null,
        });
      }
    }
    return candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.distance - b.distance);
  }

  private candidateItems(candidates: readonly DockingCandidate[]): PropertyWindowItem<ModuleAction>[] {
    return [
      { label: '接舷候補を閉じる', act: 'cancelDockCandidates', keepOpen: true },
      ...candidates.map((candidate, index) => ({
        label: candidate.eligible
          ? `${candidate.label} (${candidate.distance.toFixed(1)} m / ${(candidate.angle * 180 / Math.PI).toFixed(1)}° / ${candidate.relativeSpeed.toFixed(2)} m/s)`
          : `${candidate.label} — ${candidate.reason ?? '接舷不可'}`,
        act: `dockCandidate:${index}` as const,
        disabled: !candidate.eligible,
      })),
    ];
  }

  private syncEntry(entry: ModuleWindowEntry, module = entry.ship.assembly.module(entry.moduleId)): void {
    if (module === null) return;
    entry.win.syncRows(this.content(entry.ship, module).rows);
    entry.win.syncItems(entry.candidates === null
      ? moduleItems(entry.ship, module) : this.candidateItems(entry.candidates));
  }

  private undockProducesMaterial(ship: ModularShip, moduleId: string): boolean {
    const connection = ship.assembly.detachableConnections().find(
      edge => edge.parentId === moduleId || edge.childId === moduleId,
    );
    if (connection === undefined) return false;
    return ship.assembly.clone().splitAt(connection.id)[1].role === 'material';
  }

  private undock(ship: ModularShip, moduleId: string): void {
    try {
      ship.undock(moduleId, this.roster);
      this.close();
    } catch (error) {
      this.hud.hint(error instanceof Error ? error.message : '発進できません');
    }
  }
}
