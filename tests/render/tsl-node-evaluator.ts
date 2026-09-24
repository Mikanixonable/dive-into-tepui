import * as THREE from 'three/webgpu';

// このテスト層で値として評価する、TSLの定数・スカラー・ベクトル・行列の狭い集合。
export type ShaderValue = number | boolean | number[] | THREE.Matrix4;

interface ShaderNode {
  readonly type?: string;
  readonly value?: unknown;
  readonly node?: ShaderNode;
  readonly nodes?: readonly ShaderNode[];
  readonly components?: string;
  readonly convertTo?: string;
  readonly method?: string;
  readonly op?: string;
  readonly aNode?: ShaderNode | null;
  readonly bNode?: ShaderNode | null;
  readonly cNode?: ShaderNode | null;
  readonly condNode?: ShaderNode;
  readonly ifNode?: ShaderNode;
  readonly elseNode?: ShaderNode | null;
  readonly isShaderCallNodeInternal?: boolean;
  readonly shaderNode?: { readonly jsFunc: (inputs: unknown, builder: unknown) => unknown };
  readonly rawInputs?: unknown;
}

type ShaderVector = number[];

// 子ノードを評価する関数。1 回の評価の中で共有されたノードは一度だけ評価する。
type Evaluate = (input: unknown) => ShaderValue;

// Fn の本体を展開するときに渡す builder。描画と同じ WebGPU の座標系を答える。
const WEBGPU_BUILDER = { renderer: { coordinateSystem: THREE.WebGPUCoordinateSystem } };

// スカラーとベクトルの算術演算を、GPUのスカラー拡張規則に合わせて適用する。
function componentwise(left: ShaderValue, right: ShaderValue, operation: (a: number, b: number) => number): ShaderValue {
  if (Array.isArray(left)) return left.map((value, index) => componentwise(value, Array.isArray(right) ? right[index]! : right, operation)) as ShaderVector;
  if (Array.isArray(right)) return right.map((value) => componentwise(left, value, operation)) as ShaderVector;
  return operation(left as number, right as number);
}

// 演算子を評価する。比較・論理・ビット演算はスカラーだけを扱い、ビット演算は 32 ビットの uint として評価する。
function evaluateOperator(node: ShaderNode, evaluate: Evaluate): ShaderValue {
  const left = evaluate(node.aNode);
  if (node.op === '~') return ~(left as number) >>> 0;
  const right = evaluate(node.bNode);
  switch (node.op) {
    case '+': return componentwise(left, right, (a, b) => a + b);
    case '-': return componentwise(left, right, (a, b) => a - b);
    case '*': return left instanceof THREE.Matrix4
      ? new THREE.Vector4().fromArray(right as ShaderVector).applyMatrix4(left).toArray()
      : componentwise(left, right, (a, b) => a * b);
    case '/': return componentwise(left, right, (a, b) => a / b);
    case '==': return left === right;
    case '<': return (left as number) < (right as number);
    case '>': return (left as number) > (right as number);
    case '<=': return (left as number) <= (right as number);
    case '>=': return (left as number) >= (right as number);
    case '&&': return (left as boolean) && (right as boolean);
    case '||': return (left as boolean) || (right as boolean);
    case '&': return ((left as number) & (right as number)) >>> 0;
    case '|': return ((left as number) | (right as number)) >>> 0;
    case '<<': return ((left as number) << (right as number)) >>> 0;
    default: throw new Error(`Unsupported shader operator ${node.op}`);
  }
}

// 組み込み関数を評価する。ベクトルを取る関数のほかはスカラーだけを扱う。
function evaluateMath(node: ShaderNode, evaluate: Evaluate): ShaderValue {
  const value = evaluate(node.aNode);
  switch (node.method) {
    case 'normalize': {
      const vector = value as ShaderVector;
      const length = Math.hypot(...vector);
      return vector.map((component) => component / length);
    }
    case 'length': return Math.hypot(...(value as ShaderVector));
    case 'cross': {
      const [ax, ay, az] = value as ShaderVector;
      const [bx, by, bz] = evaluate(node.bNode) as ShaderVector;
      return [ay! * bz! - az! * by!, az! * bx! - ax! * bz!, ax! * by! - ay! * bx!];
    }
    case 'atan': return Math.atan2(value as number, evaluate(node.bNode) as number);
    case 'asin': return Math.asin(value as number);
    case 'clamp': return Math.min(Math.max(value as number, evaluate(node.bNode) as number), evaluate(node.cNode) as number);
    case 'exp2': return 2 ** (value as number);
    case 'fract': return (value as number) - Math.floor(value as number);
    case 'floor': return Math.floor(value as number);
    case 'round': {
      // WGSL の round は、ちょうど半分を偶数へ丸める。
      const nearest = Math.round(value as number);
      return nearest - (value as number) === 0.5 && nearest % 2 !== 0 ? nearest - 1 : nearest;
    }
    case 'sign': return Math.sign(value as number);
    case 'abs': return Math.abs(value as number);
    case 'negate': return -(value as number);
    case 'oneMinus': return 1 - (value as number);
    case 'sqrt': return Math.sqrt(value as number);
    case 'sin': return Math.sin(value as number);
    case 'cos': return Math.cos(value as number);
    case 'acos': return Math.acos(value as number);
    case 'max': return Math.max(value as number, evaluate(node.bNode) as number);
    case 'min': return Math.min(value as number, evaluate(node.bNode) as number);
    case 'dot': {
      const left = value as ShaderVector;
      const right = evaluate(node.bNode) as ShaderVector;
      return left.reduce((sum, component, index) => sum + component * right[index]!, 0);
    }
    case 'countOneBits': return [...(value as number).toString(2)].filter((bit) => bit === '1').length;
    default: throw new Error(`Unsupported shader math ${node.method}`);
  }
}

// 型の変換を評価する。整数への変換は 0 へ向けて切り捨てる。
function evaluateConversion(node: ShaderNode, evaluate: Evaluate): ShaderValue {
  const value = evaluate(node.node);
  if (node.convertTo === 'int' || node.convertTo === 'uint') return Math.trunc(value as number);
  const sameShape = Array.isArray(value) ? node.convertTo === `vec${value.length}` : node.convertTo === 'float';
  if (!sameShape) throw new Error(`Unsupported shader conversion to ${node.convertTo}`);
  return value;
}

// ノード 1 つを、子を evaluate で評価して求める。
function evaluateNode(input: unknown, evaluate: Evaluate): ShaderValue {
  const node = input as ShaderNode & {
    readonly isVector2?: boolean; readonly isVector3?: boolean; readonly isMatrix4?: boolean;
  };
  if (node.isVector2) {
    const value = input as THREE.Vector2;
    return [value.x, value.y];
  }
  if (node.isVector3) {
    const value = input as THREE.Vector3;
    return [value.x, value.y, value.z];
  }
  if (node.isMatrix4) return input as THREE.Matrix4;
  if (node.isShaderCallNodeInternal) return evaluate(node.shaderNode!.jsFunc(node.rawInputs, WEBGPU_BUILDER));
  if (node.type === 'VarNode') return evaluate(node.node);
  if (node.type === 'ConstNode' || node.type === 'UniformNode') return evaluate(node.value);
  if (node.type === 'ConvertNode') return evaluateConversion(node, evaluate);
  if (node.type === 'JoinNode') return node.nodes!.flatMap((child) => {
    const value = evaluate(child);
    return Array.isArray(value) ? value : [value as number];
  });
  if (node.type === 'SplitNode') {
    const value = evaluate(node.node);
    const components = node.components!.split('');
    const selected = components.map((component) => (value as number[])['xyzw'.indexOf(component)]!);
    return selected.length === 1 ? selected[0]! : selected;
  }
  if (node.type === 'OperatorNode') return evaluateOperator(node, evaluate);
  if (node.type === 'MathNode' || node.type === 'BitcountNode') return evaluateMath(node, evaluate);
  if (node.type === 'ConditionalNode') {
    return evaluate(node.condNode) ? evaluate(node.ifNode) : evaluate(node.elseNode);
  }
  throw new Error(`Unsupported shader node ${node.type}`);
}

// 実GPUを起動せず、TSLノードを倍精度で数学的に評価する。知らない種類のノード・演算・関数は投げる。
export function evaluateShaderNode(input: unknown): ShaderValue {
  const values = new Map<unknown, ShaderValue>();
  const evaluate: Evaluate = (child) => {
    if (typeof child === 'number' || typeof child === 'boolean') return child;
    const known = values.get(child);
    if (known !== undefined) return known;
    const value = evaluateNode(child, evaluate);
    values.set(child, value);
    return value;
  };
  return evaluate(input);
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
