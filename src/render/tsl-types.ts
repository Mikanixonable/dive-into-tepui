// シェーダグラフを組むモジュールが共有する TSL ノード型の語彙。three のノードは
// 値の型を型引数に持つ Node<T> で表されるので、頻出の組にだけ名前を与える。
import * as THREE from 'three/webgpu';

// シェーダグラフの中間値。
export type FloatNode = THREE.Node<'float'>;
export type Vec2Node = THREE.Node<'vec2'>;
export type Vec3Node = THREE.Node<'vec3'>;
export type Vec4Node = THREE.Node<'vec4'>;
export type BoolNode = THREE.Node<'bool'>;
export type Mat3Node = THREE.Node<'mat3'>;

// CPU 側から毎フレーム値を書き込めるノード。`value` への代入がそのまま uniform 更新になる。
export type FloatUniform = THREE.UniformNode<'float', number>;
export type Vec2Uniform = THREE.UniformNode<'vec2', THREE.Vector2>;
export type Vec3Uniform = THREE.UniformNode<'vec3', THREE.Vector3>;
export type Vec4Uniform = THREE.UniformNode<'vec4', THREE.Vector4>;
export type ColorUniform = THREE.UniformNode<'color', THREE.Color>;
export type Mat4Uniform = THREE.UniformNode<'mat4', THREE.Matrix4>;
