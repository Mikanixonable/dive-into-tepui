// オーロラカーテン: 磁気(≒地理)極を囲む波打つリング帯。途切れ・色の揺らぎはノイズ的な
// 周期関数で表現する(閉ループを保つため周期関数のみを使う)。1つで1層ぶんなので、同じ極に
// 複数重ねて厚みを出す。天体半径・オーバル緯度・発光高度・色は呼び出し側が与える。
import * as THREE from 'three/webgpu';

const SEG = 160;
const V_SEG = 3; // 鉛直方向4頂点: 0=下端フェード, 1=核(緑), 2=中間(赤), 3=上端フェード
const INTENSITY_SCALE = 0.15; // 発光全体の強さ倍率

// カーテンを載せる天体の、オーロラの見えを決める量。発光高度は大気の組成と降り込む粒子の
// エネルギーで、色は励起される原子の輝線で決まるので、どちらも天体ごとの静的事実。
export type AuroraOptics = {
  readonly bodyRadius: number; // カーテンの基準になる天体半径 [m]
  readonly ovalLatitudeDeg: number; // オーロラオーバルの中心緯度 [deg]
  // 鉛直4頂点の高度 [m]。上端2つはカーテンの伸び topAltitude に対する比で与える。
  readonly baseAltitude: number;
  readonly coreAltitude: number;
  readonly topAltitude: number;
  readonly topAltitudeVariation: number; // 周方向の伸び縮み [m]
  // 鉛直4頂点の色(明るさ 1 のときの線形 RGB)。下端フェード・核・中間・上端フェードの順。
  readonly layerColors: readonly [readonly number[], readonly number[], readonly number[], readonly number[]];
};

export class Aurora {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly material: THREE.MeshBasicMaterial;
  private readonly positions = new Float32Array((SEG + 1) * (V_SEG + 1) * 3);
  private readonly colors = new Float32Array((SEG + 1) * (V_SEG + 1) * 3);

  // sign は北極側(+1)/南極側(-1)。geomSeed/colorSeed は形状と色の位相 — 同じ極に重ねる層は
  // geomSeed を揃えると平行になり交差を防げる。radiusOffset/latOffsetDeg はその層どうしの
  // ずらし量、phaseOffset は明滅のずらし量。
  constructor(
    private readonly optics: AuroraOptics,
    private readonly sign: 1 | -1,
    private readonly geomSeed: number,
    private readonly colorSeed: number,
    private readonly radiusOffset: number,
    private readonly latOffsetDeg: number,
    private readonly phaseOffset: number,
  ) {
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
  sync(phase: number): void {
    this.writeVertices(phase);
    this.geo.attributes.position!.needsUpdate = true;
    this.geo.attributes.color!.needsUpdate = true;
  }

  // 全体の明滅。**明るさは色に載せ、不透明度は 1 に固定する** — 不透明度は「背景をどれだけ
  // 置き換えるか」という別の量で、1 を超える明るさを表せない。
  private pulse(phase: number): number {
    return 0.55 + 0.2 * Math.sin(phase * 0.7 + this.phaseOffset * 2.1) * Math.sin(phase * 0.23 + this.phaseOffset);
  }

  // mesh を親から外し、ジオメトリ・マテリアルを解放する。
  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
  }

  // phase 時点のカーテン形状を positions/colors へ書き込む(GPU への反映は呼び出し側)。
  private writeVertices(phase: number): void {
    const o = this.optics;
    const sPhase = this.geomSeed + phase;
    const cPhase = this.colorSeed + phase;
    for (let i = 0; i <= SEG; i++) {
      const th = (i / SEG) * Math.PI * 2;

      // 緯度・高さをノイズ的に波打たせる
      const latDeg = o.ovalLatitudeDeg + this.latOffsetDeg
        + 4.5 * Math.sin(3 * th + sPhase) + 2.2 * Math.sin(7 * th + sPhase * 2.3);
      const lat = ((latDeg * Math.PI) / 180) * this.sign;
      const cl = Math.cos(lat);
      const dirX = cl * Math.cos(th);
      const dirY = Math.sin(lat);
      const dirZ = cl * Math.sin(th);

      // 途切れや二重を表現するノイズ(強度が低い場所は暗くなる)
      const intensityNode = 0.4 + 0.6 * Math.sin(5 * th + cPhase * 0.8) + 0.4 * Math.sin(11 * th - cPhase * 1.3);
      const intensity = Math.max(0, Math.min(1, intensityNode));

      const hTop = o.topAltitude + o.topAltitudeVariation * Math.sin(2 * th + sPhase * 1.7);
      const alts = [o.baseAltitude, o.coreAltitude, o.coreAltitude + hTop * 0.4, o.baseAltitude + hTop];

      // 時間による色の揺らぎ
      const flick = 0.8 + 0.2 * Math.sin(19 * th + cPhase * 4.1);
      const coreInt = intensity * flick * INTENSITY_SCALE * this.pulse(phase);

      for (let j = 0; j <= V_SEG; j++) {
        const r = o.bodyRadius + alts[j]! + this.radiusOffset;
        const idx = (i * (V_SEG + 1) + j) * 3;
        this.positions.set([dirX * r, dirY * r, dirZ * r], idx);
        // 加算合成なので 0 で透明。
        const color = o.layerColors[j]!;
        this.colors.set([color[0]! * coreInt, color[1]! * coreInt, color[2]! * coreInt], idx);
      }
    }
  }
}
