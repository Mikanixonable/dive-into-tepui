// 映り込みのパス。マテリアルパスが共有の描画先へ書いた絵を縮小列にし、映り込みの判定(ScreenSpaceReflection)が
// 当たった位置の像を、鏡面ローブが当たり距離で張る円の大きさに合う段から読んで(Uludag 2014「Hi-Z Screen-Space
// Cone-Traced Reflections」)、鏡面反射率と置換の重みを掛けた像を共有の描画先へ足す。描画設定のオン / オフを受け、
// オフのフレームは描画命令を出さない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, abs, ceil, clamp, float, floor, ivec2, log2, max, min, mrt, screenSize, screenUV, select, tan, texture,
  textureLoad, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { ShadingSample } from './lighting/shading-sample';
import { specularReflectanceAt } from './material-pass';
import { compileInto } from './compile-into';
import { thicknessFarZ, viewZOf } from './screen-space/reflection-trace';
import type { ScreenSpaceReflection } from './screen-space/screen-space-reflection';
import type { GBufferPass } from './gbuffer';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node } from '../tsl-types';

// 縮小列の段数。段 0 は共有の描画先そのもので、段 k は描画画素 2^k 個四方を画素 1 つにまとめる。
// TODO: 段数は仮置き。映り込みの精細さの段と合わせて、ぼけの届く粗さと費用を実測して決め直す。
const LEVEL_COUNT = 5;
// 鏡面ローブの半幅 [rad] の、GGX の α(知覚的粗さの 2 乗)に対する比。
const LOBE_HALF_WIDTH_PER_ALPHA = 2;

// 全画面で書くマテリアル。additive を立てると、描画先へ加算で積む。
function stageMaterial(colorNode: Vec4Node, additive = false): THREE.MeshBasicNodeMaterial {
  // 加算合成は透過を明示しないと効かないので、上書きの段も含めて透過で作る。
  const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true });
  if (additive) {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
  } else {
    material.blending = THREE.NoBlending;
  }
  material.colorNode = colorNode;
  return material;
}

// 深度を持たない半精度の描画先。
function imageTarget(): THREE.RenderTarget {
  return new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
  });
}

// 縮小列の段の奥行きの描画先の名前。MRT の出力と結び付く。
const LEVEL_DEPTH = 'reflectionLevelDepth';

// view 空間の奥行き 2 つを 32bit 浮動小数で持つ描画先。読むのは textureLoad だけ。
function depthTarget(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    type: THREE.FloatType, format: THREE.RGFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  target.texture.name = LEVEL_DEPTH;
  return target;
}

// 全画面で depthTarget へ depth を書くマテリアル。色の出力を通さずに書く — 負の奥行きが色として 0 へ丸められる。
function depthMaterial(depth: Vec4Node): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
  });
  material.mrtNode = mrt({ [LEVEL_DEPTH]: depth });
  return material;
}

// 縮小列の段 1 以降の 1 段。前の段の 2 × 2 の画素を 1 つにまとめる。まとめた描画画素のうち、いちばん手前の面から
// ray thickness の奥までに収まる画素を手前の層と呼び、それより奥は段の画素が写す面の奥にある別の物体として除く。
// depthTarget は rg が手前の層のいちばん手前といちばん奥の view 空間の奥行き z、radianceTarget は rgba が手前の層の
// 放射輝度の和と画素数を、ともにまとめた描画画素の数で割ったもの。
interface ReductionLevel {
  readonly depthTarget: THREE.RenderTarget;
  readonly depthMaterial: THREE.MeshBasicNodeMaterial;
  readonly radianceTarget: THREE.RenderTarget;
  readonly radianceMaterial: THREE.MeshBasicNodeMaterial;
}

// 縮小列の 1 つの段から読んだ画素。radiance は ReductionLevel の radianceTarget の値、nearestZ / layerFarZ は手前の層の
// いちばん手前といちばん奥の view 空間の奥行き z。
interface ReducedTexel {
  readonly radiance: Vec4Node;
  readonly nearestZ: FloatNode;
  readonly layerFarZ: FloatNode;
}

export class ReflectionPass {
  // 縮小列の段 1 以降。段 k は levels[k − 1]。
  private readonly levels: readonly ReductionLevel[];
  // 共有の描画先へ足す像 R × w × I。足した後もこのフレームの値を残す。
  private readonly imageTarget = imageTarget();
  private readonly resolveMaterial: THREE.MeshBasicNodeMaterial;
  private readonly addMaterial: THREE.MeshBasicNodeMaterial;
  private readonly quad = new QuadMesh();
  // 反射する面のシェーディング入力。
  private readonly sample: ShadingSample;
  // G バッファの素の深度(逆 Z、虚空は 0)。
  private readonly depth: THREE.DepthTexture;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの射影行列とその逆は毎フレーム自前で書き込む。
  private readonly projection: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly projectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // 描画バッファの解像度 [px]。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  // 直前に render したときのオン / オフ。null はまだ render していないこと。
  private renderedEnabled: boolean | null = null;
  // 空へ戻すときに退避する消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // sharedTarget はマテリアルパスが書いた共有の描画先で、像はそこから読み、そこへ足す。reflection は映り込みの
  // 判定。enabled は構築時点の描画設定 screenSpaceSpecular の値。
  public constructor(
    private readonly renderer: WebGPURenderer, gbuffer: GBufferPass, reflection: ScreenSpaceReflection,
    private readonly sharedTarget: THREE.RenderTarget, private readonly gpu: GpuTimings, private enabled: boolean,
  ) {
    this.depth = gbuffer.depthTexture;
    const levels: ReductionLevel[] = [];
    for (let level = 1; level < LEVEL_COUNT; level++) {
      const depth = depthTarget();
      const finer = levels[level - 2] ?? null;
      levels.push({
        depthTarget: depth,
        depthMaterial: depthMaterial(this.reducedDepth(finer, level)),
        radianceTarget: imageTarget(),
        radianceMaterial: stageMaterial(this.reducedRadiance(finer, level, depth.texture)),
      });
    }
    this.levels = levels;
    this.sample = new ShadingSample(gbuffer);
    this.resolveMaterial = stageMaterial(this.image(gbuffer, reflection));
    // α を 0 で積み、共有の描画先の α を変えない。
    this.addMaterial = stageMaterial(vec4(texture(this.imageTarget.texture, screenUV).rgb, 0), true);
  }

  // このフレームに共有の描画先へ足した像。
  public get texture(): THREE.Texture { return this.imageTarget.texture; }

  // 次の render からオン / オフを enabled にする。
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // 1 フレームぶんを描く。マテリアルパスの後・大気パスの前に、描画バッファの寸法 width × height で呼ぶ。camera は
  // 当たった位置を画面へ写す行列を引き直すためだけに使う。
  public render(camera: THREE.Camera, width: number, height: number): void {
    if (this.enabled !== this.renderedEnabled && !this.enabled) this.clearImage();
    this.renderedEnabled = this.enabled;
    if (!this.enabled) return;
    this.prepare(camera, width, height);
    // 縮小列 → 像 → 加算の順に書く。どの段も、自分の描画先を読まない。
    for (const [material, target] of this.stages()) {
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = target !== this.sharedTarget;
      this.quad.material = material;
      this.gpu.beginPass(GPU_PASS.reflection);
      this.quad.render(this.renderer);
    }
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
  }

  // オンなら全段のマテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    if (!this.enabled) return;
    this.prepare(camera, width, height);
    for (const [material, target] of this.stages()) {
      this.quad.material = material;
      await compileInto(this.renderer, target, this.quad, this.quad.camera);
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで共有する単一の板
  // なので、ここでは解放しない。
  public dispose(): void {
    for (const level of this.levels) {
      level.depthTarget.dispose();
      level.depthMaterial.dispose();
      level.radianceTarget.dispose();
      level.radianceMaterial.dispose();
    }
    this.imageTarget.dispose();
    this.resolveMaterial.dispose();
    this.addMaterial.dispose();
  }

  // 描画命令の列。マテリアルとその描画先の組を、書く順に並べる。
  private stages(): readonly (readonly [THREE.MeshBasicNodeMaterial, THREE.RenderTarget])[] {
    return [
      ...this.levels.flatMap((level) => [
        [level.depthMaterial, level.depthTarget] as const,
        [level.radianceMaterial, level.radianceTarget] as const,
      ]),
      [this.resolveMaterial, this.imageTarget],
      [this.addMaterial, this.sharedTarget],
    ];
  }

  // 段 level の画素の depthTarget の値。finer は 1 つ細かい段で、段 1 では null(描画画素そのもの)。
  private reducedDepth(finer: ReductionLevel | null, level: number): Vec4Node {
    return Fn(() => {
      const children = this.childrenOf(finer, level);
      // いちばん手前は、子のいちばん手前の最大(view 空間の z は手前ほど大きい)。左上の子は必ず画面の中にある。
      const nearestZ = children.reduce<FloatNode>(
        (z, { inside, texel }) => select(inside, max(z, texel.nearestZ), z), children[0]!.texel.nearestZ,
      ).toVar();
      // 手前の層のいちばん奥は、手前の層に収まる子のいちばん奥の最小。
      const slabFarZ = thicknessFarZ(nearestZ).toVar();
      const layerFarZ = children.reduce<FloatNode>(
        (z, { inside, texel }) => select(inside.and(texel.layerFarZ.greaterThanEqual(slabFarZ)), min(z, texel.layerFarZ), z),
        nearestZ,
      );
      return vec4(nearestZ, layerFarZ, 0, 1);
    })();
  }

  // 段 level の画素の radianceTarget の値。finer は reducedDepth と同じで、depth は同じ段の depthTarget。手前の層に
  // 丸ごと収まる子だけを足す — 層をまたぐ子の手前側の画素は落ちるが、奥の物体は混ざらない。
  private reducedRadiance(finer: ReductionLevel | null, level: number, depth: THREE.Texture): Vec4Node {
    return Fn(() => {
      const slabFarZ = thicknessFarZ(textureLoad(depth, ivec2(floor(screenUV.mul(screenSize)))).r).toVar();
      return this.childrenOf(finer, level).reduce<Vec4Node>(
        (sum, { inside, texel }) => sum.add(
          select(inside.and(texel.layerFarZ.greaterThanEqual(slabFarZ)), texel.radiance, vec4(0)),
        ),
        vec4(0),
      ).mul(0.25);
    })();
  }

  // 段 level の描いている画素がまとめる、1 つ細かい段 finer の 2 × 2 の画素。inside はその画素が画面の中にあるか。
  // **Fn の中から呼ぶこと。**
  private childrenOf(
    finer: ReductionLevel | null, level: number,
  ): readonly { readonly inside: BoolNode; readonly texel: ReducedTexel }[] {
    const base = floor(screenUV.mul(screenSize)).mul(2).toVar();
    const finerSize = ceil(this.fullSize.div(2 ** (level - 1))).toVar();
    return [vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(1, 1)].map((offset) => {
      const texel = base.add(offset).toVar();
      return {
        inside: texel.x.lessThan(finerSize.x).and(texel.y.lessThan(finerSize.y)),
        texel: this.texelOf(finer, ivec2(min(texel, finerSize.sub(1)))),
      };
    });
  }

  // 画素ごとの像 R × w × I。置換の重み w が 0 の画素は 0。
  private image(gbuffer: GBufferPass, reflection: ScreenSpaceReflection): Vec4Node {
    return Fn(() => {
      const image = vec3(0).toVar();
      // 判定は面の写っている画素にだけ w を書くので、w の正の画素は面の画素。
      const weight = reflection.weightAt(screenUV).toVar();
      If(weight.greaterThan(0), () => {
        const distance = reflection.hitDistanceAt(screenUV).toVar();
        const hit = this.sample.position.add(this.sample.reflected.mul(distance)).toVar();
        const level = this.levelOf(hit, distance);
        const radiance = this.radianceAt(reflection.hitUVAt(screenUV), level, hit.z);
        image.assign(specularReflectanceAt(gbuffer, screenUV).mul(weight).mul(radiance));
      });
      return vec4(image, 1);
    })();
  }

  // 反射する面から距離 distance [m] の view 空間の点 hit で鏡面ローブが張る円を覆う縮小列の段(小数)。円の直径が
  // 段の画素 1 つに収まる段を選ぶ。
  private levelOf(hit: Vec3Node, distance: FloatNode): FloatNode {
    const alpha = this.sample.roughness.mul(this.sample.roughness);
    const radius = distance.mul(tan(alpha.mul(LOBE_HALF_WIDTH_PER_ALPHA)));
    // 当たった点と、そこから画面の横へ円の半径だけずらした点を画面へ写し、半径を画素で測る。
    const center = this.projection.mul(vec4(hit, 1));
    const edge = this.projection.mul(vec4(hit.add(vec3(radius, 0, 0)), 1));
    const radiusPixels = abs(edge.x.div(edge.w).sub(center.x.div(center.w))).mul(0.5).mul(screenSize.x);
    return clamp(log2(max(radiusPixels.mul(2), 1)), 0, LEVEL_COUNT - 1);
  }

  // 縮小列を段 level(小数)で読んだ uv の放射輝度。隣り合う 2 段を段の端数で線形に混ぜる。hitZ は当たった点の
  // view 空間の奥行きで、それより ray thickness を超えて奥の面しか写っていない段の画素は読まない — ray が当たった
  // 面の像ではない。
  private radianceAt(uv: Vec2Node, level: FloatNode, hitZ: FloatNode): Vec3Node {
    const farZ = thicknessFarZ(hitZ).toVar();
    const radiance = vec3(0).toVar();
    for (let index = 0; index < LEVEL_COUNT; index++) {
      const share = max(float(1).sub(abs(level.sub(index))), 0).toVar();
      If(share.greaterThan(0), () => {
        const covered = this.bilinearAt(uv, index, farZ);
        // 当たった画素を含む段の画素は必ず読むので、a は正。
        radiance.addAssign(covered.rgb.div(max(covered.a, 1e-6)).mul(share));
      });
    }
    return radiance;
  }

  // 段 level を uv で双線形に読んだ、手前の層の放射輝度の和と画素数(ReducedTexel の radiance)。手前の層の
  // いちばん手前が奥行き farZ より奥にある段の画素は除く。
  private bilinearAt(uv: Vec2Node, level: number, farZ: FloatNode): Vec4Node {
    // uv を囲む段の画素 4 つと、双線形の端数。段の画素は描画画素 span 個四方を覆う。
    const span = 2 ** level;
    const position = uv.mul(this.fullSize).div(span).sub(0.5).toVar();
    const base = floor(position).toVar();
    const fraction = position.sub(base).toVar();
    const size = ceil(this.fullSize.div(span)).toVar();
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
    // 画面の中にあり、手前の層が farZ より手前にある画素だけを、双線形の重みで足す。
    return corners.reduce<Vec4Node>((sum, [dx, dy]) => {
      const texel = base.add(vec2(dx, dy));
      const inside = texel.x.greaterThanEqual(0).and(texel.y.greaterThanEqual(0))
        .and(texel.x.lessThan(size.x)).and(texel.y.lessThan(size.y));
      const reduced = this.texelOf(
        level === 0 ? null : this.levels[level - 1]!, ivec2(clamp(texel, vec2(0), size.sub(1))),
      );
      const accepted = inside.and(reduced.nearestZ.greaterThanEqual(farZ));
      const weight = (dx === 0 ? fraction.x.oneMinus() : fraction.x).mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
      return sum.add(select(accepted, reduced.radiance.mul(weight), vec4(0)));
    }, vec4(0));
  }

  // 縮小列の段 level の画素 texel。level が null なら段 0 — 描画画素そのもので、手前の層はその画素だけ。
  // **Fn の中から呼ぶこと。**
  private texelOf(level: ReductionLevel | null, texel: THREE.Node<'ivec2'>): ReducedTexel {
    if (level === null) {
      const z = viewZOf(textureLoad(this.depth, texel).r, this.projectionInverse).toVar();
      return { radiance: vec4(textureLoad(this.sharedTarget.texture, texel).rgb, 1), nearestZ: z, layerFarZ: z };
    }
    const depth = textureLoad(level.depthTarget.texture, texel).toVar();
    return { radiance: textureLoad(level.radianceTarget.texture, texel), nearestZ: depth.r, layerFarZ: depth.g };
  }

  // 描画先を描画バッファの寸法へ合わせ、実カメラの行列を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    // 描画先の寸法は、変わったときだけ確保し直す。
    if (this.imageTarget.width !== width || this.imageTarget.height !== height) {
      this.imageTarget.setSize(width, height);
    }
    for (const [index, level] of this.levels.entries()) {
      const span = 2 ** (index + 1);
      const levelWidth = Math.max(1, Math.ceil(width / span));
      const levelHeight = Math.max(1, Math.ceil(height / span));
      for (const target of [level.depthTarget, level.radianceTarget]) {
        if (target.width !== levelWidth || target.height !== levelHeight) target.setSize(levelWidth, levelHeight);
      }
    }
    this.fullSize.value.set(width, height);
    this.projection.value.copy(camera.projectionMatrix);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.sample.sync(camera);
  }

  // 像を空へ戻す。残すと、切る直前の像が「映り込み」の表示に凍ったまま残る。
  private clearImage(): void {
    // 消去色はレンダラーを共有する他のパスのものなので、退避して黒の透明で消し、戻す。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.imageTarget);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }
}
