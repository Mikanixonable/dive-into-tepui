// 描画テスト環境の画面。ケースと、表示スタイルと、画面へ出す中間バッファを選ぶと、その絵を
// ゲーム本体と同じ描画経路で描く。
import { startProteinAssetPreload } from '../../src/game/protein/protein-asset-loader';
import { DEBUG_TARGETS, type DebugTargetId } from '../../src/render/pipeline/debug-target';
import { AMBIENT_STRONG, AMBIENT_WEAK } from '../../src/render/pipeline/lighting/ambient-source';
import { RENDER_STYLES, type RenderStyle } from '../../src/render/render-style';
import { GRAPHICS_OPTIONS, type ChoiceValue, type GraphicsOptionKey } from '../../src/render/graphics-settings';
import { CASE_NAMES, MAX_CAMERA_DISTANCE_LOG, sunDiameterPx, type CaseName } from './cases';
import {
  LabView, MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ZOOM_LOG, MAX_SUN_DISTANCE_LOG_AU, MIN_SUN_DISTANCE_LOG_AU,
  PIPELINE_GRAPHICS_KEYS, type LabMeasurement, type LabViewAngles,
} from './lab';
import { AU } from '../../src/physics/astronomical-unit';

declare global {
  interface Window {
    // 撮影の駆動(tools/render-lab-shot.mjs)が CDP から読む入口。
    renderLab?: {
      cases: readonly CaseName[];
      shoot: (name: CaseName) => Promise<string>;
      capture: () => Promise<string>;
      setView: (changes: Partial<LabViewAngles>) => void;
      setStyle: (style: RenderStyle) => void;
      setTarget: (target: DebugTargetId) => void;
      setGraphicsOption: (key: GraphicsOptionKey, value: boolean | ChoiceValue) => void;
      measure: (name: CaseName, angles?: Partial<LabViewAngles>) => Promise<LabMeasurement>;
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

// row の中のボタンをまとめて押せる/押せないにする。
function setRowEnabled(rowId: string, enabled: boolean): void {
  document.getElementById(rowId)!.querySelectorAll('button').forEach((button) => {
    button.disabled = !enabled;
  });
}

// row の中に、見出しを添えた排他選択を1組足す。返り値で選択の見た目を更新する。
function buildChoiceField<T>(
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
function buildSelectField<T>(
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
function buildToggleField(rowId: string, label: string, select: (on: boolean) => void): (on: boolean) => void {
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
  // 恒星までの距離。**見かけ径を併記する** — 太陽が 1px を切るあたりの挙動を読むためのつまみ
  // なので、AU だけでは判断の材料にならない。
  const setSunDistance = buildSlider('view-angles', '距離',
    MIN_SUN_DISTANCE_LOG_AU, MAX_SUN_DISTANCE_LOG_AU, 0.01,
    () => `${(view.sunDistance / AU).toPrecision(3)} AU / `
      + `${sunDiameterPx(view.sunDistance, view.cameraFovDeg).toPrecision(2)} px`,
    (v) => view.setViewAngles({ sunDistanceLogAu: v }));
  const setCameraAzimuth = buildSlider('view-angles', 'カメラ 方位', -180, 180, 0.5,
    () => degrees(view.viewAngles.cameraAzimuthDeg), (v) => view.setViewAngles({ cameraAzimuthDeg: v }));
  const setCameraElevation = buildSlider('view-angles', '仰角',
    -MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ELEVATION_DEG, 0.5,
    () => degrees(view.viewAngles.cameraElevationDeg), (v) => view.setViewAngles({ cameraElevationDeg: v }));
  const setCameraDistance = buildSlider('view-angles', '距離',
    -MAX_CAMERA_DISTANCE_LOG, MAX_CAMERA_DISTANCE_LOG, 0.02,
    () => `${view.cameraDistance.toExponential(2)} m`, (v) => view.setViewAngles({ cameraDistanceLog: v }));
  // ズームは画角を狭める倍率。**倍率と画角を併記する** — 遠くの天体をどこまで拡大したかは倍率で、
  // その絵がどれだけ狭い画角を切り出したものかは画角でしか読めない。
  const setCameraZoom = buildSlider('view-angles', 'ズーム', 0, MAX_CAMERA_ZOOM_LOG, 0.02,
    () => `×${(10 ** view.viewAngles.cameraZoomLog).toPrecision(3)} / ${view.cameraFovDeg.toPrecision(3)}°`,
    (v) => {
      view.setViewAngles({ cameraZoomLog: v });
      // 恒星の見かけ径は画角で変わるので、そちらの表示も引き直す。
      setSunDistance(view.viewAngles.sunDistanceLogAu);
    });

  const syncAngles = (): void => {
    const current = view.viewAngles;
    setSunAzimuth(current.sunAzimuthDeg);
    setSunElevation(current.sunElevationDeg);
    setSunDistance(current.sunDistanceLogAu);
    setCameraAzimuth(current.cameraAzimuthDeg);
    setCameraElevation(current.cameraElevationDeg);
    setCameraDistance(current.cameraDistanceLog);
    setCameraZoom(current.cameraZoomLog);
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

  // 表示スタイルを選ぶ。デバッグ表示は写実スタイルのときだけ選べる
  // (DEVELOP/SPEC/RENDERING.md)ので、模式図のあいだは選択欄ごと押せなくする。
  const selectStyle = (style: RenderStyle): void => {
    markStyle(style);
    setRowEnabled('targets', style === 'realistic');
    view.setStyle(style);
  };
  const markStyle = buildButtonRow<RenderStyle>('styles', RENDER_STYLES, selectStyle);

  // 描画品質設定は、パイプラインが読む項目だけを設定の表から起こす。点灯の正本は LabView 側に
  // あるので、どの操作のあとも全項目を引き直す。
  const graphicsMarks: (() => void)[] = [];
  // 全項目の点灯を現在値へ合わせ直す。
  const syncGraphics = (): void => {
    for (const mark of graphicsMarks) mark();
  };
  for (const key of PIPELINE_GRAPHICS_KEYS) {
    const option = GRAPHICS_OPTIONS[key];
    if (option.kind === 'toggle') {
      const mark = buildToggleField('graphics', option.label, (on) => {
        view.setGraphicsOption(key, on);
        syncGraphics();
      });
      graphicsMarks.push(() => mark(view.graphics[key] === true));
      continue;
    }
    const build = option.kind === 'select' ? buildSelectField<ChoiceValue> : buildChoiceField<ChoiceValue>;
    const mark = build('graphics', option.label, option.items, (value) => {
      view.setGraphicsOption(key, value);
      syncGraphics();
    });
    graphicsMarks.push(() => {
      const value = view.graphics[key];
      if (typeof value !== 'boolean') mark(value);
    });
  }
  syncGraphics();

  // 一様な環境光。ゲーム本体はビューの種別から強弱を決めるが、ここには種別が無いので直に選ぶ。
  const markAmbient = buildChoiceField<number>('graphics', '環境光', [
    [0, 'オフ'], [AMBIENT_WEAK, '弱(戦闘ビュー)'], [AMBIENT_STRONG, '強(マップビュー)'],
  ], (fraction) => {
    view.setAmbientFraction(fraction);
    markAmbient(fraction);
  });
  markAmbient(view.ambientFraction);

  markCase(CASE_NAMES[0]!);
  markTarget('off');
  markStyle('realistic');
  view.show(CASE_NAMES[0]!);
  syncAngles();

  window.renderLab = {
    cases: CASE_NAMES,
    shoot: async (name) => { const png = await view.shoot(name); syncAngles(); return png; },
    capture: () => view.capture(),
    setView: (changes) => { view.setViewAngles(changes); syncAngles(); },
    setStyle: selectStyle,
    setTarget: (target) => { markTarget(target); view.showDebugTarget(target); },
    setGraphicsOption: (key, value) => { view.setGraphicsOption(key, value); syncGraphics(); },
    measure: (name, angles) => view.measure(name, angles),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
