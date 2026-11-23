// 近傍拡散補正の画質の指標を GPU で測る。誤差 e(補正を表示の尺度へ写した q の、候補と収束先 q_B の差)を印の中で
// スケール s ごとの帯 L_s へ分け、スコア S = Σ_s w(μ·s)·E_s、E_s = mean_x Σ_成分 max(0, R_s² − σ̃_s²)/(σ̃_s + ε) で、見る人に
// 見える偽の構造を数える。σ̃_s は正直な揺れ(誤差が局所の雑音の強さの白色雑音なら L_s が揺れる大きさ。それに収まる構造は
// 雑音に紛れる)。R_s は形の覆い隠し(L_s から、収束先の同じ帯 a = L_s(q_B) と、それを G_s で広げた b へ窓 G_2s の局所の
// 最小二乗で当てた灰色の成分を除いたもの。真の構造に倍率やぼけとして沿う誤差は見えにくい。最後の帯の係数は印の中の全体で
// 1 つ)。w(μ·s) = exp(−(log₂(μ·s) − log₂S₀)²/(2ω²)) は画面の大きさの重み(μ は表示倍率)、ε は見えない差の床。ガウスの
// 畳み込みは印の中で正規化し、画像の外は 0 とする。
import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, Loop, dot, float, instanceIndex, int, localId, max, select, sqrt, storage, uniform, vec2, vec3, vec4,
  workgroupArray, workgroupBarrier, workgroupId,
} from 'three/tsl';
import { VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import type { ComputeNode, StorageBufferNode } from 'three/webgpu';
import type { FloatNode, IntNode, Vec2Node, Vec3Node, Vec4Node } from '../../src/render/tsl-types';

// 誤差を分けるスケール s(ガウスの標準偏差 [画素])。構造 L_s は帯 G_s∗e − G_2s∗e で、最後の s だけは G_s∗e。
export const ERROR_SCALES: readonly number[] = [1, 2, 4, 8, 16, 32, 64];
const LAST = ERROR_SCALES.length - 1;
// 重み w の山の位置 S₀ [画面の画素] と幅 ω [オクターブ]、見えない差の床 ε(q)。盲検の順位への当てはめで、格子の内側の
// 切りのよい値に落ちたもの(近傍拡散補正の計画書の判断材料)。
const PEAK_SIZE = 1;
const PEAK_WIDTH = 1;
const SCORE_EPSILON = 1e-4;
// 当てはめ直しのために重みを掛ける前の項 E_s(ε) を数える、床 ε(q)の並び。SCORE_EPSILON を含む。
export const FALSE_STRUCTURE_EPSILONS: readonly number[] = [1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3];
// 回帰で b を a に直交化した成分のエネルギー Σ b⊥² = Σbb − (Σab)²/Σaa が、Σaa のこの割合以下なら a だけへ当てる。
// 回帰の和は単精度で最大およそ 8,200 回足す(最後の帯の全体の和: 64 画素の和を 8,100 個)ので、相対の丸めは
// 8,200·2⁻²⁴ ≈ 5e-4 まで。Σ b⊥² はその丸めを受けた 2 つの項の差なので、この割合より小さい値は丸めと区別できない。
const ORTHOGONAL_ENERGY_FLOOR = 1e-3;
// 測れる画像の画素数の上限。
const CAPACITY = VIEW_WIDTH * VIEW_HEIGHT;
// 畳み込みの 1 ワークグループが受け持つ、軸に沿った画素数。
const TILE = 128;
// 画素ごとの項の和を 1 スレッドが受け持つ画素数と、その和の数。
const PIXELS_PER_SUM = 64;
const SEGMENTS = Math.ceil(CAPACITY / PIXELS_PER_SUM);
// 回帰の窓の和 (Σaa, Σab, Σbb, Σea, Σeb) の数。
const REGRESSION_SUMS = 5;
// 1 つの和が足す量の数。和は (Σ L_s², Σ σ̃_s², 雑音の項)、FALSE_STRUCTURE_EPSILONS の順の E_s(ε)、Σ R_s² の順。
const SUMMED = 3 + FALSE_STRUCTURE_EPSILONS.length + 1;

// 誤差の指標。score はスコア S、scoreByScale はその帯ごとの内訳(ERROR_SCALES の順)、noiseTerm は雑音の強さ
// N = mean_x Σ_成分 sqrt(G_2∗H_1²)(H_1 = e − G_1∗e。スコアには入らない)、unweightedFalseStructure[帯][ε] は重みを掛ける前の項
// E_s(ε)(ERROR_SCALES と FALSE_STRUCTURE_EPSILONS の順)、removedFraction[帯] は覆い隠しで除いた割合
// Σ(L_s² − R_s²) / Σ L_s²、r はスケールごとの R(s) = sqrt(Σ L_s² / Σ σ̃_s²)(1 なら正直な雑音、上なら雑音で説明できない
// 構造)。和はどれも 3 成分を通す。
export interface ErrorMeasurement {
  readonly score: number;
  readonly scoreByScale: readonly number[];
  readonly noiseTerm: number;
  readonly unweightedFalseStructure: readonly (readonly number[])[];
  readonly removedFraction: readonly number[];
  readonly r: readonly number[];
}

// スケールの番号 j の帯の粗い側 G_2s の番号。最後のスケールは自分。
const coarserOf = (j: number): number => Math.min(j + 1, LAST);

// 画面の大きさ size = μ·s [画面の画素] の帯の、スコアの重み w。
const weightOf = (size: number): number => Math.exp(-(Math.log2(size / PEAK_SIZE) ** 2) / (2 * PEAK_WIDTH ** 2));

// 標準偏差 s [画素] の、半径 3s で打ち切って和を 1 にした 1 次元の核(-3s..3s の重み)。
function gaussianOf(s: number): Float64Array {
  const radius = Math.ceil(3 * s);
  const taps = Float64Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * s * s)));
  const sum = taps.reduce((total, v) => total + v, 0);
  return taps.map((v) => v / sum);
}
const GAUSSIANS = ERROR_SCALES.map(gaussianOf);

// 1 次元の核 a と b の積の核。台は狭いほう。
function productOf(a: Float64Array, b: Float64Array): Float64Array {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const pad = (long.length - short.length) / 2;
  return short.map((v, i) => v * long[i + pad]!);
}

// 成分ごとの 1 次元の核 components(左右対称。短いものは中央に揃えて 0 で埋める)を、vec4 の重みの並びとして GPU へ
// 置いたもの。2 次元の核は、この 1 次元の核の外積になる。
function kernelOf(components: readonly Float64Array[]): StorageBufferNode<'vec4'> {
  const length = Math.max(...components.map((c) => c.length));
  const taps = new Float32Array(4 * length);
  for (const [k, component] of components.entries()) {
    const pad = (length - component.length) / 2;
    for (const [i, tap] of component.entries()) taps[4 * (i + pad) + k] = tap;
  }
  return storage(new StorageBufferAttribute(taps, 4), 'vec4', length).toReadOnly();
}
// 4 成分とも同じ 1 次元の核 g。
const replicatedKernelOf = (g: Float64Array): StorageBufferNode<'vec4'> => kernelOf([g, g, g, g]);

// 長さ length の vec4 か float の並び。平面は画素ごとに 1 つ持つ、上限の大きさの並び。
const vectorsOf = (length: number): StorageBufferNode<'vec4'> => storage(
  new StorageBufferAttribute(length, 4), 'vec4', length,
);
const floatsOf = (length: number): StorageBufferNode<'float'> => storage(
  new StorageBufferAttribute(length, 1), 'float', length,
);
const planeOf = (): StorageBufferNode<'vec4'> => vectorsOf(CAPACITY);

// 畳み込んだ (Σ g·M·f, Σ g·M) の、印の中で正規化した値 Σ g·M·f / Σ g·M。分母が 0 なら 0。
const normalized = (v: Vec4Node): Vec3Node => select(v.w.greaterThan(0), v.xyz.div(v.w), vec3(0));

// 帯 j の構造 L_s の画素 p の値。smooths は G_s∗(M·f, M) を j の偶奇の枠に置いた 2 枚で、帯 j と粗い側が揃っていること。
function structureOf(smooths: readonly StorageBufferNode<'vec4'>[], j: number, p: IntNode): Vec3Node {
  const fine = normalized(smooths[j % 2]!.element(p));
  return j === LAST ? fine : fine.sub(normalized(smooths[coarserOf(j) % 2]!.element(p)));
}

// 分子 numerator・分母 denominator の比。分母が 0 以下なら 0。
const ratioOf = (numerator: FloatNode, denominator: FloatNode): FloatNode => (
  select(denominator.greaterThan(0), numerator.div(denominator), float(0)));

// 回帰の窓の和 (Σaa, Σab, Σbb, Σea, Σeb) からの、a の係数 α と b の係数 β'。b を a に直交化した b⊥ = b − (Σab/Σaa)·a と
// a へ当ててから、a と b の係数へ戻す。Σaa が 0 なら両方 0。
function coefficientsFrom(aa: FloatNode, ab: FloatNode, bb: FloatNode, ea: FloatNode, eb: FloatNode): Vec2Node {
  const alongA = ratioOf(ea, aa);
  const projection = ratioOf(ab, aa);
  const orthogonalEnergy = bb.sub(projection.mul(ab));
  const independent = aa.greaterThan(0).and(orthogonalEnergy.greaterThan(aa.mul(ORTHOGONAL_ENERGY_FLOOR)));
  const alongB = select(independent, eb.sub(projection.mul(ea)).div(orthogonalEnergy), float(0));
  return vec2(alongA.sub(projection.mul(alongB)), alongB);
}

// 覆い隠した構造の二乗 square の、偽の構造の項 max(0, R_s² − σ̃_s²)/(σ̃_s + ε) の成分ごとの値。
const falseStructureOf = (square: Vec3Node, honest: Vec3Node, epsilon: number): Vec3Node => (
  max(square.sub(honest.mul(honest)), 0).div(honest.add(epsilon)));

export class ErrorMetric {
  // 誤差の 3 成分と収束先の補正の 3 成分に印を掛けたものと印 (M·e, M)・(M·q_B, M)。
  private readonly maskedError = planeOf();
  private readonly maskedConverged = planeOf();
  // スケール j の G_s∗(M·e, M) と G_s∗(M·q_B, M) を、j の偶奇の枠に置く。帯 j を測るあいだは j と 2j の 2 枚が要る。
  private readonly errorSmooths = [planeOf(), planeOf()];
  private readonly convergedSmooths = [planeOf(), planeOf()];
  // 行だけを畳み込んだ途中の値。
  private readonly rows = planeOf();
  // 雑音 H_s = e − G_s∗e の (M·H_s², M) を G_2s で畳み込んだもの(雑音の強さ V_s の材料)。
  private readonly noisePower = planeOf();
  // 帯 j の誤差の構造 (M·L_s(e), M) と収束先の構造 (M·a, M)、それを G_s で広げた G_s∗(M·a, M)(b はその正規化)。
  private readonly errorStructures = planeOf();
  private readonly convergedStructures = planeOf();
  private readonly convergedSpreads = planeOf();
  // 回帰の窓 G_2s の和 (Σaa, Σab, Σbb, Σea) と (Σeb, 0, 0, 0) と、画素ごとの係数 (α, β', 0, 0)。最後の帯の係数は、
  // PIXELS_PER_SUM 画素ごとの REGRESSION_SUMS 個の和から求めた印の中の全体の係数。
  private readonly regressionSums = [planeOf(), planeOf()];
  private readonly coefficients = planeOf();
  private readonly regressionPartials = floatsOf(REGRESSION_SUMS * SEGMENTS);
  private readonly globalCoefficients = vectorsOf(1);
  // 帯ごとの、白色雑音での L_s の分散の係数 κ_s と、その材料 (G_s²∗M, G_s·G_2s∗M, G_2s²∗M)。κ_s は印だけで決まるので、
  // 印が変わったときだけ求め直す。kappaMask と kappaWidth は κ_s を求めた印とその幅。
  private readonly kappas = ERROR_SCALES.map(() => floatsOf(CAPACITY));
  private readonly moments = planeOf();
  private kappaMask: Uint8Array | null = null;
  private kappaWidth = 0;
  // 画素ごとのスコアの項と、帯ごと・PIXELS_PER_SUM 画素ごとの SUMMED 個の量の和。
  private readonly falseStructure = floatsOf(CAPACITY);
  private readonly partialSums = floatsOf(SEGMENTS * ERROR_SCALES.length * SUMMED);
  private readonly width = uniform(0, 'int');
  private readonly height = uniform(0, 'int');
  // 帯ごとのスコアの重み w(μ·s)。
  private readonly weights = ERROR_SCALES.map(() => uniform(0));
  // 段の種類ごとの並び(寸法に合わせてスレッド数を置き直す)と、1 回の指標で走らせる段の順の並び。
  private readonly rowPasses: ComputeNode[] = [];
  private readonly columnPasses: ComputeNode[] = [];
  private readonly pixelPasses: ComputeNode[] = [];
  private readonly sumPasses: ComputeNode[] = [];
  private readonly passesWithKappa: ComputeNode[] = [];
  private readonly passesWithoutKappa: ComputeNode[] = [];

  private constructor(private readonly renderer: WebGPURenderer) {
    const always = (...passes: ComputeNode[]): void => {
      this.passesWithKappa.push(...passes);
      this.passesWithoutKappa.push(...passes);
    };
    // G_s∗(M·e, M) と G_s∗(M·q_B, M) は、帯 j を測る直前に 2s の分を作る。
    const smoothOf = (j: number): ComputeNode[] => {
      const kernel = replicatedKernelOf(GAUSSIANS[j]!);
      return [
        ...this.convolutionOf((p) => this.maskedError.element(p), this.errorSmooths[j % 2]!, kernel),
        ...this.convolutionOf((p) => this.maskedConverged.element(p), this.convergedSmooths[j % 2]!, kernel),
      ];
    };
    always(...smoothOf(0));
    // 帯 j ごとに、構造と雑音の強さ V_s と覆い隠しの係数と、印が変わったときだけ κ_s を求めてから、画素ごとの項を足す。
    for (const [j, fine] of GAUSSIANS.entries()) {
      const c = coarserOf(j);
      const coarse = GAUSSIANS[c]!;
      if (c !== j) always(...smoothOf(c));
      const coarseKernel = replicatedKernelOf(coarse);
      always(
        this.structurePassOf(j),
        ...this.convolutionOf((p) => this.noiseSquareOf(j, p), this.noisePower, coarseKernel),
        ...this.convolutionOf(
          (p) => this.convergedStructures.element(p), this.convergedSpreads, replicatedKernelOf(fine),
        ),
      );
      if (j === LAST) {
        always(this.regressionPartialPass(), this.globalCoefficientPass());
      } else {
        always(
          ...this.convolutionOf((p) => this.regressionSourcesOf(p)[0], this.regressionSums[0]!, coarseKernel),
          ...this.convolutionOf((p) => this.regressionSourcesOf(p)[1], this.regressionSums[1]!, coarseKernel),
        );
      }
      always(this.coefficientPassOf(j));
      const momentKernel = kernelOf(j === LAST ? [productOf(fine, fine)]
        : [productOf(fine, fine), productOf(fine, coarse), productOf(coarse, coarse)]);
      this.passesWithKappa.push(
        ...this.convolutionOf((p) => vec4(this.maskedError.element(p).w), this.moments, momentKernel),
        this.kappaPassOf(j),
      );
      always(this.sumPassOf(j));
    }
  }

  // 自前のレンダラで組む。
  public static async create(): Promise<ErrorMetric> {
    const renderer = new WebGPURenderer();
    await renderer.init();
    return new ErrorMetric(renderer);
  }

  // 誤差 error と収束先の補正 converged(どちらも画素ごとに 3 成分)の、印 mask(画素ごとに 0 か 1)の立った画素での
  // 指標。画像は width × height で、描画テスト環境の絵の画素数まで。magnification は表示倍率 μ(画像の 1 画素が画面の
  // 何画素に映るか)。
  public async measure(
    error: Float32Array, converged: Float32Array, mask: Uint8Array, width: number, height: number,
    magnification: number,
  ): Promise<ErrorMeasurement> {
    const count = width * height;
    if (count > CAPACITY) throw new Error(`error-metric: ${width}×${height} exceeds ${VIEW_WIDTH}×${VIEW_HEIGHT}`);
    // 入力と寸法、重み、段ごとのスレッド数を置き、全ての段を 1 度に走らせる。印が前と同じなら κ_s を求める段は除く。
    const errorAttribute = this.maskedError.value;
    const convergedAttribute = this.maskedConverged.value;
    const errorInput = errorAttribute.array as Float32Array;
    const convergedInput = convergedAttribute.array as Float32Array;
    let maskCount = 0;
    for (let p = 0; p < count; p++) {
      for (let k = 0; k < 3; k++) {
        errorInput[4 * p + k] = mask[p]! * error[3 * p + k]!;
        convergedInput[4 * p + k] = mask[p]! * converged[3 * p + k]!;
      }
      errorInput[4 * p + 3] = mask[p]!;
      convergedInput[4 * p + 3] = mask[p]!;
      maskCount += mask[p]!;
    }
    errorAttribute.needsUpdate = true;
    convergedAttribute.needsUpdate = true;
    this.width.value = width;
    this.height.value = height;
    const weights = ERROR_SCALES.map((s) => weightOf(magnification * s));
    for (const [j, weight] of weights.entries()) this.weights[j]!.value = weight;
    for (const pass of this.rowPasses) pass.dispatchSize = [Math.ceil(width / TILE), height, 1];
    for (const pass of this.columnPasses) pass.dispatchSize = [Math.ceil(height / TILE), width, 1];
    for (const pass of this.pixelPasses) pass.count = count;
    const segments = Math.ceil(count / PIXELS_PER_SUM);
    for (const pass of this.sumPasses) pass.count = segments;
    const knownMask = width === this.kappaWidth && this.kappaMask !== null && this.kappaMask.length === count
      && this.kappaMask.every((v, p) => v === mask[p]);
    this.renderer.compute(knownMask ? this.passesWithoutKappa : this.passesWithKappa);
    if (!knownMask) {
      this.kappaMask = mask.slice(0, count);
      this.kappaWidth = width;
    }
    const partials = await this.renderer.getArrayBufferAsync(this.partialSums.value);
    return summaryOf(new Float32Array(partials), segments, maskCount, weights);
  }

  // 直前に measure で測った画像の、画素ごとのスコアの項(3 成分の和。印の立っていない画素は 0)。
  public async falseStructureMap(): Promise<Float32Array> {
    const count = this.width.value * this.height.value;
    return new Float32Array(await this.renderer.getArrayBufferAsync(this.falseStructure.value, null, 0, 4 * count));
  }

  // 平面を、成分ごとの 1 次元の核 kernel の外積で畳み込み target へ書く 2 段(行と列)。read は畳み込む平面の画素 p の値。
  private convolutionOf(
    read: (p: IntNode) => Vec4Node, target: StorageBufferNode<'vec4'>, kernel: StorageBufferNode<'vec4'>,
  ): ComputeNode[] {
    return [
      this.linePassOf('row', read, this.rows, kernel),
      this.linePassOf('column', (p) => this.rows.element(p), target, kernel),
    ];
  }

  // 平面を 1 次元の核 kernel で軸 axis に沿って畳み込み target へ書く段。ワークグループは軸に沿った TILE 画素を受け持ち、
  // 両側に核の半径を足した区間をワークグループ共有メモリへ読んでから畳み込む。
  private linePassOf(
    axis: 'row' | 'column', read: (p: IntNode) => Vec4Node, target: StorageBufferNode<'vec4'>,
    kernel: StorageBufferNode<'vec4'>,
  ): ComputeNode {
    const radius = (kernel.value.count - 1) / 2;
    // three の型が workgroupArray の element を宣言していないので、その面だけで受ける。
    const tile = workgroupArray('vec4', TILE + 2 * radius) as unknown as { element: (i: IntNode) => Vec4Node };
    const { width } = this;
    const length = axis === 'row' ? this.width : this.height;
    const pass = Fn(() => {
      const local = int(localId.x);
      const first = int(workgroupId.x).mul(TILE);
      const line = int(workgroupId.y);
      const pixelOf = (along: IntNode): IntNode => (
        axis === 'row' ? line.mul(width).add(along) : along.mul(width).add(line));
      Loop({ start: local, end: TILE + 2 * radius, type: 'int', update: TILE }, ({ i }) => {
        const along = first.sub(radius).add(i);
        tile.element(i).assign(vec4(0));
        If(along.greaterThanEqual(0).and(along.lessThan(length)), () => {
          tile.element(i).assign(read(pixelOf(along)));
        });
      });
      workgroupBarrier();
      const along = first.add(local);
      If(along.lessThan(length), () => {
        // 核は左右対称なので、中心から等距離の 2 画素を足してから重みを掛ける。
        const center = local.add(radius);
        const sum = kernel.element(radius).mul(tile.element(center)).toVar();
        Loop({ start: 1, end: radius, type: 'int', condition: '<=' }, ({ i }) => {
          const pair = tile.element(center.add(i)).add(tile.element(center.sub(i)));
          sum.addAssign(kernel.element(i.add(radius)).mul(pair));
        });
        target.element(pixelOf(along)).assign(sum);
      });
    })().computeKernel([TILE]);
    (axis === 'row' ? this.rowPasses : this.columnPasses).push(pass);
    return pass;
  }

  // 帯 j の誤差の構造 (M·L_s(e), M) を errorStructures へ、収束先の構造 (M·a, M) を convergedStructures へ書く段。
  private structurePassOf(j: number): ComputeNode {
    const pass = Fn(() => {
      const p = int(instanceIndex);
      const m = this.maskedError.element(p).w;
      this.errorStructures.element(p).assign(vec4(structureOf(this.errorSmooths, j, p).mul(m), m));
      this.convergedStructures.element(p).assign(vec4(structureOf(this.convergedSmooths, j, p).mul(m), m));
    })().compute(CAPACITY);
    this.pixelPasses.push(pass);
    return pass;
  }

  // 帯 j の雑音 H_s = e − G_s∗e の、画素 p の (M·H_s², M)。
  private noiseSquareOf(j: number, p: IntNode): Vec4Node {
    const source = this.maskedError.element(p);
    const noise = source.xyz.sub(normalized(this.errorSmooths[j % 2]!.element(p)));
    return vec4(noise.mul(noise).mul(source.w), source.w);
  }

  // 画素 p の、回帰の窓で足す量 M·(aa, ab, bb, ea) と M·(eb, 0, 0, 0)(e = L_s(e)、積は 3 成分の内積)。
  private regressionSourcesOf(p: IntNode): [Vec4Node, Vec4Node] {
    const error = this.errorStructures.element(p);
    const a = this.convergedStructures.element(p).xyz;
    const b = normalized(this.convergedSpreads.element(p)).mul(error.w);
    const e = error.xyz;
    return [vec4(dot(a, a), dot(a, b), dot(b, b), dot(e, a)), vec4(dot(e, b), 0, 0, 0)];
  }

  // 帯 j の画素ごとの係数 (α, β', 0, 0) を coefficients へ書く段。最後の帯は印の中の全体の係数を写す。
  private coefficientPassOf(j: number): ComputeNode {
    const pass = Fn(() => {
      const p = int(instanceIndex);
      const [first, second] = [this.regressionSums[0]!.element(p), this.regressionSums[1]!.element(p)];
      const fit = j === LAST ? this.globalCoefficients.element(0)
        : vec4(coefficientsFrom(first.x, first.y, first.z, first.w, second.x), 0, 0);
      this.coefficients.element(p).assign(fit);
    })().compute(CAPACITY);
    this.pixelPasses.push(pass);
    return pass;
  }

  // 最後の帯の回帰の和 (Σaa, Σab, Σbb, Σea, Σeb) を、印の立った画素で PIXELS_PER_SUM 画素ずつ足して regressionPartials へ
  // 書く段。
  private regressionPartialPass(): ComputeNode {
    const pass = Fn(() => {
      const t = int(instanceIndex);
      const count = this.width.mul(this.height);
      const sums = [vec4(0).toVar(), float(0).toVar()] as const;
      Loop(PIXELS_PER_SUM, ({ i }) => {
        const p = t.mul(PIXELS_PER_SUM).add(i);
        If(p.lessThan(count), () => {
          const [first, second] = this.regressionSourcesOf(p);
          sums[0].addAssign(first);
          sums[1].addAssign(second.x);
        });
      });
      const [first, second] = sums;
      for (const [k, sum] of [first.x, first.y, first.z, first.w, second].entries()) {
        this.regressionPartials.element(t.mul(REGRESSION_SUMS).add(k)).assign(sum);
      }
    })().compute(SEGMENTS);
    this.sumPasses.push(pass);
    return pass;
  }

  // regressionPartials を全て足し、最後の帯の印の中の全体の係数を globalCoefficients へ書く 1 スレッドの段。
  private globalCoefficientPass(): ComputeNode {
    return Fn(() => {
      const segments = this.width.mul(this.height).add(PIXELS_PER_SUM - 1).div(PIXELS_PER_SUM);
      const sums = Array.from({ length: REGRESSION_SUMS }, () => float(0).toVar());
      Loop({ start: 0, end: segments, type: 'int' }, ({ i }) => {
        for (const [k, sum] of sums.entries()) {
          sum.addAssign(this.regressionPartials.element(i.mul(REGRESSION_SUMS).add(k)));
        }
      });
      const [aa, ab, bb, ea, eb] = [sums[0]!, sums[1]!, sums[2]!, sums[3]!, sums[4]!];
      this.globalCoefficients.element(0).assign(vec4(coefficientsFrom(aa, ab, bb, ea, eb), 0, 0));
    })().compute(1);
  }

  // 帯 j の κ_s(画素ごとの正規化した核 ĝ の Σ(ĝ_s − ĝ_2s)²。最後のスケールは Σĝ_s²)を kappas[j] へ書く段。
  private kappaPassOf(j: number): ComputeNode {
    const c = coarserOf(j);
    const pass = Fn(() => {
      const p = int(instanceIndex);
      const moment = this.moments.element(p);
      const [ws, wc] = [this.errorSmooths[j % 2]!.element(p).w, this.errorSmooths[c % 2]!.element(p).w];
      const kappa = j === LAST ? moment.x.div(ws.mul(ws))
        : moment.x.div(ws.mul(ws)).sub(moment.y.mul(2).div(ws.mul(wc))).add(moment.z.div(wc.mul(wc)));
      this.kappas[j]!.element(p).assign(kappa);
    })().compute(CAPACITY);
    this.pixelPasses.push(pass);
    return pass;
  }

  // 帯 j の画素ごとの項を、印の立った画素で PIXELS_PER_SUM 画素ずつ足して partialSums へ書き、スコアの項を
  // falseStructure へ足す段(最初の帯は置く)。
  private sumPassOf(j: number): ComputeNode {
    const pass = Fn(() => {
      const t = int(instanceIndex);
      const count = this.width.mul(this.height);
      const sums = vec3(0).toVar();
      const unweightedSums = FALSE_STRUCTURE_EPSILONS.map(() => float(0).toVar());
      const residualSum = float(0).toVar();
      Loop(PIXELS_PER_SUM, ({ i }) => {
        const p = t.mul(PIXELS_PER_SUM).add(i);
        const scoreTerm = float(0).toVar();
        const error = this.errorStructures.element(p);
        If(p.lessThan(count).and(error.w.greaterThan(0)), () => {
          // 構造 L_s と、雑音の強さ V_s = G_2s∗H_s² から白色雑音なら L_s が揺れる大きさ σ̃_s = sqrt(V_s·κ_s)。
          const structure = error.xyz;
          const power = normalized(this.noisePower.element(p));
          const honest = sqrt(max(power.mul(this.kappas[j]!.element(p)), 0));
          // 覆い隠した構造 R_s と、床 ε ごとの偽の構造の項。
          const fit = this.coefficients.element(p);
          const residual = structure.sub(this.convergedStructures.element(p).xyz.mul(fit.x))
            .sub(normalized(this.convergedSpreads.element(p)).mul(fit.y));
          const square = residual.mul(residual);
          for (const [k, epsilon] of FALSE_STRUCTURE_EPSILONS.entries()) {
            unweightedSums[k]!.addAssign(dot(falseStructureOf(square, honest, epsilon), vec3(1)));
          }
          scoreTerm.assign(dot(falseStructureOf(square, honest, SCORE_EPSILON), vec3(1)).mul(this.weights[j]!));
          residualSum.addAssign(dot(square, vec3(1)));
          // N = sqrt(G_2∗H_1²) は最も細かいスケールの V の平方根。
          const noise = j === 0 ? dot(sqrt(power), vec3(1)) : 0;
          sums.addAssign(vec3(dot(structure.mul(structure), vec3(1)), dot(honest.mul(honest), vec3(1)), noise));
        });
        const map = this.falseStructure.element(p);
        if (j === 0) map.assign(scoreTerm);
        else map.addAssign(scoreTerm);
      });
      const first = t.add(j * SEGMENTS).mul(SUMMED);
      for (const [k, sum] of [sums.x, sums.y, sums.z, ...unweightedSums, residualSum].entries()) {
        this.partialSums.element(first.add(k)).assign(sum);
      }
    })().compute(SEGMENTS);
    this.sumPasses.push(pass);
    return pass;
  }
}

// 帯ごとの和の並び partials(sumPassOf の並び)の、帯ごとに先頭 segments 個の和を、印の立った画素の数 count とスコアの
// 帯ごとの重み weights で指標へ。
function summaryOf(
  partials: Float32Array, segments: number, count: number, weights: readonly number[],
): ErrorMeasurement {
  const bandSums = ERROR_SCALES.map((_, j) => Array.from({ length: SUMMED }, (_, k) => {
    let sum = 0;
    for (let t = j * SEGMENTS; t < j * SEGMENTS + segments; t++) sum += partials[SUMMED * t + k]!;
    return sum;
  }));
  const unweightedFalseStructure = bandSums.map((sums) => sums.slice(3, 3 + FALSE_STRUCTURE_EPSILONS.length)
    .map((v) => v / count));
  const scoreEpsilon = FALSE_STRUCTURE_EPSILONS.indexOf(SCORE_EPSILON);
  const scoreByScale = unweightedFalseStructure.map((band, j) => weights[j]! * band[scoreEpsilon]!);
  return {
    score: scoreByScale.reduce((sum, v) => sum + v, 0),
    scoreByScale,
    noiseTerm: bandSums[0]![2]! / count,
    unweightedFalseStructure,
    removedFraction: bandSums.map((sums) => 1 - sums[SUMMED - 1]! / sums[0]!),
    r: bandSums.map(([structureSquare, honestSquare]) => Math.sqrt(structureSquare! / honestSquare!)),
  };
}
