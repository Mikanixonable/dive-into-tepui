// RingSystemDefの物理データを、マップビューと戦闘ビューで共通のRingVisualへ同期する。
// 環の姿勢は極軸だけで決まり、非軸対称アークは本体の自転位相には追従させない。
import * as THREE from 'three/webgpu';
import { spinOrientation } from '../../physics/body-orientation';
import { RingBandDef, RingSystemDef } from '../../physics/solar-system';
import { Vec3 } from '../../physics/vec3';
import {
  createAnnulusRing,
  createRingLine,
  createTorusRing,
  RingVisual,
  RingVisualState,
} from '../../render/ring';
import { ringPixelCoverage } from '../../render/screen-lod';
import { ScaleFn } from '../camera/camera-system';

// thickness===0 の帯を annulus(面)/line(線)どちらで表すかの分かれ目[m]。土星の主環群や
// 天王星のダスト帯(ζ/ν/μ)のような数千km幅の帯は annulus のまま実幅を見せ、天王星の
// 名前付きringlet(数km〜数十km)のように常にサブピクセル同然の帯は、GPUラスタライズで
// 消えうる面を避けて常に線1本で表す。
const RING_LINE_WIDTH_THRESHOLD_M = 1_500_000;

type CoverageBand = {
  readonly widthMeters: number;
  readonly visual: RingVisual;
};

export class RingView {
  readonly group = new THREE.Group();
  private readonly coverageBands: CoverageBand[] = [];
  private readonly visuals: RingVisual[] = [];

  // rings は物理データ(半径は [m])、bodyRadius は本体メッシュと同じ「半径 1」単位への換算元、
  // renderOrder は半透明の環を本体より後に描くための値。THREE の描画順は Object3D ごとに独立
  // していて親から子へ伝播しないので、グループではなく帯のメッシュ1つ1つへ書く。
  constructor(
    rings: RingSystemDef,
    private readonly bodyRadius: number,
    renderOrder: number,
  ) {
    for (const band of rings.bands) {
      const built = this.buildBand(band, bodyRadius);
      built.object.traverse((o) => { o.renderOrder = renderOrder; });
      this.group.add(built.object);
      this.visuals.push(built);
    }
  }

  // 帯1本ぶんの RingVisual を組む。半径は「本体半径 = 1」単位へ換算して渡す。厚みのある帯は
  // 拡散した雲なので扁平トーラス、厚み0の帯は実幅で annulus/line を選び、選んだ側だけを控える。
  private buildBand(band: RingBandDef, bodyRadius: number): RingVisual {
    const inner = band.innerRadius / bodyRadius;
    const outer = band.outerRadius / bodyRadius;
    if (band.thickness > 0) {
      return createTorusRing(band.optics, inner, outer, band.thickness / bodyRadius);
    }
    const widthMeters = band.outerRadius - band.innerRadius;
    const visual = widthMeters >= RING_LINE_WIDTH_THRESHOLD_M
      ? createAnnulusRing(band.optics, inner, outer, band.arcs)
      : createRingLine(band.optics, (inner + outer) / 2, band.arcs);
    this.coverageBands.push({ widthMeters, visual });
    return visual;
  }

  // pos/axis は本体メッシュ(SphereView/PointView)と揃える。bodyPos/metersPerPixelAt は
  // 帯の被覆率減光専用で、sunDirection は環自身の光学計算用。
  sync(
    pos: THREE.Vector3,
    axis: Vec3 | null,
    bodyPos: Vec3,
    metersPerPixelAt: ScaleFn,
    sunDirection: Vec3,
  ): void {
    this.group.position.copy(pos);
    this.group.scale.setScalar(this.bodyRadius);
    const ringAxis = axis === null
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(axis.x, axis.y, axis.z).normalize();
    if (axis !== null) {
      const q = spinOrientation(axis, 0);
      if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    }
    const state: RingVisualState = {
      bodyCenter: pos,
      bodyRadius: this.bodyRadius,
      sunDirection: new THREE.Vector3(sunDirection.x, sunDirection.y, sunDirection.z).normalize(),
      ringAxis,
      coverage: 1,
    };
    for (const visual of this.visuals) visual.sync(state);
    if (this.coverageBands.length === 0) return;
    const mpp = metersPerPixelAt(bodyPos);
    for (const band of this.coverageBands) {
      band.visual.sync({ ...state, coverage: ringPixelCoverage(band.widthMeters, mpp) });
    }
  }

  // 全帯の RingVisual を解放し、group を親から外す。
  dispose(): void {
    this.group.removeFromParent();
    for (const visual of this.visuals) visual.dispose();
  }
}
