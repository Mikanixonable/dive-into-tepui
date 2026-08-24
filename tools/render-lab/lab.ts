// 同じケースをライトプリパスとフォワードの 2 経路で描く。違いは「メッシュとライトがどの
// チャンネルに居るか」だけで、HDR ターゲット・トーンマッピング・合成・色空間変換はどちらも
// 同じ RenderPipeline を通る。だから画面に出る差はシェーディング経路の差そのものになる。
//
// 例外が 1 つある: フォワード経路は G バッファを空にするので、合成パスがキャンバスの深度
// バッファへ複製する深度も空になり、3D UI パスの線が不透明物に隠れない。**差分画像で線が
// 不透明物を横切る箇所だけは、2 経路が食い違うのが正しい。**
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { GPU_PASS_COUNT, GPU_PASS_LABELS, GpuTimings } from '../../src/gpu-timings';
import { ProteinMotionMetricsRecorder, type ProteinMotionMetricSummary } from '../../src/protein-motion-metrics';
import { RenderPipeline } from '../../src/render/pipeline/render-pipeline';
import { LIT_OPAQUE_LAYER, OVERLAY_LAYER } from '../../src/render/pipeline/lit-layer';
import {
  AMBIENT_COLOR, AMBIENT_IRRADIANCE, SUN_COLOR, SUN_IRRADIANCE_1AU, SUN_RADIANT_INTENSITY,
} from '../../src/render/pipeline/sun-light';
import { reversedOpaqueSort, reversedTransparentSort } from '../../src/render/pipeline/reversed-sort';
import { QUALITY_PRESETS } from '../../src/render/graphics-settings';
import { AU } from '../../src/physics/planet-orbit';
import { R_SUN } from '../../src/physics/solar-system';
import { CASES, type CaseName, type LabCase, SUN_DIR, VIEW_HEIGHT, VIEW_WIDTH } from './cases';

export type LabPath = 'prepass' | 'forward';

export interface LabDistribution {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface LabMeasurement {
  readonly caseName: CaseName;
  readonly path: LabPath;
  readonly frames: number;
  readonly cpuRenderMs: LabDistribution;
  readonly gpuSupported: boolean;
  readonly gpuPassMs: Readonly<Record<string, LabDistribution>>;
  readonly proteinMotion: ProteinMotionMetricSummary;
  readonly proteinCase?: LabCase['proteinMotion'];
}

const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// 恒星は 1 天文単位の位置に置く。ゲーム本体と同じ放射強度を渡すので、そこで受ける放射照度も
// ゲーム本体の 1 天文単位と一致する。
const SUN_POSITION = SUN_DIR.clone().multiplyScalar(AU);

export class LabView {
  private readonly scene = new THREE.Scene();
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
  private lastRenderCpuMs = 0;

  private constructor(
    private readonly path: LabPath,
    private readonly renderer: WebGPURenderer,
    private readonly pipeline: RenderPipeline,
    private readonly gpu: GpuTimings,
  ) {
    // RenderPipeline はカメラのチャンネルを一時的に絞る。シーンルートが既定の 0 だけだと
    // その時点で子要素の走査が止まるため、コンテナとして全チャンネルを受ける。
    this.scene.layers.enableAll();
    const sun = new THREE.DirectionalLight(SUN_COLOR.getHex(), SUN_IRRADIANCE_1AU);
    sun.position.copy(SUN_DIR).multiplyScalar(1e5);
    const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_IRRADIANCE);
    // NodeMaterial はカメラのチャンネルと重なる光源が1つも無いと照明モデルを組まない。
    // マテリアルパスはカメラを LIT_OPAQUE_LAYER 単独へ絞るので、その経路の光源は同チャンネルにも属させる。
    if (path === 'prepass') {
      sun.layers.enable(LIT_OPAQUE_LAYER);
      ambient.layers.enable(LIT_OPAQUE_LAYER);
    }
    this.scene.add(sun, ambient);
  }

  static async create(canvas: HTMLCanvasElement, path: LabPath): Promise<LabView> {
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
    return new LabView(path, renderer, pipeline, gpu);
  }

  // ケースを組み直して描く。前のケースはシーンから外すだけで解放しない — 球の単位ジオメトリは
  // LOD 段ごとに全利用元で共有されていて、ここで捨てると次のケースが壊れる。
  show(name: CaseName): void {
    if (this.current !== null) {
      this.scene.remove(...this.current.objects);
      disposeCaseObjects(this.current);
    }
    const built = CASES[name](this.pipeline.sunOcclusion);
    for (const object of built.objects) {
      // フォワード経路では buildPlayerShip() が内部で付けた LIT_OPAQUE_LAYER を打ち消す。
      // 呼ばないのではなく、呼ばれたあとに戻す。3D UI チャンネルはシェーディング経路と無関係
      // (どちらの経路でも合成後に同じ 3D UI パスが描く)なので、そこは戻さない。
      if (this.path === 'forward') {
        object.traverse((o) => { if (!o.layers.isEnabled(OVERLAY_LAYER)) o.layers.set(0); });
      }
    }
    this.scene.add(...built.objects);
    this.current = built;
    this.render();
  }

  // 動くものが無いので、描くのはケースを差し替えたときと撮影のときだけ。
  render(): void {
    if (this.current === null) return;
    this.pipeline.sunLight.set(SUN_POSITION, R_SUN, SUN_COLOR, SUN_RADIANT_INTENSITY, AMBIENT_IRRADIANCE);
    this.pipeline.sunOcclusion.setOccluders(this.current.occluders ?? []);
    const rings = this.current.rings;
    this.pipeline.sunOcclusion.setRings(rings?.center ?? ORIGIN, rings?.axis ?? UP, rings?.bands ?? []);
    const atmosphere = this.current.atmosphere;
    this.pipeline.atmosphere.setBody(atmosphere?.center ?? ORIGIN, atmosphere?.surfaceRadius ?? 0);
    const startedAt = performance.now();
    this.pipeline.render(this.scene, this.current.camera);
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
      path: this.path,
      frames: sampleFrames,
      cpuRenderMs: distribution(cpuSamples),
      gpuSupported: this.gpu.snapshot().supported,
      gpuPassMs: Object.fromEntries(GPU_PASS_LABELS.map((label, index) => [label, distribution(gpuSamples[index]!)])),
      proteinMotion: motion.summary(),
      proteinCase: this.current?.proteinMotion,
    };
  }

  // キャンバスへ出るのと同じ絵を画素で受け取る。合成パスが「キャンバスへ」と書いた出力先が
  // 撮影ターゲットへ差し替わるだけなので、トーンマッピングも sRGB 変換も同じに掛かる —
  // WebGPU キャンバスの提示・合成・スクリーンショットはどこも通らない。
  async capture(name: CaseName): Promise<Uint8Array> {
    this.show(name);
    this.renderer.setOutputRenderTarget(this.captureTarget);
    try {
      this.current?.updateProteinMotion?.(1);
      this.render();
    } finally {
      // 戻し忘れると以後キャンバスに何も出なくなる(撮影だけは通るので気付きにくい)。
      this.renderer.setOutputRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    return new Uint8Array(pixels.buffer);
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

export type LabViews = { readonly prepass: LabView; readonly forward: LabView };
export type Shot = { readonly prepass: string; readonly forward: string; readonly diff: string };

// 差分の増幅率。1/255 の丸め差は見えず、実質的な差は見える倍率。
const DIFF_GAIN = 8;

// 2 経路の画素差。レンダラーが 2 台=デバイスも 2 つなので、GPU 上でテクスチャを突き合わせられない。
// 読み出したあとの引き算で出す。
function diffPixels(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.abs(a[i + c]! - b[i + c]!) * DIFF_GAIN);
    out[i + 3] = 255;
  }
  return out;
}

function toPng(pixels: Uint8Array): string {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_WIDTH;
  canvas.height = VIEW_HEIGHT;
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), VIEW_WIDTH, VIEW_HEIGHT), 0, 0);
  return canvas.toDataURL('image/png');
}

// ケース1つを 3 枚の PNG(2 経路と差分)にする。撮影の駆動(tools/render-lab-shot.mjs)が呼ぶ。
export async function shootCase(views: LabViews, name: CaseName): Promise<Shot> {
  const prepass = await views.prepass.capture(name);
  const forward = await views.forward.capture(name);
  return { prepass: toPng(prepass), forward: toPng(forward), diff: toPng(diffPixels(prepass, forward)) };
}
