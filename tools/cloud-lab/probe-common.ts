// 読み出し器(weather-probe・motion・translucent・天気図)と表示器(cloud-lab 本体)が共有する足場。
// 気候画像の待ち方・実写の読み込み・Float32 の写しの組み方と読み戻し・箱の面への焼き・
// base64・雲を運ぶ風の写しをここへ集める。
import * as THREE from 'three/webgpu';
import { QuadMesh } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { clamp, cos, mix, mrt, screenUV, sin, texture, uniform, vec3, vec4 } from 'three/tsl';
// 実写の雲(ゲーム本体が地表へ貼っているもの)。器が比較・分離の入力として読む。
import cloudsPhotoUrl from '../../src/assets/8k_clouds.jpg';
import { DeferredTexture } from '../../src/render/deferred-texture';
import {
  blendBakedTexels, bindCloudBlend, cloudMotionFromTexel,
} from '../../src/render/cloud/cloud-field-sample';
import type { ClimateMap } from '../../src/render/cloud/climate-map';
import type { GeneratedCloudField } from '../../src/render/cloud/generated-cloud-field';
import type { FloatNode, FloatUniform, Vec3Node, Vec4Node, Vec4Uniform } from '../../src/render/tsl-types';

// 気候画像が届くのを待つ上限 [フレーム]。越えたら画像が取れていないので、器を組まずに投げる。
const CLIMATE_WAIT_FRAMES = 600;

// 雲を運ぶ風の表示値が張る速さ [m/s]。実写側のブロック計測の上限(80)より外へ余裕を取る。
// 読み戻す側の道具(tools/cloud-*.mjs)は同じ値をそれぞれに持つ。
export const WIND_SPAN_MS = 96;

// 気候画像の取得を始め、GPU へ載るまで待つ。投入は本体と同じ待ち行列を通すので、
// 1 フレームに 1 枚ずつ進める。label は待ち切れなかったときの失敗文へ入れる器の名前。
export async function awaitClimateMap(
  renderer: WebGPURenderer, climateMaps: readonly ClimateMap[], label: string,
): Promise<void> {
  for (const map of climateMaps) map.request();
  for (let frame = 0; frame < CLIMATE_WAIT_FRAMES; frame += 1) {
    if (climateMaps.every((map) => map.generation > 0)) return;
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    DeferredTexture.publishOne(renderer);
  }
  throw new Error(`${label}: 気候画像が届かない`);
}

// 実写の雲テクスチャ。気候テクスチャと同じ向き(v = 0 が北極)・同じ生の値。
// mipmapped にすると潰した面でもエイリアスが出ない — 小さく焼いて出す面だけ要る。
export async function loadCloudsPhoto(mipmapped: boolean): Promise<THREE.Texture> {
  const photo = await new THREE.TextureLoader().loadAsync(cloudsPhotoUrl);
  photo.wrapS = THREE.RepeatWrapping;
  photo.wrapT = THREE.ClampToEdgeWrapping;
  photo.flipY = false;
  photo.generateMipmaps = mipmapped;
  photo.minFilter = mipmapped ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  photo.magFilter = THREE.LinearFilter;
  photo.colorSpace = THREE.NoColorSpace;
  return photo;
}

// 生の画素列を base64 へ(チャンクで割って fromCharCode の引数の上限を避ける)。
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// quad を target へ描き、RGBA8 の生画素を base64 で返す(行は北から南へ、列は西から東へ並ぶ)。
export async function renderTargetBase64(
  renderer: WebGPURenderer, quad: QuadMesh, target: THREE.RenderTarget, sizePx: number,
): Promise<string> {
  renderer.setRenderTarget(target);
  quad.render(renderer);
  renderer.setRenderTarget(null);
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, sizePx, sizePx);
  return bytesToBase64(new Uint8Array(pixels.buffer));
}

// 箱の四辺(西・南・東・北 [rad])を持つ uniform から、その箱の画素が張る単位方向。
// v は北から南へ増える。motion と translucent が同じ置き方で箱を焼く。
export function boxDirectionNode(boxBounds: Vec4Uniform): Vec3Node {
  const longitude = mix(boxBounds.x, boxBounds.z, screenUV.x);
  const latitude = mix(boxBounds.w, boxBounds.y, screenUV.y);
  const flat = cos(latitude);
  return vec3(flat.mul(sin(longitude)), sin(latitude), flat.mul(cos(longitude)));
}

// Float32 の RGBA 写しへ vec4 の列を順に描き、画素をチャンネルごとの面へ並べ替えて読み戻す器。
// 色への写像・クランプ・トーンマップはどこにも通さない。読み出しの 4 成分目をアルファとして
// 潰されないよう、出力は colorNode ではなく MRT で書く。
export class FloatPlaneSet {
  private readonly targets: THREE.RenderTarget[];
  private readonly quads: QuadMesh[];

  // groups の並びのまま 4 チャンネルずつ RGBA へ割り当てる。写しの序数 × 4 が面の添字になる。
  public constructor(
    groups: readonly Vec4Node[], private readonly width: number, private readonly height: number,
  ) {
    this.targets = groups.map(() => {
      const target = new THREE.RenderTarget(width, height, {
        format: THREE.RGBAFormat, type: THREE.FloatType, depthBuffer: false, samples: 0,
      });
      target.texture.name = 'w';
      return target;
    });
    this.quads = groups.map((color) => {
      const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
      material.mrtNode = mrt({ w: color });
      return new QuadMesh(material);
    });
  }

  // 全部の写しを描き、チャンネル面(width × height の Float32)を groups の並びで返す。
  public async read(renderer: WebGPURenderer): Promise<Float32Array[]> {
    const planes: Float32Array[] = [];
    for (let t = 0; t < this.targets.length; t += 1) {
      renderer.setRenderTarget(this.targets[t]!);
      this.quads[t]!.render(renderer);
      renderer.setRenderTarget(null);
      const texels = await renderer.readRenderTargetPixelsAsync(
        this.targets[t]!, 0, 0, this.width, this.height);
      for (let c = 0; c < 4; c += 1) {
        const plane = new Float32Array(this.width * this.height);
        for (let i = 0; i < plane.length; i += 1) plane[i] = texels[i * 4 + c]!;
        planes.push(plane);
      }
    }
    return planes;
  }
}

// 雲を運ぶ風の写し(地表付近・上層の東・北成分を ±WIND_SPAN_MS へ写す)を組む器。
// 2 枚の写しの混ぜ方は場の blend 状態へ張り付ける。motion と translucent が同じ写しを使う。
export class CloudMotionWind {
  private readonly parity: FloatUniform = uniform(0);
  private readonly fraction: FloatUniform = uniform(0);

  public constructor(private readonly field: GeneratedCloudField) {
    bindCloudBlend(field.blend, this.parity, this.fraction);
  }

  public windNode(direction: Vec3Node): Vec4Node {
    const uv = this.field.fieldProjection.uvAt(direction);
    const texel = blendBakedTexels(
      texture(this.field.slots[0].motion, uv), texture(this.field.slots[1].motion, uv),
      this.parity, this.fraction,
    );
    const motion = cloudMotionFromTexel(texel);
    const encode = (v: FloatNode): FloatNode => clamp(v.div(WIND_SPAN_MS).add(0.5), 0, 1);
    return vec4(
      encode(motion.surfaceWind.x), encode(motion.surfaceWind.y),
      encode(motion.upperWind.x), encode(motion.upperWind.y),
    );
  }
}
