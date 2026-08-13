// 常設 TARGET パネル(#hud-target)の同期: ロック中ターゲットの名前・装甲・距離・接近速度・
// 相対速度だけを表示する。軌道要素・相対傾斜角は右クリックのプロパティウィンドウが持ち、
// ここには出さない(戦闘=自艦の軌道要素は OrbitPanel、対象側は PropertyWindow の2系統に
// 整理し、同じ値を二重の書式で表示しない)。
import { ACCENT, BAR_BG, BG, DANGER, FONT_XS, SPACE_2, TEXT_DIM, TEXT_STRONG, TRANSITION_FAST } from '../theme';
import { fmtDist, fmtSpeed } from './utils';
import { relativeInfo } from './orbit-info';
import { Attractor } from '../../physics/attractor';
import type { Game } from '../game';

const SYNC_INTERVAL_MS = 100;

interface TargetPanelData {
  name: string;
  dist: number;
  closing: number; // 接近速度 [m/s] (正 = 近づいている)
  relSpeed: number;
  hp: number;
  maxHp: number;
}

export class TargetPanel {
  private nextSyncAt = 0;

  constructor(private readonly els: Map<string, HTMLElement>) {}

  sync(game: Game, attractors: readonly Attractor[]): void {
    const player = game.player;
    const tgt = player ? game.targeter.aliveTarget : null;
    // 表示/非表示はターゲット固定の有無に直結するので、内容の更新間隔とは別に毎フレーム反映する。
    this.els.get('tgtbody')?.closest<HTMLElement>('#hud-target')?.classList.toggle('hidden', tgt === null);

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    if (!player || !tgt) {
      this.setTarget(null);
      return;
    }
    const rel = relativeInfo(player, tgt, attractors);
    this.setTarget({ name: tgt.name, hp: tgt.hp, maxHp: tgt.maxHp, ...rel });
  }

  // ターゲットパネルの本文を書き換える。t が null ならプレースホルダ表示にする。
  private setTarget(t: TargetPanelData | null): void {
    const body = this.els.get('tgtbody');
    if (!body) return;
    const title = this.els.get('tgtname');
    if (!t) {
      if (title) title.textContent = 'TARGET';
      body.innerHTML = `<div style="color:${TEXT_DIM}">ターゲットなし</div>`;
      return;
    }
    if (title) title.textContent = t.name;
    body.innerHTML = `
      <div class="row"><span class="k">距離</span><span class="v">${fmtDist(t.dist)}</span></div>
      <div class="row"><span class="k">接近速度</span><span class="v">${fmtSpeed(t.closing)}</span></div>
      <div class="row"><span class="k">相対速度</span><span class="v">${fmtSpeed(t.relSpeed)}</span></div>
      <div class="row"><span class="k">装甲</span><span class="v"><div style="display:inline-block; position:relative; width:120px; height:12px; background:${BAR_BG}; vertical-align:middle; margin-left:${SPACE_2};"><div style="width:${Math.max(0, Math.min(100, (t.hp / t.maxHp) * 100))}%; height:100%; background:${t.hp <= t.maxHp * 0.3 ? DANGER : ACCENT}; transition:width ${TRANSITION_FAST};"></div><div style="position:absolute; right:4px; top:0; bottom:0; display:flex; align-items:center; font-size:${FONT_XS}; color:${TEXT_STRONG}; text-shadow:0 0 2px ${BG}, 0 0 2px ${BG};">${Math.floor(t.hp)} / ${t.maxHp}</div></div></span></div>
      <div class="row" style="color:${TEXT_DIM}; font-size:${FONT_XS};">軌道要素は右クリックで表示</div>`;
  }
}
