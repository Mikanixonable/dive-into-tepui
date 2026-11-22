// 実験環境(render-lab / cloud-lab)の画面が共有する操作部品。row の id を受けてその中へ
// ボタン列・チェックボックス・スライダー(目盛り付きを含む)を足し、選択の見た目を合わせ直す関数を返す。値の正本は
// 呼び出し側が持つ。ゲーム本体のウィジェット(src/hud/widgets)は HUD のトークンとタッチ操作の
// 前提に組まれているため、実験環境では使わず、ここの素の部品を使う。

// row の中に選択肢ぶんのボタンを並べ、押されたら select を呼ぶ。返り値で選択の見た目を更新する。
export function buildButtonRow<T extends string>(
  rowId: string, entries: readonly (readonly [T, string])[], select: (value: T) => void,
): (active: T) => void {
  const row = document.getElementById(rowId)!;
  // 値を鍵にボタンを持ち、点灯はここから引き直す。
  const buttons = new Map<T, HTMLButtonElement>();
  for (const [value, label] of entries) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => select(value));
    row.appendChild(button);
    buttons.set(value, button);
  }
  return (active) => {
    for (const [value, button] of buttons) {
      button.classList.toggle('active', value === active);
      button.setAttribute('aria-pressed', String(value === active));
    }
  };
}

// row の中にチェックボックスを1つ足す。層の表示切替のような ON/OFF の項目に使う。
export function buildCheckbox(rowId: string, label: string, initial: boolean,
  change: (on: boolean) => void): void {
  const field = document.createElement('label');
  field.className = 'field';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initial;
  const name = document.createElement('span');
  name.textContent = label;
  input.addEventListener('change', () => change(input.checked));
  field.append(input, name);
  document.getElementById(rowId)!.appendChild(field);
}

// つまみの太さ [px]。目盛りの文字はつまみの中心へ合わせるので、CSS の太さと一致させる。
const THUMB_PX = 14;

// 目盛りは値 at の位置へ文字 label を置く。範囲は min〜max、刻みは step。
export interface ScaleTick {
  readonly at: number;
  readonly label: string;
}
interface ScaleSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly ticks: readonly ScaleTick[];
}

// 目盛りつきスライダーの置き直し口。範囲と目盛りはいつでも組み直せ、値は setValue で合わせる。
interface ScaleSlider {
  setScale(spec: ScaleSpec): void;
  setValue(value: number): void;
}

// row の中に目盛りつきのスライダーを足す。choice のときは、いまの値に当たる目盛りを点灯させる。
// 読み出しは format() の文字(空なら出さない)。動かすと change を呼ぶ。
function buildTickedSlider(rowId: string, label: string, width: string, choice: boolean,
  format: () => string, change: (value: number) => void): ScaleSlider {
  const field = document.createElement('label');
  field.className = 'field';
  const name = document.createElement('span');
  name.textContent = label;
  const body = document.createElement('div');
  body.className = 'scale';
  body.style.width = width;
  const input = document.createElement('input');
  input.type = 'range';
  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  body.append(input, ticks);
  const readout = document.createElement('output');
  let marks: readonly { readonly at: number; readonly span: HTMLSpanElement }[] = [];
  const light = (value: number): void => {
    if (choice) for (const mark of marks) mark.span.classList.toggle('on', mark.at === value);
  };
  input.addEventListener('input', () => {
    const value = Number(input.value);
    change(value);
    readout.textContent = format();
    light(value);
  });
  field.append(name, body);
  if (!choice) field.append(readout);
  document.getElementById(rowId)!.appendChild(field);
  return {
    setScale: (spec) => {
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      marks = spec.ticks.map((tick) => {
        const span = document.createElement('span');
        span.className = 'tick';
        const t = Math.min(1, Math.max(0, (tick.at - spec.min) / (spec.max - spec.min)));
        span.style.left = `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${t})`;
        span.style.transform = t === 0 ? 'none' : t === 1 ? 'translateX(-100%)' : 'translateX(-50%)';
        span.textContent = tick.label;
        return { at: tick.at, span };
      });
      ticks.replaceChildren(...marks.map((mark) => mark.span));
      light(Number(input.value));
    },
    setValue: (value) => {
      input.value = String(value);
      readout.textContent = format();
      light(value);
    },
  };
}

// row の中に、値の範囲と目盛りを組み直せるスライダーを足す(時刻の窓のように刻みが変わるもの)。
export function buildScaleSlider(rowId: string, label: string, width: string,
  format: () => string, change: (value: number) => void): ScaleSlider {
  return buildTickedSlider(rowId, label, width, false, format, change);
}

// row の中に選択肢のスライダーを足す。選択肢は目盛りとして並べ、いまの選びを点灯させる。
export function buildChoiceSlider(rowId: string, label: string, width: string, options: readonly string[],
  change: (index: number) => void): ScaleSlider {
  const slider = buildTickedSlider(rowId, label, width, true, () => '', change);
  slider.setScale({ min: 0, max: options.length - 1, step: 1, ticks: options.map((text, at) => ({ at, label: text })) });
  return slider;
}

// row の中にスライダーを1本足す。動かすと change を呼び、そのあと format() が返す文字を隣へ出す
// (値の正本は change の書き込み先にあるので、この順)。返り値でつまみを合わせる。
// extras.code は見出しの下に添えるコード上の名前、extras.tip はホバーで出す説明(data-tip へ持たせ、
// 出す側は呼び出し元のページが持つ)。
export function buildSlider(
  rowId: string, label: string, min: number, max: number, step: number,
  format: () => string, change: (value: number) => void,
  extras: { readonly code?: string; readonly tip?: string } = {},
): (value: number) => void {
  const row = document.getElementById(rowId)!;
  // 見出し・つまみ・読み出しを 1 つの label へ横に並べる。
  const field = document.createElement('label');
  field.className = 'field';
  if (extras.tip !== undefined) field.dataset.tip = extras.tip;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  if (extras.code !== undefined) {
    const code = document.createElement('code');
    code.textContent = extras.code;
    name.appendChild(code);
  }
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  const readout = document.createElement('output');
  input.addEventListener('input', () => {
    change(Number(input.value));
    readout.textContent = format();
  });
  field.append(name, input, readout);
  row.appendChild(field);
  return (value) => {
    input.value = String(value);
    readout.textContent = format();
  };
}
