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
// 輪郭を探す近傍までの距離 [px]。写実の輪郭相当(1px)の2倍。
export const SCHEMATIC_EDGE_WIDTH_PX = 2;

// 天体へ貼る経緯度グリッドの刻み [deg] と色。
export const GRATICULE_STEP_DEG = 15;
export const GRATICULE_COLOR = 0x606068;
export const GRATICULE_OPACITY = 0.7;
// 球面のどれだけ外側へ浮かせて描くか(球半径に対する比)。深度テストで面に食い込ませないための余裕。
export const GRATICULE_RADIUS_RATIO = 1.002;

// 環・太陽の輪郭円の色。
export const OUTLINE_CIRCLE_COLOR = SCHEMATIC_LINE;

// 3D UI パスを合成するとき、中心画素の上下左右へこの半径 [px] だけオフセットした4点も
// 最大値でまとめて拾うダイレート半径。ネイティブ線は WebGPU で太さ制御を持たないため、
// これで写実相当(1px)の2倍の太さへ底上げする。
export const SCHEMATIC_OVERLAY_DILATE_PX = 0.5;

// 3D UI パス(軌道線・軌跡線・天球グリッド・縮尺グリッド・Δv ギズモ)を白背景へ合成するときの
// 色の落とし方。暗背景向けの明るい色をそのまま反転すると色相まで裏返り、線の色が持つ区別
// (参照/自機/ターゲット/計画/予測)が別の意味の色になる。色相と彩度を保ったまま暗くする。
export const SCHEMATIC_OVERLAY_DARKEN = 0.45;
// 同じ合成でアルファに掛ける倍率。暗背景では薄い線でも光って見えるが、白地では同じ薄さだと
// 消えるため、濃さの側で補う。
export const SCHEMATIC_OVERLAY_ALPHA_GAIN = 1.6;
