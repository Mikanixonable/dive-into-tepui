// タンパク質の残基変形を GPU で解く器。**体ごとの区別は共有バッファ上の借り位置(uniform)
// だけに置く** — storage バッファの名前は WGSL の本文へ出るので、体ごとにバッファを作ると
// 敵が湧くたびにその体専用のシェーダがコンパイルされる。
import * as THREE from 'three/webgpu';
import type { UintUniform } from './tsl-types';

export const PROTEIN_RESIDUE_A_ATTRIBUTE = 'proteinResidueA';
export const PROTEIN_RESIDUE_B_ATTRIBUTE = 'proteinResidueB';
export const PROTEIN_RESIDUE_T_ATTRIBUTE = 'proteinResidueT';

/** 全タンパク質の残基変位を載せる共有バッファの容量 [vec4]。カタログ最大の残基数は 4713(6n2y)。 */
const PROTEIN_RESIDUE_SLOTS = 65536;
/** 同じくモード係数の共有バッファの容量 [float]。 */
const PROTEIN_MODE_SLOTS = 4096;

// compute pass が書き、頂点シェーダが読む残基変位。全体で 1 本しか持たない。
const residueOffsetBuffer = new THREE.StorageBufferAttribute(new Float32Array(PROTEIN_RESIDUE_SLOTS * 4), 4);
// そのフレームのモード振幅。CPU から書く。
const coefficientBuffer = new THREE.StorageBufferAttribute(new Float32Array(PROTEIN_MODE_SLOTS), 1);
// **ノード実体も 1 つずつしか作らない。** storage の構造体名にはノード id が入るので、
// 作り直すと本文が変わる。
const residueOffsetStorage = THREE.TSL.storage(residueOffsetBuffer, 'vec4', PROTEIN_RESIDUE_SLOTS);
const coefficientStorage = THREE.TSL.storage(coefficientBuffer, 'float', PROTEIN_MODE_SLOTS);

/** 共有バッファ上の連続区間。 */
interface Span {
  start: number;
  length: number;
}

/** 共有バッファの区間を貸し出す。返された区間は隣り合う空きと繋ぎ直す。 */
class SlotPool {
  // 空き区間。開始位置の昇順で、隣り合うものは常に繋がっている。
  private free: Span[];

  public constructor(capacity: number) {
    this.free = [{ start: 0, length: capacity }];
  }

  /** 借りた区間の先頭。連続した空きが足りなければ null。 */
  public acquire(length: number): number | null {
    const index = this.free.findIndex((span) => span.length >= length);
    if (index < 0) return null;
    const span = this.free[index]!;
    if (span.length === length) this.free.splice(index, 1);
    else this.free[index] = { start: span.start + length, length: span.length - length };
    return span.start;
  }

  /** 借りていた区間を空きへ戻す。**同じ区間を二度返してはならない。** */
  public release(start: number, length: number): void {
    const at = this.free.findIndex((span) => span.start > start);
    this.free.splice(at < 0 ? this.free.length : at, 0, { start, length });
    const merged: Span[] = [];
    for (const span of this.free) {
      const last = merged[merged.length - 1];
      if (last !== undefined && last.start + last.length === span.start) last.length += span.length;
      else merged.push({ ...span });
    }
    this.free = merged;
  }
}

const residueSlots = new SlotPool(PROTEIN_RESIDUE_SLOTS);
const modeSlots = new SlotPool(PROTEIN_MODE_SLOTS);

/** asset 単位で共有するモード基底(残基×モードの vec4)と、そのノード実体。 */
export interface ProteinModeDisplacements {
  readonly attribute: THREE.StorageBufferAttribute;
  // **同じ asset の体は同じノード実体を指す** — 作り直すと compute の本文が変わる。
  readonly storage: THREE.StorageBufferNode<'vec4'>;
  refCount: number;
}

/**
 * 敵1体ぶんの残基変形を、描画側から扱うための持ち手。
 *
 * compute pass が `modeDisplacements` とそのフレームのモード振幅を掛け合わせて共有バッファの
 * 借り位置を埋め、この binding から作ったマテリアルはみなそこを読む。
 * game 層を import せずに済むよう、受け取るのは素の typed array だけにしている。
 */
export interface ProteinMotionBinding {
  readonly residueCount: number;
  readonly modeCount: number;
  // 共有バッファ上の借り位置。**uniform は WGSL の本文へ出ない**ので、体が増えても
  // 頂点シェーダは 1 本のままでいる。
  readonly residueBase: UintUniform;
  readonly modeBase: UintUniform;
  readonly modeDisplacements: ProteinModeDisplacements;
  /** 初回の flush まで作らない — renderer を持たない呼び出し側でも binding を作れるようにするため。 */
  computeNode?: THREE.Node;
  disposed?: boolean;
}

const dirtyBindings = new Set<ProteinMotionBinding>();

/** asset 単位で共有するモード変位。鍵は、その asset の binding が共通で指す CPU 配列。 */
const sharedModeDisplacements = new WeakMap<Float32Array, ProteinModeDisplacements>();

function acquireModeDisplacements(modeDisplacements: Float32Array): ProteinModeDisplacements {
  const existing = sharedModeDisplacements.get(modeDisplacements);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }
  const attribute = new THREE.StorageBufferAttribute(modeDisplacements, 4);
  const shared: ProteinModeDisplacements = {
    attribute,
    storage: THREE.TSL.storage(attribute, 'vec4', modeDisplacements.length / 4),
    refCount: 1,
  };
  sharedModeDisplacements.set(modeDisplacements, shared);
  return shared;
}

/** 参照数を1つ減らし、尽きたなら true。 */
function releaseModeDisplacements(shared: ProteinModeDisplacements): boolean {
  shared.refCount -= 1;
  if (shared.refCount > 0) return false;
  sharedModeDisplacements.delete(shared.attribute.array as Float32Array);
  return true;
}

interface ProteinMotionRendererInternals {
  readonly _attributes: {
    has(attribute: THREE.StorageBufferAttribute): boolean;
    delete(attribute: THREE.StorageBufferAttribute): unknown;
  } | null;
}

const proteinMotionRenderers = new Map<ProteinMotionRendererInternals, number>();

type ProteinMotionNodeMaterial =
  | THREE.LineBasicNodeMaterial
  | THREE.MeshBasicNodeMaterial
  | THREE.MeshStandardNodeMaterial;

function assertResidueCount(residueCount: number): void {
  if (!Number.isInteger(residueCount) || residueCount <= 0) {
    throw new RangeError('Protein motion residueCount must be a positive integer');
  }
}

/**
 * 敵1体ぶんの binding を作る。共有バッファから残基変位とモード係数の区間を借り、体ごとの
 * 区別はその借り位置の uniform だけで表す。モード変位の GPU バッファは、同じ
 * `modeDisplacements`(= 同じ asset)から作った binding どうしで共有し、参照数が
 * 尽きたときだけ解放する。**空きが尽きたら null を返す** — 呼び手は motion 無しで描く。
 */
export function createProteinMotionBinding(
  residueCount: number,
  modeDisplacements: Float32Array,
  modeCount: number,
): ProteinMotionBinding | null {
  assertResidueCount(residueCount);
  if (modeDisplacements.length !== modeCount * residueCount * 4) {
    throw new RangeError('Protein motion mode displacements must contain one vec4 per mode per residue');
  }
  const residueStart = residueSlots.acquire(residueCount);
  if (residueStart === null) return null;
  const modeStart = modeSlots.acquire(modeCount);
  if (modeStart === null) {
    residueSlots.release(residueStart, residueCount);
    return null;
  }
  const binding: ProteinMotionBinding = {
    residueCount,
    modeCount,
    residueBase: THREE.TSL.uniform(residueStart, 'uint') as UintUniform,
    modeBase: THREE.TSL.uniform(modeStart, 'uint') as UintUniform,
    modeDisplacements: acquireModeDisplacements(modeDisplacements),
  };
  // 借りた区間には前の借り手の係数が残っている。0 を積んで compute を 1 度通し、
  // 変位が 0 の状態から始める。
  updateProteinMotionCoefficients(binding, new Float32Array(modeCount));
  return binding;
}

/** そのフレームのモード係数を書き込み、次の flush で compute を発行する対象に加える。 */
export function updateProteinMotionCoefficients(binding: ProteinMotionBinding, coefficients: ArrayLike<number>): void {
  if (coefficients.length !== binding.modeCount) {
    throw new RangeError('Protein motion coefficients must contain one value per mode');
  }
  const target = coefficientBuffer.array as Float32Array;
  const base = binding.modeBase.value;
  for (let index = 0; index < binding.modeCount; index += 1) target[base + index] = coefficients[index] ?? 0;
  coefficientBuffer.needsUpdate = true;
  dirtyBindings.add(binding);
}

/**
 * 残基ごとに全モードの寄与を足し込んで、共有バッファの借り位置を埋める compute ノードを組む。
 * **体ごとに 1 つ作る** — 借り位置の uniform を体ごとに持つ必要がある。本文が変わるのは
 * モード基底の名前だけなので、同じ asset の体どうしはシェーダを共有する。
 */
function proteinMotionComputeNode(binding: ProteinMotionBinding): THREE.Node {
  const { Fn, Loop, instanceIndex, uint, uniform } = THREE.TSL;
  const modeDisplacements = binding.modeDisplacements.storage;
  const residueCount = uniform(binding.residueCount, 'uint');
  const modeCount = uniform(binding.modeCount, 'uint');
  return Fn(() => {
    const total = THREE.TSL.vec3(0, 0, 0).toVar();
    Loop({ start: uint(0), end: modeCount, type: 'uint' }, ({ i }) => {
      const modeOffset = i.mul(residueCount).add(instanceIndex);
      total.addAssign(
        modeDisplacements.element(modeOffset).xyz.mul(coefficientStorage.element(binding.modeBase.add(i))),
      );
    });
    residueOffsetStorage.element(binding.residueBase.add(instanceIndex)).xyz.assign(total);
  })().compute(binding.residueCount) as THREE.Node;
}

/** 係数が更新された binding それぞれへ compute pass を発行する。影パスより前に呼ぶ。 */
export function flushProteinMotionComputes(renderer: THREE.WebGPURenderer): void {
  for (const binding of dirtyBindings) {
    if (!binding.computeNode) binding.computeNode = proteinMotionComputeNode(binding);
    renderer.compute(binding.computeNode as THREE.ComputeNode, binding.residueCount);
  }
  dirtyBindings.clear();
}

// 残基バッファを持ちうるレンダラを登録し、登録を解く関数を返す。同じレンダラを共有する
// パイプラインのために参照カウントで数える。**three は StorageBufferAttribute の解放口を
// 公開していない** — バックエンドのバッファを壊して renderer.info を更新できるのは内部の
// 属性レジストリだけなので、そこへ触れる箇所をこの登録へ閉じ込める。
export function registerProteinMotionRenderer(renderer: THREE.WebGPURenderer): () => void {
  const internals = renderer as THREE.WebGPURenderer & ProteinMotionRendererInternals;
  proteinMotionRenderers.set(internals, (proteinMotionRenderers.get(internals) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const remaining = (proteinMotionRenderers.get(internals) ?? 1) - 1;
    if (remaining > 0) proteinMotionRenderers.set(internals, remaining);
    else proteinMotionRenderers.delete(internals);
  };
}

/**
 * 借りていた区間を返し、この binding が持つ GPU バッファを renderer から解放する。
 * モード変位のバッファは同じ asset の binding で共有しているので、参照数が尽きたときだけ
 * 解放する — まだ使っている binding があるのに解放すると画面がまるごと黒くなる。
 * 共有元の `Float32Array` はどちらの場合も壊さない。
 */
export function disposeProteinMotionBinding(binding: ProteinMotionBinding): void {
  if (binding.disposed) return;
  binding.disposed = true;
  dirtyBindings.delete(binding);
  residueSlots.release(binding.residueBase.value, binding.residueCount);
  modeSlots.release(binding.modeBase.value, binding.modeCount);
  if (!releaseModeDisplacements(binding.modeDisplacements)) return;
  const { attribute } = binding.modeDisplacements;
  for (const renderer of proteinMotionRenderers.keys()) {
    const attributes = renderer._attributes;
    if (attributes?.has(attribute)) attributes.delete(attribute);
  }
  attribute.array = new Float32Array(0);
  attribute.needsUpdate = true;
}

function residueOffsetNode(binding: ProteinMotionBinding): THREE.Node<'vec3'> {
  assertResidueCount(binding.residueCount);
  const residueA = THREE.TSL.attribute(PROTEIN_RESIDUE_A_ATTRIBUTE, 'uint') as THREE.Node<'uint'>;
  const residueB = THREE.TSL.attribute(PROTEIN_RESIDUE_B_ATTRIBUTE, 'uint') as THREE.Node<'uint'>;
  const residueT = THREE.TSL.attribute(PROTEIN_RESIDUE_T_ATTRIBUTE, 'float') as THREE.Node<'float'>;
  const base = binding.residueBase;
  const offsetA = residueOffsetStorage.element(base.add(residueA)).xyz;
  const offsetB = residueOffsetStorage.element(base.add(residueB)).xyz;
  return offsetA.mul(THREE.TSL.float(1).sub(residueT)).add(offsetB.mul(residueT));
}

// 共有の残基変位をマテリアルのローカル位置へ結ぶ。positionNode は元の物体のマテリアルが
// 持つので、G バッファと override マテリアルの影の経路が同じノードをそのまま運べる。
function applyProteinMotionBinding<T extends ProteinMotionNodeMaterial>(
  material: T,
  binding: ProteinMotionBinding,
): T {
  material.positionNode = THREE.TSL.positionLocal.add(residueOffsetNode(binding));
  material.userData.proteinMotionBinding = binding;
  material.userData.proteinMotionPositionNode = true;
  return material;
}

export function proteinStandardMaterial(
  parameters: THREE.MeshStandardNodeMaterialParameters,
  binding?: ProteinMotionBinding,
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial(parameters);
  return binding ? applyProteinMotionBinding(material, binding) : material;
}

export function proteinLineMaterial(
  parameters: THREE.LineBasicNodeMaterialParameters,
  binding?: ProteinMotionBinding,
): THREE.LineBasicNodeMaterial {
  const material = new THREE.LineBasicNodeMaterial(parameters);
  return binding ? applyProteinMotionBinding(material, binding) : material;
}

function assertAttributeLength(name: string, values: ArrayLike<number>, count: number): void {
  if (values.length !== count) throw new RangeError(`${name} must match geometry vertex count`);
}

// 補間つきの残基インデックスを、通常のメッシュ/線のジオメトリへ結ぶ。
export function attachProteinResidueBinding(
  geometry: THREE.BufferGeometry,
  residueA: ArrayLike<number>,
  residueB: ArrayLike<number> = residueA,
  residueT: ArrayLike<number> = new Float32Array(residueA.length),
): void {
  const count = geometry.getAttribute('position')?.count ?? 0;
  assertAttributeLength(PROTEIN_RESIDUE_A_ATTRIBUTE, residueA, count);
  assertAttributeLength(PROTEIN_RESIDUE_B_ATTRIBUTE, residueB, count);
  assertAttributeLength(PROTEIN_RESIDUE_T_ATTRIBUTE, residueT, count);
  geometry.setAttribute(PROTEIN_RESIDUE_A_ATTRIBUTE, new THREE.Uint32BufferAttribute(Uint32Array.from(residueA), 1));
  geometry.setAttribute(PROTEIN_RESIDUE_B_ATTRIBUTE, new THREE.Uint32BufferAttribute(Uint32Array.from(residueB), 1));
  geometry.setAttribute(PROTEIN_RESIDUE_T_ATTRIBUTE, new THREE.Float32BufferAttribute(Float32Array.from(residueT), 1));
  geometry.userData.proteinResidueBinding = true;
}

// 補間つきの残基インデックスを、InstancedMesh のインスタンスデータへ結ぶ。
export function attachProteinInstancedResidueBinding(
  mesh: THREE.InstancedMesh,
  residueA: ArrayLike<number>,
  residueB: ArrayLike<number> = residueA,
  residueT: ArrayLike<number> = new Float32Array(residueA.length),
): void {
  if (residueA.length !== mesh.count || residueB.length !== mesh.count || residueT.length !== mesh.count) {
    throw new RangeError('Protein instance residue bindings must match InstancedMesh count');
  }
  mesh.geometry.setAttribute(PROTEIN_RESIDUE_A_ATTRIBUTE, new THREE.InstancedBufferAttribute(Uint32Array.from(residueA), 1));
  mesh.geometry.setAttribute(PROTEIN_RESIDUE_B_ATTRIBUTE, new THREE.InstancedBufferAttribute(Uint32Array.from(residueB), 1));
  mesh.geometry.setAttribute(PROTEIN_RESIDUE_T_ATTRIBUTE, new THREE.InstancedBufferAttribute(Float32Array.from(residueT), 1));
  mesh.geometry.userData.proteinResidueBinding = true;
}
