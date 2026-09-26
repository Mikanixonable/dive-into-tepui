import { qInvert, qRotate } from '../../math/quat';
import { v3 } from '../../math/vec3';
import type { ShipModuleCatalog } from './ship-module-catalog';
import {
  finiteQuaternion, finiteVector, isIdentityRotation, isSideChild, isSideParent, sameTransform,
  sideMountTransform,
} from './ship-assembly-transform';
import {
  isDockingModule, type ShipAssemblyNode, type ShipAssemblyValidation, type ShipConnection,
} from './ship-assembly-types';

export function validateShipAssembly(
  nodes: ReadonlyMap<string, ShipAssemblyNode>, connections: readonly ShipConnection[], catalog: ShipModuleCatalog,
): ShipAssemblyValidation {
  const errors: string[] = [];
  const childIds = new Set<string>();
  const parentIds = new Set<string>();
  for (const [id, node] of nodes) {
    const definition = catalog.get(node.instance.definitionId);
    if (definition === null) errors.push(`unknown definition: ${node.instance.definitionId}`);
    else if (definition.kind !== node.instance.kind) errors.push(`kind mismatch: ${id}`);
    if (!finiteVector(node.transform.position) || !finiteQuaternion(node.transform.rotation)) {
      errors.push(`non-finite transform: ${id}`);
    }
  }
  for (const connection of connections) {
    if (!nodes.has(connection.parentId)) errors.push(`missing parent: ${connection.parentId}`);
    if (!nodes.has(connection.childId)) errors.push(`missing child: ${connection.childId}`);
    if (childIds.has(connection.childId)) errors.push(`multiple parents: ${connection.childId}`);
    childIds.add(connection.childId);
    if (parentIds.has(connection.id)) errors.push(`duplicate connection: ${connection.id}`);
    parentIds.add(connection.id);
    if (!finiteVector(connection.childTransform.position) || !finiteQuaternion(connection.childTransform.rotation)) {
      errors.push(`non-finite connection transform: ${connection.id}`);
    }
    const parent = nodes.get(connection.parentId);
    const child = nodes.get(connection.childId);
    if (connection.kind === 'docking') {
      if (!isDockingModule(parent?.instance ?? null) || !isDockingModule(child?.instance ?? null)) {
        errors.push(`invalid docking endpoints: ${connection.id}`);
      }
    } else if (connection.kind === 'construction') {
      if (parent?.instance.kind !== 'dock') errors.push(`invalid construction parent: ${connection.id}`);
    } else if (connection.kind === 'axial' && parent !== undefined && child !== undefined) {
      const parentDef = catalog.get(parent.instance.definitionId);
      const childDef = catalog.get(child.instance.definitionId);
      const expected = (parentDef?.length ?? 0) / 2 + (childDef?.length ?? 0) / 2;
      const p = connection.childTransform.position;
      const rot = connection.childTransform.rotation;
      const isDockParent = parentDef?.kind === 'dock' || parentDef?.kind === 'docking_port';
      const isDockTurn = isDockParent
        && Math.abs(rot.x) < 1e-9 && Math.abs(Math.abs(rot.y) - 1) < 1e-9
        && Math.abs(rot.z) < 1e-9 && Math.abs(rot.w) < 1e-9;
      const validRotation = isIdentityRotation(rot) || isDockTurn;
      if (Math.abs(p.x) > 1e-9 || Math.abs(p.y) > 1e-9 || Math.abs(Math.abs(p.z) - expected) > 1e-9
        || !validRotation) errors.push(`invalid axial snap: ${connection.id}`);
    }
    if (connection.kind === 'side' && parent !== undefined && child !== undefined) {
      const slotOwnerId = connection.sideReversed ? connection.childId : connection.parentId;
      if (connection.sideReversed) {
        if (!isSideChild(parent.instance.kind)) errors.push(`invalid side parent: ${connection.id}`);
        if (!isSideParent(child.instance.kind)) errors.push(`invalid side child: ${connection.id}`);
      } else {
        if (!isSideParent(parent.instance.kind)) errors.push(`invalid side parent: ${connection.id}`);
        if (!isSideChild(child.instance.kind)) errors.push(`invalid side child: ${connection.id}`);
      }
      if (connection.sideSlot === undefined) errors.push(`missing side slot: ${connection.id}`);
      else {
        const expected = connection.sideReversed
          ? (() => {
            const forward = sideMountTransform(
              catalog.require(child.instance.definitionId),
              catalog.require(parent.instance.definitionId),
              connection.sideSlot,
            );
            const invRot = qInvert(forward.rotation);
            return {
              position: qRotate(invRot, v3(-forward.position.x, -forward.position.y, -forward.position.z)),
              rotation: invRot,
            };
          })()
          : sideMountTransform(
            catalog.require(parent.instance.definitionId),
            catalog.require(child.instance.definitionId),
            connection.sideSlot,
          );
        if (!sameTransform(connection.childTransform, expected)) errors.push(`invalid side mount: ${connection.id}`);
        const duplicate = connections.some(other => other !== connection
          && other.kind === 'side'
          && (other.sideReversed ? other.childId : other.parentId) === slotOwnerId
          && other.sideSlot === connection.sideSlot);
        if (duplicate) errors.push(`duplicate side slot: ${connection.id}`);
      }
    }
  }
  const occupied = new Set<string>();
  for (const connection of connections.filter(edge => edge.kind === 'docking')) {
    for (const moduleId of [connection.parentId, connection.childId]) {
      if (occupied.has(moduleId)) errors.push(`docking module has multiple connections: ${moduleId}`);
      occupied.add(moduleId);
    }
  }
  const roots = [...nodes.keys()].filter(id => !childIds.has(id));
  if (nodes.size > 0 && roots.length !== 1) errors.push(`assembly must have one root, got ${roots.length}`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { errors.push(`connection cycle at: ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of connections) if (edge.parentId === id && nodes.has(edge.childId)) visit(edge.childId);
    visiting.delete(id); visited.add(id);
  };
  for (const root of roots) visit(root);
  if (visited.size !== nodes.size) errors.push('assembly graph is disconnected');
  return { valid: errors.length === 0, errors: Object.freeze(errors) };
}
