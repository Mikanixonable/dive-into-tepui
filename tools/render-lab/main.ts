// 描画テスト環境の画面。ケースを選ぶと、その絵をゲーム本体と同じ描画経路で描く。
import { CASE_NAMES, type CaseName } from './cases';
import { LabView, type LabMeasurement } from './lab';

declare global {
  interface Window {
    // 撮影の駆動(tools/render-lab-shot.mjs)が CDP から読む入口。
    renderLab?: {
      cases: readonly CaseName[];
      shoot: (name: CaseName) => Promise<string>;
      measure: (name: CaseName) => Promise<LabMeasurement>;
    };
  }
}

async function init(): Promise<void> {
  const view = await LabView.create(document.getElementById('view') as HTMLCanvasElement);

  const row = document.getElementById('cases')!;
  const buttons = new Map<CaseName, HTMLButtonElement>();
  const select = (name: CaseName) => {
    for (const [key, button] of buttons) button.classList.toggle('active', key === name);
    view.show(name);
  };
  for (const name of CASE_NAMES) {
    const button = document.createElement('button');
    button.textContent = name;
    button.addEventListener('click', () => select(name));
    row.appendChild(button);
    buttons.set(name, button);
  }
  select(CASE_NAMES[0]!);

  window.renderLab = {
    cases: CASE_NAMES,
    shoot: (name) => view.shoot(name),
    measure: (name) => view.measure(name),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
