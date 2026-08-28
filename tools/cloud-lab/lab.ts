// 雲の実験環境の 1 ビュー。天気のモデルが正距円筒へ写した 2 枚のうち選んだ量を、値のまま
// キャンバスへ出す(トーンマッピングも色空間変換も掛けない)。撮影(PNG)もここが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { length, screenUV, texture, vec3 } from 'three/tsl';
import { CloudFieldTextures } from '../../src/render/cloud/cloud-field-textures';
import { pixelsToPngDataUrl } from '../lab-png';
import type { Vec3Node } from '../../src/render/tsl-types';

// キャンバスと撮影の大きさ [px]。正距円筒なので 2:1。
export const VIEW_WIDTH = 1024;
export const VIEW_HEIGHT = 512;

// 表示できる量。並びがそのまま画面のボタンの並び。
export type CloudLabViewId = 'opticalDepth' | 'cloudTop' | 'temperature' | 'humidity' | 'wind';
export const CLOUD_LAB_VIEWS: readonly (readonly [CloudLabViewId, string])[] = [
  ['opticalDepth', '光学的厚み'],
  ['cloudTop', '雲頂'],
  ['temperature', '温度'],
  ['humidity', '湿度'],
  ['wind', '風'],
];

// 表示値 0..1 へ写すときの目盛り。光学的厚みは 0..8、温度は −40..40 °C、風は ±40 m/s を
// 0.5 中心の R(東)G(北)に、速さを B に。
const OPTICAL_DEPTH_SPAN = 8;
const TEMPERATURE_MIN = -40;
const TEMPERATURE_SPAN = 80;
const WIND_SPAN = 40;

// 表示の種類ごとに、写しの 2 枚から表示値を組む。
function displayColor(id: CloudLabViewId, field: THREE.Texture, weather: THREE.Texture): Vec3Node {
  const f = texture(field, screenUV);
  const w = texture(weather, screenUV);
  // 量ごとの写像。選ばれた 1 つだけを組む。
  const colors: Record<CloudLabViewId, () => Vec3Node> = {
    opticalDepth: () => vec3(f.r.div(OPTICAL_DEPTH_SPAN)),
    cloudTop: () => vec3(f.g),
    temperature: () => vec3(w.r.sub(TEMPERATURE_MIN).div(TEMPERATURE_SPAN)),
    humidity: () => vec3(w.g),
    wind: () => vec3(
      w.b.div(2 * WIND_SPAN).add(0.5), w.a.div(2 * WIND_SPAN).add(0.5), length(w.ba).div(WIND_SPAN),
    ),
  };
  return colors[id]();
}

export class CloudLabView {
  private readonly fields = new CloudFieldTextures();
  private readonly materials: ReadonlyMap<CloudLabViewId, THREE.MeshBasicNodeMaterial>;
  private readonly quad: QuadMesh;
  // 撮影先。表示値をそのまま RGBA8 で受ける。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
  });
  private viewId: CloudLabViewId = 'opticalDepth';
  private seconds = 0;

  // レンダラを起こしてから器を組む。
  public static async create(canvas: HTMLCanvasElement): Promise<CloudLabView> {
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT, false);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    await renderer.init();
    return new CloudLabView(renderer);
  }

  // 表示の種類ごとのマテリアルを一度だけ組む。
  private constructor(private readonly renderer: WebGPURenderer) {
    const materials = new Map<CloudLabViewId, THREE.MeshBasicNodeMaterial>();
    for (const [id] of CLOUD_LAB_VIEWS) {
      const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
      material.colorNode = displayColor(id, this.fields.fieldTexture, this.fields.weatherTexture);
      materials.set(id, material);
    }
    this.materials = materials;
    this.quad = new QuadMesh(materials.get(this.viewId)!);
  }

  public get currentView(): CloudLabViewId { return this.viewId; }
  public get hours(): number { return this.seconds / 3600; }

  // 表示する量を切り替えて描き直す。
  public show(id: CloudLabViewId): void {
    this.viewId = id;
    this.quad.material = this.materials.get(id)!;
    this.render();
  }

  // 時刻 [h] を変えて描き直す。
  public setTime(hours: number): void {
    this.seconds = hours * 3600;
    this.render();
  }

  // いまの時刻の写しを作り直し、選んだ量をキャンバスへ出す。
  public render(): void {
    this.fields.render(this.renderer, this.seconds);
    this.quad.render(this.renderer);
  }

  // いま画面に出ているものを PNG のデータ URL で返す。
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
