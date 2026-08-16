// 常設 TARGET パネル(#hud-target)の同期: ロック中ターゲットの名前・装甲・距離・
// 接近速度・相対速度だけを表示する。軌道要素・相対傾斜角はプロパティウィンドウが持ち、
// ここには出さない（戦闘=自艦の軌道要素は OrbitPanel、対象側は PropertyWindow の2系統に
// 整理し、同じ値を二重の書式で表示しない）。
import { fmtDist, fmtSpeed } from './utils';
import { relativeInfo } from './orbit-info';
import type { Attractor } from '../../physics/attractor';
import type { Game } from '../game';

const SYNC_INTERVAL_MS = 100;

interface TargetPanelData {
  readonly name: string;
  readonly distanceM: number;
  readonly closingMps: number; // 正 = 近づいている。
  readonly relativeSpeedMps: number;
  readonly hp: number;
  readonly maxHp: number;
}

export class TargetPanel {
  private nextSyncAt = 0;

  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {}

  public sync(game: Game, attractors: readonly Attractor[]): void {
    const player = game.player;
    const target = player ? game.targeter.aliveTarget : null;
    // 表示/非表示はターゲット固定の有無に直結するので、更新間隔とは別に毎フレーム反映する。
    this.els.get('tgtbody')?.closest<HTMLElement>('#hud-target')?.classList.toggle('hidden', target === null);

    const now = performance.now();
    if (now < this.nextSyncAt) return;
    this.nextSyncAt = now + SYNC_INTERVAL_MS;

    if (!player || !target) {
      this.syncTarget(null);
      return;
    }
    const relative = relativeInfo(player, target, attractors);
    this.syncTarget({
      name: target.name,
      distanceM: relative.dist,
      closingMps: relative.closing,
      relativeSpeedMps: relative.relSpeed,
      hp: 'hp' in target ? (target as { hp: number }).hp : 1000,
      maxHp: 'maxHp' in target ? (target as { maxHp: number }).maxHp : 1000,
    });
  }

  // 安定した DOM へ値だけを同期し、高速更新でも読み上げ対象の要素を作り直さない。
  private syncTarget(target: TargetPanelData | null): void {
    if (!target) {
      this.setText('tgtname', '—');
      return;
    }

    this.setText('tgtname', target.name);
    this.setText('tgt-dist', fmtDist(target.distanceM));
    this.setText('tgt-closing', fmtSpeed(target.closingMps));
    this.setText('tgt-relative-speed', fmtSpeed(target.relativeSpeedMps));

    const clampedHp = Math.max(0, Math.min(target.maxHp, target.hp));
    const armorPercent = target.maxHp > 0 ? clampedHp / target.maxHp * 100 : 0;
    const armorValue = `${Math.floor(clampedHp)} / ${target.maxHp}`;
    const armorMeter = this.els.get('tgt-armor-meter');
    armorMeter?.classList.toggle('critical', target.hp <= target.maxHp * 0.3);
    armorMeter?.setAttribute('aria-valuemax', String(target.maxHp));
    armorMeter?.setAttribute('aria-valuenow', String(clampedHp));
    armorMeter?.setAttribute('aria-valuetext', armorValue);
    const armorFill = this.els.get('tgt-armor-fill');
    if (armorFill) armorFill.style.width = `${armorPercent}%`;
    this.setText('tgt-armor-value', armorValue);
  }

  // data-id 要素のテキストを、変化があるときだけ書き換える。
  private setText(id: string, text: string): void {
    const element = this.els.get(id);
    if (element && element.textContent !== text) element.textContent = text;
  }
}
