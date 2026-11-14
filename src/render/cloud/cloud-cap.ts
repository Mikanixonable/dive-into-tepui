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

// cap の半径を丸める段の比。半径は 1 段ごとにこの倍率で増える。段の中では texel の寸法が変わらない。
const CAP_RADIUS_LEVEL_RATIO = 2 ** (1 / 4);
// 丸めの段の基準 [rad]。どの高度でもこれ以上の段へ切り上がる。
const CAP_RADIUS_LEVEL_BASE = (1 * Math.PI) / 180;
// 中心を揃える格子の刻み [texel]。直下点がこれだけ動くまで cap は置き直されない。刻みの半分の対角が
// 余白へ足されるので、余白(5 度)より十分小さい角に収まる刻みに取る — 半径 pi/2 で 1.8 度。
export const CLOUD_CAP_SNAP_TEXELS = 8;

// 地表に固定した格子へ揃えた cap の置き方。latitude・longitude は中心 [rad]、radius は角半径 [rad]。
export interface SnappedCap {
  readonly latitude: number;
  readonly longitude: number;
  readonly radius: number;
}

// 直下点 latitude・longitude [rad] と、そこで要る角半径 radius [rad] から、地表に固定した格子へ揃えた
// cap の置き方を返す。**視点が少し動いただけで texel の格子を地表に対して滑らせない** — 雲場は
// 中間の場を何枚も cap へ焼いて読み直すので、格子が滑ると 2〜4 texel の模様の写り方が毎フレーム変わり、
// 止まった雲がちらつく。半径は CAP_RADIUS_LEVEL_RATIO の段へ切り上げ、中心は CLOUD_CAP_SNAP_TEXELS
// texel 刻みの緯度経度の格子点へ丸める。丸めでずれた中心のぶん半径を足してから段へ上げるので、
// 揃えた cap は要る円板を必ず覆う。
export function snapCap(latitude: number, longitude: number, radius: number, size = CLOUD_CAP_SIZE): SnappedCap {
  // 刻みは半径に依るので、まず丸める前の半径で上限を見積もり、余白を足してから段へ上げる。
  const stepFor = (r: number): number => (CLOUD_CAP_SNAP_TEXELS * 2 * Math.sin(Math.min(r, Math.PI / 2))) / size;
  const padded = radius + stepFor(radius * CAP_RADIUS_LEVEL_RATIO) * Math.SQRT1_2;
  const level = Math.ceil(Math.log(Math.max(padded, CAP_RADIUS_LEVEL_BASE) / CAP_RADIUS_LEVEL_BASE)
    / Math.log(CAP_RADIUS_LEVEL_RATIO) - 1e-9);
  const snappedRadius = Math.min(Math.PI / 2, CAP_RADIUS_LEVEL_BASE * CAP_RADIUS_LEVEL_RATIO ** level);
  const step = stepFor(snappedRadius);
  const snappedLatitude = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, Math.round(latitude / step) * step));
  // 経度の刻みは、その緯度で東西の実長が step になる角。極の近くでは刻みが粗くなるが、地表の上での
  // ずれは step のまま。
  const longitudeStep = step / Math.max(Math.cos(snappedLatitude), step);
  const snappedLongitude = Math.round(longitude / longitudeStep) * longitudeStep;
  return { latitude: snappedLatitude, longitude: snappedLongitude, radius: snappedRadius };
}
