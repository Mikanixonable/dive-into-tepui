// OrbitalElements から軌道楕円を描画する。頂点は中心天体(OrbitalElements.center)相対座標のまま
// 保持し、フローティングオリジンによる Object3D 平行移動でその天体の ECI 位置へ置く。
import * as THREE from 'three/webgpu';
import { OrbitalElements } from '../../physics/elements';
import { add, v3, Vec3 } from '../../math/vec3';
import { FloatingOrigin } from '../camera/floating-origin';
import { Curve, CurveSampler } from '../../render/curve';
import { LineStyle } from '../../render/line-style';

// 離心近点角 E=t·2π を、中心天体相対の ECI オフセットへ写す閉曲線サンプラ。
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

export class EllipseLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  // いま描いている楕円の軌道要素。非表示のあいだは null。
  private elements: OrbitalElements | null = null;

  // 線を1本組む。最初の sync まで頂点を持たないので、その間は隠れたままになる。
  constructor(style: LineStyle) {
    this.curve = new Curve(style);
    this.line = this.curve.object;
  }

  // 線の色・不透明度・描画順を差し替える。
  setStyle(style: LineStyle): void {
    this.curve.setStyle(style);
  }

  // 不透明度 [0,1] を書き換える。
  setOpacity(opacity: number): void {
    this.curve.setOpacity(opacity);
  }

  // 曲線を消し、当たり判定向けのサンプル点も空にする(次回 sync までは何も返さない)。
  hide(): void {
    this.elements = null;
    this.curve.setVisible(false);
  }

  // 毎フレーム呼ぶ。楕円として描けない要素(離心率が 1 に近い、a が非有限か非正)を渡すと
  // hide() と同じ状態になる。
  sync(el: OrbitalElements, fo: FloatingOrigin, camera: THREE.Camera): void {
    if (el.e >= 0.98 || !isFinite(el.a) || el.a <= 0) {
      this.hide();
      return;
    }

    // 頂点もシーンも ECI 基準なので回転は掛けない。ここへフレーム回転を掛けると、焼いた
    // 軌道形状だけが回り続けて船の現在位置から外れていく。
    this.curve.setTransform(fo.RtoThreeV3(el.centerState.r));
    this.elements = el;
    this.curve.setAnalyticCurve(ellipseSampler(el), camera);
    this.curve.setVisible(true);
  }

  // 現在描いている楕円上のサンプル点列を ECI 絶対座標で返す(右クリックの当たり判定向け)。
  // 要素を持たない(非表示)間は空配列。
  samplePoints(count: number): readonly Vec3[] {
    const el = this.elements;
    if (!el) return [];
    const sampler = ellipseSampler(el);
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      sampler(i / count, scratch);
      points.push(add(el.centerState.r, v3(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  // 描画資源を解放する。以後この線は描けない。
  dispose(): void {
    this.curve.dispose();
  }
}
