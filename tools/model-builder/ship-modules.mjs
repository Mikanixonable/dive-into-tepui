// ShipModuleCatalog の寸法から、メートル単位・長手軸 +Z の module model を組み立てる。
// 全モジュールは assets-src/ship-modules/*.glb からインポートされ、
// 機能アンカー（接続面、スラスター噴射口、RCS、マズル、展開ヒンジ）を付与する。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceModules } from '../compile-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const glbDir = join(__dirname, '..', '..', 'assets-src', 'ship-modules');

function loadGlbScene(filename) {
  const glbPath = join(glbDir, filename);
  if (!existsSync(glbPath)) return Promise.resolve(null);
  const buf = readFileSync(glbPath);
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve) => {
    loader.parse(
      arrayBuf,
      '',
      (gltf) => resolve(gltf.scene),
      (err) => {
        console.error(`Failed to parse ${glbPath}:`, err);
        resolve(null);
      },
    );
  });
}

const ROTATE_BLENDER_TO_THREE = new THREE.Matrix4().makeRotationX(Math.PI / 2);

async function applyGlbModel(root, filename) {
  const scene = await loadGlbScene(filename);
  if (!scene) return false;
  scene.traverse((child) => {
    if (child.isMesh && child.geometry) {
      child.geometry.applyMatrix4(ROTATE_BLENDER_TO_THREE);
      child.geometry.computeVertexNormals();
      child.geometry.computeBoundingBox();
    }
  });
  while (scene.children.length > 0) {
    const child = scene.children[0];
    root.add(child);
  }
  return true;
}

const source = loadSourceModules(['game/ship/ship-module-catalog', 'physics/player-shape']);
const { SHIP_MODULE_CATALOG } = source.shipModuleCatalog;
const {
  RADIATOR_FOLD_COUNT,
  RADIATOR_PANEL_WIDTH,
  RADIATOR_SEGMENT_LENGTH,
  SOLAR_PANEL_COUNT,
  SOLAR_PANEL_SPAN,
  SOLAR_PANEL_WIDTH,
} = source.playerShape;
source.dispose();

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

// ------------------------------------------------------------- 展開部材 (Radiator / Solar Panel)
// GLB からインポートされた各羽（panel0, panel1...）を panel-hinge:N のノード階層へバインドし、
// ヒンジローカル座標系に頂点を整列させる。
function setupDeployablePanels(root, definition) {
  const count = definition.kind === 'radiator' ? RADIATOR_FOLD_COUNT : SOLAR_PANEL_COUNT;
  const panelWidth = definition.kind === 'radiator' ? RADIATOR_SEGMENT_LENGTH : SOLAR_PANEL_WIDTH;
  const panelSpan = definition.kind === 'radiator' ? RADIATOR_PANEL_WIDTH : SOLAR_PANEL_SPAN;
  const halfLen = definition.length / 2;
  const hinge = anchor(root, 'panel-hinge', 0, 0, halfLen);

  for (let index = 0; index < count; index++) {
    const panelHinge = anchor(hinge, `panel-hinge:${index}`, 0, 0, index * panelWidth);
    panelHinge.userData = {
      ...panelHinge.userData,
      panelIndex: index,
      panelKind: definition.kind,
      panelWidth,
      panelSpan,
    };

    const targetNames = new Set([`panel${index}`, `panel:${index}`]);
    const toMove = [];
    for (const child of [...root.children]) {
      if (child.isMesh && (
        targetNames.has(child.name) ||
        child.name.startsWith(`panel_ribs${index}`) ||
        child.name.startsWith(`panel_ribs:${index}`) ||
        child.name.startsWith(`panel_hinge_hardware${index}`) ||
        child.name.startsWith(`panel_hinge_hardware:${index}`) ||
        child.name.startsWith(`radiator_pipe${index}`) ||
        child.name.startsWith(`radiator_pipe:${index}`) ||
        child.name.startsWith(`radiator_hinge_hardware${index}`) ||
        child.name.startsWith(`radiator_hinge_hardware:${index}`)
      )) {
        toMove.push(child);
      }
    }

    const zOffset = -(halfLen + index * panelWidth);
    for (const mesh of toMove) {
      root.remove(mesh);
      mesh.geometry.translate(0, 0, zOffset);
      mesh.geometry.computeBoundingBox();
      if (targetNames.has(mesh.name)) {
        const newName = index === 0 ? 'deployable-panel' : `deployable-panel:${index}`;
        mesh.name = newName;
        mesh.userData.name = newName;
      } else {
        mesh.userData.name = mesh.name;
      }
      panelHinge.add(mesh);
    }
  }
}

async function addKindDetails(root, definition) {
  const modelId = definition.modelId;
  const glbName = `${modelId}.glb`;

  if (!(await applyGlbModel(root, glbName))) {
    throw new Error(`Missing GLB model for ${definition.modelId}: ${glbName}`);
  }

  switch (definition.kind) {
    case 'cockpit':
    case 'tank':
    case 'armor':
      return;
    case 'thruster':
    case 'booster':
      anchor(root, 'thrust', 0, 0, -definition.length / 2, new THREE.Vector3(0, 0, -1));
      return;
    case 'rcs':
      anchor(root, 'rcs:1,0', 1, 0, 0, new THREE.Vector3(1, 0, 0));
      anchor(root, 'rcs:-1,0', -1, 0, 0, new THREE.Vector3(-1, 0, 0));
      anchor(root, 'rcs:0,1', 0, 1, 0, new THREE.Vector3(0, 1, 0));
      anchor(root, 'rcs:0,-1', 0, -1, 0, new THREE.Vector3(0, -1, 0));
      anchor(root, 'rcs:roll:+', 0, 1, 0, new THREE.Vector3(1, 0, 0));
      anchor(root, 'rcs:roll:-', 0, -1, 0, new THREE.Vector3(-1, 0, 0));
      return;
    case 'weapon':
      anchor(root, 'muzzle:left', -1.5, 0, definition.length / 2 + 0.25, new THREE.Vector3(0, 0, 1));
      anchor(root, 'muzzle:right', 1.5, 0, definition.length / 2 + 0.25, new THREE.Vector3(0, 0, 1));
      anchor(root, 'belt', 0, 0, 0);
      return;
    case 'radiator':
    case 'solar_panel':
      setupDeployablePanels(root, definition);
      return;
    case 'docking_port':
    case 'dock':
    case 'decoupler': {
      const semantic = definition.kind === 'dock' ? 'construction-dock'
        : definition.kind === 'docking_port' ? 'docking-port' : 'decoupler';
      anchor(root, semantic, 0, 0, definition.length / 2, new THREE.Vector3(0, 0, 1));
      return;
    }
  }
}

async function buildModule(definition) {
  const root = new THREE.Group();
  root.name = `module:${definition.modelId}`;
  root.userData = { moduleModelId: definition.modelId, moduleKind: definition.kind };
  connectionAnchors(root, definition);
  await addKindDetails(root, definition);
  return root;
}

export async function buildShipModules() {
  const root = new THREE.Group();
  root.name = 'ship-modules';
  const modelIds = new Set();
  for (const definition of SHIP_MODULE_CATALOG.all()) {
    if (modelIds.has(definition.modelId)) continue;
    modelIds.add(definition.modelId);
    root.add(await buildModule(definition));
  }
  return root;
}
