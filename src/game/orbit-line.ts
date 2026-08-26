// OrbitalElements から軌道楕円を描画する。頂点は中心天体(OrbitalElements.center)相対座標のまま保持し、
// フローティングオリジンによる Object3D 平行移動でその天体の ECI 位置へ置く。どの天体を
// 中心に描くかは OrbitalElements 自身が持つため、呼び出し側が外側で選び直すことはできない。
// 楕円はそのフレームに渡された軌道要素だけから組み立てるので、要素が動けば楕円も遅れずに動く。
// 解像度そのものの決定(画面上のサジッタに応じた適応分割)は Curve に委ねる。楕円は天体自身の
// 現在位置を貫くが、天体メッシュは不透明・深度書き込み有りで先に描かれるため、深度テストだけで
// 天体が手前に残る。
import * as THREE from 'three/webgpu';
import { OrbitalElements } from '../physics/elements';
import { add, v3, Vec3 } from '../physics/vec3';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveSampler } from '../render/curve';
import { LineStyle } from '../render/line-style';

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

export class OrbitLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  // 直近の sync が描いた軌道要素。samplePoints が描かれている楕円と同じ点列を返すために持つ。
  private drawn: OrbitalElements | null = null;

  // style.renderOrder は、この線が他の線と重なったときにどちらを手前へ描くかを決める —
  // 透明描画どうしの前後は描画順でしか決まらない。
  constructor(style: LineStyle) {
    this.curve = new Curve({ style });
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
      this.drawn = null;
      this.curve.setVisible(false);
      return;
    }

    // OrbitLineの頂点はECI相対、シーンもECI基準なので、回転クォータニオンは恒等にする。
    // 回転座標系はMapCameraの視点・姿勢で表現する。ここへ現在時刻のフレーム回転を掛けると、
    // 焼いた軌道形状だけが回転し続け、船の現在位置から外れていく。
    this.curve.setTransform(fo.RtoThreeV3(el.center.state.r));
    this.drawn = el;

    // サンプラはこのフレームの要素を閉じ込めた新しいクロージャなので、それ自身が
    // 「曲線の中身が変わった」ことを表す revision になる。
    const sampler = ellipseSampler(el);
    this.curve.setAnalyticCurve(sampler, { revision: sampler, camera });
    this.curve.setVisible(true);
  }

  // 現在描いている楕円上のサンプル点列を ECI 絶対座標で返す(右クリックの当たり判定向け)。
  // 要素を持たない(非表示)間は空配列。
  samplePoints(count: number): readonly Vec3[] {
    const el = this.drawn;
    if (!el) return [];
    const sampler = ellipseSampler(el);
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      sampler(i / count, scratch);
      points.push(add(el.center.state.r, v3(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  dispose(): void {
    this.curve.dispose();
  }
}
