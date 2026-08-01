// マップモードのフォーカス対象(地球・月・太陽・ラグランジュ点等)ラベルの算出と
// HUD マーカーへの反映。
import { Vec3, v3 } from '../../physics/vec3';
import { ProjectFn } from './camera-system';
import { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';

export interface FocusLabel {
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
  'se-l3': '太陽-地球 L3',
  'se-l4': '太陽-地球 L4',
  'se-l5': '太陽-地球 L5',
};

export class FocusMarkers {
  readonly labels: FocusLabel[] = Object.entries(LABEL_NAMES).map(([id, name]) => ({
    id,
    name,
    pos: v3(0, 0, 0),
  }));

  constructor(private readonly markerManager: MarkerManager, private readonly ephemeris: Ephemeris) {}

  // 表示時刻 t でラベル座標を更新し、マーカーに反映する。
  syncLabels(t: number, project: ProjectFn): void {
    const ephemeris = this.ephemeris;
    const emL = ephemeris.emLagrangeAt(t);
    const seL = ephemeris.seLagrangeAt(t);

    // 各ラベルの座標を求める
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
      'se-l3': seL.L3,
      'se-l4': seL.L4,
      'se-l5': seL.L5,
    };

    // 求めた座標をラベルとマーカーへ反映する
    for (const lbl of this.labels) {
      lbl.pos = positions[lbl.id]!;
      this.markerManager.setPosition(lbl.id, 'mk-poi', '●', lbl.pos, project, lbl.name);
    }
  }

  // マップモードを抜けたときの後始末(戦闘ビューには天体ラベルを出さない)。
  hideLabels(): void {
    for (const lbl of this.labels) this.markerManager.hide(lbl.id);
  }

  // id に対応するラベルを返す。存在しなければ undefined。
  findLabel(id: string): FocusLabel | undefined {
    return this.labels.find((l) => l.id === id);
  }
}
