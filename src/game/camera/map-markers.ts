// マップモードのフォーカス対象(地球・月・太陽・ラグランジュ点等)ラベルの算出と
// HUD マーカーへの反映。MapCamera から抽出 — 「どこにラベルがあるか」の担当で、
// カメラの視点操作(MapCamera)とは責務を分離する。
import { Vec3, v3 } from '../../physics/vec3';
import { ProjectFn } from './camera-system';
import { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';

export interface MapLabel {
  id: string;
  name: string;
  pos: Vec3;
}

const LABEL_NAMES: Record<string, string> = {
  earth: '地球',
  moon: '月',
  sun: '太陽',
  'em-l1': '地球-月 L1',
  'em-l2': '地球-月 L2',
  'em-l3': '地球-月 L3',
  'em-l4': '地球-月 L4',
  'em-l5': '地球-月 L5',
  'se-l1': '太陽-地球 L1',
  'se-l2': '太陽-地球 L2',
};

export class MapMarkers {
  readonly labels: MapLabel[] = Object.entries(LABEL_NAMES).map(([id, name]) => ({
    id,
    name,
    pos: v3(0, 0, 0),
  }));

  constructor(private readonly markerManager: MarkerManager, private readonly ephemeris: Ephemeris) {}

  // マップモードのフォーカス対象(地球・月・太陽・ラグランジュ点など)ラベルの座標を
  // 表示時刻 t(未来ゴーストスライダーを織り込んだ時刻)で更新し、マーカーに反映する。
  syncLabels(t: number, project: ProjectFn): void {
    const ephemeris = this.ephemeris;
    const emL = ephemeris.emLagrangeAt(t);
    const seL = ephemeris.seLagrangeAt(t);

    const positions: Record<string, Vec3> = {
      'earth': v3(0, 0, 0),
      'moon': ephemeris.moonPosAt(t),
      'sun': ephemeris.sunPosAt(t),
      'em-l1': emL.L1,
      'em-l2': emL.L2,
      'em-l3': emL.L3,
      'em-l4': emL.L4,
      'em-l5': emL.L5,
      'se-l1': seL.L1,
      'se-l2': seL.L2,
    };

    for (const lbl of this.labels) {
      lbl.pos = positions[lbl.id]!;
      this.markerManager.setPosition(lbl.id, 'poi', '●', lbl.pos, project, lbl.name);
    }
  }

  // マップモードを抜けたときの後始末(戦闘ビューには天体ラベルを出さない)。
  hideLabels(): void {
    for (const lbl of this.labels) this.markerManager.hide(lbl.id);
  }

  findLabel(id: string): MapLabel | undefined {
    return this.labels.find((l) => l.id === id);
  }
}
