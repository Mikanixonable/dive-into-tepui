// マップモードのフォーカス対象(地球・月・太陽・ラグランジュ点等)ラベルの算出と
// HUD マーカーへの反映。MapCamera から抽出 — 「どこにラベルがあるか」の担当で、
// カメラの視点操作(MapCamera)とは責務を分離する。
// game.ts を import しない — 依存はコンストラクタ注入(hud)・引数のみ。
import { moonPosition, sunPosition, emLagrangePoints, seLagrangePoints } from '../../physics/ephemeris';
import { Vec3, sub } from '../../physics/vec3';
import { Hud } from '../../hud/hud';
import { ProjectFn } from '../camera/projection';

export interface MapLabel {
  id: string;
  name: string;
  pos: Vec3;
}

// drawLabels() が必要とする、Game 側の現在状態のスナップショット。
export interface MapHudCtx {
  simTime: number;
  sunPhase0: number;
  moonPhase0: number;
  duration: number; // predictDurationSec()
}

export class MapHud {
  labels: MapLabel[] = [];

  constructor(private readonly hud: Hud) {}

  // マップモードのフォーカス対象(地球・月・太陽・ラグランジュ点など)ラベルを更新し、
  // HUD マーカーとして描画する。sliderT > 0 の間はゴーストスライダーの表示時刻を使う。
  drawLabels(o: Vec3, ctx: MapHudCtx, sliderT: number, project: ProjectFn): void {
    const t = sliderT > 0 ? ctx.simTime + sliderT * ctx.duration : ctx.simTime;
    const mPos = moonPosition(t, ctx.moonPhase0);
    const sPos = sunPosition(t, ctx.sunPhase0);
    const emL = emLagrangePoints(t, ctx.moonPhase0);
    const seL = seLagrangePoints(t, ctx.sunPhase0);

    this.labels = [
      { id: 'earth', name: '地球', pos: { x: 0, y: 0, z: 0 } },
      { id: 'moon', name: '月', pos: mPos },
      { id: 'sun', name: '太陽', pos: sPos },
      { id: 'em-l1', name: '地球-月 L1', pos: emL.L1 },
      { id: 'em-l2', name: '地球-月 L2', pos: emL.L2 },
      { id: 'em-l3', name: '地球-月 L3', pos: emL.L3 },
      { id: 'em-l4', name: '地球-月 L4', pos: emL.L4 },
      { id: 'em-l5', name: '地球-月 L5', pos: emL.L5 },
      { id: 'se-l1', name: '太陽-地球 L1', pos: seL.L1 },
      { id: 'se-l2', name: '太陽-地球 L2', pos: seL.L2 },
    ];

    for (const lbl of this.labels) {
      const wp = sub(lbl.pos, o);
      const p = project(wp);
      if (p && p.front) {
        this.hud.markers.set(lbl.id, 'poi', '●', p.x, p.y, true, lbl.name);
      } else {
        this.hud.markers.set(lbl.id, 'poi', '●', 0, 0, false, lbl.name);
      }
    }
  }

  findLabel(id: string): MapLabel | undefined {
    return this.labels.find((l) => l.id === id);
  }
}
