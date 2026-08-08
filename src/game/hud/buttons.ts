// HUD パネル共通のボタン部品。値を排他選択する SegmentedControl と、単発実行の hudButton。

// 単発の実行ボタン。
export function hudButton(label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('span');
  btn.className = 'seg-btn';
  btn.textContent = label;
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// 見出し + 排他選択のボタン列。T は Map のキーとして参照同一性で引けるものであれば足りる
// (文字列に限らない — 座標系の ReferenceFrame オブジェクトなど、正準インスタンスの集合から選ぶ値も扱う)。
export class SegmentedControl<T> {
  readonly element: HTMLElement;
  private readonly buttons = new Map<T, HTMLElement>();

  // items は [値, 表示ラベル] の並びで、その順にボタンを並べる。
  constructor(title: string, items: readonly (readonly [T, string])[], onSelect: (value: T) => void) {
    this.element = document.createElement('div');
    this.element.className = 'hud-seg';
    // 見出し
    const heading = document.createElement('span');
    heading.className = 'seg-title';
    heading.textContent = title;
    this.element.appendChild(heading);
    // 各項目をボタン化して並べる
    for (const [value, label] of items) {
      const btn = hudButton(label, () => onSelect(value));
      this.element.appendChild(btn);
      this.buttons.set(value, btn);
    }
  }

  // 選択中の値を点灯させる。候補外の値(ラベルメニューから選んだフォーカスなど)では全消灯になる。
  setSelected(value: T): void {
    for (const [v, btn] of this.buttons) btn.classList.toggle('on', v === value);
  }
}

// 押している間 isHeld が true になるボタン。呼び出し側がゲームループから毎フレーム isHeld を
// 読み、押している間だけ処理を続ける形で使う。
export class HudHoldButton {
  readonly element: HTMLElement;
  private held = false;

  get isHeld(): boolean {
    return this.held;
  }

  // label はボタンの表示文字列。
  constructor(label: string) {
    this.element = document.createElement('span');
    this.element.className = 'seg-btn hold-btn';
    this.element.textContent = label;
    this.element.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.held = true;
      this.element.setPointerCapture(e.pointerId);
    });
    const release = (e: PointerEvent): void => {
      this.held = false;
      try {
        this.element.releasePointerCapture(e.pointerId);
      } catch {
        /* すでに解放済みなら無視 */
      }
    };
    this.element.addEventListener('pointerup', release);
    this.element.addEventListener('pointercancel', release);
    this.element.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

// 見出し + ON/OFF を切り替えるトグルスイッチ。
export class HudToggle {
  readonly element: HTMLElement;
  private readonly track: HTMLElement;
  private on = false;

  // title は見出し。onChange は切り替わった後の値で呼ばれる。
  constructor(title: string, onChange: (on: boolean) => void) {
    this.element = document.createElement('div');
    this.element.className = 'hud-toggle';
    const heading = document.createElement('span');
    heading.className = 'toggle-title';
    heading.textContent = title;
    this.element.appendChild(heading);

    // クリックを受けるのはトラックで、つまみは表示だけを担う
    this.track = document.createElement('span');
    this.track.className = 'toggle-track';
    const knob = document.createElement('span');
    knob.className = 'toggle-knob';
    this.track.appendChild(knob);
    this.track.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.track.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setOn(!this.on);
      onChange(this.on);
    });
    this.element.appendChild(this.track);
  }

  // 表示状態を設定する(onChange は呼ばれない)。
  setOn(on: boolean): void {
    this.on = on;
    this.track.classList.toggle('on', on);
  }
}
