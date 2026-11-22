import * as THREE from 'three/webgpu';

// このテスト層で値として評価する、TSLの定数・スカラー・ベクトル・行列の狭い集合。
export type ShaderValue = number | boolean | number[] | THREE.Matrix4;

interface ShaderNode {
  readonly type?: string;
  readonly value?: unknown;
  readonly node?: ShaderNode;
  readonly valueNode?: ShaderNode;
  readonly conversionType?: string;
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
function componentwise(left: ShaderValue, right: ShaderValue, operation: (a: number, b: number) => number | boolean): ShaderValue {
  if (Array.isArray(left)) return left.map((value, index) => componentwise(value, Array.isArray(right) ? right[index]! : right, operation)) as ShaderVector;
  if (Array.isArray(right)) return right.map((value) => componentwise(left, value, operation)) as ShaderVector;
  return operation(left as number, right as number);
}

// 要素ごとの 1 引数関数。スカラーにはそのまま掛け、ベクトルには全成分へ掛ける。
function elementwise(value: ShaderValue, operation: (x: number) => number): ShaderValue {
  return Array.isArray(value)
    ? value.map((x) => elementwise(x, operation) as number)
    : operation(value as number);
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
    case '>>': return (left as number) >>> (right as number);
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
    case 'length': return Math.hypot(...(Array.isArray(value) ? value : [value as number]));
    case 'cross': {
      const [ax, ay, az] = value as ShaderVector;
      const [bx, by, bz] = evaluate(node.bNode) as ShaderVector;
      return [ay! * bz! - az! * by!, az! * bx! - ax! * bz!, ax! * by! - ay! * bx!];
    }
    case 'atan': return Math.atan2(value as number, evaluate(node.bNode) as number);
    case 'asin': return elementwise(value, Math.asin);
    case 'clamp': return componentwise(
      componentwise(value, evaluate(node.bNode), Math.max), evaluate(node.cNode), Math.min,
    );
    case 'exp2': return elementwise(value, (x) => 2 ** x);
    case 'exp': return Array.isArray(value) ? value.map(Math.exp) : Math.exp(value as number);
    case 'log': return Array.isArray(value) ? value.map(Math.log) : Math.log(value as number);
    case 'log2': return elementwise(value, Math.log2);
    case 'fract': return elementwise(value, (x) => x - Math.floor(x));
    case 'floor': return Array.isArray(value)
      ? value.map((component) => Math.floor(component))
      : Math.floor(value as number);
    case 'round': {
      // WGSL の round は、ちょうど半分を偶数へ丸める。
      const roundEven = (component: number): number => {
        const nearest = Math.round(component);
        return nearest - component === 0.5 && nearest % 2 !== 0 ? nearest - 1 : nearest;
      };
      return Array.isArray(value) ? value.map(roundEven) : roundEven(value as number);
    }
    case 'sign': return Array.isArray(value) ? value.map(Math.sign) : Math.sign(value as number);
    case 'abs': return Array.isArray(value) ? value.map(Math.abs) : Math.abs(value as number);
    case 'negate': return Array.isArray(value) ? value.map((component) => -component) : -(value as number);
    case 'oneMinus': return elementwise(value, (x) => 1 - x);
    case 'sqrt': return elementwise(value, Math.sqrt);
    case 'sin': return elementwise(value, Math.sin);
    case 'cos': return elementwise(value, Math.cos);
    case 'acos': return elementwise(value, Math.acos);
    case 'max': return componentwise(value, evaluate(node.bNode), Math.max);
    case 'min': return componentwise(value, evaluate(node.bNode), Math.min);
    case 'pow': return (value as number) ** (evaluate(node.bNode) as number);
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
  if (Array.isArray(value) && node.convertTo === `ivec${value.length}`) {
    return value.map((component) => Math.trunc(component));
  }
  const sameShape = Array.isArray(value) ? node.convertTo === `vec${value.length}` : node.convertTo === 'float';
  if (!sameShape) throw new Error(`Unsupported shader conversion to ${node.convertTo}`);
  return value;
}

function evaluateBitcast(node: ShaderNode, evaluate: Evaluate): ShaderValue {
  const value = evaluate(node.valueNode) as number;
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  if (node.conversionType === 'uint') {
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
  }
  if (node.conversionType === 'float') {
    view.setUint32(0, value >>> 0, true);
    return view.getFloat32(0, true);
  }
  throw new Error(`Unsupported shader bitcast to ${node.conversionType}`);
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
  if (node.type === 'BitcastNode') return evaluateBitcast(node, evaluate);
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
  // vec3(スカラーノード) のような型変換。ベクトル化は値を全成分へ複製し、スカラー化は
  // 先頭の成分を取る。
  if (node.type === 'ConvertNode') {
    const value = evaluateShaderNode(node.node);
    const count = (node as { readonly nodeType?: string }).nodeType === 'vec2' ? 2
      : (node as { readonly nodeType?: string }).nodeType === 'vec3' ? 3
        : (node as { readonly nodeType?: string }).nodeType === 'vec4' ? 4
          : 0;
    if (count === 0) return Array.isArray(value) ? value[0]! : value;
    return Array.isArray(value)
      ? value.slice(0, count)
      : Array.from({ length: count }, () => value as number);
  }
  // uniformArray(...).element(i)。保持する JS 配列の要素をそのまま評価する。
  if ((node as { readonly isArrayElementNode?: boolean }).isArrayElementNode === true) {
    const element = node as { readonly node: { readonly array: readonly unknown[] }; readonly indexNode: unknown };
    const index = evaluateShaderNode(element.indexNode) as number;
    return evaluateShaderNode(element.node.array[index]);
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
