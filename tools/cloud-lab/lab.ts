// 雲の実験環境の 1 ビュー。天気のモデル・気候の事前分布・雲の場の写しから選んだ量を、値のまま
// キャンバスへ出す(トーンマッピングも色空間変換も掛けない)。撮影(PNG)もここが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { R_EARTH } from '../../src/physics/solar-system';
import { EARTH_TEXTURES } from '../../src/render/celestial-textures';
import { ClimateMap } from '../../src/render/cloud/climate-map';
import { CloudFieldTextures } from '../../src/render/cloud/cloud-field-textures';
import { WeatherModel } from '../../src/render/cloud/weather-model';
import { pixelsToPngDataUrl } from '../lab-png';
import { CLOUD_LAB_VIEWS, type CloudLabViewId } from './views';

// キャンバスと撮影の大きさ [px]。正距円筒なので 2:1。
export const VIEW_WIDTH = 1024;
export const VIEW_HEIGHT = 512;

export class CloudLabView {
  private readonly fields: CloudFieldTextures;
  private readonly materials: ReadonlyMap<CloudLabViewId, THREE.MeshBasicNodeMaterial>;
  private readonly quad: QuadMesh;
  // 撮影先。表示値をそのまま RGBA8 で受ける。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
  });
  private viewId: CloudLabViewId = 'opticalDepth';
  private seconds = 0;

  // レンダラを起こし、地球の気候を読み終えてから器を組む。
  public static async create(canvas: HTMLCanvasElement): Promise<CloudLabView> {
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT, false);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    await renderer.init();
    const climate = await ClimateMap.load(EARTH_TEXTURES.climateUrl, R_EARTH);
    return new CloudLabView(renderer, climate);
  }

  // 表示の種類ごとのマテリアルを一度だけ組む。
  private constructor(private readonly renderer: WebGPURenderer, climate: ClimateMap) {
    const model = new WeatherModel(climate);
    this.fields = new CloudFieldTextures(model);
    const materials = new Map<CloudLabViewId, THREE.MeshBasicNodeMaterial>();
    for (const view of CLOUD_LAB_VIEWS) {
      const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
      material.colorNode = view.color(model, climate, this.fields);
      materials.set(view.id, material);
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
