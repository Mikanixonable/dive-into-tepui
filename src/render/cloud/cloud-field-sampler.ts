// 雲場テクスチャを、天体固定の単位方向から読む。焼いた側と同じ cap の置き方を写し取り、同じ uv
// で読む。差し込まれたテクスチャは借り物で、解放は差し込んだ側が行う。
import * as THREE from 'three/webgpu';
import { clamp, dot, Fn, If, min, mix, smoothstep, step, texture, uniform, vec4 } from 'three/tsl';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import { orthographicCapUv, type CapPlacement } from '../field-projection';
import { cloudSampleFromTexel, type CloudSample } from './cloud-field-sample';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform, Vec4Node } from '../tsl-types';

// 焼いた雲場と、それを焼いた cap の置き方の組。場を出す側が毎フレーム公開し、読み手が写し取る。
export interface CloudFieldBinding {
  readonly texture: THREE.Texture;
  readonly cap: CapPlacement;
  // 任意の局所高解像度タイル。タイルの外縁と完全解像域の境界のあいだを滑らかに混ぜる。
  readonly detailTile: CloudFieldDetailTileBinding | null;
}

// 局所雲場タイルと、その内側で全詳細度へ達する境界。cosine は方向と cap 中心の内積で表す。
// texture の所有権は binding を作った供給源に残る。
export interface CloudFieldDetailTileBinding {
  readonly texture: THREE.Texture;
  readonly cap: CapPlacement;
  readonly blendStartCos: number;
  // 局所場が既存場に残差だけを重ねるときは晴天を保ち、低周波の被覆・雲頂を変えない。
  readonly composition?: 'absolute' | 'coverage-residual';
}

// 局所被覆の残差を base の雲域内に制限する。shader の残差合成と同じスカラー契約。
export function cloudDetailResidualCoverage(base: number, detail: number): number {
  if (!Number.isFinite(base) || !Number.isFinite(detail) || base < 0 || base > 1 || detail < 0 || detail > 1) {
    throw new RangeError('cloud detail residual coverage must be in [0, 1]');
  }
  return Math.min(1, Math.max(0, base + (detail - 0.5) * 2 * Math.min(base, 1 - base)));
}

// タイル外縁から blendStartCos までの角距離に対する寄与率。shader 側も TSL smoothstep で同じ補間を行う。
export function cloudDetailTileWeight(cosine: number, outerCos: number, blendStartCos: number): number {
  checkDetailTileBlendRange(cosine, outerCos, blendStartCos);
  const t = Math.min(1, Math.max(0, (cosine - outerCos) / (blendStartCos - outerCos)));
  return t * t * (3 - 2 * t);
}

function checkDetailTileBlendRange(cosine: number, outerCos: number, blendStartCos: number): void {
  if (!Number.isFinite(cosine) || cosine < -1 || cosine > 1
    || !Number.isFinite(outerCos) || !Number.isFinite(blendStartCos)
    || outerCos < -1 || outerCos > 1 || blendStartCos < -1 || blendStartCos > 1
    || blendStartCos <= outerCos) {
    throw new RangeError('detail tile blendStartCos must be in [-1, 1] and greater than its outer cosine');
  }
}

export class CloudFieldSampler {
  // 読む雲場のテクスチャノード。場が結ばれるまでは EMPTY_CLOUD_FIELD を読み、bind は同じノードの
  // 値を差し替える。
  private readonly field = texture(EMPTY_CLOUD_FIELD);
  // シェーダグラフは先に組まれ、タイルは後から bind されるため、詳細側も一様値で切り替える。
  private readonly detailField = texture(EMPTY_CLOUD_FIELD);
  private readonly detailEnabled = uniform(0);
  private readonly detailResidualEnabled = uniform(0);
  // 焼いた側の cap の置き方。グラフは一度組めば済み、値だけが毎フレーム入れ替わる。
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly east: Vec3Uniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly north: Vec3Uniform = uniform(new THREE.Vector3(0, 1, 0));
  private readonly sinRadius: FloatUniform = uniform(1);
  private readonly cosRadius: FloatUniform = uniform(-1);
  private readonly detailCenter: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly detailEast: Vec3Uniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly detailNorth: Vec3Uniform = uniform(new THREE.Vector3(0, 1, 0));
  private readonly detailSinRadius: FloatUniform = uniform(1);
  private readonly detailCosRadius: FloatUniform = uniform(-1);
  private readonly detailBlendStartCos: FloatUniform = uniform(1);

  // 焼いた場と、それを焼いた cap の置き方を写し取る。テクスチャの所有権は移らない。
  public bind(binding: CloudFieldBinding): void {
    this.field.value = binding.texture;
    this.center.value.copy(binding.cap.center);
    this.east.value.copy(binding.cap.east);
    this.north.value.copy(binding.cap.north);
    this.sinRadius.value = binding.cap.sinRadius;
    this.cosRadius.value = binding.cap.cosRadius;
    const detail = binding.detailTile;
    if (detail === null) {
      this.detailEnabled.value = 0;
      this.detailResidualEnabled.value = 0;
      return;
    }
    checkDetailTileBlendRange(0, detail.cap.cosRadius, detail.blendStartCos);
    this.detailField.value = detail.texture;
    this.detailCenter.value.copy(detail.cap.center);
    this.detailEast.value.copy(detail.cap.east);
    this.detailNorth.value.copy(detail.cap.north);
    this.detailSinRadius.value = detail.cap.sinRadius;
    this.detailCosRadius.value = detail.cap.cosRadius;
    this.detailBlendStartCos.value = detail.blendStartCos;
    this.detailEnabled.value = 1;
    this.detailResidualEnabled.value = detail.composition === 'coverage-residual' ? 1 : 0;
  }

  // 単位方向 direction の雲標本を、生成時と同じ単位で読む。**cap の外は「雲なし」を返す** —
  // 返さないと縁の値が外へ伸び、裏側の半球では表側の雲を鏡映しに読む。
  public sampleCloud(direction: Vec3Node): CloudSample {
    const texel = Fn(() => {
      const inside = step(this.cosRadius, dot(direction, this.center));
      const uv = orthographicCapUv(direction, this.east, this.north, this.sinRadius);
      const base = this.field.sample(uv).mul(inside).toVar();
      If(this.detailEnabled.greaterThan(0), () => {
        const detailCosine = dot(direction, this.detailCenter);
        const detailUv = orthographicCapUv(direction, this.detailEast, this.detailNorth, this.detailSinRadius);
        const detail = this.detailField.sample(detailUv);
        const detailWeight = smoothstep(
          this.detailCosRadius as FloatNode, this.detailBlendStartCos as FloatNode, detailCosine,
        );
        If(this.detailResidualEnabled.greaterThan(0), () => {
          const residual = detail.r.sub(0.5).mul(2).mul(min(base.r, base.r.oneMinus()));
          const coverage = clamp(base.r.add(residual), 0, 1);
          base.assign(vec4(mix(base.r, coverage, detailWeight), base.g, base.b, base.a));
        }).Else(() => { base.assign(mix(base, detail, detailWeight)); });
      });
      return base;
    })();
    return cloudSampleFromTexel(texel as Vec4Node);
  }
}
