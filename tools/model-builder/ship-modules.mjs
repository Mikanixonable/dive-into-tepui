// ShipModuleCatalog の各 modelId について、assets-src/ship-modules/<modelId>.glb(Blender 製の原型)を
// メートル単位・長手軸 +Z の module model へ取り込み、定義だけから決まる接続面 anchor を足す。
// 形に結び付いた機能 anchor(噴射口・ジンバル・RCS・回転砲身・展開ヒンジ)は原型が持ち、ここでは揃っているかを検査する。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceModules } from '../compile-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const glbDir = join(__dirname, '..', '..', 'assets-src', 'ship-modules');

// modelId の原型 GLB の scene を返す。読めなければ投げる。
function loadGlbScene(modelId) {
  const buf = readFileSync(join(glbDir, `${modelId}.glb`));
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuf, '', gltf => resolve(gltf.scene), reject);
  });
}

const source = loadSourceModules(['game/ship/ship-module-catalog', 'physics/player-shape']);
const { SHIP_MODULE_CATALOG } = source.shipModuleCatalog;
const { RADIATOR_FOLD_COUNT, SOLAR_PANEL_COUNT } = source.playerShape;
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

// 定義の長さと種別だけから決まる接続面・結合機構の anchor を足す。
function definitionAnchors(root, definition) {
  anchor(root, 'connection:aft', 0, 0, -definition.length / 2, new THREE.Vector3(0, 0, -1));
  anchor(root, 'connection:forward', 0, 0, definition.length / 2, new THREE.Vector3(0, 0, 1));
  if (definition.kind === 'cockpit' || definition.kind === 'tank') {
    for (const [name, direction] of [
      ['side:+x', new THREE.Vector3(1, 0, 0)],
      ['side:-x', new THREE.Vector3(-1, 0, 0)],
      ['side:+y', new THREE.Vector3(0, 1, 0)],
      ['side:-y', new THREE.Vector3(0, -1, 0)],
    ]) anchor(root, `connection:${name}`, direction.x * 3, direction.y * 3, 0, direction);
  }
  const coupling = { dock: 'construction-dock', docking_port: 'docking-port', decoupler: 'decoupler' }[definition.kind];
  if (coupling !== undefined) anchor(root, coupling, 0, 0, definition.length / 2, new THREE.Vector3(0, 0, 1));
}

// 種別ごとに原型が持つべき機能 anchor の数。semantic anchor 名(末尾が ':' なら接頭辞)で数える。
const REQUIRED_ANCHORS = {
  thruster: { thrust: 1, 'engine-gimbal': 1 },
  booster: { thrust: 1 },
  rcs: { 'rcs:': 16 },
  radiator: { 'panel-hinge': 1, 'panel-hinge:': RADIATOR_FOLD_COUNT },
  solar_panel: { 'panel-hinge': 1, 'panel-hinge:': SOLAR_PANEL_COUNT },
};

// definition の原型が持つべき機能 anchor の数。種別の表に、機関砲なら砲口ごとの回転砲身を足す。
function requiredAnchors(definition) {
  const required = { ...(REQUIRED_ANCHORS[definition.kind] ?? {}) };
  if (definition.kind === 'weapon') required['barrel-rotor:'] = definition.muzzles.length;
  return required;
}

// 原型の機能 anchor が definition の要求を満たすか確かめる。過不足があれば投げる。
function validateAnchors(root, definition) {
  const names = [];
  root.traverse((child) => {
    if (typeof child.userData.semanticAnchor === 'string') names.push(child.userData.semanticAnchor);
  });
  for (const [prefix, count] of Object.entries(requiredAnchors(definition))) {
    const found = prefix.endsWith(':') ? names.filter(name => name.startsWith(prefix)).length
      : names.filter(name => name === prefix).length;
    if (found !== count) {
      throw new Error(`${definition.modelId}: expected ${count} anchor(s) "${prefix}", found ${found}`);
    }
  }
}

async function buildModule(definition) {
  const root = new THREE.Group();
  root.name = `module:${definition.modelId}`;
  root.userData = { moduleModelId: definition.modelId, moduleKind: definition.kind };
  const scene = await loadGlbScene(definition.modelId);
  while (scene.children.length > 0) root.add(scene.children[0]);
  validateAnchors(root, definition);
  definitionAnchors(root, definition);
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
