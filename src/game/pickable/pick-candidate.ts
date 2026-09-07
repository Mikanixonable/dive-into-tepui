// 候補の列に並ぶ物体そのもの。名前・記号・表示時刻の位置という、どの並べ方でも要る芯だけを持つ。
// 候補列を受け取って下へ渡すだけのモジュールは、この面だけを見ればよい。
import type { Vec3 } from '../../math/vec3';
import type { KinematicState } from '../../physics/kinematic-state';

export interface PickCandidate {
  readonly id: string;
  readonly name: string;
  // 対象そのものが消滅したか。true ならプロパティウィンドウを閉じる。
  readonly gone: boolean;
  // 軌道要素の導出に使う現在状態。天体と、実体を持たないマーカーは null。
  readonly orbitState: KinematicState | null;
  // 一覧・プロパティウィンドウに添える形態記号。SVG を描ける場所は glyphSvg を優先する。
  readonly glyph: string;
  readonly glyphSvg: string | null;

  // 表示時刻の ECI 位置。求まらないフレームは null で、その回は候補に出ない。
  posAt(displayTime: number): Vec3 | null;
}
