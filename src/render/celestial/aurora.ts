// オーロラカーテン: 磁気(≒地理)極を囲む波打つリング帯。途切れ・色の揺らぎはノイズ的な
// 周期関数で表現する(閉ループを保つため周期関数のみを使う)。1つで1層ぶんなので、同じ極に
// 複数重ねて厚みを出す。天体半径・オーバル緯度・発光高度・色は呼び出し側が与える。
import * as THREE from 'three/webgpu';
import { AuroraField } from '../aurora-field';

const SEG = 160;
const V_SEG = 3; // 鉛直方向4頂点: 0=下端フェード, 1=核(緑), 2=中間(赤), 3=上端フェード
const INTENSITY_SCALE = 0.15; // 発光全体の強さ倍率

// カーテンを載せる天体の、オーロラの見えを決める量。発光高度は大気の組成と降り込む粒子の
// エネルギーで、色は励起される原子の輝線で決まるので、どちらも天体ごとの静的事実。
export interface AuroraOptics {
  readonly bodyRadius: number; // カーテンの基準になる天体半径 [m]
  readonly ovalLatitudeDeg: number; // オーロラオーバルの中心緯度 [deg]
  readonly magneticPoleLatitudeDeg?: number; // 簡易双極子の磁極緯度 [deg]
  readonly magneticPoleLongitudeDeg?: number; // 北磁極の経度 [deg]
  // 鉛直4頂点の高度 [m]。上端2つはカーテンの伸び topAltitude に対する比で与える。
  readonly baseAltitude: number;
  readonly coreAltitude: number;
  readonly topAltitude: number;
  readonly topAltitudeVariation: number; // 周方向の伸び縮み [m]
  // 鉛直4頂点の色(明るさ 1 のときの線形 RGB)。下端フェード・核・中間・上端フェードの順。
  readonly layerColors: readonly [readonly number[], readonly number[], readonly number[], readonly number[]];
}

export class Aurora {
  public readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly material: THREE.MeshBasicMaterial;
  private readonly positions = new Float32Array((SEG + 1) * (V_SEG + 1) * 3);
  private readonly colors = new Float32Array((SEG + 1) * (V_SEG + 1) * 3);
  private readonly field: AuroraField;

  // sign は北極側(+1)/南極側(-1)。geomSeed/colorSeed は形状と色の位相 — 同じ極に重ねる層は
  // geomSeed を揃えると平行になり交差を防げる。radiusOffset/latOffsetDeg はその層どうしの
  // ずらし量、phaseOffset は明滅のずらし量。
  public constructor(
    private readonly optics: AuroraOptics,
    sign: 1 | -1,
    geomSeed: number,
    colorSeed: number,
    private readonly radiusOffset: number,
    private readonly latOffsetDeg: number,
    phaseOffset: number,
  ) {
    this.field = new AuroraField({
      ovalLatitudeDeg: optics.ovalLatitudeDeg,
      magneticPoleLatitudeDeg: optics.magneticPoleLatitudeDeg,
      magneticPoleLongitudeDeg: optics.magneticPoleLongitudeDeg,
      geomSeed,
      colorSeed,
      phaseOffset,
      sign,
    });
    this.writeVertices(0);

    // 周方向 SEG × 鉛直 V_SEG の格子を四角形ごとに2枚の三角形へ割る。
    const indices: number[] = [];
    for (let i = 0; i < SEG; i++) {
      for (let j = 0; j < V_SEG; j++) {
        const a = i * (V_SEG + 1) + j;
        const b = a + 1;
        const c = (i + 1) * (V_SEG + 1) + j;
        const d = c + 1;
        indices.push(a, b, c, c, b, d);
      }
    }

    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geo.setIndex(indices);
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.renderOrder = 3;
  }

  // 波打ちと明滅を phase の時点へ合わせる。
  public sync(phase: number, solarMeridianRad = 0): void {
    this.writeVertices(phase, solarMeridianRad);
    this.geo.attributes.position!.needsUpdate = true;
    this.geo.attributes.color!.needsUpdate = true;
  }

  // mesh を親から外し、ジオメトリ・マテリアルを解放する。
  public dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
  }

  // phase 時点のカーテン形状を positions/colors へ書き込む(GPU への反映は呼び出し側)。
  private writeVertices(phase: number, solarMeridianRad = 0): void {
    const o = this.optics;
    for (let i = 0; i <= SEG; i++) {
      const th = (i / SEG) * Math.PI * 2;

      const frame = this.field.frameAt(th, phase, solarMeridianRad, this.latOffsetDeg);
      const lat = (frame.latitudeDeg * Math.PI) / 180;
      const lon = (frame.longitudeDeg * Math.PI) / 180;
      const cl = Math.cos(lat);
      const dirX = cl * Math.cos(lon);
      const dirY = Math.sin(lat);
      const dirZ = cl * Math.sin(lon);

      const hTop = o.topAltitude + o.topAltitudeVariation * frame.altitudeScale;
      const alts = [o.baseAltitude, o.coreAltitude, o.coreAltitude + hTop * 0.4, o.baseAltitude + hTop];

      const coreInt = frame.intensity * INTENSITY_SCALE;

      for (let j = 0; j <= V_SEG; j++) {
        const r = o.bodyRadius + alts[j]! + this.radiusOffset;
        const idx = (i * (V_SEG + 1) + j) * 3;
        this.positions.set([dirX * r, dirY * r, dirZ * r], idx);
        // 加算合成なので 0 で透明。
        const color = o.layerColors[j]!;
        this.colors.set([
          color[0]! * coreInt * (0.8 + frame.redEmission * 0.2),
          color[1]! * coreInt * (0.8 + frame.greenEmission * 0.2),
          color[2]! * coreInt,
        ], idx);
      }
    }
  }
}
