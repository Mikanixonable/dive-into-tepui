// ShipModuleCatalog の寸法から、メートル単位・長手軸 +Z の module model を組み立てる。
// module と semantic anchor は Group/Object3D に置き、exporter の mesh 統合で境界が消えないようにする。
import * as THREE from 'three';
import { loadSourceModules } from '../compile-source.mjs';
import { F0_BURNT_STEEL, F0_STEEL, std } from './materials.mjs';

const source = loadSourceModules(['game/ship/ship-module-catalog']);
const { SHIP_MODULE_CATALOG } = source.shipModuleCatalog;
source.dispose();

const materials = {
  hull: std(0xb9c4d0, { metalness: 0.72, roughness: 0.48 }),
  dark: std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.5 }),
  rim: std(F0_STEEL, { metalness: 1, roughness: 0.3 }),
  window: std(0x0b2135, { metalness: 0.05, roughness: 0.18 }),
  tankMain: std(0xc7d1da, { metalness: 0.68, roughness: 0.42 }),
  tankRcs: std(0x5d93a8, { metalness: 0.58, roughness: 0.46 }),
  armor: std(0x6f7a88, { metalness: 0.9, roughness: 0.38 }),
  radiator: std(0xd9e0e7, { metalness: 0.38, roughness: 0.78 }),
  solar: std(0x163f91, { metalness: 0.18, roughness: 0.44 }),
  dock: std(0xd58b37, { metalness: 0.82, roughness: 0.4 }),
};

function axialMesh(geometry, material, z = 0, name = '') {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = z;
  mesh.name = name;
  return mesh;
}

// TorusGeometry の法線は +Z なので、円柱と同じ軸回転を加えずに配置する。
function ringMesh(geometry, material, z = 0, name = '') {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = z;
  mesh.name = name;
  return mesh;
}

function anchor(parent, name, x, y, z, direction = null) {
  const node = new THREE.Object3D();
  node.name = `anchor:${name}`;
  node.userData = { semanticAnchor: name };
  node.position.set(x, y, z);
  if (direction !== null) {
    node.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.clone().normalize());
  }
  parent.add(node);
  return node;
}

function connectionAnchors(root, definition) {
  anchor(root, 'connection:aft', 0, 0, -definition.length / 2, new THREE.Vector3(0, 0, -1));
  anchor(root, 'connection:forward', 0, 0, definition.length / 2, new THREE.Vector3(0, 0, 1));
  if (definition.kind !== 'cockpit' && definition.kind !== 'tank') return;
  for (const [name, direction] of [
    ['side:+x', new THREE.Vector3(1, 0, 0)],
    ['side:-x', new THREE.Vector3(-1, 0, 0)],
    ['side:+y', new THREE.Vector3(0, 1, 0)],
    ['side:-y', new THREE.Vector3(0, -1, 0)],
  ]) anchor(root, `connection:${name}`, direction.x * 3, direction.y * 3, 0, direction);
}

function cylinderBody(root, definition, material, radius = definition.diameter / 2) {
  root.add(axialMesh(
    new THREE.CylinderGeometry(radius, radius, definition.length, 24, Math.max(1, Math.ceil(definition.length / 3))),
    material, 0, 'body',
  ));
  for (const z of [-definition.length / 2 + 0.08, definition.length / 2 - 0.08]) {
    root.add(ringMesh(new THREE.TorusGeometry(radius * 0.94, 0.08, 8, 24), materials.rim, z, 'end-ring'));
  }
}

function addKindDetails(root, definition) {
  const radius = definition.diameter / 2;
  switch (definition.kind) {
    case 'cockpit': {
      cylinderBody(root, definition, materials.hull);
      const window = axialMesh(new THREE.CylinderGeometry(radius * 0.48, radius * 0.48, 0.05, 16), materials.window,
        definition.length / 2 + 0.026, 'cockpit-window');
      root.add(window);
      break;
    }
    case 'tank':
      cylinderBody(root, definition,
        definition.abilities.fuelKind === 'rcs' ? materials.tankRcs : materials.tankMain);
      for (let z = -definition.length / 2 + 1.5; z < definition.length / 2; z += 3) {
        root.add(ringMesh(new THREE.TorusGeometry(radius * 1.01, 0.07, 8, 24), materials.rim, z, 'tank-band'));
      }
      break;
    case 'thruster':
    case 'booster': {
      cylinderBody(root, definition, definition.kind === 'booster' ? materials.tankMain : materials.dark);
      const bell = axialMesh(new THREE.ConeGeometry(radius * 0.72, Math.min(1.4, definition.length), 24, 1, true),
        materials.dark, -definition.length / 2 - Math.min(0.7, definition.length / 2), 'thrust-bell');
      root.add(bell);
      anchor(root, 'thrust', 0, 0, -definition.length / 2 - Math.min(1.4, definition.length),
        new THREE.Vector3(0, 0, -1));
      break;
    }
    case 'rcs':
      cylinderBody(root, definition, materials.dark);
      for (const direction of [
        new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
      ]) anchor(
        root, `rcs:${direction.x},${direction.y}`,
        direction.x * radius, direction.y * radius, definition.length * 0.35, direction,
      );
      anchor(root, 'rcs:roll:+', radius, 0, 0, new THREE.Vector3(0, -1, 0));
      anchor(root, 'rcs:roll:-', radius, 0, 0, new THREE.Vector3(0, 1, 0));
      break;
    case 'weapon':
      cylinderBody(root, definition, materials.dark);
      for (const x of [-0.7, 0.7]) {
        const barrel = axialMesh(new THREE.CylinderGeometry(0.18, 0.23, 1.2, 12), materials.dark,
          definition.length / 2 + 0.55, 'barrel');
        barrel.position.x = x;
        root.add(barrel);
        anchor(root, `muzzle:${x > 0 ? 'right' : 'left'}`, x, 0, definition.length / 2 + 1.15);
      }
      anchor(root, 'belt', 0, -radius * 0.65, 0, new THREE.Vector3(1, 0, 0));
      break;
    case 'armor':
      cylinderBody(root, definition, materials.armor, radius * 1.04);
      break;
    case 'radiator':
    case 'solar_panel': {
      cylinderBody(root, definition, materials.rim, radius * 0.22);
      const panelMaterial = definition.kind === 'radiator' ? materials.radiator : materials.solar;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.08, Math.max(0.8, definition.length)), panelMaterial);
      panel.name = 'deployable-panel';
      const hinge = anchor(root, 'panel-hinge', -2.3, 0, 0);
      panel.position.x = 2.3;
      hinge.add(panel);
      break;
    }
    case 'docking_port':
    case 'dock':
    case 'decoupler': {
      const color = definition.kind === 'dock' ? materials.dock : materials.rim;
      root.add(axialMesh(new THREE.CylinderGeometry(radius, radius, definition.length, 24, 1), color, 0, 'ring'));
      root.add(ringMesh(new THREE.TorusGeometry(radius * 0.78, radius * 0.12, 8, 24), materials.dark,
        definition.length / 2 + 0.02, 'interface-ring'));
      const semantic = definition.kind === 'dock' ? 'construction-dock'
        : definition.kind === 'docking_port' ? 'docking-port' : 'decoupler';
      anchor(root, semantic, 0, 0, definition.length / 2, new THREE.Vector3(0, 0, 1));
      break;
    }
  }
}

function buildModule(definition) {
  const root = new THREE.Group();
  root.name = `module:${definition.modelId}`;
  root.userData = { moduleModelId: definition.modelId, moduleKind: definition.kind };
  connectionAnchors(root, definition);
  addKindDetails(root, definition);
  return root;
}

export function buildShipModules() {
  const root = new THREE.Group();
  root.name = 'ship-modules';
  const modelIds = new Set();
  for (const definition of SHIP_MODULE_CATALOG.all()) {
    if (modelIds.has(definition.modelId)) continue;
    modelIds.add(definition.modelId);
    root.add(buildModule(definition));
  }
  return root;
}
