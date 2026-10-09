// 映り込みを粗さに応じて均す。均す前の映り込みを、面ごとの被覆率を掛けた和の縮小列にまとめ、受け手の画素ごとに、像の
// ぼけの短い軸の幅に合う段を、受け手の面に載る分はその段の値で、載らない分は 1 つ細かい段の値で埋めて読み、均した値を
// 書く(Stachowiak 2015「Stochastic Screen-Space Reflections」の空間方向の均し)。w × I・w・w × d を同じ重みで均すので、
// 均した後も 3 つの量のあいだの比は保たれる。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, abs, ceil, clamp, dot, float, floor, getViewPosition, ivec2, length, log2, max, min, mrt, saturate,
  screenCoordinate, screenUV, select, smoothstep, struct, tan, textureLoad, uniform, vec2, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { octDecodeNormal, type GBufferPass } from '../gbuffer';
import { specularLobeHalfWidth, specularLobeHalfWidthOf } from '../lighting/ggx';
import { ShadingSample } from '../lighting/shading-sample';
import { viewRayAt } from '../view-ray';
import { compileInto } from '../compile-into';
import { NO_REFLECTION_ROUGHNESS, rayThicknessAt } from './reflection-trace';
import { encodedDenoisedReflection, type ScreenSpaceReflection } from './screen-space-reflection';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node } from '../../tsl-types';

// 縮小列の段数。段 0 は均す前の映り込みと G バッファそのもので、段 k は描画画素 2^k 個四方を画素 1 つにまとめる。
// いちばん粗い段の画素 1 つが 4096 px 四方までの描画バッファ全体を覆う。tools/render-lab-reflection-levels.mjs が
// この行を文字列で読む。
export const REFLECTION_LEVEL_COUNT = 13;
// 当たり距離を読み始める段(描画画素 16 個四方)。
const DISTANCE_LEVEL = 4;
// 均しの広さ: 均すのに読む段の画素の一辺の、像のぼけの短い軸の幅に対する比。短い軸の幅は、鏡像の奥行きへ写した鏡面
// ローブの円の直径に N·V を掛けたもの — 斜めから見た面の映り込みは、入射面の中へはローブの半幅どおりにぼけ、入射面に
// 垂直な向きへはその約 N·V 倍しかぼけない。像のぼけは追跡の向きのジッターが縦横とも作るので、均しはまだらを消す幅でよい。
const DENOISE_WIDTH_PER_SHORT_AXIS = 1;
// 同じ面とみなす重みの区間。重みは full の側で 1、none の側で 0 で、あいだをなめらかにつなぐ — 二値の判定は、境をまたぐ
// 受け手どうしで値を跳ばす。
// 法線どうしの余弦(約 18°〜32°)。曲面の隣り合う画素を同じ面に残し、稜の向こうの面を分ける。
const SAME_SURFACE_NORMAL_COSINE = { full: 0.95, none: 0.85 } as const;
// 代表の平面までの隔たりの、点の奥行きの ray thickness に対する比。
const SAME_SURFACE_PLANE_OFFSET = { full: 0.5, none: 1 } as const;
// 鏡面ローブの半幅の差の、大きいほうの半幅に対する比。粗さが 1 割違う材質(半幅は約 2 割違う)を同じ面に残し、2 割違う
// 材質(半幅は 3 割以上違う)を分ける。
const SAME_SURFACE_LOBE_WIDTH_DIFFERENCE = { full: 0.2, none: 0.3 } as const;

// 縮小列の段の画素 1 つ。どの量も、代表の面に載る描画画素についての和を、段の画素が覆う描画画素の数で割ったもの。
// weighted は rgb = w × I の和、a = w の和。covered は x = w × d の和 [m]、y = 被覆率(代表の面に載る描画画素の割合)。
// surface は代表の面で、xy = 法線の octahedral 符号、z = 平面の原点からの距離 n·P [m](view 空間)、w = 知覚的粗さ。
// 「載る」は同じ面とみなす重みを掛けた量で、0..1 の割合で載る。
const ReflectionLevelTexel = struct(
  { weighted: 'vec4', covered: 'vec2', surface: 'vec4' }, 'ReflectionLevelTexel',
);
interface LevelTexel {
  readonly weighted: Vec4Node;
  readonly covered: Vec2Node;
  readonly surface: Vec4Node;
}

// 受け手の画素の、ある段までで均した値。weighted は rgb = (w × I)‾、a = w̄、weightedDistance は (w × d)‾ [m]。
interface DenoisedValue {
  readonly weighted: Vec4Node;
  readonly weightedDistance: FloatNode;
}

// 受け手の画素 1 つぶんの均した映り込み。weightedImage / weight / weightedDistance は (w × I)‾・w̄・(w × d)‾、level は
// 均すのに読んだ段(小数)。
const DenoisedReflection = struct(
  { weightedImage: 'vec3', weight: 'float', weightedDistance: 'float', level: 'float' }, 'DenoisedReflection',
);

// 縮小列の段の描画先のテクスチャの名前。MRT の出力と結び付く。
const LEVEL_WEIGHTED = 'reflectionLevelWeighted';
const LEVEL_COVERED = 'reflectionLevelCovered';
const LEVEL_SURFACE = 'reflectionLevelSurface';

// 縮小列の段 1 以降を詰める描画先。添付は LevelTexel の weighted・covered・surface の順で、平面の距離は km 規模の面でも
// 半精度の上限を超えないよう 32bit 浮動小数で持つ。32bit の添付はフィルタできないので、textureLoad で読むこと。
function atlasTarget(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: 3, depthBuffer: false, samples: 0, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  // 添付ごとの名前と形式。名前は MRT の出力と結び付く。
  const formats = [
    [LEVEL_WEIGHTED, THREE.RGBAFormat, THREE.HalfFloatType],
    [LEVEL_COVERED, THREE.RGFormat, THREE.HalfFloatType],
    [LEVEL_SURFACE, THREE.RGBAFormat, THREE.FloatType],
  ] as const;
  for (const [index, [name, format, type]] of formats.entries()) {
    const attachment = target.textures[index]!;
    attachment.name = name;
    attachment.format = format;
    attachment.type = type;
  }
  return target;
}

// 全画面で書くマテリアル。出力は mrtNode へ置く。
function stageMaterial(mrtNode: ReturnType<typeof mrt>): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
  });
  material.mrtNode = mrtNode;
  return material;
}

// 縮小列の段 1 以降の 1 段。段は atlas の中の矩形 viewport を占め、origin はその左上 [px]、span は段の画素 1 つが覆う
// 描画画素の一辺の数。
interface ReductionLevel {
  readonly atlas: THREE.RenderTarget;
  readonly viewport: THREE.Vector4;
  readonly origin: Vec2Uniform;
  readonly span: number;
  readonly material: THREE.MeshBasicNodeMaterial;
}

// 縮小列の段の画素がまとめる、1 つ細かい段の画素。inside はその画素が画面の中にあるか、point はその画素に写る代表の
// 面の点(view 空間)。
interface ReductionChild {
  readonly inside: BoolNode;
  readonly texel: LevelTexel;
  readonly point: Vec3Node;
}

// 双線形の 4 点の、左上の点からのずれ。
const CORNERS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;

// 点 point(view 空間)に載る、法線 normal・知覚的粗さ roughness の面を、代表の面 surface(LevelTexel の surface)と同じ
// 面とみなす重み(0..1)。法線の向き、代表の平面からの隔たり、鏡面ローブの半幅の近さの重みを掛けたもの。
// **Fn の中から呼ぶこと。**
function sameSurfaceWeight(surface: Vec4Node, point: Vec3Node, normal: Vec3Node, roughness: FloatNode): FloatNode {
  const planeNormal = octDecodeNormal(surface.xy).toVar();
  const facing = smoothstep(SAME_SURFACE_NORMAL_COSINE.none, SAME_SURFACE_NORMAL_COSINE.full, dot(planeNormal, normal));
  // 平面からの隔たりは、点の奥行きの ray thickness を目盛りに測る。
  const offset = abs(dot(planeNormal, point).sub(surface.z)).div(max(rayThicknessAt(point.z), 1e-6));
  const onPlane = float(1).sub(smoothstep(SAME_SURFACE_PLANE_OFFSET.full, SAME_SURFACE_PLANE_OFFSET.none, offset));
  // 半幅の差は、大きいほうの半幅を目盛りに測る。
  const width = specularLobeHalfWidthOf(surface.w).toVar();
  const otherWidth = specularLobeHalfWidthOf(roughness).toVar();
  const difference = abs(width.sub(otherWidth)).div(max(max(width, otherWidth), 1e-6));
  const alike = float(1).sub(smoothstep(
    SAME_SURFACE_LOBE_WIDTH_DIFFERENCE.full, SAME_SURFACE_LOBE_WIDTH_DIFFERENCE.none, difference,
  ));
  return facing.mul(onPlane).mul(alike);
}

export class ReflectionDenoise {
  // 縮小列の段 1 以降。段 k は levels[k − 1]。
  private readonly levels: readonly ReductionLevel[];
  // 段 k は atlases[k % 2] に入り、前の段を読みながら書く描画先が読む描画先と別になる。段ごとに描画先を持つと、均した
  // 値を書く描画が読むテクスチャの数が段数に比例し、WebGPU がフラグメントシェーダに保証する 16 枚を超える。
  private readonly atlases = [atlasTarget(), atlasTarget()] as const;
  // atlases の寸法 [px]。毎フレーム確保しないよう持っておく。
  private readonly atlasSizes = [new THREE.Vector2(), new THREE.Vector2()] as const;
  private readonly resolveMaterial: THREE.MeshBasicNodeMaterial;
  private readonly quad = new QuadMesh();
  // 受け手の画素のシェーディング入力。
  private readonly sample: ShadingSample;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列は毎フレーム自前で書き込む。
  private readonly projectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // 描画バッファの解像度 [px] と、縦の焦点距離 [px](view 空間の長さ × 焦点距離 / 奥行き が画面の長さ)。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  private readonly focalLength = uniform(1);

  // reflection は均す前の映り込みを読み、均した映り込みを書く先。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly reflection: ScreenSpaceReflection, private readonly gpu: GpuTimings,
  ) {
    this.sample = new ShadingSample(gbuffer);
    // 縮小列の段 1 以降を、細かい段から順に組む。段 k は段 k − 1 を読む。
    const levels: ReductionLevel[] = [];
    for (let index = 1; index < REFLECTION_LEVEL_COUNT; index++) {
      const origin: Vec2Uniform = uniform(new THREE.Vector2());
      const span = 2 ** index;
      const texel = this.reducedTexel(levels[index - 2] ?? null, origin, span);
      levels.push({
        atlas: this.atlases[index % 2]!,
        viewport: new THREE.Vector4(),
        origin,
        span,
        material: stageMaterial(mrt({
          [LEVEL_WEIGHTED]: texel.get('weighted') as Vec4Node,
          [LEVEL_COVERED]: vec4(texel.get('covered') as Vec2Node, 0, 1),
          [LEVEL_SURFACE]: texel.get('surface') as Vec4Node,
        })),
      });
    }
    this.levels = levels;
    // 均した映り込みを書くマテリアル。縮小列の全段を読む。
    const denoised = this.denoised();
    this.resolveMaterial = stageMaterial(encodedDenoisedReflection(
      denoised.get('weightedImage') as Vec3Node, denoised.get('weight') as FloatNode,
      denoised.get('weightedDistance') as FloatNode, denoised.get('level') as FloatNode,
    ));
  }

  // 1 フレームぶんを描く。均す前の映り込みを書いた後に、G バッファと同じ寸法 width × height で呼ぶ。camera からは
  // 深度から位置を復元する行列と焦点距離を引き直す。
  public render(camera: THREE.Camera, width: number, height: number): void {
    this.prepare(camera, width, height);
    // 縮小列を細かい段から書き、均した映り込みを書く。atlas は他の段の矩形を残すので、描く前に消さない。
    for (const level of this.levels) {
      level.atlas.viewport.copy(level.viewport);
      this.draw(level.material, level.atlas, false);
    }
    this.draw(this.resolveMaterial, this.reflection.denoisedTarget, true);
  }

  // 全段のマテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    this.prepare(camera, width, height);
    const stages = [
      ...this.levels.map((level) => [level.material, level.atlas] as const),
      [this.resolveMaterial, this.reflection.denoisedTarget] as const,
    ];
    for (const [material, target] of stages) {
      this.quad.material = material;
      await compileInto(this.renderer, target, this.quad, this.quad.camera);
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    for (const level of this.levels) level.material.dispose();
    for (const atlas of this.atlases) atlas.dispose();
    this.resolveMaterial.dispose();
  }

  // material の全画面の板を target へ描く。clear が偽なら、描画先のいまの中身を残して上から描く。
  private draw(material: THREE.MeshBasicNodeMaterial, target: THREE.RenderTarget, clear: boolean): void {
    this.renderer.setRenderTarget(target);
    this.renderer.autoClear = clear;
    this.quad.material = material;
    this.gpu.beginPass(GPU_PASS.reflection);
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;
  }

  // 縮小列の段の画素(ReflectionLevelTexel)。finer は 1 つ細かい段で、段 1 では null(段 0)。origin は書く段の矩形の
  // 左上、span は書く段の画素 1 つが覆う描画画素の一辺の数。
  private reducedTexel(finer: ReductionLevel | null, origin: Vec2Uniform, span: number): THREE.Node {
    return Fn(() => {
      const children = this.childrenOf(finer, origin, span);
      // 代表の面は、被覆率のいちばん大きい子の面。同じなら手前の子の面。左上の子は必ず画面の中にある。
      const surface = children[0]!.texel.surface.toVar();
      const coverage = children[0]!.texel.covered.y.toVar();
      const nearestZ = children[0]!.point.z.toVar();
      for (const child of children.slice(1)) {
        const childCoverage = child.texel.covered.y;
        const nearer = childCoverage.equal(coverage).and(child.point.z.greaterThan(nearestZ));
        If(child.inside.and(childCoverage.greaterThan(coverage).or(nearer)), () => {
          surface.assign(child.texel.surface);
          coverage.assign(childCoverage);
          nearestZ.assign(child.point.z);
        });
      }
      // 子を、代表の面に載る重みを掛けて足し、段の画素が覆う描画画素の数で割る。
      const weighted = vec4(0).toVar();
      const covered = vec2(0).toVar();
      for (const child of children) {
        If(child.inside, () => {
          const childNormal = octDecodeNormal(child.texel.surface.xy);
          const share = sameSurfaceWeight(surface, child.point, childNormal, child.texel.surface.w).toVar();
          weighted.addAssign(child.texel.weighted.mul(share));
          covered.addAssign(child.texel.covered.mul(share));
        });
      }
      return ReflectionLevelTexel(weighted.mul(0.25), covered.mul(0.25), surface);
    })();
  }

  // 書く段の描いている画素がまとめる、1 つ細かい段 finer の 2 × 2 の画素。origin と span は reducedTexel と同じ。
  // **Fn の中から呼ぶこと。**
  private childrenOf(finer: ReductionLevel | null, origin: Vec2Uniform, span: number): readonly ReductionChild[] {
    // 描いている画素の、矩形の中の位置の 2 倍が左上の子。細かい段の端の画素は画面の外へはみ出しうる。
    const base = floor(screenCoordinate).sub(origin).mul(2).toVar();
    const finerSize = ceil(this.fullSize.div(span / 2)).toVar();
    return CORNERS.map(([dx, dy]) => {
      const texel = base.add(vec2(dx, dy)).toVar();
      const clamped = min(texel, finerSize.sub(1)).toVar();
      return {
        inside: texel.x.lessThan(finerSize.x).and(texel.y.lessThan(finerSize.y)),
        ...(finer === null ? this.drawnChildAt(clamped) : this.reducedChildAt(finer, clamped)),
      };
    });
  }

  // 段 0 の画素 texel(描画画素そのもの)。代表の面はその画素に写る面で、面が写っていれば被覆率は 1。
  // **Fn の中から呼ぶこと。**
  private drawnChildAt(texel: Vec2Node): Omit<ReductionChild, 'inside'> {
    // 画素に写る面の点・法線・粗さ。
    const pixel = ivec2(texel);
    const depth = textureLoad(this.gbuffer.depthTexture, pixel).r.toVar();
    const uv = texel.add(0.5).div(this.fullSize).toVar();
    const point = getViewPosition(uv, depth, this.projectionInverse).toVar();
    const normalCode = textureLoad(this.gbuffer.normalTexture, pixel).rg.toVar();
    const roughness = textureLoad(this.gbuffer.roughnessTexture, pixel).r;
    // 量は均す前の映り込みそのもの。面が写っていない画素は被覆率 0。
    const coverage = select(depth.greaterThan(0), float(1), float(0));
    return {
      texel: {
        weighted: vec4(this.reflection.rawWeightedImageAt(uv), this.reflection.rawWeightAt(uv)),
        covered: vec2(this.reflection.rawWeightedDistanceAt(uv), coverage),
        surface: vec4(normalCode, dot(octDecodeNormal(normalCode), point), roughness),
      },
      point,
    };
  }

  // 段 1 以降の段 level の画素 texel。その画素の点は、画素の中心を通る視線と代表の平面の交点。**Fn の中から呼ぶこと。**
  private reducedChildAt(level: ReductionLevel, texel: Vec2Node): Omit<ReductionChild, 'inside'> {
    const read = this.levelTexelAt(level, texel);
    const ray = viewRayAt(this.projectionInverse, texel.add(0.5).mul(level.span).div(this.fullSize));
    const normal = octDecodeNormal(read.surface.xy).toVar();
    // 視線が平面とほぼ平行な画素では、交点を有限の遠い点に留める。
    const along = dot(normal, ray.direction).toVar();
    const safeAlong = select(along.greaterThanEqual(0), max(along, 1e-6), min(along, -1e-6));
    const reach = read.surface.z.sub(dot(normal, ray.origin)).div(safeAlong);
    return { texel: read, point: ray.origin.add(ray.direction.mul(reach)).toVar() };
  }

  // 段 1 以降の段 level の画素 texel の値。**Fn の中から呼ぶこと。**
  private levelTexelAt(level: ReductionLevel, texel: Vec2Node): LevelTexel {
    const [weighted, covered, surface] = level.atlas.textures;
    const atlasTexel = ivec2(texel.add(level.origin)).toVar();
    return {
      weighted: textureLoad(weighted!, atlasTexel).toVar(),
      covered: textureLoad(covered!, atlasTexel).rg.toVar(),
      surface: textureLoad(surface!, atlasTexel).toVar(),
    };
  }

  // 受け手の画素の均した映り込み(DenoisedReflection)。段 0 から順に、受け手の面に載らない分を 1 つ細かい段の値で埋めた
  // 値を求め、段 DISTANCE_LEVEL から粗い段へ、最初に w̄ が正になった段の (w × d)‾ / w̄ を当たり距離にして均す段を選び、
  // 選んだ段の両隣を段の端数で混ぜる。どの段でも w̄ が 0 の画素、面の写っていない画素、映り込みの出ない粗さの画素は 0。
  private denoised(): THREE.Node {
    return Fn(() => {
      const weighted = vec4(0).toVar();
      const weightedDistance = float(0).toVar();
      // 均す段。当たり距離が決まるまでは −1。
      const selected = float(-1).toVar();
      If(this.gbuffer.covered().and(this.sample.roughness.lessThan(NO_REFLECTION_ROUGHNESS)), () => {
        // 段ごとの埋めた値。段 0 は受け手の画素そのもの。混ぜる 2 段は必ず求めてある。
        const filled: DenoisedValue[] = [{
          weighted: vec4(this.reflection.rawWeightedImageAt(screenUV), this.reflection.rawWeightAt(screenUV)).toVar(),
          weightedDistance: this.reflection.rawWeightedDistanceAt(screenUV).toVar(),
        }];
        for (let index = 1; index < REFLECTION_LEVEL_COUNT; index++) {
          const value: DenoisedValue = { weighted: vec4(0).toVar(), weightedDistance: float(0).toVar() };
          const finer = filled[index - 1]!;
          filled.push(value);
          // 当たり距離を探すあいだと、選んだ段の 1 つ上までの段を求める。
          const fill = (): void => {
            const next = this.filledAt(this.levels[index - 1]!, finer);
            value.weighted.assign(next.weighted);
            value.weightedDistance.assign(next.weightedDistance);
          };
          if (index <= DISTANCE_LEVEL) fill();
          else If(selected.lessThan(0).or(selected.greaterThanEqual(index - 1)), fill);
          // 当たり距離が決まったら、均す段を選ぶ。
          if (index < DISTANCE_LEVEL) continue;
          If(selected.lessThan(0).and(value.weighted.a.greaterThan(0)), () => {
            selected.assign(this.levelOf(value.weightedDistance.div(value.weighted.a)));
          });
        }
        // 選んだ段の両隣を、段の端数の tent の重みで混ぜる。
        for (const [index, value] of filled.entries()) {
          const share = max(float(1).sub(abs(selected.sub(index))), 0).toVar();
          If(share.greaterThan(0), () => {
            weighted.addAssign(value.weighted.mul(share));
            weightedDistance.addAssign(value.weightedDistance.mul(share));
          });
        }
      });
      return DenoisedReflection(weighted.rgb, weighted.a, weightedDistance, max(selected, 0));
    })();
  }

  // 段 level の、受け手の画素の埋めた値。段 level を受け手の画素の中心で双線形に読み、受け手の面に載る分はその段の値を、
  // 載らない分と画面の外の分は 1 つ細かい段の埋めた値 finer を使う。**Fn の中から呼ぶこと。**
  private filledAt(level: ReductionLevel, finer: DenoisedValue): DenoisedValue {
    // 受け手の画素の中心を囲む段の画素 4 つと、双線形の端数。
    const position = screenUV.mul(this.fullSize).div(level.span).sub(0.5).toVar();
    const base = floor(position).toVar();
    const fraction = position.sub(base).toVar();
    const size = ceil(this.fullSize.div(level.span)).toVar();
    // 画面の中の画素を、双線形の重みと受け手の面に載る重みを掛けて足す。段の値は被覆率を掛けた和なので、足した被覆率が
    // 受け手の画素のうち段の値で埋まった割合になる。
    const weighted = vec4(0).toVar();
    const covered = vec2(0).toVar();
    for (const [dx, dy] of CORNERS) {
      const texel = base.add(vec2(dx, dy)).toVar();
      const inside = texel.x.greaterThanEqual(0).and(texel.y.greaterThanEqual(0))
        .and(texel.x.lessThan(size.x)).and(texel.y.lessThan(size.y));
      If(inside, () => {
        const read = this.levelTexelAt(level, texel);
        const bilinear = (dx === 0 ? fraction.x.oneMinus() : fraction.x)
          .mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
        const share = bilinear
          .mul(sameSurfaceWeight(read.surface, this.sample.position, this.sample.normal, this.sample.roughness))
          .toVar();
        weighted.addAssign(read.weighted.mul(share));
        covered.addAssign(read.covered.mul(share));
      });
    }
    // 埋まらなかった割合を、細かい段の値で埋める。
    const remainder = saturate(float(1).sub(covered.y)).toVar();
    return {
      weighted: weighted.add(finer.weighted.mul(remainder)),
      weightedDistance: covered.x.add(finer.weightedDistance.mul(remainder)),
    };
  }

  // 受け手の画素を均す段(小数)。当たり距離 distance [m] で鏡面ローブが張る円を、受け手から見た鏡像の奥行きへ置いて
  // 画面へ写し、その直径に N·V を掛けた像のぼけの短い軸の幅の DENOISE_WIDTH_PER_SHORT_AXIS 倍が、段の画素 1 つの一辺に
  // なる段を選ぶ。
  private levelOf(distance: FloatNode): FloatNode {
    const position = this.sample.position;
    const range = length(position).toVar();
    // 鏡像は視線の延長上、視点から |P| + d の所にある。
    const mirrorDepth = position.z.negate().mul(range.add(distance)).div(range);
    const diameter = distance.mul(tan(specularLobeHalfWidth(this.sample))).mul(this.focalLength).div(mirrorDepth).mul(2);
    // 視線が面に寝て N·V が 0 以下へ落ちる画素は、段 0 で止まる。
    const shortAxis = diameter.mul(dot(this.sample.normal, this.sample.viewDir));
    return clamp(log2(max(shortAxis.mul(DENOISE_WIDTH_PER_SHORT_AXIS), 1)), 0, REFLECTION_LEVEL_COUNT - 1);
  }

  // 段を atlas の矩形へ並べ、描画先と実カメラの値を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    // 段を atlas の上端に横へ並べる。atlas の幅は並べた段の幅の和、高さはいちばん細かい段の高さ。
    for (const size of this.atlasSizes) size.set(0, 0);
    for (const [index, level] of this.levels.entries()) {
      const atlasSize = this.atlasSizes[(index + 1) % 2]!;
      const levelWidth = Math.max(1, Math.ceil(width / level.span));
      const levelHeight = Math.max(1, Math.ceil(height / level.span));
      level.viewport.set(atlasSize.x, 0, levelWidth, levelHeight);
      level.origin.value.set(atlasSize.x, 0);
      atlasSize.set(atlasSize.x + levelWidth, Math.max(atlasSize.y, levelHeight));
    }
    for (const [index, atlas] of this.atlases.entries()) {
      const { x, y } = this.atlasSizes[index]!;
      if (atlas.width !== x || atlas.height !== y) atlas.setSize(x, y);
    }
    // 実カメラの値。縦の焦点距離は、射影行列の縦の倍率に画面の高さの半分を掛けたもの。
    this.fullSize.value.set(width, height);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.focalLength.value = camera.projectionMatrix.elements[5]! * height / 2;
    this.sample.sync(camera);
  }
}
