// 視点中心の雲場の cap の大きさと、そこへ収める角半径の式。雲場を焼く側と、それを置き直す側が
// 共有する純関数として持つ。

// cap の写しの 1 辺 [texel]。全球の正距円筒 1024x512 の半分の texel 数で、どの高度でも中心の
// texel は今より細かくなる。
export const CLOUD_CAP_SIZE = 512;

// 外周の余白 [rad]。風上へ遡って中間場を読む処理が cap の外へ出るぶんの崩れを、見えている円板の
// 外へ押し出すために足す。
export const CLOUD_CAP_MARGIN = (5 * Math.PI) / 180;

// 見えている雲頂を覆う cap の角半径 [rad]。rho はカメラの中心距離を殻の空間(地表が 1)で測った値、
// topOverRadius は雲頂の上限を天体の基準半径で割った比、margin は外周の余白 [rad]。
//
// **pi/2 で止める** — 正射影の半径 sin(theta) は theta <= pi/2 でしか単調でなく、越えると裏側の
// 半球が表側と同じ uv へ写る。そのため遠方では余白が取れない。
export function capRadiusFor(rho: number, topOverRadius: number, margin = CLOUD_CAP_MARGIN): number {
  // 地表の地平線。rho < 1 にはならないが、念のため 1 で止める。
  const horizon = Math.acos(1 / Math.max(rho, 1));
  // 雲頂が地面の地平線より先まで見える分。
  const cloudTop = Math.acos(1 / (1 + Math.max(topOverRadius, 0)));
  return Math.min(Math.PI / 2, horizon + cloudTop + margin);
}
