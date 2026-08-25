import * as THREE from 'three/webgpu';

export const PROTEIN_RESIDUE_A_ATTRIBUTE = 'proteinResidueA';
export const PROTEIN_RESIDUE_B_ATTRIBUTE = 'proteinResidueB';
export const PROTEIN_RESIDUE_T_ATTRIBUTE = 'proteinResidueT';

/**
 * The render-side handle for a controller-owned residue offset buffer.
 *
 * The StorageBufferAttribute intentionally keeps the controller's Float32Array
 * as its backing array. A controller can update that array in place, set
 * `needsUpdate`, and every material made from this binding observes the same
 * GPU buffer. No runtime/controller import is required here — mode
 * displacements and coefficients arrive as plain typed arrays.
 */
export interface ProteinMotionBinding {
  readonly residueCount: number;
  readonly modeCount: number;
  readonly residueOffsets: THREE.StorageBufferAttribute;
  readonly modeDisplacements: THREE.StorageBufferAttribute;
  readonly coefficients: THREE.StorageBufferAttribute;
  /** Lazily built on the first flush so headless callers never need a renderer. */
  computeNode?: THREE.Node;
  disposed?: boolean;
}

const dirtyBindings = new Set<ProteinMotionBinding>();

interface ProteinMotionRendererInternals {
  readonly _attributes: {
    has(attribute: THREE.StorageBufferAttribute): boolean;
    delete(attribute: THREE.StorageBufferAttribute): unknown;
  } | null;
}

const proteinMotionRenderers = new Map<ProteinMotionRendererInternals, number>();

export type ProteinMotionNodeMaterial =
  | THREE.LineBasicNodeMaterial
  | THREE.MeshBasicNodeMaterial
  | THREE.MeshStandardNodeMaterial;

function assertResidueCount(residueCount: number): void {
  if (!Number.isInteger(residueCount) || residueCount <= 0) {
    throw new RangeError('Protein motion residueCount must be a positive integer');
  }
}

/**
 * Create a binding for one enemy body: a residue offset buffer the compute
 * pass writes into, plus the asset's flattened mode displacements (shared,
 * read-only) and a per-instance mode coefficient buffer.
 */
export function createProteinMotionBinding(
  residueCount: number,
  modeDisplacements: Float32Array = new Float32Array(0),
  modeCount = 0,
): ProteinMotionBinding {
  assertResidueCount(residueCount);
  if (modeDisplacements.length !== modeCount * residueCount * 4) {
    throw new RangeError('Protein motion mode displacements must contain one vec4 per mode per residue');
  }
  return {
    residueCount,
    modeCount,
    residueOffsets: new THREE.StorageBufferAttribute(new Float32Array(residueCount * 4), 4),
    modeDisplacements: new THREE.StorageBufferAttribute(modeDisplacements, 4),
    coefficients: new THREE.StorageBufferAttribute(new Float32Array(modeCount), 1),
  };
}

/** Write this frame's mode coefficients and mark the binding for the next compute flush. */
export function updateProteinMotionCoefficients(binding: ProteinMotionBinding, coefficients: ArrayLike<number>): void {
  if (coefficients.length !== binding.modeCount) {
    throw new RangeError('Protein motion coefficients must contain one value per mode');
  }
  const target = binding.coefficients.array as Float32Array;
  for (let index = 0; index < target.length; index += 1) target[index] = coefficients[index] ?? 0;
  binding.coefficients.needsUpdate = true;
  dirtyBindings.add(binding);
}

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

/** Dispatch a compute pass for every binding whose coefficients changed this frame. */
export function flushProteinMotionComputes(renderer: THREE.WebGPURenderer): void {
  for (const binding of dirtyBindings) {
    if (!binding.computeNode) binding.computeNode = proteinMotionComputeNode(binding);
    renderer.compute(binding.computeNode as THREE.ComputeNode, binding.residueCount);
  }
  dirtyBindings.clear();
}

/** Copy a controller's latest residue offsets into an existing shared buffer. */
export function updateProteinMotionBinding(
  binding: ProteinMotionBinding,
  offsets: ArrayLike<number>,
): void {
  if (offsets.length !== binding.residueCount * 4) {
    throw new RangeError('Protein motion offsets must contain four scalars per residue');
  }
  const target = binding.residueOffsets.array as Float32Array;
  for (let index = 0; index < target.length; index += 1) target[index] = offsets[index] ?? 0;
  binding.residueOffsets.needsUpdate = true;
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
 * Release every renderer-owned GPU buffer before dropping the CPU arrays.
 *
 * The mode displacement buffer's Float32Array is asset-owned and cached by
 * `proteinMotionModeDisplacements`, so only this binding's GPU-side storage
 * buffer is released — the shared source array is left untouched.
 */
export function disposeProteinMotionBinding(binding: ProteinMotionBinding): void {
  if (binding.disposed) return;
  binding.disposed = true;
  dirtyBindings.delete(binding);
  for (const renderer of proteinMotionRenderers.keys()) {
    const attributes = renderer._attributes;
    for (const attribute of [binding.residueOffsets, binding.modeDisplacements, binding.coefficients]) {
      if (attributes?.has(attribute)) attributes.delete(attribute);
    }
  }
  binding.residueOffsets.array = new Float32Array(0);
  binding.residueOffsets.needsUpdate = true;
  binding.modeDisplacements.array = new Float32Array(0);
  binding.modeDisplacements.needsUpdate = true;
  binding.coefficients.array = new Float32Array(0);
  binding.coefficients.needsUpdate = true;
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
export function applyProteinMotionBinding<T extends ProteinMotionNodeMaterial>(
  material: T,
  binding: ProteinMotionBinding,
): T {
  material.positionNode = THREE.TSL.positionLocal.add(residueOffsetNode(binding));
  material.userData.proteinMotionBinding = binding;
  material.userData.proteinMotionPositionNode = true;
  return material;
}

/** Return the source position node used by the explicit shadow propagation hook. */
export function proteinMotionPositionNodeForMaterial(material: THREE.Material): THREE.Node | null {
  const candidate = material as THREE.NodeMaterial;
  return candidate.positionNode?.isNode ? candidate.positionNode : null;
}

/**
 * Explicitly carry per-object motion into custom override-material passes.
 *
 * Three's renderer currently copies a source NodeMaterial positionNode while
 * processing an override material, but the protein shadow pass must also work
 * when that implementation detail changes. This hook runs before each tagged
 * object draw, selects that object's source node, and is removed by the caller
 * immediately after the pass.
 */
export function installProteinMotionOverridePropagation(
  root: THREE.Object3D,
  overrides: readonly THREE.NodeMaterial[],
): () => void {
  const overrideSet = new Set(overrides);
  const restore: Array<() => void> = [];
  root.traverse((object) => {
    if (object.userData.proteinShadowOccluder !== true && object.userData.proteinShadowReceiver !== true) return;
    const previous = object.onBeforeRender;
    object.onBeforeRender = (...args: Parameters<THREE.Object3D['onBeforeRender']>) => {
      previous.apply(object, args);
      const scene = args[1];
      const override = scene.overrideMaterial as THREE.NodeMaterial | null;
      if (!override || !overrideSet.has(override)) return;
      override.positionNode = proteinMotionPositionNodeForMaterial(args[4]);
    };
    restore.push(() => { object.onBeforeRender = previous; });
  });
  return () => {
    for (const restoreObject of restore) restoreObject();
  };
}

export function proteinStandardMaterial(
  parameters: THREE.MeshStandardNodeMaterialParameters,
  binding?: ProteinMotionBinding,
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial(parameters);
  return binding ? applyProteinMotionBinding(material, binding) : material;
}

export function proteinBasicMaterial(
  parameters: THREE.MeshBasicNodeMaterialParameters,
  binding?: ProteinMotionBinding,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial(parameters);
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
