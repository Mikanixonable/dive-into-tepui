// 雲の層が大気へ落とす影を、恒星の方向から見た正射影の 1 枚へ焼き、点ごとに 1 回のフェッチで引く。
// 1 texel は殻の空間(地表が半径 1)で恒星の方向に平行な直線 1 本で、直線が雲の殻を通る区間を
// 4 等分した結び目ごとに、そこから殻を抜けるまでの透過率を RGBA へ書く(R が区間の下端)。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, and, clamp, dot, float, greaterThan, lessThan, max, screenUV, select, sqrt,
  texture, uniform, vec2, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { CapPlacement } from '../../field-projection';
import type { FloatNode, FloatUniform, Vec2Uniform, Vec3Node, Vec3Uniform, Vec4Node } from '../../tsl-types';

// 地図の 1 辺 [texel]。雲場の cap の写しと同じ texel 数で、場の 1 texel より細かい影は
// 大気の雲影が細部を読まない以上そもそも持たない。
const SUN_MAP_SIZE = 512;
// 結び目の数(RGBA の 4 成分)。
export const SUN_MAP_KNOTS = 4;

// 殻を抜ける区間の上を、恒星へ向かって何本かのタップでたどる関数。origin は直線上の s = 0 の点、
// dir は恒星の方向(殻の空間の単位ベクトル)、s0・s1 は区間の両端。区間を下から 4 等分した
// 結び目ごとの、そこから s1 までの透過率を RGBA で返す。
export type SunMapKnots = (origin: Vec3Node, dir: Vec3Node, s0: FloatNode, s1: FloatNode) => Vec4Node;

// 直線が殻を通る区間。b2 は直線の天体中心からの距離の二乗。地表を貫く直線(b2 < 1)は昼側で
// 地表から殻の上端まで、地表をかすめる直線は殻へ入ってから出るまで。殻に触れない直線では
// 両端が 0 へ潰れる。
function shellInterval(b2: FloatNode, shellRadius: FloatNode): { s0: FloatNode; s1: FloatNode } {
  const s1 = sqrt(max(shellRadius.mul(shellRadius).sub(b2), 0));
  const s0 = select(lessThan(b2, 1), sqrt(max(float(1).sub(b2), 0)), s1.negate());
  return { s0, s1 };
}

export class CloudShadowSunMap {
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  // 恒星の方向と、それに直交する投影面の 2 軸(殻の空間)。
  private readonly dir: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly east: Vec3Uniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly north: Vec3Uniform = uniform(new THREE.Vector3(0, 1, 0));
  // 地図が覆う投影面の正方形の中心と半幅(殻の空間)。
  private readonly windowCenter: Vec2Uniform = uniform(new THREE.Vector2());
  private readonly windowHalf: FloatUniform = uniform(1);
  private readonly scratch = new THREE.Vector3();

  // shellRadius は殻の上端の半径(殻の空間)。knots は 1 本の直線の結び目の透過率を返す。
  public constructor(private readonly shellRadius: FloatNode, knots: SunMapKnots) {
    this.target = new THREE.RenderTarget(SUN_MAP_SIZE, SUN_MAP_SIZE, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
    });
    const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    material.colorNode = Fn(() => {
      const plane = this.windowCenter.add(screenUV.sub(0.5).mul(this.windowHalf.mul(2)));
      const b2 = dot(plane, plane);
      const value = vec4(1).toVar();
      // 殻に触れない直線は雲を通らない。
      If(lessThan(b2, this.shellRadius.mul(this.shellRadius)), () => {
        const { s0, s1 } = shellInterval(b2, this.shellRadius);
        const origin = this.east.mul(plane.x).add(this.north.mul(plane.y));
        value.assign(knots(origin, this.dir, s0, s1));
      });
      return value;
    })();
    this.quad = new QuadMesh(material);
  }

  // 恒星の方向 dir(殻の空間の単位ベクトル)と、雲場の cap の置き方から、地図が覆う範囲を決める。
  // shellRadius は殻の上端の半径(殻の空間)で、uniform の側と同じ値を渡す。
  //
  // 範囲は、cap の雲が占める立体(半径 1..shellRadius、cap の角の内側)を包む球の、投影面への影。
  // 球の中心は cap の中心方向に置き、半径は立体の頂点の候補(半径の両端 × 角の両端)までの最大距離。
  // cap が半球を越えるときは天体全体を包む。
  public update(dir: THREE.Vector3, cap: CapPlacement, shellRadius: number): void {
    // 投影面の 2 軸は、恒星の方向に平行でない補助軸との外積で取る。
    this.dir.value.copy(dir);
    const helper = Math.abs(dir.x) < 0.9 ? this.scratch.set(1, 0, 0) : this.scratch.set(0, 1, 0);
    this.east.value.crossVectors(helper, dir).normalize();
    this.north.value.crossVectors(dir, this.east.value);
    const cosRadius = cap.cosRadius;
    if (cosRadius <= 0) {
      this.windowCenter.value.set(0, 0);
      this.windowHalf.value = shellRadius;
      return;
    }
    const k = (shellRadius + cosRadius) / 2;
    let reach = 0;
    for (const r of [1, shellRadius]) {
      for (const along of [cosRadius, 1]) reach = Math.max(reach, r * r + k * k - 2 * r * k * along);
    }
    this.windowCenter.value.set(cap.center.dot(this.east.value) * k, cap.center.dot(this.north.value) * k);
    this.windowHalf.value = Math.sqrt(reach);
  }

  // 地図を焼く。GPU 時間は「雲影」へ計上する。
  public bake(renderer: WebGPURenderer, gpu: GpuTimings): void {
    renderer.setRenderTarget(this.target);
    gpu.beginPass(GPU_PASS.cloudShadow);
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
  }

  // 殻の空間の点 offset(天体中心から)へ届く直射光のうち、雲が透す割合。地図の外を通る直線と、
  // 殻を抜けたあとの点では 1。区間より下(地表をかすめる直線の、殻を抜けきった先)は区間全体の値。
  public transmittanceAt(offset: Vec3Node): FloatNode {
    const s = dot(offset, this.dir);
    const plane = vec2(dot(offset, this.east), dot(offset, this.north));
    const uv = plane.sub(this.windowCenter).div(this.windowHalf.mul(2)).add(0.5);
    const { s0, s1 } = shellInterval(dot(offset, offset).sub(s.mul(s)), this.shellRadius);
    // 結び目の間隔を 1 とした区間の中の位置。
    const position = clamp(s.sub(s0).div(max(s1.sub(s0), 1e-9)), 0, 1).mul(SUN_MAP_KNOTS);
    const knots = texture(this.target.texture, uv);
    // 結び目のあいだを線形に結ぶ。下端の値から、越えた区間ぶんの傾きを足し上げる。
    const value = knots.r
      .add(knots.g.sub(knots.r).mul(clamp(position, 0, 1)))
      .add(knots.b.sub(knots.g).mul(clamp(position.sub(1), 0, 1)))
      .add(knots.a.sub(knots.b).mul(clamp(position.sub(2), 0, 1)))
      .add(float(1).sub(knots.a).mul(clamp(position.sub(3), 0, 1)));
    const inside = and(
      and(greaterThan(uv.x, 0), lessThan(uv.x, 1)),
      and(greaterThan(uv.y, 0), lessThan(uv.y, 1)));
    return select(inside, value, float(1));
  }

  // 地図を事前コンパイルする。
  public async compile(renderer: WebGPURenderer): Promise<void> {
    renderer.setRenderTarget(this.target);
    await renderer.compileAsync(this.quad, this.quad.camera);
    renderer.setRenderTarget(null);
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.target.dispose();
    (this.quad.material as THREE.Material).dispose();
  }
}
