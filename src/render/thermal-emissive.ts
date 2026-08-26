// 物体の温度を自照へ変える配線。マテリアルは個体ごとに複製せず、温度・局所的な過熱・輻射率を
// 個体ごとの値として受け取る — Mesh 1 個ずつなら userData から、インスタンス描画なら
// 頂点属性から。物体のどこが熱くなりやすいかは、ジオメトリに焼いた形が持つ。
import * as THREE from 'three/webgpu';
import { attribute, reference } from 'three/tsl';
import { blackbodyEmissiveNode } from './blackbody';
import { isStandardMaterial } from './pipeline/lit-layer';
import { toStandardNodeMaterial } from './standard-node-material';
import type { FloatNode, Vec3Node } from './tsl-types';

// インスタンス 1 個ぶんの熱の状態を運ぶ属性(温度 [K]、局所的な過熱の振幅 [K]、輻射率)。
export const INSTANCE_THERMAL_ATTRIBUTE = 'instanceThermal';
// 平均温度からの温度差の分布(0..1)。頂点ごとに持ち、面の上では補間される。
export const THERMAL_SHAPE_ATTRIBUTE = 'thermalShape';

// 熱の状態をどこから読むか。Mesh 1 個ずつに別の温度を与えるなら 'object'、
// 1 本の InstancedMesh へ積んだ個体ごとに与えるなら 'instance'。
export type ThermalSource = 'object' | 'instance';

// 熱の状態を持つ Mesh の userData。syncThermalState が書き、描画のたびに読まれる。
interface ThermalUserData {
  thermalTemperature: number;
  thermalDeviation: number;
  thermalEmissivity: number;
}

function objectValue(property: keyof ThermalUserData): FloatNode {
  return reference(`userData.${property}`, 'float', null) as unknown as FloatNode;
}

// source に応じた、その画素の温度 [K] と輻射率。shaped ならジオメトリに焼いた形を
// 局所的な過熱の振幅へ掛けて足す。
function thermalState(source: ThermalSource, shaped: boolean): { temperature: FloatNode; emissivity: FloatNode } {
  let average: FloatNode;
  let deviation: FloatNode;
  let emissivity: FloatNode;
  if (source === 'object') {
    average = objectValue('thermalTemperature');
    deviation = objectValue('thermalDeviation');
    emissivity = objectValue('thermalEmissivity');
  } else {
    const packed = attribute(INSTANCE_THERMAL_ATTRIBUTE, 'vec3') as THREE.Node<'vec3'>;
    average = packed.x as FloatNode;
    deviation = packed.y as FloatNode;
    emissivity = packed.z as FloatNode;
  }
  if (!shaped) return { temperature: average, emissivity };
  const shape = attribute(THERMAL_SHAPE_ATTRIBUTE, 'float') as FloatNode;
  return { temperature: average.add(deviation.mul(shape)) as FloatNode, emissivity };
}

// 読み方の組み合わせごとに 1 つだけ組むシェーダグラフ。同じグラフを使い回すと、マテリアルが
// 何枚あってもシェーダは 1 本で済む。
const emissiveNodes = new Map<string, Vec3Node>();

function emissiveNode(source: ThermalSource, shaped: boolean): Vec3Node {
  const key = `${source}:${shaped}`;
  const cached = emissiveNodes.get(key);
  if (cached !== undefined) return cached;
  const { temperature, emissivity } = thermalState(source, shaped);
  const node = blackbodyEmissiveNode(temperature, emissivity);
  emissiveNodes.set(key, node);
  return node;
}

// マテリアルの自照を温度から引くようにする。shaped は、そのマテリアルを貼るジオメトリが
// THERMAL_SHAPE_ATTRIBUTE を持つかどうか(持たないジオメトリで立てると描画が組めない)。
export function attachThermalEmissive<T extends THREE.MeshStandardNodeMaterial>(
  material: T, source: ThermalSource, shaped = false,
): T {
  material.emissiveNode = emissiveNode(source, shaped);
  return material;
}

// root 配下の標準マテリアルを、Mesh ごとの温度で自照する Node 版へ持ち替える。
// 熱の状態は 0 で初期化するので、最初の syncThermalState までは光らない。
export function makeThermallyEmissive<T extends THREE.Object3D>(root: T): T {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const shaped = mesh.geometry.getAttribute(THERMAL_SHAPE_ATTRIBUTE) !== undefined;
    const upgrade = (material: THREE.Material): THREE.Material =>
      isStandardMaterial(material) ? attachThermalEmissive(toStandardNodeMaterial(material), 'object', shaped) : material;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(upgrade) : upgrade(mesh.material);
  });
  initThermalState(root);
  return root;
}

// root と、その配下すべてへいまの熱の状態を配る。温度と過熱の振幅は [K]。
export function syncThermalState(
  root: THREE.Object3D, temperature: number, deviation: number, emissivity: number,
): void {
  root.traverse((obj) => {
    const data = obj.userData as ThermalUserData;
    data.thermalTemperature = temperature;
    data.thermalDeviation = deviation;
    data.thermalEmissivity = emissivity;
  });
}

// object が運んでいる熱の状態を out の offset から 3 つぶん書き、値が動いたなら true を返す。
// 熱の状態を受け取っていない object は 0 として書かれる。
export function writeThermalState(
  object: THREE.Object3D, out: Float32Array, offset: number,
): boolean {
  const data = object.userData as Partial<ThermalUserData>;
  const values = [data.thermalTemperature ?? 0, data.thermalDeviation ?? 0, data.thermalEmissivity ?? 0];
  let changed = false;
  for (let i = 0; i < values.length; i++) {
    if (out[offset + i] === values[i]) continue;
    out[offset + i] = values[i]!;
    changed = true;
  }
  return changed;
}

// 熱の状態をまだ受け取っていない Mesh を、光らない状態へ据える。
export function initThermalState(root: THREE.Object3D): void {
  syncThermalState(root, 0, 0, 0);
}
