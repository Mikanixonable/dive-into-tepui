// マップの視点設定と軌道描画フレーム設定をまとめるパネル。
import {
  FRAME_ROLES, type FrameAnchorSource, type FrameRotationSource,
  frameRoleAnchorId, frameRoleOf, rotationSourceKey,
} from '../../../physics/frame';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { CelestialBody } from '../../../physics/celestial-body';
import {
  type CameraReferencePlane, type CameraRotationFollow, rotationFollowKey,
} from '../../viewer/focus-camera-selection';
import type { CameraRotationMode } from '../../viewer/camera-orientation';
import type { ProjectionMode } from '../../../math/projection';
import type { ListedObject } from '../../pickable/listed-object';
import type { DisplayTimelineSource } from '../../viewer/display-timeline-selection';
import { LagrangePointMarker } from '../../marker/lagrange-point-marker';
import { isLagrangeId } from '../../celestial/lagrange-id';
import { expandHitTarget } from '../../../hud-kit/widgets/widget-base';
import { ObjectPicker, type ObjectPickerGroup } from '../../../hud-kit/windows/object-picker';
import type { OverlayManager } from '../../../hud-kit/overlay-manager';
import { groupPickables } from '../object-picker-groups';
import { AngleCompass, type AngleCompassCommands } from './angle-compass';
import { CameraOpticsBar, type CameraOpticsCommands } from './camera-optics-bar';
import {
  frameRoleName, referencePlaneLabel, rotationFollowLabel, rotationHintLabel,
  rotationSourceLabel, rotationTileLabel,
} from './frame-labels';
import {
  bodyClassGlyph, centerGlyphSvg, type CenterGlyphKind,
  frameDiagramSvg, linkGlyphSvg, rotationGlyphSvg,
} from './frame-glyphs';
import { TileStrip, type TileItem } from './tile-strip';
import { buildPanel } from './panel-shell';

const MAX_BODY_TILES = 3; // 中心タイル帯へ直接並べる近傍天体の最大数(自機・解除と合わせて5列へ収める)

const ROLE_GROUP: ObjectPickerGroup<string | null> = {
  label: '役割',
  items: FRAME_ROLES.map((role) => [frameRoleAnchorId(role), frameRoleName(role)] as const),
};

// 統合パネルが1フレームに映すカメラ側の状態。
export interface MapFrameCameraViewModel {
  readonly focusId: string | null;
  readonly rotationFollow: CameraRotationFollow | null;
  readonly availableRotationFollows: readonly CameraRotationFollow[];
  readonly cameraRotationMode: CameraRotationMode;
  readonly projection: ProjectionMode;
  readonly fovDeg: number;
  readonly referencePlane: CameraReferencePlane;
}

// 統合パネルが発行する操作。
export interface MapFrameCommands extends AngleCompassCommands, CameraOpticsCommands {
  selectCameraCenter(id: string | null): void;
  setRotationFollow(follow: CameraRotationFollow | null): void;
  setFrameCenter(id: string): void;
  setFrameRotation(rotatingWith: FrameRotationSource | null): void;
  setFollowCamera(on: boolean): void;
}

// タイトルに補助操作や説明を添えられるセクション見出しを作る。
function buildSectionHead(title: string): HTMLElement {
  const head = document.createElement('div');
  head.className = 'fc-sec-head';
  const label = document.createElement('span');
  label.className = 'fc-sec-label';
  label.textContent = title;
  head.appendChild(label);
  return head;
}

export class MapFramePanel {
  private readonly panel: HTMLElement;
  private readonly linkButton: HTMLButtonElement;
  private readonly linkIcon: HTMLElement;
  private readonly linkText: HTMLElement;
  private readonly diagramSvg: SVGSVGElement;
  private readonly sumCam: HTMLElement;
  private readonly sumFrm: HTMLElement;
  private readonly sumMeta: HTMLElement;
  private readonly camPicker: ObjectPicker<string | null>;
  private readonly camCenterTiles: TileStrip<string | null>;
  private readonly camLagrangeRow: TileStrip<string | null>;
  private readonly camRotHint: HTMLElement;
  private readonly camRotTiles: TileStrip<CameraRotationFollow | null>;
  private readonly detachedBox: HTMLElement;
  private readonly frmPicker: ObjectPicker<string>;
  private readonly frmCenterTiles: TileStrip<string>;
  private readonly frmRotTiles: TileStrip<FrameRotationSource | null>;
  private readonly compass: AngleCompass;
  private readonly opticsBar: CameraOpticsBar;

  private lastDiagramMarkup = '';
  private lastLinked: boolean | null = null;

  // 視点設定と軌道描画フレームの操作・状態表示を組み立てる。
  public constructor(
    panelRoot: HTMLElement,
    private readonly celestialBodies: CelestialBodies,
    private readonly displayTimeline: Pick<DisplayTimelineSource, 'frame' | 'followCamera'>,
    private readonly commands: MapFrameCommands,
    private readonly frameAnchors: Pick<FrameAnchorSource, 'attractorOf'>,
    overlayManager: OverlayManager,
    initialRotationMode: CameraRotationMode,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-map-frame', '視点と基準フレーム', 'VIEW');
    this.panel.classList.add('map-frame-panel');

    const link = this.buildLinkButton();
    this.linkButton = link.button;
    this.linkIcon = link.icon;
    this.linkText = link.text;
    this.panel.querySelector<HTMLElement>('.editorial-panel-head')!.appendChild(this.linkButton);

    const diagram = this.buildDiagramBox();
    this.diagramSvg = diagram.svg;
    this.sumCam = diagram.cam;
    this.sumFrm = diagram.frm;
    this.sumMeta = diagram.meta;
    this.panel.appendChild(diagram.box);

    // 中心(基準)セクション。
    const centerHead = buildSectionHead('中心（基準）');
    this.camPicker = new ObjectPicker<string | null>('', (id) => commands.selectCameraCenter(id), overlayManager);
    this.camPicker.element.classList.add('fc-inline-picker');
    centerHead.appendChild(this.camPicker.element);
    this.camCenterTiles = new TileStrip<string | null>(
      'fc-tile-grid fc-center-grid', '視点の基準', (id) => commands.selectCameraCenter(id),
    );
    this.camLagrangeRow = new TileStrip<string | null>(
      'fc-lagrange-strip hidden', 'ラグランジュ点の基準', (id) => commands.selectCameraCenter(id),
    );
    this.panel.append(centerHead, this.camCenterTiles.element, this.camLagrangeRow.element);

    // 回転セクション。
    const rotHead = buildSectionHead('回転の合わせ方');
    this.camRotHint = document.createElement('span');
    this.camRotHint.className = 'fc-sec-hint';
    rotHead.appendChild(this.camRotHint);
    this.camRotTiles = new TileStrip<CameraRotationFollow | null>(
      'fc-tile-grid fc-rot-grid', '視点の回転追従', (follow) => commands.setRotationFollow(follow),
    );
    this.panel.append(rotHead, this.camRotTiles.element);

    // 軌道分離時だけ開く独立セクション。
    const detached = this.buildDetachedBox(overlayManager);
    this.detachedBox = detached.box;
    this.frmPicker = detached.picker;
    this.frmCenterTiles = detached.centers;
    this.frmRotTiles = detached.rotations;
    this.panel.appendChild(this.detachedBox);

    // 角度コンパス + 下段光学バー。
    const compassHead = buildSectionHead('角度コンパス');
    const compassHint = document.createElement('span');
    compassHint.className = 'fc-sec-hint';
    compassHint.textContent = '面と向きを1クリックで整列';
    compassHead.appendChild(compassHint);
    this.compass = new AngleCompass(commands);
    this.opticsBar = new CameraOpticsBar(commands, initialRotationMode);
    this.panel.append(compassHead, this.compass.element, this.opticsBar.element);
  }

  // カメラと軌道描画の連動を切り替えるピルを作る。
  private buildLinkButton(): { button: HTMLButtonElement; icon: HTMLElement; text: HTMLElement } {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fc-link-pill';
    expandHitTarget(button);
    button.title = 'カメラと軌道描画の基準を連動/分離する';
    const icon = document.createElement('span');
    icon.className = 'fc-link-icon';
    const text = document.createElement('span');
    button.append(icon, text);
    button.addEventListener('click', (e) => {
      if (e.isTrusted) button.blur();
      this.commands.setFollowCamera(!this.displayTimeline.followCamera);
    });
    return { button, icon, text };
  }

  // 座標系の要約図と読み値を収める区画を作る。
  private buildDiagramBox(): {
    box: HTMLElement; svg: SVGSVGElement; cam: HTMLElement; frm: HTMLElement; meta: HTMLElement;
  } {
    const box = document.createElement('section');
    box.className = 'fc-diagram-box';
    box.setAttribute('aria-label', '現在の座標系の要約');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 94 74');
    svg.setAttribute('class', 'fc-diagram-svg');
    svg.setAttribute('aria-hidden', 'true');
    const summary = document.createElement('div');
    summary.className = 'fc-diagram-summary';
    summary.innerHTML = `
      <div class="fc-sum-row"><span class="fc-badge fc-badge-cam">視点</span><strong class="fc-sum-val" data-fc="cam">—</strong></div>
      <div class="fc-sum-row"><span class="fc-badge fc-badge-frm">軌道</span><strong class="fc-sum-val" data-fc="frm">—</strong></div>
      <div class="fc-sum-meta" data-fc="meta">—</div>`;
    box.append(svg, summary);
    return {
      box,
      svg,
      cam: summary.querySelector<HTMLElement>('[data-fc="cam"]')!,
      frm: summary.querySelector<HTMLElement>('[data-fc="frm"]')!,
      meta: summary.querySelector<HTMLElement>('[data-fc="meta"]')!,
    };
  }

  // カメラから独立した軌道描画基準の操作欄を作る。
  private buildDetachedBox(overlayManager: OverlayManager): {
    box: HTMLElement;
    picker: ObjectPicker<string>;
    centers: TileStrip<string>;
    rotations: TileStrip<FrameRotationSource | null>;
  } {
    const box = document.createElement('section');
    box.className = 'fc-detached-box hidden';
    box.setAttribute('aria-label', '軌道描画フレームの独立設定');
    const head = buildSectionHead('軌道描画フレーム（独立）');
    const picker = new ObjectPicker<string>('', (id) => this.commands.setFrameCenter(id), overlayManager);
    picker.element.classList.add('fc-inline-picker');
    head.appendChild(picker.element);
    const centers = new TileStrip<string>(
      'fc-tile-grid fc-center-grid fc-signal-tiles', '軌道描画の基準', (id) => this.commands.setFrameCenter(id),
    );
    const rotations = new TileStrip<FrameRotationSource | null>(
      'fc-tile-grid fc-rot-grid fc-signal-tiles', '軌道描画の回転系', (rot) => this.commands.setFrameRotation(rot),
    );
    box.append(head, centers.element, rotations.element);
    return { box, picker, centers, rotations };
  }

  // 内部 ID を役割名・天体名へ変換し、null は固定点と表示する。
  private idLabel(id: string | null): string {
    // 内部の役割 ID を表示名へ変換し、null は固定点として扱う。
    if (id === null) return '自由点';
    const role = frameRoleOf(id);
    return role !== null ? frameRoleName(role) : this.celestialBodies.nameOf(id);
  }

  // 中心 ID の意味に応じたタイル図案を返す。
  private glyphKindOf(id: string | null): CenterGlyphKind {
    // 役割 ID・ラグランジュ点・天体クラスから中心タイルの図案を決める。
    if (id === null) return 'free';
    const role = frameRoleOf(id);
    if (role === 'controlled') return 'ship';
    if (role === 'navTarget') return 'target';
    if (isLagrangeId(id)) return 'lagrange';
    const bodyClass = this.celestialBodies.bodyClassOf(id);
    return bodyClass !== null ? bodyClassGlyph(bodyClass) : 'ship';
  }

  // 視点または独立フレームの中心候補を、表示中の物体から組み立てる。
  private buildCenterTiles(
    members: readonly string[], pickables: readonly ListedObject[], includeRelease: boolean,
  ): TileItem<string | null>[] {
    // 自機を先頭に置き、表示中の天体を上限まで加えてから固定解除を末尾に置く。
    const byId = new Map(pickables.map((p) => [p.id, p] as const));
    const controlledId = frameRoleAnchorId('controlled');
    const items: TileItem<string | null>[] = [{
      key: controlledId, value: controlledId, label: '自機', title: '操作対象',
      glyphSvg: centerGlyphSvg('ship'),
    }];
    let addedBodies = 0;
    for (const id of members) {
      if (addedBodies >= MAX_BODY_TILES) break;
      const p = byId.get(id);
      if (p === undefined || p instanceof LagrangePointMarker) continue;
      items.push({
        key: id, value: id, label: p.name, title: p.name,
        glyphSvg: centerGlyphSvg(bodyClassGlyph(this.celestialBodies.bodyClassOf(id))),
      });
      addedBodies++;
    }
    if (includeRelease) {
      items.push({
        key: '__free__', value: null, label: '解除', title: '固定を解除(慣性空間の固定点)',
        glyphSvg: centerGlyphSvg('free'),
      });
    }
    return items;
  }

  // フォーカス親天体に属するラグランジュ点を選択候補にする。
  private buildLagrangeTiles(
    members: readonly string[], pickables: readonly ListedObject[], focusId: string | null,
  ): TileItem<string | null>[] {
    // 表示中の親天体ごとにまとめ、フォーカス中の親があればその点だけを出す。
    const memberSet = new Set(members);
    const byParent = new Map<string, LagrangePointMarker[]>();
    for (const p of pickables) {
      if (!(p instanceof LagrangePointMarker) || !memberSet.has(p.parentId)) continue;
      const list = byParent.get(p.parentId);
      if (list === undefined) byParent.set(p.parentId, [p]);
      else list.push(p);
    }
    if (byParent.size === 0) return [];
    const chosenParent = focusId !== null && byParent.has(focusId) ? focusId : [...byParent.keys()][0]!;
    return (byParent.get(chosenParent) ?? []).map((m) => ({
      key: m.id, value: m.id, label: `L${m.point}`, title: m.name,
    }));
  }

  // 指定時刻に使える公転・自転フレームを選択候補にする。
  private buildFrameRotationTiles(
    members: readonly string[], displayTime: number,
  ): TileItem<FrameRotationSource | null>[] {
    // 時刻に回転状態が定義されているものだけ、慣性・公転・自転の順で候補にする。
    const items: TileItem<FrameRotationSource | null>[] = [{
      key: '', value: null, label: '慣性', title: '慣性系(回転しない)',
      glyphSvg: rotationGlyphSvg(null),
    }];
    const revolvable: (readonly [string, CelestialBody])[] = [];
    for (const id of members) {
      const motion = this.celestialBodies.findMotion(id);
      if (motion === null || motion.primary === null) continue;
      revolvable.push([id, motion]);
    }
    for (const [id] of revolvable) {
      const source: FrameRotationSource = { kind: 'revolution', id };
      items.push({
        key: rotationSourceKey(source), value: source,
        label: rotationTileLabel(this.celestialBodies, source),
        title: rotationSourceLabel(this.celestialBodies, source),
        glyphSvg: rotationGlyphSvg(source),
      });
    }
    for (const [id, motion] of revolvable) {
      if (motion.spinRotationAt(displayTime) === null) continue;
      const source: FrameRotationSource = { kind: 'spin', id };
      items.push({
        key: rotationSourceKey(source), value: source,
        label: rotationTileLabel(this.celestialBodies, source),
        title: rotationSourceLabel(this.celestialBodies, source),
        glyphSvg: rotationGlyphSvg(source),
      });
    }
    for (const role of FRAME_ROLES) {
      const id = frameRoleAnchorId(role);
      if (this.frameAnchors.attractorOf(id, displayTime) === null) continue;
      const source: FrameRotationSource = { kind: 'revolution', id };
      items.push({
        key: rotationSourceKey(source), value: source,
        label: rotationTileLabel(this.celestialBodies, source),
        title: rotationSourceLabel(this.celestialBodies, source),
        glyphSvg: rotationGlyphSvg(source),
      });
    }
    return items;
  }

  // カメラと軌道描画の状態を要約し、独立した基準があれば図でも区別する。
  private syncSummary(cam: MapFrameCameraViewModel, linked: boolean): void {
    // 現在の視点と連動状態を要約し、独立した軌道基準があるかを図式へ反映する。
    const frame = this.displayTimeline.frame;
    const camRotKey = rotationFollowKey(cam.rotationFollow);
    const frmRotKey = rotationSourceKey(frame.rotatingWith);
    const isDetached = !linked && (frame.center !== cam.focusId || frmRotKey !== camRotKey);

    this.sumCam.textContent = `${this.idLabel(cam.focusId)}・${rotationFollowLabel(this.celestialBodies, cam.rotationFollow)}`;
    this.sumFrm.textContent = linked
      ? '視点に連動'
      : `${this.idLabel(frame.center)}・${rotationSourceLabel(this.celestialBodies, frame.rotatingWith)}`;
    const lensSummary = cam.projection === 'orthographic' ? '平行投影' : `透視 ${cam.fovDeg.toFixed(0)}°`;
    this.sumMeta.textContent = `${referencePlaneLabel(cam.referencePlane)} · ${lensSummary}`;

    const diagramMarkup = frameDiagramSvg({
      centerKind: this.glyphKindOf(cam.focusId),
      cameraRotating: cam.rotationFollow !== null,
      cameraRevolvingPair: cam.rotationFollow !== null && cam.rotationFollow.kind === 'revolution',
      frameDetached: isDetached,
      frameRotating: frame.rotatingWith !== null,
      orthographic: cam.projection === 'orthographic',
      sideView: this.compass.lastRequestedView === 'side',
    });
    if (diagramMarkup !== this.lastDiagramMarkup) {
      this.diagramSvg.innerHTML = diagramMarkup;
      this.lastDiagramMarkup = diagramMarkup;
    }
  }

  // 現在値と候補を各コントロールへ反映する。
  public sync(
    pickables: readonly ListedObject[], members: readonly string[], displayTime: number,
    cam: MapFrameCameraViewModel,
  ): void {
    // 連動状態が変わったときだけ独立設定欄とリンク表示を切り替える。
    const linked = this.displayTimeline.followCamera;
    if (this.lastLinked !== linked) {
      this.lastLinked = linked;
      this.linkButton.classList.toggle('on', linked);
      this.linkButton.setAttribute('aria-pressed', String(linked));
      this.linkIcon.innerHTML = linkGlyphSvg(linked);
      this.linkText.textContent = linked ? '軌道連動' : '軌道分離';
      this.detachedBox.classList.toggle('hidden', linked);
    }

    this.syncSummary(cam, linked);

    // 視点側の中心ピッカー・タイル・L 点行。
    this.camPicker.setGroups([
      { label: '', items: [[null, '固定を解除']] },
      ROLE_GROUP,
      ...groupPickables(this.celestialBodies, pickables, true),
    ]);
    this.camPicker.setSelected(cam.focusId);
    this.camCenterTiles.setItems(this.buildCenterTiles(members, pickables, true));
    this.camCenterTiles.setSelectedKey(cam.focusId ?? '__free__');

    const lagrangeTiles = this.buildLagrangeTiles(members, pickables, cam.focusId);
    this.camLagrangeRow.element.classList.toggle('hidden', lagrangeTiles.length === 0);
    if (lagrangeTiles.length > 0) {
      this.camLagrangeRow.setItems(lagrangeTiles);
      this.camLagrangeRow.setSelectedKey(cam.focusId);
    }

    // 視点側の回転タイル。
    this.camRotHint.textContent = rotationHintLabel(this.celestialBodies, cam.rotationFollow);
    this.camRotTiles.setItems([
      { key: '', value: null, label: '慣性', title: '慣性系(回転しない)', glyphSvg: rotationGlyphSvg(null) },
      ...cam.availableRotationFollows.map((follow) => ({
        key: rotationFollowKey(follow),
        value: follow,
        label: rotationTileLabel(this.celestialBodies, follow),
        title: rotationFollowLabel(this.celestialBodies, follow),
        glyphSvg: rotationGlyphSvg(follow),
      })),
    ]);
    this.camRotTiles.setSelectedKey(rotationFollowKey(cam.rotationFollow));

    // 軌道分離時のみ独立欄を同期。
    if (!linked) {
      const frame = this.displayTimeline.frame;
      this.frmPicker.setGroups([
        ROLE_GROUP as ObjectPickerGroup<string>,
        ...groupPickables(this.celestialBodies, pickables, false),
      ]);
      this.frmPicker.setSelected(frame.center);
      this.frmCenterTiles.setItems(this.buildCenterTiles(members, pickables, false) as TileItem<string>[]);
      this.frmCenterTiles.setSelectedKey(frame.center);
      this.frmRotTiles.setItems(this.buildFrameRotationTiles(members, displayTime));
      this.frmRotTiles.setSelectedKey(rotationSourceKey(frame.rotatingWith));
    }

    // コンパスと光学バーへカメラ設定を反映する。
    this.compass.sync(cam.referencePlane);
    this.opticsBar.sync(cam.projection, cam.fovDeg, cam.cameraRotationMode);
  }

  // ピッカーの登録を解除してパネルを取り除く。
  public dispose(): void {
    this.camPicker.dispose();
    this.frmPicker.dispose();
    this.panel.remove();
  }
}
