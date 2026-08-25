// 模式図スタイルの見た目を決める値。

// 物体の無い画素と、輪郭の内側を塗る色。
export const SCHEMATIC_BACKGROUND = 0xffffff;
// 輪郭線の色。
export const SCHEMATIC_LINE = 0x101014;

// 隣接画素との view 空間距離の**相対**差がこの比を超えたら輪郭とみなす。絶対差で判定すると、
// 遠方の天体では隣接画素の距離差そのものが巨大になって全面が線になる。
export const SCHEMATIC_DEPTH_RATIO = 0.02;
// 隣接画素との法線の内積がこれを下回ったら稜線とみなす(cos 40° ≈ 0.766)。
export const SCHEMATIC_NORMAL_DOT = 0.766;
// 輪郭を探す近傍までの距離 [px]。
export const SCHEMATIC_EDGE_WIDTH_PX = 1;

// 天体へ貼る経緯度グリッドの刻み [deg] と色。
export const GRATICULE_STEP_DEG = 15;
export const GRATICULE_COLOR = 0x606068;
export const GRATICULE_OPACITY = 0.7;
// 球面のどれだけ外側へ浮かせて描くか(球半径に対する比)。深度テストで面に食い込ませないための余裕。
export const GRATICULE_RADIUS_RATIO = 1.002;

// 環・太陽の輪郭円の色。
export const OUTLINE_CIRCLE_COLOR = SCHEMATIC_LINE;
