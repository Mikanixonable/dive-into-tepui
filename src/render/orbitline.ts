// 状態ベクトルから求めた軌道要素の楕円を LineLoop で描く。
// 座標はフローティングオリジン(自機基準)で毎フレーム更新する。
import * as THREE from 'three/webgpu';
import { Elements, sampleOrbit } from '../physics/orbital';
import { Vec3 } from '../physics/vec3';

// LEO 軌道(周長 ~42,000 km)で 1 セグメント ~20 km になる点数。
// 弦の矢高は数 m まで落ちるので、軌道上(=線のすぐ近く)から見ても折れ線に見えない。
const POINT_COUNT = 2048;

// WebGPU レンダラー(r169)は LineLoop 非対応のため、THREE.Line で
// 始点を終端に複製して閉じた楕円を描く。
export class OrbitLine {
  readonly line: THREE.Line;
  private readonly positions: Float32Array;
  private readonly samples: Vec3[] = [];

  constructor(color: number, opacity = 0.5) {
    this.positions = new Float32Array((POINT_COUNT + 1) * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    this.line = new THREE.Line(geo, mat);
    this.line.frustumCulled = false;
    this.line.renderOrder = 1;
  }

  update(el: Elements | null, origin: Vec3): void {
    if (!el || !sampleOrbit(el, POINT_COUNT, this.samples)) {
      this.line.visible = false;
      return;
    }
    for (let i = 0; i < POINT_COUNT; i++) {
      const p = this.samples[i]!;
      this.positions[i * 3] = p.x - origin.x;
      this.positions[i * 3 + 1] = p.y - origin.y;
      this.positions[i * 3 + 2] = p.z - origin.z;
    }
    // 閉路化
    this.positions[POINT_COUNT * 3] = this.positions[0]!;
    this.positions[POINT_COUNT * 3 + 1] = this.positions[1]!;
    this.positions[POINT_COUNT * 3 + 2] = this.positions[2]!;
    const attr = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.line.visible = true;
  }
}
