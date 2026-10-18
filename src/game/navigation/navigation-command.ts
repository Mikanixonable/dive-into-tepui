// 航行指令の求解セッション。目標・送る艦・制約から遷移候補を解いて一覧ウィンドウへ出し、
// 選ばれた候補を命令キュー経由で艦の計画へ書き込む。求解ウィンドウが開いているあいだは、
// 候補の最早出発時刻の手前までしか simTime を進めない時刻バリアを公開する。
import { planTransfers, type TransferCandidate } from '../../physics/transfer-planner';
import { deltaVBudget, effectiveExhaustVelocity } from '../../physics/rocket';
import { strongestAttractor } from '../../physics/attractor';
import type { CommandQueue } from '../command-queue';
import type { ControlSelection } from '../control-selection';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { OverlayManager } from '../../hud/overlay-manager';
import { isModularShip, type ModularShip } from '../ship/modular-ship';
import type { OrbitSlotRegistry } from './orbit-slot-registry';
import type { OrbitSlotCatalogAccess } from './orbit-slot-family';
import { transferTargetOf } from './transfer-target';
import { commitTransferCandidate } from './transfer-command';
import { NavigationCommandWindow } from './navigation-command-window';

// 時刻バリアが simTime を止める、最早の出発時刻の手前の余裕 [s]。
// planTransfers の最早出発(出発までの最小猶予)より小さい値なので、開いた直後に
// 即座に時刻が止まることはない。
const SOLVE_TIME_MARGIN = 10;

export class NavigationCommand {
  private window: NavigationCommandWindow | null = null;
  // 求解済みの候補と、それを出した時点の出発側。ウィンドウを閉じるとクリアする。
  private candidates: readonly TransferCandidate[] = [];
  private ship: ModularShip | null = null;
  private targetId: string | null = null;
  private solvedSimTime = 0;
  private deltaVLimit: number | null = null;

  // roster は目標を個体へ解決するための名簿、notify は解決できない理由を伝える先、
  // simTimeOf は求解の出発時刻を読む口。
  public constructor(
    private readonly commands: CommandQueue,
    private readonly celestialBodies: CelestialBodies,
    private readonly roster: EntityRoster,
    private readonly controlSelection: ControlSelection,
    private readonly orbitSlots: OrbitSlotRegistry,
    private readonly slotCatalog: OrbitSlotCatalogAccess | null,
    private readonly overlayManager: OverlayManager,
    private readonly notify: (message: string) => void,
    private readonly simTimeOf: () => number,
  ) {}

  // 求解ウィンドウが開いているあいだに simTime が越えてはいけない上限 [simTime s]。
  // 適用できる候補が無い・ウィンドウが閉じていれば null(制限なし)。
  public get simTimeLimit(): number | null {
    if (this.window === null || this.candidates.length === 0) return null;
    let earliest = Infinity;
    for (const candidate of this.candidates) earliest = Math.min(earliest, candidate.departAt);
    return earliest - SOLVE_TIME_MARGIN;
  }

  // 対象 targetId(表示名 name)への航行指令を組むウィンドウを開く。
  // 送る艦は操作対象で、健全なコックピットを持つ ModularShip のときだけ開く。
  public open(targetId: string | null, name: string): void {
    if (this.window !== null) this.window.close();
    const controlled = this.controlSelection.current;
    if (controlled === null || !isModularShip(controlled) || !controlled.healthyCockpit) {
      this.notify('航行指令を出せる艦を操作していません');
      return;
    }
    if (targetId === null) {
      this.notify('目標が選ばれていません');
      return;
    }
    const simTime = this.simTimeOf();
    const target = transferTargetOf(
      targetId, this.celestialBodies, this.roster.all(), this.orbitSlots, this.slotCatalog, simTime,
    );
    if (target === null) {
      this.notify(`${name} は航行指令の目標にできません`);
      return;
    }
    this.ship = controlled;
    this.targetId = targetId;
    this.deltaVLimit = null;
    this.window = new NavigationCommandWindow(
      this.overlayManager, name, controlled.name, this.availableDeltaV(controlled),
    );
    this.window.onSolve = (maxDeltaV) => {
      this.deltaVLimit = maxDeltaV;
      this.solve();
    };
    this.window.onChoose = (candidate) => this.apply(candidate);
    this.window.onClose = () => this.clear();
    this.solve();
  }

  // 艦が今使える Δv [m/s]。推力・燃料が無い(または求まらない)なら null。
  private availableDeltaV(ship: ModularShip): number | null {
    const consumption = ship.totalFuelConsumptionRate * ship.mainFuelMassPerUnit();
    const exhaustVel = effectiveExhaustVelocity(ship.totalThrust, consumption);
    if (!(exhaustVel > 0) || !isFinite(exhaustVel)) return null;
    const budget = deltaVBudget(exhaustVel, ship.motion.mass, ship.totalFuel * ship.mainFuelMassPerUnit());
    return budget > 0 ? budget : null;
  }

  // 現在の制約で候補を解き直し、一覧へ反映する。
  private solve(): void {
    const ship = this.ship;
    const window = this.window;
    if (ship === null || window === null || this.targetId === null) return;
    const simTime = this.simTimeOf();
    const target = transferTargetOf(
      this.targetId, this.celestialBodies, this.roster.all(), this.orbitSlots, this.slotCatalog, simTime,
    );
    const center = strongestAttractor(ship.motion.state.r, this.celestialBodies.celestialMotions, simTime);
    this.solvedSimTime = simTime;
    this.candidates = target === null
      ? []
      : planTransfers(ship.motion.state, center, target, {
        maxDeltaV: this.deltaVLimit ?? undefined,
      });
    window.render(this.candidates, simTime);
  }

  // 選ばれた候補を、艦の計画へ書き込み自動操縦へ切り替える命令として積み、ウィンドウを畳む。
  private apply(candidate: TransferCandidate): void {
    const ship = this.ship;
    if (ship === null) return;
    this.commands.submit(() => commitTransferCandidate(ship, candidate));
    this.notify(`${ship.name} に遷移を設定しました`);
    this.window?.close();
  }

  // 毎フレーム呼ぶ。開いた時点の艦か目標が失われていればウィンドウを畳む。
  public sync(): void {
    if (this.window === null || this.targetId === null) return;
    if (this.controlSelection.current !== this.ship) {
      this.window.close();
      return;
    }
    if (transferTargetOf(
      this.targetId, this.celestialBodies, this.roster.all(), this.orbitSlots,
      this.slotCatalog, this.solvedSimTime,
    ) === null) {
      this.window.close();
    }
  }

  // 開いている求解の状態をクリアする。ウィンドウの onClose 経路で呼ぶ。
  private clear(): void {
    this.window = null;
    this.candidates = [];
    this.ship = null;
    this.targetId = null;
  }

  // ウィンドウを畳み、以後の呼び出しを無効にする。
  public dispose(): void {
    this.window?.close();
  }
}
