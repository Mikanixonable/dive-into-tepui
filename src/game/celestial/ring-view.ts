// RingSystemDef(物理データ)1系の描画。環は本体メッシュの子にはしない — 環の姿勢は極軸
// だけで決まり(帯ごとの姿勢差はない)、海王星アダムス環のような非軸対称のアーク構造は
// 本体の自転位相(spinOrientation の spinAngle)には追従してはならないため、位置・スケールは
// 本体メッシュに揃えつつ、姿勢だけ spinAngle=0 の spinOrientation で別個に組む
// (body-orientation.ts の spinOrientation をそのまま再利用し、新しい姿勢関数は作らない)。
import * as THREE from 'three/webgpu';
import { spinOrientation } from '../../physics/body-orientation';
import { ringVisualForm } from './ring-lod';
import { RingBandDef, RingSystemDef, RingTextureId } from '../../physics/solar-system';
import { Vec3 } from '../../physics/vec3';
import { createAnnulusRing, createRingLine, createTexturedRing, createTorusRing } from '../../render/ring';
import { ScaleFn } from '../camera/camera-system';

const RING_COLOR = 0x8899aa;
const RING_OPACITY = 0.3;
const LINE_OPACITY = 0.5;
const TORUS_OPACITY = 0.18;

// annulus/line を距離に応じて切り替える帯1本ぶんの2つのメッシュ。
type ThinBand = { readonly widthMeters: number; readonly annulus: THREE.Object3D; readonly line: THREE.Object3D };

export class RingView {
  readonly group = new THREE.Group();
  private readonly thinBands: ThinBand[] = [];

  // rings は物理データ(半径は [m])、bodyRadius は本体メッシュと同じ「半径 1」単位への換算元、
  // textureUrls は RingBandDef.texture の識別子から実アセット URL を引く表。
  constructor(rings: RingSystemDef, bodyRadius: number, textureUrls: Readonly<Partial<Record<RingTextureId, string>>>) {
    for (const band of rings.bands) {
      this.group.add(this.buildBand(band, bodyRadius, textureUrls));
    }
  }

  private buildBand(band: RingBandDef, bodyRadius: number, textureUrls: Readonly<Partial<Record<RingTextureId, string>>>): THREE.Object3D {
    const inner = band.innerRadius / bodyRadius;
    const outer = band.outerRadius / bodyRadius;
    if (band.texture !== undefined) {
      const url = textureUrls[band.texture];
      if (url === undefined) throw new Error(`RingView: 環テクスチャ未登録の識別子: ${band.texture}`);
      return createTexturedRing(url, inner, outer);
    }
    if (band.thickness > 0) return createTorusRing(RING_COLOR, TORUS_OPACITY, inner, outer, band.thickness / bodyRadius);
    const annulus = createAnnulusRing(RING_COLOR, RING_OPACITY, inner, outer, band.arcs);
    const line = createRingLine(RING_COLOR, LINE_OPACITY, (inner + outer) / 2, band.arcs);
    this.thinBands.push({ widthMeters: band.outerRadius - band.innerRadius, annulus, line });
    const group = new THREE.Group();
    group.add(annulus, line);
    return group;
  }

  // pos/scale/axis は本体メッシュ(SphereBody/PointBody)と揃える。bodyPos/metersPerPixelAt は
  // 細環の annulus/線 切り替えの判定専用 — 実 ECI 位置での実距離で判定するので、戦闘視点の
  // 視距離圧縮表示でも見かけの角直径どおりに切り替わる。
  sync(pos: THREE.Vector3, scale: number, axis: Vec3 | null, bodyPos: Vec3, metersPerPixelAt: ScaleFn): void {
    this.group.position.copy(pos);
    this.group.scale.setScalar(scale);
    if (axis !== null) {
      const q = spinOrientation(axis, 0);
      if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    }
    if (this.thinBands.length === 0) return;
    const mpp = metersPerPixelAt(bodyPos);
    for (const band of this.thinBands) {
      const form = ringVisualForm(band.widthMeters, mpp);
      band.annulus.visible = form === 'annulus';
      band.line.visible = form === 'line';
    }
  }
}
