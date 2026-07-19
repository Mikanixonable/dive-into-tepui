import * as THREE from 'three/webgpu';
import { Vec3 } from '../physics/vec3';

const tmpV = new THREE.Vector3();

export class HudProjection {
  constructor(private readonly activeCamera: () => THREE.PerspectiveCamera) {}

  project(rel: Vec3): { x: number; y: number; front: boolean } {
    const cam = this.activeCamera();
    tmpV.set(rel.x, rel.y, rel.z).applyMatrix4(cam.matrixWorldInverse);
    const front = tmpV.z < 0;
    tmpV.applyMatrix4(cam.projectionMatrix);
    return {
      x: (tmpV.x * 0.5 + 0.5) * window.innerWidth,
      y: (-tmpV.y * 0.5 + 0.5) * window.innerHeight,
      front,
    };
  }
}
