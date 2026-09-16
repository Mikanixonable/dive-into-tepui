// 画面全体のトップバー(#hud-topbar)の同期: MET・時間加速・NODE WARP。
// 自機の有無に関係なく常に出す画面全体の状態。
import { SyncThrottle } from '../sync-throttle';
import { fmtDateTime, fmtElapsedUnits, setElementText, fmtTime } from '../../../hud/utils';

const SYNC_INTERVAL_MS = 100;

export interface TopBarViewModel {
  readonly epochUnixSec: number;
  readonly simTime: number;
  readonly simSpeed: number;
  readonly speedOptions: readonly number[];
  readonly autoWarpRealRemain: number | null;
  readonly autoWarpSimRemain: number | null;
  readonly isPaused: boolean;
  readonly onSpeedChange: (speed: number) => void;
}

export class TopBar {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private onSpeedChange: (speed: number) => void = () => {};

  public constructor(private readonly els: Map<string, HTMLElement>) {}

  // MET を毎フレーム、時間加速と NODE WARP の残りを間引いて反映する。
  public sync(view: TopBarViewModel): void {
    this.onSpeedChange = view.onSpeedChange;
    setElementText(this.els, 'met', `${fmtDateTime(view.epochUnixSec + view.simTime)} / T+ ${fmtElapsedUnits(view.simTime)}`);

    if (!this.throttle.due()) return;

    // 時間加速セレクトを初回だけ選択肢で満たし、以後は選択値と表示を現在の速度へ合わせる。
    const simSpeedLabel = `×${view.simSpeed}`;
    const simSpeedEl = this.els.get('sim-speed');
    if (simSpeedEl instanceof HTMLSelectElement) {
      if (simSpeedEl.dataset['speedOptions'] !== 'ready') {
        for (const speed of view.speedOptions) {
          const option = document.createElement('option');
          option.value = String(speed);
          option.textContent = `×${speed}`;
          simSpeedEl.appendChild(option);
        }
        simSpeedEl.dataset['speedOptions'] = 'ready';
        simSpeedEl.addEventListener('change', () => this.onSpeedChange(Number(simSpeedEl.value)));
      }
      simSpeedEl.value = String(view.simSpeed);
      const warpRemain = view.autoWarpRealRemain !== null ? ` (残り ${fmtTime(view.autoWarpRealRemain)})` : '';
      simSpeedEl.title = view.isPaused ? '一時停止中' : `時間加速 ${simSpeedLabel}${warpRemain}`;
      simSpeedEl.classList.toggle('sim-speed-hot', simSpeedLabel !== '×1' || view.isPaused);
    }
    // NODE WARP の残り時間表示。
    const nodeWarpEl = this.els.get('node-warp-remain');
    if (nodeWarpEl) {
      nodeWarpEl.textContent = view.autoWarpSimRemain === null ? '—' : fmtTime(view.autoWarpSimRemain);
      nodeWarpEl.classList.toggle('sim-speed-hot', view.autoWarpSimRemain !== null);
    }
  }
}
