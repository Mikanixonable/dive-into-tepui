// OrbitalElements から軌道楕円を描画する。どの天体を中心に描くかは要素自身が持ち、頂点はその
// 天体の相対座標のまま保持して、フローティングオリジンによる平行移動で ECI 位置へ置く。
// 描くのは常に sync へ渡されたその瞬間の要素だけで、以前に描いた形は持たない — 接触軌道は定義上
// その瞬間の位置を通るので、これによって楕円は必ず対象の現在位置を通る。
// 解像度そのものの決定(画面上のサジッタに応じた分割)は Curve に委ねる。
import * as THREE from 'three/webgpu';
import { OrbitalElements } from '../physics/elements';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveSampler } from '../render/curve';
import { LineStyle } from '../render/line-style';

// Curve の頂点予算。楕円は閉曲線なので初期分割・分割上限のみで足り、固定サンプル数は持たない。
const MAX_VERTICES = 4096;

// これ以上潰れた楕円は描かない(離心率の上限)。
const MAX_ECC = 0.98;

export class OrbitLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  // このフレームに描く軌道要素。sampler はこれだけを読む。
  private el: OrbitalElements | null = null;

  // style.renderOrder は、この線が他の線と重なったときにどちらを手前へ描くかを決める —
  // 透明描画どうしの前後は描画順でしか決まらない。
  constructor(style: LineStyle) {
    this.curve = new Curve({ style, maxVertices: MAX_VERTICES });
    this.line = this.curve.object;
  }

  setStyle(style: LineStyle): void {
    this.curve.setStyle(style);
  }

  // 不透明度を書き換える。天体からの距離に応じて描画側がフェードさせる。
  setOpacity(opacity: number): void {
    this.curve.setOpacity(opacity);
  }

  setColor(color: string | number): void {
    this.curve.setColor(color);
  }

  setRenderOrder(renderOrder: number): void {
    this.curve.setRenderOrder(renderOrder);
  }

  // 離心近点角 E=t·2π を軌道要素で中心天体相対の位置へ写す、閉曲線サンプラ。
  private readonly sampler: CurveSampler = (t, out) => {
    const el = this.el;
    if (!el) return;
    const b = el.a * Math.sqrt(1 - el.e * el.e);
    const E = t * Math.PI * 2;
    const x = el.a * (Math.cos(E) - el.e);
    const y = b * Math.sin(E);
    out.set(
      el.pHat.x * x + el.qHat.x * y,
      el.pHat.y * x + el.qHat.y * y,
      el.pHat.z * x + el.qHat.z * y,
    );
  };

  // 毎フレーム呼ぶ。fo = 描画のフローティングオリジン、camera = 画面上のサジッタを実距離へ
  // 換算するための描画カメラ。el が null か楕円として描けない要素なら非表示にする。
  sync(el: OrbitalElements | null, fo: FloatingOrigin, camera: THREE.Camera): void {
    this.el = el !== null && el.e < MAX_ECC && isFinite(el.a) && el.a > 0 ? el : null;
    if (this.el === null) {
      this.curve.clear();
      return;
    }
    this.curve.setTransform(fo.RtoThreeV3(this.el.center.state.r));
    // 要素は毎フレーム新しい値として渡ってくるので、revision に据えれば形が変わるたびに焼き直される。
    this.curve.setCurve(this.sampler, { revision: this.el, camera });
    this.curve.setVisible(true);
  }

  dispose(): void {
    this.curve.dispose();
  }
}
