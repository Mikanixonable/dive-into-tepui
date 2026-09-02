// 天体ラベルの下へ、混雑で画面から消えた船・敵機・基地をサブ行としてぶら下げる。
// 近い天体では1隻ずつ名前を並べ、遠い天体では記号と個数だけの1行へ畳む。どの天体へ
// ぶら下げるかは対象を最も強く引く天体から辿り、そのラベルが出ていなければ親天体へ繰り上げる。
import { len, sub, type Vec3 } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import type { CelestialMotion } from '../../physics/celestial-motion';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { ProjectFn } from '../camera/camera-system';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { GroupedMarkerItem, GroupedMarkers } from './grouped-markers';
import type { MarkerManager } from './marker-manager';

// これより天体が遠ければ、サブ行を記号と個数だけの1行へ畳む [m]。
const STAGE2_DIST = 5e9;

// 1隻ずつ並べる段で使う行数の上限。これを超えたぶんは「+N 隻」へまとめる。
const MAX_LISTED_LINES = 3;

// 種別ごとのサブ行記号。マーカー本体の記号は SVG なので、文字だけで組む行には使えない。
const SUB_LABEL_GLYPH: Record<DynamicEntityKind, string> = {
  player: '▲', base: '⬡', enemy: '△', ammo: '▣', fuel: '◈',
};

// 今フレームの天体ラベル1件ぶんの表示状態。
export interface CelestialLabelState {
  readonly pos: Vec3;
  // 画面にマーカーが出ていて、サブ行の集約先になれるか。
  readonly shown: boolean;
  // 名前を描いているか。
  readonly labelShown: boolean;
  readonly markerClass: string;
  readonly markerLabel: string;
  // アイコンの字形。アイコンを描かないフレームは空文字。
  readonly glyph: string;
  readonly priority: number;
  readonly opacity: number;
  // 画面手前にあり、天体に遮られていないか。
  readonly drawable: boolean;
}

// サブ行を集約する先の天体 id と、そこへぶら下げる項目。
interface SubLabelEntry {
  readonly prefix: string;
  readonly item: GroupedMarkerItem;
}

export class CelestialSubLabels {
  private readonly entriesByBody = new Map<string, SubLabelEntry[]>();

  constructor(
    private readonly markerManager: MarkerManager,
    private readonly celestialSystem: CelestialSystem,
  ) {}

  // 隠れた項目を天体ラベルへ振り分け、集約先のラベルをサブ行付きへ描き直す。
  // labelStateOf は天体ラベルの今フレームの表示状態を引く関数で、ラベルを持たない id には null。
  sync(
    groupedMarkers: GroupedMarkers,
    labelStateOf: (id: string) => CelestialLabelState | null,
    celestialBodies: readonly CelestialMotion[],
    pivot: number,
    project: ProjectFn,
    cameraPos: Vec3,
  ): void {
    const hiddenItems = groupedMarkers.getHiddenItems();
    if (hiddenItems.length === 0) return;

    // まず隠れた項目を集約先の天体ごとに束ねる。
    this.entriesByBody.clear();
    for (const item of hiddenItems) {
      this.route(item, strongestAttractor(item.pos, celestialBodies, pivot).id, labelStateOf, cameraPos);
    }

    // 束ねた先のラベルを、サブ行を足した表記で置き直す。
    for (const [bodyId, entries] of this.entriesByBody) {
      const label = labelStateOf(bodyId);
      if (label === null || !label.labelShown || !label.shown) continue;
      const stage2 = len(sub(label.pos, cameraPos)) >= STAGE2_DIST;
      const subDivs = stage2 ? countLine(entries) : listedLines(entries);
      if (!label.drawable) continue;
      this.markerManager.setPosition(
        bodyId, label.markerClass, label.glyph, label.pos, project,
        `<span class="lbl-main">${label.markerLabel}</span>${subDivs.join('')}`,
        label.opacity, undefined, undefined, false, false, label.priority, cameraPos,
      );
    }
  }

  // 項目1件を集約先の天体ラベルへ割り当てる。遠い天体では主親天体へまとめ、近い天体では
  // 直近の天体ラベルへ付ける — そのラベルが出ていなければ「月:」のように名前を添えて親へ繰り上げる。
  private route(
    item: GroupedMarkerItem, centerId: string,
    labelStateOf: (id: string) => CelestialLabelState | null, cameraPos: Vec3,
  ): void {
    const centerLabel = labelStateOf(centerId);
    const centerShown = centerLabel !== null && centerLabel.shown;
    const distToCenter = centerLabel === null ? Infinity : len(sub(centerLabel.pos, cameraPos));
    const primaryId = this.celestialSystem.entityOf(centerId).motion.primary?.id ?? null;
    const primaryShown = primaryId !== null && (labelStateOf(primaryId)?.shown ?? false);

    // 遠い系ではプレフィックスを付けず主親天体へまとめ、近い系では直近の天体へ付ける。
    if (distToCenter >= STAGE2_DIST) {
      if (primaryShown && primaryId !== null) this.append(primaryId, '', item);
      else if (centerShown) this.append(centerId, '', item);
      return;
    }
    if (centerShown) this.append(centerId, '', item);
    else if (primaryShown && primaryId !== null) {
      this.append(primaryId, `${this.celestialSystem.nameOf(centerId)}: `, item);
    }
  }

  // 集約先ごとの束へ1件足す。
  private append(bodyId: string, prefix: string, item: GroupedMarkerItem): void {
    const list = this.entriesByBody.get(bodyId);
    if (list) list.push({ prefix, item });
    else this.entriesByBody.set(bodyId, [{ prefix, item }]);
  }
}

// 1隻ずつ名前を並べる段。上限を超えたぶんは末尾の「+N 隻」へまとめる。
function listedLines(entries: readonly SubLabelEntry[]): string[] {
  const sorted = [...entries].sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0));
  if (sorted.length <= MAX_LISTED_LINES) return sorted.map(subLabelLine);
  const shown = sorted.slice(0, MAX_LISTED_LINES - 1).map(subLabelLine);
  shown.push(`<div class="lbl-sub">+${sorted.length - (MAX_LISTED_LINES - 1)} 隻</div>`);
  return shown;
}

// サブ行1行ぶんのマークアップ。
function subLabelLine(entry: SubLabelEntry): string {
  return `<div class="lbl-sub">${entry.prefix}${SUB_LABEL_GLYPH[entry.item.kind]} ${entry.item.name}</div>`;
}

// 記号と個数だけの1行へ畳む段。1件も無ければ行を作らない。
function countLine(entries: readonly SubLabelEntry[]): string[] {
  const counts: Record<DynamicEntityKind, number> = { player: 0, enemy: 0, base: 0, ammo: 0, fuel: 0 };
  for (const entry of entries) counts[entry.item.kind]++;
  const order: readonly DynamicEntityKind[] = ['enemy', 'player', 'base', 'ammo', 'fuel'];
  const parts = order.filter((kind) => counts[kind] > 0).map((kind) => `${SUB_LABEL_GLYPH[kind]}${counts[kind]}`);
  return parts.length === 0 ? [] : [`<div class="lbl-sub">${parts.join(' ')}</div>`];
}
