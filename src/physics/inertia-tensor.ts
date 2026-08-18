// 剛体の慣性テンソルの型。

// 重心まわりの慣性テンソル [kg·m²]。ixy/ixz/iyz は慣性乗積を負号込みで持つテンソルの非対角成分
// (−∫xy dm など)で、行列は [[ixx, ixy, ixz], [ixy, iyy, iyz], [ixz, iyz, izz]] になる。
export interface InertiaTensor {
  readonly ixx: number;
  readonly iyy: number;
  readonly izz: number;
  readonly ixy: number;
  readonly ixz: number;
  readonly iyz: number;
}
