// レンズ効果。画面の絵を、明るい点ほど広く見える淡い像として画面の中で配り直す。
//
// **配り直しであって加算ではない。** 核の総和を 1 に保つので、滲みが受け取ったぶんだけ元の
// 光点が暗くなり、画面全体の光量は変わらない。
//
// **閾値(ニー)を持たない。** 明るい画素だけを抜き出してから広げると、入力を「太陽ぶん」と
// 「それ以外」に分けて計算した結果が、分けずに計算した結果と一致しなくなる。線形のままなら
// 一致するので、将来この段の入力から太陽を抜いて解析式で足し直しても、他の画素の絵は
// 1 ビットも変わらない。**この段が線形であることだけが、その拡張性を担保している。**
//
// 広がりは、半分ずつ縮む段のチェーンを昇って降りることで作る。段の解像度が画面解像度に対する
// 固定の割合なので、**広がりは画面上の角度で決まり、光源までの距離では変わらない。**
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mix, screenUV, texture, uniform, vec2, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { Vec2Uniform, Vec3Node } from '../tsl-types';

// 縮小チェーンの段数。いちばん粗い段の 1 テクセルが画面の 1/32 を覆う。
const LEVELS = 5;

// レンズが本来の道から外す光の割合。実在のレンズの veiling glare が 1〜3%。
const GLARE_FRACTION = 0.03;

// 1 段ぶんの器。読み元のテクセル寸法だけが段ごとに違うので、そこを uniform で持つ。
type Stage = {
  readonly target: THREE.RenderTarget;
  readonly quad: QuadMesh;
  readonly material: THREE.MeshBasicNodeMaterial;
  // オフセットを測る単位。**読み元**のテクセル寸法であって、書き込み先のではない。
  readonly sourceTexel: Vec2Uniform;
};

// source の (x, y) テクセルぶんずれた点を読む。
function tapAt(source: THREE.Texture, texel: Vec2Uniform, x: number, y: number): Vec3Node {
  return texture(source, screenUV.add(vec2(x, y).mul(texel))).rgb;
}

// 総和 1 の縮小。書き込み先が読み元のちょうど半分の解像度なので、半テクセルずらした双一次の
// 4 点がそのまま 4x4 の箱平均になる。
function boxDownsample(source: THREE.Texture, texel: Vec2Uniform): Vec3Node {
  const tap = (x: number, y: number): Vec3Node => tapAt(source, texel, x, y);
  return tap(-0.5, -0.5).add(tap(0.5, -0.5)).add(tap(-0.5, 0.5)).add(tap(0.5, 0.5)).mul(0.25);
}

// 総和 1 の拡大((1,2,1 / 2,4,2 / 1,2,1) / 16 のテント)。
function tentUpsample(source: THREE.Texture, texel: Vec2Uniform): Vec3Node {
  const tap = (x: number, y: number): Vec3Node => tapAt(source, texel, x, y);
  const corners = tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1));
  const edges = tap(0, -1).add(tap(-1, 0)).add(tap(1, 0)).add(tap(0, 1));
  return corners.add(edges.mul(2)).add(tap(0, 0).mul(4)).mul(1 / 16);
}

// 描画先と、そこへ描く色を作るシェーダを 1 組にする。色は総和 1 でなければならない。
function createStage(colorOf: (sourceTexel: Vec2Uniform) => Vec3Node): Stage {
  const sourceTexel: Vec2Uniform = uniform(new THREE.Vector2());
  const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: false });
  material.colorNode = vec4(colorOf(sourceTexel), 1);
  return {
    // 深度は要らない。半精度浮動小数点の上限は 65504 だが、核の総和が 1 なので出力が入力の
    // 最大値(太陽面の 4.62e4)を超えることはない。
    target: new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    }),
    quad: new QuadMesh(material),
    material,
    sourceTexel,
  };
}

export class LensPass {
  // 縮小チェーン。down[i] は画面の 1/2^(i+1) の解像度。
  private readonly down: readonly Stage[];
  // 拡大チェーン。up[i] は down[i] と同じ解像度で、1 段粗いほうを混ぜ込んだもの。
  private readonly up: readonly Stage[];
  private width = 0;
  private height = 0;

  // source は world パスまでが描き終えた HDR の絵。
  constructor(
    private readonly renderer: WebGPURenderer,
    source: THREE.Texture,
    private readonly gpu: GpuTimings,
  ) {
    const down: Stage[] = [];
    for (let i = 0; i < LEVELS; i++) {
      const from = i === 0 ? source : down[i - 1]!.target.texture;
      down.push(createStage((texel) => boxDownsample(from, texel)));
    }
    // 粗いほうから順に組む。**各段の重みは「その下に何段積んであるか」で決まり**、
    // 全体として 5 段が均等な 1/5 ずつを持つ — 1 オクターブあたり等エネルギー、つまり
    // 実在のレンズのグレアと同じ 1/角度² の広がりになる。
    const up: Stage[] = new Array<Stage>(LEVELS - 1);
    for (let i = LEVELS - 2; i >= 0; i--) {
      const coarser = (i === LEVELS - 2 ? down[LEVELS - 1]! : up[i + 1]!).target.texture;
      const finer = down[i]!.target.texture;
      const coarserWeight = (LEVELS - 1 - i) / (LEVELS - i);
      up[i] = createStage(
        (texel) => mix(texture(finer, screenUV).rgb, tentUpsample(coarser, texel), coarserWeight),
      );
    }
    this.down = down;
    this.up = up;
  }

  // 下地へレンズ効果を掛けた色。**滲みが受け取ったぶんだけ元の光点が暗くなる**ので、
  // 加算ではなく混合で書く。
  blendedWith(base: Vec3Node): Vec3Node {
    return mix(base, this.redistributed(1), GLARE_FRACTION);
  }

  // レンズが配り直した光だけ。デバッグ表示が下地と合成せず単独で映す。
  redistributedLight(): Vec3Node {
    return this.redistributed(GLARE_FRACTION);
  }

  // 配り直された像。出力は半解像度なので、読む側は screenUV の線形補間に任せる
  // (ぼけた像なのでそれで足りる)。
  private redistributed(scale: number): Vec3Node {
    return texture(this.up[0]!.target.texture, screenUV).rgb.mul(scale);
  }

  // 1 フレームぶんのレンズ効果を発行する。呼ぶのは world パスの後・合成パスの前。
  render(width: number, height: number): void {
    this.resize(width, height);
    for (const stage of this.down) this.draw(stage);
    for (let i = LEVELS - 2; i >= 0; i--) this.draw(this.up[i]!);
    this.renderer.setRenderTarget(null);
  }

  private draw(stage: Stage): void {
    this.renderer.setRenderTarget(stage.target);
    this.renderer.autoClear = true;
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼ぶ。1 パスで何度も呼ぶので、
    // 計測側は同じパスへ届いた時間を足し合わせる。
    this.gpu.beginPass(GPU_PASS.lens);
    stage.quad.render(this.renderer);
  }

  // 各段を画面解像度の固定の割合へ合わせ、オフセットの単位を読み元の寸法から取り直す。
  private resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    let sourceWidth = width;
    let sourceHeight = height;
    for (const [i, stage] of this.down.entries()) {
      stage.target.setSize(
        Math.max(1, Math.ceil(width / 2 ** (i + 1))), Math.max(1, Math.ceil(height / 2 ** (i + 1))),
      );
      stage.sourceTexel.value.set(1 / sourceWidth, 1 / sourceHeight);
      sourceWidth = stage.target.width;
      sourceHeight = stage.target.height;
    }
    for (const [i, stage] of this.up.entries()) {
      stage.target.setSize(this.down[i]!.target.width, this.down[i]!.target.height);
      // テントが読むのは 1 段粗いほうなので、オフセットもその段のテクセルで測る。
      const coarser = this.down[i + 1]!.target;
      stage.sourceTexel.value.set(1 / coarser.width, 1 / coarser.height);
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    for (const stage of [...this.down, ...this.up]) {
      stage.target.dispose();
      stage.material.dispose();
    }
  }
}
