// 露出係数の正本。**いま見ている場所の明るさへ画面をどれだけ合わせるか**を1つの数で持つ。
// 順応(場所の明るさへ合わせるぶん)と露出補正の積をトーンマッパへ渡し、固定した明るさで描く
// ものには順応ぶんだけを打ち消す倍率を答える。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { SUN_IRRADIANCE_1AU, irradianceAtDistance } from './sun-light';
import type { FloatNode, FloatUniform } from '../tsl-types';

// 順応の強さ。1 なら完全に順応して距離が絵から消え、0 なら順応しない。**太陽に正対した
// アルベド 0.3 の面が海王星軌道(30 天文単位)でも sRGB 50/255 を下回らない**という要求から
// 出た下限 0.796 を丸めた値で、これを下げるほど外延天体が黒へ近づく。
const ADAPTATION_EXPONENT = 0.8;

export class Exposure {
  private readonly factorUniform: FloatUniform = uniform(1);
  // 順応ぶん。固定した明るさで描くものが打ち消すのはここだけで、露出補正には従う。
  private adaptation = 1;
  private compensation = 1;

  // 順応の基準点と恒星の位置(どちらも描画座標)、その恒星の放射強度を1フレーム分書く。
  // **1 天文単位ぶんの放射照度より明るい側へは順応しない** — 較正(表示値 = アルベド)を
  // そのまま残すためで、恒星へ寄っても係数が 1 で止まるので画面が黒く沈むこともない。
  setReference(reference: THREE.Vector3, sunPosition: THREE.Vector3, sunIntensity: number): void {
    const irradiance = irradianceAtDistance(sunIntensity, reference.distanceTo(sunPosition));
    this.adaptation = Math.max(1, (SUN_IRRADIANCE_1AU / irradiance) ** ADAPTATION_EXPONENT);
    this.refreshFactor();
  }

  // 露出補正の倍率(EV 1 段で 2 倍)を書く。描画設定が変わった時点で1回呼ばれる。
  setCompensation(compensation: number): void {
    this.compensation = compensation;
    this.refreshFactor();
  }

  private refreshFactor(): void {
    this.factorUniform.value = this.adaptation * this.compensation;
  }

  // トーンマッパへ渡す露出係数。物理量として描くものはこれをそのまま受ける。
  get factor(): FloatNode { return this.factorUniform; }

  // 固定した明るさで描くものが自分の色へ掛ける倍率。順応ぶんをちょうど打ち消すので、
  // どこから見ても同じ明るさで写る。
  get fixedBrightnessScale(): number { return 1 / this.adaptation; }
}
