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
import { mix, screenUV, texture, uniform, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { Vec2Uniform, Vec3Node } from '../tsl-types';
import { apertureGhosts, downsample, streakPass, tentUpsample } from './lens-kernels';

// 縮小チェーンの段数。いちばん粗い段の 1 テクセルが画面の 1/32 を覆う。
const LEVELS = 5;

// レンズが本来の道から外す光の割合。実在のレンズの veiling glare が 1〜3%。
const GLARE_FRACTION = 0.03;

// 条を引く段。**この段のテクセル寸法がそのまま条の太さになる。** 長さはパス数が別に稼ぐので、
// ここは太さだけで選んでよい(1/4 なら 4 画面px)。
const STREAK_LEVEL = 1;
// 条の向きの数。**1 方向につき 1 本の鎖**が要る(タップが片側だけなので — lens-kernels.ts)。
// 中心を通る条 1 本が正反対の 2 方向を占めるので、見た目の本数はこの半分になる。
const STREAK_DIRECTIONS = 10;
// 条を伸ばすパスの数。刻みがパスごとにタップ数倍になるので、到達距離はこれに対して指数で伸びる。
const STREAK_PASSES = 2;
// 核のうち条へ回す割合。**滲みの重みから引く**ので、核の総和は 1 のまま動かない。
const STREAK_SHARE = 0.1;

// ゴーストのいちばん締まった読み元の段。この段の解像度がそのままゴーストの出力の解像度になり、
// **1 枚ごとのぼけ量の選択肢として、ここから 3 段ぶんの縮小段と、同じ段の滲みの像を読む。**
const GHOST_LEVEL = 2;
// 核のうちゴーストへ回す割合。条と同じく滲みの重みから引く。
const GHOST_SHARE = 0.08;

// 1 回の全画面描画。読み元のテクセル寸法だけが違うので、そこを uniform で持つ。**書き込み先は
// 持たない** — 条の鎖のように、複数のフィルタが同じ 2 枚を往復して使うことがある。
type Filter = {
  readonly quad: QuadMesh;
  readonly material: THREE.MeshBasicNodeMaterial;
  // オフセットを測る単位。**読み元**のテクセル寸法であって、書き込み先のではない。
  readonly sourceTexel: Vec2Uniform;
};

// フィルタと、それ専用の書き込み先。
type Stage = Filter & { readonly target: THREE.RenderTarget };

// 色を作るシェーダを 1 枚のフィルタにする。色は総和 1 でなければならない。additive を立てると
// 書き込み先へ加算で積む(条の軸ごとの鎖を 1 枚へまとめるため)。
function createFilter(colorOf: (sourceTexel: Vec2Uniform) => Vec3Node, additive = false): Filter {
  const sourceTexel: Vec2Uniform = uniform(new THREE.Vector2());
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: additive,
  });
  if (additive) {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
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

function createStage(colorOf: (sourceTexel: Vec2Uniform) => Vec3Node): Stage {
  return { ...createFilter(colorOf), target: createTarget() };
}

export class LensPass {
  // 縮小チェーン。down[i] は画面の 1/2^(i+1) の解像度。
  private readonly down: readonly Stage[];
  // 拡大チェーン。up[i] は down[i] と同じ解像度で、1 段粗いほうを混ぜ込んだもの。
  private readonly up: readonly Stage[];
  // 条。**軸ごとに独立した鎖**で、鎖の途中は 2 枚の作業用ターゲットを往復し、最後のパスだけが
  // 出力へ加算で積まれる。滲みとは別の核なので、読む側が滲みと配分を分け合う。
  private readonly streakChain: readonly (readonly Filter[])[];
  private readonly streakScratch: readonly THREE.RenderTarget[];
  private readonly streakTarget = createTarget();
  // ゴースト。同じく別の核。
  private readonly ghosts: Stage;
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
      down.push(createStage((texel) => downsample(from, texel)));
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
    // 鎖は 1 本ずつ順に走らせるので、途中の作業用ターゲットは全鎖で使い回せる。
    this.streakScratch = Array.from({ length: STREAK_PASSES - 1 }, () => createTarget());
    this.streakChain = Array.from({ length: STREAK_DIRECTIONS }, (_, direction) => {
      const angle = (2 * Math.PI * direction) / STREAK_DIRECTIONS;
      return Array.from({ length: STREAK_PASSES }, (_, pass) => {
        const last = pass === STREAK_PASSES - 1;
        const from = pass === 0
          ? down[STREAK_LEVEL]!.target.texture
          : this.streakScratch[pass - 1]!.texture;
        // 最後のパスだけ本数で割る。鎖 1 本ぶんが 1/本数 を持ち、加算して総和 1 になる。
        return createFilter(
          (texel) => streakPass(from, texel, angle, pass).mul(last ? 1 / STREAK_DIRECTIONS : 1),
          last,
        );
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

  // レンズが配り直した光だけ。デバッグ表示が下地と合成せず単独で映す。
  redistributedLight(): Vec3Node {
    return this.redistributed(GLARE_FRACTION);
  }

  // 配り直された像。滲みと条は**足し合わせず、割合で分け合う** — どちらも総和 1 の核なので、
  // 混ぜた結果もまた総和 1 になる。出力は縮小された段なので、読む側は screenUV の線形補間に
  // 任せる(ぼけた像なのでそれで足りる)。
  private redistributed(scale: number): Vec3Node {
    const glare = texture(this.up[0]!.target.texture, screenUV).rgb;
    const streak = texture(this.streakTarget.texture, screenUV).rgb;
    const ghosts = texture(this.ghosts.target.texture, screenUV).rgb;
    return mix(mix(glare, streak, STREAK_SHARE), ghosts, GHOST_SHARE).mul(scale);
  }

  // 1 フレームぶんのレンズ効果を発行する。呼ぶのは world パスの後・合成パスの前。
  render(width: number, height: number): void {
    this.resize(width, height);
    for (const stage of this.down) this.draw(stage, stage.target);
    for (const [direction, passes] of this.streakChain.entries()) {
      for (const [pass, filter] of passes.entries()) {
        const last = pass === STREAK_PASSES - 1;
        // 最後のパスは加算で積むので、**最初の 1 本だけがクリアする。** クリアを落とすと前の
        // フレームの上へ積み上がり、半精度の上限を越えて画面が NaN になる。
        this.draw(filter, last ? this.streakTarget : this.streakScratch[pass]!, !last || direction === 0);
      }
    }
    for (let i = LEVELS - 2; i >= 0; i--) this.draw(this.up[i]!, this.up[i]!.target);
    this.draw(this.ghosts, this.ghosts.target);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
  }

  private draw(filter: Filter, target: THREE.RenderTarget, clear = true): void {
    this.renderer.setRenderTarget(target);
    this.renderer.autoClear = clear;
    // beginPass はこのあとの renderer.render() 呼び出しの直前に呼ぶ。1 パスで何度も呼ぶので、
    // 計測側は同じパスへ届いた時間を足し合わせる。
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
    // 条の鎖はすべて読み元と同じ寸法で、往復するあいだ寸法が変わらない。
    const streakSource = this.down[STREAK_LEVEL]!.target;
    for (const target of [...this.streakScratch, this.streakTarget]) {
      target.setSize(streakSource.width, streakSource.height);
    }
    for (const passes of this.streakChain) {
      for (const filter of passes) filter.sourceTexel.value.set(1 / streakSource.width, 1 / streakSource.height);
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
    for (const target of [...this.streakScratch, this.streakTarget]) target.dispose();
    for (const passes of this.streakChain) for (const filter of passes) filter.material.dispose();
  }
}
