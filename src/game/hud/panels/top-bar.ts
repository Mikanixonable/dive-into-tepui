// 画面全体のトップバー(#hud-topbar)の同期: MET・時間加速・NODE WARP。
// 自機の有無に関係なく常に出す画面全体の状態。
import { SyncThrottle } from '../sync-throttle';
import { fmtDateTime, fmtElapsedUnits, setElementText, fmtTime } from '../../../hud/utils';
import { SIM_SPEED_LEVELS } from '../../dynamic/sim-speed-manager';

const SYNC_INTERVAL_MS = 100;

export interface TopBarViewModel {
  readonly epochUnixSec: number;
  readonly simTime: number;
  readonly simSpeed: number;
  readonly autoWarpRealSecondsRemaining: number | null;
  readonly autoWarpSimulationSecondsRemaining: number | null;
  readonly isPaused: boolean;
}

export interface TopBarCommands {
  readonly setSimulationSpeed: (speed: number) => void;
}

export class TopBar {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  private commands: TopBarCommands = { setSimulationSpeed: () => {} };

  public constructor(private readonly els: Map<string, HTMLElement>) {}

  public setCommands(commands: TopBarCommands): void {
    this.commands = commands;
  }

  // MET を毎フレーム、時間加速と NODE WARP の残りを間引いて反映する。
  public sync(view: TopBarViewModel): void {
    setElementText(this.els, 'met', `${fmtDateTime(view.epochUnixSec + view.simTime)} / T+ ${fmtElapsedUnits(view.simTime)}`);

    if (!this.throttle.due()) return;

    // 時間加速セレクトを初回だけ選択肢で満たし、以後は選択値と表示を現在の速度へ合わせる。
    const simSpeedLabel = `×${view.simSpeed}`;
    const simSpeedEl = this.els.get('sim-speed');
    if (simSpeedEl instanceof HTMLSelectElement) {
      if (simSpeedEl.dataset['speedOptions'] !== 'ready') {
        for (const speed of SIM_SPEED_LEVELS) {
          const option = document.createElement('option');
          option.value = String(speed);
          option.textContent = `×${speed}`;
          simSpeedEl.appendChild(option);
        }
        simSpeedEl.dataset['speedOptions'] = 'ready';
        simSpeedEl.addEventListener('change', () => this.commands.setSimulationSpeed(Number(simSpeedEl.value)));
      }
      simSpeedEl.value = String(view.simSpeed);
      const warpRemain = view.autoWarpRealSecondsRemaining !== null
        ? ` (残り ${fmtTime(view.autoWarpRealSecondsRemaining)})` : '';
      simSpeedEl.title = view.isPaused ? '一時停止中' : `時間加速 ${simSpeedLabel}${warpRemain}`;
      simSpeedEl.classList.toggle('sim-speed-hot', simSpeedLabel !== '×1' || view.isPaused);
    }
    // NODE WARP の残り時間表示。
    const nodeWarpEl = this.els.get('node-warp-remain');
    if (nodeWarpEl) {
      nodeWarpEl.textContent = view.autoWarpSimulationSecondsRemaining === null
        ? '—' : fmtTime(view.autoWarpSimulationSecondsRemaining);
      nodeWarpEl.classList.toggle('sim-speed-hot', view.autoWarpSimulationSecondsRemaining !== null);
    }
  }
}
