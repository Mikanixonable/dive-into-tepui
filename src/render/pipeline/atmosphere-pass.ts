// 大気を、幾何形状ではなく画面空間のフィルタとして不透明の絵の上へ重ねる。G バッファの深度から
// 復元した位置と視線で、指数分布の大気を通る区間の透過率と内部散乱を解き、下地へ
// 「下地 × 透過率(波長別)+ 内部散乱」をパスの中で合成する。天体本体が落とす影も同じ視線と
// 地表との交差で解くので、深度テストの精度には依存しない。
//
// **板は 1 天体分だけ持ち、複数の大気は奥から順に描き重ねる。** 合成は「下地 × 透過率 +
// 内部散乱」の鎖なので、奥の層の出力をそのまま手前の層の下地にすれば同じ絵になる。
// どの天体の見えも同じ「視線に沿った散乱の積分」で解き、違うのは呼び出し側が配ったサンプル点の
// 数だけ。**扁平な天体は、自転軸方向へ引き伸ばして真球にした空間で解く**(toSphereSpace)。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, PI, abs, and, clamp, dot, exp, float, greaterThan, greaterThanEqual, length, lessThan,
  max, min, mix, normalize, not, or, screenUV, select, smoothstep, sqrt, sub, texture, uniform,
  vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { MAX_ATMOSPHERE_BODIES, type AtmosphereBody, type AtmosphereDraw, cutoffAltitude } from '../atmosphere';
import { rayMarch, type MediumSample } from '../ray-march';
import { BlueNoise } from '../blue-noise';
import { viewPositionAt, viewRayAt } from './view-ray';
import type { BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform } from '../tsl-types';
import type { GBufferPass } from './gbuffer';
import type { BodyShadow } from './shadow/body-shadow';
import type { SunLight } from './sun-light';
import { compileInto } from './compile-into';

// 消散係数の下限 [1/m]。散乱の割合を消散で割るときの 0/0 を塞ぐ。
const MIN_EXTINCTION = 1e-30;

// 極半径/赤道半径の下限。潰し量はこの逆数なので、0 を塞ぐ。太陽系で最も扁平な土星でも 0.90。
const MIN_POLAR_RATIO = 1e-3;

// 天体 1 体ぶんの uniform。surfaceRadius は赤道半径、cutoffRadius は大気の裾を打ち切る半径
// (赤道半径 + 打ち切り高度)、steps はこの層を解くサンプル点の数。polarAxis は扁平を潰す軸の
// 単位ベクトル、polarStretch はその向きへ引き伸ばす量(赤道半径/極半径 − 1。真球で 0)。
interface BodySlot {
  readonly steps: FloatUniform;
  readonly center: Vec3Uniform;
  readonly surfaceRadius: FloatUniform;
  readonly cutoffRadius: FloatUniform;
  readonly polarAxis: Vec3Uniform;
  readonly polarStretch: FloatUniform;
  readonly rayleigh: Vec3Uniform;
  readonly rayleighScaleHeight: FloatUniform;
  readonly mie: FloatUniform;
  readonly mieScaleHeight: FloatUniform;
  readonly mieAnisotropy: FloatUniform;
}

// 視線が 1 つの天体の大気を通る区間。距離はすべて視線の起点から測った [m]。
interface RaySegment {
  readonly near: FloatNode;
  readonly far: FloatNode;
  // 区間のうち大気が最も濃い距離。地表で終わる視線では区間の奥、掠める視線では最接近点。
  readonly densest: FloatNode;
  // 視線が大気に掛かるか。掛からない画素では素通しへ倒す。
  readonly hitsAtmosphere: BoolNode;
}

// 天体 1 体ぶんの、視線区間の透過率と内部散乱。
interface LayerContribution {
  readonly transmittance: Vec3Node;
  readonly inscatter: Vec3Node;
}

// 半径 r の点から天頂角余弦 mu(0 以上)の向きへ大気の外まで抜けるまでの、散乱係数 1 あたりの
// 光学的厚み。Chapman 関数を Ch0/((Ch0−1)·mu+1) で近似する — mu=1 で 1、mu=0 で √(πr/2H) と
// 両端で厳密値に一致し、その間を単調に埋める。
const outwardDepth = Fn((
  [radius, mu, surfaceRadius, scaleHeight]: readonly [FloatNode, FloatNode, FloatNode, FloatNode],
) => {
  const chapmanZero = sqrt(PI.mul(radius).div(scaleHeight).mul(0.5));
  const chapman = chapmanZero.div(chapmanZero.sub(1).mul(mu).add(1));
  return scaleHeight.mul(exp(surfaceRadius.sub(radius).div(scaleHeight))).mul(chapman);
});

// 半径 radius・天頂角余弦 mu の点から大気の外へ抜けるまでの、散乱係数 1 あたりの光学的厚み。
// 降る向き(mu<0)の経路は、最接近点で折り返す2本の上向きの経路として組み、最接近点が地表より
// 内側へ落ちる向きでは地表で打ち切る。**打ち切った値は、地平線を掠める経路の厚みの続きである**
// — 天体を貫く経路で直射を遮るのは horizonVisibility が解く。
//
// **どちらの枝も outwardDepth へ渡す余弦を非負に保つ** — select は選ばれない枝も評価するので、
// 負の余弦を通すと Chapman 近似の分母が 0 を跨ぎ、選ばれない側で無限大が湧く。
const depthToSpace = Fn((
  [radius, mu, surfaceRadius, scaleHeight]: readonly [FloatNode, FloatNode, FloatNode, FloatNode],
) => {
  const ascending = outwardDepth(radius, abs(mu), surfaceRadius, scaleHeight);
  const perigee = max(radius.mul(sqrt(max(float(1).sub(mu.mul(mu)), 0))), surfaceRadius);
  const descending = outwardDepth(perigee, float(0), surfaceRadius, scaleHeight).mul(2).sub(ascending);
  return select(greaterThan(mu, 0), ascending, descending);
});

// レイリー散乱の位相関数。等方散乱を 1 とする目盛りなので、前後で 1.5、側方で 0.75 になる。
const rayleighPhase = (cosTheta: FloatNode): FloatNode => cosTheta.mul(cosTheta).add(1).mul(0.75);

// Henyey–Greenstein の位相関数。等方散乱を 1 とする目盛り。非対称因子 g が大きいほど
// 前方へ尖り、太陽のまわりのグローが締まる。
const miePhase = Fn(([cosTheta, anisotropy]: readonly [FloatNode, FloatNode]) => {
  const squared = anisotropy.mul(anisotropy);
  const denominator = max(squared.add(1).sub(anisotropy.mul(cosTheta).mul(2)), 1e-4);
  return float(1).sub(squared).div(denominator.mul(sqrt(denominator)));
});

// 1 枚を画面いっぱいへ写すだけのマテリアル。
function copyMaterial(source: THREE.Texture): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  material.colorNode = texture(source, screenUV);
  return material;
}

export class AtmospherePass {
  private readonly quad: QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  // いま描いている層 1 体ぶんの光学パラメータ。層ごとに描く直前へ書き込む。
  private readonly slot: BodySlot;
  // 板が読む下地。層ごとに、その層より奥まで重ね終えた絵をここへ写す。
  private readonly backdropTarget: THREE.RenderTarget;
  private readonly sharedCopyMaterial: THREE.MeshBasicNodeMaterial;
  private readonly sharedCopyQuad: QuadMesh;
  // 描画デバッグ表示へ渡す 1 枚と、それを下地として読み直すためのコピー板。
  private readonly inspectTarget: THREE.RenderTarget;
  private readonly inspectCopyMaterial: THREE.MeshBasicNodeMaterial;
  private readonly inspectCopyQuad: QuadMesh;
  // 積分の刻みを画素ごとにずらす種。
  private readonly blueNoise: BlueNoise;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列と view→描画座標の行列は
  // 毎フレーム自前で書き込む。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewToWorld: Mat4Uniform;
  // このフレームに重ねる層。視点に近い順。
  private draws: readonly AtmosphereDraw[] = [];
  // 裾球と、クリア色の退避先。フレームごとに確保しない使い回し領域。
  private readonly cutoffSphere = new THREE.Sphere();
  private readonly savedClearColor = new THREE.Color();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();

  // 大気は、共有ターゲットに入った不透明の絵を下地として読み、「下地 × 透過率 + 内部散乱」を
  // 解いた完成形で同じターゲットを上書きする。合成をブレンドではなくパスの中で行うのは、
  // 合成のアルファは 1 つしか無く、下地の波長別の減衰(厚い大気越しの下地が赤へ寄る)を
  // 表せないため。
  public constructor(
    private readonly renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    private readonly sharedTarget: THREE.RenderTarget,
    private readonly sunLight: SunLight,
    private readonly bodyShadow: BodyShadow,
    private readonly gpu: GpuTimings,
  ) {
    this.blueNoise = new BlueNoise();
    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());
    // **steps の初期値は 1 以上でなければならない** — 積分の段の幅はサンプル数の逆数なので、
    // 層を1つも受けないまま事前コンパイルへ入ると 0 除算になる。
    this.slot = {
      steps: uniform(1),
      center: uniform(new THREE.Vector3()),
      surfaceRadius: uniform(0),
      cutoffRadius: uniform(0),
      polarAxis: uniform(new THREE.Vector3(0, 1, 0)),
      polarStretch: uniform(0),
      rayleigh: uniform(new THREE.Vector3()),
      rayleighScaleHeight: uniform(1),
      mie: uniform(0),
      mieScaleHeight: uniform(1),
      mieAnisotropy: uniform(0),
    };

    // 下地も点検用の1枚も色を写しただけなので、深度を持たない。
    this.backdropTarget = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    });
    this.inspectTarget = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    });
    this.sharedCopyMaterial = copyMaterial(sharedTarget.texture);
    this.sharedCopyQuad = new QuadMesh(this.sharedCopyMaterial);
    this.inspectCopyMaterial = copyMaterial(this.inspectTarget.texture);
    this.inspectCopyQuad = new QuadMesh(this.inspectCopyMaterial);

    const viewPos = viewPositionAt(gbuffer.depthTexture, this.projMatrixInverse);
    const opaquePos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    // 視線は投影方式に依らない形(view-ray.ts)から取る — 平行投影の視線はカメラ位置から
    // 放射状に出ないので、「カメラ位置から復元位置へ」の形では組めない。
    const ray = viewRayAt(this.projMatrixInverse);
    const rayOrigin: Vec3Node = this.viewToWorld.mul(vec4(ray.origin, 1)).xyz;
    const rayDir: Vec3Node = this.viewToWorld.mul(vec4(ray.direction, 0)).xyz;
    const opaqueDist = length(sub(opaquePos, rayOrigin));

    // **重い側はすべて分岐の中に置く。** 大気に掛からない視線は区間の判定だけで抜ける —
    // select で混ぜると、捨てるぶんまで毎画素走る。
    const composed = Fn(() => {
      const segment = this.raySegment(rayOrigin, rayDir, opaqueDist);
      const transmittance = vec3(1, 1, 1).toVar();
      const inscatter = vec3(0, 0, 0).toVar();
      If(segment.hitsAtmosphere, () => {
        const layer = this.integrated(segment, rayOrigin, rayDir);
        transmittance.assign(layer.transmittance);
        inscatter.assign(layer.inscatter);
      });
      return inscatter.add(texture(this.backdropTarget.texture, screenUV).rgb.mul(transmittance));
    })();

    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.material.colorNode = composed;
    this.quad = new QuadMesh(this.material);
  }

  // 描画座標のベクトルを、自転軸方向へ引き伸ばして天体を真球にした空間へ写す。地表も裾も
  // 大気の等密度面も、この空間では中心を共有する球面になるので、区間も高度も光路もここで解ける。
  //
  // **この空間の長さは描画座標の長さではない。** 引き伸ばした向きぶん伸びているので、距離を
  // 実寸として使う値は、その向きの伸び率で割ってから返すこと。
  private toSphereSpace(vector: Vec3Node): Vec3Node {
    return vector.add(this.slot.polarAxis.mul(dot(vector, this.slot.polarAxis).mul(this.slot.polarStretch)));
  }

  // 視線が 1 つの天体の大気を通る区間。奥は大気の裾・不透明面・地表のうち最も手前で止まる。
  // 距離はどれも描画座標の実寸で返す。
  // **地表を解析で解くのは、地平線すれすれの視線で深度の量子化が縁を刻むため。**
  private raySegment(
    rayOrigin: Vec3Node, rayDir: Vec3Node, opaqueDist: FloatNode,
  ): RaySegment {
    const toOrigin = this.toSphereSpace(sub(rayOrigin, this.slot.center));
    // 引き伸ばした視線の長さが、実寸 1 m あたりこの空間を何進むかになる。
    const stretchedDir = this.toSphereSpace(rayDir);
    const unitsPerMeter = max(length(stretchedDir), 1e-6);
    const unitDir = stretchedDir.div(unitsPerMeter);
    const alongRay = dot(toOrigin, unitDir);

    // **判別式は「半径² − 最接近距離²」の形で解く。** 教科書の b² − c の形は、天体を惑星間
    // 距離から見る視線で ~1e19 同士の引き算になり、f32 の桁落ちが交点距離に数十 km(スケール
    // ハイトの桁上)のノイズを載せる — 円盤全面が z-fighting 様の縞になる。最接近点への垂線
    // ベクトルは成分ごとの引き算なので、この桁落ちを持たない。
    const perpOffset = sub(toOrigin, unitDir.mul(alongRay));
    const perpSq = dot(perpOffset, perpOffset);
    const cutoff = this.slot.cutoffRadius;
    const cutoffDisc = cutoff.mul(cutoff).sub(perpSq);
    const cutoffSpan = sqrt(max(cutoffDisc, 0));
    const near = max(alongRay.negate().sub(cutoffSpan).div(unitsPerMeter), 0);
    const surface = this.slot.surfaceRadius;
    const surfaceDisc = surface.mul(surface).sub(perpSq);
    const surfaceT = alongRay.negate().sub(sqrt(max(surfaceDisc, 0))).div(unitsPerMeter);
    const opaqueOrSurface = select(
      and(greaterThan(surfaceDisc, 0), greaterThan(surfaceT, near)), min(surfaceT, opaqueDist), opaqueDist,
    );
    // **区間は空でも順序を保つ** — 奥が手前より手前へ回ると、この先の clamp が下限と上限を
    // 逆に受け、値が未定義になる。大気に掛からない視線はここで長さ 0 の区間になる。
    const far = max(min(alongRay.negate().add(cutoffSpan).div(unitsPerMeter), opaqueOrSurface), near);

    return {
      near,
      far,
      densest: clamp(alongRay.negate().div(unitsPerMeter), near, far),
      hitsAtmosphere: and(greaterThan(cutoffDisc, 0), greaterThan(far, near)),
    };
  }

  // 区間を視線に沿って積分した透過率と内部散乱。被積分関数は高度と日照に対して指数で変わるので、
  // サンプル点は区間の中の「山」へ寄せる。区間が空でないこと(near < far)が事前条件。
  //
  // **山は 1 つだけ選び、鋭いものを優先する。** 地表(または不透明面)での打ち切りと日没境界は
  // 被積分関数がそこで断ち切られるのに対し、最接近点は滑らかな極大でしかない。鋭い側を外すと、
  // その遷移が丸ごと 1 段の中へ収まって絵に帯が立つ。**最接近点しか無い視線では等間隔で取る**
  // — 高度は最接近点から距離の 2 乗でしか増えず、寄せて山から離れた側を粗くする害のほうが勝つ。
  private integrated(
    segment: RaySegment, rayOrigin: Vec3Node, rayDir: Vec3Node,
  ): LayerContribution {
    // 奥端が地表や不透明面で切れている視線では、最も濃い点がその奥端に重なる — 打ち切りが
    // いちばん鋭いので、これを最優先の山に採る。切れていない視線でだけ日没境界を見て、それも
    // 区間の中に無ければ最接近点へ落ちる。
    const truncated = greaterThanEqual(segment.densest, segment.far);
    const sunset = this.sunsetDistance(segment, rayOrigin, rayDir);
    const crossesSunset = and(greaterThan(sunset, segment.near), lessThan(sunset, segment.far));
    const takesSunset = and(crossesSunset, not(truncated));
    const peak = select(takesSunset, sunset, segment.densest);
    const sharpness = select(or(truncated, takesSunset), float(1), float(0));

    // 手前側は山へ向かって細かく、奥側はそこから離れるほど粗く。**段を分ける位置は、山が区間の
    // どこに在るかで決める** — 段数を機械的に半分ずつ配ると、山が区間の端に重なる視線(地表で
    // 終わる視線 = 天体が写る画素すべて)で片側の段が長さ 0 に潰れ、サンプル点の半分が同じ 1 点に
    // 積まれて捨てられる。
    const span = max(segment.far.sub(segment.near), 1);
    const split = clamp(peak.sub(segment.near).div(span), 0, 1);
    // 区間の位置 fraction(0..1)を、山へ寄せた視線上の距離 [m] へ写す。
    const distanceAt = (fraction: FloatNode): FloatNode => {
      // **どちらの枝も 0 除算を踏まないよう分母に床を張る** — select は選ばれない枝も評価する。
      const nearFraction = clamp(fraction.div(max(split, 1e-6)), 0, 1);
      const farFraction = clamp(fraction.sub(split).div(max(float(1).sub(split), 1e-6)), 0, 1);
      const nearRest = float(1).sub(nearFraction);
      const nearEase = float(1).sub(mix(nearRest, nearRest.mul(nearRest), sharpness));
      const farEase = mix(farFraction, farFraction.mul(farFraction), sharpness);
      const nearSide = segment.near.add(peak.sub(segment.near).mul(nearEase));
      const farSide = peak.add(segment.far.sub(peak).mul(farEase));
      return select(lessThan(fraction, split), nearSide, farSide);
    };
    const march = rayMarch(
      this.slot.steps, distanceAt,
      (distance) => this.mediumAt(rayOrigin.add(rayDir.mul(distance)), rayDir),
      this.blueNoise.atScreenPixel(),
    );
    return { transmittance: march.transmittance, inscatter: march.radiance };
  }

  // 視線上で、太陽がその天体の地平線へ沈む距離。**区間の外に落ちることも、区間を跨がない視線で
  // 発散に近い値になることもある** — 呼び出し側が区間の中に在るかを見てから使う。
  //
  // 高度 r の点から見た日没は、天体中心から測って恒星方向の座標が −√(r²−R²) の面で起きる
  // (地平線が高度のぶん下がる)。高度は最も濃い点のもので代表させる。恒星は十分遠いので、
  // 向きは天体中心から見た 1 本で足りる。
  private sunsetDistance(
    segment: RaySegment, rayOrigin: Vec3Node, rayDir: Vec3Node,
  ): FloatNode {
    const sunDir = normalize(this.toSphereSpace(sub(this.sunLight.position, this.slot.center)));
    const densestOffset = this.toSphereSpace(
      sub(rayOrigin.add(rayDir.mul(segment.densest)), this.slot.center));
    const densestRadius = max(length(densestOffset), max(this.slot.surfaceRadius, 1));
    const sunsetOffset = sqrt(
      max(densestRadius.mul(densestRadius).sub(this.slot.surfaceRadius.mul(this.slot.surfaceRadius)), 0),
    );
    // **分母には符号を保ったまま床を張る** — 視線が恒星方向と直交すると 0 になる。そのとき解は
    // 区間の遥か外へ飛ぶので、呼び出し側の判定がそのまま弾く。**視線は正規化せずに写す** —
    // 引き伸ばした長さが実寸 1 m あたりの進みなので、商がそのまま実寸の距離になる。
    const alongSun = dot(this.toSphereSpace(rayDir), sunDir);
    const towardSun = select(greaterThan(alongSun, 0), float(1), float(-1));
    return sunsetOffset.negate().sub(dot(this.toSphereSpace(sub(rayOrigin, this.slot.center)), sunDir))
      .div(towardSun.mul(max(abs(alongSun), 1e-6)));
  }

  // 視線上の 1 点の媒質。消散はレイリーとミーの和で、視線へ足す量は「散乱が消散に占める割合 ×
  // 位相関数 × そこへ届く太陽光」。散乱と消散が等しい(吸収を持たない)ので、割合は位相関数の
  // 重みそのものになる。
  private mediumAt(point: Vec3Node, rayDir: Vec3Node): MediumSample {
    // 高度から成分ごとの散乱係数を引く。
    const offset = this.toSphereSpace(sub(point, this.slot.center));
    const radius = max(length(offset), max(this.slot.surfaceRadius, 1));
    const altitude = radius.sub(this.slot.surfaceRadius);
    const rayleigh: Vec3Node = this.slot.rayleigh.mul(exp(altitude.div(this.slot.rayleighScaleHeight).negate()));
    const mie = this.slot.mie.mul(exp(altitude.div(this.slot.mieScaleHeight).negate()));
    const extinction: Vec3Node = rayleigh.add(vec3(mie));

    // 視線へ向かう散乱は、成分ごとの散乱係数に位相関数を掛けて重みを付けた和。
    const sunDir = normalize(sub(this.sunLight.position, point));
    const cosTheta = dot(rayDir, sunDir);
    const scattered: Vec3Node = rayleigh.mul(rayleighPhase(cosTheta))
      .add(vec3(mie.mul(miePhase(cosTheta, this.slot.mieAnisotropy))));
    return {
      extinction,
      source: scattered.div(max(extinction, vec3(MIN_EXTINCTION, MIN_EXTINCTION, MIN_EXTINCTION)))
        .mul(this.sunRadianceAt(point)),
    };
  }

  // 大気の中の 1 点へ届く太陽光の輝度。太陽光自身が通ってきた大気の透過率と、他の天体による
  // 影の両方が掛かる。**影はこの点で評価し直す** — G バッファの画素位置とは別の点なので、
  // 影パスが書いた 1 枚は引けない。日食のとき月の影が大気にも落ちる。
  //
  // 目盛りは拡散面と揃える(放射照度を π で割る)。散乱した割合をアルベドと見なすので、
  // 太陽へ正対した濃い大気は、同じ場所のアルベド 1 の拡散面と同じ表示値になる。
  private sunRadianceAt(point: Vec3Node): Vec3Node {
    // 太陽光がその点まで通ってきた大気の光学的厚み。天頂角の余弦だけで決まる。
    const offset = this.toSphereSpace(sub(point, this.slot.center));
    const radius = max(length(offset), max(this.slot.surfaceRadius, 1));
    const toSun = sub(this.sunLight.position, point);
    const stretchedToSun = this.toSphereSpace(toSun);
    const sunMu = dot(offset.div(radius), normalize(stretchedToSun));
    // 厚みは引き伸ばした空間の長さで出るので、その向きの伸び率で実寸へ戻す。
    const sunPathScale = max(length(toSun), 1).div(max(length(stretchedToSun), 1));
    const sunDepth: Vec3Node = this.slot.rayleigh
      .mul(depthToSpace(radius, sunMu, this.slot.surfaceRadius, this.slot.rayleighScaleHeight).mul(sunPathScale))
      .add(vec3(this.slot.mie
        .mul(depthToSpace(radius, sunMu, this.slot.surfaceRadius, this.slot.mieScaleHeight)).mul(sunPathScale)));
    const irradiance = this.sunLight.intensity.div(max(dot(toSun, toSun), 1));
    const shadow = this.bodyShadow
      .transmittance(point)
      .mul(this.horizonVisibility(radius, sunMu, toSun));
    return exp(sunDepth.negate()).mul(irradiance.div(PI)).mul(shadow).mul(this.sunLight.color);
  }

  // 大気の中の 1 点から見て、恒星がその天体自身の地平線の上に出ている割合 0..1。
  //
  // **この天体自身の遮りはここで解く** — 影を落とす天体の一覧に載っている保証が無く、載っていないと
  // 夜側でも depthToSpace が地表で打ち切った有限の厚みを返し、真夜中の半球ぜんぶが夕焼け色に光る。
  //
  // 恒星は点ではないので、境目は縁を掠める帯の中で滑らかに変わる。帯の幅は恒星の視半径を
  // 地平線の傾き sin で天頂角余弦へ直したもの。帯の中では、打ち切った厚みが「まだ見えている
  // 縁の一片が通ってくる経路の厚み」として意味を持つ。
  private horizonVisibility(
    radius: FloatNode, sunMu: FloatNode, toSun: Vec3Node,
  ): FloatNode {
    const sinHorizon = this.slot.surfaceRadius.div(radius);
    const cosHorizon = sqrt(max(float(1).sub(sinHorizon.mul(sinHorizon)), 0)).negate();
    // **幅には床を張る** — sin が 0 へ落ちると、床が無い限り smoothstep の下限と上限が一致する。
    const halfWidth = max(sinHorizon.mul(this.sunLight.radius.div(max(length(toSun), 1))), 1e-9);
    return smoothstep(halfWidth.negate(), halfWidth, sunMu.sub(cosHorizon));
  }

  // このフレームで大気を描く天体を、**視点に近い順**に、それぞれのサンプル点の数と一緒に渡す。
  // 合成の前後はこの並びで決まる。MAX_ATMOSPHERE_BODIES を超えた分は描かれない。
  public setDraws(draws: readonly AtmosphereDraw[]): void {
    this.draws = draws.slice(0, MAX_ATMOSPHERE_BODIES);
  }

  // 視錐台に掛かる層を奥から順に、共有ターゲットの不透明の絵へ重ねる。
  public render(camera: THREE.Camera): void {
    this.composeLayers(camera, this.sharedTarget, this.sharedCopyQuad);
  }

  // 描画デバッグ表示へ渡す1枚。
  public get inspectTexture(): THREE.Texture { return this.inspectTarget.texture; }

  // 大気が最初に重ねる下地を、そのまま点検用の1枚へ控える。render より前に呼ぶこと。
  public inspectBackdrop(): void {
    this.syncSize(this.inspectTarget);
    this.copyInto(this.inspectTarget, this.sharedCopyQuad);
  }

  // 下地を黒へ置き換えて同じ層を重ね、大気が足す内部散乱だけを点検用の1枚へ描く。
  public inspectScattered(camera: THREE.Camera): void {
    this.syncSize(this.inspectTarget);
    // 層を1つも描かないフレームは、この黒がそのまま残る。
    this.clearToBlack(this.inspectTarget);
    this.composeLayers(camera, this.inspectTarget, this.inspectCopyQuad);
  }

  // 下地の控えと大気の合成板を、描画時と同じターゲットへ事前コンパイルする。
  public async compile(camera: THREE.Camera): Promise<void> {
    this.writeCamera(camera);
    this.syncSize(this.backdropTarget);
    await compileInto(this.renderer, this.backdropTarget, this.sharedCopyQuad, this.sharedCopyQuad.camera);
    await compileInto(this.renderer, this.sharedTarget, this.quad, this.quad.camera);
  }

  // 層を奥から順に destination へ重ねる。層ごとに、そこまでに重ね終えた絵を backdropSource から
  // 下地の控えへ写し、それを読んで destination を書き換える。
  //
  // **視錐台から外れた層は描画命令ごと落とす** — 裾の外の密度は打ち切り済みなので、裾球が
  // 掛からない層は絵に何も足さない。
  private composeLayers(camera: THREE.Camera, destination: THREE.RenderTarget, backdropSource: QuadMesh): void {
    this.writeCamera(camera);
    this.frustum.setFromProjectionMatrix(
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem, camera.reversedDepth,
    );
    // **奥から重ねる** — draws は視点に近い順なので、逆にたどる。手前の層の透過率が奥の層の
    // 内部散乱へ掛かる形は、奥の出力を手前の下地にすることで出る。
    for (let index = this.draws.length - 1; index >= 0; index--) {
      const { body, steps } = this.draws[index]!;
      const cutoffRadius = body.surfaceRadius + cutoffAltitude(body.optics, body.surfaceRadius);
      this.cutoffSphere.set(body.center, cutoffRadius);
      if (!this.frustum.intersectsSphere(this.cutoffSphere)) continue;
      this.writeSlot(body, steps, cutoffRadius);
      this.syncSize(this.backdropTarget);
      this.copyInto(this.backdropTarget, backdropSource);
      this.drawLayer(destination);
    }
  }

  // 板が解く1体ぶんの光学パラメータを書き込む。
  private writeSlot(body: AtmosphereBody, steps: number, cutoffRadius: number): void {
    this.slot.steps.value = steps;
    this.slot.center.value.copy(body.center);
    this.slot.surfaceRadius.value = body.surfaceRadius;
    this.slot.cutoffRadius.value = cutoffRadius;
    // **軸は単位長でなければならない** — 長さが乗ると潰し量がその2乗で効く。
    this.slot.polarAxis.value.copy(body.polarAxis).normalize();
    this.slot.polarStretch.value = 1 / Math.max(body.polarRatio, MIN_POLAR_RATIO) - 1;
    this.slot.rayleigh.value.copy(body.optics.rayleigh);
    this.slot.rayleighScaleHeight.value = body.optics.rayleighScaleHeight;
    this.slot.mie.value = body.optics.mie;
    this.slot.mieScaleHeight.value = body.optics.mieScaleHeight;
    this.slot.mieAnisotropy.value = body.optics.mieAnisotropy;
  }

  // QuadMesh は固定直交カメラで描かれるので、実カメラの行列を uniform へ書き写す。
  private writeCamera(camera: THREE.Camera): void {
    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);
  }

  // いま書き込んである層 1 つを destination へ描く。
  private drawLayer(destination: THREE.RenderTarget): void {
    // 色だけを上書きする — 共有ターゲットの深度はマテリアルパスが書いたものを後段も使う。
    this.renderer.setRenderTarget(destination);
    this.renderer.autoClear = false;
    // GPU 計測は、beginPass の直後の描画命令に付く。層ごとのぶんは計測側が足し合わせる。
    this.gpu.beginPass(GPU_PASS.atmosphere);
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
  }

  // source が読んでいる1枚を destination へ写す。
  private copyInto(destination: THREE.RenderTarget, source: QuadMesh): void {
    this.gpu.beginPass(GPU_PASS.atmosphere);
    this.renderer.setRenderTarget(destination);
    source.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }

  // ターゲットを黒で塗り潰す。クリア色はレンダラの共有状態なので、退避して戻す。
  private clearToBlack(target: THREE.RenderTarget): void {
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }

  // 中間の1枚を共有ターゲットと同じ寸法へ合わせる。**点検用の1枚は、点検が要求されたときだけ
  // 広げる** — 通常のプレイでは 1×1 のまま置いておく。
  private syncSize(target: THREE.RenderTarget): void {
    const { width, height } = this.sharedTarget;
    if (target.width !== width || target.height !== height) target.setSize(width, height);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  public dispose(): void {
    this.material.dispose();
    this.backdropTarget.dispose();
    this.inspectTarget.dispose();
    this.sharedCopyMaterial.dispose();
    this.inspectCopyMaterial.dispose();
    this.blueNoise.dispose();
  }
}
