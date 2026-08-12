import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { AXIS_PROGRADE, AXIS_NORMAL, AXIS_RADIAL } from '../theme';

// 選択中ノードの Δv アーム6本(PRO/RET・NRM/ANM・OUT/IN)を表す3D矢印ギズモ。
export class PlanGizmo3D {
  public readonly group = new THREE.Group();
  private parts: { stem: THREE.Mesh, head: THREE.Mesh, dir: THREE.Vector3, baseLen: number }[] = [];

  constructor() {
    this.group.renderOrder = 999;

    this.createAxis(new THREE.Vector3(0, 1, 0), AXIS_PROGRADE); // PRO
    this.createAxis(new THREE.Vector3(0, -1, 0), AXIS_PROGRADE); // RETRO
    this.createAxis(new THREE.Vector3(0, 0, 1), AXIS_NORMAL); // NRM
    this.createAxis(new THREE.Vector3(0, 0, -1), AXIS_NORMAL); // ANTI-NRM
    this.createAxis(new THREE.Vector3(1, 0, 0), AXIS_RADIAL); // RAD
    this.createAxis(new THREE.Vector3(-1, 0, 0), AXIS_RADIAL); // RAD-IN

    this.group.visible = false;
  }

  // ローカル方向 dir(単位ベクトル)を向く矢印(軸+頭)を1本作り、group へ加える。
  private createAxis(dir: THREE.Vector3, color: string): void {
    const length = 20;
    const headLength = 4;
    const headWidth = 2.5;
    const stemLength = length - headLength;
    const stemWidth = 0.5;

    const material = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.8
    });

    const stemGeom = new THREE.CylinderGeometry(stemWidth, stemWidth, stemLength, 8);
    const stem = new THREE.Mesh(stemGeom, material);
    stem.position.copy(dir).multiplyScalar(stemLength / 2);

    const headGeom = new THREE.ConeGeometry(headWidth, headLength, 12);
    const head = new THREE.Mesh(headGeom, material);
    head.position.copy(dir).multiplyScalar(length - headLength / 2);

    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    stem.quaternion.copy(quaternion);
    head.quaternion.copy(quaternion);

    this.group.add(stem);
    this.group.add(head);
    this.parts.push({ stem, head, dir, baseLen: length });
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  // ギズモをノード位置へ置き、ローカル軸(X=RAD, Y=PRO, Z=NRM)を軌道基準系 pro/nrm/rad に揃える。
  // scale は画面上で一定の見かけサイズになるよう呼び出し側がカメラ距離から求める。
  public setPositionAndRotation(pos: THREE.Vector3, pro: Vec3, nrm: Vec3, rad: Vec3, scale: number): void {
    this.group.position.copy(pos);

    const mat = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(rad.x, rad.y, rad.z),
      new THREE.Vector3(pro.x, pro.y, pro.z),
      new THREE.Vector3(nrm.x, nrm.y, nrm.z)
    );
    this.group.quaternion.setFromRotationMatrix(mat);
    this.group.scale.setScalar(scale);
  }

  // 特定の軸をドラッグ/ラッチしている時に矢印を伸ばす
  public setStretch(activeAxis: 0 | 1 | 2 | null, activeSign: 1 | -1 | null, stretchFactor: number): void {
    for (let i = 0; i < 3; i++) {
      for (let s of [1, -1]) {
        const idx = i * 2 + (s < 0 ? 1 : 0);
        const part = this.parts[idx]!;
        
        // アクティブなら少し伸ばす (1.0 + stretchFactor)
        const isActive = (i === activeAxis && s === activeSign);
        const length = part.baseLen * (isActive ? 1.0 + stretchFactor : 1.0);
        
        const headLength = 4;
        const stemLength = length - headLength;
        
        // 再計算
        part.stem.scale.y = stemLength / (part.baseLen - headLength);
        part.stem.position.copy(part.dir).multiplyScalar(stemLength / 2);
        part.head.position.copy(part.dir).multiplyScalar(length - headLength / 2);
      }
    }
  }
}
