// 建造候補モジュールを配置可否の色付き半透明ゴーストとして描画する。
import * as THREE from 'three/webgpu';
import { qNormalize, type Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';
import { disposeOwnedRenderResources } from '../../dispose-owned-render-resources';
import { markOverlay } from '../../pipeline/lit-layer';
import { buildShipModuleModel } from './ship-module-models';
import type { ShipModuleModelFactory } from './ship-module-view';

const VALID_COLOR = 0x53f089;
const INVALID_COLOR = 0xff5b63;
const GHOST_OPACITY = 0.35;

// 建造候補の world transform と配置可否。
export interface ShipGhostDisplay {
  readonly modelId: string;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly valid: boolean;
}

// 建造中の module 1個を専用の半透明 material で描く。
export class ShipGhostView {
  public readonly object = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private modelId: string | null = null;
  private disposed = false;

  public constructor(
    private readonly scene?: THREE.Scene,
    private readonly modelFactory: ShipModuleModelFactory = buildShipModuleModel,
    addToScene = true,
  ) {
    this.object.name = 'ship-ghost';
    this.object.visible = false;
    markOverlay(this.object);
    if (addToScene) scene?.add(this.object);
  }

  // null で非表示にし、候補があれば model・world pose・可否色を同期する。
  public sync(display: ShipGhostDisplay | null): void {
    if (this.disposed) throw new Error('cannot sync a disposed ShipGhostView');
    this.object.visible = display !== null;
    if (display === null) return;
    if (display.modelId !== this.modelId) this.replaceModel(display.modelId);
    this.object.position.set(display.position.x, display.position.y, display.position.z);
    this.setQuaternion(display.rotation);
    this.tint(display.valid ? VALID_COLOR : INVALID_COLOR);
    this.object.userData.shipGhostModelId = display.modelId;
    this.object.userData.shipGhostValid = display.valid;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeModel();
    this.scene?.remove(this.object);
  }

  private replaceModel(modelId: string): void {
    this.removeModel();
    const model = this.modelFactory(modelId);
    if (!(model instanceof THREE.Object3D)) throw new Error(`ship model factory returned no Object3D: ${modelId}`);
    this.prepareGhostMaterials(model);
    model.traverse((object) => { object.renderOrder = 0; });
    this.object.add(model);
    markOverlay(this.object);
    this.model = model;
    this.modelId = modelId;
  }

  private removeModel(): void {
    if (this.model === null) return;
    this.object.remove(this.model);
    disposeOwnedRenderResources(this.model);
    this.model = null;
    this.modelId = null;
  }

  // 通常船と material を共有すると ghost の透過色が伝播するため、専用 clone へ置換する。
  private prepareGhostMaterials(model: THREE.Object3D): void {
    const replacements: {
      readonly mesh: THREE.Mesh;
      readonly original: THREE.Material[];
      readonly array: boolean;
      readonly ghost: THREE.Material[];
      readonly ownsOriginal: boolean;
    }[] = [];
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = mesh.material as THREE.Material | THREE.Material[];
      const array = Array.isArray(source);
      const original: THREE.Material[] = array ? source : [source];
      replacements.push({
        mesh,
        original,
        array,
        ghost: original.map((material) => this.ghostMaterial(material)),
        ownsOriginal: mesh.userData.ownsMaterial === true,
      });
    });
    const disposed = new Set<THREE.Material>();
    for (const replacement of replacements) {
      if (replacement.ownsOriginal) {
        for (const material of replacement.original) {
          if (disposed.has(material)) continue;
          material.dispose();
          disposed.add(material);
        }
      }
      const firstGhost = replacement.ghost[0];
      if (firstGhost === undefined) throw new Error('ship ghost model has no material');
      replacement.mesh.material = replacement.array ? replacement.ghost : firstGhost;
      replacement.mesh.userData.ownsMaterial = true;
    }
  }

  private ghostMaterial(source: THREE.Material): THREE.Material {
    return new THREE.MeshBasicMaterial({
      name: `${source.name}:construction-ghost`,
      color: VALID_COLOR,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthTest: true,
      depthWrite: false,
      side: source.side,
      toneMapped: false,
    });
  }

  private tint(color: number): void {
    this.model?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const colored = material as THREE.Material & { color?: THREE.Color };
        colored.color?.set(color);
      }
    });
  }

  private setQuaternion(rotation: Quat): void {
    const q = qNormalize(rotation);
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
  }
}
