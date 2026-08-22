// 常設 ORBIT パネル(#hud-orbit)の同期: 自艦の基準・高度・速度・遠地点/近地点・傾斜角・
// 周期・動圧・機体温度、および基準切替のセグメントコントロール。戦闘ビュー専用 — マップ
// ビューでは畳む(対象側の軌道要素はプロパティウィンドウが持ち、ここでは二重に出さない)。
import * as C from '../const';
import { fmtDist, fmtSpeed, fmtTime } from './utils';
import { orbitInfo } from './orbit-info';
import { CelestialBody } from '../../physics/celestial-body';
import type { Game } from '../game';
import type { OrbitReferenceMode } from '../orbit-reference';
import { Button, SegmentedControl } from './widgets';

import { getApsisLabelSpec } from './orbit-labels';
import { Player } from '../player/player';

const SYNC_INTERVAL_MS = 100;

const REFERENCE_ITEMS: readonly (readonly [OrbitReferenceMode, string])[] = [
  ['auto', '自動'],
  ['earth', '地球'],
  ['moon', '月'],
  ['target', '航法ターゲット'],
];

export class OrbitPanel {
  private nextSyncAt = 0;
  private readonly referenceControl: SegmentedControl<OrbitReferenceMode>;
  // 軌道分析パネルの開閉は Hud が持つため、ここでは押されたことだけを伝える。ボタン構築時には
  // まだ配線されていないので、VesselPanel.setInput と同じ late injection にする。
  private openAnalysis: (() => void) | null = null;

  constructor(private readonly els: Map<string, HTMLElement>) {
    this.referenceControl = new SegmentedControl('基準', REFERENCE_ITEMS, (mode) => {
      this.game?.orbitReference.setMode(mode);
    });
    this.els.get('reference-row')?.appendChild(this.referenceControl.element);
    this.buildActionButtons();
  }

  // Hud から軌道分析パネルの開閉ハンドラを受け取る。
  setOpenAnalysisHandler(handler: () => void): void {
    this.openAnalysis = handler;
  }

  private buildActionButtons(): void {
    const container = this.els.get('orbit-actions');
    if (!container) return;
    const button = new Button('軌道分析', () => this.openAnalysis?.());
    container.appendChild(button.element);
  }

  private game: Game | null = null;

  sync(game: Game, celestialBodies: readonly CelestialBody[]): void {
    this.game = game;
    const entity = game.activeControllableEntity;
    const el = document.getElementById('hud-orbit');
    if (!entity) {
      el?.classList.add('hidden');
      return;
    }
    el?.classList.toggle('hidden', game.cameraSystem.overviewMode);

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    this.referenceControl.setSelected(game.orbitReference.selectedMode);
    const reference = game.orbitReference.resolve(
      entity.state.r, celestialBodies, game.navTarget, game.entities, game.ephemeris, entity.state.t,
    );
    const oi = orbitInfo(entity, reference);
    const apSpec = getApsisLabelSpec('ap', oi.centerId);
    const peSpec = getApsisLabelSpec('pe', oi.centerId);
    const thermal = entity instanceof Player ? entity.thermal : null;
    // 航法ターゲット基準で対象が重力天体でない(艦・基地・ラグランジュ点)場合は、
    // celestialBodyName の生 ID フォールバックより航法ターゲットの表示名を優先する。
    const centerName = !reference.attractor && game.navTarget.name ? game.navTarget.name : oi.centerName;
    this.setText('center', centerName);
    this.setText('alt', fmtDist(oi.alt));
    this.els.get('alt')?.classList.toggle('warn-hot', thermal?.altDescendWarned ?? false);
    this.setText('spd', fmtSpeed(oi.spd));
    this.setText('ap-label', `${apSpec.nameJa} ${apSpec.short}`);
    this.setText('pe-label', `${peSpec.nameJa} ${peSpec.short}`);
    this.setText('ap', fmtDist(oi.apAlt));
    this.setText('pe', fmtDist(oi.peAlt));
    this.setText('inc', isFinite(oi.incDeg) ? `${oi.incDeg.toFixed(2)}°` : '---');
    this.setText('prd', fmtTime(oi.period));
    // 動圧・機体温度は閾値超過で警告表示にする。
    const qEl = this.els.get('qdyn');
    if (qEl) {
      if (thermal) {
        qEl.textContent = thermal.qdyn >= 10 ? `${(thermal.qdyn / 1000).toFixed(2)} kPa` : '0.00 kPa';
        qEl.classList.toggle('warn-hot', thermal.qdyn > 0.5 * C.MAX_DYN_PRESSURE);
      } else {
        qEl.textContent = '---';
        qEl.classList.remove('warn-hot');
      }
    }
    const tEl = this.els.get('temp');
    if (tEl) {
      if (thermal) {
        tEl.textContent = `${thermal.hullTemp.toFixed(0)} K`;
        tEl.classList.toggle('warn-hot', thermal.hullTemp > 0.7 * C.MAX_HULL_TEMP);
      } else {
        tEl.textContent = '---';
        tEl.classList.remove('warn-hot');
      }
    }
  }

  // id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const e = this.els.get(id);
    if (e && e.textContent !== text) e.textContent = text;
  }
}
