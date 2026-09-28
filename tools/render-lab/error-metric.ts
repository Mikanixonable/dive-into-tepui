// 近傍拡散補正の画質の指標を GPU で測る。誤差 e(補正を表示の尺度へ写した q の、候補と収束先の差)を印の中で
// スケール s ごとに構造 L_s と雑音へ分け、雑音の強さから正直な白色雑音なら L_s が揺れる大きさ σ̃_s を求め、スコア
// S = mean_x Σ_成分 [N + β·Σ_s (μ·s)^−γ·max(0, L_s² − σ̃_s²)/(σ̃_s + ε)] で雑音の罰 N と偽の構造の罰を 1 つに並べる
// (μ は表示倍率)。ガウスの畳み込みは印の中で正規化し、画像の外は 0 とする。
import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, Loop, dot, instanceIndex, int, localId, max, select, sqrt, storage, uniform, vec3, vec4, workgroupArray,
  workgroupBarrier, workgroupId,
} from 'three/tsl';
import { VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import type { ComputeNode, StorageBufferNode } from 'three/webgpu';
import type { IntNode, Vec3Node, Vec4Node } from '../../src/render/tsl-types';

// 誤差を分けるスケール s(ガウスの標準偏差 [画素])。構造 L_s は帯 G_s∗e − G_2s∗e で、最後の s だけは G_s∗e。
export const ERROR_SCALES: readonly number[] = [1, 2, 4, 8, 16, 32, 64];
const LAST = ERROR_SCALES.length - 1;
// 偽の構造の罰の重み β と、スケールの重み (μ·s)^−γ の指数 γ、偽の構造の罰の分母の下限 ε(q)。
const FALSE_STRUCTURE_WEIGHT = 100;
const SCALE_EXPONENT = 2;
const EPSILON = 3e-4;
// 測れる画像の画素数の上限。
const CAPACITY = VIEW_WIDTH * VIEW_HEIGHT;
// 畳み込みの 1 ワークグループが受け持つ、軸に沿った画素数。
const TILE = 128;
// 画素ごとの項の和を 1 スレッドが受け持つ画素数と、その和の数。
const PIXELS_PER_SUM = 64;
const SEGMENTS = Math.ceil(CAPACITY / PIXELS_PER_SUM);

// 誤差の指標。score はスコア S、noiseTerm と falseStructureTerm はその雑音と偽の構造の項、falseStructureByScale は
// 偽の構造の項のスケールごとの内訳(ERROR_SCALES の順)、r はスケールごとの R(s) = sqrt(Σ L_s² / Σ σ̃_s²)(3 成分を
// 通して。1 なら正直な雑音、上なら雑音で説明できない構造)。
export interface ErrorMeasurement {
  readonly score: number;
  readonly noiseTerm: number;
  readonly falseStructureTerm: number;
  readonly falseStructureByScale: readonly number[];
  readonly r: readonly number[];
}

// スケールの番号 j の帯の粗い側 G_2s の番号。最後のスケールは自分。
const coarserOf = (j: number): number => Math.min(j + 1, LAST);

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

// 画素ごとに vec4 か float を 1 つ持つ、上限の大きさの平面。
const planeOf = (): StorageBufferNode<'vec4'> => storage(new StorageBufferAttribute(CAPACITY, 4), 'vec4', CAPACITY);
const scalarPlaneOf = (): StorageBufferNode<'float'> => storage(
  new StorageBufferAttribute(CAPACITY, 1), 'float', CAPACITY,
);

// 畳み込んだ (Σ g·M·f, Σ g·M) の、印の中で正規化した値 Σ g·M·f / Σ g·M。分母が 0 なら 0。
const normalized = (v: Vec4Node): Vec3Node => select(v.w.greaterThan(0), v.xyz.div(v.w), vec3(0));

export class ErrorMetric {
  // 誤差の 3 成分に印を掛けたものと印 (M·e, M)。
  private readonly input = planeOf();
  // スケール j の G_s∗(M·e, M) を、j の偶奇の枠に置く。帯 j を測るあいだは j と 2j の 2 枚が要る。
  private readonly smooths = [planeOf(), planeOf()];
  // 行だけを畳み込んだ途中の値。
  private readonly rows = planeOf();
  // 雑音 H_s = e − G_s∗e の (M·H_s², M) と、それを G_2s で畳み込んだもの。
  private readonly squared = planeOf();
  private readonly power = planeOf();
  // 帯ごとの、白色雑音での L_s の分散の係数 κ_s と、その材料 (G_s²∗M, G_s·G_2s∗M, G_2s²∗M)。κ_s は印だけで決まるので、
  // 印が変わったときだけ求め直す。kappaMask と kappaWidth は κ_s を求めた印とその幅。
  private readonly kappas = ERROR_SCALES.map(() => scalarPlaneOf());
  private readonly moments = planeOf();
  private kappaMask: Uint8Array | null = null;
  private kappaWidth = 0;
  // 画素ごとの偽の構造の項と、帯ごと・PIXELS_PER_SUM 画素ごとの (Σ L_s², Σ σ̃_s², 偽の構造の項, 雑音の項) の和。
  private readonly falseStructure = scalarPlaneOf();
  private readonly partialSums = storage(
    new StorageBufferAttribute(SEGMENTS * ERROR_SCALES.length, 4), 'vec4', SEGMENTS * ERROR_SCALES.length,
  );
  private readonly width = uniform(0, 'int');
  private readonly height = uniform(0, 'int');
  // 帯ごとの偽の構造の罰の重み β·(μ·s)^−γ。
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
    // G_s∗(M·e, M) は、帯 j を測る直前に 2s の分を作る。
    const smoothOf = (j: number): ComputeNode[] => this.convolutionOf(
      (p) => this.input.element(p), this.smooths[j % 2]!, replicatedKernelOf(GAUSSIANS[j]!),
    );
    always(...smoothOf(0));
    // 帯 j ごとに、雑音の強さ V_s と、印が変わったときだけ κ_s を求めてから、画素ごとの項を足す。
    for (const [j, fine] of GAUSSIANS.entries()) {
      const c = coarserOf(j);
      const coarse = GAUSSIANS[c]!;
      if (c !== j) always(...smoothOf(c));
      always(
        this.squarePassOf(j),
        ...this.convolutionOf((p) => this.squared.element(p), this.power, replicatedKernelOf(coarse)),
      );
      const momentKernel = kernelOf(j === LAST ? [productOf(fine, fine)]
        : [productOf(fine, fine), productOf(fine, coarse), productOf(coarse, coarse)]);
      this.passesWithKappa.push(
        ...this.convolutionOf((p) => vec4(this.input.element(p).w), this.moments, momentKernel), this.kappaPassOf(j),
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

  // 誤差 error(画素ごとに 3 成分)の、印 mask(画素ごとに 0 か 1)の立った画素での指標。画像は width × height で、
  // 描画テスト環境の絵の画素数まで。magnification は表示倍率 μ(画像の 1 画素が画面の何画素に映るか)。
  public async measure(
    error: Float32Array, mask: Uint8Array, width: number, height: number, magnification: number,
  ): Promise<ErrorMeasurement> {
    const count = width * height;
    if (count > CAPACITY) throw new Error(`error-metric: ${width}×${height} exceeds ${VIEW_WIDTH}×${VIEW_HEIGHT}`);
    // 入力と寸法、重み、段ごとのスレッド数を置き、全ての段を 1 度に走らせる。印が前と同じなら κ_s を求める段は除く。
    const attribute = this.input.value;
    const input = attribute.array as Float32Array;
    let maskCount = 0;
    for (let p = 0; p < count; p++) {
      for (let k = 0; k < 3; k++) input[4 * p + k] = mask[p]! * error[3 * p + k]!;
      input[4 * p + 3] = mask[p]!;
      maskCount += mask[p]!;
    }
    attribute.needsUpdate = true;
    this.width.value = width;
    this.height.value = height;
    for (const [j, s] of ERROR_SCALES.entries()) {
      this.weights[j]!.value = FALSE_STRUCTURE_WEIGHT * (magnification * s) ** -SCALE_EXPONENT;
    }
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
    return summaryOf(new Float32Array(partials), segments, maskCount);
  }

  // 直前に measure で測った画像の、画素ごとの偽の構造の項(3 成分の和。印の立っていない画素は 0)。
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

  // 帯 j の雑音 H_s = e − G_s∗e の (M·H_s², M) を squared へ書く段。
  private squarePassOf(j: number): ComputeNode {
    const pass = Fn(() => {
      const p = int(instanceIndex);
      const source = this.input.element(p);
      const noise = source.xyz.sub(normalized(this.smooths[j % 2]!.element(p)));
      this.squared.element(p).assign(vec4(noise.mul(noise).mul(source.w), source.w));
    })().compute(CAPACITY);
    this.pixelPasses.push(pass);
    return pass;
  }

  // 帯 j の κ_s(画素ごとの正規化した核 ĝ の Σ(ĝ_s − ĝ_2s)²。最後のスケールは Σĝ_s²)を kappas[j] へ書く段。
  private kappaPassOf(j: number): ComputeNode {
    const c = coarserOf(j);
    const pass = Fn(() => {
      const p = int(instanceIndex);
      const moment = this.moments.element(p);
      const [ws, wc] = [this.smooths[j % 2]!.element(p).w, this.smooths[c % 2]!.element(p).w];
      const kappa = j === LAST ? moment.x.div(ws.mul(ws))
        : moment.x.div(ws.mul(ws)).sub(moment.y.mul(2).div(ws.mul(wc))).add(moment.z.div(wc.mul(wc)));
      this.kappas[j]!.element(p).assign(kappa);
    })().compute(CAPACITY);
    this.pixelPasses.push(pass);
    return pass;
  }

  // 帯 j の画素ごとの項を、印の立った画素で PIXELS_PER_SUM 画素ずつ足して partialSums へ書き、偽の構造の項を
  // falseStructure へ足す段(最初の帯は置く)。
  private sumPassOf(j: number): ComputeNode {
    const c = coarserOf(j);
    const pass = Fn(() => {
      const t = int(instanceIndex);
      const count = this.width.mul(this.height);
      const sums = vec4(0).toVar();
      Loop(PIXELS_PER_SUM, ({ i }) => {
        const p = t.mul(PIXELS_PER_SUM).add(i);
        const penalty = vec3(0).toVar();
        If(p.lessThan(count).and(this.input.element(p).w.greaterThan(0)), () => {
          // 構造 L_s と、雑音の強さ V_s = G_2s∗H_s² から白色雑音なら L_s が揺れる大きさ σ̃_s = sqrt(V_s·κ_s)。
          const fine = normalized(this.smooths[j % 2]!.element(p));
          const structure = j === LAST ? fine : fine.sub(normalized(this.smooths[c % 2]!.element(p)));
          const power = normalized(this.power.element(p));
          const honest = sqrt(max(power.mul(this.kappas[j]!.element(p)), 0));
          const square = structure.mul(structure);
          const honestSquare = honest.mul(honest);
          penalty.assign(max(square.sub(honestSquare), 0).div(honest.add(EPSILON)).mul(this.weights[j]!));
          // N = sqrt(G_2∗H_1²) は最も細かいスケールの V の平方根。
          const noise = j === 0 ? dot(sqrt(power), vec3(1)) : 0;
          sums.addAssign(vec4(dot(square, vec3(1)), dot(honestSquare, vec3(1)), dot(penalty, vec3(1)), noise));
        });
        const map = this.falseStructure.element(p);
        if (j === 0) map.assign(dot(penalty, vec3(1)));
        else map.addAssign(dot(penalty, vec3(1)));
      });
      this.partialSums.element(t.add(j * SEGMENTS)).assign(sums);
    })().compute(SEGMENTS);
    this.sumPasses.push(pass);
    return pass;
  }
}

// 帯ごとの和の並び partials(sumPassOf の並び)の、帯ごとに先頭 segments 個の和を、印の立った画素の数 count で指標へ。
function summaryOf(partials: Float32Array, segments: number, count: number): ErrorMeasurement {
  const bandSums = ERROR_SCALES.map((_, j) => [0, 1, 2, 3].map((k) => {
    let sum = 0;
    for (let t = j * SEGMENTS; t < j * SEGMENTS + segments; t++) sum += partials[4 * t + k]!;
    return sum;
  }));
  const noise = bandSums[0]![3]!;
  const falseStructureByScale = bandSums.map((sums) => sums[2]!);
  const falseStructure = falseStructureByScale.reduce((sum, v) => sum + v, 0);
  return {
    score: (noise + falseStructure) / count,
    noiseTerm: noise / count,
    falseStructureTerm: falseStructure / count,
    falseStructureByScale: falseStructureByScale.map((v) => v / count),
    r: bandSums.map(([structureSquare, honestSquare]) => Math.sqrt(structureSquare! / honestSquare!)),
  };
}
