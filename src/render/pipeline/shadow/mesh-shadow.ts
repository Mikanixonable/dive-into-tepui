// 影マップへ描かれたメッシュ(艦艇・基地・デブリなど)が落とす影。描画座標の点へ恒星の直射光が
// どれだけ届くかを、深度マップを引く TSL グラフとして返す。値の源は SunShadowMaps がフレームごとに
// 描く深度マップとスロットの uniform 配列で、ここが持つ状態は無い。
import {
  Fn, If, Loop, clamp, cos, dot, float, int, max, min, select, sin, sqrt, texture, vec2, vec3, vec4,
} from 'three/tsl';
import type {
  BoolNode, FloatNode, IntNode, Mat4Node, Vec2Node, Vec3Node, Vec4Node,
} from '../../tsl-types';
import { MAX_SHADOW_SLOTS, type SunShadowMaps } from '../sun-shadow-maps';
import { COLUMN_SPAN } from '../sun-shadow-casters';
import type { SunLight } from '../sun-light';

// 影のバイアス。受け手をこれだけ法線方向へずらしてからライト空間へ写し、残りを傾きに比例した
// 深度バイアスで吸収する。単位はどちらもそのスロットの 1 texel。
const NORMAL_OFFSET_TEXELS = 1.5;
const MAX_SLOPE_BIAS_TEXELS = 8;

// フィルタ。半径は半影の幅から決まり、この範囲へ収める(単位は texel)。タップは Vogel disk で
// 散らす — 少ないタップでも規則的な縞にならない。
const PCF_TAPS = 12;
const PCF_MIN_TEXELS = 0.5;
const PCF_MAX_TEXELS = 8;
const VOGEL_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// デバッグ表示「影マップのスロット」がスロットへ割り当てる色。並びがスロット番号の順。
const SLOT_DEBUG_COLORS: readonly (readonly [number, number, number])[] = [
  [1, 0.25, 0.2], [0.3, 1, 0.35], [0.35, 0.5, 1], [1, 0.85, 0.25],
];

export class MeshShadow {
  constructor(
    private readonly sunLight: SunLight,
    private readonly shadowMaps: SunShadowMaps,
  ) {}

  // このフレームにメッシュの影があるか。
  casts(): boolean { return this.shadowMaps.casts(); }

  // 選んだ 1 スロットだけを引く — 透過率は恒星円盤の遮られずに残る面積比なので、枠の重なった
  // スロットの答えを掛け合わせると同じメッシュの半影が二重に濃くなる。判定を select ではなく If で
  // 書き、選ぶ段と引く段を分けるのは、虚空の画素からテクスチャフェッチを消すため(select は両辺を
  // 評価する)。normal は受け手の面の法線で、バイアスを法線方向のオフセットで入れるために要る。
  transmittance(worldPos: Vec3Node, normal: Vec3Node): FloatNode {
    const sunDir = this.sunLight.directionFrom(worldPos);
    const sunAngRadius = this.sunLight.angularRadiusFrom(worldPos);
    return Fn(() => {
      const selected = this.selectSlot(worldPos);
      const visibility = float(1).toVar();
      const slots = this.shadowMaps.uniformArrays;
      If(selected.greaterThanEqual(0), () => {
        const layer = int(selected);
        visibility.assign(this.slotVisibility(
          layer, slots.lightViewProjection.element(layer), slots.lightView.element(layer), slots.parameters.element(layer),
          worldPos, normal, sunDir, sunAngRadius,
        ));
      });
      return visibility;
    })();
  }

  // デバッグ表示「影マップのスロット」の色。選ばれたスロットの色で、どれも覆っていなければ黒。
  slotDebugColor(worldPos: Vec3Node): Vec3Node {
    return Fn(() => {
      const selected = this.selectSlot(worldPos);
      const color = vec3(0, 0, 0).toVar();
      for (const [index, tint] of SLOT_DEBUG_COLORS.entries()) {
        If(selected.equal(index), () => { color.assign(vec3(...tint)); });
      }
      return color;
    })();
  }

  // 描画座標の点が、そのスロットの柱(枠 × [near, near + coverDepth])に入っているか。枠はフィルタの
  // 足のぶんだけ狭めて判定するので、選んだ時点で法線オフセットぶんずらした位置も PCF の円盤も
  // 枠の内側に収まり、引く側で縁を判じずに済む。
  private slotCovers(
    lightViewProjection: Mat4Node, lightView: Mat4Node, parameters: Vec4Node, worldPos: Vec3Node,
  ): BoolNode {
    const margin = this.shadowMaps.uvPerTexel.mul(NORMAL_OFFSET_TEXELS + PCF_MAX_TEXELS);
    const inner = float(1).sub(margin);
    const uv = this.slotUv(lightViewProjection, worldPos);
    const depth = this.slotDepth(lightView, parameters.x, worldPos);
    // near から測った柱の長さ [m]。枠の 1 辺(= texel の実寸 × スロットの 1 辺)を、影が届く
    // 距離の倍率 COLUMN_SPAN 倍したもの。
    const coverDepth = parameters.z.mul(this.shadowMaps.texelsPerSlot).mul(COLUMN_SPAN);
    return parameters.w.greaterThan(0.5)
      .and(uv.x.greaterThan(margin)).and(uv.x.lessThan(inner))
      .and(uv.y.greaterThan(margin)).and(uv.y.lessThan(inner))
      .and(depth.greaterThan(0)).and(depth.lessThan(coverDepth));
  }

  // 描画座標の点を、そのスロットの深度マップの UV へ写す。**深度マップの v は上端が 0** —
  // 描いたとき NDC y=+1 の画素がテクスチャの 0 行目へ落ちるので、x と揃えて 0.5·y+0.5 に
  // すると鏡像になり、メッシュのシルエットが鏡に映した位置へ出る。
  private slotUv(lightViewProjection: Mat4Node, worldPos: Vec3Node): Vec2Node {
    const clip = lightViewProjection.mul(vec4(worldPos, 1));
    const ndc = clip.xyz.div(clip.w);
    return vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
  }

  // 描画座標の点の、そのスロットの near から測ったライト空間深度 [m]。深度マップの値と同じ単位。
  private slotDepth(lightView: Mat4Node, near: FloatNode, worldPos: Vec3Node): FloatNode {
    return lightView.mul(vec4(worldPos, 1)).z.negate().sub(near);
  }

  // 描画座標の点を覆うスロットのうち、texel がいちばん細かいものの番号。どれも覆っていなければ
  // −1。**どのスロットも自分の枠のメッシュをすべて持つので、どれを選んでも答えは正しい** —
  // 細かいほうが影の形をよく表すというだけの基準である。
  private selectSlot(worldPos: Vec3Node): FloatNode {
    return Fn(() => {
      const bestTexel = float(0).toVar();
      const bestIndex = float(-1).toVar();
      const slots = this.shadowMaps.uniformArrays;
      // 覆っていて、いままでより texel が細かいスロットへ乗り換える。
      Loop({ start: 0, end: MAX_SHADOW_SLOTS, type: 'int', condition: '<' }, ({ i }) => {
        const parameters = slots.parameters.element(i);
        const finer = bestIndex.lessThan(0).or(parameters.z.lessThan(bestTexel));
        If(this.slotCovers(
          slots.lightViewProjection.element(i), slots.lightView.element(i), parameters, worldPos,
        ).and(finer), () => {
          bestTexel.assign(parameters.z);
          bestIndex.assign(float(i));
        });
      });
      return bestIndex;
    })();
  }

  // スロット 1 つぶんの可視率。近層はブロッカー探索 1 タップで半影の幅を決め、その半径の
  // Vogel disk で PCF する。遠層のぶんは distantVisibility が返す。
  private slotVisibility(
    layer: IntNode, lightViewProjection: Mat4Node, lightView: Mat4Node, parameters: Vec4Node,
    worldPos: Vec3Node, normal: Vec3Node, sunDir: Vec3Node, sunAngRadius: FloatNode,
  ): FloatNode {
    const texel = parameters.z;
    // バイアスは 2 段構え。**無次元の定数は使えない** — スロットの広がりがフレームごとに
    // 変わるので、texel の実寸を単位に取る。法線方向のオフセットで受け手をメッシュから離し、
    // 残りを傾きに比例した深度バイアスで吸収する。
    const nDotL = clamp(dot(normal, sunDir), 1e-3, 1);
    const slope = sqrt(float(1).sub(nDotL.mul(nDotL))).div(nDotL);
    const offsetPos = worldPos.add(normal.mul(texel.mul(NORMAL_OFFSET_TEXELS)));
    const depthBias = min(texel.mul(slope).mul(2), texel.mul(MAX_SLOPE_BIAS_TEXELS));

    const uvBase = this.slotUv(lightViewProjection, offsetPos);
    const receiverDepth = this.slotDepth(lightView, parameters.x, offsetPos);

    // 半影の幅を物理から出す。影を落とすものまでの距離 (receiver − blocker) に恒星の視半径を掛けた
    // ものが world 空間での半径で、それを texel へ直す。1 タップの探索は探索半径の外のメッシュを
    // 見逃す(PCSS の既知の限界)ので細い部材の影の縁は硬いまま残るが、画面上 2px の差なので許容する。
    const blockerDepth = texture(this.shadowMaps.texture, uvBase).depth(layer).r;
    const blockerDistance = max(receiverDepth.sub(blockerDepth), 0);
    const radiusTexels = clamp(sunAngRadius.mul(blockerDistance).div(texel), PCF_MIN_TEXELS, PCF_MAX_TEXELS);
    // 影を落とすものから遠ざかるほど本影は細り、その角半径が恒星の角半径を下回ると影は消える。
    // 遮られる面積比は (影を落とすものの角半径 / 恒星の角半径)² で落ちる。**PCF は半影の広がりを
    // PCF_MAX_TEXELS で頭打ちにするのでこの減衰を再現できない** — 解析で掛ける。差し渡しは枠の
    // 1 辺で代用する(枠はメッシュの箱へ密着しているので、単独の枠では実寸に近い)。
    const casterSize = texel.mul(this.shadowMaps.texelsPerSlot);
    const shrink = casterSize.div(max(sunAngRadius.mul(blockerDistance).mul(2), 1e-9));
    const umbraFade = min(shrink.mul(shrink), 1);

    const step = radiusTexels.mul(this.shadowMaps.uvPerTexel);
    const lit = float(0).toVar();
    Loop({ start: 0, end: PCF_TAPS, type: 'int', condition: '<' }, ({ i }) => {
      // Vogel disk: 黄金角で回しながら sqrt で半径を振ると、円盤上へ均等に散る。
      const tap = float(i);
      const angle = tap.mul(VOGEL_GOLDEN_ANGLE);
      const spread = sqrt(tap.add(0.5).div(PCF_TAPS));
      const uv = uvBase.add(vec2(cos(angle).mul(spread), sin(angle).mul(spread)).mul(step));
      const stored = texture(this.shadowMaps.texture, uv).depth(layer).r;
      lit.addAssign(select(receiverDepth.sub(depthBias).greaterThan(stored), float(0), float(1)));
    });
    const visibility = float(1).sub(float(1).sub(lit.div(PCF_TAPS)).mul(umbraFade));
    const distantVisibility = this.distantVisibility(layer, uvBase, receiverDepth.sub(depthBias), casterSize, sunAngRadius);
    // 法線オフセットが受け手を光源側へ押し出し、柱の手前へ抜けることがある。そこは遮られない。
    return select(receiverDepth.lessThan(0), float(1), visibility.mul(distantVisibility));
  }

  // 遠層に写ったメッシュが残す可視率。近層と遠層に同じメッシュが写ることはないので、2 つの可視率は
  // そのまま掛けられる。遠層に居るのは本影を失ったものだけで半影の幅は枠の 1 辺以上あるので、
  // PCF は要らず、遮られる面積比 (角半径 / 恒星の角半径)² を 1 タップから返す。
  private distantVisibility(
    layer: IntNode, uv: Vec2Node, receiverDepth: FloatNode, casterSize: FloatNode,
    sunAngRadius: FloatNode,
  ): FloatNode {
    const blockerDepth = texture(this.shadowMaps.farTexture, uv).depth(layer).r;
    const blockerDistance = receiverDepth.sub(blockerDepth);
    const shrink = casterSize.div(max(sunAngRadius.mul(blockerDistance).mul(2), 1e-9));
    // メッシュの居ない texel は受け手より奥の深度で埋まっているので、そのまま素通しになる。
    return select(blockerDistance.greaterThan(0), float(1).sub(min(shrink.mul(shrink), 1)), float(1));
  }
}
