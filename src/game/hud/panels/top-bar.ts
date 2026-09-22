// 画面全体のトップバー(#hud-topbar)の同期: MET・時間加速・NODE WARP。
// 自機の有無に関係なく常に出す画面全体の状態。
import { SyncThrottle } from '../sync-throttle';
import { fmtDateTime, fmtElapsedUnits, setElementText, fmtTime } from '../../../hud/utils';
import { SIM_SPEED_LEVELS } from '../../dynamic/sim-speed-manager';

const SYNC_INTERVAL_MS = 100;

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
  private readonly simSpeedEl: HTMLSelectElement | null;
  // 直近の sync が受けた値。セレクトの操作はフレームの外で起きるので、その時点の口をここから引く。
  private view: TopBarViewModel | null = null;

  // 時間加速セレクトへ選択肢を並べ、選択の変更を直近の値が持つ口へ返す。
  public constructor(private readonly els: Map<string, HTMLElement>) {
    const el = this.els.get('sim-speed');
    const select = el instanceof HTMLSelectElement ? el : null;
    this.simSpeedEl = select;
    if (!select) return;
    // 選択肢はランを跨いで変わらないので、ここで一度だけ並べる。
    for (const speed of SIM_SPEED_LEVELS) {
      const option = document.createElement('option');
      option.value = String(speed);
      option.textContent = `×${speed}`;
      select.appendChild(option);
    }
    select.addEventListener('change', () => this.view?.setSimSpeed(Number(select.value)));
  }

  // MET を毎フレーム、時間加速と NODE WARP の残りを間引いて反映する。
  // view が null(ランが無い)なら、掴んでいる口を落として何も書かない。
  public sync(view: TopBarViewModel | null, nowMs: number): void {
    this.view = view;
    if (!view) return;
    const { simTime } = view;
    setElementText(
      this.els, 'met', `${fmtDateTime(view.epochUnixSec + simTime)} / T+ ${fmtElapsedUnits(simTime)}`,
    );

    if (!this.throttle.due(nowMs)) return;

    // 時間加速セレクトの選択値と表示を、現在の速度へ合わせる。
    const simSpeedLabel = `×${view.simSpeed}`;
    if (this.simSpeedEl) {
      this.simSpeedEl.value = String(view.simSpeed);
      const warpRemain = view.autoWarpRealRemainSec !== null
        ? ` (残り ${fmtTime(view.autoWarpRealRemainSec)})`
        : '';
      this.simSpeedEl.title = view.isPaused ? '一時停止中' : `時間加速 ${simSpeedLabel}${warpRemain}`;
      this.simSpeedEl.classList.toggle('sim-speed-hot', simSpeedLabel !== '×1' || view.isPaused);
    }
    // NODE WARP の残り時間表示。
    const nodeWarpEl = this.els.get('node-warp-remain');
    if (nodeWarpEl) {
      const remain = view.autoWarpSimRemainSec;
      nodeWarpEl.textContent = remain === null ? '' : fmtTime(remain);
      nodeWarpEl.classList.toggle('sim-speed-hot', remain !== null);
      nodeWarpEl.closest('.gs-metric')?.classList.toggle('hidden', remain === null);
    }
  }
}
