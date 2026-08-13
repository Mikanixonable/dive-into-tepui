// 常設 SHIP STATUS パネル(#hud-status)の同期: RCS制動・並進出力・微調整・進行方向ホールド・
// 視点のRCS追従・弾薬。自機が無ければ隠す。
import * as C from '../const';
import { fmtAmmoStatus } from './utils';
import type { Game } from '../game';

const SYNC_INTERVAL_MS = 100;

export class StatusPanel {
  private nextSyncAt = 0;

  constructor(private readonly els: Map<string, HTMLElement>) {}

  sync(game: Game): void {
    const player = game.player;
    if (!player) {
      document.getElementById('hud-status')?.classList.add('hidden');
      return;
    }
    // マップビューでは艦固有の情報をプロパティウィンドウで参照するので畳む(CSS 側でも
    // #hud.map-mode #hud-status を隠すが、未配置状態から復帰した直後は JS 側で明示的に戻す)。
    if (!game.cameraSystem.overviewMode) document.getElementById('hud-status')?.classList.remove('hidden');

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    this.setText('rcs', player.rcsDamp ? 'ON' : 'OFF');
    this.setText(
      'throttle',
      `${C.THROTTLE_LABELS[player.throttleIdx]} (${C.THROTTLE_LEVELS[player.throttleIdx]!.toFixed(1)} m/s²)`,
    );
    const fineEl = this.els.get('fine');
    if (fineEl) {
      fineEl.textContent = player.fineAttitude ? 'ON' : 'OFF';
      fineEl.classList.toggle('mode-tgt', player.fineAttitude);
    }
    const camfollow = game.cameraSystem.combatCamera.camFollowAttitude;
    const camfollowEl = this.els.get('camfollow');
    if (camfollowEl) {
      camfollowEl.textContent = camfollow ? 'ON' : 'OFF';
      camfollowEl.classList.toggle('mode-tgt', camfollow);
    }
    const proholdEl = this.els.get('prohold');
    if (proholdEl) {
      proholdEl.textContent = player.progradeHold ? 'ON' : 'OFF';
      proholdEl.classList.toggle('mode-tgt', player.progradeHold);
    }
    const ammoEl = this.els.get('ammo');
    if (ammoEl) {
      ammoEl.textContent = fmtAmmoStatus(player.roundsInMag, player.magsLeft, player.reloadTimer);
      ammoEl.classList.toggle('warn-hot', player.reloadTimer > 0 || player.magsLeft < 4);
    }
  }

  // id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const e = this.els.get(id);
    if (e && e.textContent !== text) e.textContent = text;
  }
}
