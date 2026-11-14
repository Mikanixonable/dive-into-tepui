// 結節体(SPEC/KNOT.md)1体ぶんの表示。形状生成が返した索の管メッシュ(被覆と素線)
// と、結節ノード・駆動中核・編み込まれたデブリ片の塊を持つ。部位の喪失に伴う
// 表示の変化は戦闘スライスで足す — ここでは生成した形をそのまま立てる。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../../pipeline/lit-layer';
import { makeThermallyEmissive } from '../../thermal-emissive';
import { DynamicView } from '../dynamic-view';
import type { KnotMeshData, KnotNodeRole, KnotShape } from '../../../game/knot/knot-shape';

// 結節ノードの役割ごとの色。射撃役は個体の識別色で示し、他の役は機械の塊として
// 落ち着いた色に分ける。
const NODE_COLORS: Record<Exclude<KnotNodeRole, 'shooter'>, number> = {
  sensor: 0xbfd0d8,
  drive: 0x596069,
};
// 駆動中核の色。索の奥に沈む、鈍い赤の金属。
const CORE_COLOR = 0x74342a;
// デブリ片の色。索に編み込まれた残骸の板。
const DEBRIS_COLOR = 0x4c4a44;

// 生成済みの頂点列を BufferGeometry へ写す。
function meshGeometry(data: KnotMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return geometry;
}

export class KnotEnemyView extends DynamicView {
  // 形状 shape の個体を、識別色 accent で組み立てる。
  public constructor(shape: KnotShape, accent: string | number, scene?: THREE.Scene) {
    const root = new THREE.Group();
    super(root, scene);
    const addMesh = (mesh: THREE.Mesh): void => {
      mesh.userData.ownsGeometry = true;
      mesh.userData.ownsMaterial = true;
      root.add(mesh);
    };
    // 索は被覆と素線で材質を分ける。色は生成側が頂点カラーへ焼いてある。
    const sheath = new THREE.Mesh(meshGeometry(shape.sheath), new THREE.MeshStandardNodeMaterial({
      vertexColors: true, roughness: 0.82, metalness: 0.2,
    }));
    addMesh(sheath);
    const bare = new THREE.Mesh(meshGeometry(shape.bare), new THREE.MeshStandardNodeMaterial({
      vertexColors: true, roughness: 0.42, metalness: 0.85,
    }));
    addMesh(bare);
    // 結節ノードは役割を持つ機械の塊として、角のある塊で立てる。
    for (const node of shape.nodes) {
      const color = node.role === 'shooter' ? accent : NODE_COLORS[node.role];
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(node.radius, 1),
        new THREE.MeshStandardNodeMaterial({ color, roughness: 0.5, metalness: 0.6, flatShading: true }),
      );
      mesh.position.set(node.position[0], node.position[1], node.position[2]);
      addMesh(mesh);
    }
    // 駆動中核。索に囲まれた中心の塊。
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(shape.core.radius, 2),
      new THREE.MeshStandardNodeMaterial({ color: CORE_COLOR, roughness: 0.45, metalness: 0.7, flatShading: true }),
    );
    core.position.set(shape.core.position[0], shape.core.position[1], shape.core.position[2]);
    addMesh(core);
    // 編み込まれたデブリ片。
    for (const piece of shape.debris) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(piece.size[0], piece.size[1], piece.size[2]),
        new THREE.MeshStandardNodeMaterial({ color: DEBRIS_COLOR, roughness: 0.7, metalness: 0.5 }),
      );
      mesh.position.set(piece.position[0], piece.position[1], piece.position[2]);
      mesh.rotation.set(piece.rotation[0], piece.rotation[1], piece.rotation[2]);
      addMesh(mesh);
    }
    makeThermallyEmissive(root);
    markLitOpaque(root);
    markShadowCaster(root);
  }
}
