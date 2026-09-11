// 多数の対象のマーカーを、投影後のスクリーン座標だけを見て破綻なく並べる表示器。画面上で
// 近接するものを1つの代表にまとめ、画面外へ出たものは画面端の方位マーカーに置き換える。
// 対象ごとの見た目とラベル内容(GroupedMarkerItem)は対象自身が用意する。
import { Vec3, len, sub } from '../../math/vec3';
import type { ViewMode } from '../../render/view-mode';
import { Projected } from '../../math/projection';
import type { ActiveCelestialLabel } from './celestial-markers';
import type { MarkerManager } from './marker-manager';
import { DIRECTION_GLYPH } from './marker-identity';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import { resolveCrowdingWinner, MARKER_PRIORITY, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO } from './crowding';
import { currentThemePalette } from '../../theme';
import type { ProjectFn, ScaleFn } from '../../math/projection';
import type { CelestialBody } from '../../physics/celestial-body';

export interface GroupedMarkerItem {
  key: string; // 対象を一意に識別するマーカーキー
  readonly kind: DynamicEntityKind; // 天体ラベル下のサブ行が内訳を数えるための種別
  cls: string; // 画面内マーカーの CSS クラス
  sym: string; // 画面内マーカーの記号
  pos: Vec3; // ワールド位置 (ECI)
  vel: Vec3; // ECI 速度。マップビューでの進行方向表示に使う
  priority: number; // 代表選出の優先度(大きいものが代表になる)
  name: string; // ラベルの主題。まとめられた代表には "xN" が付く
  detail?: string; // ラベル末尾の付随情報(距離など)
  bearingColor: string; // 画面外方位マーカーの色
  bearingSym?: string; // 画面外方位マーカーの記号。省略時は通常の矢印
  bearingClass?: string; // 画面外方位マーカーの CSS クラス
  bearingVisible?: boolean; // false のときは画面外でも方位マーカーを出さない
  color?: string; // 画面内マーカー自体の色。省略時は cls の CSS 色に従う
  symMarkup?: boolean; // sym をマークアップ(SVG など)として扱うか
  opacity?: number; // 画面内マーカーの不透明度。0 以下なら非表示
  occluded?: boolean; // 惑星遮蔽中は表示位置を維持したままフェードアウトする
}

// ターゲットに指定された対象のマーカーへ、代表選出の優先度と強調色を被せる。
export function withTargetRole(item: GroupedMarkerItem): GroupedMarkerItem {
  const signal = currentThemePalette().signal;
  return {
    ...item,
    cls: `${item.cls} mk-target`,
    priority: MARKER_PRIORITY.PRIMARY_TARGET,
    color: signal,
    bearingColor: signal,
  };
}

// これより画面上で近い対象どうしは、1つの代表マーカーへまとめる [px]。
// 天体ラベルと近接した対象をそのラベルへ譲る判定にも同じ近さを使う。
const CLUSTER_RADIUS_PX = 40;

const bearingKey = (key: string): string => `${key}-bearing`;

interface PlacedItem {
  item: GroupedMarkerItem;
  p: Projected;
  dist: number | undefined;
  count: number; // 自分がまとめた件数(1 = 単独)
  labeled: boolean; // false = 代表に吸収されたのでラベルを出さない
  groupMembers?: readonly GroupedMarkerItem[];
  hiddenByCelestialLabel?: boolean;
}

export class GroupedMarkers {
  // 前フレームに出したキー。集合から消えた対象のマーカーを片付けるために覚えておく。
  private shownKeys: readonly string[] = [];
  private readonly hiddenItemsList: GroupedMarkerItem[] = [];
  // 天体ラベルとの近接で前フレームに隠したキー(depth-guard のヒステリシス用)。
  private prevHiddenByCelestialLabel = new Set<string>();

  // 直前の sync で天体ラベルへラベルを譲った項目。天体ラベル下のサブ行の候補になる。
  public getHiddenItems(): readonly GroupedMarkerItem[] {
    return this.hiddenItemsList;
  }

  public constructor(private readonly markerManager: MarkerManager) { }

  // items のマーカーをこのフレームの位置へ置き、前フレームから消えた対象のマーカーを片付ける。
  // 全て隠すには空配列を渡す。マップビューでは方位マーカーの代わりに、マーカー自体を vel の
  // 進行方向へ回す(円軌道では静止画から回転方向が読めないため)。
  public sync(
    items: readonly GroupedMarkerItem[],
    project: ProjectFn,
    view: ViewMode,
    scale: ScaleFn,
    celestialLabels: readonly ActiveCelestialLabel[] = [],
    celestialBodies: readonly CelestialBody[] = [],
    cameraPos?: Vec3,
  ): void {
    const placed: PlacedItem[] = items.map(
      (item) => ({ item, p: project(item.pos), dist: cameraPos ? len(sub(item.pos, cameraPos)) : undefined, count: 1, labeled: true }),
    );
    this.groupNearby(placed, celestialLabels);

    for (const m of placed) {
      const opacity = m.item.opacity ?? 1;
      if (m.item.occluded) {
        this.markerManager.fadeOut(m.item.key);
        this.markerManager.hide(bearingKey(m.item.key));
        continue;
      }
      if (opacity <= 0) {
        this.markerManager.hide(m.item.key);
        this.markerManager.hide(bearingKey(m.item.key));
        continue;
      }
      const label = m.labeled ? this.label(m.item, m.count, m.groupMembers) : '';
      const rotationDeg = view === 'map'
        ? this.markerManager.headingRotationDeg(m.item.pos, m.item.vel, project, scale, celestialBodies)
        : undefined;
      this.markerManager.set(
        m.item.key, m.item.cls, m.item.sym, m.p.x, m.p.y, m.p.front, label, opacity, m.item.color,
        rotationDeg, m.item.symMarkup, false, m.item.priority, m.dist,
      );
      // 画面外(背面を含む)の対象は、画面端の方位マーカーで方位を示す。
      if (view === 'map' || m.item.bearingVisible === false) this.markerManager.hide(bearingKey(m.item.key));
      else this.markerManager.setBearing(
        bearingKey(m.item.key), m.item.bearingClass ?? 'mk-dir', m.item.bearingSym ?? DIRECTION_GLYPH.bearing,
        m.p, '', 1, m.item.bearingColor,
      );
    }

    this.hiddenItemsList.length = 0;
    const addedKeys = new Set<string>();

    for (const m of placed) {
      // 天体ラベルへラベルを譲り、惑星に遮蔽されていない対象を天体サブ行の候補にする。
      if (m.hiddenByCelestialLabel && !m.item.occluded && m.p.front) {
        if (m.groupMembers && m.groupMembers.length > 0) {
          for (const member of m.groupMembers) {
            if (!addedKeys.has(member.key) && !member.occluded) {
              addedKeys.add(member.key);
              this.hiddenItemsList.push(member);
            }
          }
        } else if (!addedKeys.has(m.item.key)) {
          addedKeys.add(m.item.key);
          this.hiddenItemsList.push(m.item);
        }
      }
    }

    this.retire(items.map((item) => item.key));
  }

  // 画面手前にあるものだけをクラスタ化し、優先度が最大のものを代表に据える。
  // 天体ラベルと近接している船マーカーは天体優先(天体 > 船)でラベルを落とす。
  private groupNearby(placed: readonly PlacedItem[], celestialLabels: readonly ActiveCelestialLabel[]): void {
    // 画面座標が近いものを同じグループへまとめる
    const groups: PlacedItem[][] = [];
    for (const m of placed) {
      if (!m.p.front || (m.item.opacity ?? 1) <= 0) continue;
      const near = groups.find((g) => this.isNear(g[0]!.p, m.p));
      if (near) near.push(m);
      else groups.push([m]);
    }
    // グループ内は優先度最大を代表にし、残りはラベルを落とす
    for (const g of groups) {
      if (g.length <= 1) continue;
      g.sort((a, b) => b.item.priority - a.item.priority);
      g[0]!.count = g.length;
      g[0]!.groupMembers = g.map((m) => m.item);
      for (const m of g.slice(1)) m.labeled = false;
    }
    // 天体ラベルと画面上で近接している船マーカーはラベルを隠す。ただし船がカメラに著しく
    // 近く天体が著しく遠い(depth-guard)場合は、優先度(天体 > 船)に関わらず船を残す —
    // 手前の船が奥の天体ラベルに隠され続けることを防ぐ(DEVELOP/SPEC/MAP.md 7.2 節)。
    const nowHiddenByCelestialLabel = new Set<string>();
    if (celestialLabels.length > 0) {
      for (const m of placed) {
        if (!m.labeled || !m.p.front) continue;
        for (const c of celestialLabels) {
          if (!c.labelVisible || Math.hypot(m.p.x - c.x, m.p.y - c.y) >= CLUSTER_RADIUS_PX) continue;
          // 天体ラベル側(c)には、前フレームの間引き状態に依らない基準の depthGuardRatio を当てる(false)。
          const pick = resolveCrowdingWinner(
            m.item.key, m.item.priority, m.dist, this.prevHiddenByCelestialLabel.has(m.item.key),
            c.id, c.priority, c.dist, false,
            DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO, true,
          );
          if (pick !== 'a') continue;
          m.labeled = false;
          m.hiddenByCelestialLabel = true;
          nowHiddenByCelestialLabel.add(m.item.key);
          break;
        }
      }
    }
    this.prevHiddenByCelestialLabel = nowHiddenByCelestialLabel;
  }

  // a と b がクラスタ化する距離内にあるか判定する。
  private isNear(a: Projected, b: Projected): boolean {
    return Math.hypot(a.x - b.x, a.y - b.y) < CLUSTER_RADIUS_PX;
  }

  // 代表のラベル文字列を組み立てる。
  private label(item: GroupedMarkerItem, count: number, members?: readonly GroupedMarkerItem[]): string {
    // 2つ近接: それぞれの正式名称を各自の色で2行に。3つ以上: "xN" の件数表記に。
    if (count === 2 && members && members.length >= 2) {
      const line = (m: GroupedMarkerItem): string => m.color
        ? `<span style="color:${m.color}">${m.name}</span>`
        : m.name;
      return `${line(members[0]!)}\n${line(members[1]!)}`;
    }
    if (count >= 3) {
      return `x${count}`;
    }
    return item.detail ? `${item.name}\n${item.detail}` : item.name;
  }

  // 前フレームに出して keys に無いマーカーを DOM ごと片付ける。key は対象ごとに一意で増え続ける
  // ので、隠さずに消す。
  private retire(keys: readonly string[]): void {
    const kept = new Set(keys);
    for (const key of this.shownKeys) {
      if (kept.has(key)) continue;
      this.markerManager.remove(key);
      this.markerManager.remove(bearingKey(key));
    }
    this.shownKeys = keys;
  }
}
