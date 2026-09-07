// 注視している当事者。一覧・プロパティ行・マーカーが「いま誰の視点か」から読むのは、その個体の
// 位置・同一性と、相対量を出すための接触軌道だけ。操作系(スロットル・射撃管制・電源・計画)まで
// 知る必要はないので、注視者を受け取るだけの側はこの面で受ける。
import type { CelestialBody } from '../../../physics/celestial-body';
import type { OrbitalElements } from '../../../physics/elements';
import type { KinematicState } from '../../../physics/kinematic-state';

export interface Viewer {
  readonly id: string;
  readonly state: KinematicState;
  // center を中心とする接触軌道要素。縮退していれば null。
  orbitalElementsAround(center: CelestialBody, centerPivot: number): OrbitalElements | null;
}
