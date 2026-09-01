// 恒星本体の見た目: 自己発光する実半径の球と、遠すぎて球として描けないときに置き換わる点像。
// 色と面の輝度は恒星ごとの値なので、呼び出し側が与える。
import * as THREE from 'three/webgpu';
import { Billboard, POINT_IMAGE_ANGULAR_SIZE } from './billboard';
import { glowMeanAlpha } from './glow-texture';
import { showsPhysicalSphere } from './screen-lod';
import { STAR_SHELL_RADIUS } from './stars';

// 点像を星殻上へ置くための書き込み先。
const POINT_POSITION = new THREE.Vector3();

export interface StarSphere {
  // 実球体と点像をシーンへ一度だけ登録する。
  addTo(scene: THREE.Scene): void;
  // 実球体と点像をまとめて表示/非表示にする。
  setVisible(visible: boolean): void;
  // 実球体か点像のどちらかが出ているか。
  readonly visible: boolean;
  // 描画座標 position・実半径 radius [m] の恒星を、見かけ直径 apparentDiameterPx [px] に
  // 応じて実球体か点像のどちらかで描く。
  sync(
    position: THREE.Vector3, radius: number, apparentDiameterPx: number,
    cameraQuaternion: THREE.Quaternion,
  ): void;
  // 見かけの大きさによらず実球体で描く。
  syncSphere(position: THREE.Vector3, radius: number): void;
  // 実球体と点像をどちらも隠す。
  hide(): void;
  // シーンから外し、GPU 資源を解放する。
  dispose(): void;
}

// 恒星の見た目を構築する。color は恒星面の色、surfaceRadiance はその面の輝度(描画が扱う
// 放射量の目盛り)。実位置・実半径・見かけの大きさを渡すのは呼び出し側。
export function createStarSphere(color: string | number, surfaceRadiance: number): StarSphere {
  return new StarSphereObject(color, surfaceRadiance);
}

// 実球体と点像の組。**遠ざかって球として描けなくなったら点像へ入れ替える** — 実半径のまま
// 描き続けると、見かけ径が 1px を切った時点で総光量がラスタライズの被覆率へ量子化され、
// サブピクセルの移動だけで光量が 0 と 1px ぶんの間を跳ぶ(レンズ効果がそれを画面いっぱいの
// 滲みの明滅として拡大する)。
class StarSphereObject implements StarSphere {
  private readonly mesh: THREE.Mesh;
  // 点像。**星殻上へ置く** — 実位置に置くと、戦闘視点の遠平面より遠い恒星が消える。
  // 描画順は星野の直後で、惑星の輝点と揃える。グローテクスチャの生成が DOM を要するので
  // addTo まで作らない。
  private point!: Billboard;

  constructor(
    private readonly color: string | number,
    private readonly surfaceRadiance: number,
  ) {
    this.mesh = createStarMesh(color, surfaceRadiance);
  }

  addTo(scene: THREE.Scene): void {
    this.point = new Billboard(this.color, -9);
    scene.add(this.mesh, this.point.mesh);
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
    this.point.mesh.visible = visible;
  }

  get visible(): boolean { return this.mesh.visible || this.point.mesh.visible; }

  sync(
    position: THREE.Vector3, radius: number, apparentDiameterPx: number,
    cameraQuaternion: THREE.Quaternion,
  ): void {
    if (showsPhysicalSphere(apparentDiameterPx)) {
      this.syncSphere(position, radius);
      return;
    }
    this.mesh.visible = false;
    this.point.sync(
      POINT_POSITION.copy(position).setLength(STAR_SHELL_RADIUS),
      POINT_IMAGE_ANGULAR_SIZE * STAR_SHELL_RADIUS,
      this.pointBrightness(radius, position.length()),
      cameraQuaternion,
    );
  }

  syncSphere(position: THREE.Vector3, radius: number): void {
    this.point.hide();
    this.mesh.visible = true;
    this.mesh.position.copy(position);
    this.mesh.scale.setScalar(radius);
  }

  hide(): void {
    this.mesh.visible = false;
    this.point.hide();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.point.mesh.removeFromParent();
    this.point.dispose();
  }

  // 距離 distance [m] にある半径 radius [m] の恒星を点像で描くときの、板の面の明るさ。
  // **球として描いたときと同じ総光量を運ぶ** — 恒星円盤が張る立体角ぶんの光を、板が張る
  // 立体角(角の広がりの二乗)とグローの平均不透明度で割って面の明るさへ戻す。角の広がりは
  // 距離によらないので、これは距離の二乗で薄れ、球との切り替えで絵が飛ばない。
  private pointBrightness(radius: number, distance: number): number {
    const diskSolidAngle = Math.PI * (radius / distance) ** 2;
    const spriteSolidAngle = POINT_IMAGE_ANGULAR_SIZE ** 2 * glowMeanAlpha();
    return this.surfaceRadiance * diskSolidAngle / spriteSolidAngle;
  }
}

// 単位球(半径1)の恒星本体。自己発光する光源そのものなので、シーンの照明を受けない
// MeshBasicMaterial で塗る。実位置・実半径へ置くのは StarSphereObject の仕事。
function createStarMesh(color: string | number, surfaceRadiance: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(surfaceRadiance),
  });
  return new THREE.Mesh(geo, mat);
}
