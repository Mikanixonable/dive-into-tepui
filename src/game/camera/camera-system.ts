import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { ChaseCamera } from './chase-camera';
import { MapCamera } from './map-camera';
import { PipCamera } from './pip-camera';
import { MapMarkers } from './map-markers';
import { FocusGizmo } from './focus-gizmo';
import { MarkerManager } from '../marker/marker-manager';
import { Input } from '../input/input';
import { Player } from '../player/player';
import { FloatingOrigin } from '../floating-origin';
import { Vec3 } from '../../physics/vec3';
import { Projected } from '../../physics/projection';

export type ProjectFn = (worldPos: Vec3) => Projected;

// 戦闘ビュー(ChaseCamera)とマップビュー(MapCamera)を切り替えて駆動する。
// どちらも視点操作のみの責務のカメラで、このクラスが対称に内部保持する。
// マップモードのフォーカス候補(mapMarkers)とその選択 UI(focusGizmo)は「どこを注視
// するか」= mapCamera 寄りの責務なので、ここが所有する。フォーカス選択メニューの
// ノードメニューとの排他(右クリックの取り合い)は上位(game.ts)が調停する。
export class CameraSystem {
  readonly chaseCamera: ChaseCamera;
  readonly mapCamera: MapCamera;
  readonly pipCamera = new PipCamera();
  readonly mapMarkers: MapMarkers;
  private readonly focusGizmo = new FocusGizmo();
  mapMode = false;
  zoomActive = false;

  constructor(
    private readonly _hud: Hud,
    sfx: Sfx,
    markerManager: MarkerManager,
  ) {
    this.mapMarkers = new MapMarkers(markerManager);
    this.chaseCamera = new ChaseCamera(_hud, sfx);
    this.mapCamera = new MapCamera(_hud, sfx, this.mapMarkers);
    this.focusGizmo.onMenuFocus = (targetKey) => {
      this.mapCamera.focus = targetKey;
      const lbl = this.mapMarkers.findLabel(targetKey);
      if (lbl) this._hud.hint(`${lbl.name} にフォーカス`);
    };
  }

  // マップラベル(フォーカス候補)を右クリックしたときの処理: 最寄りラベル(MAP_LABEL_PICK_PX
  // 以内)があればフォーカス選択メニューを開き、無ければ閉じる。ノードに消費されなかった
  // 右クリックのフォールバック先として game.ts から呼ばれる。
  handleFocusRightClick(clientX: number, clientY: number): void {
    const project = this.activeCameraProjection;
    let bestKey: string | null = null;
    let bestD = C.MAP_LABEL_PICK_PX * C.MAP_LABEL_PICK_PX;
    for (const lbl of this.mapMarkers.labels) {
      const p = project(lbl.pos);
      if (!p.front) continue;
      const d = (p.x - clientX) * (p.x - clientX) + (p.y - clientY) * (p.y - clientY);
      if (d < bestD) {
        bestD = d;
        bestKey = lbl.id;
      }
    }
    if (bestKey !== null) this.focusGizmo.openMenu(clientX, clientY, bestKey);
    else this.focusGizmo.closeMenu();
  }

  closeFocusMenu(): void {
    this.focusGizmo.closeMenu();
  }

  get activeCamera(): THREE.PerspectiveCamera {
    return this.mapMode ? this.mapCamera.camera : this.chaseCamera.camera;
  }

  get activeCameraPos(): Vec3 {
    return this.mapMode ? this.mapCamera.position : this.chaseCamera.position;
  }

  update(
    player: Player,
    sunAz: number,
    input: Input,
    dt: number,
  ): void {
    this.zoomActive = !this.mapMode && input.down('KeyZ');

    const keyYaw = (input.down('ArrowLeft') ? 1 : 0) + (input.down('ArrowRight') ? -1 : 0);
    const keyPitch = (input.down('ArrowDown') ? 1 : 0) + (input.down('ArrowUp') ? -1 : 0);
    const mouse = input.mouse();

    if (this.mapMode) {
      this.mapCamera.update(mouse, keyYaw, keyPitch, dt, sunAz);
    }
    else {
      this.chaseCamera.update(mouse, keyYaw, keyPitch, dt, player, this.zoomActive);
    }
    this.pipCamera.update(player);
  }

  // update() が算出した絶対 ECI の視点状態を、フローティングオリジン(fo)で補正して
  // 描画用のアクティブカメラへ反映する(平行移動のみ)。マーカー投影
  // (activeCameraProjection)や environment-scene がこの THREE.js カメラ姿勢を読むため、
  // game.sync() の先頭で(それらより先に)呼ぶ。
  sync(fo: FloatingOrigin): void {
    if (this.mapMode) this.mapCamera.sync(fo);
    else this.chaseCamera.sync(fo);
    this.pipCamera.sync(fo);
  }


  get activeCameraProjection(): ProjectFn {
    return this.mapMode ? this.mapCamera.projection : this.chaseCamera.projection;
  }
}