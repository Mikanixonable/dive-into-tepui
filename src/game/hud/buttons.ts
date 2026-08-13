// hud/widgets/ への薄い委譲層。呼び出し側は hud/widgets/ の各ウィジェットへ移行し、
// このファイルは移行が済んだ呼び出し側から順に不要になる。dom.ts の既存 CSS(.seg-btn/
// .hud-seg/.hold-btn/.icon-toggle-btn/.category-toggle-btn/.hud-toggle 以下)は他の
// パネルからも直接参照されているため、委譲先ウィジェットが組んだ要素のクラス名を
// 旧名へ差し替えて両立させる(w-* と旧名を両方持たせると、新旧2つのスタイル規則が
// 同じプロパティを異なる値で競合させてしまう)。
import { Button, HoldButton, SegmentedControl as WidgetSegmentedControl, ToggleSwitch } from './widgets';

// 単発の実行ボタン。
export function hudButton(label: string, onClick: () => void): HTMLElement {
  const btn = new Button(label, onClick);
  btn.element.className = 'seg-btn';
  return btn.element;
}

// 見出し + 排他選択のボタン列。T は Map のキーとして参照同一性で引けるものであれば足りる
// (文字列に限らない — 座標系の ReferenceFrame オブジェクトなど、正準インスタンスの集合から選ぶ値も扱う)。
export class SegmentedControl<T> {
  readonly element: HTMLElement;
  private readonly inner: WidgetSegmentedControl<T>;

  // items は [値, 表示ラベル] の並びで、その順にボタンを並べる。
  constructor(title: string, items: readonly (readonly [T, string])[], onSelect: (value: T) => void) {
    this.inner = new WidgetSegmentedControl(title, items, onSelect);
    this.element = this.inner.element;
    this.element.className = 'hud-seg';
    this.patchLegacyClasses();
  }

  // 選択中の値を点灯させる。
  setSelected(value: T): void {
    this.inner.setSelected(value);
  }

  // ボタン列を items へ丸ごと差し替える。
  setItems(items: readonly (readonly [T, string])[]): void {
    this.inner.setItems(items);
    this.patchLegacyClasses();
  }

  // 差し替え後に組み直された見出し・各ボタンへ旧クラス名を貼り直す。
  private patchLegacyClasses(): void {
    const title = this.element.querySelector<HTMLElement>('.w-group-title');
    if (title) title.className = 'seg-title';
    this.element.querySelectorAll<HTMLElement>('.w-btn').forEach((btn) => { btn.className = 'seg-btn'; });
  }
}

// 押している間 isHeld が true になるボタン。呼び出し側がゲームループから毎フレーム isHeld を
// 読み、押している間だけ処理を続ける形で使う。
export class HudHoldButton {
  readonly element: HTMLElement;
  private readonly inner: HoldButton;

  get isHeld(): boolean {
    return this.inner.isHeld;
  }

  // label はボタンの表示文字列。
  constructor(label: string) {
    this.inner = new HoldButton(label);
    this.element = this.inner.element;
    this.element.className = 'seg-btn hold-btn';
  }
}

// クリックのたびに ON/OFF が切り替わる、絵文字1字程度のグリフだけの小型トグル。複数個を
// 1行に並べて「アイコン/ラベル/軌道線」のような同種の切り替えをまとめて出す場面向け。
export class IconToggleButton {
  readonly element: HTMLElement;
  private readonly button: Button;
  private on = false;

  // glyph は表示するグリフ、title はホバー時に出る説明文。onChange は切り替わった後の値で呼ばれる。
  constructor(glyph: string, title: string, onChange: (on: boolean) => void) {
    this.button = new Button(glyph, () => {
      this.setOn(!this.on);
      onChange(this.on);
    });
    this.element = this.button.element;
    this.element.className = 'seg-btn icon-toggle-btn';
    this.element.title = title;
  }

  // 表示状態を設定する(onChange は呼ばれない)。
  setOn(on: boolean): void {
    this.on = on;
    this.button.setOn(on);
  }

  // 親カテゴリーが OFF の間は個別設定を保持したまま操作だけ止める(Button 自身が
  // disabled 中のクリックを無視するので、ここでは委譲するだけでよい)。
  setEnabled(enabled: boolean): void {
    this.button.setEnabled(enabled);
  }
}

// カテゴリー名のように、文字列そのものを押して ON/OFF を切り替えるトグル。
export class HudToggleButton {
  readonly element: HTMLElement;
  private readonly button: Button;
  private on = true;

  // label はボタンの表示文字列、title はホバー時に出る説明文。onChange は切り替わった後の値で呼ばれる。
  constructor(label: string, title: string, onChange: (on: boolean) => void) {
    this.button = new Button(label, () => {
      this.setOn(!this.on);
      onChange(this.on);
    });
    this.element = this.button.element;
    this.element.className = 'seg-btn category-toggle-btn';
    this.element.title = title;
    this.setOn(true);
  }

  // 表示状態を設定する(onChange は呼ばれない)。
  setOn(on: boolean): void {
    this.on = on;
    this.button.setOn(on);
  }
}

// 見出し + ON/OFF を切り替えるトグルスイッチ。
export class HudToggle {
  readonly element: HTMLElement;
  private readonly inner: ToggleSwitch;

  // title は見出し。onChange は切り替わった後の値で呼ばれる。
  constructor(title: string, onChange: (on: boolean) => void) {
    this.inner = new ToggleSwitch(title, onChange);
    this.element = this.inner.element;
    this.element.className = 'hud-toggle';
    // 見出し・トラック・つまみの3要素それぞれへ旧クラス名を貼り直す。
    const heading = this.element.querySelector<HTMLElement>('.w-toggle-title');
    if (heading) heading.className = 'toggle-title';
    const track = this.element.querySelector<HTMLElement>('.w-toggle-track');
    if (track) {
      track.className = 'toggle-track';
      const knob = track.querySelector<HTMLElement>('.w-toggle-knob');
      if (knob) knob.className = 'toggle-knob';
    }
  }

  // 表示状態を設定する(onChange は呼ばれない)。
  setOn(on: boolean): void {
    this.inner.setOn(on);
  }
}
