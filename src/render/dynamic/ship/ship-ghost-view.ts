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
// 持ち運んでいるものの色。配置の可否が決まっていない姿なので、可否の色とは別の中間色にする。
const CARRIED_COLOR = 0x9db8d8;
const GHOST_OPACITY = 0.35;

// 建造候補1つぶんの world transform と配置可否。floating を立てると持ち運び中の姿として、
// 可否の色の代わりに中間色で描く。
export interface ShipGhostDisplay {
  readonly modelId: string;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly valid: boolean;
  readonly floating?: boolean;
}

// 宣言1件が占有する表示単位。modelId が変わったときだけ model を差し替える。
interface GhostSlot {
  readonly object: THREE.Group;
  model: THREE.Object3D | null;
  modelId: string | null;
}

// 建造中の module 群を専用の半透明 material で描く。宣言の列の要素がそのままゴーストになる。
export class ShipGhostView {
  public readonly object = new THREE.Group();
  private readonly slots: GhostSlot[] = [];
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

  // 宣言の列をそのまま表示する。空なら全て隠す。スロットは宣言数ぶんまで増やして使い回し、
  // 余った分は model を保ったまま伏せる。
  public sync(displays: readonly ShipGhostDisplay[]): void {
    if (this.disposed) throw new Error('cannot sync a disposed ShipGhostView');
    this.object.visible = displays.length > 0;
    while (this.slots.length < displays.length) this.slots.push(this.createSlot());
    for (const [index, slot] of this.slots.entries()) {
      const display = displays[index];
      if (display === undefined) {
        slot.object.visible = false;
        continue;
      }
      slot.object.visible = true;
      if (display.modelId !== slot.modelId) this.replaceModel(slot, display.modelId);
      slot.object.position.set(display.position.x, display.position.y, display.position.z);
      const q = qNormalize(display.rotation);
      slot.object.quaternion.set(q.x, q.y, q.z, q.w);
      this.tint(
        slot,
        display.floating === true ? CARRIED_COLOR : display.valid ? VALID_COLOR : INVALID_COLOR,
      );
      slot.object.userData.shipGhostModelId = display.modelId;
      slot.object.userData.shipGhostValid = display.valid;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      this.object.remove(slot.object);
      disposeOwnedRenderResources(slot.object);
    }
    this.slots.length = 0;
    this.scene?.remove(this.object);
  }

  private createSlot(): GhostSlot {
    const object = new THREE.Group();
    object.name = `ship-ghost:${this.slots.length}`;
    object.visible = false;
    markOverlay(object);
    this.object.add(object);
    return { object, model: null, modelId: null };
  }

  private replaceModel(slot: GhostSlot, modelId: string): void {
    this.removeModel(slot);
    const model = this.modelFactory(modelId);
    if (!(model instanceof THREE.Object3D)) throw new Error(`ship model factory returned no Object3D: ${modelId}`);
    this.prepareGhostMaterials(model);
    model.traverse((object) => { object.renderOrder = 0; });
    slot.object.add(model);
    markOverlay(slot.object);
    slot.model = model;
    slot.modelId = modelId;
  }

  private removeModel(slot: GhostSlot): void {
    if (slot.model === null) return;
    slot.object.remove(slot.model);
    disposeOwnedRenderResources(slot.model);
    slot.model = null;
    slot.modelId = null;
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

  private tint(slot: GhostSlot, color: number): void {
    slot.model?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const colored = material as THREE.Material & { color?: THREE.Color };
        colored.color?.set(color);
      }
    });
  }
}
