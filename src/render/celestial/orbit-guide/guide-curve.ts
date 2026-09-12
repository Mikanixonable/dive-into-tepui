// ECI 絶対座標の曲線を1本の折れ線として描き、描画原点の移動へ毎フレーム追随させる。
// 描かれている曲線上の点を ECI 絶対座標で引ける。
import * as THREE from 'three/webgpu';
import { v3, Vec3 } from '../../../math/vec3';
import { Curve, CurveColorSampler, CurveKnots, CurveSampler } from '../../curve';
import { LineStyle } from '../../line-style';
import type { CameraFrame } from '../../camera/camera-frame';

// 描く曲線の形。閉じた式で書けるものと、離散サンプルの節点列の2つがある。sample と knots は
// 基準点(GuideCurveDisplay.origin)からの相対位置を返す。
export type GuideCurveShape =
  | { readonly kind: 'analytic'; readonly sample: CurveSampler; readonly initialSegments?: number }
  | { readonly kind: 'hermite'; readonly knots: CurveKnots };

// このフレームに描く曲線1本。曲線上の点列は shape と origin の参照が変わるまで引き直さないので、
// 形が同じフレームでは同じオブジェクトを渡し続けること。
export interface GuideCurveDisplay {
  // 頂点を相対化する基準点(ECI [m])。
  readonly origin: Vec3;
  readonly shape: GuideCurveShape;
  readonly style: LineStyle;
  // 線の中で色を変えるときの色。無ければ style.color 一色で塗る。
  readonly colorAt?: CurveColorSampler;
}

export class GuideCurve {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  // いま描いている曲線。非表示のあいだは null。
  private display: GuideCurveDisplay | null = null;
  // 直近に samplePoints が返した点列と、それを引いた曲線・基準点・分割数。
  private sampledPoints: readonly Vec3[] = [];
  private sampledShape: GuideCurveShape | null = null;
  private sampledOrigin: Vec3 | null = null;
  private sampledCount = 0;
  private readonly scratch = new THREE.Vector3();

  // 線を1本組む。style は最初のフレームの見た目で、以後は sync が渡す値で上書きされる。
  // maxVertices は収束しない曲線の頂点数の打ち切り。
  public constructor(style: LineStyle, maxVertices?: number) {
    this.curve = new Curve(style, maxVertices);
    this.line = this.curve.object;
  }

  // このフレームに描く曲線と見た目を反映し、描画原点の移動へ追随させる。display が null の
  // フレームは線が消え、samplePoints も空になる。
  public sync(display: GuideCurveDisplay | null, camera: CameraFrame): void {
    this.display = display;
    if (display === null) {
      this.curve.setVisible(false);
      return;
    }
    this.curve.setStyle(display.style);
    this.curve.setTransform(camera.floatingOrigin.RtoThreeV3(display.origin));
    // 頂点の配り方はカメラで変わるので、毎フレーム現在のカメラごと渡す。
    const viewportHeight = camera.viewport.height;
    const shape = display.shape;
    if (shape.kind === 'analytic') {
      this.curve.setAnalyticCurve(
        shape.sample, camera.camera, viewportHeight, shape.initialSegments, display.colorAt);
    } else {
      this.curve.setHermiteCurve(shape.knots, camera.camera, viewportHeight, display.colorAt);
    }
    this.curve.setVisible(true);
  }

  // 曲線上の t∈[0,1] の点を ECI 絶対座標で返す。直近の sync が曲線を渡したフレームでだけ呼べ、
  // 線が消えているあいだに呼ぶと例外を投げる。
  public pointAt(t: number): Vec3 {
    const display = this.display;
    if (display === null) throw new Error('GuideCurve: 線が消えているあいだは曲線上の点を引けない');
    const origin = display.origin;
    this.curve.sampleAt(t, this.scratch);
    return v3(origin.x + this.scratch.x, origin.y + this.scratch.y, origin.z + this.scratch.z);
  }

  // 曲線上の count+1 点を ECI 絶対座標で返す(両端を含む)。線が消えているあいだは空。
  // 曲線の形・基準点・count が変わるまでは同じ配列を返す。
  public samplePoints(count: number): readonly Vec3[] {
    const display = this.display;
    if (display === null) return [];
    // 曲線の形・基準点・分割数のどれかが変わったフレームだけ引き直す。
    if (display.shape !== this.sampledShape || display.origin !== this.sampledOrigin
      || count !== this.sampledCount) {
      const points: Vec3[] = [];
      for (let i = 0; i <= count; i++) points.push(this.pointAt(i / count));
      this.sampledPoints = points;
      this.sampledShape = display.shape;
      this.sampledOrigin = display.origin;
      this.sampledCount = count;
    }
    return this.sampledPoints;
  }

  // 描画資源を解放する。以後この線は描けない。
  public dispose(): void {
    this.curve.dispose();
  }
}
