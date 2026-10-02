// 搭載モジュールごとのプロパティウィンドウの寿命と、確認・接舷候補の操作を管理する。
import { PropertyWindow } from '../../hud/windows/property-window';
import { ModularShip } from '../ship/modular-ship';
import { dockingEligibility } from '../ship/ship-docking';
import { moduleContent, moduleItems, type ModuleInspectionAction } from './module-inspection';
import type { PropertyWindowItem } from '../../hud/windows/property-window-content';
import type { ControlSelection } from '../control-selection';
import type { HudLayers } from '../hud/hud-layers';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { Notifier } from '../../hud/notifier';
import type { ShipConstruction } from '../ship/ship-construction';
import type { ConfirmationOverlay } from '../../hud/windows/confirmation-overlay';

type ModuleAction = ModuleInspectionAction | 'cancelDockCandidates' | `dockCandidate:${number}`;

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
      clientX, clientY, moduleContent(ship, module), this.hud.overlayManager,
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
        this.confirmation.open({ message: `${moduleId} を作動させますか？` }, (confirmed) => {
          if (!confirmed) return;
          try {
            ship.decouple(moduleId, this.roster);
          } catch (error) {
            this.hud.hint(error instanceof Error ? error.message : '分離できません', undefined, 'warn');
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
          this.hud.hint(eligibility.reasons[0] ?? '接舷条件を満たしていません', undefined, 'warn');
          this.showDockCandidates(entry);
          this.syncEntry(entry);
          return;
        }
        try {
          ship.dock(candidate.ship, moduleId, candidate.moduleId, this.controlSelection);
          this.close();
        } catch (error) {
          this.hud.hint(error instanceof Error ? error.message : '接舷できません', undefined, 'warn');
        }
      } else if (act === 'startConstructionModule') {
        try {
          if (!this.enterCombatView()) throw new Error('戦闘ビューへ切り替えられません');
          this.construction.start(ship, moduleId);
          this.close();
          this.closeOtherWindows();
        } catch (error) {
          this.hud.hint(error instanceof Error ? error.message : '建造を開始できません', undefined, 'warn');
        }
      } else if (act === 'undockModule') {
        if (this.undockProducesMaterial(ship, moduleId)) {
          this.confirmation.open(
            { message: 'コックピットがないため操縦不能な物資として分離します。続けますか？' },
            (confirmed) => { if (confirmed) this.undock(ship, moduleId); },
          );
        } else this.undock(ship, moduleId);
      } else if (act === 'repairDockedModules') {
        try {
          ship.repairAtDock(moduleId);
        } catch (error) {
          this.hud.hint(error instanceof Error ? error.message : '修理できません', undefined, 'warn');
        }
      } else if (act === 'selectCockpitModule') {
        if (!ship.capabilities.selectOperatingCockpit(moduleId)) this.hud.hint('全損したコックピットは選択できません', undefined, 'warn');
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

  // 接舷候補を再評価し、選択中の窓へ保持する。
  private showDockCandidates(entry: ModuleWindowEntry): void {
    entry.candidates = this.dockingCandidates(entry.ship, entry.moduleId);
  }

  // 生存する別船体の接舷部を、接舷可否と距離順で列挙する。
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
    // 操作可能な候補を先に、近いものから表示する。
    return candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.distance - b.distance);
  }

  // 候補の位置と相対運動を、接舷操作の選択項目へ写す。
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

  // 部品が存在する窓へ状態と現在の操作項目を反映する。
  private syncEntry(entry: ModuleWindowEntry, module = entry.ship.assembly.module(entry.moduleId)): void {
    if (module === null) return;
    entry.win.syncRows(moduleContent(entry.ship, module).rows);
    entry.win.syncItems(entry.candidates === null
      ? moduleItems(entry.ship, module) : this.candidateItems(entry.candidates));
  }

  // 切り離す枝が操縦不能な物資になるかを、複製した船体で判定する。
  private undockProducesMaterial(ship: ModularShip, moduleId: string): boolean {
    const connection = ship.assembly.detachableConnections().find(
      edge => edge.parentId === moduleId || edge.childId === moduleId,
    );
    if (connection === undefined) return false;
    return ship.assembly.clone().splitAt(connection.id)[1].role === 'material';
  }

  // 接続を解除し、成功した窓を閉じる。失敗は通知する。
  private undock(ship: ModularShip, moduleId: string): void {
    try {
      ship.undock(moduleId, this.roster);
      this.close();
    } catch (error) {
      this.hud.hint(error instanceof Error ? error.message : '発進できません', undefined, 'warn');
    }
  }
}
