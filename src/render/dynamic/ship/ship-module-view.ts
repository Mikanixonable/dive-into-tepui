// 1モジュールの model、assembly transform、semantic anchor と表示状態を所有する。
import * as THREE from 'three/webgpu';
import type { Quat } from '../../../math/quat';
import { qNormalize } from '../../../math/quat';
import { sub, v3, type Vec3 } from '../../../math/vec3';
import { deployablePanelPoses, type DeployablePanelKind } from '../../../physics/ship-panel-layout';
import { disposeOwnedRenderResources } from '../../dispose-owned-render-resources';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import type {
  ShipModuleRenderInput, ShipModuleRenderKind, ShipModuleRenderTransform,
} from './ship-render-contract';

// 呼び出しごとに、この view が所有できる model root を返す factory。
export type ShipModuleModelFactory = (modelId: string) => THREE.Object3D;

// module 表示 hook が読む損傷率と展開率。
export interface ShipModuleVisualState {
  readonly id: string;
  readonly kind: ShipModuleRenderKind;
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

// 1 module の model、transform、semantic anchor、状態を所有する。
export class ShipModuleView {
  public readonly object = new THREE.Group();
  private model: THREE.Object3D;
  private inputValue: ShipModuleRenderInput;
  private centerOffsetValue: Vec3 = ZERO;
  private readonly anchors = new Map<string, THREE.Object3D>();
  private disposed = false;

  public constructor(
    input: ShipModuleRenderInput,
    private readonly modelFactory: ShipModuleModelFactory,
    centerOffset: Vec3 = ZERO,
  ) {
    this.inputValue = input;
    this.model = this.buildModel(input.modelId);
    this.object.name = `ship-module:${input.id}`;
    this.object.add(this.model);
    this.indexAnchors();
    this.sync(input, centerOffset);
  }

  public get id(): string { return this.inputValue.id; }
  public get input(): ShipModuleRenderInput { return this.inputValue; }
  public get transform(): ShipModuleRenderTransform { return this.inputValue.transform; }
  public get centerOffset(): Vec3 { return this.centerOffsetValue; }

  // module の transform を、ship の COM 原点からの表示位置へ反映する。
  public sync(
    input: ShipModuleRenderInput,
    centerOffset: Vec3 = ZERO,
  ): void {
    if (this.disposed) throw new Error('cannot sync a disposed ShipModuleView');
    if (input.id !== this.inputValue.id) {
      throw new Error(`module id changed without rebuilding view: ${input.id}`);
    }
    if (input.modelId !== this.inputValue.modelId) {
      throw new Error(`module model changed without rebuilding view: ${input.id}`);
    }
    this.inputValue = input;
    this.centerOffsetValue = v3(centerOffset.x, centerOffset.y, centerOffset.z);
    this.object.position.copy(toThreeVec(sub(input.transform.position, centerOffset)));
    const q = copyQuat(input.transform.rotation);
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
    this.syncVisualState();
  }

  // 名前付きの module-local anchor を返す。欠けていれば null。
  public semanticAnchor(name: string): THREE.Object3D | null {
    return this.anchors.get(name) ?? null;
  }

  public semanticAnchors(prefix: string): readonly THREE.Object3D[] {
    return [...this.anchors]
      .filter(([name]) => name.startsWith(prefix))
      .map(([, anchor]) => anchor);
  }

  // 現在の表示入力を表示 hook 用の正規化状態へ畳む。
  public get visualState(): ShipModuleVisualState {
    const maxHp = this.inputValue.maxHp;
    return {
      id: this.inputValue.id,
      kind: this.inputValue.kind,
      hp: this.inputValue.hp,
      maxHp,
      damage: maxHp <= 0 ? 0 : 1 - this.inputValue.hp / maxHp,
      deployed: this.inputValue.deployed,
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
      hinge.visible = state.hp > 0;
      const panels = this.semanticAnchors('panel-hinge:');
      const kind = (panels[0]?.userData.panelKind ?? null) as DeployablePanelKind | null;
      const poses = kind === null ? [] : deployablePanelPoses(kind, 0, state.deployed);
      for (const panel of panels) {
        const panelIndex = panel.userData.panelIndex as number;
        const pose = poses[panelIndex];
        if (pose === undefined) throw new Error(`panel index out of range: ${this.inputValue.modelId}#${panelIndex}`);
        panel.position.set(pose.origin.x, pose.origin.y, pose.origin.z);
        panel.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
      }
    }
    this.object.userData.shipModuleId = this.inputValue.id;
    this.object.userData.shipModuleKind = this.inputValue.kind;
    this.object.userData.shipModuleModelId = this.inputValue.modelId;
    this.object.userData.shipModuleVisualState = state;
    this.model.userData.shipModuleVisualState = state;
  }

  // 同じ module id の表示モデルを置換し、anchor index を更新する。
  public replaceModule(
    input: ShipModuleRenderInput,
    centerOffset: Vec3 = ZERO,
  ): void {
    if (this.disposed) throw new Error('cannot replace a disposed ShipModuleView');
    if (input.id !== this.inputValue.id) throw new Error(`module id changed during replacement: ${input.id}`);
    const old = this.model;
    this.model = this.buildModel(input.modelId);
    this.inputValue = input;
    this.object.remove(old);
    disposeOwnedRenderResources(old);
    this.object.add(this.model);
    this.indexAnchors();
    this.sync(input, centerOffset);
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
