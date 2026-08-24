// 描画テスト環境の画面。ケースを選ぶと、ライトプリパスとフォワードの 2 経路を並べて描く。
import { CASE_NAMES, type CaseName } from './cases';
import { LabView, type LabMeasurement, type LabViews, type Shot, shootCase } from './lab';

declare global {
  interface Window {
    // 撮影の駆動(tools/render-lab-shot.mjs)が CDP から読む入口。
    renderLab?: {
      cases: readonly CaseName[];
      shoot: (name: CaseName) => Promise<Shot>;
      measure: (name: CaseName) => Promise<{ readonly prepass: LabMeasurement; readonly forward: LabMeasurement }>;
    };
  }
}

function canvasById(id: string): HTMLCanvasElement {
  return document.getElementById(id) as HTMLCanvasElement;
}

async function init(): Promise<void> {
  const views: LabViews = {
    prepass: await LabView.create(canvasById('prepass'), 'prepass'),
    forward: await LabView.create(canvasById('forward'), 'forward'),
  };

  const row = document.getElementById('cases')!;
  const buttons = new Map<CaseName, HTMLButtonElement>();
  const select = (name: CaseName) => {
    for (const [key, button] of buttons) button.classList.toggle('active', key === name);
    views.prepass.show(name);
    views.forward.show(name);
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
    shoot: (name) => shootCase(views, name),
    measure: async (name) => ({
      prepass: await views.prepass.measure(name),
      forward: await views.forward.measure(name),
    }),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
