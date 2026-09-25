// 描画テスト環境の画面。ケース(とその撮影)と、表示スタイルと、画面へ出す中間バッファを選ぶと、その絵を
// ゲーム本体と同じ描画経路で描く。描画品質設定の操作はゲーム本体の設定パネル(GraphicsPanel)を
// そのまま組む。
import { PROTEIN_ASSET_IDS, requestProteinAsset } from '../../src/game/protein/protein-asset-loader';
import { loadShipModuleModels } from '../../src/render/dynamic/ship/ship-module-models';
import { DEBUG_TARGETS, type DebugTargetId } from '../../src/render/pipeline/debug-target';
import { RENDER_STYLES, type RenderStyle } from '../../src/render/render-style';
import {
  withGraphicsOption, type ChoiceValue, type GraphicsOptionKey, type GraphicsSettingsData,
} from '../../src/render/graphics-settings';
import { MemorySettingStorage } from '../../src/settings/stored-setting';
import { UserSettings } from '../../src/settings/user-settings';
import { GraphicsPanel } from '../../src/hud/panels/graphics-panel';
import { Pulldown, SegmentedControl, WIDGET_STYLE, type PulldownColumn } from '../../src/hud/widgets';
import { injectOnce } from '../../src/hud/inject-style';
import { applyThemeVariables } from '../../src/hud/style/theme-variables';
import { AU } from '../../src/physics/astronomical-unit';
import { parseThemePalette } from '../../src/theme';
import { CUMULUS_DITHER_KNOB } from '../../src/render/cloud/cumulus-shape';
import { cloudShellKnobOf, type CloudSpecies } from '../../src/render/pipeline/cloud-atmosphere-renderer';
import { buildSlider } from '../lab-controls';
import { CASE_NAMES, type CaseName } from './cases';
import { MAX_CAMERA_DISTANCE_LOG, type LabShot } from './lab-case';
import { LabView, MAX_CAMERA_ELEVATION_DEG, type LabMeasurement } from './lab';
import { sunDiameterPx, sunDistanceOf } from './lab-sun';
import { createEarthSurfaceCaptureApi, type EarthSurfaceCaptureInput } from './earth-surface-capture';
import type { FloatUniform } from '../../src/render/tsl-types';
import type { EarthSurfaceCaptureDocument } from '../../src/render/earth-surface-metrics';
import type { LabViewAngles } from './view-angles';

// 恒星の距離のつまみの下限・上限。つまみは距離を**天文単位の常用対数で持つ** — 見かけ径が 1px を切る
// あたりの変化を読みたいので、AU を直に刻むと近距離側が粗すぎて追えない。下限の 0.01 AU は太陽が
// 画角(50°)いっぱいに広がる距離、上限の 100 AU は海王星軌道の外側。
const MIN_SUN_DISTANCE_LOG_AU = -2;
const MAX_SUN_DISTANCE_LOG_AU = 2;

// ズームのつまみ(画角を狭める倍率の常用対数)の上限。0 がケース既定の画角。
const MAX_CAMERA_ZOOM_LOG = 2;

// 地球の高度のつまみ(描画原点の高度 [m] の常用対数)の下限・上限。下限の 1 km は大気の底、
// 上限の 100 万 km は月軌道の外側。
const MIN_EARTH_ALTITUDE_LOG = 3;
const MAX_EARTH_ALTITUDE_LOG = 9;

// 殻の高度のつまみが届く上限 [m]。対流圏界面(極 8 km、熱帯 18 km)の上まで取る。
const MAX_SHELL_ALTITUDE = 20e3;

// 設定パネルに出さない項目。この環境が原理的に効かせられないものだけを入れる — 並べて何も
// 起きないと、絵の違いの出どころを読み違える。
const HIDDEN_GRAPHICS_KEYS: ReadonlySet<GraphicsOptionKey> = new Set<GraphicsOptionKey>([
  // 描画は 960x540 固定(撮影した PNG の大きさを決め打ちにするため)。
  'resolutionScale',
]);

declare global {
  interface Window {
    // CDP から撮影と計測を駆動するための入口。
    renderLab?: {
      earthSurfaceCapture: (input: EarthSurfaceCaptureInput) => EarthSurfaceCaptureDocument;
      cases: readonly CaseName[];
      shoot: (name: CaseName, graphics?: Partial<GraphicsSettingsData>) => Promise<Readonly<Record<string, string>>>;
      shootNative: (
        name: CaseName, shotName: string, graphics?: Partial<GraphicsSettingsData>,
        cloudDetailDiagnostic?: LabShot['cloudDetailDiagnostic'] | null,
      ) => Promise<string>;
      capture: () => Promise<string>;
      setView: (changes: Partial<LabViewAngles>) => void;
      setStyle: (style: RenderStyle) => void;
      setTarget: (target: DebugTargetId) => void;
      setGraphicsOption: (key: GraphicsOptionKey, value: boolean | ChoiceValue) => void;
      graphicsSettings: () => Readonly<GraphicsSettingsData>;
      measure: (name: CaseName, angles?: Partial<LabViewAngles>) => Promise<LabMeasurement>;
      measureShot: (
        name: CaseName, shotName: string, graphics?: Partial<GraphicsSettingsData>,
        cloudDetailDiagnostic?: LabShot['cloudDetailDiagnostic'] | null,
      ) => Promise<LabMeasurement>;
    };
  }
}

// 観察の向きのつまみ(恒星・カメラと地球の置き方)を組み、つまみの位置を view の現在値へ合わせる関数を
// 返す。その関数は、地球を置かないケースでは地球のつまみを節ごと隠す。
function buildViewAngleSliders(view: LabView): () => void {
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
    () => {
      const distance = sunDistanceOf(view.viewAngles);
      return `${(distance / AU).toPrecision(3)} AU / ${sunDiameterPx(distance, view.cameraFovDeg).toPrecision(2)} px`;
    },
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

  // 地球の置き方。方位・仰角は描画原点から地球の中心への向き、直下の緯度・経度は描画原点の真下に
  // 来る地表の地点。
  const setEarthAzimuth = buildSlider('earth-angles', '地球 方位', -180, 180, 0.5,
    () => degrees(view.viewAngles.earthAzimuthDeg), (v) => view.setViewAngles({ earthAzimuthDeg: v }));
  const setEarthElevation = buildSlider('earth-angles', '地球 仰角', -90, 90, 0.5,
    () => degrees(view.viewAngles.earthElevationDeg), (v) => view.setViewAngles({ earthElevationDeg: v }));
  const setEarthAltitude = buildSlider('earth-angles', '高度',
    MIN_EARTH_ALTITUDE_LOG, MAX_EARTH_ALTITUDE_LOG, 0.01,
    () => `${Number((10 ** view.viewAngles.earthAltitudeLog / 1e3).toPrecision(3))} km`,
    (v) => view.setViewAngles({ earthAltitudeLog: v }));
  const setEarthLatitude = buildSlider('earth-angles', '直下 緯度', -90, 90, 0.5,
    () => degrees(view.viewAngles.earthLatitudeDeg), (v) => view.setViewAngles({ earthLatitudeDeg: v }));
  const setEarthLongitude = buildSlider('earth-angles', '直下 経度', -180, 180, 0.5,
    () => degrees(view.viewAngles.earthLongitudeDeg), (v) => view.setViewAngles({ earthLongitudeDeg: v }));
  const earthSection = document.getElementById('earth-section')!;

  return () => {
    const current = view.viewAngles;
    // 恒星とカメラ。
    setSunAzimuth(current.sunAzimuthDeg);
    setSunElevation(current.sunElevationDeg);
    setSunDistance(current.sunDistanceLogAu);
    setCameraAzimuth(current.cameraAzimuthDeg);
    setCameraElevation(current.cameraElevationDeg);
    setCameraDistance(current.cameraDistanceLog);
    setCameraZoom(current.cameraZoomLog);
    // 地球の置き方。
    earthSection.hidden = !view.showsEarth;
    setEarthAzimuth(current.earthAzimuthDeg);
    setEarthElevation(current.earthElevationDeg);
    setEarthAltitude(current.earthAltitudeLog);
    setEarthLatitude(current.earthLatitudeDeg);
    setEarthLongitude(current.earthLongitudeDeg);
  };
}

// 仮設の雲のつまみ(積雲のディザと、半透明な殻の種類ごとの濃さ・高度・反射率)を組む。つまみは
// 描画の uniform を書き換え、view をその場で描き直す。
function buildCloudSliders(view: LabView): void {
  const redraw = (knob: FloatUniform, value: number): void => { knob.value = value; view.render(); };

  // 積雲の飽和とディザの幅。被覆率が 中央値±半幅 に入る柱がディザに掛かるので、半幅を広げるほど
  // 半透明として読める画素が増える。生成側の場へ差し替えたあとの追い込みまで残す。
  const dither = CUMULUS_DITHER_KNOB;
  buildSlider('cumulus-dither', '中央値', 0, 1, 0.001,
    () => dither.center.value.toFixed(3), (v) => redraw(dither.center, v))(dither.center.value);
  buildSlider('cumulus-dither', '中間調 半幅', 0.001, 0.5, 0.001,
    () => `±${dither.halfWidth.value.toFixed(3)}`,
    (v) => redraw(dither.halfWidth, v))(dither.halfWidth.value);

  // 半透明な殻の濃さ・立つ高さ・反射率。不透明な積雲との馴染みを目で追い込み終えるまで残す。
  const kilometers = (value: number) => `${(value / 1000).toFixed(2)} km`;
  // 種類 1 つぶんのつまみを row へ並べ、つまみの位置を殻の現在値へ合わせる。
  const buildShellSliders = (rowId: string, species: CloudSpecies): void => {
    const knob = cloudShellKnobOf(species);
    // 濃さの2本は鉛直の光学的厚みの目盛りで、足切り・ゲインの順に掛かる。
    buildSlider(rowId, '足切り', 0, 1, 0.005,
      () => knob.cutoff.value.toFixed(3), (v) => redraw(knob.cutoff, v))(knob.cutoff.value);
    buildSlider(rowId, 'ゲイン', 0, 4, 0.01,
      () => `×${knob.gain.value.toFixed(2)}`, (v) => redraw(knob.gain, v))(knob.gain.value);
    // 殻は上下の中央に立ち、上下の差が掠める視線の光路を決める。
    buildSlider(rowId, '下端高度', 0, MAX_SHELL_ALTITUDE, 100, () => kilometers(knob.bottomAltitude.value),
      (v) => redraw(knob.bottomAltitude, v))(knob.bottomAltitude.value);
    buildSlider(rowId, '上端高度', 0, MAX_SHELL_ALTITUDE, 100, () => kilometers(knob.topAltitude.value),
      (v) => redraw(knob.topAltitude, v))(knob.topAltitude.value);
    buildSlider(rowId, 'アルベド', 0, 1, 0.01,
      () => knob.albedo.value.toFixed(2), (v) => redraw(knob.albedo, v))(knob.albedo.value);
  };
  buildShellSliders('cumulus-shell', 'cumulus');
  buildShellSliders('cirrus-shell', 'cirrus');
}

// 画面を組み、最初のケースを描き、CDP の入口を window へ生やす。
async function init(): Promise<void> {
  // 地表の計測の口は、タンパク質のアセットを待つ前に公開する — 別ケースのアセットが 404 でも
  // 「データ未投入」を返せるように。
  const earthSurfaceCapture = createEarthSurfaceCaptureApi();
  window.renderLab = { earthSurfaceCapture } as Window['renderLab'];

  // ゲーム本体のウィジェットを組む前に、その CSS が読むトークンと規則を入れる。
  applyThemeVariables(parseThemePalette(null));
  injectOnce('widget-style', WIDGET_STYLE);

  // fetch で来る大型アセットは、同期 factory を使うケースを組む前にまとめて待つ。
  await Promise.all([
    ...PROTEIN_ASSET_IDS.map((id) => requestProteinAsset(id)),
    loadShipModuleModels(),
  ]);
  // **この実行の中だけで生きる設定**。残すと、撮影が「人間が最後に押した状態」に依存して黙って変わる。
  const settings = new UserSettings(new MemorySettingStorage());
  const view = await LabView.create(document.getElementById('view') as HTMLCanvasElement, settings.graphics);
  const syncAngles = buildViewAngleSliders(view);

  const shotsRow = document.getElementById('shots')!;
  // 撮影のプルダウンを、いまのケースの撮影名で組み直す。反映は **applyShot を通す** — 観察の向きだけを
  // 合わせると、撮影が持つ描画品質設定の差分が落ちる。
  const rebuildShots = (): void => {
    const items = view.shotNames.map((name) => [name, name] as const);
    const columns: readonly [PulldownColumn<string>] = [{ items }];
    const shots = new Pulldown('撮影', columns, '反映', ([name]) => {
      view.applyShot(name);
      syncAngles();
    });
    shotsRow.replaceChildren(shots.element);
  };

  // ケースを選び、観察のつまみと撮影のプルダウンをそのケースへ合わせる。
  const selectCase = (name: CaseName): void => {
    cases.setSelected(name);
    view.show(name);
    syncAngles();
    rebuildShots();
  };
  const caseItems = CASE_NAMES.map((name) => [name, name] as const);
  const cases = new SegmentedControl<CaseName>('ケース', caseItems, selectCase);
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

  // 描画品質設定のパネル。パネルの操作を設定へ流し、設定の現在値をパネルへ映す。
  const panel = new GraphicsPanel(settings.graphics.current, HIDDEN_GRAPHICS_KEYS);
  document.getElementById('graphics')!.appendChild(panel.element);
  panel.onChange = (graphics) => settings.graphics.set(graphics);
  settings.graphics.subscribe((graphics) => panel.sync(graphics));

  buildCloudSliders(view);

  targets.setSelected('off');
  selectStyle('realistic');
  selectCase(CASE_NAMES[0]!);

  window.renderLab = {
    earthSurfaceCapture,
    cases: CASE_NAMES,
    shoot: async (name, graphics) => { const pngs = await view.shoot(name, graphics); syncAngles(); return pngs; },
    shootNative: async (name, shotName, graphics, cloudDetailDiagnostic) => {
      const png = await view.shootNative(name, shotName, graphics, cloudDetailDiagnostic);
      syncAngles();
      return png;
    },
    capture: () => view.capture(),
    setView: (changes) => { view.setViewAngles(changes); syncAngles(); },
    setStyle: selectStyle,
    setTarget: (target) => { targets.setSelected(target); view.showDebugTarget(target); },
    setGraphicsOption: (key, value) => {
      settings.graphics.set(withGraphicsOption(settings.graphics.current, key, value));
    },
    graphicsSettings: () => settings.graphics.current,
    measure: (name, angles) => view.measure(name, angles),
    measureShot: (name, shotName, graphics, cloudDetailDiagnostic) => view.measureShot(
      name, shotName, graphics, 6, 30, cloudDetailDiagnostic,
    ),
  };
}

// 失敗は画面へ出す — canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
