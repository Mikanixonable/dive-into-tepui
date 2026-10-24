// 画面中央上部の警報帯。出ている警報のうち先頭の最大2件を「何が起きたか + 取るべき行動のキー +
// 確認」の1行ずつで示し、あふれた分は件数にまとめる。確認済みの警報帯は静かな表示に変わる。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { Button } from '../../hud/widgets';
import { createKeyCap } from '../../hud/key-cap';
import { alarmActionSignature, alarmContent, type AlarmContent } from './alarm-content';
import type { ActiveAlarm, AlarmItem } from '../alarm/alarm-evaluator';

// 同時に出す警報帯の枚数。
const MAX_BANDS = 2;

const LEVEL_LABELS = { caution: 'CAUTION', warning: 'WARNING' } as const;

// 警報帯1枚の DOM。更新のたびに作り直さず、押しかけの確認ボタンを保つ。
interface Band {
  level: ActiveAlarm['level'];
  readonly element: HTMLElement;
  readonly levelEl: HTMLElement;
  readonly messageEl: HTMLElement;
  readonly actionEl: HTMLElement;
  readonly ackButton: Button;
  readonly stateEl: HTMLElement;
  // 文言の略号の要素。値が動いても作り直さず、文字だけ書き換える。
  codeEl: HTMLElement | null;
  // 直近に書いた文言の区間ごとの DOM。区間の構成が同じなら文字だけ書き換える。
  parts: { readonly node: Text | HTMLElement; readonly strong: boolean }[];
  // 直近に書いた行動の構成。変わったときだけ行動の DOM を組み直す。
  actionSignature: string;
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
      // 段が上がった警報は新しく立った警報として作り直す。下がった警報は同じ帯の中で書き換える。
      const alarm = visible.find((candidate) => candidate.item === item);
      if (alarm !== undefined && !(band.level === 'caution' && alarm.level === 'warning')) continue;
      band.element.remove();
      this.bands.delete(item);
    }
    for (const alarm of visible) this.syncBand(this.bandOf(alarm), alarm);
    this.arrange(visible);
    this.syncMore(overflow);
  }

  // alarm の警報帯。無ければ組む。警報帯は role="alert" で、組まれたとき(新しく立った・段が上がった)に
  // だけ読み上げさせる — 値・段の語・確認の表示の書き換えは aria-live="off" の子の中で行い、読み上げさせない。
  private bandOf(alarm: ActiveAlarm): Band {
    const existing = this.bands.get(alarm.item);
    if (existing !== undefined) return existing;
    const element = document.createElement('div');
    element.className = `ui-alert ui-surface-focus is-${alarm.level}`;
    element.setAttribute('role', 'alert');
    const levelEl = document.createElement('span');
    levelEl.className = 'ui-alert-level';
    levelEl.textContent = LEVEL_LABELS[alarm.level];
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
    const children = [levelEl, body, ackButton.element, stateEl];
    element.append(...children);
    for (const child of children) child.setAttribute('aria-live', 'off');
    const band: Band = {
      level: alarm.level, element, levelEl, messageEl, actionEl, ackButton, stateEl,
      codeEl: null, parts: [], actionSignature: '',
    };
    this.bands.set(alarm.item, band);
    return band;
  }

  // 警報帯の段・文言・行動・確認済みの表示を alarm へ合わせる。
  private syncBand(band: Band, alarm: ActiveAlarm): void {
    if (band.level !== alarm.level) {
      band.element.classList.replace(`is-${band.level}`, `is-${alarm.level}`);
      band.level = alarm.level;
      band.levelEl.textContent = LEVEL_LABELS[alarm.level];
    }
    const content = alarmContent(alarm);
    this.writeMessage(band, content);
    const signature = alarmActionSignature(content);
    if (band.actionSignature !== signature) {
      band.actionSignature = signature;
      band.actionEl.replaceChildren(...content.actions.map((step) => {
        const element = document.createElement('span');
        element.className = 'ui-hint-step';
        element.append(...step.keys.map((key) => createKeyCap(key)), step.text);
        return element;
      }));
    }
    band.element.classList.toggle('is-acked', alarm.acknowledged);
    band.ackButton.element.classList.toggle('hidden', alarm.acknowledged);
    band.stateEl.classList.toggle('hidden', !alarm.acknowledged);
  }

  // 警報帯の文言を content へ合わせる。区間の構成(数と強調)が同じなら、変わった文字だけ書き換える。
  private writeMessage(band: Band, content: AlarmContent): void {
    if (band.codeEl === null) {
      band.codeEl = document.createElement('b');
      band.messageEl.replaceChildren(band.codeEl);
    }
    if (band.codeEl.textContent !== content.code) band.codeEl.textContent = content.code;
    const sameShape = band.parts.length === content.message.length
      && band.parts.every((part, index) => part.strong === content.message[index]!.strong);
    if (!sameShape) {
      band.parts = content.message.map((part) => ({
        node: part.strong ? document.createElement('b') : document.createTextNode(''),
        strong: part.strong,
      }));
      band.messageEl.replaceChildren(band.codeEl, ...band.parts.map((part) => part.node));
    }
    content.message.forEach((part, index) => {
      const { node } = band.parts[index]!;
      if (node.textContent !== part.text) node.textContent = part.text;
    });
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
