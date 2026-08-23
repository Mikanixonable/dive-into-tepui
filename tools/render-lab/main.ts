// 描画テスト環境の画面。ケースを選ぶと、ライトプリパスとフォワードの 2 経路を並べて描く。
import { CASE_NAMES, type CaseName } from './cases';
import { LabView } from './lab';

function canvasById(id: string): HTMLCanvasElement {
  return document.getElementById(id) as HTMLCanvasElement;
}

async function init(): Promise<void> {
  const views = [
    await LabView.create(canvasById('prepass'), 'prepass'),
    await LabView.create(canvasById('forward'), 'forward'),
  ];

  const row = document.getElementById('cases')!;
  const buttons = new Map<CaseName, HTMLButtonElement>();
  const select = (name: CaseName) => {
    for (const [key, button] of buttons) button.classList.toggle('active', key === name);
    for (const view of views) view.show(name);
  };
  for (const name of CASE_NAMES) {
    const button = document.createElement('button');
    button.textContent = name;
    button.addEventListener('click', () => select(name));
    row.appendChild(button);
    buttons.set(name, button);
  }
  select(CASE_NAMES[0]!);
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
