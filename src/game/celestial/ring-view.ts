// RingSystemDefの物理データを、マップビューと戦闘ビューで共通のRingVisualへ同期する。
// 環の姿勢は極軸だけで決まり、非軸対称アークは本体の自転位相には追従させない。
import * as THREE from 'three/webgpu';
import { spinOrientation } from '../../physics/body-orientation';
import { ringPixelCoverage } from '../../physics/ring-optics';
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

// 面と線の重みが入れ替わる画面上の帯幅[px]の範囲。幅が半径の 1/10,000 程度しかない細環は
// 面のまま描くとズームアウトで消えてしまうので、1px を境に線へ渡す(見やすさのための調整値)。
const LINE_FADE_MIN_PX = 0.75;
const LINE_FADE_MAX_PX = 1.25;

type ThinBandBlend = { readonly coverage: number; readonly annulus: number; readonly line: number };

// 帯の実幅[m]と、その位置での metersPerPixel から、面と線それぞれの重みを決める。線へ落としても
// alpha を固定値へ上げず、画面被覆率を同じ物理透過へ掛けるので、ズームアウトで総光量が増えない。
function thinBandBlend(bandWidthMeters: number, metersPerPixelAtBand: number): ThinBandBlend {
  const pixels = metersPerPixelAtBand > 0 ? bandWidthMeters / metersPerPixelAtBand : 0;
  const line = pixels <= LINE_FADE_MIN_PX ? 1
    : pixels >= LINE_FADE_MAX_PX ? 0
    : (LINE_FADE_MAX_PX - pixels) / (LINE_FADE_MAX_PX - LINE_FADE_MIN_PX);
  return { coverage: ringPixelCoverage(bandWidthMeters, metersPerPixelAtBand), annulus: 1 - line, line };
}

export class RingView {
  readonly group = new THREE.Group();
  private readonly thinBands: ThinBand[] = [];
  private readonly visuals: RingVisual[] = [];

  // rings は物理データ(半径は [m])、bodyRadius は本体メッシュと同じ「半径 1」単位への換算元、
  // textureUrls は RingBandDef.texture の識別子から実アセット URL を引く表、renderOrder は
  // 半透明の環を本体より後に描くための値。THREE の描画順は Object3D ごとに独立していて
  // 親から子へ伝播しないので、グループではなく帯のメッシュ1つ1つへ書く。
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

  // 帯1本ぶんの RingVisual を組む。半径は「本体半径 = 1」単位へ換算して渡す。厚みのある帯は
  // 拡散した雲なので扁平トーラス1つ、厚み0の帯は面と線の2つを持ち、その組を thinBands へ控える。
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
    // 厚み0の帯は画面上の幅しだいで面と線を混ぜるので、両方の表現を作って組で控える。
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

  // pos/scale/axis は本体メッシュ(SphereBody/PointBody)と揃える。bodyPos/metersPerPixelAt は
  // 細帯の面/線の重み付け専用 — 真の ECI 位置での実距離で判定するので、戦闘視点の視距離圧縮
  // 表示でも見かけの角直径どおりに切り替わる。sunDirection/cameraPosition は環自身の光学計算用。
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
    // 細帯だけは画面上の幅で面と線の重みを振り直し、被覆率を掛けた coverage で上書きする。
    if (this.thinBands.length === 0) return;
    const mpp = metersPerPixelAt(bodyPos);
    for (const band of this.thinBands) {
      const blend = thinBandBlend(band.widthMeters, mpp);
      band.annulus.object.visible = blend.annulus > 0;
      band.line.object.visible = blend.line > 0;
      band.annulus.sync({ ...state, coverage: blend.coverage * blend.annulus });
      band.line.sync({ ...state, coverage: blend.coverage * blend.line });
    }
  }
}
