// 搭載モジュールごとのプロパティウィンドウの寿命と、確認・接舷候補の操作を管理する。
import { PropertyWindow } from '../../hud/windows/property-window';
import { ModularShip } from '../ship/modular-ship';
import { dockingEligibility } from '../ship/ship-docking';
import { moduleContent, moduleItems, type ModuleInspectionAction } from './module-inspection';
import { CommandCompletion } from '../command-completion';
import { DockingEligibilityError, type ModuleCommands, type ModuleCommandAction } from './module-commands';
import type { PropertyWindowItem } from '../../hud/windows/property-window-content';
import type { ControlSelection } from '../control-selection';
import type { HudLayers } from '../hud/hud-layers';
import type { EntityRoster } from '../dynamic/entity-roster';
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

interface PendingModuleAction {
  readonly entry: ModuleWindowEntry;
  readonly action: ModuleCommandAction | 'dockCandidate';
  readonly completion: CommandCompletion;
  readonly closeOnSuccess: readonly ModuleWindowEntry[];
}

export interface ModuleWindowOpener {
  open(ship: ModularShip, moduleId: string, clientX: number, clientY: number): void;
  openAtDefault(ship: ModularShip, moduleId: string): void;
}

export class ModuleWindows implements ModuleWindowOpener {
  private readonly windows = new Map<string, ModuleWindowEntry>();
  private readonly pending = new Set<PendingModuleAction>();

  public constructor(
    private readonly hud: HudLayers & Notifier,
    private readonly controlSelection: ControlSelection,
    private readonly roster: EntityRoster,
    private readonly commands: ModuleCommands,
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
      // 確認不要な操作はそのまま命令へ送る。
      if (act === 'deployModule' || act === 'stowModule' || act === 'toggleBoosterModule'
        || act === 'repairDockedModules' || act === 'selectCockpitModule') {
        this.submit(entry, act);
      } else if (act === 'decoupleModule') {
        this.confirmation.open({ message: `${moduleId} を作動させますか？` }, (confirmed) => {
          if (!confirmed) return;
          this.submit(entry, 'decoupleModule');
        });
      } else if (act === 'dockModule') {
        if (entry.candidates === null) this.showDockCandidates(entry);
        else entry.candidates = null;
        this.syncEntry(entry);
      } else if (act === 'cancelDockCandidates') {
        entry.candidates = null;
        this.syncEntry(entry);
      } else if (act.startsWith('dockCandidate:')) {
        // 評価済みの候補から選んだ相手へ、接舷の命令を送る。
        const index = Number(act.slice('dockCandidate:'.length));
        const candidate = entry.candidates?.[index];
        if (candidate === undefined) return;
        const completion = new CommandCompletion();
        this.pending.add({ entry, action: 'dockCandidate', completion, closeOnSuccess: [...this.windows.values()] });
        this.commands.dock(ship, moduleId, candidate.ship, candidate.moduleId, completion);
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
            (confirmed) => { if (confirmed) this.submit(entry, 'undockModule'); },
          );
        } else this.submit(entry, 'undockModule');
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
    this.syncCompletions();
    // 開いている窓を対象の現状へ揃え、操作対象から外れた窓を畳む。
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
    // 接舷不可の候補は理由を示し、選べない項目にする。
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

  // 窓の対象と操作を捕捉し、応答を待つ。
  private submit(entry: ModuleWindowEntry, action: ModuleCommandAction): void {
    const completion = new CommandCompletion();
    this.pending.add({
      entry, action, completion,
      closeOnSuccess: action === 'undockModule' ? [...this.windows.values()] : [],
    });
    this.commands.submit(entry.ship, entry.moduleId, action, completion);
  }

  // 窓を閉じた後も命令の成否を読み、通知や接舷候補へ反映する。
  private syncCompletions(): void {
    for (const pending of this.pending) {
      const state = pending.completion.state;
      if (state.kind === 'pending') continue;
      this.pending.delete(pending);
      // 成功時に畳む対象として指定された窓を畳む。
      if (state.kind === 'succeeded') {
        for (const entry of pending.closeOnSuccess) {
          if (this.windows.get(`${entry.ship.id}:${entry.moduleId}`) === entry) entry.win.close();
        }
        continue;
      }
      // 失敗を通知し、接舷条件の不成立では候補を出し直す。
      const error = state.error;
      this.hud.hint(error instanceof Error ? error.message : this.failureText(pending.action), undefined, 'warn');
      const { entry } = pending;
      if (pending.action === 'dockCandidate' && error instanceof DockingEligibilityError
        && this.windows.get(`${entry.ship.id}:${entry.moduleId}`) === entry) {
        this.showDockCandidates(entry);
      }
    }
  }

  // 非Errorの失敗にも操作に対応する文面を付ける。
  private failureText(action: PendingModuleAction['action']): string {
    switch (action) {
      case 'decoupleModule': return '分離できません';
      case 'dockCandidate': return '接舷できません';
      case 'undockModule': return '発進できません';
      case 'repairDockedModules': return '修理できません';
      case 'selectCockpitModule': return '全損したコックピットは選択できません';
      default: return 'モジュールを操作できません';
    }
  }
}
