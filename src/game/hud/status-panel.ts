// 常設 SHIP STATUS パネル(#hud-status)の同期: RCS制動・並進出力・微調整・
// 進行方向ホールド・視点のRCS追従・弾薬。自機が無ければ隠す。
// 装填/姿勢リセット/視点追従切替/ターゲット選択の4操作と、タッチ時のみのスロットル段は、
// キー押下と同じ経路(Input.tapKey)で発火するボタンとして
// ここに持つ — タッチでも到達できるようにするための、キー入力の代替 UI。
import * as C from '../const';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Button, SegmentedControl } from './widgets';
import { fmtAmmoStatus } from './utils';
import type { Game } from '../game';
import type { Input } from '../input/input';
import type { KeyBinding } from '../input/key-mapping';

const SYNC_INTERVAL_MS = 100;

const THROTTLE_KEYS: readonly KeyBinding[] = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax];

export class StatusPanel {
  private nextSyncAt = 0;
  private input: Input | null = null;
  private readonly throttleControl: SegmentedControl<number> | null;

  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {
    this.buildActionButtons();
    this.throttleControl = this.buildThrottleControl();
  }

  // Game 構築後に Input を差し込む。ボタン構築時にはまだ存在しないための late injection。
  public setInput(input: Input): void {
    this.input = input;
  }

  // R/F/G/T の代替操作ボタンを組み立てて status-actions プレースホルダへ足す。
  private buildActionButtons(): void {
    const container = this.els.get('status-actions');
    if (!container) return;
    const addAction = (label: string, title: string, key: KeyBinding, isPrimary = false): void => {
      const button = new Button(label, () => this.input?.tapKey(key));
      button.element.title = title;
      button.element.setAttribute('aria-label', `${label}、キー ${key.label}`);
      button.element.setAttribute('aria-keyshortcuts', key.label);
      button.element.classList.toggle('status-action-primary', isPrimary);
      container.appendChild(button.element);
    };
    addAction(
      `進行方向 [${K.progradeReset.label}]`,
      'プログレード姿勢リセット（機首を進行方向へ即座に向ける）',
      K.progradeReset,
    );
    addAction(
      `視点追従 [${K.followAttitudeToggle.label}]`,
      '視点のRCS追従を切り替える',
      K.followAttitudeToggle,
    );
    addAction(
      `ターゲット [${K.targetSelect.label}]`,
      '照準に近い敵を第一ターゲットにする',
      K.targetSelect,
      true,
    );
    addAction(`装填 [${K.reload.label}]`, 'マニュアル装填', K.reload);
  }

  // スロットル 1-4 の SegmentedControl を組み立てて status-throttle-touch プレースホルダへ足す。
  // 表示可否は CSS(body.touch-ui-active)側が持つ — ここでは常に組む。
  private buildThrottleControl(): SegmentedControl<number> | null {
    const container = this.els.get('status-throttle-touch');
    if (!container) return null;
    const control = new SegmentedControl<number>(
      '推力段', THROTTLE_KEYS.map((key, i) => [i, key.label] as const),
      (index) => this.input?.tapKey(THROTTLE_KEYS[index]!),
    );
    container.appendChild(control.element);
    return control;
  }

  public sync(game: Game): void {
    const player = game.player;
    if (!player) {
      document.getElementById('hud-status')?.classList.add('hidden');
      return;
    }
    // マップビューでは艦固有の情報をプロパティウィンドウで参照するので畳む。
    // CSS 側でも #hud.map-mode #hud-status を隠すが、未配置状態からの復帰時は JS で明示的に戻す。
    if (!game.cameraSystem.overviewMode) document.getElementById('hud-status')?.classList.remove('hidden');

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    this.syncState('rcs', player.rcsDamp, 'near');
    this.setText(
      'throttle',
      `${C.THROTTLE_LABELS[player.throttleIdx]} (${C.THROTTLE_LEVELS[player.throttleIdx]!.toFixed(1)} m/s²)`,
    );
    this.throttleControl?.setSelected(player.throttleIdx);
    this.syncState('fine', player.fineAttitude, 'near');
    const cameraFollowsAttitude = game.cameraSystem.combatCamera.camFollowAttitude;
    this.syncState('camfollow', cameraFollowsAttitude, 'signal');
    this.syncState('prohold', player.progradeHold, 'near');
    const ammo = this.els.get('ammo');
    if (ammo) {
      ammo.textContent = fmtAmmoStatus(player.roundsInMag, player.magsLeft, player.reloadTimer);
      ammo.classList.toggle('warn-hot', player.reloadTimer > 0 || player.magsLeft < 4);
    }
  }

  // id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const element = this.els.get(id);
    if (element && element.textContent !== text) element.textContent = text;
  }

  // 機体モードの状態語と色ロールを同期する。
  // Near は隣接する操縦支援、Signal は視点同期に使う。
  private syncState(id: string, isActive: boolean, role: 'near' | 'signal'): void {
    const element = this.els.get(id);
    if (!element) return;
    element.textContent = isActive ? 'On' : 'Off';
    element.classList.toggle('state-near', isActive && role === 'near');
    element.classList.toggle('state-signal', isActive && role === 'signal');
  }
}
