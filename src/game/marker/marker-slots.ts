// マーカーを1枠ぶん置く・消す・出ているか訊く口。マーカーを出す側は「何をどこに出すか」だけを
// 決めればよく、DOM の作り方も混み合いの解決も知らない。
import type { Projected, ProjectFn } from '../../math/projection';
import type { Vec3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import type { MarkerVisibility } from './marker-visibility';

// 方向マーカーを投影する仮想距離 [m]。実在の位置ではなく方向のみを示す。
export const MARKER_DIR_DIST = 5e4;

export interface MarkerSlots extends MarkerVisibility {
  // スクリーン座標のマーカー。visible=false で非表示。cls は見た目の分類、sym はグリフ。
  set(
    key: string, cls: string, sym: string, x: number, y: number, visible: boolean,
    label?: string, opacity?: number, color?: string, rotationDeg?: number,
    symMarkup?: boolean, fixedLabel?: boolean, priority?: number, dist?: number,
  ): void;
  // 3D 空間上の「位置」を示すマーカー(敵機・補給・ノードなど、実在の座標そのもの)。
  // cameraPos を渡すと、そこからの距離を混み合いの解決に使う。
  setPosition(
    key: string, cls: string, sym: string, worldPos: Vec3, project: ProjectFn,
    label?: string, opacity?: number, color?: string, rotationDeg?: number,
    symMarkup?: boolean, fixedLabel?: boolean, priority?: number, cameraPos?: Vec3,
  ): void;
  // 3D 空間上の「方向」を示すマーカー(プログレード/ボアサイト/BURN など、実在の位置を
  // 持たない)。origin から dir の向きへ MARKER_DIR_DIST だけ離した仮想点を投影する。
  // origin は自機位置で統一すること。
  setDirection(
    key: string, cls: string, sym: string, origin: Vec3, dir: Vec3, project: ProjectFn,
    label?: string, opacity?: number, color?: string, rotationDeg?: number,
    symMarkup?: boolean, fixedLabel?: boolean, priority?: number,
  ): void;
  // 計画ノードのマーカー。occludeByBodies を立てると、天体に遮られている間はフェードで畳む。
  setNodePosition(
    key: string, cls: string, sym: string, worldPos: Vec3, project: ProjectFn, cameraPos: Vec3,
    occluders: readonly CelestialBody[], occludersPivot: number, occludeByBodies: boolean,
    label?: string, priority?: number,
  ): void;
  // 画面外(背面を含む)の対象を、画面中心から見た方位として画面端の円周上に置く。p が画面内に
  // 入っているあいだは隠れるので、実位置を指す setPosition と対で使い、そちらが front=false や
  // 画面外へ出て見えなくなったぶんを補う。sym は**上向きの記号**を渡すこと。
  setBearing(
    key: string, cls: string, sym: string, p: Projected,
    label?: string, opacity?: number, color?: string,
  ): void;

  // マーカーを隠す。要素は残るので、キーが有限で使い回す対象に使う。
  hide(key: string): void;
  // 天体遮蔽で見えなくなるマーカーを、いきなり消さずに透明化する。
  fadeOut(key: string): void;
  // マーカーを DOM ごと削除する。キーが対象ごとに増え続けるものはこちらで捨てる。
  remove(key: string): void;
}
