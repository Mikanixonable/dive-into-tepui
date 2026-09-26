// 雲の実験環境のキャンバス。製品と同じ組立ての全球雲場(MeteorologicalCloudField +
// ConvectiveCloudGlobalFieldSupply)を1つ持ち、投影法の違う 2 面に並べ、面が組んだ色を
// 値のまま出す(トーンマッピングも色空間変換も掛けない)。撮影(PNG)もここが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { Fn, If, screenUV, vec2, vec3 } from 'three/tsl';
// 実写の雲(ゲーム本体が地表へ貼っているもの)。「実写」ビューが比較のためだけに読む。
import cloudsPhotoUrl from '../../src/assets/8k_clouds.jpg';
import { DeferredTexture } from '../../src/render/deferred-texture';
import { EquirectProjection, OrthographicCap } from '../../src/render/field-projection';
import { pixelsToPngDataUrl } from '../lab-png';
import { CloudLabGlobalField } from './global-field';
import { CloudLabPane } from './pane';
import { CLOUD_LAB_VIEWS, DEFAULT_CLOUD_LAB_VIEW, type CloudLabView, type CloudLabViewId } from './views';
import {
  METEOROLOGICAL_CASES, METEOROLOGICAL_CASE_IDS, type MeteorologicalCaseFixture, type MeteorologicalCaseId,
} from './meteorological-cases';
import type { Vec3Node } from '../../src/render/tsl-types';

// 面の大きさ [px]。全球の面は正距円筒なので 2:1、cap の面は正方形。全球の写しは
// 表示と同じ大きさに焼く — 読む側より細かく焼いた分は、読み出しの補間で均されてそのまま
// 捨てられる。
const VIEW_HEIGHT = 512;
const GLOBE_WIDTH = VIEW_HEIGHT * 2;
const CAP_SIZE = VIEW_HEIGHT;

// キャンバスと撮影の大きさ [px]。2 面を横に並べた合計。
const VIEW_WIDTH = GLOBE_WIDTH + CAP_SIZE;

// 全球の面と cap の面の境目(キャンバスの幅に対する比)。
const SPLIT_U = GLOBE_WIDTH / VIEW_WIDTH;

// 気候画像が届くのを待つ上限 [フレーム]。越えたら画像が取れていないので、器を組まずに投げる。
const CLIMATE_WAIT_FRAMES = 600;

// cap の既定 [°]。時刻 0 の熱帯低気圧の最盛期の位置(19°N・136°E)を中心に、LEO(高度 400 km)の
// 地平線 19.8° に近い半径で開く。
const DEFAULT_CAP_LATITUDE = 19;
const DEFAULT_CAP_LONGITUDE = 136;
const DEFAULT_CAP_RADIUS = 20;

// 撮影が場と診断場の焼き込みを待つ上限 [ms]。全球場の供給ジョブは実測で数秒なので、
// その数倍を越えたら諦めて現在の場で撮る — 撮影そのものは落とさない。
const CAPTURE_SETTLE_TIMEOUT_MS = 120_000;

export class CloudLabCanvas {
  // 左が全球の写し、右が正射影の cap。並びが画面の左右と一致する。
  private readonly panes: readonly [CloudLabPane, CloudLabPane];
  private readonly capProjection: OrthographicCap;
  // 両面が共有する全球の生成雲場と CPU 診断場。供給ジョブは分割導出なので、render が
  // 呼ばれるたびに少しずつ進め、届くまでは前回の場を使い続ける。
  private readonly shared: CloudLabGlobalField;
  // 一度出した量のマテリアル。グラフを組むだけで場の読み取りが丸ごと展開されるので、
  // 出すまで組まない。
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
  private selectedFixtureId: MeteorologicalCaseId = METEOROLOGICAL_CASE_IDS[0]!;
  // 場が届くまで駆動を回し続ける RAF が予約済みか。二重に回さないための旗。
  private driveScheduled = false;

  // レンダラを起こし、実写の雲と気候の画像を読み終えてから器を返す — 撮影は画像の到着を待たずに
  // 走るので、ここで待たないと最初の何枚かが空のテクスチャで焼かれる。
  public static async create(canvas: HTMLCanvasElement): Promise<CloudLabCanvas> {
    const renderer = new WebGPURenderer({ canvas });
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT, false);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    await renderer.init();
    const photo = await new THREE.TextureLoader().loadAsync(cloudsPhotoUrl);
    // 気候テクスチャと同じ向き(v = 0 が北極)・同じ生の値。表示は 8k を 1024×512 へ潰すので、
    // ミップを切るとエイリアスがそのまま出る — ここだけはミップ付きで読む。
    photo.wrapS = THREE.RepeatWrapping;
    photo.wrapT = THREE.ClampToEdgeWrapping;
    photo.flipY = false;
    photo.generateMipmaps = true;
    photo.minFilter = THREE.LinearMipmapLinearFilter;
    photo.magFilter = THREE.LinearFilter;
    photo.colorSpace = THREE.NoColorSpace;
    const lab = new CloudLabCanvas(renderer, photo);
    await lab.awaitClimate();
    return lab;
  }

  // 気候画像の取得を始め、GPU へ載るまで待つ。投入は本体と同じ待ち行列を通すので、
  // 1 フレームに 1 枚ずつ進める。
  private async awaitClimate(): Promise<void> {
    this.shared.climate.request();
    for (let frame = 0; frame < CLIMATE_WAIT_FRAMES; frame += 1) {
      if (this.shared.climate.generation > 0) return;
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
      DeferredTexture.publishOne(this.renderer);
    }
    throw new Error('cloud lab: 気候画像が届かない');
  }

  // 2 面と、起動時に出す量のマテリアルを組む。
  private constructor(private readonly renderer: WebGPURenderer, photo: THREE.Texture) {
    this.capProjection = new OrthographicCap(
      CAP_SIZE, THREE.MathUtils.degToRad(this.capLatitude), THREE.MathUtils.degToRad(this.capLongitude),
      THREE.MathUtils.degToRad(this.capRadius));
    // 生成雲は全球を正距円筒で持つ — 全球の面はその写しをそのまま出し、cap の面は
    // 同じ写しを方向から引く。供給ジョブは両面で1つだけ走る。
    const globeProjection = new EquirectProjection(VIEW_HEIGHT);
    this.shared = new CloudLabGlobalField(globeProjection);
    this.panes = [
      new CloudLabPane(globeProjection, photo, this.shared),
      new CloudLabPane(this.capProjection, photo, this.shared),
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
  public get fixture(): MeteorologicalCaseFixture { return METEOROLOGICAL_CASES[this.selectedFixtureId]; }
  public get fixtureId(): MeteorologicalCaseId { return this.selectedFixtureId; }
  // 生成雲場の世代。供給ジョブが届いて焼き直されるたびに進む — 暖機の完了を見る撮影駆動が読む。
  public get cloudGeneration(): number { return this.shared.generation; }
  // いまの時刻の場と診断場が焼き終わっているか。撮影駆動が待ち合わせに使う。
  public get cloudSettled(): boolean { return this.shared.settledFor(this.seconds); }

  // 表示する制御実験の入力・計測契約を選ぶ。
  public selectFixture(id: MeteorologicalCaseId): void {
    if (!METEOROLOGICAL_CASES[id]) throw new Error(`cloud lab: unknown meteorological fixture "${id}"`);
    this.selectedFixtureId = id;
  }

  // 表示する量を切り替えて描き直す。
  public show(id: CloudLabViewId): void {
    this.view = CLOUD_LAB_VIEWS.find((view) => view.id === id)!;
    this.quad.material = this.materialFor(this.view);
    this.render();
  }

  // 時刻 [h] を変えて描き直す。場の導出が走るあいだは、届いたところまでが画面へ出る。
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

  // 場と診断場を1回ぶん進めて面へ出す。まだ届いていなければ、届くまで RAF で駆動を続ける。
  public render(): void {
    DeferredTexture.publishOne(this.renderer);
    const settled = this.shared.drive(this.renderer, this.seconds);
    this.quad.render(this.renderer);
    if (settled) return;
    if (this.driveScheduled) return;
    this.driveScheduled = true;
    requestAnimationFrame(() => {
      this.driveScheduled = false;
      this.render();
    });
  }

  // いまの時刻の場と診断場が焼き終わるまで駆動を回し、画面に出ているものを PNG の
  // データ URL で返す。
  public async capture(): Promise<string> {
    const deadline = performance.now() + CAPTURE_SETTLE_TIMEOUT_MS;
    while (!this.shared.drive(this.renderer, this.seconds)) {
      if (performance.now() >= deadline) break;
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
      DeferredTexture.publishOne(this.renderer);
    }
    this.renderer.setOutputRenderTarget(this.captureTarget);
    try {
      this.quad.render(this.renderer);
    } finally {
      // 戻し忘れると以後キャンバスに何も出なくなる(撮影だけは通るので気付きにくい)。
      this.renderer.setOutputRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    return pixelsToPngDataUrl(new Uint8Array(pixels.buffer), VIEW_WIDTH, VIEW_HEIGHT);
  }

  // 画面の左右で面を切り替える色。**分岐は select ではなく If で書く** — select は両辺を評価する
  // ので、捨てる側の面ぶんが毎画素走る。
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
