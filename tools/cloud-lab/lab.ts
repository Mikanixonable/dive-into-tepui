// 雲の実験環境のキャンバス。本体と同じ工場で組んだ地球の生成雲場を、投影法の違う 2 面に並べ、面が
// 組んだ色を値のまま出す(トーンマッピングも色空間変換も掛けない)。撮影(PNG)もここが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { Fn, If, screenUV, vec2, vec3 } from 'three/tsl';
import { earthGeneratedCloudField } from '../../src/game/celestial/solar-system/earth-system';
import { DeferredTexture } from '../../src/render/deferred-texture';
import { EquirectProjection, OrthographicCap } from '../../src/render/field-projection';
import { pixelsToPngDataUrl } from '../lab-png';
import { CloudLabPane } from './pane';
import { awaitClimateMap, loadCloudFieldImage, loadCloudsPhoto } from './probe-common';
import { CLOUD_LAB_VIEWS, DEFAULT_CLOUD_LAB_VIEW, type CloudLabView, type CloudLabViewId } from './views';
import { SECONDS_PER_HOUR } from './time-units';
import type { Vec3Node } from '../../src/render/tsl-types';

// 面の大きさ [px]。全球の面は正距円筒なので 2:1、cap の面は正方形。cap の写しは表示と同じ大きさに
// 取る — 読む側より細かく焼いた分は、読み出しの補間で均されてそのまま捨てられる。
const VIEW_HEIGHT = 512;
const GLOBE_WIDTH = VIEW_HEIGHT * 2;
const CAP_SIZE = VIEW_HEIGHT;

// キャンバスと撮影の大きさ [px]。2 面を横に並べた合計。
const VIEW_WIDTH = GLOBE_WIDTH + CAP_SIZE;

// 全球の面と cap の面の境目(キャンバスの幅に対する比)。
const SPLIT_U = GLOBE_WIDTH / VIEW_WIDTH;

// cap の既定 [°]。時刻 0 の熱帯低気圧の最盛期の位置(19°N・136°E)を中心に、LEO(高度 400 km)の
// 地平線 19.8° に近い半径で開く。
const DEFAULT_CAP_LATITUDE = 19;
const DEFAULT_CAP_LONGITUDE = 136;
const DEFAULT_CAP_RADIUS = 20;

export class CloudLabCanvas {
  // 左が本体と同じ全球の写し、右が正射影の cap。並びが画面の左右と一致する。
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

  // レンダラを起こし、実写の雲と気候の画像を読み終えてから器を返す — 撮影は画像の到着を待たずに
  // 走るので、ここで待たないと最初の何枚かが空のテクスチャで焼かれる。
  // captureOnly は撮影専用(画面へ提示しない)。指定の理由は render() 側に書く。
  public static async create(canvas: HTMLCanvasElement, captureOnly = false): Promise<CloudLabCanvas> {
    const renderer = new WebGPURenderer({ canvas, requiredLimits: { maxSampledTexturesPerShaderStage: 32 } });
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT, false);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    await renderer.init();
    // 気候テクスチャと同じ向き(v = 0 が北極)・同じ生の値。表示は 8k を 1024×512 へ潰すので
    // ミップ付きで読む(切るとエイリアスがそのまま出る)。
    const photo = await loadCloudsPhoto(true);
    const observedField = await loadCloudFieldImage();
    const lab = new CloudLabCanvas(renderer, photo, observedField, captureOnly);
    await awaitClimateMap(renderer, lab.panes.map((pane) => pane.climate), 'cloud lab');
    return lab;
  }

  // 2 面と、起動時に出す量のマテリアルを組む。
  private constructor(
    private readonly renderer: WebGPURenderer,
    photo: THREE.Texture,
    observedField: THREE.Texture,
    private readonly captureOnly: boolean,
  ) {
    this.capProjection = new OrthographicCap(
      CAP_SIZE, THREE.MathUtils.degToRad(this.capLatitude), THREE.MathUtils.degToRad(this.capLongitude),
      THREE.MathUtils.degToRad(this.capRadius));
    this.panes = [
      new CloudLabPane(earthGeneratedCloudField(new EquirectProjection(VIEW_HEIGHT)), photo, observedField),
      new CloudLabPane(earthGeneratedCloudField(this.capProjection), photo, observedField),
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
  public get hours(): number { return this.seconds / SECONDS_PER_HOUR; }
  public get capCenterLatitude(): number { return this.capLatitude; }
  public get capCenterLongitude(): number { return this.capLongitude; }
  public get capAngularRadius(): number { return this.capRadius; }

  // 表示する量を置く。描き直すのは render()。
  public show(id: CloudLabViewId): void {
    this.view = CLOUD_LAB_VIEWS.find((view) => view.id === id)!;
    this.quad.material = this.materialFor(this.view);
  }

  // 時刻 [h] を置く。描き直すのは render()。
  public setTime(hours: number): void {
    this.seconds = hours * SECONDS_PER_HOUR;
  }

  // モデルの調整値を変えたあとに呼ぶ。両面を次の render() で焼き直す。
  public invalidate(): void {
    for (const pane of this.panes) pane.invalidate();
  }

  // cap の中心の緯度・経度と半径 [°] を置く。描き直すのは render()。
  public aimCap(latitude: number, longitude: number, radius: number): void {
    this.capLatitude = latitude;
    this.capLongitude = longitude;
    this.capRadius = radius;
    this.capProjection.aim(
      THREE.MathUtils.degToRad(latitude), THREE.MathUtils.degToRad(longitude), THREE.MathUtils.degToRad(radius));
  }

  // いまの時刻の場を両面で焼き、選んだ量をキャンバスへ出す。
  public render(): void {
    DeferredTexture.publishOne(this.renderer);
    for (const pane of this.panes) pane.bake(this.renderer, this.seconds);
    // 撮影専用ではキャンバスへ出さない。GPU の無い環境(ソフトウェア WebGPU)では、キャンバスへの
    // 提示が共有イメージを作れずに device を落とし、撮影の読み出し(mapAsync)まで道連れにする。
    // 撮影は captureTarget への描画だけを使うので、提示を止めても撮れる絵は変わらない。
    if (this.captureOnly && this.renderer.getOutputRenderTarget() === null) return;
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
      // キャンバスの uv を、その画素が属する面の uv(0..1)へ直して色を組む。
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
