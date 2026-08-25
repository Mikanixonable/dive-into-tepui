// 模式図スタイルで噴射炎の代わりに出す、輪郭抽出(schematic-composite.ts)に拾わせるための
// 不可視コーン。ジオメトリは頂点をローカル原点に置き、-Y 方向へ長さ1で広がる単位コーンとして
// 持ち、sync のたびに position/quaternion/scale でノズルへ合わせる。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from './pipeline/lit-layer';
import {
  SCHEMATIC_THRUST_CONE_LENGTH_MIN, SCHEMATIC_THRUST_CONE_LENGTH_SPAN, SCHEMATIC_THRUST_CONE_RADIUS_RATIO,
} from './schematic-style';

const CONE_SEGMENTS = 12;
const LOCAL_AXIS = new THREE.Vector3(0, -1, 0);

let sharedGeometry: THREE.ConeGeometry | null = null;
let sharedMaterial: THREE.MeshStandardMaterial | null = null;

function coneGeometry(): THREE.ConeGeometry {
  if (!sharedGeometry) {
    sharedGeometry = new THREE.ConeGeometry(1, 1, CONE_SEGMENTS, 1, true);
    sharedGeometry.translate(0, -0.5, 0);
  }
  return sharedGeometry;
}

// 模式図の輪郭抽出は G バッファの深度・法線だけを読むので、色は使われない。
function coneMaterial(): THREE.MeshStandardMaterial {
  if (!sharedMaterial) sharedMaterial = new THREE.MeshStandardMaterial();
  return sharedMaterial;
}

export class SchematicThrustCone {
  readonly mesh = new THREE.Mesh(coneGeometry(), coneMaterial());

  constructor() {
    markLitOpaque(this.mesh);
    this.mesh.visible = false;
  }

  // position(ワールド)を頂点とし、direction(ワールド、非ゼロ)の向きへ出力比 ratio(0..1)
  // に応じて伸びるコーンを合わせる。
  sync(position: THREE.Vector3, direction: THREE.Vector3, ratio: number, plumeScale = 1): void {
    const length = (SCHEMATIC_THRUST_CONE_LENGTH_MIN + SCHEMATIC_THRUST_CONE_LENGTH_SPAN * ratio) * plumeScale;
    const radius = length * SCHEMATIC_THRUST_CONE_RADIUS_RATIO;
    this.mesh.position.copy(position);
    this.mesh.quaternion.setFromUnitVectors(LOCAL_AXIS, direction);
    this.mesh.scale.set(radius, length, radius);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  // 親からメッシュを外す。ジオメトリ・マテリアルは全インスタンス共有のため解放しない。
  dispose(): void {
    this.mesh.removeFromParent();
  }
}
