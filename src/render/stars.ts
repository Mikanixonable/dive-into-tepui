// 星空と太陽。WebGPU のポイントプリミティブは 1px 固定のため、
// 星は小さな三角形をまとめた単一ジオメトリで描く(レンダラー非依存で確実)。
import * as THREE from 'three/webgpu';
import starsTextureUrl from '../assets/8k_stars.jpg';
import { WORLD_BACKGROUND_LAYER } from './pipeline/lit-layer';
import { Billboard, POINT_IMAGE_ANGULAR_SIZE } from './billboard';
import { glowMeanAlpha } from './glow-texture';
import { showsPhysicalSphere } from './screen-lod';
import { AU } from '../physics/planet-orbit';
import { R_SUN } from '../physics/solar-system/constants';

export const STAR_SHELL_RADIUS = 3.5e7; // [m] 自機中心に固定するので視差は出ない

// 太陽面の輝度(render/pipeline/sun-light.ts の単位)。1 天文単位での放射照度 π は太陽円盤が
// 張る立体角 π(R/d)² を通して届くので、面の輝度は (d/R)² になる。5772 K の黒体として
// σT⁴/太陽定数 を計算しても同じ 4.62e4 が出る。
export const SUN_SURFACE_RADIANCE = (AU / R_SUN) ** 2;

export interface Stars {
  readonly mesh: THREE.Mesh;
  // 順応ぶんを打ち消す倍率を材質色へ掛ける。星殻は実写写真をそのまま貼ったもので物理的な
  // 輝度の目盛りに載っていないため、どこから見ても同じ明るさで写らなければならない。
  setFixedBrightnessScale(scale: number): void;
  dispose(): void;
}

// 星空の球殻メッシュを構築する。
export function createStars(): Stars {
  const geo = new THREE.SphereGeometry(STAR_SHELL_RADIUS, 64, 64);
  const texture = new THREE.TextureLoader().load(starsTextureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.BackSide,
    depthWrite: false,
    // renderOrder -10 で最初に描くため深度テストは元々不要。殻がカメラから
    // 0.9*far の距離にあり、深度クリア値付近の量子化丸めで LESS テストが
    // 落ちて黒く抜けることがあるため明示的に無効化する。
    depthTest: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  // CelestialSystem.sync が毎フレーム position をカメラ位置へ合わせる殻なので、
  // 外接球によるフラスタム判定は常に「視界内」を返し意味を持たない。
  mesh.frustumCulled = false;
  mesh.layers.set(WORLD_BACKGROUND_LAYER);
  mesh.renderOrder = -10;
  return {
    mesh,
    setFixedBrightnessScale(scale: number): void {
      mat.color.setScalar(scale);
    },
    // ジオメトリ・マテリアル・テクスチャを解放する。mesh をシーンから外すのは呼び出し側。
    dispose(): void {
      geo.dispose();
      mat.dispose();
      texture.dispose();
    },
  };
}

// 太陽面の色。実球体と点像が同じ色を名乗る — 表示が切り替わったところで色みが変わらない。
const SUN_SURFACE_COLOR = 0xfff3d0;

// 点像を星殻上へ置くための書き込み先。
const POINT_POSITION = new THREE.Vector3();

export interface Sun {
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

// 太陽の見た目を構築する。実位置・実半径・見かけの大きさを渡すのは呼び出し側。
export function createSun(): Sun {
  return new SunObject();
}

// 実球体と点像の組。**遠ざかって球として描けなくなったら点像へ入れ替える** — 実半径のまま
// 描き続けると、見かけ径が 1px を切った時点で総光量がラスタライズの被覆率へ量子化され、
// サブピクセルの移動だけで光量が 0 と 1px ぶんの間を跳ぶ(レンズ効果がそれを画面いっぱいの
// 滲みの明滅として拡大する)。
class SunObject implements Sun {
  private readonly mesh = createSunMesh();
  // 点像。**星殻上へ置く** — 実位置に置くと、戦闘視点の遠平面より遠い恒星が消える。
  // 描画順は星野の直後で、惑星の輝点と揃える。グローテクスチャの生成が DOM を要するので
  // addTo まで作らない。
  private point!: Billboard;

  addTo(scene: THREE.Scene): void {
    this.point = new Billboard(SUN_SURFACE_COLOR, -9);
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
      pointBrightness(radius, position.length()),
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
}

// 距離 distance [m] にある半径 radius [m] の恒星を点像で描くときの、板の面の明るさ。
// **球として描いたときと同じ総光量を運ぶ** — 恒星円盤が張る立体角ぶんの光を、板が張る
// 立体角(角の広がりの二乗)とグローの平均不透明度で割って面の明るさへ戻す。角の広がりは
// 距離によらないので、これは距離の二乗で薄れ、球との切り替えで絵が飛ばない。
function pointBrightness(radius: number, distance: number): number {
  const diskSolidAngle = Math.PI * (radius / distance) ** 2;
  const spriteSolidAngle = POINT_IMAGE_ANGULAR_SIZE ** 2 * glowMeanAlpha();
  return SUN_SURFACE_RADIANCE * diskSolidAngle / spriteSolidAngle;
}

// 単位球(半径1)の太陽本体。自己発光する光源そのものなので、シーンの照明を受けない
// MeshBasicMaterial で塗る。実位置・実半径へ置くのは SunObject の仕事。
function createSunMesh(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(SUN_SURFACE_COLOR).multiplyScalar(SUN_SURFACE_RADIANCE),
  });
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}
