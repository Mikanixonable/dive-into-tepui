// 雲の実験環境のキャンバス。投影法の違う 2 面を横に並べ、面が組んだ色を値のまま出す
// (トーンマッピングも色空間変換も掛けない)。撮影(PNG)もここが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { Fn, If, screenUV, vec2, vec3 } from 'three/tsl';
// 地球の気候の事前分布。tools/export-climate.mjs が焼く。
import climateTextureUrl from '../../src/assets/earth-climate.png';
import { ClimateMap } from '../../src/render/cloud/climate-map';
import { EquirectProjection, OrthographicCap } from '../../src/render/cloud/field-projection';
import { pixelsToPngDataUrl } from '../lab-png';
import { CloudLabPane } from './pane';
import { CLOUD_LAB_VIEWS, DEFAULT_CLOUD_LAB_VIEW, type CloudLabView, type CloudLabViewId } from './views';
import type { Vec3Node } from '../../src/render/tsl-types';

// 面の大きさ [px]。全球の面は正距円筒なので 2:1、cap の面は正方形。写しは表示と同じ大きさに取る
// — 読む側より細かく焼いた分は、読み出しの補間で均されてそのまま捨てられる。
const VIEW_HEIGHT = 512;
const GLOBE_WIDTH = VIEW_HEIGHT * 2;
const CAP_SIZE = VIEW_HEIGHT;

// キャンバスと撮影の大きさ [px]。2 面を横に並べた合計。
const VIEW_WIDTH = GLOBE_WIDTH + CAP_SIZE;

// 全球の面と cap の面の境目(キャンバスの幅に対する比)。
const SPLIT_U = GLOBE_WIDTH / VIEW_WIDTH;

// cap の既定 [°]。台風の初期位置(15°N・140°E)を中心に、LEO(高度 400 km)の地平線 19.8° に
// 近い半径で開く。
const DEFAULT_CAP_LATITUDE = 15;
const DEFAULT_CAP_LONGITUDE = 140;
const DEFAULT_CAP_RADIUS = 20;

export class CloudLabCanvas {
  // 左が全球の正距円筒、右が正射影の cap。並びが画面の左右と一致する。
  private readonly panes: readonly [CloudLabPane, CloudLabPane];
  private readonly capProjection: OrthographicCap;
  // 一度出した量のマテリアル。グラフを組むだけで天気の式が丸ごと展開されるので、出すまで組まない。
  private readonly materials = new Map<CloudLabViewId, THREE.MeshBasicNodeMaterial>();
  private readonly quad: QuadMesh;
  // 撮影先。表示値をそのまま RGBA8 で受ける。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
  });
  private view: CloudLabView = DEFAULT_CLOUD_LAB_VIEW;
  private seconds = 0;
  private capLatitude = DEFAULT_CAP_LATITUDE;
  private capLongitude = DEFAULT_CAP_LONGITUDE;
  private capRadius = DEFAULT_CAP_RADIUS;

  // レンダラを起こし、地球の気候を読み終えてから器を組む。
  public static async create(canvas: HTMLCanvasElement): Promise<CloudLabCanvas> {
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT, false);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    await renderer.init();
    const climate = await ClimateMap.load(climateTextureUrl);
    return new CloudLabCanvas(renderer, climate);
  }

  // 2 面と、起動時に出す量のマテリアルを組む。
  private constructor(private readonly renderer: WebGPURenderer, climate: ClimateMap) {
    this.capProjection = new OrthographicCap(
      CAP_SIZE, THREE.MathUtils.degToRad(this.capLatitude), THREE.MathUtils.degToRad(this.capLongitude),
      THREE.MathUtils.degToRad(this.capRadius));
    this.panes = [
      new CloudLabPane(new EquirectProjection(VIEW_HEIGHT), climate),
      new CloudLabPane(this.capProjection, climate),
    ];
    this.quad = new QuadMesh(this.materialFor(this.view));
  }

  // 量 view のマテリアル。無ければ組んで覚える。
  private materialFor(view: CloudLabView): THREE.MeshBasicNodeMaterial {
    const known = this.materials.get(view.id);
    if (known) return known;
    const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    material.colorNode = this.colorNode(view);
    this.materials.set(view.id, material);
    return material;
  }

  public get currentView(): CloudLabViewId { return this.view.id; }
  public get hours(): number { return this.seconds / 3600; }
  public get capCenterLatitude(): number { return this.capLatitude; }
  public get capCenterLongitude(): number { return this.capLongitude; }
  public get capAngularRadius(): number { return this.capRadius; }

  // 表示する量を切り替えて描き直す。
  public show(id: CloudLabViewId): void {
    this.view = CLOUD_LAB_VIEWS.find((view) => view.id === id)!;
    this.quad.material = this.materialFor(this.view);
    this.render();
  }

  // 時刻 [h] を変えて描き直す。
  public setTime(hours: number): void {
    this.seconds = hours * 3600;
    this.render();
  }

  // cap の中心の緯度・経度と半径 [°] を置き直して描き直す。
  public aimCap(latitude: number, longitude: number, radius: number): void {
    this.capLatitude = latitude;
    this.capLongitude = longitude;
    this.capRadius = radius;
    this.capProjection.aim(
      THREE.MathUtils.degToRad(latitude), THREE.MathUtils.degToRad(longitude), THREE.MathUtils.degToRad(radius));
    this.render();
  }

  // いまの時刻を両面へ入れ、選んだ量をキャンバスへ出す。
  public render(): void {
    for (const pane of this.panes) {
      pane.syncTime(this.seconds);
      pane.bake(this.renderer, this.view);
    }
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

  // 画面の左右で面を切り替える色。**分岐は select ではなく If で書く** — select は両辺を評価する
  // ので、ノイズを直に評価するビューで捨てる側の面ぶんが毎画素走る。
  private colorNode(view: CloudLabView): Vec3Node {
    const [globe, cap] = this.panes;
    return Fn(() => {
      const color = vec3(0).toVar();
      If(screenUV.x.lessThan(SPLIT_U), () => {
        color.assign(globe.colorAt(view, vec2(screenUV.x.div(SPLIT_U), screenUV.y)));
      }).Else(() => {
        color.assign(cap.colorAt(view, vec2(screenUV.x.sub(SPLIT_U).div(1 - SPLIT_U), screenUV.y)));
      });
      return color;
    })();
  }
}
