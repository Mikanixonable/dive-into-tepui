// 常設 SHIP STATUS パネル(#hud-status)の同期: RCS制動・並進出力・微調整・進行方向ホールド・
// 視点のRCS追従・弾薬。自機が無ければ隠す。装填/姿勢リセット/視点追従切替/ターゲット選択の
// 4操作と、タッチ時のみのスロットル段はキー押下と同じ経路(Input.tapKey)で発火するボタンとして
// ここに持つ — タッチでも到達できるようにするための、キー入力の代替 UI。
import * as C from '../const';
import { fmtAmmoStatus } from './utils';
import type { Game } from '../game';
import type { Input } from '../input/input';
import { KEY_MAPPING as K, KeyBinding } from '../input/key-mapping';
import { Button, SegmentedControl } from './widgets';

const SYNC_INTERVAL_MS = 100;

const THROTTLE_KEYS: readonly KeyBinding[] = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax];

export class StatusPanel {
  private nextSyncAt = 0;
  private input: Input | null = null;
  private readonly throttleControl: SegmentedControl<number> | null;

  constructor(private readonly els: Map<string, HTMLElement>) {
    this.buildActionButtons();
    this.throttleControl = this.buildThrottleControl();
  }

  // Game 構築後に Input を差し込む。ボタンの構築時点ではまだ存在しないための late injection。
  setInput(input: Input): void {
    this.input = input;
  }

  // R/F/G/T の代替操作ボタンを組み立てて status-actions プレースホルダへ足す。
  private buildActionButtons(): void {
    const container = this.els.get('status-actions');
    if (!container) return;
    const mk = (label: string, title: string, key: KeyBinding): void => {
      const btn = new Button(label, () => this.input?.tapKey(key));
      btn.element.title = title;
      container.appendChild(btn.element);
    };
    mk(`進行方向 [${K.progradeReset.label}]`, 'プログレード姿勢リセット(機首を進行方向へ即座に向ける)', K.progradeReset);
    mk(`視点追従 [${K.followAttitudeToggle.label}]`, '視点のRCS追従を切り替える', K.followAttitudeToggle);
    mk(`ターゲット [${K.targetSelect.label}]`, '照準に近い敵をターゲット選択', K.targetSelect);
    mk(`装填 [${K.reload.label}]`, 'マニュアル装填', K.reload);
  }

  // スロットル 1-4 の SegmentedControl を組み立てて status-throttle-touch プレースホルダへ足す。
  // 表示可否は CSS(body.touch-ui-active)側が持つ — ここでは常に組む。
  private buildThrottleControl(): SegmentedControl<number> | null {
    const container = this.els.get('status-throttle-touch');
    if (!container) return null;
    const control = new SegmentedControl<number>(
      '推力段', THROTTLE_KEYS.map((key, i) => [i, key.label] as const),
      (idx) => this.input?.tapKey(THROTTLE_KEYS[idx]!),
    );
    container.appendChild(control.element);
    return control;
  }

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
    this.throttleControl?.setSelected(player.throttleIdx);
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
