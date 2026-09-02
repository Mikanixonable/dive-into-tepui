// 描画テスト環境の画面。ケースと、表示スタイルと、画面へ出す中間バッファを選ぶと、その絵を
// ゲーム本体と同じ描画経路で描く。
//
// **描画品質設定はゲーム本体の設定パネル(GraphicsPanel)をそのまま組む。** 項目の並び・群の
// 見出し・ウィジェットの選び方は GRAPHICS_OPTIONS の表だけが決めるので、項目を足したときに
// ここへ書き足すものは無い。
import { startProteinAssetPreload } from '../../src/game/protein/protein-asset-loader';
import { DEBUG_TARGETS, type DebugTargetId } from '../../src/render/pipeline/debug-target';
import { AMBIENT_STRONG, AMBIENT_WEAK } from '../../src/render/pipeline/lighting/ambient-source';
import { RENDER_STYLES, type RenderStyle } from '../../src/render/render-style';
import { GraphicsSettings, type ChoiceValue, type GraphicsOptionKey } from '../../src/render/graphics-settings';
import { GraphicsPanel } from '../../src/game/hud/panels/graphics-panel';
import { SegmentedControl, WIDGET_STYLE, injectOnce } from '../../src/game/hud/widgets';
import { injectThemeVariables } from '../../src/game/theme';
import { CASE_NAMES, MAX_CAMERA_DISTANCE_LOG, sunDiameterPx, type CaseName } from './cases';
import {
  LabView, MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ZOOM_LOG, MAX_SUN_DISTANCE_LOG_AU, MIN_SUN_DISTANCE_LOG_AU,
  type LabMeasurement, type LabViewAngles,
} from './lab';
import { AU } from '../../src/physics/astronomical-unit';
import { buildSlider } from '../lab-controls';

// 設定パネルに出さない項目。**ここが空でないのは、この環境が原理的に効かせられないときだけ** —
// 効かせられるものは cases.ts / lab.ts の側で受けること。並べて何も起きないと、絵の違いの
// 出どころを読み違える。
const HIDDEN_GRAPHICS_KEYS: ReadonlySet<GraphicsOptionKey> = new Set<GraphicsOptionKey>([
  // 描画は 960x540 固定(撮影した PNG の大きさを決め打ちにするため)。
  'resolutionScale',
  // ビューの種別を持たないので、下の「環境光」が直に強弱を選ぶ。
  'overviewAmbient', 'combatAmbient',
]);

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

async function init(): Promise<void> {
  // ゲーム本体のウィジェットを組む前に、その CSS が読むトークンと規則を入れる
  // (src/game/hud/hud-root.ts が起動時に行うのと同じ)。
  injectThemeVariables();
  injectOnce('widget-style', WIDGET_STYLE);

  // タンパク質のケースは fetch で来る構造・motion を同期的に読むので、器を組む前に待つ。
  await startProteinAssetPreload();
  // **保存先を持たない設定**。残すと、撮影が「人間が最後に押した状態」に依存して黙って変わる。
  const graphics = new GraphicsSettings(null);
  const view = await LabView.create(document.getElementById('view') as HTMLCanvasElement, graphics);

  // つまみの位置は表示だけを担い、値の正本は LabView が持つ。**つまみの刻みへ丸めた値を
  // 書き戻さない** — ケース既定の向きが刻みに乗っていないので、丸めると絵が変わる。
  const degrees = (value: number) => `${value.toFixed(1)}°`;
  const setSunAzimuth = buildSlider('view-angles', '恒星 方位', -180, 180, 0.5,
    () => degrees(view.viewAngles.sunAzimuthDeg), (v) => view.setViewAngles({ sunAzimuthDeg: v }));
  const setSunElevation = buildSlider('view-angles', '恒星 仰角', -90, 90, 0.5,
    () => degrees(view.viewAngles.sunElevationDeg), (v) => view.setViewAngles({ sunElevationDeg: v }));
  // 恒星までの距離。**見かけ径を併記する** — 太陽が 1px を切るあたりの挙動を読むためのつまみ
  // なので、AU だけでは判断の材料にならない。
  const setSunDistance = buildSlider('view-angles', '恒星 距離',
    MIN_SUN_DISTANCE_LOG_AU, MAX_SUN_DISTANCE_LOG_AU, 0.01,
    () => `${(view.sunDistance / AU).toPrecision(3)} AU / `
      + `${sunDiameterPx(view.sunDistance, view.cameraFovDeg).toPrecision(2)} px`,
    (v) => view.setViewAngles({ sunDistanceLogAu: v }));
  const setCameraAzimuth = buildSlider('view-angles', 'カメラ 方位', -180, 180, 0.5,
    () => degrees(view.viewAngles.cameraAzimuthDeg), (v) => view.setViewAngles({ cameraAzimuthDeg: v }));
  const setCameraElevation = buildSlider('view-angles', 'カメラ 仰角',
    -MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ELEVATION_DEG, 0.5,
    () => degrees(view.viewAngles.cameraElevationDeg), (v) => view.setViewAngles({ cameraElevationDeg: v }));
  const setCameraDistance = buildSlider('view-angles', 'カメラ 距離',
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

  const caseItems = CASE_NAMES.map((name) => [name, name] as const);
  const cases = new SegmentedControl<CaseName>('ケース', caseItems, (name) => {
    cases.setSelected(name);
    view.show(name);
    syncAngles();
  });
  document.getElementById('cases')!.appendChild(cases.element);

  const targets = new SegmentedControl<DebugTargetId>('デバッグ表示', DEBUG_TARGETS, (target) => {
    targets.setSelected(target);
    view.showDebugTarget(target);
  });

  // 表示スタイルを選ぶ。デバッグ表示は写実スタイルのときだけ選べる
  // (DEVELOP/SPEC/RENDERING.md)ので、模式図のあいだは選択欄ごと押せなくする。
  const selectStyle = (style: RenderStyle): void => {
    styles.setSelected(style);
    targets.setEnabled(style === 'realistic');
    view.setStyle(style);
  };
  const styles = new SegmentedControl<RenderStyle>('スタイル', RENDER_STYLES, selectStyle);
  document.getElementById('modes')!.append(styles.element, targets.element);

  // 描画品質設定。パネル自身が押し出し先として登録されるので、撮影の駆動が UI を通さずに
  // 項目を書き換えても点灯が追随する。
  const panel = new GraphicsPanel(graphics, HIDDEN_GRAPHICS_KEYS);
  document.getElementById('graphics')!.appendChild(panel.element);
  graphics.bind(view);

  // 一様な環境光。ゲーム本体はビューの種別から強弱を決めるが、ここには種別が無いので直に選ぶ。
  const ambient = new SegmentedControl<number>('強さ', [
    [0, 'オフ'], [AMBIENT_WEAK, '弱(戦闘ビュー)'], [AMBIENT_STRONG, '強(マップビュー)'],
  ], (fraction) => {
    view.setAmbientFraction(fraction);
    ambient.setSelected(fraction);
  });
  document.getElementById('ambient')!.appendChild(ambient.element);
  ambient.setSelected(view.ambientFraction);

  cases.setSelected(CASE_NAMES[0]!);
  targets.setSelected('off');
  selectStyle('realistic');
  view.show(CASE_NAMES[0]!);
  syncAngles();

  window.renderLab = {
    cases: CASE_NAMES,
    shoot: async (name) => { const png = await view.shoot(name); syncAngles(); return png; },
    capture: () => view.capture(),
    setView: (changes) => { view.setViewAngles(changes); syncAngles(); },
    setStyle: selectStyle,
    setTarget: (target) => { targets.setSelected(target); view.showDebugTarget(target); },
    setGraphicsOption: (key, value) => { graphics.setOption(key, value); },
    measure: (name, angles) => view.measure(name, angles),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
