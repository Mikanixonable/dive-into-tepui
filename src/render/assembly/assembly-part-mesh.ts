// 組み立て型の敵の部品1個ぶんのメッシュ。敵の本体と、そこから飛び出した部品が同じ見た目を共有する。
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../math/random';
import { assemblyPartGeometry } from './assembly-geometry';
import type { AssemblyPartDef } from './assembly-shape';

// 構造部の中性色。識別色(accent)を持つ部品と区別が付く、白〜煙色の薄いトーンだけを置く。
const STRUCTURE_COLORS = [0xf1edf0, 0xd9d9d3, 0xc6cbd6, 0xa8aec0, 0x8d95a8] as const;
// 誘電体プラスチックの粗さの範囲。部品ごとにこの中でばらつかせる。
const ROUGHNESS_MIN = 0.15;
const ROUGHNESS_MAX = 0.3;

// 個体 seed の部品 part のメッシュ。構造部は個体の seed と部品番号で決まる中性色、発射部・中核は
// 識別色 accent で描く。ジオメトリとマテリアルは表示ツリーから外れたときに破棄してよい。
// 色と粗さは seed と部品番号から決まる同じ乱数列から、この順に引く。引く順を変えると同じ個体の見た目が変わる。
export function assemblyPartMesh(
  seed: number, part: AssemblyPartDef, accent: string | number,
): THREE.Mesh {
  const rand = mulberry32((seed ^ Math.imul(part.index + 1, 0x9e3779b9)) >>> 0);
  const color = part.role === 'structure'
    ? STRUCTURE_COLORS[Math.floor(rand() * STRUCTURE_COLORS.length)]!
    : accent;
  const material = new THREE.MeshStandardNodeMaterial({
    color,
    roughness: ROUGHNESS_MIN + rand() * (ROUGHNESS_MAX - ROUGHNESS_MIN),
    metalness: 0,
  });
  const mesh = new THREE.Mesh(assemblyPartGeometry(part), material);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}
