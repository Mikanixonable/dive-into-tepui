// 主推進器(hydrolox)1基の排気プルーム。排気が満たす切頭円錐を透過する体積として、画素の
// 視線と円錐の交差区間を解析的に求めて積分する。出口近傍の自発光(淡い青〜青紫)と下流の
// 凝縮氷晶への太陽光散乱を重ねる。見えるべき姿は DEVELOP/SPEC/COMBAT.md「推進プルーム」が正本。
import * as THREE from 'three/webgpu';
import {
  Fn, If, PI, cameraProjectionMatrixInverse, cameraWorldMatrix, dot, exp, float, max, min,
  mix, normalize, pow, select, sqrt, uniform, vec3, vec4,
} from 'three/tsl';
import { mulberry32 } from '../../../math/random';
import { viewRayAt } from '../../pipeline/view-ray';
import { rayMarch, type MediumSample } from '../../ray-march';
import { plumeNoiseSeed } from './plume-noise';
import { PLUME_NOZZLE_EXIT_RADIUS, plumeShape } from './plume-shape';
import type { BodyShadow } from '../../pipeline/shadow/body-shadow';
import type { SunLight } from '../../pipeline/sun-light';
import type { FloatNode, FloatUniform, Vec2Uniform, Vec3Node, Vec3Uniform, Vec4Node } from '../../tsl-types';

// 積分の刻み数。媒質は滑らかな解析場なので等間隔の中点則で足りる。
const MARCH_STEPS = 48;
// 出口断面が持つ消散係数 [1/m](出力比 1 のとき)。ほぼ透明な排気としての調整値 — 軸を
// 貫く視線の光学的厚みが 1 を切る程度。
const EXTINCTION_AT_EXIT = 0.3;
// 出口近傍の自発光の色(線形 RGB)。水素燃焼の可視成分に残る淡い青〜青紫(#9FB8FF)。
const EMISSION_COLOR: readonly [number, number, number] = [0.35, 0.48, 1.0];
// 単位光学的厚みあたりの自発光輝度(表示値)。ブースト込みで艦体の近くまで読める程度。
const EMISSION_STRENGTH = 0.6;
// 自発光の軸方向の減衰長 [m]。出口径(約 2 m)の数倍に発光が集中する。
const EMISSION_DECAY_LENGTH = 5;
// 凝縮氷晶の単一散乱アルベド。吸収を持たない氷なので散乱がほぼすべて。
const SCATTER_ALBEDO = 0.9;
// Henyey–Greenstein の非対称因子。氷晶らしい前方散乱寄りの弱い異方性。
const SCATTER_PHASE_G = 0.35;
// 表示用の明るさ増幅係数。物理輝度そのままでは太陽光下の艦体より桁違いに暗いための意図的な
// 例外 — DEVELOP/SPEC/COMBAT.md「推進プルーム」に明言されている。
const PLUME_DISPLAY_BOOST = 6;
// 出力比に対する領域の長さの下限比。絞っても形は残り、やや短くなる。
const LENGTH_RATIO_FLOOR = 0.6;
// 出口近傍の揺れ。局所半径に対する振幅比と、出口からの減衰長 [m]。
const WOBBLE_FRACTION = 0.06;
const WOBBLE_DECAY_LENGTH = 3;
// 揺れと明滅の角周波数 [rad/s] と明滅の振幅比。位相は表示時刻で駆動する。
const WOBBLE_OMEGA_X = 5.1;
const WOBBLE_OMEGA_Y = 7.3;
const FLICKER_OMEGA = 11.0;
const FLICKER_FRACTION = 0.04;
// 領域を囲うメッシュの余裕率(揺れと丸め誤差の吸収ぶん)。
const BOUND_RADIUS_MARGIN = 1.12;
const BOUND_LENGTH_MARGIN = 1.05;
// 交差判定の係数が 0 へ落ちるときの除算ガードと、区間の端を表す十分大きな距離 [m]。
const GRAZE_EPS = 1e-9;
const FAR_DISTANCE = 1e15;
const TWO_PI = Math.PI * 2;

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

let sharedBounds: THREE.CylinderGeometry | null = null;

// 領域を囲う単位円柱(半径 1・長さ 1・ローカル +Z が排気方向、出口端は z = 0)。
function boundsGeometry(): THREE.CylinderGeometry {
  if (sharedBounds === null) {
    sharedBounds = new THREE.CylinderGeometry(1, 1, 1, 24, 1, false);
    sharedBounds.rotateX(Math.PI / 2);
    sharedBounds.translate(0, 0, 0.5);
  }
  return sharedBounds;
}

export class PlumeVolume {
  // 切頭円錐の幾何と排気の状態。円錐は「半径を出口断面から 0 まで遡った仮想頂点」を基準に
  // 持ち、軸距離 s' に対して半径は tanHalfAngle·s'。axialRange は仮想頂点から測った
  // 領域の軸距離の範囲 [m](x = 出口断面、y = 下流端)。sync が毎フレーム書き込む。
  private readonly coneApex: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly axis: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly axialRange: Vec2Uniform = uniform(new THREE.Vector2(1, 2));
  private readonly tanHalfAngle: FloatUniform = uniform(0.5);
  private readonly decayLength: FloatUniform = uniform(10);
  private readonly radialExponent: FloatUniform = uniform(2);
  private readonly ratio: FloatUniform = uniform(0);
  private readonly wobble: Vec3Uniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly flicker: FloatUniform = uniform(1);
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly wobblePhaseX: number;
  private readonly wobblePhaseY: number;
  private readonly flickerPhase: number;
  private readonly tmpApex = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpAxis = new THREE.Vector3();
  private readonly tmpBasisX = new THREE.Vector3();
  private readonly tmpBasisY = new THREE.Vector3();

  // 描画資源を組んで scene へ登録する。sunLight と bodyShadow は散乱光へ届く太陽光の
  // 供給源。ownerId と nozzleIndex は揺らぎの決定論的な位相を決める識別子。
  public constructor(
    scene: THREE.Scene,
    ownerId: string,
    nozzleIndex: number,
    private readonly sunLight: SunLight,
    private readonly bodyShadow: BodyShadow,
  ) {
    const phase = mulberry32(plumeNoiseSeed(ownerId, 0, nozzleIndex));
    this.wobblePhaseX = phase() * TWO_PI;
    this.wobblePhaseY = phase() * TWO_PI;
    this.flickerPhase = phase() * TWO_PI;

    // 裏面だけを描いて領域の出口側を画素へ出し、前後関係は深度に委ねる。
    this.material = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide,
    });
    this.material.colorNode = this.plumeNode();
    this.mesh = new THREE.Mesh(boundsGeometry(), this.material);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // anchor(+Z が排気方向の噴射口。ship root の world matrix 更新済み)へ、出力比 ratio(0..1)・
  // 外気密度 ambientDensity [kg/m³]・表示時刻 displayTime [s] のプルームを同期する。
  // ratio <= 0 なら隠す。
  public sync(anchor: THREE.Object3D, ratio: number, ambientDensity: number, displayTime: number): void {
    if (!(ratio > 0)) {
      this.hide();
      return;
    }
    const shape = plumeShape(ambientDensity);
    const plumeLength = shape.length * (LENGTH_RATIO_FLOOR + (1 - LENGTH_RATIO_FLOOR) * ratio);
    const apex = anchor.getWorldPosition(this.tmpApex);
    const quaternion = anchor.getWorldQuaternion(this.tmpQuat);
    const axis = this.tmpAxis.set(0, 0, 1).applyQuaternion(quaternion);

    // 仮想頂点は出口断面から半径 0 まで軸を遡った点。軸距離はそこから測る。
    const tipToExit = PLUME_NOZZLE_EXIT_RADIUS / shape.tanHalfAngle;
    this.coneApex.value.copy(apex).addScaledVector(axis, -tipToExit);
    this.axis.value.copy(axis);
    this.axialRange.value.set(tipToExit, tipToExit + plumeLength);
    this.tanHalfAngle.value = shape.tanHalfAngle;
    this.decayLength.value = shape.decayLength;
    this.radialExponent.value = shape.radialExponent;
    this.ratio.value = ratio;

    // 揺れの向きは排気軸に垂直な 2 方向を、決定論的な位相で合成する。
    const reference = Math.abs(axis.y) < 0.9 ? UP : RIGHT;
    const basisX = this.tmpBasisX.crossVectors(axis, reference).normalize();
    const basisY = this.tmpBasisY.crossVectors(axis, basisX);
    this.wobble.value.copy(basisX)
      .multiplyScalar(Math.sin(WOBBLE_OMEGA_X * displayTime + this.wobblePhaseX))
      .addScaledVector(basisY, Math.sin(WOBBLE_OMEGA_Y * displayTime + this.wobblePhaseY));
    this.flicker.value = 1 + FLICKER_FRACTION * Math.sin(FLICKER_OMEGA * displayTime + this.flickerPhase);

    // 囲いメッシュは領域全体を覆う円柱。プルーム本体はシェーダ側の円錐が切る。
    this.mesh.position.copy(apex);
    this.mesh.quaternion.copy(quaternion);
    const boundRadius = (PLUME_NOZZLE_EXIT_RADIUS + shape.tanHalfAngle * plumeLength)
      * BOUND_RADIUS_MARGIN;
    this.mesh.scale.set(boundRadius, boundRadius, plumeLength * BOUND_LENGTH_MARGIN);
    this.mesh.visible = true;
  }

  // プルームを隠す。
  public hide(): void {
    this.mesh.visible = false;
  }

  // メッシュを scene から外してマテリアルを解放する。囲いのジオメトリは全インスタンス共有。
  public dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.material.dispose();
  }

  // プルームの描画色(輝度と不透明度を併せた vec4)。交差区間を解いて積分するまでが
  // 1 画素。
  private plumeNode(): Vec4Node {
    return Fn(() => {
      const ray = viewRayAt(cameraProjectionMatrixInverse);
      const rayOrigin = cameraWorldMatrix.mul(vec4(ray.origin, 1)).xyz;
      const rayDir = normalize(cameraWorldMatrix.mul(vec4(ray.direction, 0)).xyz);

      const interval = this.intersectionAt(rayOrigin, rayDir);
      const radiance = vec3(0, 0, 0).toVar();
      const opacity = float(0).toVar();
      If(interval.far.greaterThan(interval.near), () => {
        const march = rayMarch(
          float(MARCH_STEPS),
          (fraction) => mix(interval.near, interval.far, fraction),
          (distance) => this.mediumAt(rayOrigin.add(rayDir.mul(distance)), rayDir),
        );
        radiance.assign(march.radiance.mul(PLUME_DISPLAY_BOOST));
        opacity.assign(float(1).sub(march.transmittance.x));
      });
      // α 合成では rgb × α が画面へ出るので、積んだ輝度が 1 度だけ効くよう不透明度で戻す。
      return vec4(radiance.div(max(opacity, 1e-6)), opacity);
    })() as Vec4Node;
  }

  // 視線と切頭円錐の交差区間を、視線の起点からの距離 [m] で返す。交わらない視線は
  // far <= near の空区間。
  private intersectionAt(rayOrigin: Vec3Node, rayDir: Vec3Node): { near: FloatNode; far: FloatNode } {
    const offset = rayOrigin.sub(this.coneApex);
    const alongDir = dot(rayDir, this.axis).toVar();
    const alongOff = dot(offset, this.axis).toVar();
    const slopeSq = this.tanHalfAngle.mul(this.tanHalfAngle).add(1);
    // 錐の内側は 2 次不等式 a·t² + 2b·t + c ≤ 0 で、その境界の根が入口と出口。
    const a = float(1).sub(slopeSq.mul(alongDir).mul(alongDir)).toVar();
    const b = dot(offset, rayDir).sub(slopeSq.mul(alongOff).mul(alongDir)).toVar();
    const c = dot(offset, offset).sub(slopeSq.mul(alongOff).mul(alongOff)).toVar();
    const discriminant = b.mul(b).sub(a.mul(c)).toVar();
    // 母線とほぼ平行(a → 0)でも符号を保った下限で除算を続行する — 根が遠方へ逃げるだけで、
    // 軸方向の板との交差で区間は正しく残る。
    const safeA = select(a.greaterThanEqual(0), max(a, float(GRAZE_EPS)), min(a, float(-GRAZE_EPS)));
    const span = sqrt(max(discriminant, 0));
    const lowRoot = min(b.negate().sub(span).div(safeA), b.negate().add(span).div(safeA)).toVar();
    const highRoot = max(b.negate().sub(span).div(safeA), b.negate().add(span).div(safeA)).toVar();
    // a < 0 では錐の内側が 2 根の外側(式は上下 2 枚の錐を解く) — 仮想頂点の向きへ開く
    // 側が対象なので、軸方向へ進む視線は遠い根の先、戻る視線は近い根の手前まで。判別式を
    // 割らない a < 0 では直線全体が錐の内側。
    const opensForward = alongDir.greaterThan(0);
    const wholeLine = a.lessThan(0).and(discriminant.lessThanEqual(0));
    const coneNear = select(wholeLine, float(-FAR_DISTANCE),
      select(a.lessThan(0), select(opensForward, highRoot, float(-FAR_DISTANCE)), lowRoot));
    const coneFar = select(wholeLine, float(FAR_DISTANCE),
      select(a.lessThan(0), select(opensForward, float(FAR_DISTANCE), lowRoot), highRoot));

    // 軸方向の板(axialRange)との交差。軸に平行な視線では板の両端が遠方へ逃げ、錐との
    // 交差が区間を決める — 板の外側に居る視線では板が遠方の 1 点に潰れ、空になる。
    const safeDir = select(
      alongDir.greaterThanEqual(0),
      max(alongDir, float(GRAZE_EPS)),
      min(alongDir, float(-GRAZE_EPS)),
    );
    const slabA = this.axialRange.x.sub(alongOff).div(safeDir);
    const slabB = this.axialRange.y.sub(alongOff).div(safeDir);
    const near = max(max(coneNear, min(slabA, slabB)), 0).toVar();
    const far = min(coneFar, max(slabA, slabB)).toVar();
    return { near, far };
  }

  // 視線上の 1 点における媒質。消散は排気密度に比例する無彩色で、視線へ足す放射は出口
  // 近傍の自発光と氷晶への太陽光散乱。
  private mediumAt(point: Vec3Node, rayDir: Vec3Node): MediumSample {
    const offset = point.sub(this.coneApex);
    const sPrime = max(dot(offset, this.axis), this.axialRange.x);
    const s = sPrime.sub(this.axialRange.x);
    const coneRadius = max(this.tanHalfAngle.mul(sPrime), PLUME_NOZZLE_EXIT_RADIUS);
    const radial = offset.sub(this.axis.mul(sPrime));
    // 出口近傍だけの揺れ。軸に垂直なずれとして載せ、下流では減衰する。
    const wobbleAmp = coneRadius.mul(WOBBLE_FRACTION).mul(exp(s.div(WOBBLE_DECAY_LENGTH).negate()));
    const shifted = radial.sub(this.wobble.mul(wobbleAmp));
    const radialSq = dot(shifted, shifted).div(coneRadius.mul(coneRadius));

    // 密度 ∝ 出力比 × 断面の希釈(出口断面距離/s')² × 軸方向の減衰 × 径方向プロファイル。
    const dilution = this.axialRange.x.div(sPrime);
    const density = this.ratio.mul(dilution.mul(dilution))
      .mul(exp(s.div(this.decayLength).negate()))
      .mul(exp(pow(radialSq, this.radialExponent.mul(0.5)).negate()));
    const extinction = vec3(density.mul(EXTINCTION_AT_EXIT));

    // 出口近傍の自発光。排気と同じ場所から出るので単位光学的厚みあたりで渡す — 薄い縁
    // では (1 − e^{−σΔs}) 側が小さくなり、光量は自動的に落ちる。
    const emission = vec3(EMISSION_COLOR[0], EMISSION_COLOR[1], EMISSION_COLOR[2])
      .mul(EMISSION_STRENGTH).mul(this.ratio).mul(this.flicker)
      .mul(exp(s.div(EMISSION_DECAY_LENGTH).negate()))
      .mul(exp(radialSq.negate()));

    // 氷晶への太陽光散乱。届く光は天体の影と距離の二乗で決まる。
    const toSun = this.sunLight.position.sub(point);
    const sunIrradiance = this.sunLight.intensity.div(max(dot(toSun, toSun), 1));
    const phaseG = float(SCATTER_PHASE_G);
    const denominator = max(
      phaseG.mul(phaseG).add(1).sub(phaseG.mul(dot(rayDir, normalize(toSun))).mul(2)), 1e-4);
    const phase = float(1).sub(phaseG.mul(phaseG)).div(denominator.mul(sqrt(denominator)));
    const scatter = this.sunLight.color.mul(sunIrradiance.div(PI))
      .mul(this.bodyShadow.transmittance(point))
      .mul(SCATTER_ALBEDO).mul(phase);

    return { extinction, source: emission.add(scatter) };
  }
}
