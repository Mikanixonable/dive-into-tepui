import * as THREE from 'three/webgpu';
import type { Quat } from '../../../math/quat';
import { qNormalize } from '../../../math/quat';
import { sub, v3, type Vec3 } from '../../../math/vec3';
import type { ModuleTransform } from '../../../game/ship/ship-assembly';
import type { ShipModuleDefinition } from '../../../game/ship/ship-module-definition';
import type { ShipModuleInstance } from '../../../game/ship/ship-module-instance';
import { disposeOwnedRenderResources } from '../../dispose-owned-render-resources';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';

// Asset のロード方式は render 層の外側で決める。factory は呼び出しごとに、この view が所有できる
// model の新しい root を返す。共有 geometry/material を使う場合は baked-model の共有 clone を返す。
export type ShipModuleModelFactory = (modelId: string) => THREE.Object3D;

// 損傷・展開値は view の内部で解釈せず、親が狭い状態面だけを読むための値として公開する。
export interface ShipModuleVisualState {
  readonly id: string;
  readonly kind: ShipModuleInstance['kind'];
  readonly hp: number;
  readonly maxHp: number;
  readonly damage: number;
  readonly deployed: number | null;
}

const ZERO = v3();

function copyQuat(q: Quat): Quat {
  return qNormalize(q);
}

function semanticName(object: THREE.Object3D): string | null {
  const value = object.userData.semanticAnchor;
  if (typeof value === 'string') return value;
  if (object.name.startsWith('anchor:')) return object.name.slice('anchor:'.length);
  return null;
}

// 1 module の model、transform、semantic anchor、状態を所有する。assembly graph の判断は行わない。
export class ShipModuleView {
  public readonly object = new THREE.Group();
  private model: THREE.Object3D;
  private definitionValue: ShipModuleDefinition;
  private instanceValue: ShipModuleInstance;
  private transformValue: ModuleTransform;
  private centerOffsetValue: Vec3 = ZERO;
  private readonly anchors = new Map<string, THREE.Object3D>();
  private disposed = false;

  public constructor(
    instance: ShipModuleInstance,
    definition: ShipModuleDefinition,
    transform: ModuleTransform,
    private readonly modelFactory: ShipModuleModelFactory,
    centerOffset: Vec3 = ZERO,
  ) {
    this.instanceValue = instance;
    this.definitionValue = definition;
    this.transformValue = transform;
    this.model = this.buildModel(definition.modelId);
    this.object.name = `ship-module:${instance.id}`;
    this.object.add(this.model);
    this.indexAnchors();
    this.sync(instance, transform, centerOffset);
  }

  public get id(): string { return this.instanceValue.id; }
  public get instance(): ShipModuleInstance { return this.instanceValue; }
  public get definition(): ShipModuleDefinition { return this.definitionValue; }
  public get transform(): ModuleTransform { return this.transformValue; }
  public get centerOffset(): Vec3 { return this.centerOffsetValue; }

  // assembly の module world transform を、ship の COM 原点からの表示位置へ反映する。
  public sync(
    instance: ShipModuleInstance,
    transform: ModuleTransform,
    centerOffset: Vec3 = ZERO,
  ): void {
    if (this.disposed) throw new Error('cannot sync a disposed ShipModuleView');
    const definition = this.definitionValue;
    if (instance.definitionId !== definition.id) {
      throw new Error(`module definition changed without rebuilding view: ${instance.id}`);
    }
    this.instanceValue = instance;
    this.transformValue = transform;
    this.centerOffsetValue = v3(centerOffset.x, centerOffset.y, centerOffset.z);
    this.object.position.copy(toThreeVec(sub(transform.position, centerOffset)));
    const q = copyQuat(transform.rotation);
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
    this.syncVisualState();
  }

  // semanticAnchor の値は module-local の Object3D。親が world 座標を必要とする場合は
  // getWorldPosition/getWorldQuaternion を使い、描画ツリーの所有権を view 外へ移さない。
  public semanticAnchor(name: string): THREE.Object3D | null {
    return this.anchors.get(name) ?? null;
  }

  public semanticAnchors(prefix: string): readonly THREE.Object3D[] {
    return [...this.anchors]
      .filter(([name]) => name.startsWith(prefix))
      .map(([, anchor]) => anchor);
  }

  public anchor(name: string): THREE.Object3D | null { return this.semanticAnchor(name); }

  // 損傷・展開を既存資源へ反映する hook 用の狭い state 面。material を共有している可能性が
  // あるため、ここでは共有 material の色や透明度を直接書き換えない。
  public get visualState(): ShipModuleVisualState {
    const maxHp = this.definitionValue.maxHp;
    const deployed = this.instanceValue.kind === 'radiator' || this.instanceValue.kind === 'solar_panel'
      ? this.instanceValue.deployed : null;
    return {
      id: this.instanceValue.id,
      kind: this.instanceValue.kind,
      hp: this.instanceValue.hp,
      maxHp,
      damage: maxHp <= 0 ? 0 : 1 - this.instanceValue.hp / maxHp,
      deployed,
    };
  }

  private buildModel(modelId: string): THREE.Object3D {
    const model = this.modelFactory(modelId);
    if (!(model instanceof THREE.Object3D)) throw new Error(`ship model factory returned no Object3D: ${modelId}`);
    markLitOpaque(model);
    markShadowCaster(model);
    return model;
  }

  private indexAnchors(): void {
    this.anchors.clear();
    this.model.traverse((object) => {
      const name = semanticName(object);
      if (name !== null && !this.anchors.has(name)) this.anchors.set(name, object);
    });
  }

  private syncVisualState(): void {
    const state = this.visualState;
    const hinge = this.semanticAnchor('panel-hinge');
    if (hinge !== null && state.deployed !== null) {
      // asset は全開位置を 0 とし、収納時は module の長手軸へ90度畳む。
      hinge.rotation.y = (1 - state.deployed) * Math.PI / 2;
      hinge.visible = state.hp > 0;
    }
    this.object.userData.shipModuleId = this.instanceValue.id;
    this.object.userData.shipModuleKind = this.instanceValue.kind;
    this.object.userData.shipModuleModelId = this.definitionValue.modelId;
    this.object.userData.shipModuleVisualState = state;
    this.model.userData.shipModuleVisualState = state;
  }

  // model の差し替えは同一 instance id を別 definition へ再利用する場合のために明示的に公開する。
  // 古い model は先に tree から外してから所有資源を解放し、anchor の残骸を残さない。
  public replaceDefinition(
    instance: ShipModuleInstance,
    definition: ShipModuleDefinition,
    transform: ModuleTransform,
    centerOffset: Vec3 = ZERO,
  ): void {
    if (this.disposed) throw new Error('cannot replace a disposed ShipModuleView');
    if (instance.id !== this.instanceValue.id) throw new Error(`module id changed during replacement: ${instance.id}`);
    const old = this.model;
    this.model = this.buildModel(definition.modelId);
    this.definitionValue = definition;
    this.object.remove(old);
    disposeOwnedRenderResources(old);
    this.object.add(this.model);
    this.indexAnchors();
    this.sync(instance, transform, centerOffset);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.remove(this.model);
    disposeOwnedRenderResources(this.model);
    this.anchors.clear();
  }
}

function toThreeVec(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}
