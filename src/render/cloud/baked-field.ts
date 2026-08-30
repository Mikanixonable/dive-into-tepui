// 単位方向の関数を投影法の写しへ焼き、単位方向で読み直す。1 texel を描くのに同じ場を何度も
// 標本化するとき、式をその場で何度も展開する代わりに、1 回焼いて何度も読む。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mrt, screenUV, texture } from 'three/tsl';
import type { FieldProjection } from './field-projection';
import type { Vec3Node, Vec4Node } from '../tsl-types';

export class BakedField {
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // name は写しの名前、format は使う成分(THREE.RedFormat / THREE.RGFormat)、projection は写しの
  // 持ち方、coarseness は投影の細かさを何分の一に落として焼くか(焼く場が要求する細かさは場ごとに
  // 違う)、source は単位方向から焼く値を組むグラフ。source は写しを組むときに一度だけ展開される。
  public constructor(
    name: string,
    format: THREE.PixelFormat,
    private readonly projection: FieldProjection,
    coarseness: number,
    source: (direction: Vec3Node) => Vec4Node,
  ) {
    this.target = new THREE.RenderTarget(
      projection.width / coarseness, projection.height / coarseness,
      { count: 1, depthBuffer: false, samples: 0 });
    const map = this.target.textures[0]!;
    map.name = name;
    map.format = format;
    // 半精度で焼く。単精度はフィルタできない環境があり、そこでは黙って最近傍に落ちる。
    map.type = THREE.HalfFloatType;
    map.wrapS = projection.wrapS;
    map.wrapT = projection.wrapT;
    map.generateMipmaps = false;
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.mrtNode = mrt({ [name]: source(projection.directionAt(screenUV)) });
    this.quad = new QuadMesh(this.material);
  }

  // いま source の uniform が指している時刻の場を写しへ描く。at() で読む前に必ず一度呼ぶ。
  public render(renderer: WebGPURenderer): void {
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
  }

  // 単位方向 direction での値。使う成分は呼ぶ側が取る。
  public at(direction: Vec3Node): Vec4Node {
    return texture(this.target.textures[0]!, this.projection.uvAt(direction));
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
