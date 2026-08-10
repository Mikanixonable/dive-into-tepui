// RingSystemDefの物理データを、マップビューと戦闘ビューで共通のRingVisualへ同期する。
// 環の姿勢は極軸だけで決まり、非軸対称アークは本体の自転位相には追従させない。
import * as THREE from 'three/webgpu';
import { spinOrientation } from '../../physics/body-orientation';
import { ringLod } from './ring-lod';
import { RingBandDef, RingSystemDef, RingTextureId } from '../../physics/solar-system';
import { Vec3 } from '../../physics/vec3';
import {
  createAnnulusRing,
  createRingLine,
  createTexturedRing,
  createTorusRing,
  RingVisual,
  RingVisualState,
} from '../../render/ring';
import { ScaleFn } from '../camera/camera-system';

type ThinBand = {
  readonly widthMeters: number;
  readonly annulus: RingVisual;
  readonly line: RingVisual;
};

export class RingView {
  readonly group = new THREE.Group();
  private readonly thinBands: ThinBand[] = [];
  private readonly visuals: RingVisual[] = [];

  constructor(
    rings: RingSystemDef,
    bodyRadius: number,
    textureUrls: Readonly<Partial<Record<RingTextureId, string>>>,
    renderOrder: number,
  ) {
    for (const band of rings.bands) {
      const built = this.buildBand(band, bodyRadius, textureUrls);
      built.object.traverse((o) => { o.renderOrder = renderOrder; });
      this.group.add(built.object);
      this.visuals.push(built);
    }
  }

  private buildBand(
    band: RingBandDef,
    bodyRadius: number,
    textureUrls: Readonly<Partial<Record<RingTextureId, string>>>,
  ): RingVisual {
    const inner = band.innerRadius / bodyRadius;
    const outer = band.outerRadius / bodyRadius;
    if (band.texture !== undefined) {
      const url = textureUrls[band.texture];
      if (url === undefined) throw new Error(`RingView: 環テクスチャ未登録の識別子: ${band.texture}`);
      return createTexturedRing(url, band.optics, inner, outer);
    }
    if (band.thickness > 0) {
      return createTorusRing(band.optics, inner, outer, band.thickness / bodyRadius);
    }
    const annulus = createAnnulusRing(band.optics, inner, outer, band.arcs);
    const line = createRingLine(band.optics, (inner + outer) / 2, band.arcs);
    this.thinBands.push({ widthMeters: band.outerRadius - band.innerRadius, annulus, line });
    const group = new THREE.Group();
    group.add(annulus.object, line.object);
    return {
      object: group,
      sync: (state) => {
        annulus.sync(state);
        line.sync(state);
      },
    };
  }

  sync(
    pos: THREE.Vector3,
    scale: number,
    axis: Vec3 | null,
    bodyPos: Vec3,
    metersPerPixelAt: ScaleFn,
    sunDirection: Vec3,
    cameraPosition: THREE.Vector3,
  ): void {
    this.group.position.copy(pos);
    this.group.scale.setScalar(scale);
    const ringAxis = axis === null
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(axis.x, axis.y, axis.z).normalize();
    if (axis !== null) {
      const q = spinOrientation(axis, 0);
      if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    }
    const state: RingVisualState = {
      bodyCenter: pos,
      bodyRadius: scale,
      sunDirection: new THREE.Vector3(sunDirection.x, sunDirection.y, sunDirection.z).normalize(),
      cameraPosition,
      ringAxis,
      coverage: 1,
    };
    for (const visual of this.visuals) visual.sync(state);
    if (this.thinBands.length === 0) return;
    const mpp = metersPerPixelAt(bodyPos);
    for (const band of this.thinBands) {
      const lod = ringLod(band.widthMeters, mpp);
      band.annulus.object.visible = lod.annulusWeight > 0;
      band.line.object.visible = lod.lineWeight > 0;
      band.annulus.sync({ ...state, coverage: lod.coverage * lod.annulusWeight });
      band.line.sync({ ...state, coverage: lod.coverage * lod.lineWeight });
    }
  }
}
