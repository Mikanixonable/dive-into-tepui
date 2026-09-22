// 戦闘/マップのビュー選択を持ち、操作対象の有無に応じた遷移可否を決める。
import type { RunEventSink } from '../run-events';
import type { ViewMode } from '../view/view-mode';

// ビュー遷移の可否判定および遷移時の計画件数を参照するインターフェース。
export interface ViewControlSource {
  readonly current: {
    readonly plan: { readonly nodes: readonly unknown[] };
  } | null;
}

// ビュー選択状態を外部から参照するインターフェース。
export interface ViewSelectionSource {
  readonly current: ViewMode;
  // view へいま遷移できるか。
  canSelect(view: ViewMode): boolean;
}

export class ViewSelection implements ViewSelectionSource {
  private view: ViewMode;

  // requested のビューで始める。戦闘ビューへ入れないときはマップから始める。
  public constructor(
    private readonly control: ViewControlSource,
    private readonly events: RunEventSink,
    requested: ViewMode = 'combat',
  ) {
    this.view = this.canSelect(requested) ? requested : 'map';
  }

  // 直列化したビューで始める。ビューでない値は欠けと同じく既定から始める。
  public static deserialize(serialized: ViewMode, control: ViewControlSource, events: RunEventSink): ViewSelection {
    return new ViewSelection(
      control, events, serialized === 'combat' || serialized === 'map' ? serialized : undefined,
    );
  }

  public get current(): ViewMode { return this.view; }

  // 直列化した形。
  public serialize(): ViewMode { return this.view; }

  // view へいま遷移できるか。
  public canSelect(view: ViewMode): boolean {
    return view === 'map' || this.control.current !== null;
  }

  // 明示されたビューへ切り替える。遷移できなければ現在値を保ち、拒否を記録して false を返す。
  public select(view: ViewMode): boolean {
    if (view === this.view) return true;
    if (!this.canSelect(view)) {
      this.events.record({ kind: 'combatViewUnavailable' });
      return false;
    }
    this.view = view;
    return true;
  }

  // 戦闘/マップを切り替え、遷移結果を記録する。
  public toggle(): void {
    if (this.view === 'combat') {
      this.view = 'map';
      this.events.record({ kind: 'orbitPlanningOpened' });
      return;
    }

    if (!this.select('combat')) return;
    const nodeCount = this.control.current?.plan.nodes.length ?? 0;
    if (nodeCount > 0) this.events.record({ kind: 'maneuverPlanConfirmed', nodeCount });
  }
}
