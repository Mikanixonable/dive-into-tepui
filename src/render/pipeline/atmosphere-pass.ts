// 大気を、幾何形状ではなく画面空間のフィルタとして不透明の絵の上へ重ねる。G バッファの深度から
// 復元した位置と視線で、指数分布の大気を通る区間の光学的厚みを解き、透過率と内部散乱を前乗算
// アルファで合成する(色は乗算済み、アルファは 1 − 透過率)。天体本体による遮蔽も同じ視線の
// レイ・スフィア交差で解くので、深度テストの精度には依存しない。
//
// 大気を持つ天体を同時に MAX_ATMOSPHERE_BODIES 体まで受け、視点に近い順に重ねる。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import {
  Fn, PI, abs, and, clamp, dot, exp, float, greaterThan, length, lessThan, max, min,
  normalize, select, sqrt, sub, uniform, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform } from '../tsl-types';
import { type AtmosphereOptics, cutoffAltitude } from '../atmosphere-params';
import type { GBufferPass } from './gbuffer';
import type { SunOcclusion } from './sun-occlusion';
import type { SunLight } from './sun-light';
import { viewPositionAt, viewRayAt } from './view-ray';

// 同時に大気を描ける天体の数。**TSL のグラフは静的に展開されるので、実行時には増やせない。**
export const MAX_ATMOSPHERE_BODIES = 4;

// 大気を描く天体 1 体。中心は描画座標、半径は [m]。
export type AtmosphereBody = {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly optics: AtmosphereOptics;
};

// 天体 1 体ぶんの uniform。cutoffRadius は大気の裾を打ち切る半径(天体半径 + 打ち切り高度)。
type BodySlot = {
  readonly center: Vec3Uniform;
  readonly surfaceRadius: FloatUniform;
  readonly cutoffRadius: FloatUniform;
  readonly rayleigh: Vec3Uniform;
  readonly rayleighScaleHeight: FloatUniform;
  readonly mie: FloatUniform;
  readonly mieScaleHeight: FloatUniform;
};

// 半径 r の点から天頂角余弦 mu(0 以上)の向きへ大気の外まで抜けるまでの、散乱係数 1 あたりの
// 光学的厚み。Chapman 関数を Ch0/((Ch0−1)·mu+1) で近似する — mu=1 で 1、mu=0 で √(πr/2H) と
// 両端で厳密値に一致し、その間を単調に埋める。
const outwardDepth = Fn((
  [radius, mu, surfaceRadius, scaleHeight]: readonly FloatNode[],
) => {
  const chapmanZero = sqrt(PI.mul(radius!).div(scaleHeight!).mul(0.5));
  const chapman = chapmanZero.div(chapmanZero.sub(1).mul(mu!).add(1));
  return scaleHeight!.mul(exp(surfaceRadius!.sub(radius!).div(scaleHeight!))).mul(chapman);
});

// outwardDepth に、視線が降っている(mu<0)ぶんの符号を付けたもの。区間の光学的厚みは
// 両端のこの値の差で出る。
const signedDepth = Fn((
  [radius, mu, surfaceRadius, scaleHeight]: readonly FloatNode[],
) => {
  const depth = outwardDepth(radius!, abs(mu!), surfaceRadius!, scaleHeight!);
  return select(lessThan(mu!, 0), depth.negate(), depth);
});

// 半径 radius・天頂角余弦 mu の点から大気の外へ抜けるまでの、散乱係数 1 あたりの光学的厚み。
// 降る向き(mu<0)の経路は、最接近点で折り返す2本の上向きの経路として組む。最接近点が地表より
// 内側へ落ちる向きでは地表で止まるので、そこで打ち切る。
//
// **どちらの枝も outwardDepth へ渡す余弦を非負に保つ** — select は選ばれない枝も評価するので、
// 負の余弦を通すと Chapman 近似の分母が 0 を跨ぎ、選ばれない側で無限大が湧く。
const depthToSpace = Fn((
  [radius, mu, surfaceRadius, scaleHeight]: readonly FloatNode[],
) => {
  const perigee = max(radius!.mul(sqrt(max(float(1).sub(mu!.mul(mu!)), 0))), surfaceRadius!);
  const descending = outwardDepth(perigee, float(0), surfaceRadius!, scaleHeight!).mul(2)
    .sub(outwardDepth(radius!, abs(mu!), surfaceRadius!, scaleHeight!));
  return select(greaterThan(mu!, 0), outwardDepth(radius!, abs(mu!), surfaceRadius!, scaleHeight!), descending);
});

// 天体 1 体ぶんの、視線区間の透過率と内部散乱。
type LayerContribution = {
  readonly transmittance: Vec3Node;
  readonly inscatter: Vec3Node;
};

export class AtmospherePass {
  private readonly quad: QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly slots: readonly BodySlot[];
  // 下地と合成する前の、大気が足す内部散乱だけ(前乗算アルファの色そのもの)。
  private readonly scattered: Vec3Node;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列と view→描画座標の行列は
  // 毎フレーム自前で書き込む(light-prepass.ts の逆射影行列と同じ理由)。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewToWorld: Mat4Uniform;

  // 大気の合成先は world パスと共有する HDR ターゲットで、前乗算アルファで重ねる。
  // 大気を持つ天体が画面に無いフレームは全スロットの半径が 0 になり、何も足さない。
  constructor(
    private readonly renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    private readonly sunLight: SunLight,
    private readonly sunOcclusion: SunOcclusion,
    private readonly gpu: GpuTimings,
  ) {
    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());
    this.slots = Array.from({ length: MAX_ATMOSPHERE_BODIES }, (): BodySlot => ({
      center: uniform(new THREE.Vector3()),
      surfaceRadius: uniform(0),
      cutoffRadius: uniform(0),
      rayleigh: uniform(new THREE.Vector3()),
      rayleighScaleHeight: uniform(1),
      mie: uniform(0),
      mieScaleHeight: uniform(1),
    }));

    const viewPos = viewPositionAt(gbuffer.depthTexture, this.projMatrixInverse);
    const opaquePos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    // 視線は投影方式に依らない形(view-ray.ts)から取る — 平行投影の視線はカメラ位置から
    // 放射状に出ないので、「カメラ位置から復元位置へ」の形では組めない。
    const ray = viewRayAt(this.projMatrixInverse);
    const rayOrigin: Vec3Node = this.viewToWorld.mul(vec4(ray.origin, 1)).xyz;
    const rayDir: Vec3Node = this.viewToWorld.mul(vec4(ray.direction, 0)).xyz;
    const opaqueDist = length(sub(opaquePos, rayOrigin));

    // 視点に近い天体から順に重ねる。手前の層が奥の層の内部散乱も減衰させるので、
    // 透過率を累積しながら足していく。
    let transmittance: Vec3Node = vec3(1, 1, 1);
    let inscatter: Vec3Node = vec3(0, 0, 0);
    for (const slot of this.slots) {
      const layer = this.layerContribution(slot, rayOrigin, rayDir, opaqueDist);
      inscatter = inscatter.add(layer.inscatter.mul(transmittance));
      transmittance = transmittance.mul(layer.transmittance);
    }

    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    // 前乗算アルファ: 色は既に透過率を掛けた内部散乱、アルファは大気が下地から奪う割合。
    // **アルファは1つしか無いので、波長ごとに違う透過率を平均で代表させる** — 下地が
    // 波長ごとに違う減り方をすることは表せない。内部散乱の色は波長ごとのまま出る。
    this.scattered = inscatter;
    this.material.colorNode = this.scattered;
    this.material.opacityNode = float(1).sub(transmittance.x.add(transmittance.y).add(transmittance.z).div(3));
    this.quad = new QuadMesh(this.material);
  }

  // 天体 1 体が視線へ与える透過率と内部散乱。半径 0 のスロットは素通し(透過率 1・散乱 0)。
  private layerContribution(
    slot: BodySlot, rayOrigin: Vec3Node, rayDir: Vec3Node, opaqueDist: FloatNode,
  ): LayerContribution {
    const toOrigin = sub(rayOrigin, slot.center);
    const alongRay = dot(toOrigin, rayDir);
    const centerDistSq = dot(toOrigin, toOrigin);

    // 大気の裾を打ち切る球との交差。ここから外は積分しない。
    const cutoff = slot.cutoffRadius;
    const cutoffDisc = alongRay.mul(alongRay).sub(centerDistSq.sub(cutoff.mul(cutoff)));
    const cutoffSpan = sqrt(max(cutoffDisc, 0));
    const nearT = max(alongRay.negate().sub(cutoffSpan), 0);
    // 区間の奥は、大気の裾・不透明面・地表のうち最も手前で止まる。**地表を解析で解くのは、
    // 地平線すれすれの視線で深度の量子化が縁を刻むため。**
    const surface = slot.surfaceRadius;
    const surfaceDisc = alongRay.mul(alongRay).sub(centerDistSq.sub(surface.mul(surface)));
    const surfaceT = alongRay.negate().sub(sqrt(max(surfaceDisc, 0)));
    const opaqueOrSurface = select(
      and(greaterThan(surfaceDisc, 0), greaterThan(surfaceT, nearT)), min(surfaceT, opaqueDist), opaqueDist,
    );
    // **区間は空でも順序を保つ** — 奥が手前より手前へ回ると、この先の clamp が下限と上限を
    // 逆に受け、値が未定義になる。大気に掛からない視線はここで長さ 0 の区間になる。
    const farT = max(min(alongRay.negate().add(cutoffSpan), opaqueOrSurface), nearT);

    // 区間の両端と、視線が天体へ最も近づく半径。**半径には 1m の床を張る** — 空きスロットは
    // 半径 0 なので、床が無いと動径方向の単位ベクトルが 0/0 になる。
    const floorRadius = max(surface, 1);
    const nearPoint = rayOrigin.add(rayDir.mul(nearT));
    const farPoint = rayOrigin.add(rayDir.mul(farT));
    const nearOffset = sub(nearPoint, slot.center);
    const farOffset = sub(farPoint, slot.center);
    const nearRadius = max(length(nearOffset), floorRadius);
    const farRadius = max(length(farOffset), floorRadius);
    const nearMu = dot(nearOffset.div(nearRadius), rayDir);
    const farMu = dot(farOffset.div(farRadius), rayDir);
    const perigeeRadius = max(sqrt(max(centerDistSq.sub(alongRay.mul(alongRay)), 0)), floorRadius);
    // 最接近点を区間の内側に含む視線だけ、降る脚と昇る脚に分かれる。
    const straddles = and(lessThan(nearMu, 0), greaterThan(farMu, 0));

    const segment = (scaleHeight: FloatUniform): FloatNode => {
      const ends = signedDepth(nearRadius, nearMu, surface, scaleHeight)
        .sub(signedDepth(farRadius, farMu, surface, scaleHeight));
      const turn = select(straddles, outwardDepth(perigeeRadius, float(0), surface, scaleHeight).mul(2), float(0));
      return max(ends.add(turn), 0);
    };
    const opticalDepth: Vec3Node = slot.rayleigh.mul(segment(slot.rayleighScaleHeight))
      .add(vec3(slot.mie.mul(segment(slot.mieScaleHeight))));

    // 視線が大気に掛からないフレーム・画素では、素通しへ倒す。
    const lit = and(greaterThan(surface, 0), and(greaterThan(cutoffDisc, 0), greaterThan(farT, nearT)));
    const transmittance: Vec3Node = select(lit, exp(opticalDepth.negate()), vec3(1, 1, 1));
    const scattered: Vec3Node = vec3(1, 1, 1).sub(transmittance);
    return {
      transmittance,
      inscatter: scattered.mul(this.sunlight(slot, rayOrigin, rayDir, nearT, farT, alongRay)),
    };
  }

  // 区間のうち最も濃い点へ届く太陽光の輝度。太陽光自身が通ってきた大気の透過率と、他の天体に
  // よる遮蔽の両方が掛かる。**遮蔽はこの点で評価し直す** — G バッファの画素位置とは別の点
  // なので、遮蔽パスが書いた 1 枚は引けない。日食のとき月の影が大気にも落ちる。
  private sunlight(
    slot: BodySlot, rayOrigin: Vec3Node, rayDir: Vec3Node,
    nearT: FloatNode, farT: FloatNode, alongRay: FloatNode,
  ): Vec3Node {
    const densestT = clamp(alongRay.negate(), nearT, farT);
    const densest = rayOrigin.add(rayDir.mul(densestT));
    const offset = sub(densest, slot.center);
    const radius = max(length(offset), max(slot.surfaceRadius, 1));
    const toSun = sub(this.sunLight.position, densest);
    const sunDir = normalize(toSun);
    const sunMu = dot(offset.div(radius), sunDir);
    const sunDepth: Vec3Node = slot.rayleigh
      .mul(depthToSpace(radius, sunMu, slot.surfaceRadius, slot.rayleighScaleHeight))
      .add(vec3(slot.mie.mul(depthToSpace(radius, sunMu, slot.surfaceRadius, slot.mieScaleHeight))));
    // 目盛りは拡散面と揃える(放射照度を π で割る)。散乱した割合をアルベドと見なすので、
    // 太陽へ正対した濃い大気は、同じ場所のアルベド 1 の拡散面と同じ表示値になる。
    const irradiance = this.sunLight.intensity.div(max(dot(toSun, toSun), 1));
    const occlusion = this.sunOcclusion.transmittance(densest, { rings: false, meshNormal: null });
    return exp(sunDepth.negate()).mul(irradiance.div(PI)).mul(occlusion).mul(this.sunLight.color);
  }

  // 下地と合成する前の、大気が重ねる内部散乱だけ。「大気」デバッグ表示の合成パスがこのノードを
  // 組み直して映す — このパスは共有ターゲットへ直接重ねるので、単独で見せるための絵はどこにも
  // 残っておらず、**それを残すためだけの描画は足さない**(lens-pass.ts の redistributedLight と同じ)。
  scatteredLight(): Vec3Node { return this.scattered; }

  // このフレームで大気を描く天体を、カメラのいる場所の大気を強く作っている順に渡す。
  // **先頭が主天体であり、同時に視点へ最も近い**ので、合成の前後もこの並びで決まる。
  // MAX_ATMOSPHERE_BODIES を超えた分と、空きスロットは描かれない。
  setBodies(bodies: readonly AtmosphereBody[]): void {
    for (const [index, slot] of this.slots.entries()) {
      const body = bodies[index];
      slot.surfaceRadius.value = body === undefined ? 0 : body.surfaceRadius;
      if (body === undefined) continue;
      slot.center.value.copy(body.center);
      slot.cutoffRadius.value = body.surfaceRadius + cutoffAltitude(body.optics, body.surfaceRadius);
      slot.rayleigh.value.copy(body.optics.rayleigh);
      slot.rayleighScaleHeight.value = body.optics.rayleighScaleHeight;
      slot.mie.value = body.optics.mie;
      slot.mieScaleHeight.value = body.optics.mieScaleHeight;
    }
  }

  // 不透明の絵が入った共有ターゲットへ大気を重ねる。
  render(camera: THREE.Camera, sharedTarget: THREE.RenderTarget): void {
    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);

    this.renderer.setRenderTarget(sharedTarget);
    this.renderer.autoClear = false;
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼び、GPU 計測の対象パスを申告する。
    this.gpu.beginPass(GPU_PASS.atmosphere);
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.material.dispose();
  }
}
