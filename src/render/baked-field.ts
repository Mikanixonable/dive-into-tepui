// 単位方向の関数を投影法の写しへ焼き、単位方向で読み直す。1 texel を描くのに同じ場を何度も
// 標本化するとき、式をその場で何度も展開する代わりに、1 回焼いて何度も読む。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { mrt, screenUV, texture } from 'three/tsl';
import type { GpuPassId, GpuTimingSink } from './gpu-timings';
import type { FieldProjection } from './field-projection';
import type { FloatNode, Vec3Node, Vec4Node } from './tsl-types';

export class BakedField {
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // name は写しの名前、format は使う成分(THREE.RedFormat / THREE.RGFormat)、projection は写しの
  // 持ち方、source は単位方向から焼く値を組むグラフ。source は写しを組むときに一度だけ展開される。
  // 値の配列を返す source は 1 パスで複数の写しへ焼く(MRT) — 同じ気象の評価から複数の場を
  // 出すときに、場ごとにパスを分けて同じグラフを二度展開するのを避ける。
  // 写しの大きさは常に投影と同じ。pass は render() の GPU 時間を計上する描画パス、mipmaps を立てると
  // 段付きで焼き、atLevel() で段を選べるようになる。
  public constructor(
    name: string,
    format: THREE.PixelFormat,
    private readonly projection: FieldProjection,
    source: (direction: Vec3Node) => Vec4Node | readonly Vec4Node[],
    private readonly pass: GpuPassId,
    mipmaps = false,
  ) {
    // 段を持つ写しは段の間も補間して読む。LinearFilter のままだと、段を選んでも最上段が返る。
    const minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    const values = source(projection.directionAt(screenUV));
    const outputs = Array.isArray(values) ? values : [values];
    this.target = new THREE.RenderTarget(
      projection.width, projection.height,
      {
        count: outputs.length,
        depthBuffer: false,
        samples: 0,
        generateMipmaps: mipmaps,
        minFilter,
      });
    for (const [index, map] of this.target.textures.entries()) {
      map.name = index === 0 ? name : `${name}_${index}`;
      map.format = format;
      // 半精度で焼く。単精度はフィルタできない環境があり、そこでは黙って最近傍に落ちる。
      map.type = THREE.HalfFloatType;
      map.wrapS = projection.wrapS;
      map.wrapT = projection.wrapT;
      // RenderTarget の初期化設定を明示的に指定し、テクスチャプロパティの整合性を保つ。
      map.generateMipmaps = mipmaps;
      map.minFilter = minFilter;
      map.magFilter = THREE.LinearFilter;
    }
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    // MRT の出力名は対応するテクスチャの名前から取る — three.js が名前で対応づける
    // (MRTNode.setup の getTextureIndex)ため、ここで命名をずらすと出力が黙って捨てられる。
    this.material.mrtNode = mrt(
      Object.fromEntries(outputs.map((value, index) => [this.target.textures[index]!.name, value])));
    this.quad = new QuadMesh(this.material);
  }

  // いま source の uniform が指している時刻の場を写しへ描く。at() で読む前に必ず一度呼ぶ。
  public render(renderer: WebGPURenderer, gpu?: GpuTimingSink): void {
    renderer.setRenderTarget(this.target);
    gpu?.beginPass(this.pass);
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
  }

  // 焼いた場のテクスチャ。RenderTarget の所有権はこのクラスに残す。
  public get texture(): THREE.Texture { return this.textureAt(0); }

  // 焼いた場のうち番号 output のテクスチャ。source が複数の値を返す写しで使う。
  public textureAt(output: number): THREE.Texture { return this.target.textures[output]!; }

  // 単位方向 direction での値。使う成分は呼ぶ側が取る。output は複数出力の写しの番号。
  public at(direction: Vec3Node, output = 0): Vec4Node {
    return texture(this.target.textures[output]!, this.projection.uvAt(direction));
  }

  // 単位方向 direction での値を、ミップ段 level から読む。段を持つのは mipmaps を立てて焼いた写し。
  public atLevel(direction: Vec3Node, level: FloatNode, output = 0): Vec4Node {
    return texture(this.target.textures[output]!, this.projection.uvAt(direction)).level(level);
  }

  // 写しの中心 texel 1 個を CPU へ読み戻す。半精度 RGBA の 4 成分を、半精度の
  // ビット列のまま返す。中心は投影のちょうど真ん中なので、uv の向きは結果に効かない。
  public async readCenterTexel(renderer: WebGPURenderer): Promise<Uint16Array> {
    const x = Math.floor(this.projection.width / 2);
    const y = Math.floor(this.projection.height / 2);
    const pixels = await renderer.readRenderTargetPixelsAsync(this.target, x, y, 1, 1);
    const half = pixels instanceof Uint16Array
      ? pixels
      : new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2);
    if (half.length < 4) {
      throw new Error(`readCenterTexel: expected 4 half-float components, got ${half.length}`);
    }
    return half;
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
