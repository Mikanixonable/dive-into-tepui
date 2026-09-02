// 実写の雲画像を GPU(TSL の多段パス)で 3 チャンネル — 厚い雲の被覆率・雲頂高度・薄い雲 —
// へ推定分離する。高度の次元は原理的に欠けているので、巻雲の特徴だけに頼る:
// 積雲・層積雲の粒は全方向に細かいが、巻雲は滑らかか筋状(1 方向にだけ細かい)。
//
// パスの流れ(すべて実写と同じ大きさの半精度の写し):
//   1. ならし → 勾配の構造テンソル → 窓で均して固有値へ。小さい方の固有値 λ2 が「等方な
//      細かさ」= 積雲の証拠。w = 1 − λ2/しきい値 を veil 候補の重みにする(滑らかでも筋状でも
//      通り、粒だけ落ちる)。主軸に直交する向き = 筋の方向も残す。
//   2. 候補の輝度を筋の方向に沿って伝播・補間する(下側に寄せた重み付き拡散)。天井へは
//      非線形に漸近させる(ハードに切らない)。
//   3. それとは別に、**全画素の輝度のソフト最小値を侵食で広げた「上界」の場**を作り、
//      veil = min(候補の伝播, 上界) とする。細かい穴(等方で暗い画素)は「そこは veil では
//      なかった」証拠なので、穴 1 つが周囲を巻き込んで veil を引き下げ、veil に細かい穴は
//      写らない。veil ≤ 実写がほぼ保たれるので再合成も崩れない(ソフト最小のゆるみぶんだけ誤差)。
//   4. thick = (実写 − veil)/(1 − veil)(スクリーン合成の逆算)。雲頂高度は thick の広い濃さを
//      土台に細かい起伏を増幅して重ねる。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import {
  Fn, atan, clamp, cos, exp, float, log, max, min, mrt, screenUV, sin, sqrt, texture, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { pixelsToPngDataUrl } from '../lab-png';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../../src/render/tsl-types';

// 調整パラメータ。長さはすべて km(図法・解像度に依らない)、輝度は 0..1、起伏は [輝度²/(100km)²]。
// 規定値は 8k_clouds を目視で当てたもの。
export const SEPARATION_PARAMS = {
  fineScaleKm: { label: '細かさの尺度 [km]', min: 5, max: 60, step: 1, initial: 16 },
  tensorWindowKm: { label: 'テンソル窓 [km]', min: 10, max: 150, step: 5, initial: 35 },
  isotropyThreshold: { label: '等方の減衰尺度', min: 0.005, max: 0.3, step: 0.005, initial: 0.1 },
  minBias: { label: '下側への寄せ', min: 0, max: 10, step: 0.5, initial: 0 },
  stepKm: { label: '伝播の歩幅 [km]', min: 5, max: 60, step: 1, initial: 27 },
  denMin: { label: '証拠の最低量', min: 0.005, max: 0.5, step: 0.005, initial: 0.295 },
  ceiling: { label: 'veil の天井', min: 0.1, max: 1, step: 0.01, initial: 1 },
  boundKm: { label: '上界の半径 [km]', min: 20, max: 400, step: 10, initial: 160 },
  boundSoftness: { label: '上界のやわらかさ', min: 0.01, max: 0.2, step: 0.01, initial: 0.05 },
  topBase: { label: '雲頂の底', min: 0, max: 0.5, step: 0.01, initial: 0.05 },
  topSmoothKm: { label: '雲頂の広さ [km]', min: 30, max: 500, step: 10, initial: 140 },
  topGain: { label: '雲頂の利得', min: 0, max: 2, step: 0.05, initial: 0.35 },
  topRelief: { label: '雲頂の起伏', min: 0, max: 2, step: 0.05, initial: 1.1 },
} as const;
export type SeparationParamId = keyof typeof SEPARATION_PARAMS;

// 伝播と侵食の反復数。到達距離は 反復数 × 歩幅(伝播)/ 上界の半径(侵食)。**どちらも偶数に
// 保つ** — 往復の焼き先が偶数回で先頭の器へ戻ることを、後段のパスが当てにしている。
const INFILL_ITERATIONS = 12;
const BOUND_ITERATIONS = 8;

export type SeparationView =
  | 'photo' | 'selection' | 'veil' | 'coverage' | 'cloudTop' | 'translucent' | 'recomposed';
export const SEPARATION_VIEWS: readonly (readonly [SeparationView, string])[] = [
  ['photo', '実写'],
  ['selection', '選択の重み'],
  ['veil', '巻雲の輝度'],
  ['coverage', '被覆率'],
  ['cloudTop', '雲頂高度'],
  ['translucent', '薄い雲 τ'],
  ['recomposed', '再合成'],
];

export class SeparationPipeline {
  private readonly uniforms = Object.fromEntries(
    Object.entries(SEPARATION_PARAMS).map(([id, spec]) => [id, uniform(spec.initial)]),
  ) as Record<SeparationParamId, FloatUniform>;

  // 写しの器。infill の 2 枚は伝播のあと雲頂の広さのぼかしにも使い回す。
  private readonly smooth: THREE.RenderTarget;
  private readonly tensor: THREE.RenderTarget;
  private readonly tensorHalf: THREE.RenderTarget;
  private readonly feature: THREE.RenderTarget;
  private readonly infillA: THREE.RenderTarget;
  private readonly infillB: THREE.RenderTarget;
  private readonly veil: THREE.RenderTarget;
  private readonly thick: THREE.RenderTarget;
  private readonly top: THREE.RenderTarget;
  private readonly captureTarget: THREE.RenderTarget;

  private readonly passes: readonly { material: THREE.MeshBasicNodeMaterial; target: THREE.RenderTarget }[];
  private readonly displays = new Map<SeparationView, THREE.MeshBasicNodeMaterial>();
  private readonly quad = new QuadMesh();

  // photo は等長図法(横 1 周)の実写。読み手が施すべき設定(flipY なし・生の値・横は巻き付く)は
  // 呼び出し側が済ませて渡す。
  public constructor(
    private readonly renderer: WebGPURenderer,
    private readonly photo: THREE.Texture,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.smooth = this.dataTarget('smooth');
    this.tensor = this.dataTarget('tensor');
    this.tensorHalf = this.dataTarget('tensorHalf');
    this.feature = this.dataTarget('feature');
    this.infillA = this.dataTarget('infillA');
    this.infillB = this.dataTarget('infillB');
    this.veil = this.dataTarget('veil');
    this.thick = this.dataTarget('thick');
    this.top = this.dataTarget('top');
    this.captureTarget = new THREE.RenderTarget(width, height, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, samples: 0,
    });
    this.passes = this.buildPasses();
    for (const [view] of SEPARATION_VIEWS) this.displays.set(view, this.displayMaterial(view));
  }

  public setParam(id: SeparationParamId, value: number): void {
    this.uniforms[id].value = value;
  }

  // 全パスを順に写しへ焼く。パラメータは uniform なので、変えて呼び直しても組み直しは起きない。
  public run(): void {
    for (const { material, target } of this.passes) {
      this.quad.material = material;
      this.renderer.setRenderTarget(target);
      this.quad.render(this.renderer);
    }
    this.renderer.setRenderTarget(null);
  }

  // 量 view をキャンバスへ出す。
  public show(view: SeparationView): void {
    this.quad.material = this.displays.get(view)!;
    this.quad.render(this.renderer);
  }

  // 量 view を PNG のデータ URL で返す。
  public async capture(view: SeparationView): Promise<string> {
    this.quad.material = this.displays.get(view)!;
    this.renderer.setOutputRenderTarget(this.captureTarget);
    try {
      this.quad.render(this.renderer);
    } finally {
      this.renderer.setOutputRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(
      this.captureTarget, 0, 0, this.width, this.height);
    return pixelsToPngDataUrl(new Uint8Array(pixels.buffer), this.width, this.height);
  }

  // 実写と同じ大きさの半精度 RGBA の写し。横は経度で巻き付く。
  private dataTarget(name: string): THREE.RenderTarget {
    const target = new THREE.RenderTarget(this.width, this.height, { count: 1, depthBuffer: false, samples: 0 });
    const map = target.textures[0]!;
    map.name = name;
    map.type = THREE.HalfFloatType;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.generateMipmaps = false;
    return target;
  }

  // 緯度で横が縮む等長図法で、物理の長さ sKm が張る uv の幅。横 1 周が 40075 km。極の発散は頭打ち。
  private uvStepX(sKm: FloatNode): FloatNode {
    const cosLat = max(cos(screenUV.y.sub(0.5).mul(Math.PI)), 0.1);
    return sKm.div(cosLat.mul(40075));
  }

  private uvStepY(sKm: FloatNode): FloatNode {
    return float(sKm).div((40075 / this.width) * this.height);
  }

  // 写し map を横/縦に、半径 radiusKm の 7 点でならす材料。
  private blurPass(map: THREE.Texture, target: THREE.RenderTarget, horizontal: boolean, radiusKm: FloatNode) {
    return this.pass(target, () => {
      const sum = vec4(0).toVar();
      for (let i = -3; i <= 3; i++) {
        const sKm = float(radiusKm).mul(i / 3);
        const offset = horizontal ? vec2(this.uvStepX(sKm), 0) : vec2(0, this.uvStepY(sKm));
        sum.addAssign(texture(map, screenUV.add(offset)));
      }
      return sum.div(7);
    });
  }

  // target の名前で mrt を組んだ 1 パス。
  private pass(target: THREE.RenderTarget, source: () => Vec4Node) {
    const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    material.mrtNode = mrt({ [target.textures[0]!.name]: Fn(source)() });
    return { material, target };
  }

  private buildPasses() {
    const u = this.uniforms;
    const photoAt = (uv: Vec2Node) => texture(this.photo, uv).r;
    const passes = [];

    // 1. ならし(3×3、細かさの尺度の半分刻み)。
    passes.push(this.pass(this.smooth, () => {
      const sum = float(0).toVar();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sKm = float(u.fineScaleKm).mul(0.5);
          sum.addAssign(photoAt(screenUV.add(vec2(this.uvStepX(sKm.mul(dx)), this.uvStepY(sKm.mul(dy))))));
        }
      }
      return vec4(sum.div(9), 0, 0, 0);
    }));

    // 2. 勾配の構造テンソル(中心差分の刻みも物理の長さで取る — 解像度に依らない)。
    passes.push(this.pass(this.tensor, () => {
      const hKm = float(u.fineScaleKm).mul(0.5);
      const smoothAt = (uv: Vec2Node) => texture(this.smooth.textures[0]!, uv).r;
      const gx = smoothAt(screenUV.add(vec2(this.uvStepX(hKm), 0)))
        .sub(smoothAt(screenUV.sub(vec2(this.uvStepX(hKm), 0)))).mul(float(100).div(hKm.mul(2)));
      const gy = smoothAt(screenUV.add(vec2(0, this.uvStepY(hKm))))
        .sub(smoothAt(screenUV.sub(vec2(0, this.uvStepY(hKm))))).mul(float(100).div(hKm.mul(2)));
      return vec4(gx.mul(gx), gy.mul(gy), gx.mul(gy), 0);
    }));

    // 3. テンソルを窓で均す(横 → 縦)。
    passes.push(this.blurPass(this.tensor.textures[0]!, this.tensorHalf, true, u.tensorWindowKm));
    passes.push(this.blurPass(this.tensorHalf.textures[0]!, this.tensor, false, u.tensorWindowKm));

    // 4. 固有値 → 選択の重みと筋の方向。λ2(等方な細かさ)が弱いほど veil 候補。重みは指数の
    // 減衰にして下側で飽和させない — ハードに切ると veil に黒い境界線が残る。
    passes.push(this.pass(this.feature, () => {
      const j = texture(this.tensor.textures[0]!, screenUV);
      const mean = j.r.add(j.g).mul(0.5);
      const diff = sqrt(j.r.sub(j.g).mul(0.5).pow(2).add(j.b.mul(j.b)));
      const weight = exp(mean.sub(diff).div(u.isotropyThreshold).negate());
      // 主軸(勾配の卓越方向)に直交する向きが筋の方向。
      const theta = atan(j.b.mul(2), j.r.sub(j.g)).mul(0.5);
      return vec4(weight, sin(theta).negate(), cos(theta), 0);
    }));

    // 5. 伝播の初期値: 候補の輝度を下側に寄せた重みで積む。
    passes.push(this.pass(this.infillA, () => {
      const p = photoAt(screenUV);
      const k = texture(this.feature.textures[0]!, screenUV).r.mul(exp(p.mul(u.minBias).negate()));
      return vec4(p.mul(k), k, 0, 0);
    }));

    // 6. 筋の方向に沿った伝播(A↔B を反復)。横断方向は歩幅を絞って弱く混ぜる。
    const infillStep = (from: THREE.RenderTarget, into: THREE.RenderTarget) => this.pass(into, () => {
      const f = texture(this.feature.textures[0]!, screenUV);
      const along = vec2(this.uvStepX(f.g.mul(u.stepKm)), this.uvStepY(f.b.mul(u.stepKm)));
      const across = vec2(
        this.uvStepX(f.b.mul(u.stepKm).mul(-0.35)), this.uvStepY(f.g.mul(u.stepKm).mul(0.35)));
      const prevAt = (uv: Vec2Node) => texture(from.textures[0]!, uv);
      const sum = prevAt(screenUV).toVar();
      sum.addAssign(prevAt(screenUV.add(along)));
      sum.addAssign(prevAt(screenUV.sub(along)));
      sum.addAssign(prevAt(screenUV.add(across)).mul(0.4));
      sum.addAssign(prevAt(screenUV.sub(across)).mul(0.4));
      return sum.div(3.8);
    });
    const stepAB = infillStep(this.infillA, this.infillB);
    const stepBA = infillStep(this.infillB, this.infillA);
    for (let i = 0; i < INFILL_ITERATIONS; i++) passes.push(i % 2 === 0 ? stepAB : stepBA);

    // 7. 候補側の veil: 重み付き平均へ戻し、証拠の薄い所を締め、天井へ非線形に漸近させる。
    // 書き先はテンソルならしの中間の器の再利用(この段では空いている)。
    passes.push(this.pass(this.tensorHalf, () => {
      const acc = texture(this.infillA.textures[0]!, screenUV);
      const value = acc.r.div(acc.g.add(1e-5)).mul(clamp(acc.g.div(u.denMin), 0, 1));
      return vec4(float(u.ceiling).mul(float(1).sub(exp(value.div(u.ceiling).negate()))), 0, 0, 0);
    }));

    // 8. 上界: 全画素の輝度のソフト最小値を、十字の侵食の反復で半径ぶん広げる。細かい暗い穴が
    // 周囲を巻き込んで veil を引き下げる証拠になる。ならしの器と infill の片割れを再利用する。
    passes.push(this.pass(this.smooth, () => vec4(photoAt(screenUV), 0, 0, 0)));
    const erodeStep = (from: THREE.RenderTarget, into: THREE.RenderTarget) => this.pass(into, () => {
      const sKm = float(u.boundKm).div(BOUND_ITERATIONS);
      const at = (uv: Vec2Node) => texture(from.textures[0]!, uv).r;
      const taps = [
        at(screenUV),
        at(screenUV.add(vec2(this.uvStepX(sKm), 0))),
        at(screenUV.sub(vec2(this.uvStepX(sKm), 0))),
        at(screenUV.add(vec2(0, this.uvStepY(sKm)))),
        at(screenUV.sub(vec2(0, this.uvStepY(sKm)))),
      ];
      const hardMin = min(min(min(taps[0]!, taps[1]!), min(taps[2]!, taps[3]!)), taps[4]!).toVar();
      const sumExp = float(0).toVar();
      for (const tap of taps) sumExp.addAssign(exp(hardMin.sub(tap).div(u.boundSoftness)));
      return vec4(hardMin.sub(float(u.boundSoftness).mul(log(sumExp.div(taps.length)))), 0, 0, 0);
    });
    const erodeAB = erodeStep(this.smooth, this.infillB);
    const erodeBA = erodeStep(this.infillB, this.smooth);
    for (let i = 0; i < BOUND_ITERATIONS; i++) passes.push(i % 2 === 0 ? erodeAB : erodeBA);
    // 侵食の菱形の角と食い込みの縁を、半径の 1/4 のならしで和らげる(そのぶん上界は少し緩む)。
    passes.push(this.blurPass(this.smooth.textures[0]!, this.infillB, true, float(u.boundKm).div(4)));
    passes.push(this.blurPass(this.infillB.textures[0]!, this.smooth, false, float(u.boundKm).div(4)));

    // 9. veil = min(候補の伝播, 上界)。上界が効くので veil ≤ 実写がほぼ保たれる。
    passes.push(this.pass(this.veil, () => vec4(
      min(
        texture(this.tensorHalf.textures[0]!, screenUV).r,
        max(texture(this.smooth.textures[0]!, screenUV).r, 0)),
      0, 0, 0)));

    // 10. thick(スクリーン合成の逆算)。
    passes.push(this.pass(this.thick, () => {
      const p = photoAt(screenUV);
      const v = texture(this.veil.textures[0]!, screenUV).r;
      return vec4(clamp(p.sub(v).div(float(1).sub(v)), 0, 1), 0, 0, 0);
    }));

    // 11. 雲頂高度: thick の広い濃さ(横 → 縦のならし)を土台に、細かい起伏を増幅して重ねる。
    passes.push(this.blurPass(this.thick.textures[0]!, this.infillA, true, u.topSmoothKm));
    passes.push(this.blurPass(this.infillA.textures[0]!, this.infillB, false, u.topSmoothKm));
    passes.push(this.pass(this.top, () => {
      const t = texture(this.thick.textures[0]!, screenUV).r;
      const broad = texture(this.infillB.textures[0]!, screenUV).r;
      return vec4(
        clamp(float(u.topBase).add(broad.mul(u.topGain)).add(t.sub(broad).mul(u.topRelief)), 0, 1), 0, 0, 0);
    }));

    return passes;
  }

  // 量 view の表示値 0..1 の色(グレースケール)。薄い雲は光学的厚み τ = −ln(1−veil) を 0..1 で。
  private displayMaterial(view: SeparationView): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    material.colorNode = Fn((): Vec3Node => {
      const p = texture(this.photo, screenUV).r;
      const v = texture(this.veil.textures[0]!, screenUV).r;
      const t = texture(this.thick.textures[0]!, screenUV).r;
      if (view === 'photo') return vec3(p);
      if (view === 'selection') return vec3(texture(this.feature.textures[0]!, screenUV).r);
      if (view === 'veil') return vec3(v);
      if (view === 'coverage') return vec3(t);
      if (view === 'cloudTop') return vec3(texture(this.top.textures[0]!, screenUV).r);
      if (view === 'translucent') return vec3(clamp(log(float(1).sub(v).max(0.02)).negate(), 0, 1));
      return vec3(v.add(t.mul(float(1).sub(v))));
    })();
    return material;
  }
}
