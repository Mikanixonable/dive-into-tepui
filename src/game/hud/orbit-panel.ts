// 常設 ORBIT パネル(#hud-orbit)の同期: 自艦の基準天体・高度・速度・遠地点/近地点・傾斜角・
// 周期・動圧・機体温度。戦闘ビュー専用 — マップビューでは畳む(対象側の軌道要素は
// プロパティウィンドウが持ち、ここでは二重に出さない)。
import * as C from '../const';
import { fmtDist, fmtSpeed, fmtTime } from './utils';
import { orbitInfo } from './orbit-info';
import { Attractor } from '../../physics/attractor';
import type { Game } from '../game';

const SYNC_INTERVAL_MS = 100;

export class OrbitPanel {
  private nextSyncAt = 0;

  constructor(private readonly els: Map<string, HTMLElement>) {}

  sync(game: Game, attractors: readonly Attractor[]): void {
    const player = game.player;
    const el = document.getElementById('hud-orbit');
    if (!player) {
      el?.classList.add('hidden');
      return;
    }
    el?.classList.toggle('hidden', game.cameraSystem.overviewMode);

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    const oi = orbitInfo(player, attractors);
    const thermal = player.thermal;
    this.setText('center', oi.centerName);
    this.setText('alt', fmtDist(oi.alt));
    this.els.get('alt')?.classList.toggle('warn-hot', thermal.altDescendWarned);
    this.setText('spd', fmtSpeed(oi.spd));
    this.setText('ap', fmtDist(oi.apAlt));
    this.setText('pe', fmtDist(oi.peAlt));
    this.setText('inc', `${oi.incDeg.toFixed(2)}°`);
    this.setText('prd', fmtTime(oi.period));
    // 動圧・機体温度は閾値超過で警告表示にする。
    const qEl = this.els.get('qdyn');
    if (qEl) {
      qEl.textContent = thermal.qdyn >= 10 ? `${(thermal.qdyn / 1000).toFixed(2)} kPa` : '0.00 kPa';
      qEl.classList.toggle('warn-hot', thermal.qdyn > 0.5 * C.MAX_DYN_PRESSURE);
    }
    const tEl = this.els.get('temp');
    if (tEl) {
      tEl.textContent = `${thermal.hullTemp.toFixed(0)} K`;
      tEl.classList.toggle('warn-hot', thermal.hullTemp > 0.7 * C.MAX_HULL_TEMP);
    }
  }

  // id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const e = this.els.get(id);
    if (e && e.textContent !== text) e.textContent = text;
  }
}
