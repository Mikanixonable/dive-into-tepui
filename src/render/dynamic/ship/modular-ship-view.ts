// 描画モデルのモジュール別リソースを保持し、重心（COM）基準の表示ツリーへ同期する。
import * as THREE from 'three/webgpu';
import { v3, type Vec3 } from '../../../math/vec3';
import { ShipModuleView, type ShipModuleModelFactory } from './ship-module-view';
import type { ShipModuleRenderInput } from './ship-render-contract';

const ZERO = v3();

// ShipAssembly の module ごとの model view を一体で所有する。
export class ModularShipView {
  public readonly object = new THREE.Group();
  private readonly modules = new Map<string, ShipModuleView>();
  private disposed = false;

  public constructor(
    private readonly modelFactory: ShipModuleModelFactory,
    private readonly scene?: THREE.Scene,
    addToScene = true,
  ) {
    this.object.name = 'modular-ship';
    if (addToScene) scene?.add(this.object);
  }

  public get moduleCount(): number { return this.modules.size; }

  public module(id: string): ShipModuleView | null { return this.modules.get(id) ?? null; }

  public moduleViews(): readonly ShipModuleView[] { return [...this.modules.values()]; }

  // module 座標を ship の COM 原点へ合わせて同期する。centerOffset は physics shape の
  // centerOfMass と同じ assembly-local 軸で渡すので、model/collider の +Z/m を保てる。
  public sync(modules: readonly ShipModuleRenderInput[], centerOffset: Vec3 = ZERO): void {
    if (this.disposed) throw new Error('cannot sync a disposed ModularShipView');
    const live = new Set<string>();
    for (const module of modules) {
      live.add(module.id);
      const id = module.id;
      let view = this.modules.get(id);
      if (view === undefined) {
        view = new ShipModuleView(module, this.modelFactory, centerOffset);
        this.modules.set(id, view);
        this.object.add(view.object);
      } else if (view.input.modelId !== module.modelId) {
        view.replaceModule(module, centerOffset);
      } else {
        view.sync(module, centerOffset);
      }
    }
    for (const [id, view] of this.modules) {
      if (live.has(id)) continue;
      this.modules.delete(id);
      this.object.remove(view.object);
      view.dispose();
    }
    this.object.userData.shipModuleIds = [...live];
  }

  // 指定 module の名前付き local anchor を返す。欠けていれば null。
  public semanticAnchor(moduleId: string, name: string): THREE.Object3D | null {
    return this.modules.get(moduleId)?.semanticAnchor(name) ?? null;
  }

  public semanticAnchors(moduleId: string, prefix: string): readonly THREE.Object3D[] {
    return this.modules.get(moduleId)?.semanticAnchors(prefix) ?? [];
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const view of this.modules.values()) view.dispose();
    this.modules.clear();
    this.scene?.remove(this.object);
    this.object.clear();
  }
}
