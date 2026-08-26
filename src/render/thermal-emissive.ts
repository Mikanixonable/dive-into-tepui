// 物体の温度を自照へ変える配線。マテリアルは個体ごとに複製せず、温度・局所的な過熱・輻射率を
// 個体ごとの値として受け取る — Mesh 1 個ずつなら userData から、インスタンス描画なら
// 頂点属性から。物体のどこが熱くなりやすいかは、ジオメトリに焼いた形が持つ。
import * as THREE from 'three/webgpu';
import { attribute, reference } from 'three/tsl';
import { blackbodyEmissiveNode } from './blackbody';
import type { FloatNode } from './tsl-types';

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

// マテリアルの自照を温度から引くようにする。shaped は、そのマテリアルを貼るジオメトリが
// THERMAL_SHAPE_ATTRIBUTE を持つかどうか(持たないジオメトリで立てると描画が組めない)。
export function attachThermalEmissive<T extends THREE.MeshStandardNodeMaterial>(
  material: T, source: ThermalSource, shaped = false,
): T {
  const { temperature, emissivity } = thermalState(source, shaped);
  material.emissiveNode = blackbodyEmissiveNode(temperature, emissivity);
  return material;
}

// root 配下の Mesh へ、いまの熱の状態を配る。温度と過熱の振幅は [K]。
export function syncThermalState(
  root: THREE.Object3D, temperature: number, deviation: number, emissivity: number,
): void {
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const data = obj.userData as ThermalUserData;
    data.thermalTemperature = temperature;
    data.thermalDeviation = deviation;
    data.thermalEmissivity = emissivity;
  });
}

// 組み立て時に呼び、熱の状態を持たない Mesh が描かれることを防ぐ。値は環境温度でも 0 でもよく、
// 最初の syncThermalState までの絵にしか効かない。
export function initThermalState(root: THREE.Object3D, emissivity: number): void {
  syncThermalState(root, 0, 0, emissivity);
}
