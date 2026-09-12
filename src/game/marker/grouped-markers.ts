// 多数の対象のマーカーを、投影後のスクリーン座標だけを見て破綻なく並べる表示器。画面上で
// 近接するものを1つの代表にまとめ、画面外へ出たものは画面端の方位マーカーに置き換える。
// 対象ごとの見た目とラベル内容(GroupedMarkerItem)は対象自身が用意する。
import { Vec3, len, sub } from '../../math/vec3';
import { Projected } from '../../math/projection';
import type { ActiveCelestialLabel } from './celestial-markers';
import { MARKER_PRIORITY } from './marker-priority';
import { bearingPlacement, headingRotationDeg } from './marker-placement';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import { resolveCrowdingWinner, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO } from '../../marker/crowding';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerSink } from '../../marker/marker-sink';
import { currentThemePalette } from '../../theme';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { CelestialBody } from '../../physics/celestial-body';

// 画面外へ出た対象を画面端の円周上で指す方位マーカーの見た目。
export interface BearingMarker {
  readonly cls: string;
  readonly sym: string; // 上向きの記号
  readonly color: string;
  // 画面外へ出たときに出すか。
  readonly visible: boolean;
  readonly priority: number;
  // 近接まとめでアイコンの扱いが既に決まっている種別か。
  readonly clustered: boolean;
}

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
  bearing: BearingMarker; // 画面外方位マーカー
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
    bearing: { ...item.bearing, color: signal },
  };
}

// これより画面上で近い対象どうしは、1つの代表マーカーへまとめる [px]。
// 天体ラベルと近接した対象をそのラベルへ譲る判定にも同じ近さを使う。
const CLUSTER_RADIUS_PX = 40;

const bearingKey = (key: string): string => `${key}-bearing`;

interface PlacedItem {
  item: GroupedMarkerItem;
  p: Projected;
  dist: number;
  count: number; // 自分がまとめた件数(1 = 単独)
  labeled: boolean; // false = 代表に吸収されたのでラベルを出さない
  groupMembers?: readonly GroupedMarkerItem[];
  hiddenByCelestialLabel?: boolean;
}

export class GroupedMarkers {
  private readonly hiddenItemsList: GroupedMarkerItem[] = [];
  // 天体ラベルとの近接で前フレームに隠したキー(depth-guard のヒステリシス用)。
  private prevHiddenByCelestialLabel = new Set<string>();
  private readonly declarations: MarkerDeclaration[] = [];

  // 直前の sync で天体ラベルへラベルを譲った項目。天体ラベル下のサブ行の候補になる。
  public getHiddenItems(): readonly GroupedMarkerItem[] {
    return this.hiddenItemsList;
  }

  public constructor(private readonly group: MarkerSink) { }

  // 所有するマーカー群を取り除く。
  public dispose(): void { this.group.dispose(); }

  // items のマーカーをこのフレームの位置へ置く。全て消すには空配列を渡す。マップビューでは
  // 方位マーカーの代わりに、マーカー自体を vel の進行方向へ回す(円軌道では静止画から
  // 回転方向が読めないため)。
  public sync(
    items: readonly GroupedMarkerItem[], camera: CameraFrame, nowMs: number,
    celestialLabels: readonly ActiveCelestialLabel[] = [],
    celestialBodies: readonly CelestialBody[] = [],
  ): void {
    const project = camera.project;
    const mapView = camera.mode === 'map';
    const placed: PlacedItem[] = items.map(
      (item) => ({
        item, p: project(item.pos), dist: len(sub(item.pos, camera.position)), count: 1, labeled: true,
      }),
    );
    this.groupNearby(placed, celestialLabels);

    const declarations = this.declarations;
    declarations.length = 0;
    for (const m of placed) {
      const rotationDeg = mapView
        ? headingRotationDeg(m.item.pos, m.item.vel, project, camera.scale, celestialBodies)
        : undefined;
      declarations.push(this.itemDeclaration(m, rotationDeg));
      declarations.push(this.bearingDeclaration(m, mapView, camera));
    }
    this.group.sync(declarations, nowMs);

    this.collectHiddenItems(placed);
  }

  // このフレームに天体ラベルへラベルを譲った項目を、サブ行の候補として集め直す。
  private collectHiddenItems(placed: readonly PlacedItem[]): void {
    this.hiddenItemsList.length = 0;
    const addedKeys = new Set<string>();
    for (const m of placed) {
      // 天体ラベルへラベルを譲り、惑星に遮蔽されていない対象を天体サブ行の候補にする。
      if (!m.hiddenByCelestialLabel || m.item.occluded === true || !m.p.front) continue;
      if (m.groupMembers && m.groupMembers.length > 0) {
        for (const member of m.groupMembers) {
          if (addedKeys.has(member.key) || member.occluded === true) continue;
          addedKeys.add(member.key);
          this.hiddenItemsList.push(member);
        }
      } else if (!addedKeys.has(m.item.key)) {
        addedKeys.add(m.item.key);
        this.hiddenItemsList.push(m.item);
      }
    }
  }

  // 画面内マーカー1件の宣言。遮蔽中は畳み、不透明度が尽きた対象は伏せる。
  private itemDeclaration(m: PlacedItem, rotationDeg: number | undefined): MarkerDeclaration {
    const opacity = m.item.opacity ?? 1;
    const visible = m.item.occluded !== true && opacity > 0 && m.p.front;
    return {
      id: m.item.key,
      cls: m.item.cls,
      sym: m.item.sym,
      markup: m.item.symMarkup,
      x: m.p.x,
      y: m.p.y,
      front: visible,
      label: m.labeled ? this.label(m.item, m.count, m.groupMembers) : '',
      opacity,
      color: m.item.color,
      rotationDeg,
      priority: m.item.priority,
      dist: m.dist,
      occluded: m.item.occluded === true,
      clustered: true,
    };
  }

  // 画面外(背面を含む)の対象を画面端で指す方位マーカー1件の宣言。
  private bearingDeclaration(m: PlacedItem, mapView: boolean, camera: CameraFrame): MarkerDeclaration {
    const bearing = m.item.bearing;
    const placement = mapView || !bearing.visible || m.item.occluded === true || (m.item.opacity ?? 1) <= 0
      ? null : bearingPlacement(m.p, camera.viewport);
    return {
      id: bearingKey(m.item.key),
      cls: bearing.cls,
      sym: bearing.sym,
      x: placement?.x ?? 0,
      y: placement?.y ?? 0,
      front: placement !== null,
      color: bearing.color,
      rotationDeg: placement?.rotationDeg,
      priority: bearing.priority,
      clustered: bearing.clustered,
    };
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
}
