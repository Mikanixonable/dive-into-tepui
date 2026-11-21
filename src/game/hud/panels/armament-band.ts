// 戦闘ビューの画面下中央に出す武装の帯(#hud-armament-band)。弾帯の残り・予備の弾倉数・弾速・
// 装填の操作を示す。機関砲を積んでいない操作対象では出さない(UI-DESIGN.md §8)。
import { KEY_MAPPING as K } from '../../../input-devices/key-mapping';
import { Button } from '../../../hud-kit/widgets';
import { applyAlarmLevel } from '../../../hud-kit/alarm-level';
import { ammoAlarmLevel } from '../../alarm-level';
import { fmtAmmoStatus, reloadDisabledReason, type AmmoViewModel } from '../ammo-status';
import type { KeyBinding } from '../../../input-devices/key-mapping';

// 武装の帯が1フレームに表示する値と、装填操作のコールバック。
export interface ArmamentBandViewModel {
  readonly ammo: AmmoViewModel;
  tapKey(key: KeyBinding): void;
}

export class ArmamentBand {
  private readonly panel: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly velocityEl: HTMLElement;
  private readonly reloadButton: Button;
  // 直近の sync で受け取った状態。ボタン押下はフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: ArmamentBandViewModel | null = null;

  // 帯の DOM を組み立てて combatRoot へ足す。装填ボタンは R キーと同じ経路で発火する、
  // タッチでも到達できるキー入力の代替 UI。
  public constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-armament-band';
    this.panel.className = 'panel hidden';
    this.panel.setAttribute('aria-label', '武装');
    const code = document.createElement('span');
    code.className = 'armament-code';
    code.setAttribute('aria-hidden', 'true');
    code.textContent = 'ARM';
    this.statusEl = document.createElement('output');
    this.statusEl.className = 'armament-status';
    this.velocityEl = document.createElement('output');
    this.velocityEl.className = 'armament-velocity';
    this.reloadButton = new Button(
      '装填', () => this.view?.tapKey(K.reload),
      undefined, ['dense', 'secondary'], K.reload.label,
    );
    this.reloadButton.element.title = 'マニュアル装填';
    this.reloadButton.element.setAttribute('aria-label', `装填、キー ${K.reload.label}`);
    this.reloadButton.element.setAttribute('aria-keyshortcuts', K.reload.label);
    this.panel.append(code, this.statusEl, this.velocityEl, this.reloadButton.element);
    root.appendChild(this.panel);
  }

  // 弾薬の状態を帯へ反映する。view が null(機関砲を積んでいない)なら帯ごと隠す。
  public sync(view: ArmamentBandViewModel | null): void {
    this.view = view;
    this.panel.classList.toggle('hidden', view === null);
    if (view === null) return;
    const { ammo } = view;
    // 弾帯の残りと予備の弾倉数は、装填中の表示を優先する fmtAmmoStatus に一任する。
    const statusText = fmtAmmoStatus(ammo.rounds, ammo.mags, ammo.cooldown);
    if (this.statusEl.textContent !== statusText) this.statusEl.textContent = statusText;
    // 弾速は初速の平均。持たない操作対象では欄を出さない。
    const velocityText = ammo.muzzleVelocityMps === null ? '' : `${Math.round(ammo.muzzleVelocityMps)} m/s`;
    if (this.velocityEl.textContent !== velocityText) this.velocityEl.textContent = velocityText;
    this.velocityEl.classList.toggle('hidden', ammo.muzzleVelocityMps === null);
    // 予備が尽きかけたとき注意、弾が尽きたとき警告(UI-DESIGN.md §8)。
    applyAlarmLevel(this.statusEl, ammoAlarmLevel(ammo.rounds, ammo.mags));
    // 装填できない操作は項目を残して無効状態と理由を示す(UI-DESIGN.md §3)。
    // 理由はボタンの title と aria-label へ載せ、弾切れは隣の状態表示にも出る。
    const reason = reloadDisabledReason(ammo);
    this.reloadButton.setEnabled(reason === null);
    this.reloadButton.element.title = reason ?? 'マニュアル装填';
    this.reloadButton.element.setAttribute(
      'aria-label',
      reason === null
        ? `装填、キー ${K.reload.label}`
        : `装填できません、${reason}、キー ${K.reload.label}`,
    );
    this.panel.setAttribute('aria-label', `武装 ${statusText}${velocityText ? `、弾速 ${velocityText}` : ''}`);
  }
}
