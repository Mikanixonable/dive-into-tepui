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
 * GPU buffer. No runtime/controller import is required here.
 */
export interface ProteinMotionBinding {
  readonly residueCount: number;
  readonly residueOffsets: THREE.StorageBufferAttribute;
  disposed?: boolean;
}

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

/** Create a binding from a controller-compatible xyz+w residue buffer. */
export function createProteinMotionBinding(
  residueCount: number,
  offsets: ArrayLike<number> = new Float32Array(residueCount * 4),
): ProteinMotionBinding {
  assertResidueCount(residueCount);
  if (offsets.length !== residueCount * 4) {
    throw new RangeError('Protein motion offsets must contain four scalars per residue');
  }
  const array = offsets instanceof Float32Array ? offsets : Float32Array.from(offsets);
  return {
    residueCount,
    residueOffsets: new THREE.StorageBufferAttribute(array, 4),
  };
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

/** Release every renderer-owned GPU buffer before dropping the CPU array. */
export function disposeProteinMotionBinding(binding: ProteinMotionBinding): void {
  if (binding.disposed) return;
  binding.disposed = true;
  for (const renderer of proteinMotionRenderers.keys()) {
    const attributes = renderer._attributes;
    if (attributes?.has(binding.residueOffsets)) attributes.delete(binding.residueOffsets);
  }
  binding.residueOffsets.array = new Float32Array(0);
  binding.residueOffsets.needsUpdate = true;
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
