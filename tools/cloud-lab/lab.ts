// 雲の実験環境のキャンバス。天気のモデル・気候の事前分布・雲の場の写しから選んだ量を、値のまま
// 出す(トーンマッピングも色空間変換も掛けない)。撮影(PNG)もここが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { R_EARTH } from '../../src/physics/solar-system';
import { EARTH_TEXTURES } from '../../src/render/celestial-textures';
import { ClimateMap } from '../../src/render/cloud/climate-map';
import { CloudFieldTextures } from '../../src/render/cloud/cloud-field-textures';
import { WeatherModel } from '../../src/render/cloud/weather-model';
import { pixelsToPngDataUrl } from '../lab-png';
import { CLOUD_LAB_VIEWS, type CloudLabView, type CloudLabViewId } from './views';

// キャンバスと撮影の大きさ [px]。正距円筒なので 2:1。
export const VIEW_WIDTH = 1024;
export const VIEW_HEIGHT = 512;

export class CloudLabCanvas {
  private readonly model: WeatherModel;
  private readonly fields: CloudFieldTextures;
  private readonly materials: ReadonlyMap<CloudLabViewId, THREE.MeshBasicNodeMaterial>;
  private readonly quad: QuadMesh;
  // 撮影先。表示値をそのまま RGBA8 で受ける。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
  });
  private view: CloudLabView = CLOUD_LAB_VIEWS[0]!;
  private seconds = 0;

  // レンダラを起こし、地球の気候を読み終えてから器を組む。
  public static async create(canvas: HTMLCanvasElement): Promise<CloudLabCanvas> {
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT, false);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    await renderer.init();
    const climate = await ClimateMap.load(EARTH_TEXTURES.climateUrl, R_EARTH);
    return new CloudLabCanvas(renderer, climate);
  }

  // 表示の種類ごとのマテリアルを一度だけ組む。
  private constructor(private readonly renderer: WebGPURenderer, climate: ClimateMap) {
    this.model = new WeatherModel(climate);
    this.fields = new CloudFieldTextures(this.model);
    // ビューごとに別のマテリアル。選ばれた 1 つだけがコンパイルされる。
    const materials = new Map<CloudLabViewId, THREE.MeshBasicNodeMaterial>();
    for (const view of CLOUD_LAB_VIEWS) {
      const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
      material.colorNode = view.color(this.model, climate, this.fields);
      materials.set(view.id, material);
    }
    this.materials = materials;
    this.quad = new QuadMesh(materials.get(this.view.id)!);
  }

  public get currentView(): CloudLabViewId { return this.view.id; }
  public get hours(): number { return this.seconds / 3600; }

  // 表示する量を切り替えて描き直す。
  public show(id: CloudLabViewId): void {
    this.view = CLOUD_LAB_VIEWS.find((view) => view.id === id)!;
    this.quad.material = this.materials.get(id)!;
    this.render();
  }

  // 時刻 [h] を変えて描き直す。
  public setTime(hours: number): void {
    this.seconds = hours * 3600;
    this.render();
  }

  // いまの時刻をモデルへ入れ、選んだ量をキャンバスへ出す。雲の場の写しは、それを読むビューの
  // ときだけ焼く(気圧の写しはどのビューも読むので必ず焼く)。
  public render(): void {
    this.model.syncTime(this.seconds);
    this.model.bake(this.renderer);
    if (this.view.readsFields) this.fields.render(this.renderer);
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
