// マップモードの数値予測軌道(複数ノード対応)を描画するポリライン。
// OrbitLine(解析的な楕円、自機・ターゲット・敵の現在軌道用)とは別に、
// RK4 で数値積分された折れ線(predict.ts の TrajectorySample[])をそのまま
// 頂点列として描画する。ノードで区切られたセグメントごとに色を変え、
// 「まだ実行していない噴射(グレー)→最初のノード後(白)→2個目以降(オレンジ)」
// の順に未来が明るくなる配色にする(既存の plannedOrbitLine の配色思想を踏襲)。
//
// ジオメトリは refresh() を呼んだときだけ作り直す(毎フレームではない)。
// 毎フレームは setOrigin() でフローティングオリジン補正の平行移動だけ行う。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../physics/vec3';

const SEGMENT_COLORS = [0xbfc9d4, 0xffffff, 0xff6a00];

export class TrajLine {
  readonly group = new THREE.Group();
  private lines: THREE.Line[] = [];
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.LineBasicMaterial[] = [];

  constructor() {
    this.group.visible = false;
  }

  // segments: ノードで区切られた ECI 座標列(地球中心座標、フローティングオリジン
  // 補正前)の配列。各セグメントは前セグメント終端(ノード位置)を先頭に含めて
  // 連続させること(色の切り替わり位置で線が途切れないように)。
  refresh(segments: Vec3[][]): void {
    this.clear();
    for (let i = 0; i < segments.length; i++) {
      const pts = segments[i]!;
      if (pts.length < 2) continue;
      const arr = new Float32Array(pts.length * 3);
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j]!;
        arr[j * 3] = p.x;
        arr[j * 3 + 1] = p.y;
        arr[j * 3 + 2] = p.z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const color = SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: i === 0 ? 0.55 : 0.85,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 2;
      this.geoms.push(geo);
      this.mats.push(mat);
      this.lines.push(line);
      this.group.add(line);
    }
  }

  private clear(): void {
    for (const l of this.lines) this.group.remove(l);
    for (const m of this.mats) m.dispose();
    for (const g of this.geoms) g.dispose();
    this.lines = [];
    this.mats = [];
    this.geoms = [];
  }

  // 毎フレーム呼ぶ: フローティングオリジン補正(平行移動のみ)
  setOrigin(origin: Vec3): void {
    this.group.position.set(-origin.x, -origin.y, -origin.z);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    this.clear();
  }
}
