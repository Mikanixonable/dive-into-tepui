// 1モジュールの model、assembly transform、semantic anchor と表示状態を所有する。
// 強調の宣言がある間は、model と形状を共有する殻を重ねて描く。選択中は背面に膨らませた
// 殻で白い輪郭を、それ以外の強調は加算合成で色を重ねる。
import * as THREE from 'three/webgpu';
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
const IDENTITY_SCALE = new THREE.Vector3(1, 1, 1);
const ZERO_POSITION = new THREE.Vector3();

// 色を重ねる強調(先端部・重なりの相手)の殻の色。UI の配色トークンは 3D 描画へ届かないので、
// 描画側の定数として持つ。
const WASH_COLORS: Record<'piece' | 'conflict', number> = {
  piece: 0x53c8f0,
  conflict: 0xff5b63,
};

// 殻の不透明度の上限。宣言の intensity が掛かる。
const EMPHASIS_OPACITY = 0.45;

// 選択の輪郭の色と不透明度の上限。intensity が掛かる。
const OUTLINE_COLOR = 0xffffff;
const OUTLINE_OPACITY = 0.9;
// 選択の輪郭がモジュールの外側へ出る幅 [m]。シルエットを越えて一定の太さで見える。
const OUTLINE_OFFSET = 0.12;

// object の semantic anchor 名を返す。userData.semanticAnchor を優先し、'anchor:'
// 接頭辞の object.name も同名として扱う。anchor でなければ null。
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
  // 強調の宣言が来たフレームにだけ組む殻。洗い(加算)と輪郭(背面に膨らませた複製)の2つの
  // material を持ち、tone に応じてどちらかを貼る。outlineScale/outlineShift は輪郭用の
  // 拡大で、bounding box の中心を基点に両側へ OUTLINE_OFFSET ずつ出る。
  private shell: {
    object: THREE.Object3D;
    wash: THREE.MeshBasicMaterial;
    outline: THREE.MeshBasicMaterial;
    outlineScale: THREE.Vector3;
    outlineShift: THREE.Vector3;
    appliedTone: ShipModuleEmphasisTone | null;
  } | null = null;
  private disposed = false;

  // model を組んで object へ足し、最初の表示状態へ同期する。
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
    // 表示位置は COM 原点へ寄せ、強調のずらしを乗せる。
    const offset = emphasis?.offset ?? ZERO;
    const position = add(sub(input.transform.position, centerOffset), offset);
    this.object.position.set(position.x, position.y, position.z);
    const q = qNormalize(input.transform.rotation);
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
    this.syncEmphasis(emphasis);
    this.syncVisualState();
  }

  // 名前付きの module-local anchor を返す。欠けていれば null。
  public semanticAnchor(name: string): THREE.Object3D | null {
    return this.anchors.get(name) ?? null;
  }

  // prefix で始まる名前付きの module-local anchor を返す。
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

  // modelId の model を組み、不透明・影の描画チャンネルへ印す。
  private buildModel(modelId: string): THREE.Object3D {
    const model = this.modelFactory(modelId);
    if (!(model instanceof THREE.Object3D)) throw new Error(`ship model factory returned no Object3D: ${modelId}`);
    markLitOpaque(model);
    markShadowCaster(model);
    return model;
  }

  // 強調の宣言を殻へ反映する。選択中は bounding box の中心から膨らませた背面の殻で白い
  // 輪郭を描き、それ以外は model の形状を共有する複製へ加算で色を重ねる。
  private syncEmphasis(emphasis: ShipModuleEmphasis | null): void {
    // 宣言が無ければ殻を伏せて戻る。
    if (emphasis === null) {
      if (this.shell !== null) this.shell.object.visible = false;
      return;
    }
    const shell = this.shell ?? this.buildShell();
    shell.object.visible = true;
    // tone が切り替わったときだけ、殻の material と拡大を貼り直す。
    const outlined = emphasis.tone === 'selected';
    if (shell.appliedTone !== emphasis.tone) {
      shell.appliedTone = emphasis.tone;
      shell.object.scale.copy(outlined ? shell.outlineScale : IDENTITY_SCALE);
      shell.object.position.copy(outlined ? shell.outlineShift : ZERO_POSITION);
      const material = outlined ? shell.outline : shell.wash;
      shell.object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) mesh.material = material;
      });
    }
    // 強さを殻の色・不透明度へ掛ける。
    const intensity = Math.min(1, Math.max(0, emphasis.intensity));
    if (outlined) {
      shell.outline.opacity = OUTLINE_OPACITY * intensity;
    } else {
      shell.wash.color.setHex(WASH_COLORS[emphasis.tone as 'piece' | 'conflict']);
      shell.wash.opacity = EMPHASIS_OPACITY * intensity;
    }
  }

  // model の複製(geometry は共有)へ殻の material を貼り、overlay チャンネルへ置いて返す。
  // 輪郭用の拡大は複製のローカル bounding box から、軸ごとに両側へ OUTLINE_OFFSET ずつ
  // 出る縮尺と、拡大の基点を box の中心へ置くずらしで求める。
  private buildShell(): NonNullable<ShipModuleView['shell']> {
    const wash = new THREE.MeshBasicMaterial({
      name: 'ship-module-emphasis-wash',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });
    // 輪郭は本体を一回り大きくした殻の背面だけを描いて、シルエットを白く縁取る。
    const outline = new THREE.MeshBasicMaterial({
      name: 'ship-module-emphasis-outline',
      color: OUTLINE_COLOR,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.BackSide,
      toneMapped: false,
    });
    const object = this.model.clone(true);
    object.name = `ship-module-emphasis:${this.inputValue.id}`;
    object.traverse((child) => {
      // geometry は model と共有、material はこの view が単独で持つので、複製に所有を残さない。
      child.userData.ownsGeometry = false;
      child.userData.ownsMaterial = false;
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.material = wash;
    });
    markOverlay(object);
    this.object.add(object);
    const { outlineScale, outlineShift } = outlineExpansion(object);
    this.shell = { object, wash, outline, outlineScale, outlineShift, appliedTone: null };
    return this.shell;
  }

  // 殻を表示ツリーから外し、material を解放する。共有している geometry は model 側の資源なので触らない。
  private disposeShell(): void {
    if (this.shell === null) return;
    this.object.remove(this.shell.object);
    this.shell.wash.dispose();
    this.shell.outline.dispose();
    this.shell = null;
  }

  // model 配下の semantic anchor 名 → object の索引を組み直す。同名は先勝ち。
  private indexAnchors(): void {
    this.anchors.clear();
    this.model.traverse((object) => {
      const name = semanticName(object);
      if (name !== null && !this.anchors.has(name)) this.anchors.set(name, object);
    });
  }

  // 展開パネルの姿勢を展開率へ合わせ、module の表示状態を userData へ記録する。
  private syncVisualState(): void {
    const state = this.visualState;
    // panel-hinge 付きの model は、展開率に応じた姿勢へ各パネルを置く。全損では畳んだままにする。
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
    // 殻は古い形状の複製なので畳み、次の sync で新しい形状へ組み直される。
    this.disposeShell();
    this.sync(input, centerOffset, emphasis);
  }

  // 殻と model の表示資源を解放し、anchor 索引を空にする。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeShell();
    this.object.remove(this.model);
    disposeOwnedRenderResources(this.model);
    this.anchors.clear();
  }
}

// 殻の複製のローカル bounding box から、輪郭用の拡大の縮尺とずらしを求める。軸ごとの縮尺は
// 面から両側へ OUTLINE_OFFSET ずつ出る値、ずらしは拡大の基点を box の中心へ置くためのもの。
// 空の box しか無い複製は拡大しない。
function outlineExpansion(object: THREE.Object3D): {
  outlineScale: THREE.Vector3;
  outlineShift: THREE.Vector3;
} {
  // 複製のローカル座標へ全メッシュの bounding box を畳み込む。
  object.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  const meshBounds = new THREE.Box3();
  const bounds = new THREE.Box3();
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
    relative.multiplyMatrices(inverse, mesh.matrixWorld);
    meshBounds.copy(mesh.geometry.boundingBox as THREE.Box3).applyMatrix4(relative);
    bounds.union(meshBounds);
  });
  const outlineScale = new THREE.Vector3(1, 1, 1);
  const outlineShift = new THREE.Vector3();
  if (bounds.isEmpty()) return { outlineScale, outlineShift };
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  // 軸ごとに、box の面から両側へ OUTLINE_OFFSET 出る縮尺と、中心基点のずらしを求める。
  for (const axis of ['x', 'y', 'z'] as const) {
    if (size[axis] < 1e-6) continue;
    const scale = 1 + (2 * OUTLINE_OFFSET) / size[axis];
    outlineScale[axis] = scale;
    outlineShift[axis] = center[axis] * (1 - scale);
  }
  return { outlineScale, outlineShift };
}
