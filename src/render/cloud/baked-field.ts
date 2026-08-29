// 単位方向の関数を正距円筒図法の写しへ焼き、単位方向で読み直す。1 texel を描くのに同じ場を何度も
// 標本化するとき、式をその場で何度も展開する代わりに、1 回焼いて何度も読む。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mrt, screenUV, texture } from 'three/tsl';
import { directionFromEquirectUv, equirectUvFromDirection } from './sphere-frame';
import type { Vec3Node, Vec4Node } from '../tsl-types';

// 写しの解像度 [texel]。正距円筒なので幅は高さの 2 倍。気圧の差分の刻み(0.01 rad)が texel
// (2π/2048)の 3 倍あり、湿度のノイズの最上段(159 km)が 8 texel で表せる大きさ。
const WIDTH = 2048;
const HEIGHT = 1024;

export class BakedField {
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // name は写しの名前、format は使う成分(THREE.RedFormat / THREE.RGFormat)、source は単位方向から
  // 焼く値を組むグラフ。source は写しを組むときに一度だけ展開される。
  public constructor(name: string, format: THREE.PixelFormat, source: (direction: Vec3Node) => Vec4Node) {
    this.target = new THREE.RenderTarget(WIDTH, HEIGHT, { count: 1, depthBuffer: false, samples: 0 });
    const map = this.target.textures[0]!;
    map.name = name;
    map.format = format;
    // 半精度で焼く。単精度はフィルタできない環境があり、そこでは黙って最近傍に落ちる。
    map.type = THREE.HalfFloatType;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.generateMipmaps = false;
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.mrtNode = mrt({ [name]: source(directionFromEquirectUv(screenUV)) });
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
    return texture(this.target.textures[0]!, equirectUvFromDirection(direction));
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
