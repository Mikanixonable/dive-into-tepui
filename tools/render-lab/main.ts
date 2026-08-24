// 描画テスト環境の画面。ケースと、画面へ出す中間バッファを選ぶと、その絵をゲーム本体と同じ
// 描画経路で描く。
import { DEBUG_TARGETS, type DebugTargetId } from '../../src/render/pipeline/debug-target';
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

// row の中に選択肢ぶんのボタンを並べ、押されたら select を呼ぶ。返り値で選択の見た目を更新する。
function buildButtonRow<T extends string>(
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

async function init(): Promise<void> {
  const view = await LabView.create(document.getElementById('view') as HTMLCanvasElement);

  const caseEntries = CASE_NAMES.map((name) => [name, name] as const);
  const markCase = buildButtonRow<CaseName>('cases', caseEntries, (name) => {
    markCase(name);
    view.show(name);
  });
  const markTarget = buildButtonRow<DebugTargetId>('targets', DEBUG_TARGETS, (target) => {
    markTarget(target);
    view.showDebugTarget(target);
  });

  markCase(CASE_NAMES[0]!);
  markTarget('off');
  view.show(CASE_NAMES[0]!);

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
