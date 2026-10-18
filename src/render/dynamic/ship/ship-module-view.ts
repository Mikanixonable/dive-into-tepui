// 1モジュールの model、assembly transform、semantic anchor と表示状態を所有する。
// 強調の宣言がある間は、model と形状を共有する加算合成の殻を重ねて描く。
import * as THREE from 'three/webgpu';
import type { Quat } from '../../../math/quat';
import { qNormalize } from '../../../math/quat';
import { add, sub, v3, type Vec3 } from '../../../math/vec3';
import { deployablePanelPoses, type DeployablePanelKind } from '../../../physics/ship-panel-layout';
import { disposeOwnedRenderResources } from '../../dispose-owned-render-resources';
import { markLitOpaque, markOverlay, markShadowCaster } from '../../pipeline/lit-layer';
import type {
  ShipModuleEmphasis, ShipModuleEmphasisTone,
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

// 強調の殻の色。UI の配色トークンは 3D 描画へ届かないので、描画側の定数として持つ。
const EMPHASIS_COLORS: Record<ShipModuleEmphasisTone, number> = {
  selected: 0xffc85c,
  piece: 0x53c8f0,
  conflict: 0xff5b63,
};

// 殻の不透明度の上限。宣言の intensity が掛かる。
const EMPHASIS_OPACITY = 0.45;

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
  // 強調の宣言が来たフレームにだけ組む、加算合成の殻とその material。
  private shell: { object: THREE.Object3D; material: THREE.MeshBasicMaterial } | null = null;
  private disposed = false;

  public constructor(
    input: ShipModuleRenderInput,
    private readonly modelFactory: ShipModuleModelFactory,
    centerOffset: Vec3 = ZERO,
    emphasis: ShipModuleEmphasis | null = null,
  ) {
    this.inputValue = input;
    this.model = this.buildModel(input.modelId);
    this.object.name = `ship-module:${input.id}`;
    this.object.add(this.model);
    this.indexAnchors();
    this.sync(input, centerOffset, emphasis);
  }

  public get id(): string { return this.inputValue.id; }
  public get input(): ShipModuleRenderInput { return this.inputValue; }
  public get transform(): ShipModuleRenderTransform { return this.inputValue.transform; }
  public get centerOffset(): Vec3 { return this.centerOffsetValue; }

  // module の transform を、ship の COM 原点からの表示位置へ反映する。emphasis はそのモジュールへの
  // 強調とずらしの宣言で、無ければ殻を隠しずらしも 0 に戻す。
  public sync(
    input: ShipModuleRenderInput,
    centerOffset: Vec3 = ZERO,
    emphasis: ShipModuleEmphasis | null = null,
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
    const offset = emphasis?.offset ?? ZERO;
    this.object.position.copy(toThreeVec(add(sub(input.transform.position, centerOffset), offset)));
    const q = copyQuat(input.transform.rotation);
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
    this.syncEmphasis(emphasis);
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

  // 強調の宣言を殻へ反映する。殻は model の形状を共有する複製で、熱発光とは別に加算で重ねる。
  private syncEmphasis(emphasis: ShipModuleEmphasis | null): void {
    if (emphasis === null) {
      if (this.shell !== null) this.shell.object.visible = false;
      return;
    }
    const shell = this.shell ?? this.buildShell();
    shell.object.visible = true;
    shell.material.color.setHex(EMPHASIS_COLORS[emphasis.tone]);
    shell.material.opacity = EMPHASIS_OPACITY * Math.min(1, Math.max(0, emphasis.intensity));
  }

  // model の複製(geometry は共有)へ殻の material を貼り、overlay チャンネルへ置いて返す。
  // 本体メッシュと同じ面を覆うので、深度の縁取りで手前へ引いてちらつきを避ける。
  private buildShell(): { object: THREE.Object3D; material: THREE.MeshBasicMaterial } {
    const material = new THREE.MeshBasicMaterial({
      name: 'ship-module-emphasis',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });
    const object = this.model.clone(true);
    object.name = `ship-module-emphasis:${this.inputValue.id}`;
    object.traverse((child) => {
      // geometry は model と共有、material はこの view が単独で持つので、複製に所有を残さない。
      child.userData.ownsGeometry = false;
      child.userData.ownsMaterial = false;
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.material = material;
    });
    markOverlay(object);
    this.object.add(object);
    this.shell = { object, material };
    return this.shell;
  }

  // 殻を表示ツリーから外し、material を解放する。共有している geometry は model 側の資源なので触らない。
  private disposeShell(): void {
    if (this.shell === null) return;
    this.object.remove(this.shell.object);
    this.shell.material.dispose();
    this.shell = null;
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

  // 同じ module id の表示モデルを置換し、anchor index と殻を新しい形状へ組み直す。
  public replaceModule(
    input: ShipModuleRenderInput,
    centerOffset: Vec3 = ZERO,
    emphasis: ShipModuleEmphasis | null = null,
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
    this.disposeShell();
    this.sync(input, centerOffset, emphasis);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeShell();
    this.object.remove(this.model);
    disposeOwnedRenderResources(this.model);
    this.anchors.clear();
  }
}

function toThreeVec(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}
