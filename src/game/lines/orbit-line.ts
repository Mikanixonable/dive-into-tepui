// OrbitalElements から軌道楕円を描画する。頂点は中心天体(OrbitalElements.center)相対座標のまま
// 保持し、フローティングオリジンによる Object3D 平行移動でその天体の ECI 位置へ置く。
// 焼き直すかどうかは「いま描かれている楕円が、いまの軌道要素の楕円から画面上何 px ずれて
// 見えるか」で決める。線の解像度そのものは Curve が決める。
import * as THREE from 'three/webgpu';
import { OrbitalElements, positionOnOrbit, trueAnomalyAt, velocityOnOrbit } from '../../physics/elements';
import { apparentSizePx } from '../../math/projection';
import { add, len, sub, v3, Vec3 } from '../../math/vec3';
import { FloatingOrigin } from '../camera/floating-origin';
import { Curve, CurveSampler, MAX_SAGITTA_PX } from '../../render/curve';
import { CameraScale } from '../../render/camera-scale';
import { LineStyle } from '../../render/line-style';

// 焼き直しを迫るずれ [px]。適応分割が目標にしているサジッタへ揃え、焼いた楕円が古いことに
// よるずれが、分割の粗さによるずれを上回らないようにする。
const MAX_STALE_PX = MAX_SAGITTA_PX;

// ずれを測る真近点角の数。楕円1周を等分して測るので、遠点側だけが動く形も直接拾える。
const PROBE_COUNT = 8;

// 離心近点角 E=t·2π を軌道要素で位置へ写す、閉曲線サンプラ。頂点は中心天体相対の ECI
// オフセットで、表示座標系の回転はカメラ側が担う。これにより回転座標系でも楕円が慣性空間上の
// 同じ軌道を保つ。
function ellipseSampler(el: OrbitalElements): CurveSampler {
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  return (t, out) => {
    const E = t * Math.PI * 2;
    const x = el.a * (Math.cos(E) - el.e);
    const y = b * Math.sin(E);
    out.set(
      el.pHat.x * x + el.qHat.x * y,
      el.pHat.y * x + el.qHat.y * y,
      el.pHat.z * x + el.qHat.z * y,
    );
  };
}

// 焼いてある楕円が、いまの軌道要素の楕円から画面上どれだけずれて見えるか [px]。
//
// 真近点角を PROBE_COUNT 等分した点でいまの楕円の位置・速度を取り、焼いた楕円の同じ向きの点と
// 比べる。真近点角を合わせることで軌道に沿った進みぶんが差から落ち、線の形が変わったぶんだけが
// 残る。頂点はどちらも中心天体相対で、平行移動は毎フレーム同じ値を使うので、ここで測った距離は
// そのまま画面上の距離になる。ずれはまず 3 次元空間の m で求め、その点の距離と画角で px へ直す
// — 先に画面座標へ落とすと、カメラの前後方向のずれ(深度テストで露呈する)が消えてしまう。
//
// 速度のずれは、そこから長半径が δa = Δv·T/π 変わることを通じて軌道の反対側が動く量になる。
// probe と probe の間で形が食い違っている場合をこれで捕まえる。
function stalenessPx(
  baked: OrbitalElements, el: OrbitalElements, fo: FloatingOrigin, cam: CameraScale,
): number {
  let worst = 0;
  for (let i = 0; i < PROBE_COUNT; i++) {
    const nu = (i / PROBE_COUNT) * Math.PI * 2;
    const probe = positionOnOrbit(el, nu);
    const nuBaked = trueAnomalyAt(baked, probe);
    const posError = len(sub(probe, positionOnOrbit(baked, nuBaked)));
    const velError = len(sub(velocityOnOrbit(el, nu), velocityOnOrbit(baked, nuBaked)));
    const world = fo.RtoThreeV3(add(el.centerState.r, probe));
    const mpp = cam.at(world.x, world.y, world.z);
    worst = Math.max(
      worst,
      apparentSizePx(posError, mpp),
      apparentSizePx((velError * baked.period) / Math.PI, mpp),
    );
  }
  return worst;
}

export class OrbitLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  // いま描いている楕円の軌道要素。sync だけが書き換える。
  private baked: OrbitalElements | null = null;

  // style.renderOrder は、この線が他の線と重なったときにどちらを手前へ描くかを決める —
  // 透明描画どうしの前後は描画順でしか決まらない。
  constructor(style: LineStyle) {
    this.curve = new Curve(style);
    this.line = this.curve.object;
  }

  setStyle(style: LineStyle): void {
    this.curve.setStyle(style);
  }

  // 不透明度を書き換える。天体からの距離に応じて描画側がフェードさせる。
  setOpacity(opacity: number): void {
    this.curve.setOpacity(opacity);
  }

  setColor(color: string | number): void {
    this.curve.setColor(color);
  }

  setRenderOrder(renderOrder: number): void {
    this.curve.setRenderOrder(renderOrder);
  }

  // 毎フレーム呼ぶ。fo = 描画のフローティングオリジン、camera = 画面上のサジッタを実距離へ
  // 換算するための描画カメラ。el が null なら軌道要素を持たない状態として非表示にする。
  sync(el: OrbitalElements | null, fo: FloatingOrigin, camera: THREE.Camera): void {
    if (!el || el.e >= 0.98 || !isFinite(el.a) || el.a <= 0) {
      this.baked = null;
      this.curve.setVisible(false);
      return;
    }

    // OrbitLineの頂点はECI相対、シーンもECI基準なので、回転クォータニオンは恒等にする。
    // 回転座標系はMapCameraの視点・姿勢で表現する。ここへ現在時刻のフレーム回転を掛けると、
    // 焼いた軌道形状だけが回転し続け、船の現在位置から外れていく。
    this.curve.setTransform(fo.RtoThreeV3(el.centerState.r));

    // 頂点は中心天体相対、平行移動は毎フレームの中心天体位置。中心が入れ替われば、別の天体を
    // 基準に焼いた形状をそのまま新しい中心へ動かすことになるので、ずれを測らずに焼き直す。
    const kept = this.baked;
    const baked = kept !== null
      && kept.center.id === el.center.id
      && stalenessPx(kept, el, fo, new CameraScale(camera)) <= MAX_STALE_PX
      ? kept
      : el;
    this.baked = baked;

    this.curve.setAnalyticCurve(ellipseSampler(baked), camera);
    this.curve.setVisible(true);
  }

  // 現在描いている楕円上のサンプル点列を ECI 絶対座標で返す(右クリックの当たり判定向け)。
  // 要素を持たない(非表示)間は空配列。
  samplePoints(count: number): readonly Vec3[] {
    const baked = this.baked;
    if (!baked) return [];
    const sampler = ellipseSampler(baked);
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      sampler(i / count, scratch);
      points.push(add(baked.centerState.r, v3(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  dispose(): void {
    this.curve.dispose();
  }
}
