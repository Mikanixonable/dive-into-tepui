// 常設 VESSEL パネル(#hud-status)の同期: RCS制動・並進出力・微調整・
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
import { TANK_MATERIALS, type PropellantId } from '../economy/propellant-compatibility';

const SYNC_INTERVAL_MS = 100;

type PropellantFuelSummary =
  readonly { readonly propellant: PropellantId; readonly fuel: number; readonly capacity: number }[];

const THROTTLE_KEYS: readonly KeyBinding[] = [K.throttleLow, K.throttleMid, K.throttleHigh, K.throttleMax];

export class VesselPanel {
  private nextSyncAt = 0;
  private input: Input | null = null;
  private followButton: Button | null = null;
  private readonly throttleControl: SegmentedControl<number> | null;

  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {
    this.buildActionButtons();
    this.throttleControl = this.buildThrottleControl();
  }

  // 操作の受け口となる Input を差し込む。ボタン構築時にはまだ存在しないための late injection で、
  // null は「今は受け口が無い」— このパネルは Game より長生きするので、その状態が実在する。
  public setInput(input: Input | null): void {
    this.input = input;
  }

  // R/F/G/T の代替操作ボタンを組み立てて status-actions プレースホルダへ足す。
  private buildActionButtons(): void {
    const container = this.els.get('status-actions');
    if (!container) return;
    const addAction = (label: string, title: string, key: KeyBinding, isPrimary = false): Button => {
      const button = new Button(label, () => this.input?.tapKey(key));
      button.element.title = title;
      button.element.setAttribute('aria-label', `${label}、キー ${key.label}`);
      button.element.setAttribute('aria-keyshortcuts', key.label);
      button.element.classList.toggle('status-action-primary', isPrimary);
      container.appendChild(button.element);
      return button;
    };
    addAction(
      `進行方向 [${K.progradeReset.label}]`,
      'プログレード姿勢リセット（機首を進行方向へ即座に向ける）',
      K.progradeReset,
    );
    this.followButton = addAction(
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
    const target = game.followedVessel;
    if (!target) {
      document.getElementById('hud-vessel-status')?.classList.add('hidden');
      return;
    }
    // 通常のマップビューでは艦固有の情報をプロパティウィンドウで参照するので畳む。
    // クリエイティブでは配置後の艦を常に操作できるため、マップビューでも VESSEL を表示する。
    // CSS 側でも同じ条件を持つが、未配置状態からの復帰時は JS で明示的に戻す。
    if (!game.cameraSystem.overviewMode || game.activeStage.id === 'creative') {
      document.getElementById('hud-vessel-status')?.classList.remove('hidden');
    }

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    this.syncState('rcs', target.throttle.rcsDamp, 'near');
    this.setText(
      'throttle',
      `${C.THROTTLE_LABELS[target.throttle.throttleIdx]} (${C.THROTTLE_LEVELS[target.throttle.throttleIdx]!.toFixed(1)} m/s²)`,
    );
    this.throttleControl?.setSelected(target.throttle.throttleIdx);
    const fineAtt = target.fineAttitude;
    this.syncState('fine', fineAtt, 'near');
    const cameraFollowsAttitude = game.cameraSystem.combatCamera.camFollowAttitude;
    this.syncState('camfollow', cameraFollowsAttitude, 'signal');
    this.followButton?.setOn(cameraFollowsAttitude);
    this.syncState('prohold', target.throttle.progradeHold, 'near');

    const summary = target.propellantSummary();
    this.syncFuelRows(summary);

    const ammo = this.els.get('ammo');
    if (ammo) {
      // 砲を積まない機体(軌道基地など)は、弾薬の代わりに推進剤の残量を出す。
      if (target.fire) {
        ammo.textContent = fmtAmmoStatus(target.roundsInMag, target.magsLeft, target.reloadTimer);
        ammo.classList.toggle('warn-hot', target.reloadTimer > 0 || target.magsLeft < 4);
      } else {
        const totalFuel = summary.reduce((s, p) => s + p.fuel, 0);
        const totalCapacity = summary.reduce((s, p) => s + p.capacity, 0);
        ammo.textContent = `Fuel: ${Math.round(totalFuel)} / ${Math.round(totalCapacity)}`;
        ammo.classList.toggle('warn-hot', totalCapacity > 0 && totalFuel < totalCapacity * 0.2);
      }
    }
  }

  // id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const element = this.els.get(id);
    if (element && element.textContent !== text) element.textContent = text;
  }

  // 積んでいる推進剤ごとに1行/1本の燃料メーターを描く。行は要素にリスナーを持たないので、
  // 他のパネルと違い毎回 innerHTML をまるごと書き直してよい。
  private syncFuelRows(summary: PropellantFuelSummary): void {
    const container = this.els.get('fuel-rows');
    if (!container) return;
    container.innerHTML = summary.map(({ propellant, fuel, capacity }) => {
      const clamped = Math.max(0, Math.min(capacity, fuel));
      const percent = capacity > 0 ? (clamped / capacity) * 100 : 0;
      const valueText = `${Math.round(clamped)} / ${Math.round(capacity)}`;
      const critical = capacity > 0 && clamped < capacity * 0.2;
      const name = TANK_MATERIALS[propellant].name;
      return `
        <div class="row metric">
          <dt class="k">${name}</dt>
          <dd class="v rcs-fuel-readout">
            <span class="rcs-fuel-meter${critical ? ' critical' : ''}" role="progressbar"
              aria-label="${name}" aria-valuemin="0" aria-valuemax="${capacity}"
              aria-valuenow="${clamped}" aria-valuetext="${valueText}">
              <span class="rcs-fuel-fill" style="width:${percent.toFixed(1)}%"></span>
            </span>
            <output class="rcs-fuel-value">${valueText}</output>
          </dd>
        </div>`;
    }).join('');
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
