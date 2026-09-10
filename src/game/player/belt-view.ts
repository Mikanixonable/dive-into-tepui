import * as THREE from 'three/webgpu';
import { LOCAL_RIGHT, Q_IDENTITY, qFromAxisAngle, qFromUnitVectors, qMul, qRotate, type Quat } from '../../math/quat';
import { len, scale, sub } from '../../math/vec3';
import { buildMagazineMesh } from '../../render/ships';
import { MAG_BELT_ANCHOR_X, MAG_BELT_PITCH } from '../../physics/player-shape';
import { BeltPhysics } from './belt-physics';

export class BeltView {
  private readonly links: THREE.Group[] = [];

  public constructor(root: THREE.Object3D, linkCount: number) {
    const group = new THREE.Group();
    for (let i = 0; i < linkCount; i++) {
      const link = buildMagazineMesh();
      link.position.x = MAG_BELT_ANCHOR_X + (i + 0.5) * MAG_BELT_PITCH;
      group.add(link);
      this.links.push(link);
    }
    root.add(group);
  }

  public sync(magsLeft: number, physics: BeltPhysics): void {
    const { beltPos, beltTwist, anchor } = physics;
    let prevPoint = anchor;
    let prevQ: Quat = Q_IDENTITY;
    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i]!;
      link.visible = i < Math.min(magsLeft, this.links.length);
      const pos = beltPos[i]!;
      link.position.set((prevPoint.x + pos.x) / 2, (prevPoint.y + pos.y) / 2, (prevPoint.z + pos.z) / 2);
      const dir = sub(pos, prevPoint);
      const segLen = len(dir);
      let bendQ = prevQ;
      if (segLen > 1e-6) bendQ = qMul(qFromUnitVectors(qRotate(prevQ, LOCAL_RIGHT), scale(dir, 1 / segLen)), prevQ);
      const q = qMul(bendQ, qFromAxisAngle(LOCAL_RIGHT, beltTwist[i]!));
      link.quaternion.set(q.x, q.y, q.z, q.w);
      prevQ = bendQ;
      prevPoint = pos;
    }
  }
}
