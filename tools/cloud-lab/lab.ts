// 雲の実験環境のキャンバス。面が組んだ色を、値のまま出す(トーンマッピングも色空間変換も掛けない)。
// 撮影(PNG)もここが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { screenUV } from 'three/tsl';
import { R_EARTH } from '../../src/physics/solar-system';
import { EARTH_TEXTURES } from '../../src/render/celestial-textures';
import { ClimateMap } from '../../src/render/cloud/climate-map';
import { EquirectProjection } from '../../src/render/cloud/field-projection';
import { pixelsToPngDataUrl } from '../lab-png';
import { CloudLabPane } from './pane';
import { CLOUD_LAB_VIEWS, DEFAULT_CLOUD_LAB_VIEW, type CloudLabView, type CloudLabViewId } from './views';

// キャンバスと撮影の大きさ [px]。正距円筒なので 2:1。
export const VIEW_WIDTH = 1024;
export const VIEW_HEIGHT = 512;

export class CloudLabCanvas {
  private readonly pane: CloudLabPane;
  private readonly materials: ReadonlyMap<CloudLabViewId, THREE.MeshBasicNodeMaterial>;
  private readonly quad: QuadMesh;
  // 撮影先。表示値をそのまま RGBA8 で受ける。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
  });
  private view: CloudLabView = DEFAULT_CLOUD_LAB_VIEW;
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
    // 写しは表示と同じ大きさに取る — 読む側より細かく焼いた分は、読み出しの補間で均されて捨てられる。
    // この大きさだと気圧の差分の刻み(0.01 rad)が texel(2π/1024)の 1.6 倍、湿度のノイズの
    // 最上段(159 km)が 4 texel。
    this.pane = new CloudLabPane(new EquirectProjection(VIEW_HEIGHT), climate);
    // ビューごとに別のマテリアル。選ばれた 1 つだけがコンパイルされる。
    const materials = new Map<CloudLabViewId, THREE.MeshBasicNodeMaterial>();
    for (const view of CLOUD_LAB_VIEWS) {
      const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
      material.colorNode = this.pane.colorAt(view, screenUV);
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

  // いまの時刻を面へ入れ、選んだ量をキャンバスへ出す。
  public render(): void {
    this.pane.syncTime(this.seconds);
    this.pane.bake(this.renderer, this.view);
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
