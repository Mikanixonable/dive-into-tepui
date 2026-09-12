// 恒星本体の見た目: 自己発光する実半径の球と、遠すぎて球として描けないときに置き換わる点像。
import * as THREE from 'three/webgpu';
import { Billboard, POINT_IMAGE_ANGULAR_SIZE } from '../billboard';
import { glowMeanAlpha } from '../glow-texture';
import { showsPhysicalSphere } from './screen-lod';
import { STAR_SHELL_RADIUS } from '../stars';

// 点像を星殻上へ置くための書き込み先。
const POINT_POSITION = new THREE.Vector3();
// 可視域の太陽型恒星に対する線形周縁減光係数(Van Hamme 1993, AJ 106, 2096)。
const STELLAR_LIMB_DARKENING = 0.6;
// 投影円盤上の平均 μ は2/3なので、線形則の円盤平均は 1 - u/3。
const STELLAR_LIMB_MEAN = 1 - STELLAR_LIMB_DARKENING / 3;

// 視線と面法線の余弦 μ に対する、円盤平均で正規化した恒星面の相対輝度。
export function stellarLimbIntensity(mu: number): number {
  const boundedMu = Math.max(0, Math.min(1, mu));
  return (1 - STELLAR_LIMB_DARKENING * (1 - boundedMu)) / STELLAR_LIMB_MEAN;
}

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
  syncSphere(position: THREE.Vector3, radius: number, cameraQuaternion: THREE.Quaternion): void;
  // 実球体と点像をどちらも隠す。
  hide(): void;
  // シーンから外し、GPU 資源を解放する。
  dispose(): void;
}

// 恒星の見た目を組む。color は恒星面の色、surfaceRadiance はその面の輝度(描画が扱う放射量の
// 目盛り)。位置・半径は sync で与える。
export function createStarSphere(color: string | number, surfaceRadiance: number): StarSphere {
  return new StarSphereObject(color, surfaceRadiance);
}

// 実球体と点像の組。遠ざかって球として描けなくなったら点像へ入れ替える — 1px を切った球は
// 総光量がラスタライズの被覆率へ量子化され、サブピクセルの移動で明滅する。
class StarSphereObject implements StarSphere {
  private readonly mesh: THREE.Mesh;
  // 点像。星殻上へ置く — 実位置では遠平面より遠い恒星が消える。addTo で作る(グローテクスチャの
  // 生成が DOM を要する)。
  private point!: Billboard;

  // 実球体を組む。点像は addTo で作る。
  public constructor(
    private readonly color: string | number,
    private readonly surfaceRadiance: number,
  ) {
    this.mesh = createStarMesh(color, surfaceRadiance);
  }

  // 点像の描画順は星野の直後で、惑星の輝点と揃える。
  public addTo(scene: THREE.Scene): void {
    this.point = new Billboard(this.color, -9);
    scene.add(this.mesh, this.point.mesh);
  }

  // 実球体と点像の可視をまとめて切り替える。
  public setVisible(visible: boolean): void {
    this.mesh.visible = visible;
    this.point.mesh.visible = visible;
  }

  public get visible(): boolean { return this.mesh.visible || this.point.mesh.visible; }

  // 点像の明るさは、球で描いたときと同じ総光量になるよう距離から引く。
  public sync(
    position: THREE.Vector3, radius: number, apparentDiameterPx: number,
    cameraQuaternion: THREE.Quaternion,
  ): void {
    if (showsPhysicalSphere(apparentDiameterPx)) {
      this.syncSphere(position, radius, cameraQuaternion);
      return;
    }
    // 点像は星殻上へ、向きだけを保って置く。
    this.mesh.visible = false;
    this.point.sync(
      POINT_POSITION.copy(position).setLength(STAR_SHELL_RADIUS),
      POINT_IMAGE_ANGULAR_SIZE * STAR_SHELL_RADIUS,
      this.pointBrightness(radius, position.length()),
      cameraQuaternion,
    );
  }

  // 点像を隠し、実球体を実位置・実半径へ置く。
  public syncSphere(
    position: THREE.Vector3, radius: number, cameraQuaternion: THREE.Quaternion,
  ): void {
    this.point.hide();
    this.mesh.visible = true;
    this.mesh.position.copy(position);
    this.mesh.scale.setScalar(radius);
    // 頂点色の +Z 側を観測者へ向け、球を回しても周縁減光が常に円盤中心を基準にする。
    this.mesh.quaternion.copy(cameraQuaternion);
  }

  // 実球体と点像をどちらも隠す。
  public hide(): void {
    this.mesh.visible = false;
    this.point.hide();
  }

  // シーンから外し、実球体の geometry/material と点像を解放する。
  public dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.point.mesh.removeFromParent();
    this.point.dispose();
  }

  // 距離 distance [m] の半径 radius [m] の恒星を点像で描くときの、板の面の明るさ。恒星円盤の
  // 立体角ぶんの光を、板の立体角とグローの平均不透明度で割り戻し、球と同じ総光量を運ぶ。
  private pointBrightness(radius: number, distance: number): number {
    const diskSolidAngle = Math.PI * (radius / distance) ** 2;
    const spriteSolidAngle = POINT_IMAGE_ANGULAR_SIZE ** 2 * glowMeanAlpha();
    return this.surfaceRadiance * diskSolidAngle / spriteSolidAngle;
  }
}

// 単位球(半径1)の恒星本体。平均輝度をsurfaceRadianceに保ち、円盤中心から縁へ連続的に暗くする。
function createStarMesh(color: string | number, surfaceRadiance: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const normals = geo.getAttribute('normal');
  const intensities = new Float32Array(normals.count * 3);
  // 正対する半球の法線余弦を、円盤平均を保つ無彩色の頂点輝度へ焼き込む。
  for (let index = 0; index < normals.count; index++) {
    const intensity = stellarLimbIntensity(normals.getZ(index));
    intensities[index * 3] = intensity;
    intensities[index * 3 + 1] = intensity;
    intensities[index * 3 + 2] = intensity;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(intensities, 3));
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(surfaceRadiance),
    vertexColors: true,
  });
  return new THREE.Mesh(geo, mat);
}
