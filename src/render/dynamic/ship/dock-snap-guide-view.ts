import * as THREE from 'three/webgpu';
import { qNormalize, type Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';
import { markOverlay } from '../../pipeline/lit-layer';

const VALID_COLOR = 0x53f089;
const INVALID_COLOR = 0xff5b63;
const GUIDE_OPACITY = 0.9;
const GUIDE_SEGMENTS = 64;

// dock の自由端に置く接続面を、world 座標で受け取る。rotation は module-local +Z を接続軸へ向ける。
export interface DockSnapGuideDisplay {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly radius: number;
  readonly valid: boolean;
}

// 接続面を表す world-space の円。3D overlay だが depth test を保つので不透明物の奥では隠れる。
export class DockSnapGuideView {
  public readonly object = new THREE.Group();
  private readonly geometry = buildCircleGeometry();
  private readonly material = new THREE.LineBasicMaterial({
    color: VALID_COLOR,
    transparent: true,
    opacity: GUIDE_OPACITY,
    depthTest: true,
    depthWrite: false,
  });
  private readonly line = new THREE.Line(this.geometry, this.material);
  private disposed = false;

  public constructor(private readonly scene?: THREE.Scene, addToScene = true) {
    this.object.name = 'dock-snap-guide';
    this.object.visible = false;
    this.line.renderOrder = 1;
    markOverlay(this.line);
    this.object.add(this.line);
    if (addToScene) scene?.add(this.object);
  }

  // display が null なら guide を畳む。円は局所 XY 平面にあり、rotation で接続面へ揃える。
  public sync(display: DockSnapGuideDisplay | null): void {
    if (this.disposed) throw new Error('cannot sync a disposed DockSnapGuideView');
    this.object.visible = display !== null;
    if (display === null) return;
    if (!Number.isFinite(display.radius) || display.radius <= 0) {
      throw new Error(`dock snap guide radius must be positive: ${display.radius}`);
    }
    this.object.position.set(display.position.x, display.position.y, display.position.z);
    const q = qNormalize(display.rotation);
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
    this.object.scale.setScalar(display.radius);
    this.material.color.set(display.valid ? VALID_COLOR : INVALID_COLOR);
    this.object.userData.dockSnapGuideValid = display.valid;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene?.remove(this.object);
    this.object.remove(this.line);
    this.geometry.dispose();
    this.material.dispose();
  }
}

function buildCircleGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array((GUIDE_SEGMENTS + 1) * 3);
  for (let index = 0; index <= GUIDE_SEGMENTS; index++) {
    const angle = (index / GUIDE_SEGMENTS) * Math.PI * 2;
    positions[index * 3] = Math.cos(angle);
    positions[index * 3 + 1] = Math.sin(angle);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}
