// 気圧の場を正距円筒図法の写しへ焼き、単位方向で読み直す。気圧は勾配とラプラシアンを取る
// 5 点差分のために 1 texel あたり 5 回必要になるので、式をその場で 5 回展開する代わりに、
// 1 回焼いて 5 回読む。気圧は総観規模までしか構造を持たないので、写しでも表しきれる。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mrt, screenUV, texture, vec4 } from 'three/tsl';
import { directionFromEquirectUv, equirectUvFromDirection } from './sphere-frame';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 写しの解像度 [texel]。正距円筒なので幅は高さの 2 倍。読む側の差分の刻みが texel(2π/2048)の
// 数倍ないと、差分が 1 つの補間の中に収まって潰れる。
const WIDTH = 2048;
const HEIGHT = 1024;

export class PressureField {
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;

  // source は単位方向から気圧の偏差 [hPa] を組むグラフ。焼くときに一度だけ展開される。
  public constructor(source: (direction: Vec3Node) => FloatNode) {
    this.target = new THREE.RenderTarget(WIDTH, HEIGHT, { count: 1, depthBuffer: false, samples: 0 });
    const map = this.target.textures[0]!;
    map.name = 'pressure';
    map.format = THREE.RedFormat;
    // 半精度で焼く。単精度はフィルタできない環境があり、そこでは黙って最近傍に落ちる。
    map.type = THREE.HalfFloatType;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.generateMipmaps = false;
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.mrtNode = mrt({ pressure: vec4(source(directionFromEquirectUv(screenUV)), 0, 0, 1) });
    this.quad = new QuadMesh(this.material);
  }

  // いま source の uniform が指している時刻の気圧を写しへ描く。at() で読む前に必ず一度呼ぶ。
  public render(renderer: WebGPURenderer): void {
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
  }

  // 単位方向 direction での気圧の偏差 [hPa]。
  public at(direction: Vec3Node): FloatNode {
    return texture(this.target.textures[0]!, equirectUvFromDirection(direction)).r;
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
