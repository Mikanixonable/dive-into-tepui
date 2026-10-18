// 画面中央上部の警報帯。出ている警報のうち先頭の最大2件を「何が起きたか + 取るべき行動のキー +
// 確認」の1行ずつで示し、あふれた分は件数にまとめる。確認済みの警報帯は静かな表示に変わる。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { Button } from '../../hud/widgets';
import { createKeyCap } from '../../hud/key-cap';
import { alarmContent, type AlarmContent } from './alarm-content';
import type { ActiveAlarm, AlarmItem } from '../alarm/alarm-evaluator';

// 同時に出す警報帯の枚数。
const MAX_BANDS = 2;

const LEVEL_LABELS = { caution: 'CAUTION', warning: 'WARNING' } as const;

// 警報帯1枚の DOM。更新のたびに作り直さず、押しかけの確認ボタンを保つ。
interface Band {
  readonly level: ActiveAlarm['level'];
  readonly element: HTMLElement;
  readonly messageEl: HTMLElement;
  readonly actionEl: HTMLElement;
  readonly ackButton: Button;
  readonly stateEl: HTMLElement;
  // 直近に書いた文言と行動。変わったときだけ DOM を書き換える。
  signature: string;
}

// 文言と行動を比較用の文字列にする。
function contentSignature(content: AlarmContent): string {
  return JSON.stringify([content.message, content.actions]);
}

export class AlarmBand {
  private readonly bands = new Map<AlarmItem, Band>();
  private readonly moreEl: HTMLElement;

  // stack は警報帯を並べる要素。acknowledge は確認ボタンが押されたときに呼ぶ。
  public constructor(private readonly stack: HTMLElement, private readonly acknowledge: () => void) {
    this.moreEl = document.createElement('span');
    this.moreEl.className = 'ui-more hidden';
  }

  // 警報の列 alarms(警告が先、同じ段では新しいものが先)を警報帯へ反映する。
  public sync(alarms: readonly ActiveAlarm[]): void {
    const visible = alarms.slice(0, MAX_BANDS);
    const overflow = alarms.slice(MAX_BANDS);
    for (const [item, band] of this.bands) {
      if (visible.some((alarm) => alarm.item === item && alarm.level === band.level)) continue;
      band.element.remove();
      this.bands.delete(item);
    }
    for (const alarm of visible) this.syncBand(this.bandOf(alarm), alarm);
    this.arrange(visible);
    this.syncMore(overflow);
  }

  // alarm の警報帯。無いか段が変わっていれば組み直す。
  private bandOf(alarm: ActiveAlarm): Band {
    const existing = this.bands.get(alarm.item);
    if (existing !== undefined) return existing;
    const element = document.createElement('div');
    element.className = `ui-alert ui-surface-focus is-${alarm.level}`;
    element.setAttribute('role', 'alert');
    const level = document.createElement('span');
    level.className = 'ui-alert-level';
    level.textContent = LEVEL_LABELS[alarm.level];
    const body = document.createElement('span');
    body.className = 'ui-alert-body';
    const messageEl = document.createElement('span');
    messageEl.className = 'ui-alert-msg';
    const actionEl = document.createElement('span');
    actionEl.className = 'ui-alert-act';
    body.append(messageEl, actionEl);
    const ackButton = new Button('確認', () => this.acknowledge(), undefined, ['dense', 'secondary'], K.acknowledgeAlarm.label);
    const stateEl = document.createElement('span');
    stateEl.className = 'ui-alert-state hidden';
    stateEl.textContent = '確認済';
    element.append(level, body, ackButton.element, stateEl);
    const band: Band = { level: alarm.level, element, messageEl, actionEl, ackButton, stateEl, signature: '' };
    this.bands.set(alarm.item, band);
    return band;
  }

  // 警報帯の文言・行動・確認済みの表示を alarm へ合わせる。
  private syncBand(band: Band, alarm: ActiveAlarm): void {
    const content = alarmContent(alarm);
    const signature = contentSignature(content);
    if (band.signature !== signature) {
      band.signature = signature;
      this.writeContent(band, content);
    }
    band.element.classList.toggle('is-acked', alarm.acknowledged);
    band.ackButton.element.classList.toggle('hidden', alarm.acknowledged);
    band.stateEl.classList.toggle('hidden', !alarm.acknowledged);
  }

  // 警報帯の文言と行動の DOM を content から書く。
  private writeContent(band: Band, content: AlarmContent): void {
    const code = document.createElement('b');
    code.textContent = content.code;
    const parts = content.message.map((part) => {
      if (!part.strong) return document.createTextNode(part.text);
      const strong = document.createElement('b');
      strong.textContent = part.text;
      return strong;
    });
    band.messageEl.replaceChildren(code, ...parts);
    band.actionEl.replaceChildren(...content.actions.map((step) => {
      const element = document.createElement('span');
      element.className = 'ui-hint-step';
      element.append(...step.keys.map((key) => createKeyCap(key)), step.text);
      return element;
    }));
  }

  // 警報帯を visible の並びに揃え、件数の要素を末尾へ置く。並びが合っていれば DOM に触れない。
  private arrange(visible: readonly ActiveAlarm[]): void {
    const wanted = [...visible.map((alarm) => this.bands.get(alarm.item)!.element), this.moreEl];
    wanted.forEach((element, index) => {
      if (this.stack.children[index] !== element) this.stack.insertBefore(element, this.stack.children[index] ?? null);
    });
  }

  // あふれた警報の件数を、最も重い段の記号つきで示す。無ければ隠す。
  private syncMore(overflow: readonly ActiveAlarm[]): void {
    this.moreEl.classList.toggle('hidden', overflow.length === 0);
    if (overflow.length === 0) return;
    const warned = overflow.some((alarm) => alarm.level === 'warning');
    this.moreEl.classList.toggle('is-warning', warned);
    this.moreEl.classList.toggle('is-caution', !warned);
    const text = `他に ${overflow.length} 件`;
    if (this.moreEl.textContent !== text) this.moreEl.textContent = text;
  }
}
