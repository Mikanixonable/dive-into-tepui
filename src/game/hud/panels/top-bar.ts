// 画面全体のトップバー(#hud-topbar)の同期: MET・時間加速・NODE WARP。
// 自機の有無に関係なく常に出す画面全体の状態。
import { SyncThrottle } from '../sync-throttle';
import { fmtDateTime, fmtElapsedUnits, fmtTime } from '../../../hud/utils';
import type { HudEls } from '../hud-els';
import { SIM_SPEED_LEVELS } from '../../dynamic/sim-speed-manager';
import { Pulldown } from '../../../hud/widgets';

const SYNC_INTERVAL_MS = 100;

const SPEED_COLUMN = {
  items: SIM_SPEED_LEVELS.map((speed) => [speed, `×${speed}`] as const),
  description: '時間加速',
} as const;

// トップバーが1フレームに表示する値と、時間加速セレクトが通知する操作ハンドラ。
export interface TopBarViewModel {
  // ランの元期の unix 秒。simTime を足すと表示用の日時になる。
  readonly epochUnixSec: number;
  readonly simTime: number;
  readonly simSpeed: number;
  readonly isPaused: boolean;
  // ノード自動ワープが終わるまでの実時間 [s]。自動ワープしていなければ null。
  readonly autoWarpRealRemainSec: number | null;
  // 同じくシミュレーション時間 [s]。
  readonly autoWarpSimRemainSec: number | null;
  setSimSpeed(speed: number): void;
}

export class TopBar {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private readonly simSpeedEl: HTMLSelectElement;
  private readonly simSpeedPulldown: Pulldown<readonly [typeof SPEED_COLUMN]>;
  // 直近の sync が受けた値。セレクトの操作はフレームの外で起きるので、その時点の口をここから引く。
  private view: TopBarViewModel | null = null;

  // 時間加速ドロップダウンを差し込み、選択の変更を直近の値が持つ口へ返す。
  public constructor(private readonly els: HudEls) {
    const holder = this.els.get('sim-speed');
    const pulldown = new Pulldown<readonly [typeof SPEED_COLUMN]>(
      '', [SPEED_COLUMN], null, ([speed]) => this.view?.setSimSpeed(speed),
    );
    holder.appendChild(pulldown.element);
    this.simSpeedPulldown = pulldown;
    this.simSpeedEl = pulldown.element.querySelector<HTMLSelectElement>('select')!;
    this.simSpeedEl.classList.add('gs-speed-select');
  }

  // MET を毎フレーム、時間加速と NODE WARP の残りを間引いて反映する。
  // view が null(ランが無い)なら、掴んでいる口を落として何も書かない。
  public sync(view: TopBarViewModel | null, nowMs: number): void {
    this.view = view;
    const nodeWarpEl = this.els.get('node-warp-remain');
    if (!view) {
      nodeWarpEl.closest('#hud-topbar')?.classList.remove('node-warp-active');
      return;
    }
    const { simTime } = view;
    this.els.setText(
      'met', `${fmtDateTime(view.epochUnixSec + simTime)} / T+ ${fmtElapsedUnits(simTime)}`,
    );

    if (!this.throttle.due(nowMs)) return;

    // 時間加速ドロップダウンの選択値と表示を、現在の速度へ合わせる。
    const simSpeedLabel = `×${view.simSpeed}`;
    this.simSpeedPulldown.setSelected(0, view.simSpeed);
    const warpRemain = view.autoWarpRealRemainSec !== null
      ? ` (残り ${fmtTime(view.autoWarpRealRemainSec)})`
      : '';
    this.simSpeedEl.title = view.isPaused ? '一時停止中' : `時間加速 ${simSpeedLabel}${warpRemain}`;
    this.simSpeedEl.classList.toggle('ui-accent', simSpeedLabel !== '×1' || view.isPaused);
    // NODE WARP の残り時間表示。
    const remain = view.autoWarpSimRemainSec;
    nodeWarpEl.textContent = remain === null ? '' : fmtTime(remain);
    nodeWarpEl.classList.toggle('ui-accent', remain !== null);
    nodeWarpEl.closest('.gs-metric')?.classList.toggle('hidden', remain === null);
    nodeWarpEl.closest('#hud-topbar')?.classList.toggle('node-warp-active', remain !== null);
  }
}
