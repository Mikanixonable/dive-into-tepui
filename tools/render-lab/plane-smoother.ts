// 描画テスト環境の絵と同じ寸法の平面を GPU で均す。面の画素の中で正規化したガウス、区画ごとに区画の画素の中で正規化した
// ガウス、面の幾何の重みを付けた疎なタップの joint bilateral と、粗い走査の平面から面の幾何の重みで 1 つを選ぶ確率的な拡大。
// ガウスは半径 3σ で打ち切り、画像の外は面・区画の外とする。
import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, Loop, clamp, dot, exp, exp2, float, floor, instanceIndex, int, length, max, select, storage, uniform, vec2,
  vec4,
} from 'three/tsl';
import { BLUE_NOISE_TILE_BASE64, BLUE_NOISE_TILE_SIZE } from '../../src/render/blue-noise-tile.generated';
import { VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import type { ComputeNode, StorageBufferNode } from 'three/webgpu';
import type { FloatNode, Vec3Node } from '../../src/render/tsl-types';

// 平面の画素数。
const PIXELS = VIEW_WIDTH * VIEW_HEIGHT;
// 区画ごとのガウスの 1 回の dispatch が足すタップの数の上限。長い dispatch は GPU のタイムアウト(Windows の TDR、2 秒)で
// 装置ごと落ちる。
const TAPS_PER_DISPATCH = 2 ** 26;
// 疎なタップの本数(中心を含む)と、タップを置く螺旋の黄金角。
const SPARSE_TAP_COUNT = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// 面の重みが半分になる法線の角と、値を出す重みの和の下限。
const HALF_WEIGHT_NORMAL_ANGLE = Math.PI / 6;
const WEIGHT_EPSILON = 1e-6;
// 確率的な拡大が 1 つを選ぶ、全解像度の画素の中心を囲む 2×2 の走査の画素の並び。
const UPSCALE_TAPS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
// ブルーノイズのタイルの、左上から行優先の 0..255。
const BLUE_NOISE_TILE = Uint8Array.from(atob(BLUE_NOISE_TILE_BASE64), (c) => c.charCodeAt(0));

// 画素ごとの面の幾何。position はビュー空間の位置 [m]、normal は単位法線(どちらも画素ごとに 3 つ)、footprint は画素 1 つの
// 幅 [m](面の無い画素は 0)。
export interface SurfaceGeometry {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly footprint: Float32Array;
}

// 画素ごとに type の値を 1 つ持つ平面。
const ITEM_SIZES = { float: 1, vec2: 2, vec4: 4 } as const;
const planeOf = <T extends keyof typeof ITEM_SIZES>(type: T): StorageBufferNode<T> => storage(
  new StorageBufferAttribute(PIXELS, ITEM_SIZES[type]), type, PIXELS,
);

export class PlaneSmoother {
  // 面の中のガウスの、面の印 M を掛けた値と印 (M·f, M) と、それを行だけ畳み込んだ途中の値。
  private readonly masked = planeOf('vec2');
  private readonly rows = planeOf('vec2');
  // 区画ごとのガウスの値と、画素ごとの区画の番号(区画の無い画素は負)。
  private readonly values = planeOf('float');
  private readonly segments = storage(new StorageBufferAttribute(new Int32Array(PIXELS), 1), 'int', PIXELS);
  // どちらのガウスも、均した値をここへ書く。
  private readonly blurred = planeOf('float');
  // ガウスの半径 [画素](3σ の切り上げ)と、指数の係数 −1/(2σ²) [画素⁻²]。
  private readonly radius = uniform(0, 'int');
  private readonly falloff = uniform(0);
  // 区画ごとのガウスの dispatch が受け持つ最初の画素。
  private readonly first = uniform(0, 'int');
  // joint bilateral と確率的な拡大の入力の rgb、面の位置と画素の幅 (position, footprint)、法線、出力の rgb。
  private readonly colors = planeOf('vec4');
  private readonly positions = planeOf('vec4');
  private readonly normals = planeOf('vec4');
  private readonly smoothed = planeOf('vec4');
  // ブルーノイズのタイルのテクセルごとの、SPARSE_TAP_COUNT 本のタップのずれ [画素]。
  private readonly tapOffsets = storage(
    new StorageBufferAttribute(BLUE_NOISE_TILE.length * SPARSE_TAP_COUNT, 2), 'vec2',
    BLUE_NOISE_TILE.length * SPARSE_TAP_COUNT,
  );
  // ブルーノイズのタイルのテクセルごとの (0, 1) の一様な値。
  private readonly blueNoise = storage(
    new StorageBufferAttribute(Float32Array.from(BLUE_NOISE_TILE, (v) => (v + 0.5) / 256), 1), 'float',
    BLUE_NOISE_TILE.length,
  );
  // 確率的な拡大の、走査の画素 1 つが覆う全解像度の画素の一辺。
  private readonly block = uniform(1, 'int');
  private readonly rowPass = this.surfaceLinePassOf('row');
  private readonly columnPass = this.surfaceLinePassOf('column');
  private readonly segmentPass = this.segmentPassOf();
  private readonly bilateralPass = this.bilateralPassOf();
  private readonly stochasticUpscalePass = this.stochasticUpscalePassOf();

  private constructor(private readonly renderer: WebGPURenderer) {}

  // 自前のレンダラで組む。
  public static async create(): Promise<PlaneSmoother> {
    const renderer = new WebGPURenderer();
    await renderer.init();
    return new PlaneSmoother(renderer);
  }

  // 平面 values(画素ごとに 1 つ)を、面の画素 surface(画素ごとに 0 か 1)の値だけで、面の画素全体で正規化した標準偏差
  // sigma [画素] のガウスで均した平面。面の無い画素は 0。
  public async surfaceBlur(values: Float32Array, surface: Uint8Array, sigma: number): Promise<Float32Array> {
    const masked = this.masked.value.array as Float32Array;
    for (let p = 0; p < PIXELS; p++) {
      masked[2 * p] = surface[p]! * values[p]!;
      masked[2 * p + 1] = surface[p]!;
    }
    this.masked.value.needsUpdate = true;
    this.setGaussian(sigma);
    this.renderer.compute([this.rowPass, this.columnPass]);
    return new Float32Array(await this.renderer.getArrayBufferAsync(this.blurred.value));
  }

  // 平面 values(画素ごとに 1 つ)を、区画 segments(画素ごとの区画の番号。区画の無い画素は負)ごとに、同じ区画の画素だけで
  // 正規化した標準偏差 sigma [画素] のガウスで均した平面。区画の無い画素は 0。
  public async segmentBlur(values: Float32Array, segments: Int32Array, sigma: number): Promise<Float32Array> {
    (this.values.value.array as Float32Array).set(values);
    this.values.value.needsUpdate = true;
    (this.segments.value.array as Int32Array).set(segments);
    this.segments.value.needsUpdate = true;
    const radius = this.setGaussian(sigma);
    const pixelsPerDispatch = Math.max(1, Math.floor(TAPS_PER_DISPATCH / (2 * radius + 1) ** 2));
    for (let first = 0; first < PIXELS; first += pixelsPerDispatch) {
      this.first.value = first;
      this.segmentPass.count = Math.min(pixelsPerDispatch, PIXELS - first);
      this.renderer.compute(this.segmentPass);
    }
    return new Float32Array(await this.renderer.getArrayBufferAsync(this.blurred.value));
  }

  // rgb(画素ごとに 3 つ)を、面の幾何 geometry の重みを付けた疎なタップで均した rgb(画素ごとに 3 つ)。タップは半径 radius
  // [画素] の円盤に黄金角の螺旋で置いた SPARSE_TAP_COUNT 本(中心を含む)を、画素ごとにブルーノイズ(タイルのずれ shift
  // [テクセル])の角で回して最も近い画素へ丸め、画像の端へ寄せたもの。受け手 p に対するタップ t の重みは
  // 2^−(接平面からの距離² + 法線の曲がり²) で、距離は p の画素の幅の max(1, タップの距離 [画素]) 倍で測る。面の無い画素と、
  // 重みの和が WEIGHT_EPSILON 以下の画素は 0。
  public async sparseBilateral(
    rgb: Float32Array, geometry: SurfaceGeometry, radius: number, shift: readonly [number, number],
  ): Promise<Float32Array> {
    this.setColors(rgb);
    this.setGeometry(geometry);
    this.writeTapOffsets(radius, shift);
    this.renderer.compute(this.bilateralPass);
    return this.takeSmoothed();
  }

  // 走査の rgb scan(全解像度の 1/block の解像度で、画素ごとに 3 つ)を全解像度へ拡大した rgb(画素ごとに 3 つ)。全解像度の
  // 画素ごとに、その中心を囲む 2×2 の走査の画素から、双線形の重み × 走査の画素が表す全解像度の画素の面の重み(面の幾何
  // geometry による 2^−(接平面からの距離 [画素の幅]² + 法線の曲がり²))を確率として 1 つを選び、その値を写す。確率を引く
  // 乱数は画素ごとのブルーノイズ(タイルのずれなし)。面の無い画素と、重みの和が WEIGHT_EPSILON 以下の画素は 0。
  public async stochasticUpscale(scan: Float32Array, geometry: SurfaceGeometry, block: number): Promise<Float32Array> {
    const scanPixels = (VIEW_WIDTH / block) * (VIEW_HEIGHT / block);
    if (scan.length !== 3 * scanPixels) {
      throw new Error(`stochasticUpscale: ${scan.length / 3} scan pixels, expected ${scanPixels}`);
    }
    this.setColors(scan);
    this.setGeometry(geometry);
    this.block.value = block;
    this.renderer.compute(this.stochasticUpscalePass);
    return this.takeSmoothed();
  }

  // rgb(画素ごとに 3 つ)を colors の先頭へ置く。
  private setColors(rgb: Float32Array): void {
    const colors = this.colors.value.array as Float32Array;
    for (let p = 0; p < rgb.length / 3; p++) {
      for (let k = 0; k < 3; k++) colors[4 * p + k] = rgb[3 * p + k]!;
    }
    this.colors.value.needsUpdate = true;
  }

  // 面の幾何 geometry を positions と normals へ置く。
  private setGeometry(geometry: SurfaceGeometry): void {
    const positions = this.positions.value.array as Float32Array;
    const normals = this.normals.value.array as Float32Array;
    for (let p = 0; p < PIXELS; p++) {
      for (let k = 0; k < 3; k++) {
        positions[4 * p + k] = geometry.position[3 * p + k]!;
        normals[4 * p + k] = geometry.normal[3 * p + k]!;
      }
      positions[4 * p + 3] = geometry.footprint[p]!;
    }
    for (const plane of [this.positions, this.normals]) plane.value.needsUpdate = true;
  }

  // smoothed の rgb(画素ごとに 3 つ)。
  private async takeSmoothed(): Promise<Float32Array> {
    const smoothed = new Float32Array(await this.renderer.getArrayBufferAsync(this.smoothed.value));
    return Float32Array.from({ length: 3 * PIXELS }, (_, i) => smoothed[4 * Math.floor(i / 3) + (i % 3)]!);
  }

  // 標準偏差 sigma [画素] のガウスを uniform へ置き、その半径 [画素] を返す。
  private setGaussian(sigma: number): number {
    const radius = Math.ceil(3 * sigma);
    this.radius.value = radius;
    this.falloff.value = -1 / (2 * sigma * sigma);
    return radius;
  }

  // タイルのテクセルごとの疎なタップのずれを tapOffsets へ置く。
  private writeTapOffsets(radius: number, [shiftX, shiftY]: readonly [number, number]): void {
    const offsets = this.tapOffsets.value.array as Float32Array;
    const size = BLUE_NOISE_TILE_SIZE;
    for (let texel = 0; texel < BLUE_NOISE_TILE.length; texel++) {
      const [x, y] = [texel % size, Math.floor(texel / size)];
      const noise = (BLUE_NOISE_TILE[((y + shiftY) % size) * size + (x + shiftX) % size]! + 0.5) / 256;
      const rotation = 2 * Math.PI * noise;
      // シェーダの単精度で求めると、丸めの境の近くのタップが倍精度で求めたものと 1 画素ずれる。
      for (let i = 0; i < SPARSE_TAP_COUNT; i++) {
        const [rho, theta] = [radius * Math.sqrt(i / (SPARSE_TAP_COUNT - 1)), i * GOLDEN_ANGLE + rotation];
        offsets[2 * (texel * SPARSE_TAP_COUNT + i)] = Math.round(rho * Math.cos(theta));
        offsets[2 * (texel * SPARSE_TAP_COUNT + i) + 1] = Math.round(rho * Math.sin(theta));
      }
    }
    this.tapOffsets.value.needsUpdate = true;
  }

  // 面の中のガウスの、軸 axis に沿って畳み込む段。行の段は masked を rows へ、列の段は rows を畳み込み、面の画素で比をとって
  // blurred へ書く。
  private surfaceLinePassOf(axis: 'row' | 'column'): ComputeNode {
    const [source, stride, extent] = axis === 'row'
      ? [this.masked, 1, VIEW_WIDTH] : [this.rows, VIEW_WIDTH, VIEW_HEIGHT];
    return Fn(() => {
      const p = int(instanceIndex).toVar();
      const along = (axis === 'row' ? p.mod(VIEW_WIDTH) : p.div(VIEW_WIDTH)).toVar();
      const sum = vec2(0).toVar();
      Loop({ start: this.radius.negate(), end: this.radius, type: 'int', condition: '<=' }, ({ i }) => {
        If(along.add(i).greaterThanEqual(0).and(along.add(i).lessThan(extent)), () => {
          sum.addAssign(source.element(p.add(i.mul(stride))).mul(exp(float(i.mul(i)).mul(this.falloff))));
        });
      });
      if (axis === 'row') this.rows.element(p).assign(sum);
      else this.blurred.element(p).assign(select(this.masked.element(p).y.greaterThan(0), sum.x.div(sum.y), 0));
    })().compute(PIXELS);
  }

  // 区画ごとのガウスの段。画素 first から count 画素を受け持つ。
  private segmentPassOf(): ComputeNode {
    return Fn(() => {
      const p = this.first.add(int(instanceIndex)).toVar();
      const segment = this.segments.element(p).toVar();
      const blurred = float(0).toVar();
      If(segment.greaterThanEqual(0), () => {
        const [x, y] = [p.mod(VIEW_WIDTH).toVar(), p.div(VIEW_WIDTH).toVar()];
        const side = this.radius.mul(2).add(1).toVar();
        // 窓の中の同じ区画の画素で (Σ g·f, Σ g) を足す。入れ子の Loop は添字が同名で化けるので、窓を 1 本のループで回す。
        const sums = vec2(0).toVar();
        Loop({ start: 0, end: side.mul(side), type: 'int' }, ({ i }) => {
          const [dx, dy] = [i.mod(side).sub(this.radius).toVar(), i.div(side).sub(this.radius).toVar()];
          const [qx, qy] = [x.add(dx), y.add(dy)];
          const inImage = qx.greaterThanEqual(0).and(qx.lessThan(VIEW_WIDTH))
            .and(qy.greaterThanEqual(0)).and(qy.lessThan(VIEW_HEIGHT));
          If(inImage, () => {
            const q = qy.mul(VIEW_WIDTH).add(qx).toVar();
            If(this.segments.element(q).equal(segment), () => {
              const weight = exp(float(dx.mul(dx).add(dy.mul(dy))).mul(this.falloff));
              sums.addAssign(vec2(this.values.element(q), 1).mul(weight));
            });
          });
        });
        blurred.assign(sums.x.div(sums.y));
      });
      this.blurred.element(p).assign(blurred);
    })().compute(PIXELS);
  }

  // 疎なタップの joint bilateral の段。
  private bilateralPassOf(): ComputeNode {
    return Fn(() => {
      const p = int(instanceIndex).toVar();
      const receiver = this.positions.element(p).toVar();
      const smoothed = vec4(0).toVar();
      If(receiver.w.greaterThan(0), () => {
        const [x, y] = [p.mod(VIEW_WIDTH).toVar(), p.div(VIEW_WIDTH).toVar()];
        const pixel = vec2(float(x), float(y)).toVar();
        const texel = y.mod(BLUE_NOISE_TILE_SIZE).mul(BLUE_NOISE_TILE_SIZE).add(x.mod(BLUE_NOISE_TILE_SIZE)).toVar();
        const normal = this.normals.element(p).xyz.toVar();
        // 画素が落ちるタイルのテクセルのずれでタップを置き、面のあるタップで (Σ w·rgb, Σ w) を足す。
        const sums = vec4(0).toVar();
        Loop(SPARSE_TAP_COUNT, ({ i }) => {
          const offset = this.tapOffsets.element(texel.mul(SPARSE_TAP_COUNT).add(i));
          const target = clamp(pixel.add(offset), vec2(0), vec2(VIEW_WIDTH - 1, VIEW_HEIGHT - 1)).toVar();
          const t = int(target.y).mul(VIEW_WIDTH).add(int(target.x)).toVar();
          const tap = this.positions.element(t).toVar();
          If(tap.w.greaterThan(0), () => {
            const tolerance = max(length(target.sub(pixel)), 1);
            const weight = surfaceWeightOf(
              receiver.xyz, normal, receiver.w.mul(tolerance), tap.xyz, this.normals.element(t).xyz,
            );
            sums.addAssign(vec4(this.colors.element(t).xyz, 1).mul(weight));
          });
        });
        If(sums.w.greaterThan(WEIGHT_EPSILON), () => {
          smoothed.assign(vec4(sums.xyz.div(sums.w), 0));
        });
      });
      this.smoothed.element(p).assign(smoothed);
    })().compute(PIXELS);
  }

  // 確率的な拡大の段。走査は colors の先頭に行優先で並ぶ。
  private stochasticUpscalePassOf(): ComputeNode {
    return Fn(() => {
      const p = int(instanceIndex).toVar();
      const receiver = this.positions.element(p).toVar();
      const upscaled = vec4(0).toVar();
      If(receiver.w.greaterThan(0), () => {
        const [x, y] = [p.mod(VIEW_WIDTH).toVar(), p.div(VIEW_WIDTH).toVar()];
        const normal = this.normals.element(p).xyz.toVar();
        const block = this.block;
        const [scanWidth, scanHeight] = [int(VIEW_WIDTH).div(block).toVar(), int(VIEW_HEIGHT).div(block).toVar()];
        // 画素の中心を、走査の画素の中心が整数に来る座標で表し、囲む 2×2 の左上と双線形の端数へ分ける。
        const u = float(x).add(0.5).div(float(block)).sub(0.5).toVar();
        const v = float(y).add(0.5).div(float(block)).sub(0.5).toVar();
        const [u0, v0] = [floor(u).toVar(), floor(v).toVar()];
        const [fu, fv] = [u.sub(u0).toVar(), v.sub(v0).toVar()];
        const taps = UPSCALE_TAPS.map(([dx, dy]) => {
          const sx = int(clamp(u0.add(dx), 0, float(scanWidth).sub(1))).toVar();
          const sy = int(clamp(v0.add(dy), 0, float(scanHeight).sub(1))).toVar();
          // 走査の画素が表す全解像度の画素。
          const t = sy.mul(block).add(block.div(2)).mul(VIEW_WIDTH).add(sx.mul(block).add(block.div(2))).toVar();
          const tap = this.positions.element(t).toVar();
          const bilinear = (dx === 1 ? fu : fu.oneMinus()).mul(dy === 1 ? fv : fv.oneMinus());
          const surface = surfaceWeightOf(receiver.xyz, normal, receiver.w, tap.xyz, this.normals.element(t).xyz);
          return {
            scan: sy.mul(scanWidth).add(sx).toVar(),
            weight: select(tap.w.greaterThan(0), bilinear.mul(surface), 0).toVar(),
          };
        });
        const total = float(0).toVar();
        for (const tap of taps) total.addAssign(tap.weight);
        If(total.greaterThan(WEIGHT_EPSILON), () => {
          // 重みの累積が、画素のブルーノイズ × 重みの和を初めて超えた走査の画素を選ぶ。
          const texel = y.mod(BLUE_NOISE_TILE_SIZE).mul(BLUE_NOISE_TILE_SIZE).add(x.mod(BLUE_NOISE_TILE_SIZE));
          const threshold = this.blueNoise.element(texel).mul(total).toVar();
          const cumulative = float(0).toVar();
          const chosen = int(-1).toVar();
          for (const tap of taps) {
            cumulative.addAssign(tap.weight);
            If(chosen.lessThan(0).and(cumulative.greaterThan(threshold)), () => {
              chosen.assign(tap.scan);
            });
          }
          upscaled.assign(vec4(this.colors.element(chosen).xyz, 0));
        });
      });
      this.smoothed.element(p).assign(upscaled);
    })().compute(PIXELS);
  }
}

// 受け手(位置 position [m]・単位法線 normal)に対する、位置 tapPosition・単位法線 tapNormal の面の重み
// 2^−((接平面からの距離 / scale)² + 法線の曲がり²)。scale [m] は距離を測る長さ、曲がりは法線の角が
// HALF_WEIGHT_NORMAL_ANGLE で 1。
function surfaceWeightOf(
  position: Vec3Node, normal: Vec3Node, scale: FloatNode, tapPosition: Vec3Node, tapNormal: Vec3Node,
): FloatNode {
  const plane = dot(normal, tapPosition.sub(position)).div(scale);
  const bend = float(1).sub(dot(normal, tapNormal)).div(1 - Math.cos(HALF_WEIGHT_NORMAL_ANGLE));
  return exp2(plane.mul(plane).add(bend.mul(bend)).negate());
}
