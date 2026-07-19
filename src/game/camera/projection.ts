import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';

const tmpV = new THREE.Vector3();

// スクリーン投影。アクティブカメラに依存するので Game から都度コールバックで渡す。
export type ProjectFn = (rel: Vec3) => { x: number; y: number; front: boolean };

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
