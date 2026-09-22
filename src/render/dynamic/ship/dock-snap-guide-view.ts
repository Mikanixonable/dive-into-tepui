// 建造候補の接続面と妥当性を円形ガイドで描画する。
import * as THREE from 'three/webgpu';
import { qNormalize, type Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';
import { markOverlay } from '../../pipeline/lit-layer';

const VALID_COLOR = 0x53f089;
const INVALID_COLOR = 0xff5b63;
const GUIDE_OPACITY_SELECTED = 1.0;
const GUIDE_OPACITY_IDLE = 0.48;
const GUIDE_SEGMENTS = 64;

// dock の自由端に置く接続面を、world 座標で受け取る。rotation は module-local +Z を接続軸へ向ける。
export interface DockSnapGuideDisplay {
  readonly id?: string;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly radius: number;
  readonly valid: boolean;
  readonly selected?: boolean;
}

interface GuidePart {
  readonly object: THREE.Group;
  readonly material: THREE.LineBasicMaterial;
  readonly line: THREE.Line;
}

// 接続面を表す world-space の円。3D overlay だが depth test を保つので不透明物の奥では隠れる。
export class DockSnapGuideView {
  public readonly object = new THREE.Group();
  private readonly root = new THREE.Group();
  private readonly geometry = buildCircleGeometry();
  private readonly material = guideMaterial();
  private readonly line = new THREE.Line(this.geometry, this.material);
  private readonly extras = new Map<string, GuidePart>();
  private disposed = false;

  // 互換用の先頭guideと、複数候補を保持する親groupを一緒に作る。
  public constructor(private readonly scene?: THREE.Scene, addToScene = true) {
    this.root.name = 'dock-snap-guides';
    this.object.name = 'dock-snap-guide';
    this.object.visible = false;
    this.line.renderOrder = 1;
    this.object.add(this.line);
    this.root.add(this.object);
    markOverlay(this.root);
    if (addToScene) scene?.add(this.root);
  }

  // 既存の単一候補API。複数候補を使わない呼び手との互換性を保つ。
  public sync(display: DockSnapGuideDisplay | null): void {
    if (display === null) this.syncAll([]);
    else this.syncAll([{ ...display, id: display.id ?? 'single' }]);
  }

  // すべての候補を同じフレームの宣言として同期する。
  public syncAll(displays: readonly DockSnapGuideDisplay[]): void {
    if (this.disposed) throw new Error('cannot sync a disposed DockSnapGuideView');
    const first = displays[0];
    this.root.visible = first !== undefined;
    this.object.visible = first !== undefined;
    if (first !== undefined) this.syncPart({ object: this.object, material: this.material, line: this.line }, first);

    const activeIds = new Set<string>();
    for (let index = 1; index < displays.length; index++) {
      const display = displays[index];
      if (display === undefined) continue;
      const id = display.id ?? `guide-${index}`;
      activeIds.add(id);
      let part = this.extras.get(id);
      if (part === undefined) {
        part = this.createExtra();
        this.extras.set(id, part);
      }
      this.syncPart(part, display);
    }
    for (const [id, part] of this.extras) {
      if (activeIds.has(id)) continue;
      this.root.remove(part.object);
      part.material.dispose();
      this.extras.delete(id);
    }
  }

  // シーンから親groupを外し、共有geometryと個別materialを解放する。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene?.remove(this.root);
    this.root.remove(this.object);
    for (const part of this.extras.values()) {
      this.root.remove(part.object);
      part.material.dispose();
    }
    this.extras.clear();
    this.geometry.dispose();
    this.material.dispose();
  }

  // 先頭以外の候補だけはmaterialを分け、valid色を独立して更新できるようにする。
  private createExtra(): GuidePart {
    const object = new THREE.Group();
    const material = guideMaterial();
    const line = new THREE.Line(this.geometry, material);
    line.renderOrder = 1;
    object.add(line);
    markOverlay(object);
    this.root.add(object);
    return { object, material, line };
  }

  // 1候補の姿勢・半径・色をworld-space表示へ同期する。
  private syncPart(part: GuidePart, display: DockSnapGuideDisplay): void {
    if (!Number.isFinite(display.radius) || display.radius <= 0) {
      throw new Error(`dock snap guide radius must be positive: ${display.radius}`);
    }
    part.object.visible = true;
    part.object.position.set(display.position.x, display.position.y, display.position.z);
    const q = qNormalize(display.rotation);
    part.object.quaternion.set(q.x, q.y, q.z, q.w);
    part.object.scale.setScalar(display.radius * (display.selected ? 1.15 : 1));
    part.material.color.set(display.valid ? VALID_COLOR : INVALID_COLOR);
    part.material.opacity = display.selected ? GUIDE_OPACITY_SELECTED : GUIDE_OPACITY_IDLE;
    part.object.userData.dockSnapGuideValid = display.valid;
    part.object.userData.dockSnapGuideSelected = display.selected === true;
    part.object.userData.dockSnapGuideId = display.id;
  }
}

// 候補ごとの色だけを持つ軽量な線材質を作る。
function guideMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: VALID_COLOR, transparent: true, opacity: GUIDE_OPACITY_IDLE, depthTest: true, depthWrite: false,
  });
}

// 接続面の単位円は全候補で共有し、候補数に比例してgeometryを増やさない。
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
