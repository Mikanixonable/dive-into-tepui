// 同じケースをライトプリパスとフォワードの 2 経路で描く。違いは「メッシュとライトがどの
// チャンネルに居るか」だけで、HDR ターゲット・露出・合成・色空間変換はどちらも同じ
// RenderPipeline を通る。だから画面に出る差はシェーディング経路の差そのものになる。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { GpuTimings } from '../../src/gpu-timings';
import { RenderPipeline } from '../../src/render/pipeline/render-pipeline';
import { LIT_OPAQUE_LAYER } from '../../src/render/pipeline/lit-layer';
import { reversedOpaqueSort, reversedTransparentSort } from '../../src/render/pipeline/reversed-sort';
import { QUALITY_PRESETS } from '../../src/render/graphics-settings';
import { AMBIENT_INTENSITY, COLOR_SUN, SUN_INTENSITY } from '../../src/game/const';
import { AU } from '../../src/physics/planet-orbit';
import { R_SUN } from '../../src/physics/solar-system';
import { CASES, type CaseName, type LabCase, SUN_DIR, VIEW_HEIGHT, VIEW_WIDTH } from './cases';

export type LabPath = 'prepass' | 'forward';

const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const SUN_COLOR = new THREE.Color(COLOR_SUN);
// 環境光の色味は恒星の色とは独立した固定値(EnvironmentScene と同じ)。
const AMBIENT_COLOR = 0x8899bb;
// 恒星は 1 天文単位の位置に置く。ゲーム本体と同じく SUN_INTENSITY はそこでの放射照度なので、
// 点光源へ渡す放射強度は逆二乗ぶんを戻した値になる。
const SUN_POSITION = SUN_DIR.clone().multiplyScalar(AU);
const SUN_RADIANT_INTENSITY = SUN_INTENSITY * AU * AU;

export class LabView {
  private readonly scene = new THREE.Scene();
  // 撮影先。合成パスが既に sRGB へ変換した値を書くので、素の RGBA8 で受ける
  // (-srgb フォーマットにすると二重変換になり、撮った PNG だけが白っぽくなる)。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
  });
  private current: LabCase | null = null;

  private constructor(
    private readonly path: LabPath,
    private readonly renderer: WebGPURenderer,
    private readonly pipeline: RenderPipeline,
  ) {
    // RenderPipeline はカメラのチャンネルを一時的に絞る。シーンルートが既定の 0 だけだと
    // その時点で子要素の走査が止まるため、コンテナとして全チャンネルを受ける。
    this.scene.layers.enableAll();
    const sun = new THREE.DirectionalLight(SUN_COLOR.getHex(), SUN_INTENSITY);
    sun.position.copy(SUN_DIR).multiplyScalar(1e5);
    const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
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
    const pipeline = new RenderPipeline(renderer, QUALITY_PRESETS.high, new GpuTimings(renderer));
    return new LabView(path, renderer, pipeline);
  }

  // ケースを組み直して描く。前のケースはシーンから外すだけで解放しない — 球の単位ジオメトリは
  // LOD 段ごとに全利用元で共有されていて、ここで捨てると次のケースが壊れる。
  show(name: CaseName): void {
    if (this.current !== null) this.scene.remove(...this.current.objects);
    const built = CASES[name]();
    for (const object of built.objects) {
      // フォワード経路では buildPlayerShip() が内部で付けた LIT_OPAQUE_LAYER を打ち消す。
      // 呼ばないのではなく、呼ばれたあとに戻す。
      if (this.path === 'forward') object.traverse((o) => o.layers.set(0));
    }
    this.scene.add(...built.objects);
    this.current = built;
    this.render();
  }

  // 動くものが無いので、描くのはケースを差し替えたときと撮影のときだけ。
  render(): void {
    if (this.current === null) return;
    this.pipeline.sunLight.set(SUN_POSITION, R_SUN, SUN_COLOR, SUN_RADIANT_INTENSITY, AMBIENT_INTENSITY);
    this.pipeline.occlusion.setOccluders(this.current.occluders ?? []);
    const rings = this.current.rings;
    this.pipeline.occlusion.setRings(rings?.center ?? ORIGIN, rings?.axis ?? UP, rings?.bands ?? []);
    this.pipeline.render(this.scene, this.current.camera);
  }

  // キャンバスへ出るのと同じ絵を画素で受け取る。合成パスが「キャンバスへ」と書いた出力先が
  // 撮影ターゲットへ差し替わるだけなので、トーンマッピングも sRGB 変換も同じに掛かる —
  // WebGPU キャンバスの提示・合成・スクリーンショットはどこも通らない。
  async capture(name: CaseName): Promise<Uint8Array> {
    this.show(name);
    this.renderer.setOutputRenderTarget(this.captureTarget);
    try {
      this.render();
    } finally {
      // 戻し忘れると以後キャンバスに何も出なくなる(撮影だけは通るので気付きにくい)。
      this.renderer.setOutputRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    return new Uint8Array(pixels.buffer);
  }
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
