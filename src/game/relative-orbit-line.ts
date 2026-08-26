// 非質量ターゲット(艦・基地)基準時、戦闘ビューでケプラー軌道要素からは描けない軌道楕円の
// 代わりに描く、対象とのいまの位置を結ぶ解析的な直線。OrbitLine の兄弟だが、未来予測には
// 依存しない — 双方の「いま」の位置さえ分かれば描けるので、対象の未来予測が伸びていない状況
// (戦闘ビューでは navTargetReader が立たず、ターゲットの predicted が常に null になりうる)
// でも常に描ける。対象のいまの位置を平行移動の基準にする点は OrbitLine が中心天体のいまの
// 位置を基準にするのと同じ考え方。
import * as THREE from 'three/webgpu';
import { add, sub, v3, Vec3 } from '../physics/vec3';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveKnots } from '../render/curve';
import { LineStyle } from '../render/line-style';

export class RelativeOrbitLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  // 直近に curve.setTransform へ渡した対象の位置(ECI)。samplePoints の絶対座標化に使う。
  private origin: Vec3 | null = null;

  constructor(style: LineStyle) {
    this.curve = new Curve({ style });
    this.line = this.curve.object;
  }

  setStyle(style: LineStyle): void {
    this.curve.setStyle(style);
  }

  // 曲線を消し、当たり判定向けのサンプル点も空にする(次回 sync までは何も返さない)。
  hide(): void {
    this.curve.clear();
    this.origin = null;
  }

  // selfPos と targetPos を結ぶ直線を組む。
  sync(selfPos: Vec3, targetPos: Vec3, fo: FloatingOrigin, camera: THREE.Camera): void {
    const rel = sub(selfPos, targetPos);
    const knots: CurveKnots = {
      ts: [0, 1],
      positions: [0, 0, 0, rel.x, rel.y, rel.z],
      // 両端の接線を弦そのものにすると、3次エルミートが弦と一致する直線に落ちる。
      tangents: [rel.x, rel.y, rel.z, rel.x, rel.y, rel.z],
    };
    this.origin = targetPos;
    this.curve.setTransform(fo.RtoThreeV3(targetPos));
    this.curve.setHermiteCurve(knots, { revision: knots, camera });
    this.curve.setVisible(true);
  }

  // 直近に描いた線分上のサンプル点列を ECI 絶対座標で返す(右クリックの当たり判定向け)。
  // 曲線を持たない(非表示)間は空配列。
  samplePoints(count: number): readonly Vec3[] {
    const origin = this.origin;
    if (origin === null) return [];
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      this.curve.sampleAt(i / count, scratch);
      points.push(add(origin, v3(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  dispose(): void {
    this.curve.dispose();
  }
}
