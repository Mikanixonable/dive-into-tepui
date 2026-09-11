// OrbitalElements から軌道楕円を1本描く。楕円は中心天体の ECI 位置に付いて動く。
import * as THREE from 'three/webgpu';
import { OrbitalElements } from '../../physics/elements';
import { add, v3, Vec3 } from '../../math/vec3';
import type { CameraFrame } from '../camera/camera-frame';
import { Curve, CurveSampler } from '../curve';
import { LineStyle } from '../line-style';

// 離心近点角 E=t·2π を、中心天体相対の ECI オフセットへ写す閉曲線サンプラ。
function ellipseSampler(el: OrbitalElements): CurveSampler {
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  return (t, out) => {
    // 軌道面内の座標。原点は焦点(中心天体)、x は近点方向。
    const E = t * Math.PI * 2;
    const x = el.a * (Math.cos(E) - el.e);
    const y = b * Math.sin(E);
    // 軌道面の基底 pHat・qHat で ECI の向きへ写す。
    out.set(
      el.pHat.x * x + el.qHat.x * y,
      el.pHat.y * x + el.qHat.y * y,
      el.pHat.z * x + el.qHat.z * y,
    );
  };
}

export class EllipseLine {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  // いま描いている楕円の軌道要素。線が消えているあいだは null。
  private elements: OrbitalElements | null = null;

  // 線を1本組む。style は最初のフレームの見た目で、以後は sync が渡す値で上書きされる。
  public constructor(style: LineStyle) {
    this.curve = new Curve(style);
    this.line = this.curve.object;
  }

  // このフレームに描く楕円と見た目を反映する。elements が null か、楕円として描けない要素
  // (離心率が 1 に近い、a が非有限か非正)のときは線が消え、samplePoints も空になる。
  public sync(elements: OrbitalElements | null, style: LineStyle, camera: CameraFrame): void {
    this.curve.setStyle(style);
    if (elements === null || elements.e >= 0.98 || !isFinite(elements.a) || elements.a <= 0) {
      this.elements = null;
      this.curve.setVisible(false);
      return;
    }

    // 頂点もシーンも ECI 基準なので回転は掛けない。ここへフレーム回転を掛けると、焼いた
    // 軌道形状だけが回り続けて船の現在位置から外れていく。
    this.curve.setTransform(camera.floatingOrigin.RtoThreeV3(elements.centerState.r));
    this.elements = elements;
    this.curve.setAnalyticCurve(ellipseSampler(elements), camera.camera, camera.viewport.height);
    this.curve.setVisible(true);
  }

  // 現在描いている楕円を count 等分した count+1 点(末尾は先頭と重なる)を ECI 絶対座標で返す。
  // 楕円が消えている間は空配列。
  public samplePoints(count: number): readonly Vec3[] {
    const el = this.elements;
    if (!el) return [];
    const sampler = ellipseSampler(el);
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    // 中心天体相対の点へ、中心天体の ECI 位置を足し戻す。
    for (let i = 0; i <= count; i++) {
      sampler(i / count, scratch);
      points.push(add(el.centerState.r, v3(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  // 描画資源を解放する。以後この線は描けない。
  public dispose(): void {
    this.curve.dispose();
  }
}
