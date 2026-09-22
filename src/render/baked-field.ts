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
  // 写しの大きさは常に投影と同じ。pass は render() の GPU 時間を計上する描画パス、mipmaps を立てると
  // 段付きで焼き、atLevel() で段を選べるようになる。
  public constructor(
    name: string,
    format: THREE.PixelFormat,
    private readonly projection: FieldProjection,
    source: (direction: Vec3Node) => Vec4Node,
    private readonly pass: GpuPassId,
    mipmaps = false,
  ) {
    // 段を持つ写しは段の間も補間して読む。LinearFilter のままだと、段を選んでも最上段が返る。
    const minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    this.target = new THREE.RenderTarget(
      projection.width, projection.height,
      {
        count: 1,
        depthBuffer: false,
        samples: 0,
        generateMipmaps: mipmaps,
        minFilter,
      });
    const map = this.target.textures[0]!;
    map.name = name;
    map.format = format;
    // 半精度で焼く。単精度はフィルタできない環境があり、そこでは黙って最近傍に落ちる。
    map.type = THREE.HalfFloatType;
    map.wrapS = projection.wrapS;
    map.wrapT = projection.wrapT;
    // RenderTarget の初期化設定を明示的に指定し、テクスチャプロパティの整合性を保つ。
    map.generateMipmaps = mipmaps;
    map.minFilter = minFilter;
    map.magFilter = THREE.LinearFilter;
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.mrtNode = mrt({ [name]: source(projection.directionAt(screenUV)) });
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
  public get texture(): THREE.Texture { return this.target.textures[0]!; }

  // 単位方向 direction での値。使う成分は呼ぶ側が取る。
  public at(direction: Vec3Node): Vec4Node {
    return texture(this.target.textures[0]!, this.projection.uvAt(direction));
  }

  // 単位方向 direction での値を、ミップ段 level から読む。段を持つのは mipmaps を立てて焼いた写し。
  public atLevel(direction: Vec3Node, level: FloatNode): Vec4Node {
    return texture(this.target.textures[0]!, this.projection.uvAt(direction)).level(level);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
