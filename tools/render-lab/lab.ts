// 描画テスト環境の 1 ビュー。ケースを組み、ゲーム本体と同じ RenderPipeline でキャンバスへ描く。
// 絵の撮影(PNG)と、CPU / GPU それぞれの所要時間の計測もここが担う。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { GPU_PASS_COUNT, GPU_PASS_LABELS, GpuTimings } from '../../src/render/gpu-timings';
import {
  ProteinMotionMetricsRecorder, type ProteinMotionMetricSummary,
} from '../../src/game/protein/protein-motion-metrics';
import { RenderPipeline } from '../../src/render/pipeline/render-pipeline';
import { R_SUN, SUN_LIGHT_COLOR } from '../../src/game/celestial/solar-system/sun';
import { farClip } from '../../src/render/camera/camera-view';
import { planetRadiance, type PlanetLightValue } from '../../src/render/pipeline/lighting/planet-light-source';
import { ambientFraction } from '../../src/render/pipeline/lighting/ambient-source';
import { reversedOpaqueSort, reversedTransparentSort } from '../../src/render/pipeline/reversed-sort';
import { castsCumulusShadow } from '../../src/render/pipeline/shadow/shadow-select';
import { atmosphereDraws, withAirglowEnabled, type AtmosphereBody } from '../../src/render/atmosphere';
import { RingMaterials } from '../../src/render/celestial/ring';
import { disposeOwnedRenderResources } from '../../src/render/dispose-owned-render-resources';
import { metersPerPixelAtDepth } from '../../src/math/projection';
import { distributionOf, type SampleDistribution } from '../../src/math/sample-distribution';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { CASES, type CaseName } from './cases';
import { type LabCase, type LabShot, SUN_DIR, VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import { EARTH_LIGHT_ALBEDO, LabEarth } from './lab-earth';
import { LabSun } from './lab-sun';
import { anglesFromDirection, directionFromAngles, type LabViewAngles } from './view-angles';
import { pixelsToPngDataUrl } from '../lab-png';
import type { GraphicsOptionKey, GraphicsSettingsData } from '../../src/render/graphics-settings';
import type { StoredSetting } from '../../src/settings/stored-setting';
import type { DebugTargetId } from '../../src/render/pipeline/debug-target';
import type { RenderStyle } from '../../src/render/render-style';

// 1 ケースの計測結果。所要時間は [ms] の分布で、gpuPassMs はパスのラベルごと。
export interface LabMeasurement {
  readonly caseName: CaseName;
  readonly frames: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly cpuRenderMs: SampleDistribution;
  readonly gpuSupported: boolean;
  readonly gpuPassTotalScope: 'instrumented-render-pass-sum';
  readonly gpuPassTotalMs: SampleDistribution;
  readonly observedRenderTotalScope: 'observed-render-total';
  readonly observedRenderTotalMs: SampleDistribution;
  readonly observedRenderTotalSamplesMs: readonly (number | null)[];
  readonly observedRenderCompleteFrames: number;
  readonly observedRenderExpectedQueryCounts: readonly number[];
  readonly observedRenderResolvedQueryCounts: readonly number[];
  readonly observedComputeScope: 'renderer-compute-query-sum';
  readonly observedComputeMs: SampleDistribution;
  readonly observedComputeSamplesMs: readonly (number | null)[];
  readonly observedComputeCompleteFrames: number;
  readonly observedComputeExpectedQueryCounts: readonly number[];
  readonly observedComputeResolvedQueryCounts: readonly number[];
  readonly gpuPassMs: Readonly<Record<string, SampleDistribution>>;
  readonly proteinMotion: ProteinMotionMetricSummary;
  readonly proteinCase?: LabCase['proteinMotion'];
}

const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// カメラ位置を毎フレーム組み立てる書き込み先。
const CAMERA_OFFSET = new THREE.Vector3();

// 地球の天体照へ渡す恒星の向きの置き場。毎フレーム書き換えて使い回す。
const EARTH_STAR_DIRECTION = new THREE.Vector3();

// カメラの仰角の限界 [deg]。真上・真下では上方向と視線が平行になり、姿勢が決まらない。
export const MAX_CAMERA_ELEVATION_DEG = 89;

// 撮影がケースの部品と地球の揃いを待つ上限 [ms]。超えたらそのまま撮り、撮影そのものは落とさない。
// **重いケースの最初のフレームは、シェーダを組むあいだ 10 秒を超えて止まる**ので、上限は広く取る。
const READY_TIMEOUT_MS = 60_000;

// 撮影 1 枚が、絵の落ち着きを待って撮る回数の上限。実測では全撮影が 3 回以内に一致したので、その倍を取る。
const MAX_SETTLE_CAPTURES = 6;

interface LabPixelRatioRenderer {
  readonly domElement: HTMLCanvasElement;
  getPixelRatio(): number;
  getSize(target: THREE.Vector2): THREE.Vector2;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
}

// 描画倍率を一時的に変え、処理の成否にかかわらず元のキャンバス寸法へ戻す。
export async function withLabPixelRatio<T>(
  renderer: LabPixelRatioRenderer,
  pixelRatio: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previousPixelRatio = renderer.getPixelRatio();
  const previousSize = renderer.getSize(new THREE.Vector2());
  try {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(previousSize.x, previousSize.y, false);
    return await operation();
  } finally {
    renderer.setPixelRatio(previousPixelRatio);
    renderer.setSize(previousSize.x, previousSize.y, false);
  }
}

export class LabView {
  private readonly scene = new THREE.Scene();
  // 撮影先。合成パスは sRGB へ変換済みの値を書くので素の RGBA8 で受ける(-srgb にすると二重変換で
  // 白っぽくなる)。深度は 3D UI パスの線が深度テストに使うので持たせる(無いと線が不透明物を貫通する)。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  private current: LabCase | null = null;
  // スタイルを差し替えるとケースを組み直すので、いま出ているケースの名前も持つ。
  private currentName: CaseName | null = null;
  // 画面全体の見せ方。起動のたびに写実から始める。
  private style: RenderStyle = 'realistic';
  // 直前の render がパイプラインの描画に費やした CPU 時間 [ms]。
  private lastRenderCpuMs = 0;
  // カメラが周回する点。ケースの注視点を視線上へ落としたもの。
  private readonly pivot = new THREE.Vector3();
  // ケース既定のカメラ距離 [m]。cameraDistanceLog の基準になる。
  private defaultCameraDistance = 1;
  // ケース既定の画角 [deg]。cameraZoomLog の基準になる。
  private defaultCameraFovDeg = 1;
  // ケース既定の観察の向き。**ケースを組んで向きを引き直した時点で控える** — 描くとケースのカメラが
  // 動くので、あとから引き直すと動いたあとの向きを既定と取り違える。
  private defaultAngles: LabViewAngles = {
    sunAzimuthDeg: 0, sunElevationDeg: 0, sunDistanceLogAu: 0,
    cameraAzimuthDeg: 0, cameraElevationDeg: 0, cameraDistanceLog: 0, cameraZoomLog: 0,
    earthAzimuthDeg: 0, earthElevationDeg: 0, earthAltitudeLog: 0, earthLatitudeDeg: 0, earthLongitudeDeg: 0,
  };
  private angles: LabViewAngles = this.defaultAngles;
  // 全ケースの環の帯が共有するマテリアル。
  private readonly ringMaterials: RingMaterials;
  // 恒星。ケースによらず、観察のつまみの置き方へ描くたびに置き直す。
  private readonly sun = new LabSun();
  // 地球。実写の画像と雲場をケースの切り替えのたびに読み直さないよう 1 つだけ組み、地球を置く
  // ケースのあいだだけシーンへ出して、観察のつまみの置き方へ描くたびに置き直す。
  private readonly earth = new LabEarth();

  // 起動時の描画品質設定。撮影はこれへ差分を重ねる。
  private readonly startupGraphics: GraphicsSettingsData;

  // graphics は描く描画品質設定の器。
  private constructor(
    private readonly renderer: WebGPURenderer,
    private readonly pipeline: RenderPipeline,
    private readonly gpu: GpuTimings,
    private readonly graphics: StoredSetting<GraphicsSettingsData>,
  ) {
    // RenderPipeline はカメラのチャンネルを一時的に絞る。シーンルートが既定の 0 だけだと
    // その時点で子要素の走査が止まるため、コンテナとして全チャンネルを受ける。
    this.scene.layers.enableAll();
    this.ringMaterials = new RingMaterials(pipeline.bodyShadow, pipeline.sunLight);
    this.sun.addTo(this.scene);
    this.startupGraphics = graphics.current;
    graphics.subscribe((next) => this.rebuildForGraphics(next));
  }

  // graphics は描く描画品質設定の器。この時点の値を起動時の設定として控え、以後はその変更を受けて
  // 描き直す。
  public static async create(
    canvas: HTMLCanvasElement, graphics: StoredSetting<GraphicsSettingsData>,
  ): Promise<LabView> {
    // 深度の扱いはゲーム本体(src/render/scene.ts)と揃える。ここが違うと、深度の分解能と
    // 描画順の並べ替えが本番と別物になる。
    const renderer = new WebGPURenderer({
      canvas, trackTimestamp: true, reversedDepthBuffer: true,
    });
    renderer.setOpaqueSort(reversedOpaqueSort);
    renderer.setTransparentSort(reversedTransparentSort);
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT);
    await renderer.init();
    const gpu = new GpuTimings(renderer);
    gpu.enabled = true;
    const pipeline = new RenderPipeline(renderer, graphics.current, gpu);
    return new LabView(renderer, pipeline, gpu, graphics);
  }

  // ケースを差し替え、観察の向きをそのケースの既定へ戻して描く。
  public show(name: CaseName): void {
    this.build(name);
    this.resetView();
    this.render();
  }

  // 表示スタイルを差し替え、いま出ているケースをそのスタイルで組み直す。観察の向きは保つ —
  // 写実と模式図を同じ構図で見比べるための切り替え。
  public setStyle(style: RenderStyle): void {
    this.style = style;
    if (this.currentName !== null) this.build(this.currentName);
    this.render();
  }

  // ケースをいまのスタイルで組み直してシーンへ載せ、それを現在のケースにする。前のケースは解放する。
  private build(name: CaseName): void {
    if (this.current !== null) {
      this.scene.remove(...this.current.objects);
      this.current.disposeProteinMotion?.();
      for (const root of this.current.objects) disposeOwnedRenderResources(root);
    }
    const built = CASES[name](this.style, this.ringMaterials);
    // **1 つずつ足す** — 地球のほかに物体を持たないケースで空の引数を渡すと、three.js がエラーを出す。
    for (const object of built.objects) this.scene.add(object);
    this.current = built;
    this.currentName = name;
    // 地球はケースが置き方を宣言したときだけ出し、まずその既定の置き方へ置く。
    if (built.earth !== undefined) {
      this.scene.add(this.earth.object);
      this.earth.place(built.earth);
    } else {
      this.scene.remove(this.earth.object);
    }
    // **カメラの既定を引く前に一度同期する** — 環はここで姿勢が決まるので、同期する前に
    // 物体を包む箱を測ると注視点が原点へ寄る。
    built.sync?.(this.graphics.current, built.earth === undefined ? null : this.earth.center);
  }

  // 描画品質設定 graphics でパイプラインを組み直し、その場で描き直す。
  private rebuildForGraphics(graphics: GraphicsSettingsData): void {
    this.pipeline.ambient.setFraction(ambientFraction(graphics));
    this.pipeline.rebuildForGraphics(graphics);
    this.render();
  }

  // 画面へ出す中間バッファを選び、その場で描き直す。
  public showDebugTarget(target: DebugTargetId): void {
    this.pipeline.syncDebugTarget(target);
    this.render();
  }

  // いま観察している向き。ケースを選び直すとそのケースの既定値へ戻る。
  public get viewAngles(): LabViewAngles { return this.angles; }

  // いまのケースが地球を置くか。置かないケースでは、観察の向きの地球のつまみは絵に効かない。
  public get showsEarth(): boolean { return this.current?.earth !== undefined; }

  // 現在のカメラ距離 [m]。cameraDistanceLog は倍率の対数なので、実寸はここから読む。
  public get cameraDistance(): number { return this.defaultCameraDistance * 10 ** this.angles.cameraDistanceLog; }

  // 現在の画角 [deg]。ズームは画角を倍率ぶん狭めるので、半画角の正接を割って求める。
  public get cameraFovDeg(): number {
    const halfTangent = Math.tan(THREE.MathUtils.degToRad(this.defaultCameraFovDeg / 2));
    return THREE.MathUtils.radToDeg(2 * Math.atan(halfTangent / 10 ** this.angles.cameraZoomLog));
  }

  // 観察の向きを部分的に差し替え、その場で描き直す。仰角は姿勢が決まる範囲へ丸める。
  public setViewAngles(changes: Partial<LabViewAngles>): void {
    const merged = { ...this.angles, ...changes };
    this.angles = {
      ...merged,
      cameraElevationDeg: THREE.MathUtils.clamp(
        merged.cameraElevationDeg, -MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ELEVATION_DEG,
      ),
    };
    this.render();
  }

  // ケースのカメラと注視点から、観察の向きの既定値を引き直す。
  private resetView(): void {
    const built = this.current;
    if (built === null) return;
    // ケースのカメラから、周回の中心と既定の距離・画角を引く。**注視点はカメラの視線上へ落として
    // から使う** — 視線から外れた点を注視させると、向きへ触れていないのに絵が回る。
    const camera = built.camera;
    camera.updateMatrixWorld(true);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const pivot = built.viewTarget ?? boundsCenterOf(built.objects) ?? camera.position.clone().add(forward);
    const depth = forward.dot(new THREE.Vector3().subVectors(pivot, camera.position));
    this.defaultCameraDistance = Math.max(depth, camera.near);
    this.defaultCameraFovDeg = camera.fov;
    this.pivot.copy(camera.position).addScaledVector(forward, this.defaultCameraDistance);
    // 恒星とカメラの向きを角度へ直す。地球を置かないケースでは、地球のつまみを前のケースの値のまま保つ。
    const sun = anglesFromDirection(built.sunDirection ?? SUN_DIR);
    const eye = anglesFromDirection(forward.clone().negate());
    this.defaultAngles = {
      ...this.angles,
      ...built.earth,
      sunAzimuthDeg: sun.azimuthDeg,
      sunElevationDeg: sun.elevationDeg,
      sunDistanceLogAu: 0,
      cameraAzimuthDeg: eye.azimuthDeg,
      cameraElevationDeg: eye.elevationDeg,
      cameraDistanceLog: 0,
      cameraZoomLog: 0,
    };
    this.angles = this.defaultAngles;
  }

  // いまのケースを、観察の向きと描画品質設定の現在値で、表示時刻 displayTime [s] の 1 フレームとして描く。
  public render(displayTime = 0, observedFrame = false): void {
    if (this.current === null) return;
    const graphics = this.graphics.current;
    // カメラを観察の向きへ置く。画角と遠クリップ距離の書き換えは、投影行列を組み直すまで無言で効かない。
    // 遠クリップ距離は、周回の中心までの距離を注視距離としてゲーム本体と同じ式で引く。
    const camera = this.current.camera;
    directionFromAngles(this.angles.cameraAzimuthDeg, this.angles.cameraElevationDeg, CAMERA_OFFSET);
    camera.position.copy(this.pivot).addScaledVector(CAMERA_OFFSET, this.cameraDistance);
    camera.lookAt(this.pivot);
    camera.updateMatrixWorld(true);
    camera.fov = this.cameraFovDeg;
    camera.far = farClip(this.cameraDistance);
    camera.updateProjectionMatrix();
    // 恒星・地球・ケースの部品は、このフレームのカメラを置いてから合わせる — 部品はそのカメラを読んでよい。
    // ケースの部品は地球の中心も読むので、地球を先に置く。
    this.sun.sync(this.angles, camera, graphics, this.style);
    const earth = this.current.earth === undefined ? null : this.earth;
    earth?.place(this.angles);
    earth?.sync(camera, graphics, this.style);
    this.current.sync?.(graphics, earth?.center ?? null);
    // 恒星の光と露出。順応の基準点は描画原点 — **恒星の距離のつまみはここから恒星までの距離**なので、
    // 露出はその1つの数だけで決まり、ケースが物体をどこへ置いたかには引きずられない。
    this.pipeline.sunLight.set(this.sun.position, R_SUN, SUN_LIGHT_COLOR, this.sun.intensity);
    this.pipeline.exposure.setReference(ORIGIN, this.sun.position, this.sun.intensity);
    // 天体照の光源は地球だけ、影・大気の源は地球のぶんとケースのぶんを合わせて渡す。
    this.pipeline.planetLight.set(earth === null ? [] : [earthLightValue(earth, this.sun, graphics.airglow)]);
    this.pipeline.bodyShadow.set([...(this.current.shadowBodies ?? []), ...(earth === null ? [] : [earth.shadowBody])]);
    const rings = this.current.rings;
    this.pipeline.ringShadow.set(rings?.center ?? ORIGIN, rings?.axis ?? UP, rings?.bands ?? []);
    this.pipeline.cumulusShadow.set(castsCumulusShadow(graphics) ? earth?.cumulus ?? null : null);
    earth?.bake(this.renderer, displayTime, this.gpu);
    // 大気へのサンプル点の配りは、いま置いたカメラの位置からゲーム本体と同じ関数で引き直す。
    this.pipeline.atmosphere.setDraws(atmosphereDraws(
      [...(earth === null ? [] : [earth.atmosphere]), ...(this.current.atmospheres ?? [])].map((body) => {
        const distance = camera.position.distanceTo(body.center);
        return {
          body: withAirglowSetting(body, graphics.airglow),
          distance,
          metersPerPixel: metersPerPixelAtDepth(camera.fov, distance, VIEW_HEIGHT),
        };
      }),
      graphics.atmosphere,
    ));
    const startedAt = performance.now();
    try {
      this.pipeline.render(this.scene, camera, this.style);
    } finally {
      this.lastRenderCpuMs = performance.now() - startedAt;
      if (observedFrame) this.gpu.endObservedFrame();
      this.gpu.resolve();
    }
  }

  // ケースを表示して測る。angles を渡すと、ケース既定の観察の向きへそれを重ねてから測る。
  public async measure(
    name: CaseName, angles: Partial<LabViewAngles> = {}, warmupFrames = 6, sampleFrames = 30,
  ): Promise<LabMeasurement> {
    this.show(name);
    this.setViewAngles(angles);
    return this.measureCurrent(name, warmupFrames, sampleFrames);
  }

  // ケースの撮影を適用してから計測する。graphics は撮影の品質設定を適用した後の上書き。
  public async measureShot(
    name: CaseName, shotName: string, graphics: Partial<GraphicsSettingsData> = {},
    warmupFrames = 6, sampleFrames = 30,
  ): Promise<LabMeasurement> {
    this.show(name);
    this.applyShot(shotName);
    this.setGraphics({ ...this.graphics.current, ...graphics });
    return withLabPixelRatio(
      this.renderer,
      this.renderer.getPixelRatio() * this.graphics.current.resolutionScale,
      () => this.measureCurrent(name, warmupFrames, sampleFrames),
    );
  }

  // 現在のケースと shot の設定を保持したまま、準備待ち・ウォームアップ・標本収集を共通に行う。
  private async measureCurrent(
    name: CaseName, warmupFrames: number, sampleFrames: number,
  ): Promise<LabMeasurement> {
    await this.waitUntilReady();
    if (!this.ready) throw new Error(`render-lab: case "${name}" was not ready for measurement`);
    await this.gpu.waitForResolve();
    this.gpu.reset();

    // 暖機。計測に入れないフレームを回して、シェーダのコンパイルや初回の転送を済ませる。
    // 表示時刻は 60fps で進める — 雲場は表示時刻が変わったフレームにだけ焼くので、止めると生成を測れない。
    for (let frame = 0; frame < warmupFrames; frame++) {
      const displayTime = (frame + 1) / 60;
      this.current?.updateProteinMotion?.(displayTime);
      this.render(displayTime);
      await this.gpu.waitForResolve();
    }
    this.gpu.reset();

    // 本計測。フレームごとに CPU 時間・GPU のパス時間・残基 motion の計測値を集める。
    const cpuSamples: number[] = [];
    const gpuPassTotalSamples: number[] = [];
    const observedRenderSamples: (number | null)[] = [];
    const observedRenderExpectedQueryCounts: number[] = [];
    const observedRenderResolvedQueryCounts: number[] = [];
    const observedComputeSamples: (number | null)[] = [];
    const observedComputeExpectedQueryCounts: number[] = [];
    const observedComputeResolvedQueryCounts: number[] = [];
    const gpuSamples = Array.from({ length: GPU_PASS_COUNT }, () => [] as number[]);
    const motion = new ProteinMotionMetricsRecorder();
    for (let frame = 0; frame < sampleFrames; frame++) {
      const displayTime = (warmupFrames + frame + 1) / 60;
      this.gpu.beginObservedFrame();
      const motionSample = this.current?.updateProteinMotion?.(displayTime);
      this.render(displayTime, true);
      cpuSamples.push(this.lastRenderCpuMs);
      await this.gpu.waitForResolve();
      const timings = this.gpu.snapshot();
      observedRenderSamples.push(timings.observedRenderComplete ? timings.observedRenderTotalMs : null);
      observedRenderExpectedQueryCounts.push(timings.observedRenderExpectedQueryCount);
      observedRenderResolvedQueryCounts.push(timings.observedRenderQueryCount);
      observedComputeSamples.push(timings.observedComputeComplete ? timings.observedComputeTotalMs : null);
      observedComputeExpectedQueryCounts.push(timings.observedComputeExpectedQueryCount);
      observedComputeResolvedQueryCounts.push(timings.observedComputeQueryCount);
      let passTotalMs = 0;
      for (let index = 0; index < GPU_PASS_COUNT; index += 1) {
        passTotalMs += timings.elapsedMs[index] ?? 0;
      }
      gpuPassTotalSamples.push(passTotalMs);
      for (const [index, samples] of gpuSamples.entries()) samples.push(timings.elapsedMs[index] ?? 0);
      motion.record(motionSample ?? { cpuMs: 0, uploadBytes: 0, lodCounts: {} });
    }

    return {
      caseName: name,
      frames: sampleFrames,
      canvasWidth: this.renderer.domElement.width,
      canvasHeight: this.renderer.domElement.height,
      cpuRenderMs: distributionOf(cpuSamples),
      gpuSupported: this.gpu.snapshot().supported,
      gpuPassTotalScope: 'instrumented-render-pass-sum',
      gpuPassTotalMs: distributionOf(gpuPassTotalSamples),
      observedRenderTotalScope: 'observed-render-total',
      observedRenderTotalMs: distributionOf(observedRenderSamples.filter(
        (sample): sample is number => sample !== null,
      )),
      observedRenderTotalSamplesMs: observedRenderSamples,
      observedRenderCompleteFrames: observedRenderSamples.filter((sample) => sample !== null).length,
      observedRenderExpectedQueryCounts,
      observedRenderResolvedQueryCounts,
      observedComputeScope: 'renderer-compute-query-sum',
      observedComputeMs: distributionOf(observedComputeSamples.filter(
        (sample): sample is number => sample !== null,
      )),
      observedComputeSamplesMs: observedComputeSamples,
      observedComputeCompleteFrames: observedComputeSamples.filter((sample) => sample !== null).length,
      observedComputeExpectedQueryCounts,
      observedComputeResolvedQueryCounts,
      gpuPassMs: Object.fromEntries(GPU_PASS_LABELS.map((label, index) => [label, distributionOf(gpuSamples[index]!)])),
      proteinMotion: motion.summary(),
      proteinCase: this.current?.proteinMotion,
    };
  }

  // いまのケースの撮影。ケースが宣言していなければ、ケース名で既定の向きを 1 枚撮る。
  private get shots(): Readonly<Record<string, LabShot>> {
    if (this.current === null || this.currentName === null) return {};
    return this.current.shots ?? { [this.currentName]: { view: {} } };
  }

  // いまのケースの撮影名。
  public get shotNames(): readonly string[] { return Object.keys(this.shots); }

  // いまのケースの撮影 name を当てて描き直す。描画品質設定は起動時の値へ graphics と撮影の差分を
  // この順に重ねた値に、観察の向きはケース既定へ撮影の差分を重ねた値になる。name が撮影に無ければ投げる。
  public applyShot(name: string, graphics: Partial<GraphicsSettingsData> = {}): void {
    const shot = this.shots[name];
    if (shot === undefined) throw new Error(`render-lab: the current case has no shot "${name}"`);
    this.setGraphics({ ...this.startupGraphics, ...graphics, ...shot.graphics });
    this.setViewAngles({ ...this.defaultAngles, ...shot.view });
  }

  // 描画品質設定を next にする。**設定の器は同値でも購読者へ配り、パイプラインを組み直す**ので、
  // いまの値と 1 項目でも違うときだけ書く。
  private setGraphics(next: GraphicsSettingsData): void {
    const current = this.graphics.current;
    const changed = (Object.keys(next) as GraphicsOptionKey[]).some((key) => next[key] !== current[key]);
    if (changed) this.graphics.set(next);
  }

  // ケースを表示し、ケースが宣言した撮影ごとに applyShot を当てて、キャンバスへ出るのと同じ絵
  // (トーンマッピングと sRGB 変換込み)を撮る。graphics は起動時の描画品質設定と撮影の差分のあいだへ
  // 重ねる差分。返り値は撮影名から PNG のデータ URL への表。ケースの部品と地球が揃うまで待ってから
  // 撮る。絵が落ち着かない撮影があれば投げる。観察の向きと描画品質設定は最後の撮影のまま残る。
  public async shoot(
    name: CaseName, graphics: Partial<GraphicsSettingsData> = {},
  ): Promise<Readonly<Record<string, string>>> {
    // **ケースは起動時の値へ graphics を重ねた設定で組んで待つ** — 描画設定が有効な間にしか読み込まない
    // 部品(雲など)があり、前の撮影の設定のまま待つと、読み込み前の姿を撮る。
    this.setGraphics({ ...this.startupGraphics, ...graphics });
    this.show(name);
    this.current?.updateProteinMotion?.(1);
    await this.waitUntilReady();
    const pngs: Record<string, string> = {};
    for (const shotName of this.shotNames) {
      this.applyShot(shotName, graphics);
      pngs[shotName] = await this.captureSettled(shotName);
    }
    return pngs;
  }

  // 連続する 2 回の capture が一致するまで撮り直し、一致した絵を返す。MAX_SETTLE_CAPTURES 回撮っても
  // 一致しなければ、撮影名 shotName を添えて投げる。
  private async captureSettled(shotName: string): Promise<string> {
    // **一致を「絵が落ち着いた」ことの判定にする** — 同じセッションの中では、落ち着いたあとのフレームは
    // 完全に決定的。雲場は焼いたフレームの次から載り、パイプラインを組み直した直後のフレームは崩れる。
    let previous = await this.capture();
    for (let count = 2; count <= MAX_SETTLE_CAPTURES; count++) {
      const next = await this.capture();
      if (next === previous) return next;
      previous = next;
    }
    throw new Error(`render-lab: shot "${shotName}" did not settle within ${MAX_SETTLE_CAPTURES} captures`);
  }

  // いまのケースの部品と、地球を置くなら地球が揃い、絵として比べられる状態になったか。
  private get ready(): boolean {
    const built = this.current;
    if (built === null) return true;
    return (built.ready?.() ?? true) && (built.earth === undefined || this.earth.ready);
  }

  // ready が真になるまで、1 フレームずつ描いて待つ。上限を過ぎたらそのまま戻る。
  private async waitUntilReady(): Promise<void> {
    const deadline = performance.now() + READY_TIMEOUT_MS;
    while (!this.ready && performance.now() < deadline) {
      // **描かずに待っても進まない** — テクスチャの GPU 投入は 1 回の描画につき 1 枚しか進まない。
      this.render();
      // **次を描く前に前のフレームの GPU 完了を待つ** — 待たずに回すと重いケースで命令が溜まり、
      // デバイスごと落ちる。
      await this.gpu.waitForResolve();
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    }
  }

  // いま画面に出ているものを、ケースも観察の向きも変えずに撮る。
  public async capture(): Promise<string> {
    this.renderer.setOutputRenderTarget(this.captureTarget);
    try {
      this.render();
    } finally {
      // 戻し忘れると以後キャンバスに何も出なくなる(撮影だけは通るので気付きにくい)。
      this.renderer.setOutputRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    return pixelsToPngDataUrl(new Uint8Array(pixels.buffer), VIEW_WIDTH, VIEW_HEIGHT);
  }
}

// 物体 objects をすべて包む箱の中心(描画座標)。箱が空なら null。
function boundsCenterOf(objects: readonly THREE.Object3D[]): THREE.Vector3 | null {
  const box = new THREE.Box3();
  for (const root of objects) {
    root.updateWorldMatrix(true, true);
    box.expandByObject(root);
  }
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

// 大気 body を、描画設定の大気光の有無 airglow へ合わせた写し。**雲は写した時点で固定せず、読む
// たびに body から引く** — 雲の有無は、地球が描画設定を押し込むたびに置き直される。
function withAirglowSetting(body: AtmosphereBody, airglow: boolean): AtmosphereBody {
  return { ...body, optics: withAirglowEnabled(body.optics, airglow), get clouds() { return body.clouds; } };
}

// 地球 earth を、恒星 sun に照らされた天体照の光源とした値。大気は描画設定の大気光の有無 airglow へ
// 合わせて渡す。
function earthLightValue(earth: LabEarth, sun: LabSun, airglow: boolean): PlanetLightValue {
  const sunIrradiance = sun.irradianceAt(earth.center);
  return {
    center: earth.center,
    radius: R_EARTH,
    radiance: planetRadiance(EARTH_LIGHT_ALBEDO, sunIrradiance),
    appearance: {
      map: earth.lightSourceMap,
      albedo: EARTH_LIGHT_ALBEDO,
      sunIrradiance,
      starDirection: EARTH_STAR_DIRECTION.subVectors(sun.position, earth.center).normalize(),
      bodyFromWorld: earth.bodyFromWorld,
      atmosphere: withAirglowSetting(earth.atmosphere, airglow),
    },
  };
}
