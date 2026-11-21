// 警報帯(#hud-alarm-band): 鳴っている警報を「何が起きていて、何をすればよいか」の形で出す。
// 未確認の警告は確認されるまで点滅し、確認のボタンを添える(UI-DESIGN.md「警報と通知」)。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { Button } from '../../hud/widgets';
import type { HudEls } from './hud-els';
import type { ShipAlarm, ShipAlarms } from '../alarm/ship-alarms';

// 警報帯が同時に出す件数。あふれた分は件数にまとめる(UI-DESIGN.md「警報と通知」)。
const MAX_VISIBLE = 2;

// 警報の id と段から出す、「何が起きているか」の一文。
const ALARM_TEXT: Readonly<Record<ShipAlarm['id'], Record<'caution' | 'warning', string>>> = {
  hullTemperature: {
    caution: '注意: 高温',
    warning: '警告: 高温',
  },
};

export class AlarmBand {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly ackButton: Button;
  // 直近の sync が渡した警報。確認ボタンはフレームの外で押されるので、押す相手をここから引く。
  private alarms: ShipAlarms | null = null;
  // 直近に描いた内容の署名。変わらなければ DOM を組み直さない。
  private signature = '';

  public constructor(els: HudEls) {
    this.root = els.get('alarm-band');
    this.list = document.createElement('div');
    this.list.className = 'alarm-band-list';
    this.ackButton = new Button(
      '確認', () => this.alarms?.acknowledge(), undefined, 'secondary', K.alarmAcknowledge.label,
    );
    this.ackButton.element.classList.add('alarm-band-ack', 'hidden');
    this.root.append(this.list, this.ackButton.element);
  }

  // 鳴っている警報を帯へ反映する。鳴っていなければ畳む。
  public sync(alarms: ShipAlarms | null): void {
    this.alarms = alarms;
    const entries = alarms?.entries ?? [];
    const signature = entries
      .map((alarm) => `${alarm.id}:${alarm.level}:${alarm.acknowledged ? 'ack' : ''}`)
      .join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.root.classList.toggle('hidden', entries.length === 0);
      this.list.innerHTML = entries.slice(0, MAX_VISIBLE).map(AlarmBand.itemHtml).join('')
        + (entries.length > MAX_VISIBLE
          ? `<div class="alarm-band-item more">他 ${entries.length - MAX_VISIBLE} 件の警報</div>`
          : '');
    }
    this.ackButton.element.classList.toggle('hidden', !(alarms?.unacknowledgedWarning ?? false));
  }

  private static itemHtml(alarm: ShipAlarm): string {
    const unack = alarm.level === 'warning' && !alarm.acknowledged;
    return `<div class="alarm-band-item ui-surface-focus${unack ? ' unack' : ''}">`
      + `<output class="alarm-band-text ui-${alarm.level}">${ALARM_TEXT[alarm.id][alarm.level]}</output>`
      + '</div>';
  }
}
