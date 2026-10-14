// フレーム番号の進み方と履歴の上限を求め、近傍拡散補正を時間方向に蓄積する。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { Fn, floor, ivec2, mrt, screenSize, screenUV, texture, textureLoad, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { compileInto } from '../compile-into';
import { multiOutputMaterial, stageMaterial, type ScreenSpaceStage } from './screen-space-stage';
import type { DiffuseCorrection } from './diffuse-correction';
import type { GBufferPass } from '../gbuffer';
import type { FloatNode, FloatUniform, Vec2Node } from '../../tsl-types';

// 履歴と前フレームの深度・法線を、それぞれの形式の添付先へまとめる。
function targetOf(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: 3, depthBuffer: false, samples: 0, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const [history, depth, normal] = target.textures;
  history!.name = 'diffuseCorrectionHistory';
  history!.format = THREE.RGBAFormat;
  history!.type = THREE.HalfFloatType;
  depth!.name = 'previousDepth';
  depth!.format = THREE.RedFormat;
  depth!.type = THREE.FloatType;
  normal!.name = 'previousNormal';
  normal!.format = THREE.RGFormat;
  normal!.type = THREE.HalfFloatType;
  return target;
}

// 履歴と前フレームの面を保持し、蓄積の段を correction.target へ書く。beginFrame は G バッファを描く前に毎フレーム呼ぶ。
export class TemporalAccumulation {
  private readonly target = targetOf();
  private readonly quad = new QuadMesh();
  private readonly timeConstant: FloatUniform = uniform(1);
  private readonly copyStage: ScreenSpaceStage;
  private readonly accumulationStage: ScreenSpaceStage;
  private previousFrame: number | null = null;
  private previousFrameRendered = false;

  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly correction: DiffuseCorrection, private readonly gpu: GpuTimings,
  ) {
    this.copyStage = this.copyStageOf();
    this.accumulationStage = this.accumulationStageOf();
  }

  public get historyTexture(): THREE.Texture { return this.target.textures[0]!; }
  public get previousDepthTexture(): THREE.Texture { return this.target.textures[1]!; }
  public get previousNormalTexture(): THREE.Texture { return this.target.textures[2]!; }
  public get accumulation(): ScreenSpaceStage { return this.accumulationStage; }

  // 履歴と前フレームの面を width × height へ合わせる。
  public setSize(width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
  }

  // 履歴の時定数 frames [フレーム] を表示用の uniform へ渡す。
  public setTimeConstant(frames: number): void {
    this.timeConstant.value = frames;
  }

  // correction.target の履歴長を時定数で割り、0〜1 に制限した値を返す。
  public normalizedHistoryAt(uv: Vec2Node): FloatNode {
    return texture(this.correction.target.texture, uv).a.div(this.timeConstant).clamp(0, 1);
  }

  // G バッファを上書きする前に、連続して描いた前フレームがあれば履歴へ写す。
  public beginFrame(frame: number, change: number): void {
    const step = frameStepOf(this.previousFrame, frame, change);
    if (step === 'repeat') {
      this.previousFrameRendered = false;
      return;
    }
    if (step === 'advance' && this.previousFrameRendered) this.copyPreviousFrame();
    this.previousFrame = frame;
    this.previousFrameRendered = false;
  }

  // 近傍拡散補正の段を描いたことを、次の番号へ進むときの判断に使う。
  public markFrameRendered(): void {
    this.previousFrameRendered = true;
  }

  // beginFrame の履歴写しで使うマテリアルを、履歴ターゲットへ事前コンパイルする。
  public async compile(): Promise<void> {
    this.quad.material = this.copyStage.material;
    await compileInto(this.renderer, this.target, this.quad, this.quad.camera);
  }

  public dispose(): void {
    this.target.dispose();
    this.copyStage.material.dispose();
    this.accumulationStage.material.dispose();
  }

  private copyStageOf(): ScreenSpaceStage {
    const target = this.target;
    const pixel = ivec2(floor(screenUV.mul(screenSize)));
    const material = multiOutputMaterial(target, () => [
      textureLoad(this.correction.target.texture, pixel),
      vec4(textureLoad(this.gbuffer.depthTexture, pixel).r, 0, 0, 0),
      vec4(textureLoad(this.gbuffer.normalTexture, pixel).rg, 0, 0),
    ]);
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseHistoryCopy };
  }

  // 蓄積前の補正の rgb と履歴長 1 を correction.target へ書く段を作る。
  private accumulationStageOf(): ScreenSpaceStage {
    const target = this.correction.target;
    const material = stageMaterial();
    material.mrtNode = mrt({
      [target.texture.name]: Fn(() => {
        const input = texture(this.correction.upsampledTarget.texture, screenUV).rgb;
        return vec4(vec3(input), 1);
      })(),
    });
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseAccumulation };
  }

  // beginFrame が advance と判定したとき、補正と G バッファを履歴へ写す。
  private copyPreviousFrame(): void {
    this.renderer.setRenderTarget(this.target);
    this.quad.material = this.copyStage.material;
    this.gpu.beginPass(this.copyStage.gpuPass);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }
}

// 前回から同じ番号を描き直すか、次の番号へ進むか、履歴を切るか。
export type FrameStep = 'repeat' | 'advance' | 'cut';

// 変化量 change が履歴の計算で使える値かを検査する。
function assertChange(change: number): void {
  if (Number.isNaN(change) || change < 0) {
    throw new RangeError(`screen-space: invalid change ${change}`);
  }
}

// 前回番号 previous と今回の番号 frame から、履歴を再利用できる進み方を返す。
export function frameStepOf(previous: number | null, frame: number, change: number): FrameStep {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`screen-space: invalid frame ${frame}`);
  }
  if (previous !== null && (!Number.isInteger(previous) || previous < 0)) {
    throw new RangeError(`screen-space: invalid previous frame ${previous}`);
  }
  // 同じ番号の描き直しは、最初に受けた変化量を使い続けるので change を読まない。
  if (previous !== null && frame === previous) return 'repeat';

  assertChange(change);
  if (previous === null || frame !== previous + 1 || change === Infinity) return 'cut';
  return 'advance';
}

// 時定数 timeConstant [フレーム] と変化量 change から、実数の履歴上限を返す。
export function historyCapOf(timeConstant: number, change: number): number {
  if (!Number.isInteger(timeConstant) || timeConstant < 1) {
    throw new RangeError(`screen-space: invalid time constant ${timeConstant}`);
  }
  assertChange(change);
  return Math.max(1, timeConstant / (1 + change));
}
