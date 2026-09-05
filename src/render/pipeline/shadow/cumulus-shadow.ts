// 積雲の殻が落とす影。描画座標の点へ恒星の直射光がどれだけ届くかを、雲の層を抜ける光路の
// 消散の TSL グラフとして返す。影を落とす殻 1 体ぶんを毎フレーム set() で受ける。
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, clamp, dot, exp, float, fract, greaterThan, int, length, log, log2, max, min,
  normalize, select, sqrt, texture, uniform, vec2, vec4,
} from 'three/tsl';
import { sphereMeshUv } from '../../celestial-surface';
import {
  CLOUD_TOP_UNCERTAINTY, CUMULUS_GRAIN_SIZE, cloudTopOf, grainAmplitudeForWidth, grainAt,
  opaqueFractionOf,
} from '../../cloud/cumulus-shape';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform, Vec4Node } from '../../tsl-types';
import type { SunLight } from '../sun-light';

// 影を落とす積雲の殻 1 体ぶん。center は描画座標の天体中心、surfaceRadius は雲の高度の基準
// 半径 [m]、axes は天体固定の半軸 [m]、topAltitude は殻の高さ [m]、bodyFromWorld は描画座標の
// ベクトルを天体固定の向きへ回す行列、field は雲の場(R = 被覆率、G = 雲頂高度 / topAltitude)。
export interface ShadowCumulus {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly axes: THREE.Vector3;
  readonly topAltitude: number;
  readonly bodyFromWorld: THREE.Matrix4;
  readonly field: THREE.Texture;
}

// 光路のタップ数。
const SHADOW_TAPS = 6;
// 光路をたどる長さの上限 [m]。恒星が地平線へ寄るほど層を抜けるまでの距離は伸び、昼夜境界の
// 真上で発散する。
const MAX_LIGHT_PATH = 3e5;
// 覆われている割合から柱の光学的厚みへ直すときの上限。割合 1 では厚みが発散する。
const MAX_COVERAGE = 0.99;
// 光路 1 歩が代表する幅を、場のぼかしへ何倍で写すか。**等倍では足りない** — 隣り合うタップの
// 覆う範囲が接するだけなので、あいだに影の抜けた縞が残る。
const STEP_BLUR = 2;

// 雲の場を持たないフレームでも同じグラフが走るので、被覆率 0 の写しを結んでおく。
// **読み方の契約は本物の場と揃える** — グラフはここに結んだテクスチャのフィルタと巻きから
// 組まれるので、既定の Nearest のままだと補間の無い texel フェッチが焼き込まれ、あとで本物へ
// 差し替えても格子が出たままになる。
const EMPTY_FIELD = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
EMPTY_FIELD.minFilter = THREE.LinearMipmapLinearFilter;
EMPTY_FIELD.magFilter = THREE.LinearFilter;
EMPTY_FIELD.wrapS = THREE.RepeatWrapping;
EMPTY_FIELD.needsUpdate = true;

export class CumulusShadow {
  private readonly center: Vec3Uniform;
  private readonly surfaceRadius: FloatUniform;
  private readonly axes: Vec3Uniform;
  private readonly topAltitude: FloatUniform;
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;
  // 雲の場。set が value を差し替えると、sample() で枝分かれした先へも同じ写しが届く。
  private readonly field = texture(EMPTY_FIELD);

  constructor(private readonly sunLight: SunLight) {
    this.center = uniform(new THREE.Vector3());
    this.surfaceRadius = uniform(0);
    // 場を持たないフレームでも殻の空間への写しは走るので、半軸は 0 で割らない値から始める。
    this.axes = uniform(new THREE.Vector3(1, 1, 1));
    this.topAltitude = uniform(0);
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
  }

  // このフレームに影を落とす殻。null なら雲の影は落ちない。
  set(cumulus: ShadowCumulus | null): void {
    this.active.value = cumulus === null ? 0 : 1;
    if (cumulus === null) return;
    this.center.value.copy(cumulus.center);
    this.surfaceRadius.value = cumulus.surfaceRadius;
    this.axes.value.copy(cumulus.axes);
    this.topAltitude.value = cumulus.topAltitude;
    this.bodyFromWorld.value.copy(cumulus.bodyFromWorld);
    this.field.value = cumulus.field;
  }

  // このフレームに積雲の殻の影があるか。
  casts(): boolean { return this.active.value > 0; }

  // 受け手から恒星へ向かう光路を、雲の層(地表から殻の上端まで)を抜けるまで殻の空間
  // (toShellSpace)でたどり、柱の雲頂より下を通る割合ぶんの消散を積む。
  //
  // 柱の光学的厚みは、覆われた割合 c を通り抜けない確率と読んで τ = −ln(1 − c) と取る。割合は殻が
  // 雲を立てるのと同じ規則(cloud/cumulus-shape.ts)から引くので、影は殻のシルエットの下へ落ちる。
  // 厚みは光路長ではなく稼いだ高度で配るので、柱を 1 本抜ける合計はどれだけ斜めでも τ に一致する。
  // 受け手が自分の柱の雲頂の高さにいるときは、その柱で自分を陰らせない(receiverFloorAltitude)。
  // footprint は受け手の位置で画面 1 px が張る実寸 [m] で、場を引く mip 段と粒の振幅を決める。
  transmittance(worldPos: Vec3Node, footprint: FloatNode): FloatNode {
    const sunDir = this.sunLight.directionFrom(worldPos);
    return Fn(() => {
      const transmittance = float(1).toVar();
      // 場を持たないフレームで、タップぶんのフェッチを丸ごと飛ばす。
      If(greaterThan(this.active, 0.5), () => {
        const bodyRadius = max(this.surfaceRadius, 1);
        const offset = this.toShellSpace(worldPos.sub(this.center));
        // **光路の向きも殻の空間で取り直す** — 半軸で割ると向きが傾くので、描画座標の恒星方向を
        // そのまま使うと、光路が層を斜めに横切る量が緯度ぶんずれる。
        const rayDir = normalize(this.toShellSpace(sunDir));
        // 殻の上端の半径。地表が 1 なので、高さは基準半径で割った目盛りで乗る。
        const shellRadius = float(1).add(this.topAltitude.div(bodyRadius));
        const along = dot(offset, rayDir);
        // 光路が殻を出るまでの距離。殻より上の受け手では負になり、影は落ちない。長さは殻の空間の
        // 半径 1 を基準半径として測る(真の実寸との差は扁平率ぶんで、mip 段と上限にしか効かない)。
        const exit = sqrt(max(shellRadius.mul(shellRadius).sub(dot(offset, offset)).add(along.mul(along)), 0))
          .sub(along).mul(bodyRadius);
        const stepLength = clamp(exit, 0, MAX_LIGHT_PATH).div(SHADOW_TAPS);
        // タップ 1 回が代表する実寸。**歩がまたいだ柱は 1 タップが代表する**ので、画面 1 px の
        // 実寸と光路 1 歩の長さのうち粗いほうを取る。場の mip 段も粒の振幅もこの幅が決める。
        const sampleWidth = max(footprint, stepLength.mul(STEP_BLUR));
        const lod = this.fieldLod(sampleWidth);
        const grainAmplitude = grainAmplitudeForWidth(sampleWidth).toVar();
        const grainFrequency = bodyRadius.div(CUMULUS_GRAIN_SIZE);
        const floorAltitude = this.receiverFloorAltitude(offset, lod, bodyRadius);
        const stepRadius = stepLength.div(bodyRadius);
        const opticalDepth = float(0).toVar();
        Loop({ start: 0, end: SHADOW_TAPS, type: 'int', condition: '<' }, ({ i }) => {
          const sampleOffset = offset.add(rayDir.mul(stepRadius.mul(float(i).add(0.5))));
          const sampleRadius = max(length(sampleOffset), 1e-6);
          const up = sampleOffset.div(sampleRadius);
          const altitude = max(sampleRadius.sub(1).mul(bodyRadius), floorAltitude);
          const cloud = this.fieldAt(up, lod);
          // 粒は引けるときだけ引く。タップの数だけノイズを引くので、振幅が 0 になる遠さでは分岐ごと
          // 飛ばして費用を戻す(select では両辺が評価されて飛ばない)。
          const grain = float(0).toVar();
          If(greaterThan(grainAmplitude, 0), () => {
            grain.assign(grainAt(up, grainFrequency, grainAmplitude));
          });
          const cloudTop = cloudTopOf(cloud.g, grain).mul(this.topAltitude);
          const rise = max(dot(rayDir, up), 0).mul(stepLength);
          const columnDepth = log(min(
            opaqueFractionOf(cloud.r, grain), MAX_COVERAGE).oneMinus()).negate();
          // **1 歩が雲頂をまたぐ割合で配る** — 雲頂の内外を 1 点で判じると、歩の数だけの段に
          // 割れた縞が影に出る。タップは歩の中点なので、稼いだ高度の半分が前後に広がる。
          const inside = clamp(cloudTop.sub(altitude).div(max(rise, 1)).add(0.5), 0, 1);
          opticalDepth.addAssign(columnDepth.mul(rise).mul(inside).div(max(cloudTop, 1)));
        });
        transmittance.assign(exp(opticalDepth.negate()));
      });
      return transmittance;
    })();
  }

  // 描画座標のベクトルを、殻が雲を立てるのと同じ空間へ写す — 地表が半径 1、雲頂が半径
  // 1 + 雲頂高度 / 基準半径 の球面に乗る空間。天体固定の向きへ回してから半軸で割る。
  // 真球のつもりで中心距離から高度を測ると、扁平な天体では緯度ぶんの下駄が乗る(地球なら極で
  // 21 km — 雲の層 15 km より厚いので、極の雲頂が自分の柱の内側に沈み、恒星の向きによらず影になる)。
  private toShellSpace(worldVec: Vec3Node): Vec3Node {
    return this.bodyFromWorld.mul(vec4(worldVec, 0)).xyz.div(this.axes);
  }

  // 場を引く mip 段。タップ 1 回が代表する実寸 sampleWidth [m] を、場の texel が覆う実寸と比べて
  // 決める。texel の実寸は正距円筒に固有の式で、赤道の 1 行(2πR を幅で割る)を基準に取る — 極では
  // 1 texel の経度方向の実寸がこれより cos(緯度) ぶん狭いので、段はそのぶん細かい側へ寄る。
  private fieldLod(sampleWidth: FloatNode): FloatNode {
    // 寸法を返すノードは型引数を持たないので、成分を取れる形へ直してから読む。
    const fieldWidth = (this.field.size(int(0)) as THREE.Node<'uvec2'>).x;
    const texelWorld = this.surfaceRadius.mul(2 * Math.PI).div(float(fieldWidth));
    return max(log2(sampleWidth.div(max(texelWorld, 1))), 0);
  }

  // 殻の空間の単位方向 up における場を、mip 段を指定して引く。段を明示で渡すのは、光路のタップの
  // uv が画面の隣の画素と続いておらず、画面微分から選ばれる段が当てにならないため。uv は殻が読むのと
  // 同じ球メッシュの uv(sphereMeshUv)で引く — 別の規則で読むと、影が雲のシルエットから外れる。
  private fieldAt(up: Vec3Node, lod: FloatNode): Vec4Node {
    const uv = sphereMeshUv(up);
    return this.field.sample(vec2(fract(uv.x), uv.y)).level(lod);
  }

  // 光路のタップの高度に張る床 [m]。受け手が自分の柱の雲頂の高さにあるなら、その雲頂の高さ。
  // offset は天体中心から受け手へのベクトル(殻の空間)、bodyRadius は殻の空間の半径 1 が
  // 張る高度の目盛り [m]。
  private receiverFloorAltitude(offset: Vec3Node, lod: FloatNode, bodyRadius: FloatNode): FloatNode {
    const radius = max(length(offset), 1e-6);
    const altitude = max(radius.sub(1), 0).mul(bodyRadius);
    const top = this.fieldAt(offset.div(radius), lod).g.mul(this.topAltitude);
    const uncertainty = this.topAltitude.mul(CLOUD_TOP_UNCERTAINTY);
    return select(greaterThan(altitude, top.sub(uncertainty)), top, float(0));
  }
}
