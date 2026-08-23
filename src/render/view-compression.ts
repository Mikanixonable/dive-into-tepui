// 戦闘ビューで遠方天体を、見かけの角直径を保ったままカメラ近くの固定距離へ引き寄せる圧縮。
// 入力も出力も描画座標(ECI − 浮動原点)で閉じていて、ECI も暦もカメラの ECI 位置も要らない。
// どの分類にどの表示距離を使うかがここの判断で、その天体がどの分類かは game/ の事実。
//
// **描画原点にカメラが厳密に居ることに依存する。** 浮動原点はアクティブカメラの ECI 位置
// そのものなので今は成り立つが、原点を自機など別の点へ移すと圧縮の中心がカメラからずれ、
// 例外も出さずに絵が歪む。
//
// **このモジュールは消える前提で置いてある。** 深度を反転して 32bit にすれば遠方でも画素の
// 位置を復元できるようになり、圧縮そのものが要らなくなる。
import * as THREE from 'three/webgpu';

// 天体の分類。表示距離を選ぶためだけの区分で、物理的な分類とは独立に決めてよい。
export type CelestialKind = 'satellite' | 'planet' | 'star';

// 分類ごとの表示距離 [m]。星殻(3.5e7)の外、戦闘ビューの far の内に置く。
const VIS_DIST: Record<CelestialKind, number> = {
  satellite: 4.5e7,
  planet: 5e7,
  star: 4.2e7,
};

// 恒星ビルボードの大きさ [m]。実太陽の視直径(約 0.53°)よりやや大きめ + ハロー分で、
// 真半径を圧縮した値ではない。
export const STAR_BILLBOARD_SIZE = 2.4e6;

// 描画座標 p にある天体の圧縮率 k。位置は p·k、半径は真半径·k、深度は 1/k を掛けると
// 真の距離へ戻る。広範囲視点では圧縮しない。
export function compressionRatio(p: THREE.Vector3, kind: CelestialKind, overviewMode: boolean): number {
  return overviewMode ? 1 : VIS_DIST[kind] / Math.max(1, p.length());
}
