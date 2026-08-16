// 画面全体のシミュレーションステータスバー(#hud-simulation-status)の同期: MET・時間加速・NODE WARP。
// 自機の有無に関係なく常に出す画面全体の状態。
import { SIM_EPOCH_SEC, fmtDateTime, fmtTime } from './utils';
import type { Game } from '../game';

const SYNC_INTERVAL_MS = 100;

export class SimulationStatusBar {
  private nextSyncAt = 0;

  constructor(private readonly els: Map<string, HTMLElement>) {}

  sync(game: Game): void {
    this.setText('met', `${fmtDateTime(SIM_EPOCH_SEC + game.simulator.simTime)} / T+ ${fmtTime(game.simulator.simTime)}`);

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    const simSpeedLabel = `×${game.simSpeedManager.simSpeed}`;
    const autoWarpRealRemain = game.simSpeedManager.estimatedRealSecondsToWarpEnd(game.simulator.simTime);
    const simSpeedEl = this.els.get('sim-speed');
    if (simSpeedEl) {
      // 自動ワープ中は現在のワープ段の右に残り実時間を添える。停止中はワープ段より PAUSE を優先する。
      const warpRemain = autoWarpRealRemain !== null ? ` (残り ${fmtTime(autoWarpRealRemain)})` : '';
      simSpeedEl.textContent = game.isPaused ? 'PAUSE' : `${simSpeedLabel}${warpRemain}`;
      simSpeedEl.classList.toggle('sim-speed-hot', simSpeedLabel !== '×1' || game.isPaused);
    }
    const autoWarpSimRemain = game.simSpeedManager.remainingSimulationSeconds(game.simulator.simTime);
    const nodeWarpEl = this.els.get('node-warp-remain');
    if (nodeWarpEl) {
      nodeWarpEl.textContent = autoWarpSimRemain === null ? '—' : fmtTime(autoWarpSimRemain);
      nodeWarpEl.classList.toggle('sim-speed-hot', autoWarpSimRemain !== null);
    }
  }

  // id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const e = this.els.get(id);
    if (e && e.textContent !== text) e.textContent = text;
  }
}
