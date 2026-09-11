// 環系の物理データ(RingSystemDef)から帯ごとの表示物を組み、本体の位置と極軸から決まる姿勢・
// 見かけ幅へ毎フレーム同期する。
import * as THREE from 'three/webgpu';
import type { RenderStyle } from '../render-style';
import { spinOrientation } from '../../physics/body-orientation';
import { RingBandDef, RingSystemDef } from '../../physics/celestial-body-def';
import { Vec3 } from '../../math/vec3';
import { createOutlineCircle, OutlineCircle } from './outline-circle';
import {
  RING_TILT,
  createAnnulusRing,
  createRingLine,
  createTorusRing,
  RingLineVisual,
  RingMaterials,
  RingVisual,
} from './ring';
import { ringPixelCoverage } from './screen-lod';
import type { GraphicsSettingsData } from '../graphics-settings';
import type { ScaleFn } from '../../math/projection';

// 厚み 0 の帯。見かけ幅で面と線を切り替える。widthMeters は帯の実幅 [m]。
interface CoverageBand {
  readonly widthMeters: number;
  readonly annulus: RingVisual;
  readonly line: RingLineVisual;
}

export class RingView {
  public readonly group = new THREE.Group();
  private readonly coverageBands: CoverageBand[] = [];
  private readonly visuals: RingVisual[] = [];
  // 模式図で環の代わりに出す、環全体の最内・最外半径の輪郭円。
  private readonly outlineInner: OutlineCircle = createOutlineCircle();
  private readonly outlineOuter: OutlineCircle = createOutlineCircle();

  // rings は物理データ(半径 [m])、bodyRadius は「本体半径 = 1」単位への換算元、renderOrder は
  // 帯のメッシュへ付ける描画順(本体より後に描く値を渡す)。
  public constructor(
    rings: RingSystemDef,
    private readonly bodyRadius: number,
    renderOrder: number,
    materials: RingMaterials,
  ) {
    for (const band of rings.bands) {
      this.buildBand(band, bodyRadius, renderOrder, materials);
    }
    // 模式図の輪郭円は環全体の最内・最外の2本。
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

  // 帯1本ぶんの RingVisual を「本体半径 = 1」単位で組み、group・visuals へ登録する。
  private buildBand(
    band: RingBandDef, bodyRadius: number, renderOrder: number, materials: RingMaterials,
  ): void {
    const inner = band.innerRadius / bodyRadius;
    const outer = band.outerRadius / bodyRadius;
    // 厚みのある帯は拡散環の角柱1つ。
    if (band.thickness > 0) {
      this.addVisual(createTorusRing(band.optics, inner, outer, band.thickness / bodyRadius, materials), renderOrder);
      return;
    }
    // 厚み 0 の帯は面と線の両方を組み、sync が見かけ幅で片方を見せる。
    const annulus = createAnnulusRing(band.optics, inner, outer, materials, band.arcs);
    const line = createRingLine(band.optics, (inner + outer) / 2, materials, band.arcs);
    this.addVisual(annulus, renderOrder);
    this.addVisual(line, renderOrder);
    this.coverageBands.push({ widthMeters: band.outerRadius - band.innerRadius, annulus, line });
  }

  // renderOrder を子オブジェクトすべてへ設定し、group・visuals へ登録する。
  private addVisual(visual: RingVisual, renderOrder: number): void {
    // 描画順は親から子へ伝播しないので、子の1つ1つへ書く。
    visual.object.traverse((o) => { o.renderOrder = renderOrder; });
    this.group.add(visual.object);
    this.visuals.push(visual);
  }

  // 環全体を隠す。次の sync が表示設定に従って見せ直す。
  public hide(): void {
    this.group.visible = false;
  }

  // graphics.rings に従って環を見せ、位置・姿勢・見かけ幅を合わせる。pos は本体と同じ描画座標、
  // axis は極軸(null なら姿勢を据え置く)、bodyPos は見かけ幅を測る ECI 位置 [m]。
  public sync(
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
    // 環軸は group の姿勢で運ぶ(帯のマテリアルはモデル行列から環軸を引く)。
    if (axis !== null) {
      const q = spinOrientation(axis, 0);
      if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    }
    if (this.coverageBands.length === 0) return;
    const mpp = metersPerPixelAt(bodyPos);
    // 見かけ幅が 1px を割った帯は線で描く。
    for (const band of this.coverageBands) {
      const showAnnulus = band.widthMeters / mpp >= 1;
      band.annulus.object.visible = showAnnulus && !schematic;
      band.line.object.visible = !showAnnulus && !schematic;
      band.line.setCoverage(ringPixelCoverage(band.widthMeters, mpp));
    }
  }

  // 全帯の RingVisual と輪郭円を解放し、group を親から外す。
  public dispose(): void {
    this.group.removeFromParent();
    for (const visual of this.visuals) visual.dispose();
    this.outlineInner.dispose();
    this.outlineOuter.dispose();
  }
}
