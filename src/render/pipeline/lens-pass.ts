// レンズ効果。高輝度部ほど広く淡い光が広がる像として再配分する。
// カーネルの総和を1に保つ線形処理のため、画面全体の総光量と後段の分離可能性を維持する。
// 広がりは画面上の視野角に基づいて計算する。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { mix, screenUV, texture, uniform, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import type { FloatUniform, Vec2Uniform, Vec3Node } from '../tsl-types';
import { APERTURE_PSF_DIRECTIONS, APERTURE_PSF_PASSES } from './aperture-psf';
import { apertureGhosts, diffractionPass, downsample, tentUpsample } from './lens-kernels';
import { compileInto } from './compile-into';

// 縮小チェーンの段数。いちばん粗い段の 1 テクセルが画面の 1/32 を覆う。
const LEVELS = 5;

// レンズが本来の道から外す光の割合。実在のレンズの veiling glare が 1〜3%。
const GLARE_FRACTION = 0.03;

// 光条を生成するダウンサンプリング階層。**この階層のテクセル寸法がそのまま光条の太さになる。** 長さはパス数で確保するため、
// 太さのみを基準に選択する（1/2 なら画面解像度 2px 相当）。
const DIFFRACTION_LEVEL = 0;
// カーネルのうち回折PSFの主ローブへ配分する割合。**滲みの重みから減算する**ため、総和は1を維持する。
const DIFFRACTION_SHARE = 0.1;

// ゴースト生成の基準となる最高解像度の入力階層。この階層の解像度がそのままゴースト出力の解像度になる。
// **各ゴーストのブラー処理には、ここから3段階のダウンサンプリング階層と同レベルのブルーム画像を参照する。**
const GHOST_LEVEL = 2;
// カーネルのうちゴーストへ配分する割合。光条と同様に滲みの重みから減算する。
const GHOST_SHARE = 0.04;

// 全画面描画フィルタ。入力元のテクセル寸法のみが異なるため uniform で保持する。
// 描画先ターゲットは呼び出し側が選択し、光条のように複数フィルタが2枚のバッファを交互に利用する場合がある。
type Filter = {
  readonly quad: QuadMesh;
  readonly material: THREE.MeshBasicNodeMaterial;
  // オフセットを測る単位。**読み元**のテクセル寸法であって、書き込み先のではない。
  readonly sourceTexel: Vec2Uniform;
};

// フィルタと、それ専用の書き込み先。
type Stage = Filter & { readonly target: THREE.RenderTarget };

// 色を作るシェーダを 1 枚のフィルタにする。色は総和 1 でなければならない。additive を立てると
// 書き込み先へ加算合成する（各方向の光条フィルタチェーンを単一ターゲットへ集約するため）。
//
// **すべてのフィルタで transparent: true を有効化する。** 不透明マテリアルでは Three.js が
// アルファ値を1に固定するコードを追加しシェーダ分岐が発生するため。書き込みは NoBlending で
// 上書きを維持するため出力結果は不透明描画と同等になる（加算合成には transparent 指定が必須）。
function createFilter(colorOf: (sourceTexel: Vec2Uniform) => Vec3Node, additive = false): Filter {
  // 透過を有効にした全画面フィルタを作り、必要なら加算合成にする。
  const sourceTexel: Vec2Uniform = uniform(new THREE.Vector2());
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: true,
  });
  if (additive) {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
  } else {
    material.blending = THREE.NoBlending;
  }
  material.colorNode = vec4(colorOf(sourceTexel), 1);
  return { quad: new QuadMesh(material), material, sourceTexel };
}

// 深度を持たない半精度の描画先。核の総和が 1 なので、出力が入力の最大値を超えることはない。
function createTarget(): THREE.RenderTarget {
  return new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
  });
}

// フィルタと、そのフィルタだけが書き込む描画先を組にする。
function createStage(colorOf: (sourceTexel: Vec2Uniform) => Vec3Node): Stage {
  return { ...createFilter(colorOf), target: createTarget() };
}

export class LensPass {
  // 縮小チェーン。down[i] は画面の 1/2^(i+1) の解像度。
  private readonly down: readonly Stage[];
  // 拡大チェーン。up[i] は down[i] と同じ解像度で、1 段粗いほうを混ぜ込んだもの。
  private readonly up: readonly Stage[];
  // 光条処理。**軸ごとに独立したフィルタチェーン**で構成し、ピンポンバッファ間を往復しながら処理して最終パスのみを
  // 出力ターゲットへ加算合成する。ブルームとは独立したカーネルのため、合成段で配分比率を乗算して混合する。
  private readonly diffractionChains: readonly (readonly Filter[])[];
  private readonly diffractionScratch: readonly THREE.RenderTarget[];
  private readonly diffractionTarget = createTarget();
  // ゴースト。同じく別の核。
  private readonly ghosts: Stage;
  private width = 0;
  private height = 0;
  // 直前のフレームで出力を書いたか。設定で切られたあと 1 度だけ空へ戻すために持つ
  // (shadow/shadow-maps.ts のスロットの空戻しと同じ)。
  private drawn = false;
  // clear が退避する描画先の消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly clearColor = new THREE.Color();

  // source は world パスまでが描き終えた HDR の絵。
  constructor(
    private readonly renderer: WebGPURenderer,
    source: THREE.Texture,
    private readonly gpu: GpuTimings,
  ) {
    const down: Stage[] = [];
    for (let i = 0; i < LEVELS; i++) {
      const from = i === 0 ? source : down[i - 1]!.target.texture;
      down.push(createStage((texel) => downsample(from, texel)));
    }
    // 低解像度側から順にアップサンプル合成を行う。**各階層の重みは累積階層数から決定され**、
    // 全体として 5 つのレベルが均等に 1/5 ずつの重みを持つ。これにより 1 オクターブあたり等エネルギーとなり、
    // 実在のレンズグレアと同様の 1/角度² に比例した光の広がりを再現する。
    const up: Stage[] = new Array<Stage>(LEVELS - 1);
    for (let i = LEVELS - 2; i >= 0; i--) {
      const coarser = (i === LEVELS - 2 ? down[LEVELS - 1]! : up[i + 1]!).target.texture;
      const finer = down[i]!.target.texture;
      const coarserWeight: FloatUniform = uniform((LEVELS - 1 - i) / (LEVELS - i));
      up[i] = createStage(
        (texel) => mix(texture(finer, screenUV).rgb, tentUpsample(coarser, texel), coarserWeight),
      );
    }
    this.down = down;
    this.up = up;
    // 鎖は 1 本ずつ順に走らせるので、途中の作業用ターゲットは全鎖で使い回せる。
    this.diffractionScratch = Array.from({ length: APERTURE_PSF_PASSES.length - 1 }, () => createTarget());
    this.diffractionChains = APERTURE_PSF_DIRECTIONS.map(([x, y]) => {
      const direction: Vec2Uniform = uniform(new THREE.Vector2(x, y));
      return APERTURE_PSF_PASSES.map((psfTaps, pass) => {
        const last = pass === APERTURE_PSF_PASSES.length - 1;
        const from = pass === 0
          ? down[DIFFRACTION_LEVEL]!.target.texture
          : this.diffractionScratch[pass - 1]!.texture;
        // 最後のパスだけ本数で割る。鎖 1 本ぶんが 1/本数 を持ち、加算して総和 1 になる。
        const gain: FloatUniform = uniform(last ? 1 / APERTURE_PSF_DIRECTIONS.length : 1);
        return createFilter((texel) => diffractionPass(from, texel, direction, psfTaps).mul(gain), last);
      });
    });
    this.ghosts = createStage(() => apertureGhosts([
      down[GHOST_LEVEL]!.target.texture, down[GHOST_LEVEL + 1]!.target.texture,
      down[GHOST_LEVEL + 2]!.target.texture, up[GHOST_LEVEL]!.target.texture,
    ]));
  }

  // 下地へレンズ効果を掛けた色。**滲みが受け取ったぶんだけ元の光点が暗くなる**ので、
  // 加算ではなく混合で書く。
  blendedWith(base: Vec3Node): Vec3Node {
    return mix(base, this.redistributed(1), GLARE_FRACTION);
  }

  // 下地と合成する前の、レンズが配り直した光だけ。blendedWith が下地へ混ぜるのと同じ強さで返す。
  redistributedLight(): Vec3Node {
    return this.redistributed(GLARE_FRACTION);
  }

  // 再配分されたグレア像。ブルームと光条は**単純加算せず、配分比率で混合する** — 双方ともに総和 1 のカーネルのため、
  // 混合結果の総和も 1 を維持する。出力ターゲットはダウンサンプリング解像度のため、参照側は screenUV のバイリニア補間に
  // 委ねる（ぼかし像のため補間精度は十分）。
  private redistributed(scale: number): Vec3Node {
    const glare = texture(this.up[0]!.target.texture, screenUV).rgb;
    const diffraction = texture(this.diffractionTarget.texture, screenUV).rgb;
    const ghosts = texture(this.ghosts.target.texture, screenUV).rgb;
    return mix(mix(glare, diffraction, DIFFRACTION_SHARE), ghosts, GHOST_SHARE).mul(scale);
  }

  // 1 フレームぶんのレンズ効果を発行する。呼ぶのは world パスの後・合成パスの前。
  render(width: number, height: number): void {
    this.resize(width, height);
    for (const stage of this.down) this.draw(stage, stage.target);
    for (const [axis, passes] of this.diffractionChains.entries()) {
      for (const [pass, filter] of passes.entries()) {
        const last = pass === APERTURE_PSF_PASSES.length - 1;
        // 最後のパスは加算合成するため、**最初の 1 軸だけがクリアを行う。** クリアを省略すると前
        // フレームの上へ積み上がり、半精度の上限を越えて画面が NaN になる。
        this.draw(
          filter, last ? this.diffractionTarget : this.diffractionScratch[pass]!, !last || axis === 0,
        );
      }
    }
    for (let i = LEVELS - 2; i >= 0; i--) this.draw(this.up[i]!, this.up[i]!.target);
    this.draw(this.ghosts, this.ghosts.target);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
    this.drawn = true;
  }

  // 各フィルタを実際の縮小ターゲットへ事前コンパイルする。
  async compile(width: number, height: number): Promise<void> {
    this.resize(width, height);
    for (const stage of this.down) await compileInto(this.renderer, stage.target, stage.quad, stage.quad.camera);
    for (const filters of this.diffractionChains) {
      for (const filter of filters) {
        await compileInto(this.renderer, this.diffractionTarget, filter.quad, filter.quad.camera);
      }
    }
    for (const stage of this.up) await compileInto(this.renderer, stage.target, stage.quad, stage.quad.camera);
    await compileInto(this.renderer, this.ghosts.target, this.ghosts.quad, this.ghosts.quad.camera);
  }

  // 設定でレンズ効果が切られている間、render の代わりに呼ぶ。**切り替わった最初の 1 フレーム
  // だけ**、読まれる 3 枚を空へ戻す — 残しておくと「レンズ」デバッグ表示に切る直前の像が凍った
  // まま出力される。中間のダウンサンプリング段および光条用作業ターゲットは参照されないため消去を省略する。
  clear(width: number, height: number): void {
    // 前フレームの出力を一度だけ消去し、無効中の残像を残さない。
    if (!this.drawn) return;
    this.resize(width, height);
    const savedColor = this.renderer.getClearColor(this.clearColor).clone();
    const savedAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    for (const target of [this.up[0]!.target, this.diffractionTarget, this.ghosts.target]) {
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(savedColor, savedAlpha);
    this.drawn = false;
  }

  // フィルタ 1 枚を target へ描画する。clear を false（省略）にすると、既存の描画結果の上へ加算・ブレンドする。
  private draw(filter: Filter, target: THREE.RenderTarget, clear = true): void {
    this.renderer.setRenderTarget(target);
    this.renderer.autoClear = clear;
    // beginPass は、そのフィルタが発行する renderer.render() の直前に呼ぶ。
    this.gpu.beginPass(GPU_PASS.lens);
    filter.quad.render(this.renderer);
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
    // 光条のフィルタチェーンはすべて入力段と同一解像度を維持し、ピンポンバッファ間での反復処理中も寸法を不変に保つ。
    const diffractionSource = this.down[DIFFRACTION_LEVEL]!.target;
    for (const target of [...this.diffractionScratch, this.diffractionTarget]) {
      target.setSize(diffractionSource.width, diffractionSource.height);
    }
    for (const passes of this.diffractionChains) {
      for (const filter of passes) {
        filter.sourceTexel.value.set(1 / diffractionSource.width, 1 / diffractionSource.height);
      }
    }
    const ghostSource = this.down[GHOST_LEVEL]!.target;
    this.ghosts.target.setSize(ghostSource.width, ghostSource.height);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    for (const stage of [...this.down, ...this.up, this.ghosts]) {
      stage.target.dispose();
      stage.material.dispose();
    }
    for (const target of [...this.diffractionScratch, this.diffractionTarget]) target.dispose();
    for (const passes of this.diffractionChains) for (const filter of passes) filter.material.dispose();
  }
}
