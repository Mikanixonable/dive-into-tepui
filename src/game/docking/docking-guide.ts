import * as THREE from 'three/webgpu';
import { lenSq } from '../../math/vec3';
import { LOCAL_FORWARD, qFromUnitVectors } from '../../math/quat';
import { FloatingOrigin } from '../camera/floating-origin';
import { Player } from '../player/player';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { Docking, DockingCandidate } from './docking';
import type { ProjectFn } from '../camera/camera-system';
import { currentThemePalette } from '../../theme';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import { MARKER_PRIORITY } from '../marker/crowding';

const DOCK_GUIDE_SHOW_DIST = 300;       // [m] ガイドを表示するポート接続点までの距離

const GUIDE_MARKER_KEY = 'docking-guide';
const AXIS_LENGTH = 32;
const RING_RADIUS = 8;
const RING_SEGMENTS = 64;

const escapeLabelHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

// 接続点の軸線とリングは生成時に一度だけ確保し、毎フレームは位置・姿勢・色だけを同期する。
export class DockingGuide {
  private readonly root: THREE.Group;
  private readonly axis: THREE.Line;
  private readonly ring: THREE.LineLoop;
  private readonly axisMaterial: THREE.LineBasicMaterial;
  private readonly ringMaterial: THREE.LineBasicMaterial;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly markerManager: MarkerManager,
    private readonly entities: DynamicSystem,
    private readonly docking: Docking,
  ) {
    this.root = new THREE.Group();
    this.root.name = 'docking-guide';
    this.axisMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false });
    this.ringMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });

    const axisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, AXIS_LENGTH),
    ]);
    this.axis = new THREE.Line(axisGeometry, this.axisMaterial);
    this.axis.renderOrder = LINE_RENDER_ORDER.predicted + 1;

    const ringGeometry = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: RING_SEGMENTS }, (_, i) => {
        const a = (i / RING_SEGMENTS) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * RING_RADIUS, Math.sin(a) * RING_RADIUS, 0);
      }),
    );
    this.ring = new THREE.LineLoop(ringGeometry, this.ringMaterial);
    this.ring.renderOrder = LINE_RENDER_ORDER.predicted + 1;
    this.root.add(this.axis, this.ring);
    this.root.visible = false;
    this.scene.add(this.root);
  }

  sync(player: Player | null, fo: FloatingOrigin, project: ProjectFn): void {
    if (this.disposed) return;
    const candidate = player ? this.nearestCandidate(player) : null;
    // 軸線がカメラの背後へ回った候補は HUD ラベルと同じく非表示にする。
    if (!candidate || !project(candidate.position).front) {
      this.hide();
      return;
    }

    this.root.visible = true;
    this.root.position.copy(fo.RtoThreeV3(candidate.position));
    if (lenSq(candidate.normal) > 1e-12) {
      const q = qFromUnitVectors(LOCAL_FORWARD, candidate.normal);
      this.root.quaternion.set(q.x, q.y, q.z, q.w);
    }
    const color = candidate.canDock ? currentThemePalette().success : currentThemePalette().warning;
    this.axisMaterial.color.set(color);
    this.ringMaterial.color.set(color);

    const targetName = candidate.target.name || candidate.target.id;
    const safeTargetName = escapeLabelHtml(targetName);
    const connection = candidate.kind === 'slot' && candidate.slotIndex !== null
      ? `ドック ${candidate.slotIndex + 1}` : candidate.kind === 'hatch' ? '中央ハッチ' : '船首ポート';
    const state = candidate.canDock ? 'ドッキング可' : '調整中';
    const label = `${safeTargetName} / ${connection}<br>${state}<br>`
      + `距離 ${candidate.distance.toFixed(1)} m / 軸ずれ ${candidate.axisErrorDeg.toFixed(1)} deg / `
      + `相対速度 ${candidate.relSpeed.toFixed(1)} m/s`;
    this.markerManager.setPosition(
      GUIDE_MARKER_KEY, 'mk-docking-guide', '◎', candidate.position, project,
      label, 1, color, undefined, false, true, MARKER_PRIORITY.PRIMARY_TARGET,
    );
  }

  // ガイドの3D表示とマーカーを畳む。
  hide(): void {
    this.root.visible = false;
    this.markerManager.hide(GUIDE_MARKER_KEY);
  }

  private nearestCandidate(player: Player): DockingCandidate | null {
    const targets = [
      ...this.entities.bases.filter((base) => base.alive),
      ...this.entities.players.filter((other) => other !== player && other.alive),
    ];
    let nearest: DockingCandidate | null = null;
    for (const target of targets) {
      for (const candidate of this.docking.evaluateCandidates(player, target)) {
        if (candidate.distance > DOCK_GUIDE_SHOW_DIST) continue;
        if (!nearest || candidate.distance < nearest.distance) nearest = candidate;
      }
    }
    return nearest;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.markerManager.remove(GUIDE_MARKER_KEY);
    this.scene.remove(this.root);
    this.axis.geometry.dispose();
    this.ring.geometry.dispose();
    this.axisMaterial.dispose();
    this.ringMaterial.dispose();
  }
}
