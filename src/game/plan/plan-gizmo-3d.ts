import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';

export class PlanGizmo3D {
  public readonly group = new THREE.Group();

  constructor() {
    this.group.renderOrder = 999;
    
    // Prograde (Blue), Normal (Green), Radial (Red)
    this.createAxis(new THREE.Vector3(0, 0, 1), 0x3b82f6); // PRO (Local Z)
    this.createAxis(new THREE.Vector3(0, 0, -1), 0x3b82f6); // RETRO
    
    this.createAxis(new THREE.Vector3(0, 1, 0), 0x10b981); // NRM (Local Y)
    this.createAxis(new THREE.Vector3(0, -1, 0), 0x10b981); // ANTI-NRM
    
    this.createAxis(new THREE.Vector3(1, 0, 0), 0xef4444); // RAD (Local X)
    this.createAxis(new THREE.Vector3(-1, 0, 0), 0xef4444); // RAD-IN
  }

  private createAxis(dir: THREE.Vector3, color: number): void {
    const length = 20; // ギズモの長さ。画面上でのサイズはカメラ距離等でスケーリング
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

    // Stem
    const stemGeom = new THREE.CylinderGeometry(stemWidth, stemWidth, stemLength, 8);
    const stem = new THREE.Mesh(stemGeom, material);
    stem.position.copy(dir).multiplyScalar(stemLength / 2);
    
    // Head
    const headGeom = new THREE.ConeGeometry(headWidth, headLength, 12);
    const head = new THREE.Mesh(headGeom, material);
    head.position.copy(dir).multiplyScalar(length - headLength / 2);

    // Rotate to face direction
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    stem.quaternion.copy(quaternion);
    head.quaternion.copy(quaternion);

    this.group.add(stem);
    this.group.add(head);
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  public setPositionAndRotation(pos: Vec3, pro: Vec3, nrm: Vec3, rad: Vec3, scale: number): void {
    this.group.position.set(pos.x, pos.y, pos.z);
    
    // Construct rotation matrix from local axes (RAD=X, NRM=Y, PRO=Z)
    const mat = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(rad.x, rad.y, rad.z),
      new THREE.Vector3(nrm.x, nrm.y, nrm.z),
      new THREE.Vector3(pro.x, pro.y, pro.z)
    );
    this.group.quaternion.setFromRotationMatrix(mat);
    
    // Scale gizmo so it maintains roughly the same screen size
    this.group.scale.setScalar(scale);
  }
}
