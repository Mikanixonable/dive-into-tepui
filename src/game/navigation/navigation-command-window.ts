// 航行指令ウィンドウ: 制約(Δv 上限)と求解した遷移候補の一覧を出すドラッグ可能窓。
// 候補行を選ぶと onChoose へ渡し、適用は呼び出し側が命令として積む。
import { DraggableWindow } from '../../hud/windows/draggable-window';
import { UNCLIPPED_WINDOW_GROUP } from '../../hud/overlay-manager';
import { Button, ValueInput } from '../../hud/widgets';
import { injectOnce } from '../../hud/inject-style';
import { fmtSpeed, fmtTime } from '../../hud/utils';
import type { OverlayManager } from '../../hud/overlay-manager';
import type { TransferCandidate } from '../../physics/transfer-planner';

// ウィンドウを開く既定位置 [px]。
const WINDOW_OPEN_X = 340;
const WINDOW_OPEN_Y = 120;

const STYLE = `
#hud .dg-window.navigation-command { max-width: 380px; }
#hud .navigation-command-body { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-3); }
#hud .navigation-command-constraint { display: flex; align-items: center; gap: var(--space-2); font-size: var(--font-xs); color: var(--text-dim); }
#hud .navigation-command-constraint .w-input { width: 96px; }
#hud .navigation-command-list { display: flex; flex-direction: column; }
#hud .navigation-command-row {
  display: grid; grid-template-columns: auto 1fr auto; gap: var(--space-1) var(--space-3);
  align-items: baseline; width: 100%; text-align: left;
  padding: var(--space-2); border: none; border-radius: var(--radius-control);
  background: none; color: var(--text); font: inherit; cursor: pointer;
}
#hud .navigation-command-row:hover { background: color-mix(in srgb, var(--color-primary) 14%, transparent); }
#hud .navigation-command-row .navcmd-method { font-size: var(--font-xs); letter-spacing: var(--tracking-label); color: var(--color-primary); }
#hud .navigation-command-row .navcmd-times { font-variant-numeric: tabular-nums; }
#hud .navigation-command-row .navcmd-dv { font-variant-numeric: tabular-nums; color: var(--text-dim); white-space: nowrap; }
#hud .navigation-command-message { color: var(--text-dim); font-size: var(--font-xs); padding: var(--space-2); }
`;

export class NavigationCommandWindow {
  // 候補行が選ばれたときに呼ぶ。
  public onChoose: ((candidate: TransferCandidate) => void) | null = null;
  // Δv 上限の確定または「再求解」で呼ぶ。null は上限なし。
  public onSolve: ((maxDeltaV: number | null) => void) | null = null;
  public onClose: (() => void) | null = null;

  private readonly win: DraggableWindow;
  private readonly deltaVInput: ValueInput;
  private readonly list: HTMLElement;
  private readonly message: HTMLElement;

  // targetName・shipName は見出しに出す。maxDeltaV は Δv 上限欄の初期値(取れなければ null)。
  public constructor(
    overlayManager: OverlayManager,
    targetName: string, shipName: string, maxDeltaV: number | null,
  ) {
    injectOnce('navigation-command-window', STYLE);
    this.win = new DraggableWindow(
      WINDOW_OPEN_X, WINDOW_OPEN_Y,
      {
        title: '航行指令', subtitle: `${shipName} → ${targetName}`,
        unclippedWindowGroup: UNCLIPPED_WINDOW_GROUP,
      },
      overlayManager,
    );
    this.win.element.classList.add('navigation-command');
    this.win.onClose = () => this.onClose?.();

    const body = document.createElement('div');
    body.className = 'navigation-command-body';

    const constraint = document.createElement('div');
    constraint.className = 'navigation-command-constraint';
    const label = document.createElement('span');
    label.textContent = 'Δv 上限 [m/s]';
    constraint.appendChild(label);
    this.deltaVInput = new ValueInput(
      { type: 'number', min: 0, step: 10, placeholder: '無制限' },
      () => this.onSolve?.(this.deltaVLimit()),
    );
    this.deltaVInput.setValue(maxDeltaV === null ? '' : String(Math.round(maxDeltaV)));
    constraint.appendChild(this.deltaVInput.element);
    const resolveButton = new Button('再求解', () => this.onSolve?.(this.deltaVLimit()), undefined, ['dense', 'secondary']);
    constraint.appendChild(resolveButton.element);
    body.appendChild(constraint);

    this.message = document.createElement('div');
    this.message.className = 'navigation-command-message';
    body.appendChild(this.message);
    this.list = document.createElement('div');
    this.list.className = 'navigation-command-list';
    body.appendChild(this.list);

    this.win.body.appendChild(body);
  }

  // 入力欄の Δv 上限 [m/s]。空欄は上限なし(null)。
  private deltaVLimit(): number | null {
    const v = Number(this.deltaVInput.element.value);
    return this.deltaVInput.element.value.trim() === '' || !(v > 0) ? null : v;
  }

  // 候補一覧を組み直す。simTime は T+ 表記の原点。候補が無いときは理由の行だけを出す。
  public render(candidates: readonly TransferCandidate[], simTime: number): void {
    this.list.textContent = '';
    this.message.textContent = candidates.length === 0
      ? '候補がありません — Δv 上限が低すぎるか、到達可能な窓がありません'
      : '';
    for (const candidate of candidates) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'navigation-command-row';
      const method = document.createElement('span');
      method.className = 'navcmd-method';
      method.textContent = 'LAMBERT';
      const times = document.createElement('span');
      times.className = 'navcmd-times';
      times.textContent =
        `出発 T+${fmtTime(candidate.departAt - simTime)} / 到着 T+${fmtTime(candidate.arriveAt - simTime)}` +
        ` (所要 ${fmtTime(candidate.arriveAt - candidate.departAt)})`;
      const dv = document.createElement('span');
      dv.className = 'navcmd-dv';
      dv.textContent = `Δv ${fmtSpeed(candidate.deltaV)} · 燃焼${candidate.nodes.length}回`;
      row.append(method, times, dv);
      row.addEventListener('click', () => this.onChoose?.(candidate));
      this.list.appendChild(row);
    }
  }

  // ウィンドウを畳み、onClose 経路を通す。
  public close(): void {
    this.win.close();
  }

  // 所有する DOM を取り除く。閉じるときの内部経路。
  public dispose(): void {
    this.win.dispose();
  }
}
