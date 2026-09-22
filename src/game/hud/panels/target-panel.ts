// 常設 TARGET パネル(#hud-target)の同期。ロック中ターゲットの名前・装甲・距離・
// 接近速度・相対速度を、ターゲットの固定中に表示する。
import { fmtDist, fmtSpeed, setElementText } from '../../../hud/utils';
import { SyncThrottle } from '../sync-throttle';
import { triangleHpMarkerSvg } from '../../marker/marker-shapes';
import type { ProteinCombatReadout } from '../../protein/protein-schema';

const SYNC_INTERVAL_MS = 100;

// ロック中ターゲットの1フレーム分の状態と、パネル本体の右クリック通知コールバック。
export interface TargetPanelViewModel {
  readonly name: string;
  readonly distanceM: number;
  readonly closingMps: number; // 正 = 近づいている。
  readonly relativeSpeedMps: number;
  // 装甲を持たない対象(基地)では null。
  readonly hp: number | null;
  readonly maxHp: number | null;
  // タンパク質構造を持たない対象では null。
  readonly protein: ProteinCombatReadout | null;
  onSelectRight(clientX: number, clientY: number): void;
}

export class TargetPanel {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  // 直近の sync で受け取った状態。右クリックはフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: TargetPanelViewModel | null = null;

  // els を保持し、パネル本体の右クリックイベントを最新のコールバックへ中継する。
  public constructor(private readonly els: ReadonlyMap<string, HTMLElement>) {
    this.els.get('tgtbody')?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.view?.onSelectRight(e.clientX, e.clientY);
    });
  }

  // 固定対象の有無を毎フレーム反映し、値の更新は間引く。view が null ならターゲットが無い。
  public sync(view: TargetPanelViewModel | null, nowMs: number): void {
    this.view = view;
    // 表示/非表示はターゲット固定の有無に直結するので、更新間隔とは別に毎フレーム反映する。
    this.els.get('hud-target')?.classList.toggle('hidden', view === null);

    if (!this.throttle.due(nowMs)) return;
    this.syncTarget(view);
  }

  // 値を既存の DOM へ書き込む。target が null なら名前を空欄にし、タンパク質欄を畳む。
  private syncTarget(target: TargetPanelViewModel | null): void {
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

    // 装甲メーターと数値表示。装甲を持たない対象では行ごと畳む。
    const { hp, maxHp } = target;
    this.els.get('tgt-armor-row')?.classList.toggle('hidden', hp === null || maxHp === null);
    if (hp !== null && maxHp !== null) {
      const clampedHp = Math.max(0, Math.min(maxHp, hp));
      const armorPercent = maxHp > 0 ? clampedHp / maxHp * 100 : 0;
      const armorValue = `${Math.floor(clampedHp)} / ${maxHp}`;
      const armorMeter = this.els.get('tgt-armor-meter');
      armorMeter?.setAttribute('aria-valuemax', String(maxHp));
      armorMeter?.setAttribute('aria-valuenow', String(clampedHp));
      armorMeter?.setAttribute('aria-valuetext', armorValue);
      const armorFill = this.els.get('tgt-armor-fill');
      if (armorFill) {
        armorFill.style.width = `${armorPercent}%`;
        armorFill.classList.toggle('danger', hp <= maxHp * 0.3);
      }
      setElementText(this.els, 'tgt-armor-value', armorValue);
    }
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
