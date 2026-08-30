// 実験環境(render-lab / cloud-lab)の画面が共有する操作部品。row の id を受けてその中へ
// ボタン列・選択欄・スライダーを足し、選択の見た目を合わせ直す関数を返す。値の正本は
// 呼び出し側が持ち、ここは表示と入力の受け渡しだけを担う。

// row の中に選択肢ぶんのボタンを並べ、押されたら select を呼ぶ。返り値で選択の見た目を更新する。
export function buildButtonRow<T extends string>(
  rowId: string, entries: readonly (readonly [T, string])[], select: (value: T) => void,
): (active: T) => void {
  const row = document.getElementById(rowId)!;
  const buttons = new Map<T, HTMLButtonElement>();
  for (const [value, label] of entries) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => select(value));
    row.appendChild(button);
    buttons.set(value, button);
  }
  return (active) => {
    for (const [value, button] of buttons) button.classList.toggle('active', value === active);
  };
}

// row の中のボタンをまとめて押せる/押せないにする。
export function setRowEnabled(rowId: string, enabled: boolean): void {
  document.getElementById(rowId)!.querySelectorAll('button').forEach((button) => {
    button.disabled = !enabled;
  });
}

// row の中に、見出しを添えた排他選択を1組足す。返り値で選択の見た目を更新する。
export function buildChoiceField<T>(
  rowId: string, label: string, entries: readonly (readonly [T, string])[], select: (value: T) => void,
): (active: T) => void {
  const field = document.createElement('div');
  field.className = 'field';
  const name = document.createElement('span');
  name.textContent = label;
  field.appendChild(name);
  // 選択肢は entries の順に並べる。値そのものを鍵に持ち、点灯はここから引き直す。
  const buttons = new Map<T, HTMLButtonElement>();
  for (const [value, text] of entries) {
    const button = document.createElement('button');
    button.textContent = text;
    button.addEventListener('click', () => select(value));
    field.appendChild(button);
    buttons.set(value, button);
  }
  document.getElementById(rowId)!.appendChild(field);
  return (active) => {
    for (const [value, button] of buttons) button.classList.toggle('active', value === active);
  };
}

// row の中に、見出しを添えたドロップダウン選択を1組足す。選択肢が buildChoiceField のボタン列に
// 収まらないほど多い/長いときに使う。返り値で選択位置を合わせる。
export function buildSelectField<T>(
  rowId: string, label: string, entries: readonly (readonly [T, string])[], select: (value: T) => void,
): (active: T) => void {
  const field = document.createElement('div');
  field.className = 'field';
  const name = document.createElement('span');
  name.textContent = label;
  field.appendChild(name);
  const dropdown = document.createElement('select');
  for (const [, text] of entries) {
    const option = document.createElement('option');
    option.textContent = text;
    dropdown.appendChild(option);
  }
  dropdown.addEventListener('change', () => {
    const entry = entries[dropdown.selectedIndex];
    if (entry !== undefined) select(entry[0]);
  });
  field.appendChild(dropdown);
  document.getElementById(rowId)!.appendChild(field);
  return (active) => {
    const index = entries.findIndex(([value]) => value === active);
    if (index >= 0) dropdown.selectedIndex = index;
  };
}

// row の中に、押すたびに裏返るボタンを1つ足す。ボタンの文字がそのまま見出しになる。
export function buildToggleField(rowId: string, label: string, select: (on: boolean) => void): (on: boolean) => void {
  const button = document.createElement('button');
  button.textContent = label;
  let on = false;
  button.addEventListener('click', () => select(!on));
  document.getElementById(rowId)!.appendChild(button);
  return (next) => {
    on = next;
    button.classList.toggle('active', on);
  };
}

// row の中にスライダーを1本足す。動かすと change を呼び、そのあと format() が返す文字を隣へ出す
// (呼ぶ順は逆にできない — 値の正本は change の書き込み先にあるため)。返り値でつまみを合わせる。
export function buildSlider(
  rowId: string, label: string, min: number, max: number, step: number,
  format: () => string, change: (value: number) => void,
): (value: number) => void {
  const row = document.getElementById(rowId)!;
  const field = document.createElement('label');
  field.className = 'field';
  const name = document.createElement('span');
  name.textContent = label;
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
