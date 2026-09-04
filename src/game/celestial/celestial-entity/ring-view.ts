// RingSystemDefの物理データを、マップビューと戦闘ビューで共通のRingVisualへ同期する。
// 環の姿勢は極軸だけで決まり、非軸対称アークは本体の自転位相には追従させない。
import * as THREE from 'three/webgpu';
import type { RenderStyle } from '../../../render/render-style';
import { spinOrientation } from '../../../physics/body-orientation';
import { RingBandDef, RingSystemDef } from '../../../physics/celestial-body-def';
import { Vec3 } from '../../../math/vec3';
import { createOutlineCircle, OutlineCircle } from '../../../render/outline-circle';
import {
  RING_TILT,
  createAnnulusRing,
  createRingLine,
  createTorusRing,
  RingLineVisual,
  RingMaterials,
  RingVisual,
} from '../../../render/ring';
import { ringPixelCoverage } from '../../../render/screen-lod';
import type { GraphicsSettingsData } from '../../../render/graphics-settings';
import { ScaleFn } from '../../camera/camera-system';

type CoverageBand = {
  readonly widthMeters: number;
  readonly annulus: RingVisual;
  readonly line: RingLineVisual;
};

export class RingView {
  readonly group = new THREE.Group();
  private readonly coverageBands: CoverageBand[] = [];
  private readonly visuals: RingVisual[] = [];
  // 模式図で環の代わりに出す、環全体の最内・最外半径の輪郭円。
  private readonly outlineInner: OutlineCircle = createOutlineCircle();
  private readonly outlineOuter: OutlineCircle = createOutlineCircle();

  // rings は物理データ(半径は [m])、bodyRadius は本体メッシュと同じ「半径 1」単位への換算元、
  // renderOrder は半透明の環を本体より後に描くための値。THREE の描画順は Object3D ごとに独立
  // していて親から子へ伝播しないので、グループではなく帯のメッシュ1つ1つへ書く。
  constructor(
    rings: RingSystemDef,
    private readonly bodyRadius: number,
    renderOrder: number,
    materials: RingMaterials,
  ) {
    for (const band of rings.bands) {
      this.buildBand(band, bodyRadius, renderOrder, materials);
    }
    // 模式図で出す輪郭円は帯ごとではなく環全体の最内・最外の2本だけとする。
    const innerRadius = Math.min(...rings.bands.map((band) => band.innerRadius)) / bodyRadius;
    const outerRadius = Math.max(...rings.bands.map((band) => band.outerRadius)) / bodyRadius;
    // 輪郭円は環メッシュと同じ回転で環面へ寝かせる — 単位円は XY 平面に組まれている。
    this.outlineInner.line.rotation.x = RING_TILT;
    this.outlineOuter.line.rotation.x = RING_TILT;
    this.outlineInner.line.scale.setScalar(innerRadius);
    this.outlineOuter.line.scale.setScalar(outerRadius);
    this.outlineInner.line.visible = false;
    this.outlineOuter.line.visible = false;
    this.group.add(this.outlineInner.line, this.outlineOuter.line);
  }

  // 帯1本ぶんの RingVisual を組み、group・visuals へ登録する。半径は「本体半径 = 1」単位へ
  // 換算して渡す。厚みのある帯は拡散した雲なので扁平トーラス1つ。厚み0の帯は annulus と line
  // の両方を組んでおき、sync() が見かけ幅(1px判定)でどちらを見せるか毎フレーム選び直す。
  private buildBand(
    band: RingBandDef, bodyRadius: number, renderOrder: number, materials: RingMaterials,
  ): void {
    const inner = band.innerRadius / bodyRadius;
    const outer = band.outerRadius / bodyRadius;
    if (band.thickness > 0) {
      this.addVisual(createTorusRing(band.optics, inner, outer, band.thickness / bodyRadius, materials), renderOrder);
      return;
    }
    const annulus = createAnnulusRing(band.optics, inner, outer, materials, band.arcs);
    const line = createRingLine(band.optics, (inner + outer) / 2, materials, band.arcs);
    this.addVisual(annulus, renderOrder);
    this.addVisual(line, renderOrder);
    this.coverageBands.push({ widthMeters: band.outerRadius - band.innerRadius, annulus, line });
  }

  // renderOrder を子オブジェクトすべてへ設定し、group・visuals へ登録する。
  private addVisual(visual: RingVisual, renderOrder: number): void {
    visual.object.traverse((o) => { o.renderOrder = renderOrder; });
    this.group.add(visual.object);
    this.visuals.push(visual);
  }

  // 環全体の表示・非表示を切り替える。
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  // pos/axis は本体メッシュと揃える。bodyPos/metersPerPixelAt は帯の被覆率減光に使う。
  // graphics の設定に従って環の表示を切り替え、見せるときは姿勢と見かけ幅も合わせる。
  sync(
    pos: THREE.Vector3,
    axis: Vec3 | null,
    bodyPos: Vec3,
    metersPerPixelAt: ScaleFn,
    graphics: GraphicsSettingsData,
    style: RenderStyle,
  ): void {
    this.group.visible = graphics.rings;
    if (!graphics.rings) return;
    // 模式図では環メッシュを隠し、輪郭円だけを見せる。
    const schematic = style === 'schematic';
    this.outlineInner.line.visible = schematic;
    this.outlineOuter.line.visible = schematic;
    for (const visual of this.visuals) visual.object.visible = !schematic;
    this.group.position.copy(pos);
    this.group.scale.setScalar(this.bodyRadius);
    // 環軸は group の姿勢が運ぶ — 帯のグラフはモデル行列から引き直す。
    if (axis !== null) {
      const q = spinOrientation(axis, 0);
      if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    }
    if (this.coverageBands.length === 0) return;
    const mpp = metersPerPixelAt(bodyPos);
    // 見かけの幅(px、1を超えてもクランプしない生の値)が1を割った帯だけ line へ切り替える。
    for (const band of this.coverageBands) {
      const showAnnulus = band.widthMeters / mpp >= 1;
      band.annulus.object.visible = showAnnulus && !schematic;
      band.line.object.visible = !showAnnulus && !schematic;
      band.line.setCoverage(ringPixelCoverage(band.widthMeters, mpp));
    }
  }

  // 全帯の RingVisual と輪郭円を解放し、group を親から外す。
  dispose(): void {
    this.group.removeFromParent();
    for (const visual of this.visuals) visual.dispose();
    this.outlineInner.dispose();
    this.outlineOuter.dispose();
  }
}
