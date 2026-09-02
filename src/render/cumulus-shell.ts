// 積雲(雲の場の R = 被覆率、G = 雲頂高度)を、地表の上に立つ不透明な雲として描くメッシュ。
// 分割段ラダーの各段ぶんの球を1枚のマテリアルで束ね、見かけ直径に応じて1段だけを見せる。殻の面へ
// 届いた視線は雲頂の高さ場まで下ろして交点を探し、そこの深度と法線を書く。場の texel より細かい
// 粒は天体固定のノイズで足す。陰影・遮蔽・逆二乗の減衰はすべてパイプラインが与える。
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, cameraPosition, cameraProjectionMatrix, clamp, dFdx, dFdy, dot, float, length,
  max, modelViewMatrix, modelWorldMatrixInverse, normalize, positionLocal, select, smoothstep,
  sqrt, step, texture as textureNode, transformNormalToView, vec3, vec4,
} from 'three/tsl';
import { BlueNoise } from './blue-noise';
import { DeferredTexture } from './deferred-texture';
import { sphereMeshUv, unitSphereGeometry } from './celestial-surface';
import { gradientNoise } from './cloud/gradient-noise';
import { eastAt, northAt } from './cloud/sphere-frame';
import { markLitOpaque } from './pipeline/lit-layer';
import { sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';
import type { FloatNode, Vec3Node, Vec4Node } from './tsl-types';

// 雲の場の G(雲頂高度)が張る高さ [m]。殻はその上限へ置く(`render/cloud/cloud-field.ts`)。
const CLOUD_TOP_SPAN = 15000;

// 不透明な積雲のアルベド。厚い雲の白さは多重散乱の産物で、単散乱アルベド ≈ 1・光学的厚みが
// 十分に大きい層の反射は拡散反射の極限へ漸近する。
const CUMULUS_ALBEDO = 0.8;
// 雲の粗さ。雲は拡散する面なので、粗さは最大になる。
const CUMULUS_ROUGHNESS = 1;

// 被覆率を二値化する境目と、その周りでディザへ渡す幅。**境目は場の被覆率の平均を動かさない
// ように選ぶ** — 実写を分離した `src/assets/cloud-field.png` では、これを超える texel の面積が
// 被覆率の平均 0.125(緯度余弦で重みを付けた面積平均)に一致する。場を差し替えたら測り直す。
// 幅は粒が届かない遠さでの縁の当たりを和らげるだけなので、狭く取って粒へ譲る。
const COVERAGE_THRESHOLD = 0.347;
const COVERAGE_DITHER_WIDTH = 0.04;

// ディザの閾値の段数。blue noise は 0..1 の両端を含むので、閾値は半段ぶん内側へ寄せて使う
// — 寄せないと、覆いの無い空へ閾値 0 の画素だけが雲として残り、覆い尽くされた面から閾値 1 の
// 画素が抜ける。
const DITHER_LEVELS = 256;

// 積雲の精細さの段。**値は保存された設定を読む鍵なので、段を足すときも既存の値を動かさない**
// — 番号を詰め直すと、保存済みの設定が黙って別の段を指す。
export const CUMULUS_DETAIL = { coarse: 1, standard: 2, fine: 3 } as const;
export type CumulusDetail = (typeof CUMULUS_DETAIL)[keyof typeof CUMULUS_DETAIL];

// 段ごとの、視線を雲頂へ下ろす刻み数。**1 増やすと場と粒を 1 回ずつ余分に引く**ので、
// G バッファパスの費用はここで決まる。粗い段では刻みが雲頂をまたぐ幅も広く、二分で締めても
// 縁と雲頂は段に割れて残る。
const MARCH_STEPS_OF_DETAIL: Readonly<Record<CumulusDetail, number>> = {
  [CUMULUS_DETAIL.coarse]: 3,
  [CUMULUS_DETAIL.standard]: 6,
  [CUMULUS_DETAIL.fine]: 12,
};

// 雲頂をまたいだ区間を締める二分の回数。1 回が刻み 1 回ぶんの費用だが、**段では動かさない**
// — 縁の粗さは締める前の区間の広さが決めるので、刻みを減らした段でここまで削ると二重に粗くなる。
const REFINE_STEPS = 3;

// 積雲の粒の一辺 [m]。場の texel(赤道 9.8 km)より細かく、かつ低軌道から見下ろして解像できる
// 大きさ(高度 900km 以下で全振幅)に取る。これより細かくすると、実際の積雲の塊には近づく代わりに
// 軌道上のどの構図でも 1 画素を切って消える。**場ではなく天体の半径から決まる**ので、場の解像度が
// 変わっても粒は動かない。
const CUMULUS_GRAIN_SIZE = 6000;
// 粒が被覆率と雲頂高度をそれぞれどれだけ振るか(どちらも場と同じ 0..1 の目盛り)。**被覆率へは
// 境目を通す前に足す** — 通したあとに足すと、覆いの無い空にも粒が雲を生やす。生成側が高周波を
// 持つようになったら、この 2 つを縮めて譲る。
const GRAIN_COVERAGE_DEPTH = 0.25;
const GRAIN_TOP_RELIEF = 0.15;
// 粒の 1 波長が何画素を切ったら消し始め、何画素まで残すか。標本化できない粒はモアレにしか
// ならないので、Nyquist の 2 画素へ落ちるまでに振幅を 0 へ渡す。
const GRAIN_FADE_MIN_PIXELS = 2;
const GRAIN_FADE_FULL_PIXELS = 4;

export class CumulusShell {
  private readonly fieldMap: DeferredTexture;
  // 精細さの段と、その段の刻み数まで展開したマテリアル。段は表示側が毎フレーム押し込む。
  private detail: CumulusDetail = CUMULUS_DETAIL.standard;
  private material: THREE.Material;
  private readonly blueNoise = new BlueNoise();
  // 殻を半径 1 とする物体空間での地表の半径。レイマーチの下端になる。
  private readonly groundRadius: number;
  // 粒の 1 rad あたりの山の数と、雲頂の勾配を測る差分の幅 [rad]。差分は粒の半波長ぶんなので、
  // 場の起伏と粒の起伏が同じ 1 つの法線に出る。
  private readonly grainFrequency: number;
  private readonly gradientAngle: number;
  // 段ごとの球。表示側が親の位置・スケール・自転姿勢を毎フレーム与える。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;

  // fieldUrl は雲の場、bodyRadius は殻を載せる天体の基準半径 [m]。親は半径 bodyRadius の球へ
  // 合わせたスケールを与えればよく、雲頂ぶんの膨らみはこの殻が持つ。
  public constructor(fieldUrl: string, bodyRadius: number) {
    this.fieldMap = new DeferredTexture(fieldUrl, THREE.NoColorSpace);
    // 正距円筒の経度は周期的なので、場は経度方向へ巻く。
    this.fieldMap.texture.wrapS = THREE.RepeatWrapping;
    const shellScale = 1 + CLOUD_TOP_SPAN / bodyRadius;
    this.groundRadius = 1 / shellScale;
    this.grainFrequency = bodyRadius / CUMULUS_GRAIN_SIZE;
    this.gradientAngle = 0.5 / this.grainFrequency;
    this.material = this.buildMaterial();

    const meshes = new Map<SphereLodLevel, THREE.Mesh>();
    for (const level of SPHERE_LOD_LADDER) {
      const mesh = new THREE.Mesh(unitSphereGeometry(level), this.material);
      mesh.scale.setScalar(shellScale);
      mesh.visible = false;
      markLitOpaque(mesh);
      meshes.set(level, mesh);
    }
    this.meshes = meshes;
  }

  // 雲の場のテクスチャ。解放までこの殻が持つ。
  public get field(): THREE.Texture { return this.fieldMap.texture; }

  // 殻の高度 [m]。場の雲頂高度 0..1 が張る高さでもある。
  public get topAltitude(): number { return CLOUD_TOP_SPAN; }

  // 全段のメッシュを parent の下へ置き、場の画像の取得を始める。
  public addTo(parent: THREE.Object3D): void {
    this.fieldMap.request();
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  // 積雲の精細さの段を置き直す。**段はレイマーチの刻み数としてグラフへ展開済み**なので、
  // 変わったらマテリアルを組み直して全段のメッシュへ張り替える。
  public setDetail(detail: CumulusDetail): void {
    if (detail === this.detail) return;
    this.detail = detail;
    const previous = this.material;
    this.material = this.buildMaterial();
    for (const mesh of this.meshes.values()) mesh.material = this.material;
    previous.dispose();
  }

  // 見かけ直径 [px] から分割段を選び、その段のメッシュだけを見せる。
  public syncLod(apparentDiameterPx: number): void {
    const level = sphereLodLevel(apparentDiameterPx);
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [meshLevel, mesh] of this.meshes) mesh.visible = meshLevel === level;
  }

  // 全段のメッシュを隠す。次の syncLod で段を選び直す。
  public hide(): void {
    this.activeLevel = null;
    for (const mesh of this.meshes.values()) mesh.visible = false;
  }

  // 全段のメッシュを親から外し、マテリアル・場・ディザのタイルを解放する。
  public dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.material.dispose();
    this.fieldMap.dispose();
    this.blueNoise.dispose();
  }

  // 雲頂の交点を書く不透明な白の標準マテリアル。深度と法線は 1 本のレイマーチを共有する。
  private buildMaterial(): THREE.Material {
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: CUMULUS_ROUGHNESS, metalness: 0,
    });
    const marched = this.marchedSurface().toVar();
    material.depthNode = marched.w;
    material.normalNode = marched.xyz;
    material.colorNode = vec3(CUMULUS_ALBEDO);
    return material;
  }

  // 殻の面へ届いた視線を雲頂の高さ場へ下ろし、交点の view 空間法線(xyz)と深度(w)を返す。
  //
  // **標本化は分岐の外で済ませ、捨てるのは最後にする** — テクスチャのミップ段は隣接画素との
  // 差から決まるので、条件分岐や discard のあとで読むと段が決まらない。
  private marchedSurface(): Vec4Node {
    return Fn(() => {
      const entry = positionLocal.toVar();
      const origin = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
      const direction = normalize(entry.sub(origin)).toVar();
      const threshold = this.ditherThreshold().toVar();
      const grainAmplitude = this.grainAmplitudeAt(normalize(entry)).toVar();

      // 殻に入ってから地表の球へ達するまで(掠めるなら殻を出るまで)を等分してたどる。
      const along = dot(entry, direction);
      const half = along.mul(along).sub(dot(entry, entry));
      const groundHalf = half.add(this.groundRadius * this.groundRadius);
      const marchEnd = max(select(
        groundHalf.greaterThan(0),
        along.negate().sub(sqrt(max(groundHalf, 0))),
        along.negate().add(sqrt(max(half.add(1), 0))),
      ), 0);
      const marchSteps = MARCH_STEPS_OF_DETAIL[this.detail];
      const stepLength = marchEnd.div(marchSteps);

      // 雲頂より内側へ入った最初の刻みを、その手前の刻みと一緒に覚える。
      const hit = float(0).toVar();
      const above = float(0).toVar();
      const below = marchEnd.toVar();
      for (let stepIndex = 1; stepIndex <= marchSteps; stepIndex++) {
        const distance = stepLength.mul(stepIndex);
        const inside = this.clearanceAt(
          entry.add(direction.mul(distance)), threshold, grainAmplitude).lessThan(0);
        If(inside.and(hit.lessThan(0.5)), () => {
          hit.assign(1);
          below.assign(distance);
        });
        If(hit.lessThan(0.5), () => { above.assign(distance); });
      }
      // 雲頂をまたいだ区間を二分して縁を締める。
      for (let refineIndex = 0; refineIndex < REFINE_STEPS; refineIndex++) {
        const middle = above.add(below).mul(0.5);
        const inside = this.clearanceAt(
          entry.add(direction.mul(middle)), threshold, grainAmplitude).lessThan(0);
        If(inside, () => { below.assign(middle); }).Else(() => { above.assign(middle); });
      }

      const hitPoint = entry.add(direction.mul(below)).toVar();
      const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(hitPoint, 1)));
      const viewNormal = normalize(transformNormalToView(this.cloudTopNormalAt(hitPoint, grainAmplitude)));
      Discard(hit.lessThan(0.5));
      return vec4(viewNormal, clip.z.div(clip.w));
    })();
  }

  // 物体空間の点が、その柱の雲頂からどれだけ外に居るか。負なら雲の中。
  private clearanceAt(point: Vec3Node, threshold: FloatNode, grainAmplitude: FloatNode): FloatNode {
    const radius = max(length(point), 1e-6);
    const direction = point.div(radius);
    const cloud = this.fieldAt(direction);
    const grain = this.grainAt(direction, grainAmplitude);
    // 粒は覆いの縁を texel より細かく千切る。
    const present = step(
      threshold, this.opaqueFractionOf(cloud.r.add(grain.mul(GRAIN_COVERAGE_DEPTH))));
    // **覆いの無い柱は雲頂を地表へ落とさず、視線を素通しにする** — 落とすと、地表へ達した
    // 刻みが丸めの符号次第で雲頂の内側と判定され、地表いちめんに粒が湧く。
    const clearance = radius.sub(this.cloudTopRadiusOf(this.cloudTopOf(cloud.g, grain)));
    return select(present.greaterThan(0.5), clearance, float(1));
  }

  // 交点における雲頂面の法線(物体空間)。**覆いの有無は勾配へ入れない** — 柱ごとに断ち切られた
  // 崖ではなく、雲頂そのものの起伏を法線に出す。
  private cloudTopNormalAt(hitPoint: Vec3Node, grainAmplitude: FloatNode): Vec3Node {
    const up = hitPoint.div(max(length(hitPoint), 1e-6));
    const east = eastAt(up);
    const north = northAt(up);
    // その向きの雲頂(物体空間の半径)。
    const topAt = (direction: Vec3Node): FloatNode => this.cloudTopRadiusOf(
      this.cloudTopOf(this.fieldAt(direction).g, this.grainAt(direction, grainAmplitude)));
    // **中心の高さは交点の中心距離ではなく雲頂を引き直して測る** — 締めた交点は雲頂より内側へ
    // 食い込んでいて、中心距離を高さに使うと食い込みが両方向の傾きへ同じ下駄として乗る。掠める
    // 視線ほど刻みが長く食い込みも深いので、リム際で法線が倒れて夜側の雲が光る。
    const here = topAt(up);
    // 東と北へ粒の半波長ぶん振った雲頂との差が、そのまま接平面での傾き。
    const slopeEast = topAt(normalize(up.add(east.mul(this.gradientAngle))))
      .sub(here).div(this.gradientAngle);
    const slopeNorth = topAt(normalize(up.add(north.mul(this.gradientAngle))))
      .sub(here).div(this.gradientAngle);
    return normalize(up.sub(east.mul(slopeEast)).sub(north.mul(slopeNorth)));
  }

  // 場の雲頂高度へ粒の起伏を重ねた雲頂高度 0..1。
  private cloudTopOf(fieldTop: FloatNode, grain: FloatNode): FloatNode {
    return clamp(fieldTop.add(grain.mul(GRAIN_TOP_RELIEF)), 0, 1);
  }

  // 雲頂高度 0..1 を、殻を半径 1 とする物体空間の半径へ直す。
  private cloudTopRadiusOf(cloudTop: FloatNode): FloatNode {
    return cloudTop.mul(1 - this.groundRadius).add(this.groundRadius);
  }

  // 天体固定の単位方向における場の値。
  private fieldAt(direction: Vec3Node): Vec4Node {
    return textureNode(this.fieldMap.texture, sphereMeshUv(direction));
  }

  // 天体固定の単位方向における粒、おおむね −1..1 に amplitude を掛けたもの。
  private grainAt(direction: Vec3Node, amplitude: FloatNode): FloatNode {
    return gradientNoise(direction.mul(this.grainFrequency)).mul(amplitude);
  }

  // 粒の振幅。**1 画素が張る角は画面上の変化率から引く** — 天体の見かけ直径から出すと、
  // 大気圏のすぐ上から見下ろす構図で 1 桁ずれる。解像できない細かさになったら 0 へ落ちるので、
  // 引きの構図では場の分布だけが残る。
  private grainAmplitudeAt(entryDirection: Vec3Node): FloatNode {
    const pixelAngle = max(length(dFdx(entryDirection)), length(dFdy(entryDirection)));
    const wavelengthPixels = max(pixelAngle.mul(this.grainFrequency), 1e-9).reciprocal();
    return smoothstep(GRAIN_FADE_MIN_PIXELS, GRAIN_FADE_FULL_PIXELS, wavelengthPixels);
  }

  // 被覆率を、覆い尽くされている割合 0..1 へ伸ばしたもの。
  private opaqueFractionOf(coverage: FloatNode): FloatNode {
    return clamp(
      coverage.sub(COVERAGE_THRESHOLD - COVERAGE_DITHER_WIDTH / 2).div(COVERAGE_DITHER_WIDTH), 0, 1);
  }

  // 画素ごとに固定の、覆い尽くされている割合と比べるディザの閾値。
  private ditherThreshold(): FloatNode {
    return this.blueNoise.atScreenPixel()
      .mul((DITHER_LEVELS - 1) / DITHER_LEVELS).add(0.5 / DITHER_LEVELS);
  }
}
