// 剛体の慣性テンソルの型。断面や立体の幾何量を扱う側と、それを姿勢運動へ渡す側の双方が読む。

// 重心まわりの慣性テンソル [kg·m²]。ixy/ixz/iyz はテンソルの非対角成分そのもの(−∫xy dm など)で、
// 行列は [[ixx, ixy, ixz], [ixy, iyy, iyz], [ixz, iyz, izz]] になる。
export interface InertiaTensor {
  readonly ixx: number;
  readonly iyy: number;
  readonly izz: number;
  readonly ixy: number;
  readonly ixz: number;
  readonly iyz: number;
}
