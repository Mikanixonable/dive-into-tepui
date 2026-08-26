// 描画テスト環境の 1 ビュー。ケースを組み、ゲーム本体と同じ RenderPipeline でキャンバスへ描く。
// 絵の撮影(PNG)と、CPU / GPU それぞれの所要時間の計測もここが担う。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { GPU_PASS_COUNT, GPU_PASS_LABELS, GpuTimings } from '../../src/gpu-timings';
import { ProteinMotionMetricsRecorder, type ProteinMotionMetricSummary } from '../../src/protein-motion-metrics';
import { RenderPipeline } from '../../src/render/pipeline/render-pipeline';
import { LIT_OPAQUE_LAYER } from '../../src/render/pipeline/lit-layer';
import {
  AMBIENT_COLOR, AMBIENT_IRRADIANCE, SUN_COLOR, SUN_IRRADIANCE_1AU, SUN_RADIANT_INTENSITY,
} from '../../src/render/pipeline/sun-light';
import { reversedOpaqueSort, reversedTransparentSort } from '../../src/render/pipeline/reversed-sort';
import { QUALITY_PRESETS, withGraphicsOption } from '../../src/render/graphics-settings';
import type { GraphicsOptionKey, GraphicsSettingsData } from '../../src/render/graphics-settings';
import { AU } from '../../src/physics/planet-orbit';
import { R_SUN } from '../../src/physics/solar-system';
import type { DebugTargetId } from '../../src/render/pipeline/debug-target';
import type { RenderStyle } from '../../src/render/render-style';
import { CASES, type CaseName, type LabCase, SUN_DIR, VIEW_HEIGHT, VIEW_WIDTH } from './cases';

export interface LabDistribution {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface LabMeasurement {
  readonly caseName: CaseName;
  readonly frames: number;
  readonly cpuRenderMs: LabDistribution;
  readonly gpuSupported: boolean;
  readonly gpuPassMs: Readonly<Record<string, LabDistribution>>;
  readonly proteinMotion: ProteinMotionMetricSummary;
  readonly proteinCase?: LabCase['proteinMotion'];
}

const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// 恒星を置く位置。ゲーム本体と同じ放射強度を渡すので、そこで受ける放射照度もゲーム本体の
// 同じ距離と一致する。ケースごとの向きと距離を毎フレーム書き込む。
const SUN_POSITION = new THREE.Vector3();

// シーン光源(平行光)を置く距離 [m]。向きだけが意味を持つので、ケースの広がりより十分遠ければよい。
const SUN_LIGHT_DISTANCE = 1e5;

// 恒星方向とカメラ位置を毎フレーム組み立てる書き込み先。
const SUN_DIRECTION = new THREE.Vector3();
const CAMERA_OFFSET = new THREE.Vector3();

// カメラの仰角の限界 [deg]。真上・真下では上方向と視線が平行になり、姿勢が決まらない。
export const MAX_CAMERA_ELEVATION_DEG = 89;

// カメラの距離の倍率の常用対数の限界。0 がケース既定の距離。
export const MAX_CAMERA_ZOOM = 1;

// 観察の向き。角度は度、cameraZoom はケース既定の距離に対する倍率の常用対数。
export type LabViewAngles = {
  readonly sunAzimuthDeg: number;
  readonly sunElevationDeg: number;
  readonly cameraAzimuthDeg: number;
  readonly cameraElevationDeg: number;
  readonly cameraZoom: number;
};

// 方位角・仰角 [deg] から単位ベクトルを組む。方位角 0 が +Z、+90 度が +X。
function directionFromAngles(azimuthDeg: number, elevationDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const horizontal = Math.cos(elevation);
  return out.set(Math.sin(azimuth) * horizontal, Math.sin(elevation), Math.cos(azimuth) * horizontal);
}

// directionFromAngles の逆写像。長さ 0 でない任意のベクトルを受ける。
function anglesFromDirection(v: THREE.Vector3): { azimuthDeg: number; elevationDeg: number } {
  const unitY = THREE.MathUtils.clamp(v.y / Math.max(v.length(), 1e-12), -1, 1);
  return {
    azimuthDeg: THREE.MathUtils.radToDeg(Math.atan2(v.x, v.z)),
    elevationDeg: THREE.MathUtils.radToDeg(Math.asin(unitY)),
  };
}

export class LabView {
  private readonly scene = new THREE.Scene();
  // ケースの太陽方向へ向け直すために持つ。恒星の位置と同じ向きを指す。
  private readonly sun = new THREE.DirectionalLight(SUN_COLOR.getHex(), SUN_IRRADIANCE_1AU);
  // ケースごとの環境光。恒星光と同じく、強度は render() が毎フレーム書き込む。
  private readonly ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_IRRADIANCE);
  // 撮影先。合成パスが既に sRGB へ変換した値を書くので、素の RGBA8 で受ける
  // (-srgb フォーマットにすると二重変換になり、撮った PNG だけが白っぽくなる)。
  // 深度は 3D UI パスが要る — 合成パスが G バッファの深度をここへ複製し、線はそれに対して
  // 深度テストする。持たせないと線が不透明物を貫通して常に手前へ出る。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  private current: LabCase | null = null;
  // スタイルを差し替えるとケースを組み直すので、いま出ているケースの名前も持つ。
  private currentName: CaseName | null = null;
  // 画面全体の見せ方。ゲーム本体と違い保存はせず、起動のたびに写実から始める。
  private style: RenderStyle = 'realistic';
  private lastRenderCpuMs = 0;
  // カメラが周回する点。ケースの注視点を視線上へ落としたもの。
  private readonly pivot = new THREE.Vector3();
  // ケース既定のカメラ距離 [m]。cameraZoom の基準になる。
  private defaultCameraDistance = 1;
  private angles: LabViewAngles = {
    sunAzimuthDeg: 0, sunElevationDeg: 0,
    cameraAzimuthDeg: 0, cameraElevationDeg: 0, cameraZoom: 0,
  };
  // 描画品質設定のうち、パイプラインが読むものだけを操作の対象にする。ゲーム本体と保存先を
  // 分けるため、ここが値の正本を持つ(ブラウザへは残さない)。
  private graphicsData: GraphicsSettingsData = QUALITY_PRESETS.high;
  private readonly scratchBox = new THREE.Box3();
  private readonly caseCenterVector = new THREE.Vector3();
  private readonly scratchVector = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  private constructor(
    private readonly renderer: WebGPURenderer,
    private readonly pipeline: RenderPipeline,
    private readonly gpu: GpuTimings,
  ) {
    // RenderPipeline はカメラのチャンネルを一時的に絞る。シーンルートが既定の 0 だけだと
    // その時点で子要素の走査が止まるため、コンテナとして全チャンネルを受ける。
    this.scene.layers.enableAll();
    // NodeMaterial はカメラのチャンネルと重なる光源が1つも無いと照明モデルを組まない。
    // マテリアルパスはカメラを LIT_OPAQUE_LAYER 単独へ絞るので、光源も同チャンネルへ属させる。
    this.sun.layers.enable(LIT_OPAQUE_LAYER);
    this.ambient.layers.enable(LIT_OPAQUE_LAYER);
    this.scene.add(this.sun, this.ambient);
  }

  static async create(canvas: HTMLCanvasElement): Promise<LabView> {
    // 深度の扱いはゲーム本体(src/render/scene.ts)と揃える。ここが違うと、測りたい深度の
    // 分解能そのものが本番と別物になる。
    const renderer = new WebGPURenderer({
      canvas, antialias: QUALITY_PRESETS.high.antialias, reversedDepthBuffer: true,
    });
    renderer.setOpaqueSort(reversedOpaqueSort);
    renderer.setTransparentSort(reversedTransparentSort);
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT);
    await renderer.init();
    const gpu = new GpuTimings(renderer);
    gpu.enabled = true;
    const pipeline = new RenderPipeline(renderer, QUALITY_PRESETS.high, gpu);
    return new LabView(renderer, pipeline, gpu);
  }

  // ケースを差し替え、観察の向きをそのケースの既定へ戻して描く。
  show(name: CaseName): void {
    this.currentName = name;
    this.resetView(this.build(name));
    this.render();
  }

  // 表示スタイルを差し替え、いま出ているケースをそのスタイルで組み直す。**観察の向きは戻さない**
  // — 写実と模式図を同じ構図で見比べるための切り替えなので、既定へ戻すと見比べられない。
  setStyle(style: RenderStyle): void {
    this.style = style;
    if (this.currentName !== null) this.build(this.currentName);
    this.render();
  }

  // ケースを組み直してシーンへ載せる。前のケースはシーンから外すだけで解放しない — 球の単位
  // ジオメトリは LOD 段ごとに全利用元で共有されていて、ここで捨てると次のケースが壊れる。
  private build(name: CaseName): LabCase {
    if (this.current !== null) {
      this.scene.remove(...this.current.objects);
      disposeCaseObjects(this.current);
    }
    const built = CASES[name](this.style, this.pipeline.sunOcclusion, this.pipeline.sunLight);
    this.scene.add(...built.objects);
    this.current = built;
    return built;
  }

  get graphics(): GraphicsSettingsData { return this.graphicsData; }

  // 描画品質設定の項目を1つ差し替え、パイプラインへ押し出してその場で描き直す。
  setGraphicsOption(key: GraphicsOptionKey, value: boolean | number): void {
    this.graphicsData = withGraphicsOption(this.graphicsData, key, value);
    this.pipeline.applyGraphics(this.graphicsData);
    this.render();
  }

  // 画面へ出す中間バッファを選び、その場で描き直す。
  showDebugTarget(target: DebugTargetId): void {
    this.pipeline.debugTarget = target;
    this.render();
  }

  // いま観察している向き。ケースを選び直すとそのケースの既定値へ戻る。
  get viewAngles(): LabViewAngles { return this.angles; }

  // 現在のカメラ距離 [m]。cameraZoom は倍率の対数なので、実寸はここから読む。
  get cameraDistance(): number { return this.defaultCameraDistance * 10 ** this.angles.cameraZoom; }

  // 観察の向きを部分的に差し替え、その場で描き直す。仰角は姿勢が決まる範囲へ丸める。
  setViewAngles(changes: Partial<LabViewAngles>): void {
    const merged = { ...this.angles, ...changes };
    this.angles = {
      ...merged,
      cameraElevationDeg: THREE.MathUtils.clamp(
        merged.cameraElevationDeg, -MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ELEVATION_DEG,
      ),
    };
    this.render();
  }

  // ケースのカメラと注視点から、観察の向きの既定値を引き直す。**注視点はカメラの視線上へ
  // 落としてから使う** — 視線から外れた点を注視させると、向きへ触れていないのに絵が回る。
  private resetView(built: LabCase): void {
    const camera = built.camera;
    camera.updateMatrixWorld(true);
    camera.getWorldDirection(this.forward);
    const pivot = built.viewTarget ?? this.caseCenter(built);
    const depth = this.forward.dot(this.scratchVector.subVectors(pivot, camera.position));
    this.defaultCameraDistance = Math.max(depth, camera.near);
    this.pivot.copy(camera.position).addScaledVector(this.forward, this.defaultCameraDistance);
    const sun = anglesFromDirection(built.sunDirection ?? SUN_DIR);
    const eye = anglesFromDirection(this.scratchVector.copy(this.forward).negate());
    this.angles = {
      sunAzimuthDeg: sun.azimuthDeg,
      sunElevationDeg: sun.elevationDeg,
      cameraAzimuthDeg: eye.azimuthDeg,
      cameraElevationDeg: eye.elevationDeg,
      cameraZoom: 0,
    };
  }

  // ケースの物体をすべて包む箱の中心。viewTarget を持たないケースの注視点になる。
  private caseCenter(built: LabCase): THREE.Vector3 {
    this.scratchBox.makeEmpty();
    for (const root of built.objects) {
      root.updateWorldMatrix(true, true);
      this.scratchBox.expandByObject(root);
    }
    if (this.scratchBox.isEmpty()) {
      return this.caseCenterVector.copy(built.camera.position).addScaledVector(this.forward, 1);
    }
    return this.scratchBox.getCenter(this.caseCenterVector);
  }

  // 動くものが無いので、描くのはケースを差し替えたときと、表示を切り替えたときと、撮影のとき。
  render(): void {
    if (this.current === null) return;
    // 恒星の位置とシーン光源の向きは、必ず同じ向きから引く。片方だけを更新すると、影の向きと
    // 明暗の境界の向きが食い違ったまま「それらしく」写る。
    const sunDirection = directionFromAngles(
      this.angles.sunAzimuthDeg, this.angles.sunElevationDeg, SUN_DIRECTION,
    );
    this.sun.position.copy(sunDirection).multiplyScalar(SUN_LIGHT_DISTANCE);
    // 環境光の強さは、フォワード経路の光源とライティングパスの両方が同じ値を読む —
    // 片方だけ直すと陰影の辻褄が合わない。
    const ambientIrradiance = this.current.ambientIrradiance ?? AMBIENT_IRRADIANCE;
    this.ambient.intensity = ambientIrradiance;
    this.pipeline.sunLight.set(
      SUN_POSITION.copy(sunDirection).multiplyScalar(this.current.sunDistance ?? AU),
      R_SUN, SUN_COLOR, SUN_RADIANT_INTENSITY, ambientIrradiance,
    );
    // 順応の基準点は描画原点。**ケースの sunDistance はここから恒星までの距離**なので、
    // 露出はその1つの数だけで決まり、ケースが物体をどこへ置いたかには引きずられない。
    this.pipeline.exposure.setReference(ORIGIN, SUN_POSITION);
    const camera = this.current.camera;
    directionFromAngles(this.angles.cameraAzimuthDeg, this.angles.cameraElevationDeg, CAMERA_OFFSET);
    camera.position.copy(this.pivot).addScaledVector(CAMERA_OFFSET, this.cameraDistance);
    camera.lookAt(this.pivot);
    camera.updateMatrixWorld(true);
    this.pipeline.sunOcclusion.setOccluders(this.current.occluders ?? []);
    const rings = this.current.rings;
    this.pipeline.sunOcclusion.setRings(rings?.center ?? ORIGIN, rings?.axis ?? UP, rings?.bands ?? []);
    const atmosphere = this.current.atmosphere;
    this.pipeline.atmosphere.setBody(atmosphere?.center ?? ORIGIN, atmosphere?.surfaceRadius ?? 0);
    const startedAt = performance.now();
    this.pipeline.render(this.scene, camera, this.style);
    this.lastRenderCpuMs = performance.now() - startedAt;
    this.gpu.resolve();
  }

  async measure(name: CaseName, warmupFrames = 6, sampleFrames = 30): Promise<LabMeasurement> {
    this.show(name);
    await this.gpu.waitForResolve();
    this.gpu.reset();

    for (let frame = 0; frame < warmupFrames; frame++) {
      this.current?.updateProteinMotion?.((frame + 1) / 60);
      this.render();
      await this.gpu.waitForResolve();
    }
    this.gpu.reset();

    const cpuSamples: number[] = [];
    const gpuSamples = Array.from({ length: GPU_PASS_COUNT }, () => [] as number[]);
    const motion = new ProteinMotionMetricsRecorder();
    for (let frame = 0; frame < sampleFrames; frame++) {
      const motionSample = this.current?.updateProteinMotion?.((warmupFrames + frame + 1) / 60);
      this.render();
      cpuSamples.push(this.lastRenderCpuMs);
      await this.gpu.waitForResolve();
      const snapshot = this.gpu.snapshot();
      for (const [index, samples] of gpuSamples.entries()) samples.push(snapshot.elapsedMs[index] ?? 0);
      motion.record(motionSample ?? { cpuMs: 0, uploadBytes: 0, lodCounts: {} });
    }

    return {
      caseName: name,
      frames: sampleFrames,
      cpuRenderMs: distribution(cpuSamples),
      gpuSupported: this.gpu.snapshot().supported,
      gpuPassMs: Object.fromEntries(GPU_PASS_LABELS.map((label, index) => [label, distribution(gpuSamples[index]!)])),
      proteinMotion: motion.summary(),
      proteinCase: this.current?.proteinMotion,
    };
  }

  // キャンバスへ出るのと同じ絵を PNG のデータ URL で返す。合成パスが「キャンバスへ」と書いた
  // 出力先が撮影ターゲットへ差し替わるだけなので、トーンマッピングも sRGB 変換も同じに掛かる。
  async shoot(name: CaseName): Promise<string> {
    this.show(name);
    this.current?.updateProteinMotion?.(1);
    return this.capture();
  }

  // いま画面に出ているものを、ケースも観察の向きも変えずに撮る。
  async capture(): Promise<string> {
    this.renderer.setOutputRenderTarget(this.captureTarget);
    try {
      this.render();
    } finally {
      // 戻し忘れると以後キャンバスに何も出なくなる(撮影だけは通るので気付きにくい)。
      this.renderer.setOutputRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    return toPng(new Uint8Array(pixels.buffer));
  }
}

function disposeCaseObjects(built: LabCase): void {
  built.disposeProteinMotion?.();
  for (const root of built.objects) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!object.userData.ownsGeometry && !object.userData.ownsMaterial) return;
      if (object.userData.ownsGeometry && 'geometry' in mesh && mesh.geometry) mesh.geometry.dispose();
      if (!object.userData.ownsMaterial || !('material' in mesh)) return;
      const material = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    });
  }
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function distribution(values: readonly number[]): LabDistribution {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// 読み出した RGBA 画素を PNG のデータ URL にする。
function toPng(pixels: Uint8Array): string {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_WIDTH;
  canvas.height = VIEW_HEIGHT;
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), VIEW_WIDTH, VIEW_HEIGHT), 0, 0);
  return canvas.toDataURL('image/png');
}
