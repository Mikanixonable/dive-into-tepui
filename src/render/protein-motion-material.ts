import * as THREE from 'three/webgpu';

export const PROTEIN_RESIDUE_A_ATTRIBUTE = 'proteinResidueA';
export const PROTEIN_RESIDUE_B_ATTRIBUTE = 'proteinResidueB';
export const PROTEIN_RESIDUE_T_ATTRIBUTE = 'proteinResidueT';

/**
 * 敵1体ぶんの残基変形を、描画側から扱うための持ち手。
 *
 * `modeDisplacements` は asset 由来の不変なモード基底(残基×モードの vec4)、
 * `coefficients` はそのフレームのモード振幅で、compute pass が両者を掛け合わせて
 * `residueOffsets` を埋める。この binding から作ったマテリアルはみなそれを読む。
 * game 層を import せずに済むよう、受け取るのは素の typed array だけにしている。
 */
export interface ProteinMotionBinding {
  readonly residueCount: number;
  readonly modeCount: number;
  readonly residueOffsets: THREE.StorageBufferAttribute;
  readonly modeDisplacements: THREE.StorageBufferAttribute;
  readonly coefficients: THREE.StorageBufferAttribute;
  /** 初回の flush まで作らない — renderer を持たない呼び出し側でも binding を作れるようにするため。 */
  computeNode?: THREE.Node;
  disposed?: boolean;
}

const dirtyBindings = new Set<ProteinMotionBinding>();

interface SharedModeDisplacementBuffer {
  readonly attribute: THREE.StorageBufferAttribute;
  refCount: number;
}

/** asset 単位で共有するモード変位の GPU バッファ。鍵は、その asset の binding が共通で指す CPU 配列。 */
const sharedModeDisplacementBuffers = new WeakMap<Float32Array, SharedModeDisplacementBuffer>();

function acquireModeDisplacements(modeDisplacements: Float32Array): THREE.StorageBufferAttribute {
  const existing = sharedModeDisplacementBuffers.get(modeDisplacements);
  if (existing) {
    existing.refCount += 1;
    return existing.attribute;
  }
  const attribute = new THREE.StorageBufferAttribute(modeDisplacements, 4);
  sharedModeDisplacementBuffers.set(modeDisplacements, { attribute, refCount: 1 });
  return attribute;
}

function releaseModeDisplacements(modeDisplacements: Float32Array): SharedModeDisplacementBuffer | null {
  const shared = sharedModeDisplacementBuffers.get(modeDisplacements);
  if (!shared) return null;
  shared.refCount -= 1;
  if (shared.refCount > 0) return null;
  sharedModeDisplacementBuffers.delete(modeDisplacements);
  return shared;
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
 * 敵1体ぶんの binding を作る。compute pass の書き込み先である残基変位バッファと、
 * 体ごとのモード係数バッファを持つ。モード変位の GPU バッファは、同じ
 * `modeDisplacements`(= 同じ asset)から作った binding どうしで共有し、参照数が
 * 尽きたときだけ解放する。
 */
export function createProteinMotionBinding(
  residueCount: number,
  modeDisplacements: Float32Array,
  modeCount: number,
): ProteinMotionBinding {
  assertResidueCount(residueCount);
  if (modeDisplacements.length !== modeCount * residueCount * 4) {
    throw new RangeError('Protein motion mode displacements must contain one vec4 per mode per residue');
  }
  return {
    residueCount,
    modeCount,
    residueOffsets: new THREE.StorageBufferAttribute(new Float32Array(residueCount * 4), 4),
    modeDisplacements: acquireModeDisplacements(modeDisplacements),
    coefficients: new THREE.StorageBufferAttribute(new Float32Array(modeCount), 1),
  };
}

/** そのフレームのモード係数を書き込み、次の flush で compute を発行する対象に加える。 */
export function updateProteinMotionCoefficients(binding: ProteinMotionBinding, coefficients: ArrayLike<number>): void {
  if (coefficients.length !== binding.modeCount) {
    throw new RangeError('Protein motion coefficients must contain one value per mode');
  }
  const target = binding.coefficients.array as Float32Array;
  for (let index = 0; index < target.length; index += 1) target[index] = coefficients[index] ?? 0;
  binding.coefficients.needsUpdate = true;
  dirtyBindings.add(binding);
}

/** 残基ごとに全モードの寄与を足し込んで `residueOffsets` を埋める compute ノードを組む。 */
function proteinMotionComputeNode(binding: ProteinMotionBinding): THREE.Node {
  const { Fn, Loop, storage, instanceIndex, uint } = THREE.TSL;
  const modeDisplacements = storage(binding.modeDisplacements, 'vec4', binding.modeCount * binding.residueCount);
  const coefficients = storage(binding.coefficients, 'float', binding.modeCount);
  const residueOffsets = storage(binding.residueOffsets, 'vec4', binding.residueCount);
  const residueCount = uint(binding.residueCount);
  return Fn(() => {
    const total = THREE.TSL.vec3(0, 0, 0).toVar();
    Loop({ start: uint(0), end: uint(binding.modeCount), type: 'uint' }, ({ i }) => {
      const modeOffset = i.mul(residueCount).add(instanceIndex);
      total.addAssign(modeDisplacements.element(modeOffset).xyz.mul(coefficients.element(i)));
    });
    residueOffsets.element(instanceIndex).xyz.assign(total);
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

/**
 * Register a renderer that may own protein storage buffers.
 *
 * Three r185 does not expose public disposal on StorageBufferAttribute. Its
 * internal attribute registry is the owner that destroys the backend buffer
 * and updates renderer.info, so the pinned renderer integration is isolated
 * here and reference-counted for pipelines that share one renderer.
 */
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
 * CPU 配列を手放す前に、この binding が持つ GPU バッファを renderer から解放する。
 * モード変位のバッファは同じ asset の binding で共有しているので、参照数が尽きたときだけ
 * 解放する — まだ使っている binding があるのに解放すると画面がまるごと黒くなる。
 * 共有元の `Float32Array` はどちらの場合も壊さない。
 */
export function disposeProteinMotionBinding(binding: ProteinMotionBinding): void {
  if (binding.disposed) return;
  binding.disposed = true;
  dirtyBindings.delete(binding);
  const releasedModeDisplacements = releaseModeDisplacements(binding.modeDisplacements.array as Float32Array);
  const releasedAttributes = [binding.residueOffsets, binding.coefficients];
  if (releasedModeDisplacements) releasedAttributes.push(releasedModeDisplacements.attribute);
  for (const renderer of proteinMotionRenderers.keys()) {
    const attributes = renderer._attributes;
    for (const attribute of releasedAttributes) {
      if (attributes?.has(attribute)) attributes.delete(attribute);
    }
  }
  binding.residueOffsets.array = new Float32Array(0);
  binding.residueOffsets.needsUpdate = true;
  binding.coefficients.array = new Float32Array(0);
  binding.coefficients.needsUpdate = true;
  if (releasedModeDisplacements) {
    releasedModeDisplacements.attribute.array = new Float32Array(0);
    releasedModeDisplacements.attribute.needsUpdate = true;
  }
}

function assertBinding(binding: ProteinMotionBinding): void {
  assertResidueCount(binding.residueCount);
  if (binding.residueOffsets.itemSize !== 4 || binding.residueOffsets.count !== binding.residueCount) {
    throw new RangeError('Protein motion binding must expose one vec4 per residue');
  }
}

function residueOffsetNode(binding: ProteinMotionBinding): THREE.Node<'vec3'> {
  assertBinding(binding);
  const offsets = THREE.TSL.storage(binding.residueOffsets, 'vec4', binding.residueCount);
  const residueA = THREE.TSL.attribute(PROTEIN_RESIDUE_A_ATTRIBUTE, 'uint') as THREE.Node<'uint'>;
  const residueB = THREE.TSL.attribute(PROTEIN_RESIDUE_B_ATTRIBUTE, 'uint') as THREE.Node<'uint'>;
  const residueT = THREE.TSL.attribute(PROTEIN_RESIDUE_T_ATTRIBUTE, 'float') as THREE.Node<'float'>;
  const offsetA = offsets.element(residueA).xyz;
  const offsetB = offsets.element(residueB).xyz;
  return offsetA.mul(THREE.TSL.float(1).sub(residueT)).add(offsetB.mul(residueT));
}

/**
 * Attach the shared residue deformation to a NodeMaterial's local position.
 * Because the positionNode belongs to the source object material, Three's
 * G-buffer and override-material shadow paths can carry the same node through.
 */
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

/** Attach interpolated residue indices to ordinary mesh/line geometry. */
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

/** Attach interpolated residue indices to InstancedMesh instance data. */
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
