import * as THREE from 'three/webgpu';

// このテスト層で値として評価する、TSLの定数・スカラー・ベクトルの狭い集合。
export type ShaderValue = number | boolean | number[];

type ShaderNode = {
  readonly type?: string;
  readonly value?: unknown;
  readonly node?: ShaderNode;
  readonly nodes?: readonly ShaderNode[];
  readonly components?: string;
  readonly method?: string;
  readonly op?: string;
  readonly aNode?: ShaderNode | null;
  readonly bNode?: ShaderNode | null;
  readonly cNode?: ShaderNode | null;
  readonly condNode?: ShaderNode;
  readonly ifNode?: ShaderNode;
  readonly elseNode?: ShaderNode | null;
};

type ShaderVector = number[];

// スカラーとベクトルの算術演算を、GPUのスカラー拡張規則に合わせて適用する。
function componentwise(left: ShaderValue, right: ShaderValue, operation: (a: number, b: number) => number): ShaderValue {
  if (Array.isArray(left)) return left.map((value, index) => componentwise(value, Array.isArray(right) ? right[index]! : right, operation)) as ShaderVector;
  if (Array.isArray(right)) return right.map((value) => componentwise(left, value, operation)) as ShaderVector;
  return operation(left as number, right as number);
}

// 実GPUを起動せず、地表座標で使うTSLノードだけを数学的に評価する。
export function evaluateShaderNode(input: unknown): ShaderValue {
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  const node = input as ShaderNode & { readonly isVector2?: boolean; readonly isVector3?: boolean };
  if (node.isVector2) {
    const value = input as THREE.Vector2;
    return [value.x, value.y];
  }
  if (node.isVector3) {
    const value = input as THREE.Vector3;
    return [value.x, value.y, value.z];
  }
  if (node.type === 'VarNode') return evaluateShaderNode(node.node);
  if (node.type === 'ConstNode') return evaluateShaderNode(node.value);
  if (node.type === 'JoinNode') return node.nodes!.flatMap((child) => {
    const value = evaluateShaderNode(child);
    return Array.isArray(value) ? value : [value as number];
  });
  if (node.type === 'SplitNode') {
    const value = evaluateShaderNode(node.node);
    const components = node.components!.split('');
    const selected = components.map((component) => (value as number[])['xyzw'.indexOf(component)]!);
    return selected.length === 1 ? selected[0]! : selected;
  }
  if (node.type === 'OperatorNode') {
    const left = evaluateShaderNode(node.aNode);
    const right = evaluateShaderNode(node.bNode);
    if (node.op === '==') return left === right;
    const operation = node.op === '+' ? (a: number, b: number) => a + b
      : node.op === '-' ? (a: number, b: number) => a - b
        : node.op === '*' ? (a: number, b: number) => a * b
          : node.op === '/' ? (a: number, b: number) => a / b
            : null;
    if (operation === null) throw new Error(`Unsupported shader operator ${node.op}`);
    return componentwise(left, right, operation);
  }
  if (node.type === 'MathNode') {
    const value = evaluateShaderNode(node.aNode);
    switch (node.method) {
      case 'normalize': {
        const vector = value as ShaderVector;
        const length = Math.hypot(...vector);
        return vector.map((component) => component / length);
      }
      case 'atan': return Math.atan2(value as number, evaluateShaderNode(node.bNode) as number);
      case 'asin': return Math.asin(value as number);
      case 'clamp': return Math.min(Math.max(value as number, evaluateShaderNode(node.bNode) as number), evaluateShaderNode(node.cNode) as number);
      case 'exp2': return 2 ** (value as number);
      case 'fract': return (value as number) - Math.floor(value as number);
      case 'negate': return -(value as number);
      default: throw new Error(`Unsupported shader math ${node.method}`);
    }
  }
  if (node.type === 'ConditionalNode') {
    return evaluateShaderNode(node.condNode) ? evaluateShaderNode(node.ifNode) : evaluateShaderNode(node.elseNode);
  }
  throw new Error(`Unsupported shader node ${node.type}`);
}

// TSLグラフに契約上必要なノードが存在するかを、循環参照を避けて調べる。
export function containsShaderNode(
  input: unknown, predicate: (node: ShaderNode) => boolean, seen = new Set<unknown>(),
): boolean {
  if (input === null || typeof input !== 'object' || seen.has(input)) return false;
  seen.add(input);
  const node = input as ShaderNode;
  if (predicate(node)) return true;
  return Object.values(node).some((value) => Array.isArray(value)
    ? value.some((child) => containsShaderNode(child, predicate, seen))
    : containsShaderNode(value, predicate, seen));
}
