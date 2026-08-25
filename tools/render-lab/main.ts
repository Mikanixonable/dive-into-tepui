// 描画テスト環境の画面。ケースと、画面へ出す中間バッファを選ぶと、その絵をゲーム本体と同じ
// 描画経路で描く。
import { startProteinAssetPreload } from '../../src/game/protein/protein-asset-loader';
import { DEBUG_TARGETS, type DebugTargetId } from '../../src/render/pipeline/debug-target';
import { CASE_NAMES, type CaseName } from './cases';
import { LabView, MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ZOOM, type LabMeasurement, type LabViewAngles } from './lab';

declare global {
  interface Window {
    // 撮影の駆動(tools/render-lab-shot.mjs)が CDP から読む入口。
    renderLab?: {
      cases: readonly CaseName[];
      shoot: (name: CaseName) => Promise<string>;
      capture: () => Promise<string>;
      setView: (changes: Partial<LabViewAngles>) => void;
      setTarget: (target: DebugTargetId) => void;
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

// row の中にスライダーを1本足す。動かすと change を呼び、そのあと format() が返す文字を隣へ出す
// (呼ぶ順は逆にできない — 値の正本は change の書き込み先にあるため)。返り値でつまみを合わせる。
function buildSlider(
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

async function init(): Promise<void> {
  // タンパク質のケースは fetch で来る構造・motion を同期的に読むので、器を組む前に待つ。
  await startProteinAssetPreload();
  const view = await LabView.create(document.getElementById('view') as HTMLCanvasElement);

  // つまみの位置は表示だけを担い、値の正本は LabView が持つ。**つまみの刻みへ丸めた値を
  // 書き戻さない** — ケース既定の向きが刻みに乗っていないので、丸めると絵が変わる。
  const degrees = (value: number) => `${value.toFixed(1)}°`;
  const setSunAzimuth = buildSlider('view-angles', '恒星 方位', -180, 180, 0.5,
    () => degrees(view.viewAngles.sunAzimuthDeg), (v) => view.setViewAngles({ sunAzimuthDeg: v }));
  const setSunElevation = buildSlider('view-angles', '仰角', -90, 90, 0.5,
    () => degrees(view.viewAngles.sunElevationDeg), (v) => view.setViewAngles({ sunElevationDeg: v }));
  const setCameraAzimuth = buildSlider('view-angles', 'カメラ 方位', -180, 180, 0.5,
    () => degrees(view.viewAngles.cameraAzimuthDeg), (v) => view.setViewAngles({ cameraAzimuthDeg: v }));
  const setCameraElevation = buildSlider('view-angles', '仰角',
    -MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ELEVATION_DEG, 0.5,
    () => degrees(view.viewAngles.cameraElevationDeg), (v) => view.setViewAngles({ cameraElevationDeg: v }));
  const setCameraZoom = buildSlider('view-angles', '距離', -MAX_CAMERA_ZOOM, MAX_CAMERA_ZOOM, 0.02,
    () => `${view.cameraDistance.toExponential(2)} m`, (v) => view.setViewAngles({ cameraZoom: v }));

  const syncAngles = (): void => {
    const current = view.viewAngles;
    setSunAzimuth(current.sunAzimuthDeg);
    setSunElevation(current.sunElevationDeg);
    setCameraAzimuth(current.cameraAzimuthDeg);
    setCameraElevation(current.cameraElevationDeg);
    setCameraZoom(current.cameraZoom);
  };

  const caseEntries = CASE_NAMES.map((name) => [name, name] as const);
  const markCase = buildButtonRow<CaseName>('cases', caseEntries, (name) => {
    markCase(name);
    view.show(name);
    syncAngles();
  });
  const markTarget = buildButtonRow<DebugTargetId>('targets', DEBUG_TARGETS, (target) => {
    markTarget(target);
    view.showDebugTarget(target);
  });

  markCase(CASE_NAMES[0]!);
  markTarget('off');
  view.show(CASE_NAMES[0]!);
  syncAngles();

  window.renderLab = {
    cases: CASE_NAMES,
    shoot: async (name) => { const png = await view.shoot(name); syncAngles(); return png; },
    capture: () => view.capture(),
    setView: (changes) => { view.setViewAngles(changes); syncAngles(); },
    setTarget: (target) => { markTarget(target); view.showDebugTarget(target); },
    measure: (name) => view.measure(name),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
