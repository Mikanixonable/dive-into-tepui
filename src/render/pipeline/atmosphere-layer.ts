// 大気 1 層ぶんの光学パラメータと、視線 1 本がその層を通って受ける透過率・内部散乱。
// 指数分布の大気を通る区間の透過率と内部散乱をサンプル点で積み、雲の殻を解析の交点で挟む。
// 天体本体が落とす影も同じ視線と地表との交差で解くので、深度テストの精度には依存しない。
// **扁平な天体は、自転軸方向へ引き伸ばして真球にした空間で解く**(toSphereSpace)。
import * as THREE from 'three/webgpu';
import {
  Fn, If, PI, abs, and, clamp, dFdx, dFdy, dot, exp, float, greaterThan, greaterThanEqual, length,
  lessThan, max, min, mix, normalize, not, or, select, smoothstep, sqrt, step, sub, uniform, vec2,
  vec3,
} from 'three/tsl';
import { rayMarch, type MediumSample } from '../ray-march';
import { BlueNoise } from '../blue-noise';
import {
  CLOUD_SHELL_SPECIES, CloudScattering, shellAltitudeOf, type CloudSpecies,
} from './cloud-scattering';
import type { AtmosphereBody } from '../atmosphere';
import type { BoolNode, FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec3Uniform } from '../tsl-types';
import type { BodyShadow } from './shadow/body-shadow';
import type { SunLight } from './sun-light';

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

// 視線を、天体を自転軸方向へ引き伸ばして真球にした空間で見た形。**この空間の長さは描画座標の
// 長さではない** — unitsPerMeter が実寸 1 m あたりこの空間を進む長さで、両者を行き来する。
interface SphereSpaceRay {
  // 天体中心から視線の起点へのベクトル。
  readonly toOrigin: Vec3Node;
  // 視線の向き(この空間の単位長)。
  readonly unitDir: Vec3Node;
  readonly unitsPerMeter: FloatNode;
  // 起点から最接近点までの符号付き距離と、最接近距離の 2 乗。どちらもこの空間の長さ。
  readonly alongRay: FloatNode;
  readonly perpSq: FloatNode;
}

// 視線が天体と同心の球面に入る点と出る点。距離はどちらも視線の起点から測った実寸 [m] で、
// 交わらない視線では両者が最接近点に潰れる。
interface SphereCrossings {
  readonly entry: FloatNode;
  readonly exit: FloatNode;
  readonly crosses: BoolNode;
}

// 視線が雲の殻と交わる 1 点。distance は視線の起点から測った実寸 [m]、transmittance はその点で
// 視線が受ける減衰、radiance はその点が視線へ足す放射輝度(手前の大気と殻の減衰を含む)。
interface CloudShellLayer {
  readonly distance: FloatNode;
  readonly transmittance: FloatNode;
  readonly radiance: Vec3Node;
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
export interface LayerContribution {
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

// 視線上の距離 distance の点から手前にある殻を通り抜ける透過率。
function shellTransmittanceAt(shells: readonly CloudShellLayer[], distance: FloatNode): FloatNode {
  const product = float(1).toVar();
  for (const shell of shells) {
    product.mulAssign(mix(float(1), shell.transmittance, step(shell.distance, distance)));
  }
  return product;
}

export class AtmosphereLayer {
  // いま解く層 1 体ぶんの光学パラメータ。層ごとに描く直前へ書き込む。
  private readonly slot: BodySlot;
  // 積分の刻みを画素ごとにずらす種。
  private readonly blueNoise = new BlueNoise();
  // いま解く層の雲。
  private readonly clouds = new CloudScattering();

  // 層 1 体ぶんの uniform を確保する。**steps の初期値は 1 以上でなければならない** — 積分の段の
  // 幅はサンプル数の逆数なので、層を1つも受けないまま事前コンパイルへ入ると 0 除算になる。
  public constructor(
    private readonly sunLight: SunLight,
    private readonly bodyShadow: BodyShadow,
  ) {
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
  }

  // 種類ごとに、雲の殻を描くかを置き直す。
  public setCloudShell(species: CloudSpecies, enabled: boolean): void {
    this.clouds.setShellEnabled(species, enabled);
  }

  // この層が解く天体 1 体ぶんの光学パラメータと雲を書き込む。cutoffRadius は大気の裾を
  // 打ち切る半径 [m]。
  public write(body: AtmosphereBody, steps: number, cutoffRadius: number): void {
    this.clouds.set(body.clouds);
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

  // 視線 1 本がこの層を通って受ける透過率と、この層が視線へ足す内部散乱。opaqueDist は視線が
  // 不透明面へ届くまでの距離 [m] で、積分はその手前で止まる。**Fn の中から呼ぶこと。**
  //
  // **重い側はすべて分岐の中に置く。** 大気に掛からない視線は区間の判定だけで抜ける —
  // select で混ぜると、捨てるぶんまで毎画素走る。
  public contribution(
    rayOrigin: Vec3Node, rayDir: Vec3Node, opaqueDist: FloatNode,
  ): LayerContribution {
    // 場を引く細かさを決める、画面 1 px が張る角。**分岐の外で取る** — 画面微分は
    // 条件分岐の中では決まらない。
    const pixelAngle = max(length(dFdx(rayDir)), length(dFdy(rayDir))).toVar();
    const ray = this.sphereSpaceRay(rayOrigin, rayDir);
    const segment = this.raySegment(ray, opaqueDist);
    const transmittance = vec3(1, 1, 1).toVar();
    const inscatter = vec3(0, 0, 0).toVar();
    If(segment.hitsAtmosphere, () => {
      const shells = this.cloudShells(ray, segment, rayOrigin, rayDir, pixelAngle);
      const layer = this.integrated(ray, segment, rayOrigin, rayDir, shells);
      transmittance.assign(layer.transmittance);
      inscatter.assign(layer.inscatter);
    });
    return { transmittance, inscatter };
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    this.blueNoise.dispose();
  }

  // 描画座標のベクトルを、自転軸方向へ引き伸ばして天体を真球にした空間へ写す。地表も裾も
  // 大気の等密度面も、この空間では中心を共有する球面になるので、区間も高度も光路もここで解ける。
  //
  // **この空間の長さは描画座標の長さではない。** 引き伸ばした向きぶん伸びているので、距離を
  // 実寸として使う値は、その向きの伸び率で割ってから返すこと。
  private toSphereSpace(vector: Vec3Node): Vec3Node {
    return vector.add(this.slot.polarAxis.mul(dot(vector, this.slot.polarAxis).mul(this.slot.polarStretch)));
  }

  // 視線を真球にした空間へ写した形。この空間では地表も裾も等密度面も殻も中心を共有する
  // 球面になるので、交点も高度も光路もここで解ける。
  private sphereSpaceRay(rayOrigin: Vec3Node, rayDir: Vec3Node): SphereSpaceRay {
    const toOrigin = this.toSphereSpace(sub(rayOrigin, this.slot.center)).toVar();
    // 引き伸ばした視線の長さが、実寸 1 m あたりこの空間を何進むかになる。
    const stretchedDir = this.toSphereSpace(rayDir);
    const unitsPerMeter = max(length(stretchedDir), 1e-6).toVar();
    const unitDir = stretchedDir.div(unitsPerMeter).toVar();
    const alongRay = dot(toOrigin, unitDir).toVar();
    const perpOffset = sub(toOrigin, unitDir.mul(alongRay));
    return { toOrigin, unitDir, unitsPerMeter, alongRay, perpSq: dot(perpOffset, perpOffset).toVar() };
  }

  // 視線と、天体と同心の半径 radius の球面との交点。距離は描画座標の実寸で返す。
  //
  // **判別式は「半径² − 最接近距離²」の形で解く。** 教科書の b² − c の形は、天体を惑星間
  // 距離から見る視線で ~1e19 同士の引き算になり、f32 の桁落ちが交点距離に数十 km(スケール
  // ハイトの桁上)のノイズを載せる — 円盤全面が z-fighting 様の縞になる。最接近点への垂線
  // ベクトルは成分ごとの引き算なので、この桁落ちを持たない。
  private crossingsOf(ray: SphereSpaceRay, radius: FloatNode): SphereCrossings {
    const discriminant = radius.mul(radius).sub(ray.perpSq);
    const span = sqrt(max(discriminant, 0));
    const closest = ray.alongRay.negate();
    return {
      entry: closest.sub(span).div(ray.unitsPerMeter),
      exit: closest.add(span).div(ray.unitsPerMeter),
      crosses: greaterThan(discriminant, 0),
    };
  }

  // 視線が 1 つの天体の大気を通る区間。奥は大気の裾・不透明面・地表のうち最も手前で止まる。
  // 距離はどれも描画座標の実寸で返す。
  // **地表を解析で解くのは、地平線すれすれの視線で深度の量子化が縁を刻むため。**
  private raySegment(ray: SphereSpaceRay, opaqueDist: FloatNode): RaySegment {
    const cutoff = this.crossingsOf(ray, this.slot.cutoffRadius);
    const near = max(cutoff.entry, 0);
    const surface = this.crossingsOf(ray, this.slot.surfaceRadius);
    const opaqueOrSurface = select(
      and(surface.crosses, greaterThan(surface.entry, near)), min(surface.entry, opaqueDist), opaqueDist,
    );
    // **区間は空でも順序を保つ** — 奥が手前より手前へ回ると、この先の clamp が下限と上限を
    // 逆に受け、値が未定義になる。大気に掛からない視線はここで長さ 0 の区間になる。
    const far = max(min(cutoff.exit, opaqueOrSurface), near);

    return {
      near,
      far,
      densest: clamp(ray.alongRay.negate().div(ray.unitsPerMeter), near, far),
      hitsAtmosphere: and(cutoff.crosses, greaterThan(far, near)),
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
    ray: SphereSpaceRay, segment: RaySegment, rayOrigin: Vec3Node, rayDir: Vec3Node,
    shells: readonly CloudShellLayer[],
  ): LayerContribution {
    // 奥端が地表や不透明面で切れている視線では、最も濃い点がその奥端に重なる — 打ち切りが
    // いちばん鋭いので、これを最優先の山に採る。切れていない視線でだけ日没境界を見て、それも
    // 区間の中に無ければ最接近点へ落ちる。
    const truncated = greaterThanEqual(segment.densest, segment.far);
    const sunset = this.sunsetDistance(ray, segment);
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
      (distance) => this.mediumAt(
        rayOrigin.add(rayDir.mul(distance)), rayDir, shellTransmittanceAt(shells, distance)),
      this.blueNoise.atScreenPixel(),
    );
    // 殻は区間を刻まずに挟むので、下地には殻ぜんぶの透過率が、内部散乱には殻の放射輝度が
    // それぞれ最後にまとめて掛かる・足される。
    const shellTransmittance = float(1).toVar();
    const shellRadiance = vec3(0, 0, 0).toVar();
    for (const shell of shells) {
      shellTransmittance.mulAssign(shell.transmittance);
      shellRadiance.addAssign(shell.radiance);
    }
    return {
      transmittance: march.transmittance.mul(shellTransmittance),
      inscatter: march.radiance.add(shellRadiance),
    };
  }

  // 視線が雲の殻と交わる点。手前から順に並べ、手前の殻の透過率を奥の殻の放射輝度へ掛けながら
  // 組む。**順序は幾何が決める** — 殻はどれも天体と同心なので、視線は外側の殻から順に入り、
  // 内側の殻から順に出る。
  //
  // 交点が区間の外(大気の裾より手前、あるいは地表・不透明面より奥)へ落ちた画素では殻を捨てる
  // — 不透明な積雲の塔が写る画素で、その奥の殻が透けて出るのを防ぐ。
  private cloudShells(
    ray: SphereSpaceRay, segment: RaySegment, rayOrigin: Vec3Node, rayDir: Vec3Node,
    pixelAngle: FloatNode,
  ): readonly CloudShellLayer[] {
    const shells = CLOUD_SHELL_SPECIES.map((species) => {
      const radius = this.slot.surfaceRadius.add(shellAltitudeOf(species));
      return { species, radius, crossings: this.crossingsOf(ray, radius) };
    });
    const entries = shells.map((shell) => [shell, shell.crossings.entry] as const);
    const exits = shells.map((shell) => [shell, shell.crossings.exit] as const).reverse();

    const originDepth = this.outwardDepthAt(ray, float(0)).toVar();
    const front = float(1).toVar();
    const layers: CloudShellLayer[] = [];
    for (const [shell, crossing] of [...entries, ...exits]) {
      const distance = crossing.toVar();
      const transmittance = float(1).toVar();
      const radiance = vec3(0, 0, 0).toVar();
      const inSegment = and(greaterThan(distance, segment.near), lessThan(distance, segment.far));
      // **重い側は分岐の中に置く** — 雲に掛からない視線は交点の判定だけで抜ける。
      If(and(and(shell.crossings.crosses, inSegment), this.clouds.present(shell.species)), () => {
        const point = rayOrigin.add(rayDir.mul(distance));
        const offset = ray.toOrigin.add(ray.unitDir.mul(ray.unitsPerMeter.mul(distance)));
        const sunDir = normalize(this.toSphereSpace(sub(this.sunLight.position, point)));
        const sample = this.clouds.scatteredAt(
          shell.species, shell.radius, offset, ray.unitDir, sunDir,
          this.sunRadianceAt(point), pixelAngle.mul(distance));
        transmittance.assign(sample.transmittance);
        radiance.assign(sample.radiance.mul(front).mul(this.transmittanceTo(originDepth, ray, distance)));
      });
      front.mulAssign(transmittance);
      layers.push({ distance, transmittance, radiance });
    }
    return layers;
  }

  // 視線上の点から大気の外へ抜けるまでの、散乱係数 1 あたりの光学的厚み。x はレイリー、
  // y はミーのスケールハイトで測ったもので、長さはどちらも真球空間の目盛り。
  private outwardDepthAt(ray: SphereSpaceRay, distance: FloatNode): Vec2Node {
    const offset = ray.toOrigin.add(ray.unitDir.mul(ray.unitsPerMeter.mul(distance)));
    const radius = max(length(offset), max(this.slot.surfaceRadius, 1));
    const mu = dot(offset.div(radius), ray.unitDir);
    return vec2(
      depthToSpace(radius, mu, this.slot.surfaceRadius, this.slot.rayleighScaleHeight),
      depthToSpace(radius, mu, this.slot.surfaceRadius, this.slot.mieScaleHeight),
    );
  }

  // 視線の起点から distance までに視線が受ける大気の透過率。**区間を刻まずに解く** —
  // 指数分布を通る光路の厚みは、両端から大気の外へ抜ける厚みの差になる。originDepth は
  // 起点での outwardDepthAt。
  private transmittanceTo(
    originDepth: Vec2Node, ray: SphereSpaceRay, distance: FloatNode,
  ): Vec3Node {
    const path = max(originDepth.sub(this.outwardDepthAt(ray, distance)), vec2(0, 0))
      .div(ray.unitsPerMeter);
    return exp(this.slot.rayleigh.mul(path.x).add(vec3(this.slot.mie.mul(path.y))).negate());
  }

  // 視線上で、太陽がその天体の地平線へ沈む距離。**区間の外に落ちることも、区間を跨がない視線で
  // 発散に近い値になることもある** — 呼び出し側が区間の中に在るかを見てから使う。
  //
  // 高度 r の点から見た日没は、天体中心から測って恒星方向の座標が −√(r²−R²) の面で起きる
  // (地平線が高度のぶん下がる)。高度は最も濃い点のもので代表させる。恒星は十分遠いので、
  // 向きは天体中心から見た 1 本で足りる。
  private sunsetDistance(ray: SphereSpaceRay, segment: RaySegment): FloatNode {
    const sunDir = normalize(this.toSphereSpace(sub(this.sunLight.position, this.slot.center)));
    const densestOffset = ray.toOrigin.add(ray.unitDir.mul(ray.unitsPerMeter.mul(segment.densest)));
    const densestRadius = max(length(densestOffset), max(this.slot.surfaceRadius, 1));
    const sunsetOffset = sqrt(
      max(densestRadius.mul(densestRadius).sub(this.slot.surfaceRadius.mul(this.slot.surfaceRadius)), 0),
    );
    // **分母には符号を保ったまま床を張る** — 視線が恒星方向と直交すると 0 になる。そのとき解は
    // 区間の遥か外へ飛ぶので、呼び出し側の判定がそのまま弾く。**視線は正規化せずに写す** —
    // 引き伸ばした長さが実寸 1 m あたりの進みなので、商がそのまま実寸の距離になる。
    const alongSun = dot(ray.unitDir, sunDir).mul(ray.unitsPerMeter);
    const towardSun = select(greaterThan(alongSun, 0), float(1), float(-1));
    return sunsetOffset.negate().sub(dot(ray.toOrigin, sunDir))
      .div(towardSun.mul(max(abs(alongSun), 1e-6)));
  }

  // 視線上の 1 点の媒質。消散はレイリーとミーの和で、視線へ足す量は「散乱が消散に占める割合 ×
  // 位相関数 × そこへ届く太陽光」。散乱と消散が等しい(吸収を持たない)ので、割合は位相関数の
  // 重みそのものになる。shellTransmittance は、この点より手前にある雲の殻を通り抜ける割合。
  private mediumAt(point: Vec3Node, rayDir: Vec3Node, shellTransmittance: FloatNode): MediumSample {
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
        .mul(this.sunRadianceAt(point)).mul(shellTransmittance),
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
}
