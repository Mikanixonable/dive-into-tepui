// 描画テスト環境の画面。ケース(とその撮影)と、表示スタイルと、画面へ出す中間バッファを選ぶと、その絵を
// ゲーム本体と同じ描画経路で描く。描画品質設定の操作はゲーム本体の設定パネル(GraphicsPanel)を
// そのまま組む。
import { PROTEIN_ASSET_IDS, requestProteinAsset } from '../../src/game/protein/protein-asset-loader';
import { DEBUG_TARGETS, type DebugTargetId } from '../../src/render/pipeline/debug-target';
import { RENDER_STYLES, type RenderStyle } from '../../src/render/render-style';
import type { ChoiceValue, GraphicsKey, GraphicsSettingsData } from '../../src/render/graphics-settings';
import { withGraphicsValue } from '../../src/render/graphics-selection';
import { MemorySettingStorage } from '../../src/settings/stored-setting';
import { UserSettings } from '../../src/settings/user-settings';
import { GraphicsPanel } from '../../src/hud/panels/graphics-panel';
import { Button, Pulldown, SegmentedControl, WIDGET_STYLE, type PulldownColumn } from '../../src/hud/widgets';
import { injectOnce } from '../../src/hud/inject-style';
import { applyThemeVariables } from '../../src/hud/style/theme-variables';
import { AU } from '../../src/physics/astronomical-unit';
import { parseThemePalette } from '../../src/theme';
import { CUMULUS_DITHER_KNOB } from '../../src/render/cloud/cumulus-shape';
import { cloudShellKnobOf, type CloudSpecies } from '../../src/render/pipeline/cloud-atmosphere-renderer';
import { buildSlider } from '../lab-controls';
import { CASE_NAMES, type CaseName } from './cases';
import { MAX_CAMERA_DISTANCE_LOG } from './lab-case';
import {
  LabView, MAX_CAMERA_ELEVATION_DEG, type FloatImage, type FloatTargetName, type LabMeasurement,
} from './lab';
import { sunDiameterPx, sunDistanceOf } from './lab-sun';
import { createEarthSurfaceCaptureApi, type EarthSurfaceCaptureInput } from './earth-surface-capture';
import { ERROR_SCALES, ErrorMetric, FALSE_STRUCTURE_EPSILONS, type ErrorMeasurement } from './error-metric';
import { PlaneSmoother, type SurfaceGeometry } from './plane-smoother';
import { MotionSequence, type MotionFrameRecord } from './motion-sequence';
import { MotionVectorCheck, type MotionVectorFrameRecord } from './motion-vector-check';
import { JitterSweep, type SweepRecord } from './jitter-sweep';
import { captureAccumulated } from './accumulated-capture';
import { phasesOf, type PhaseSequence } from './phase-sequence';
import type { FloatUniform } from '../../src/render/tsl-types';
import type { JitterSource, ScanJitter } from '../../src/render/pipeline/screen-space/frame-jitter';
import type { EarthSurfaceCaptureDocument } from '../../src/render/earth-surface-metrics';
import type { LabViewAngles } from './view-angles';
import type {
  ScanTier, ScreenSpaceExperimentVariant, ScreenSpaceStageRange,
} from '../../src/render/pipeline/screen-space/screen-space-pass';

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
const HIDDEN_GRAPHICS_KEYS: ReadonlySet<GraphicsKey> = new Set<GraphicsKey>([
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
      captureAccumulated: () => Promise<string>;
      capture: () => Promise<string>;
      captureCorrectionProbe: () => ReturnType<LabView['captureCorrectionProbe']>;
      render: () => void;
      setFrame: (frame: number, change?: number) => void;
      setCaseValue: (name: string, value: string | number | boolean) => void;
      setView: (changes: Partial<LabViewAngles>) => void;
      viewAngles: () => LabViewAngles;
      setStyle: (style: RenderStyle) => void;
      setTarget: (target: DebugTargetId) => void;
      setGraphicsOption: (key: GraphicsKey, value: boolean | ChoiceValue) => void;
      measure: (name: CaseName, angles?: Partial<LabViewAngles>) => Promise<LabMeasurement>;
      measureCurrent: (warmupFrames?: number, sampleFrames?: number, advanceFrame?: boolean) => Promise<LabMeasurement>;
      measurePoolRebuild: (iterations: number) => ReturnType<LabView['measurePoolRebuild']>;
      measureScreenSpacePaths: (
        seeds: readonly (readonly [number, number])[], sampleCount?: number,
      ) => ReturnType<LabView['measureScreenSpacePaths']>;
      showShot: (name: CaseName, shotName: string, graphics?: Partial<GraphicsSettingsData>) => Promise<void>;
      setScanTier: (tier: ScanTier) => void;
      setScreenSpaceExperiment: (
        variant: ScreenSpaceExperimentVariant | null, tier: ScanTier, sparseTapCount?: number,
      ) => void;
      setScanSeed: (x: number, y: number) => void;
      setScanStageRange: (range: ScreenSpaceStageRange) => void;
      setUpsampleAlphaOne: (enabled: boolean) => void;
      setScanWhiteNoisePass: (pass: number | null) => void;
      accumulateWhitePasses: (first: number, count: number) => Promise<void>;
      takePassSums: (includeSquares?: boolean) => Promise<{
        readonly sums: readonly (readonly FloatImage[])[]; readonly squares: readonly (readonly FloatImage[])[];
      }>;
      writePackedBands: (index: number, rgba: Float32Array) => void;
      readFloat: (name: FloatTargetName) => Promise<FloatImage>;
      composite: (hdr: FloatImage) => Promise<FloatImage>;
      signedCorrectionDisplay: (hdr: FloatImage, exposureFactor?: number) => FloatImage;
      signedCorrectionPng: (hdr: FloatImage) => Promise<string>;
      exposureFactor: () => number;
      measureTiers: (
        tiers: readonly ScanTier[], rounds: number,
      ) => Promise<readonly Readonly<Record<string, number | null>>[]>;
      measureTierRounds: (
        tiers: readonly ScanTier[], rounds: number,
      ) => Promise<readonly (readonly Readonly<Record<string, number>>[])[] | null>;
      screenSpaceShaders: () => Promise<readonly { readonly label: string; readonly wgsl: string }[]>;
      clearScreenSpace: () => void;
      errorScales: readonly number[];
      falseStructureEpsilons: readonly number[];
      errorMetrics: (
        error: Float32Array, converged: Float32Array, mask: Uint8Array, width: number, height: number,
        magnification: number,
      ) => Promise<ErrorMeasurement>;
      falseStructureMap: () => Promise<Float32Array>;
      surfaceBlur: (values: Float32Array, surface: Uint8Array, sigma: number) => Promise<Float32Array>;
      segmentBlur: (values: Float32Array, segments: Int32Array, sigma: number) => Promise<Float32Array>;
      sparseBilateral: (
        rgb: Float32Array, geometry: SurfaceGeometry, radius: number, shift: readonly [number, number],
      ) => Promise<Float32Array>;
      stochasticUpscale: (scan: Float32Array, geometry: SurfaceGeometry, block: number) => Promise<Float32Array>;
      setScanJitter: (jitter: ScanJitter | null) => void;
      setJitterSources: (sources: readonly JitterSource[] | null) => void;
      setRasterJitter: (offsetPx: readonly [number, number] | null) => void;
      scanCellSize: () => number;
      resetMotion: () => void;
      moveCamera: (
        translationPx: readonly [number, number], rotationPx: readonly [number, number], orbitPx: readonly [number, number],
      ) => void;
      // columns は、位相の列 sequence で描き直した平均の補正を名前 name で添える列。
      motionFrame: (
        columns: readonly { readonly name: string; readonly sequence: PhaseSequence }[],
      ) => Promise<MotionFrameRecord>;
      resetMotionReference: () => void;
      motionVectorFrame: (frame: number, compareDepth: boolean, forceNoHistory?: boolean, verifyRepeated?: boolean) => Promise<MotionVectorFrameRecord>;
      jitterSweep: (
        sequence: PhaseSequence, timeConstants: readonly number[], imagedTimeConstants: readonly number[],
      ) => Promise<SweepRecord>;
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

  // タンパク質のケースは fetch で来る構造・motion を同期的に読むので、器を組む前に待つ。
  await Promise.all(PROTEIN_ASSET_IDS.map((id) => requestProteinAsset(id)));
  // **この実行の中だけで生きる設定**。残すと、撮影が「人間が最後に押した状態」に依存して黙って変わる。
  const settings = new UserSettings(new MemorySettingStorage());
  const view = await LabView.create(document.getElementById('view') as HTMLCanvasElement, settings.graphics);
  const errorMetric = await ErrorMetric.create();
  // 平面を均す GPU の資源は盲検の刺激を組むときにしか使わないので、初めて使うときに作る。
  let smoother: Promise<PlaneSmoother> | null = null;
  const planeSmoother = (): Promise<PlaneSmoother> => (smoother ??= PlaneSmoother.create());
  const motion = new MotionSequence(view);
  const motionVectorCheck = new MotionVectorCheck(view);
  const sweep = new JitterSweep(view);
  const syncAngles = buildViewAngleSliders(view);

  const shotsRow = document.getElementById('shots')!;
  // 撮影のプルダウンを、いまのケースの撮影名で組み直す。反映は **applyShot を通す** — 観察の向きだけを
  // 合わせると、撮影が持つ描画品質設定の差分が落ちる。
  const rebuildShots = (): void => {
    const items = view.shotNames.map((name) => [name, name] as const);
    const columns: readonly [PulldownColumn<string>] = [{ items }];
    const shots = new Pulldown('撮影', columns, '反映', ([name]) => {
      view.applyShot(name);
      targets.setSelected(view.debugTarget);
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
  panel.onChange = (selection) => settings.graphics.set(selection);
  settings.graphics.subscribe((selection) => panel.sync(selection));

  const loadButton = new Button('計測', () => { void measureCurrent(); });
  const loadResult = document.getElementById('load-result')!;
  document.getElementById('load-controls')!.appendChild(loadButton.element);
  const measureCurrent = async (): Promise<void> => {
    loadButton.setEnabled(false);
    loadResult.textContent = '計測中…';
    try {
      const result = await view.measureCurrent();
      const table = document.createElement('table');
      const head = document.createElement('tr');
      for (const label of ['パス', 'median [ms]', 'p95 [ms]']) {
        const cell = document.createElement('th');
        cell.textContent = label;
        head.appendChild(cell);
      }
      table.appendChild(head);
      const addRow = (label: string, median: number | null, p95: number | null): void => {
        const row = document.createElement('tr');
        for (const value of [label, median?.toFixed(3) ?? '—', p95?.toFixed(3) ?? '—']) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.appendChild(cell);
        }
        table.appendChild(row);
      };
      addRow('CPU 描画', result.cpuRenderMs.p50, result.cpuRenderMs.p95);
      for (const [label, distribution] of Object.entries(result.gpuPassMs)) {
        addRow(label, result.gpuSupported ? distribution.p50 : null, result.gpuSupported ? distribution.p95 : null);
      }
      loadResult.replaceChildren(table);
      if (!result.gpuSupported) loadResult.prepend(document.createTextNode('GPU 計測未対応'));
    } catch (error) {
      loadResult.textContent = String(error);
    } finally {
      loadButton.setEnabled(true);
    }
  };

  buildCloudSliders(view);

  targets.setSelected('off');
  selectStyle('realistic');
  selectCase(CASE_NAMES[0]!);

  window.renderLab = {
    earthSurfaceCapture,
    cases: CASE_NAMES,
    shoot: async (name, graphics) => {
      const pngs = await view.shoot(name, graphics);
      syncAngles();
      targets.setSelected(view.debugTarget);
      return pngs;
    },
    captureAccumulated: () => captureAccumulated(view, 'accumulated capture'),
    capture: () => view.capture(),
    captureCorrectionProbe: () => view.captureCorrectionProbe(),
    render: () => view.render(),
    setFrame: (frame, change) => view.setFrame(frame, change),
    setCaseValue: (name, value) => view.setCaseValue(name, value),
    setView: (changes) => { view.setViewAngles(changes); syncAngles(); },
    viewAngles: () => view.viewAngles,
    setStyle: selectStyle,
    setTarget: (target) => { targets.setSelected(target); view.showDebugTarget(target); },
    setGraphicsOption: (key, value) => {
      settings.graphics.set(withGraphicsValue(settings.graphics.current, key, value));
    },
    measure: (name, angles) => view.measure(name, angles),
    measureCurrent: (warmupFrames, sampleFrames, advanceFrame) =>
      view.measureCurrent(warmupFrames, sampleFrames, advanceFrame),
    measurePoolRebuild: (iterations) => view.measurePoolRebuild(iterations),
    measureScreenSpacePaths: (seeds, sampleCount) => view.measureScreenSpacePaths(seeds, sampleCount),
    showShot: async (name, shotName, graphics) => {
      await view.showShot(name, shotName, graphics);
      syncAngles();
      targets.setSelected(view.debugTarget);
    },
    setScanTier: (tier) => view.setScanTier(tier),
    setScreenSpaceExperiment: (variant, tier, sparseTapCount) =>
      view.setScreenSpaceExperiment(variant, tier, sparseTapCount),
    setScanSeed: (x, y) => view.setScanSeed(x, y),
    setScanStageRange: (range) => view.setScanStageRange(range),
    setUpsampleAlphaOne: (enabled) => view.setUpsampleAlphaOne(enabled),
    setScanWhiteNoisePass: (pass) => view.setScanWhiteNoisePass(pass),
    accumulateWhitePasses: (first, count) => view.accumulateWhitePasses(first, count),
    takePassSums: (includeSquares) => view.takePassSums(includeSquares),
    writePackedBands: (index, rgba) => view.writePackedBands(index, rgba),
    readFloat: (name) => view.readFloat(name),
    composite: (hdr) => view.composite(hdr),
    signedCorrectionDisplay: (hdr, exposureFactor) => view.signedCorrectionDisplay(hdr, exposureFactor),
    signedCorrectionPng: (hdr) => view.signedCorrectionPng(hdr),
    exposureFactor: () => view.exposureFactor,
    measureTiers: (tiers, rounds) => view.measureTiers(tiers, rounds),
    measureTierRounds: (tiers, rounds) => view.measureTierRounds(tiers, rounds),
    screenSpaceShaders: () => view.screenSpaceShaders(),
    clearScreenSpace: () => view.clearScreenSpace(),
    errorScales: ERROR_SCALES,
    falseStructureEpsilons: FALSE_STRUCTURE_EPSILONS,
    errorMetrics: (error, converged, mask, width, height, magnification) => (
      errorMetric.measure(error, converged, mask, width, height, magnification)),
    falseStructureMap: () => errorMetric.falseStructureMap(),
    surfaceBlur: async (values, surface, sigma) => (await planeSmoother()).surfaceBlur(values, surface, sigma),
    segmentBlur: async (values, segments, sigma) => (await planeSmoother()).segmentBlur(values, segments, sigma),
    sparseBilateral: async (rgb, geometry, radius, shift) => (
      (await planeSmoother()).sparseBilateral(rgb, geometry, radius, shift)),
    stochasticUpscale: async (scan, geometry, block) => (await planeSmoother()).stochasticUpscale(scan, geometry, block),
    setScanJitter: (jitter) => view.setScanJitter(jitter),
    setJitterSources: (sources) => view.setJitterSources(sources),
    setRasterJitter: (offsetPx) => view.setRasterJitter(offsetPx),
    scanCellSize: () => view.scanCellSize,
    resetMotion: () => motion.reset(),
    moveCamera: (translationPx, rotationPx, orbitPx) => motion.moveCamera(translationPx, rotationPx, orbitPx),
    motionFrame: (columns) => motion.frame(
      columns.map(({ name, sequence }) => ({ name, phases: phasesOf(sequence, view.scanCellSize) }))),
    resetMotionReference: () => motionVectorCheck.reset(),
    motionVectorFrame: (frame, compareDepth, forceNoHistory, verifyRepeated) => motionVectorCheck.frame(frame, compareDepth, forceNoHistory, verifyRepeated),
    jitterSweep: (sequence, timeConstants, imagedTimeConstants) => sweep.sweep(
      phasesOf(sequence, view.scanCellSize), timeConstants, imagedTimeConstants, view.scanCellSize),
  };
}

// 失敗は画面へ出す — canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
