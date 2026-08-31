// 常設 TARGET パネル(#hud-target)の同期。ロック中ターゲットの名前・装甲・距離・
// 接近速度・相対速度を、ターゲットが固定されている間だけ表示する。
import { fmtDist, fmtSpeed, setElementText } from '../utils';
import { SyncThrottle } from '../sync-throttle';
import { relativeInfo } from '../orbit/orbit-info';
import { Ship } from '../../game-entity/ship';
import { Enemy } from '../../game-entity/enemy';
import { triangleHpMarkerSvg } from '../../marker/marker-shapes';
import type { CelestialBody } from '../../../physics/celestial-body';
import type { Game } from '../../game';
import type { ProteinHudSnapshot } from '../../protein/protein-schema';

// 基地は装甲を持たないため、ロック時の装甲バーへ出す満タン相当の目安値。
const BASE_ARMOR_PLACEHOLDER = 1000;

const SYNC_INTERVAL_MS = 100;

interface TargetPanelData {
  readonly name: string;
  readonly distanceM: number;
  readonly closingMps: number; // 正 = 近づいている。
  readonly relativeSpeedMps: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly protein: ProteinHudSnapshot | null;
}

export class TargetPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);

  // ロック中ターゲットの右クリック。ターゲットが無いときは呼ばれない。
  public onSelectRight: ((clientX: number, clientY: number) => void) | null = null;

  // els を保持し、パネル本体の右クリックを onSelectRight へ橋渡しする。
  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {
    this.els.get('tgtbody')?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onSelectRight?.(e.clientX, e.clientY);
    });
  }

  // 固定対象の有無を毎フレーム反映し、値の更新は間引く。celestialBodies は相対距離・速度の
  // 算出に使う。
  public sync(game: Game, celestialBodies: readonly CelestialBody[]): void {
    const player = game.player;
    const target = player ? game.targeter.aliveTarget : null;
    // 表示/非表示はターゲット固定の有無に直結するので、更新間隔とは別に毎フレーム反映する。
    this.els.get('hud-target')?.classList.toggle('hidden', target === null);

    if (!this.throttle.due()) return;

    if (!player || !target) {
      this.syncTarget(null);
      return;
    }
    const relative = relativeInfo(player, target, celestialBodies);
    this.syncTarget({
      name: target.name,
      distanceM: relative.dist,
      closingMps: relative.closing,
      relativeSpeedMps: relative.relSpeed,
      // 基地は装甲を持たないので、ロック中は満タン相当の目安値を出す。
      hp: target instanceof Ship ? target.hp : BASE_ARMOR_PLACEHOLDER,
      maxHp: target instanceof Ship ? target.maxHp : BASE_ARMOR_PLACEHOLDER,
      protein: target instanceof Enemy ? target.proteinHudSnapshot : null,
    });
  }

  // 安定した DOM へ値だけを同期し、高速更新でも読み上げ対象の要素を作り直さない。
  private syncTarget(target: TargetPanelData | null): void {
    if (!target) {
      setElementText(this.els, 'tgtname', '—');
      this.els.get('tgt-protein')?.classList.add('hidden');
      return;
    }

    // 名前・距離・速度系の基本値。
    setElementText(this.els, 'tgtname', target.name);
    setElementText(this.els, 'tgt-dist', fmtDist(target.distanceM));
    setElementText(this.els, 'tgt-closing', fmtSpeed(target.closingMps));
    setElementText(this.els, 'tgt-relative-speed', fmtSpeed(target.relativeSpeedMps));

    // 装甲メーターと数値表示。
    const clampedHp = Math.max(0, Math.min(target.maxHp, target.hp));
    const armorPercent = target.maxHp > 0 ? clampedHp / target.maxHp * 100 : 0;
    const armorValue = `${Math.floor(clampedHp)} / ${target.maxHp}`;
    const armorMeter = this.els.get('tgt-armor-meter');
    armorMeter?.setAttribute('aria-valuemax', String(target.maxHp));
    armorMeter?.setAttribute('aria-valuenow', String(clampedHp));
    armorMeter?.setAttribute('aria-valuetext', armorValue);
    const armorFill = this.els.get('tgt-armor-fill');
    if (armorFill) {
      armorFill.style.width = `${armorPercent}%`;
      armorFill.classList.toggle('danger', target.hp <= target.maxHp * 0.3);
    }
    setElementText(this.els, 'tgt-armor-value', armorValue);
    // タンパク質構造を持つ標的なら、フェーズと部位ごとの状態も表示する。
    const proteinPanel = this.els.get('tgt-protein');
    if (proteinPanel) {
      proteinPanel.classList.toggle('hidden', target.protein === null);
      if (target.protein) {
        setElementText(this.els, 'tgt-protein-phase', target.protein.phase.toUpperCase());
        const rows = target.protein.sites.map((site) => {
          const ratio = site.maxHp > 0 ? Math.max(0, Math.min(1, site.hp / site.maxHp)) : 0;
          const status = site.disabled ? '停止' : `${Math.floor(site.hp)} / ${site.maxHp}`;
          const glyph = site.disabled ? '▽' : site.attackable ? '▲' : '△';
          const hpIcon = triangleHpMarkerSvg(site.hp, site.maxHp);
          return `<div class="protein-site-row${site.disabled ? ' disabled' : ''}" style="--protein-site-hp:${ratio.toFixed(3)}"><span class="protein-site-glyph" aria-hidden="true">${glyph}</span><span class="protein-site-label">${site.abbreviation}</span><span class="protein-site-hp-icon">${hpIcon}</span><output>${status}</output></div>`;
        }).join('');
        const siteRows = this.els.get('tgt-protein-sites');
        if (siteRows && siteRows.innerHTML !== rows) siteRows.innerHTML = rows;
        setElementText(this.els, 'tgt-integrity-value', `${Math.floor(target.protein.integrityHp)} / ${target.protein.integrityMaxHp}`);
      }
    }
  }
}
