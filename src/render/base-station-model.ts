import * as THREE from 'three/webgpu';
import { markLitOpaque, markSunShadowCaster } from './pipeline/lit-layer';
import { F0_STEEL } from './metal-f0';

// 基地の造形。主トラスを挟んで、居住区(+Z)とカウンターウェイトの貨物区(-Z)が向かい合う。

// 基地ローカル座標での各部の位置 [m]。モデル全体は最後に 3 倍へ拡大される。
const TRUSS_Z_MIN = -101; // 貨物部トップ境界
const TRUSS_Z_MAX = 49;   // 居住部ボトム境界
const TRUSS_RADIUS = 9;
const HABITAT_CENTER_Z = 75;
const COUNTERWEIGHT_CENTER_Z = -169;

// トラス構造はダーククリムゾンレッド、それ以外は白系セラミックホワイト。
const RED_TRUSS_MAT = new THREE.MeshStandardMaterial({ color: 0x581111, flatShading: true, roughness: 0.4, metalness: 0 });
const WHITE_FRAME_MAT = new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.2, metalness: 0 });
const WHITE_MODULE_MAT = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.15, metalness: 0 });

// ディテール用のライトアロイ。
const CONDUIT_MAT = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.3, metalness: 1 });
const CONDUIT_JOINT_MAT = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.35, metalness: 1 });
const WINDOW_GLOW_MAT = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xfde047, emissiveIntensity: 0.95, roughness: 0.2 });
const SENSOR_POD_MAT = new THREE.MeshStandardMaterial({ color: F0_STEEL, flatShading: true, roughness: 0.3, metalness: 1 });
const PANEL_GROOVE_MAT = new THREE.MeshStandardMaterial({ color: 0x1e293b, flatShading: true, roughness: 0.7, metalness: 0 });
const NEON_ACCENT_MAT = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x38bdf8, emissiveIntensity: 0.8 });
const HAZARD_ORANGE_MAT = new THREE.MeshStandardMaterial({ color: 0xd97706, emissive: 0xf59e0b, emissiveIntensity: 0.7 });
const SOLAR_CELL_MAT = new THREE.MeshStandardMaterial({
  color: 0x5eead4,
  emissive: 0x2dd4bf,
  emissiveIntensity: 0.15,
  roughness: 0.02,
  metalness: 0,
});
const RADIATOR_PANEL_MAT = new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.15, metalness: 0 });
// 放熱板と明暗を逆にするための暗色塗装。金属だと F0 がこの暗さを取れない。
const DARK_SKELETON_MAT = new THREE.MeshStandardMaterial({ color: 0x0f172a, flatShading: true, roughness: 0.4, metalness: 0 });

// コンテナ・タンク群のホワイト・シルバー・プラチナ基調パレット。個体差は添字で選ぶ。
const CONTAINER_MATS = [
  new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.25, metalness: 0 }), // ピュアホワイト
  new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.3, metalness: 0 }),  // セラミックホワイト
  new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.35, metalness: 0 }), // エアロスペースホワイト
  new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.3, metalness: 1 }),  // シルバーホワイト
  new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.35, metalness: 1 }), // ライトプラチナ
  new THREE.MeshStandardMaterial({ color: F0_STEEL, flatShading: true, roughness: 0.4, metalness: 1 }),  // ピューターアクセント
];
const TANK_MATS = [
  new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.2, metalness: 1 }),  // ピュアホワイト
  new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.25, metalness: 1 }), // シルバーホワイト
  new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.25, metalness: 1 }), // プラチナホワイト
];
const CARGO_FITTING_MAT = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.3, metalness: 1 });
const CARGO_GROOVE_MAT = new THREE.MeshStandardMaterial({ color: 0x94a3b8, flatShading: true, roughness: 0.6, metalness: 0 });
const CARGO_BAR_MAT = new THREE.MeshStandardMaterial({ color: F0_STEEL, flatShading: true, roughness: 0.2, metalness: 1 });
const CARGO_TRUSS_FRAME_MAT = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.25, metalness: 0 });

// 規格化貨物モジュール1個の寸法 [m]。
const CARGO_MODULE_WIDTH = 4.5;
const CARGO_MODULE_HEIGHT = 4.5;
const CARGO_MODULE_DEPTH = 9.0;

/** 基地のモデルを組み立てる。+Z が居住区側。 */
export function buildBaseModel(): THREE.Group {
  const g = new THREE.Group();

  // 中央 — 両端を繋ぐ主トラスと、その中腹のドッキング部
  g.add(buildTrussBeams());
  g.add(buildTrussLattice());
  g.add(buildDockingBay());

  // +Z 側 — 居住区
  g.add(buildHabitatShell());
  g.add(buildHabitatSensorPods());
  g.add(buildHabitatCrossModules());
  g.add(buildSolarPaddles());
  g.add(buildRadome());
  g.add(buildMagnetometerBoom());
  g.add(buildHabitatCargoPods());

  // -Z 側 — カウンターウェイトを兼ねる貨物区
  g.add(buildCargoHull());
  g.add(buildRadiators());
  g.add(buildDistillationPlant());
  g.add(buildCargoMatrix());

  g.scale.setScalar(3.0);

  markLitOpaque(g);
  markSunShadowCaster(g);
  return g;
}

/** 主トラスの縦通材 — 主コードビーム・内側ストリンガー・沿って走る流体配管。 */
function buildTrussBeams(): THREE.Group {
  const group = new THREE.Group();
  const length = TRUSS_Z_MAX - TRUSS_Z_MIN;
  const centerZ = (TRUSS_Z_MIN + TRUSS_Z_MAX) / 2;

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);

    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, length, 6), RED_TRUSS_MAT);
    beam.position.set(cosA * TRUSS_RADIUS, sinA * TRUSS_RADIUS, centerZ);
    beam.rotation.x = Math.PI / 2;
    group.add(beam);

    const innerBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, length, 6), RED_TRUSS_MAT);
    innerBeam.position.set(cosA * (TRUSS_RADIUS * 0.5), sinA * (TRUSS_RADIUS * 0.5), centerZ);
    innerBeam.rotation.x = Math.PI / 2;
    group.add(innerBeam);

    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, length, 6), CONDUIT_MAT);
    pipe.position.set(cosA * (TRUSS_RADIUS + 1.8), sinA * (TRUSS_RADIUS + 1.8), centerZ);
    pipe.rotation.x = Math.PI / 2;
    group.add(pipe);

    // 配管フランジ継手リング (12m おき)
    for (let pz = TRUSS_Z_MIN; pz <= TRUSS_Z_MAX; pz += 12) {
      const joint = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.6, 8), CONDUIT_JOINT_MAT);
      joint.position.set(cosA * (TRUSS_RADIUS + 1.8), sinA * (TRUSS_RADIUS + 1.8), pz);
      joint.rotation.x = Math.PI / 2;
      group.add(joint);
    }
  }
  return group;
}

/** 主トラスの斜材 — 段ごとの横リブ・立体Xブレース・内部Kブレースと節点ハブ。 */
function buildTrussLattice(): THREE.Group {
  const group = new THREE.Group();
  const stepZ = 10;

  for (let z = TRUSS_Z_MIN; z < TRUSS_Z_MAX; z += stepZ) {
    const zNext = Math.min(z + stepZ, TRUSS_Z_MAX);

    for (let i = 0; i < 3; i++) {
      const a1 = (i / 3) * Math.PI * 2;
      const a2 = (((i + 1) % 3) / 3) * Math.PI * 2;

      const p1 = new THREE.Vector3(Math.cos(a1) * TRUSS_RADIUS, Math.sin(a1) * TRUSS_RADIUS, z);
      const p2 = new THREE.Vector3(Math.cos(a2) * TRUSS_RADIUS, Math.sin(a2) * TRUSS_RADIUS, z);
      const p1Next = new THREE.Vector3(Math.cos(a1) * TRUSS_RADIUS, Math.sin(a1) * TRUSS_RADIUS, zNext);
      const p2Next = new THREE.Vector3(Math.cos(a2) * TRUSS_RADIUS, Math.sin(a2) * TRUSS_RADIUS, zNext);

      // 横方向リブ (バルクヘッド枠)
      const hMid = p1.clone().add(p2).multiplyScalar(0.5);
      const hLen = p1.distanceTo(p2);
      const hStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, hLen, 4), RED_TRUSS_MAT);
      hStrut.position.copy(hMid);
      hStrut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p2.clone().sub(p1).normalize());
      group.add(hStrut);

      // 斜めXブレース (対角線1: p1 -> p2Next)
      const dMid1 = p1.clone().add(p2Next).multiplyScalar(0.5);
      const dLen1 = p1.distanceTo(p2Next);
      const dStrut1 = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, dLen1, 4), RED_TRUSS_MAT);
      dStrut1.position.copy(dMid1);
      dStrut1.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p2Next.clone().sub(p1).normalize());
      group.add(dStrut1);

      // 斜めXブレース (対角線2: p2 -> p1Next)
      const dMid2 = p2.clone().add(p1Next).multiplyScalar(0.5);
      const dLen2 = p2.distanceTo(p1Next);
      const dStrut2 = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, dLen2, 4), RED_TRUSS_MAT);
      dStrut2.position.copy(dMid2);
      dStrut2.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1Next.clone().sub(p2).normalize());
      group.add(dStrut2);

      // 内部放射状Kブレース (中心軸 z -> ノード p1)
      const centerNode = new THREE.Vector3(0, 0, z);
      const kMid = centerNode.clone().add(p1).multiplyScalar(0.5);
      const kLen = centerNode.distanceTo(p1);
      const kStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, kLen, 4), CONDUIT_JOINT_MAT);
      kStrut.position.copy(kMid);
      kStrut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(centerNode).normalize());
      group.add(kStrut);

      // 節点ガセットジョイント
      const nodeHub = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 8), CONDUIT_JOINT_MAT);
      nodeHub.position.copy(p1);
      group.add(nodeHub);
    }
  }
  return group;
}

/** Z = 0m の中腹ドッキング部 — メインハッチと、格子状に並ぶ4基のベイスロット。 */
function buildDockingBay(): THREE.Group {
  const group = new THREE.Group();

  const hatchDoor = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 1.4, 16), WHITE_FRAME_MAT);
  hatchDoor.position.set(0, 7, 0);
  group.add(hatchDoor);

  const hatchRing = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 0.3, 16), PANEL_GROOVE_MAT);
  hatchRing.position.set(0, 7.7, 0);
  group.add(hatchRing);

  const slotPositions: readonly [number, number][] = [
    [-5.5, -5.5],
    [5.5, -5.5],
    [-5.5, 5.5],
    [5.5, 5.5],
  ];

  for (const [slotX, slotZ] of slotPositions) {
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.7, 0.8, 12), WHITE_FRAME_MAT);
    collar.position.set(slotX, 7.0, slotZ);
    group.add(collar);

    // 空気圧ロックラッチクランプ
    for (let cAngle = 0; cAngle < Math.PI * 2; cAngle += Math.PI / 2) {
      const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.4), SENSOR_POD_MAT);
      clamp.position.set(slotX + Math.cos(cAngle) * 2.6, 7.3, slotZ + Math.sin(cAngle) * 2.6);
      clamp.rotation.y = cAngle;
      group.add(clamp);
    }

    // 光学レーザーアライメントセンサー
    const laserSensor = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), NEON_ACCENT_MAT);
    laserSensor.position.set(slotX, 7.5, slotZ);
    group.add(laserSensor);

    // アンビリカル燃料供給ポート
    const umbilicalPort = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1.2, 6), CONDUIT_JOINT_MAT);
    umbilicalPort.position.set(slotX + 1.8, 6.8, slotZ + 1.8);
    umbilicalPort.rotation.x = Math.PI / 2;
    group.add(umbilicalPort);
  }
  return group;
}

/** 居住区の外骨格と、クライスラービル風アールデコ装飾。 */
function buildHabitatShell(): THREE.Group {
  const group = new THREE.Group();

  const exoskeleton = new THREE.Mesh(new THREE.BoxGeometry(15.4, 15.4, 52), WHITE_FRAME_MAT);
  exoskeleton.position.set(0, 0, HABITAT_CENTER_Z);
  group.add(exoskeleton);

  // 垂直ピアーモールディング
  for (const px of [-7.8, -3.85, 0, 3.85, 7.8]) {
    for (const py of [-7.8, 7.8]) {
      const vPier = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 50), CONDUIT_MAT);
      vPier.position.set(px, py, HABITAT_CENTER_Z);
      group.add(vPier);

      const vPierY = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.4, 50), CONDUIT_MAT);
      vPierY.position.set(py, px, HABITAT_CENTER_Z);
      group.add(vPierY);
    }
  }

  // 段層セットバックモールディングと、ホイールキャップ型メダリオンレリーフ
  for (let zStep = HABITAT_CENTER_Z - 20; zStep <= HABITAT_CENTER_Z + 20; zStep += 10) {
    const stepMolding = new THREE.Mesh(new THREE.BoxGeometry(16.0, 16.0, 0.8), WHITE_FRAME_MAT);
    stepMolding.position.set(0, 0, zStep);
    group.add(stepMolding);

    const seamRing = new THREE.Mesh(new THREE.BoxGeometry(16.3, 16.3, 0.25), PANEL_GROOVE_MAT);
    seamRing.position.set(0, 0, zStep);
    group.add(seamRing);

    for (const mx of [-8.0, 8.0]) {
      const medallion = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.25, 12), CONDUIT_JOINT_MAT);
      medallion.position.set(mx, 0, zStep);
      medallion.rotation.z = Math.PI / 2;
      group.add(medallion);

      const medallionY = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.25, 12), CONDUIT_JOINT_MAT);
      medallionY.position.set(0, mx, zStep);
      medallionY.rotation.x = Math.PI / 2;
      group.add(medallionY);
    }
  }

  // ガーゴイル風・翼状コーナーアビオニクススパイア
  for (const gx of [-8.2, 8.2]) {
    for (const gy of [-8.2, 8.2]) {
      const gargoyleSpire = new THREE.Mesh(new THREE.ConeGeometry(1.3, 5.0, 4), WHITE_FRAME_MAT);
      gargoyleSpire.position.set(gx * 1.08, gy * 1.08, HABITAT_CENTER_Z + 18);
      gargoyleSpire.rotation.x = Math.PI / 2 + 0.3;
      gargoyleSpire.rotation.z = Math.atan2(gy, gx);
      group.add(gargoyleSpire);
    }
  }

  // サンバースト冠状アールデコアーチ
  for (let aIdx = 0; aIdx < 4; aIdx++) {
    const archRadius = 7.7 - aIdx * 1.3;
    const archZ = HABITAT_CENTER_Z + 20 + aIdx * 1.5;
    const crownArch = new THREE.Mesh(new THREE.CylinderGeometry(archRadius, archRadius + 0.5, 0.8, 16), WHITE_FRAME_MAT);
    crownArch.position.set(0, 0, archZ);
    group.add(crownArch);

    const archGroove = new THREE.Mesh(new THREE.CylinderGeometry(archRadius + 0.6, archRadius + 0.6, 0.2, 16), PANEL_GROOVE_MAT);
    archGroove.position.set(0, 0, archZ);
    group.add(archGroove);
  }

  // 上部4隅の切り欠き
  for (const cx of [-7.7, 7.7]) {
    for (const cy of [-7.7, 7.7]) {
      const cornerNotch = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 12), PANEL_GROOVE_MAT);
      cornerNotch.position.set(cx, cy, HABITAT_CENTER_Z + 20);
      group.add(cornerNotch);
    }
  }
  return group;
}

/** 居住区の4隅に付く計測機器ポッドと、その先端のセンサーレンズ。 */
function buildHabitatSensorPods(): THREE.Group {
  const group = new THREE.Group();

  // 外骨格の角に沿って、居住区の全長にわたる細長いポッドを立てる。
  for (const sx of [-7.9, 7.9]) {
    for (const sy of [-7.9, 7.9]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 4.5), SENSOR_POD_MAT);
      pod.position.set(sx, sy, HABITAT_CENTER_Z);
      group.add(pod);

      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), NEON_ACCENT_MAT);
      lens.position.set(sx, sy, HABITAT_CENTER_Z + 2.4);
      group.add(lens);
    }
  }
  return group;
}

/** 居住区の十字配置モジュール(発光窓付き)と、その交差溝チャネル。 */
function buildHabitatCrossModules(): THREE.Group {
  const group = new THREE.Group();
  const crossPositions: readonly [number, number][] = [
    [0, 0],
    [4.2, 0],
    [-4.2, 0],
    [0, 4.2],
    [0, -4.2],
  ];

  for (const [x, y] of crossPositions) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 40, 10), WHITE_MODULE_MAT);
    tube.position.set(x, y, HABITAT_CENTER_Z - 3);
    tube.rotation.x = Math.PI / 2;
    group.add(tube);

    const flange = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.6, 10), CONDUIT_JOINT_MAT);
    flange.position.set(x, y, HABITAT_CENTER_Z - 3);
    flange.rotation.x = Math.PI / 2;
    group.add(flange);

    // 発光窓は外周のモジュールにだけ開く。中央は他の4本に囲まれて見えない。
    for (let zWin = HABITAT_CENTER_Z - 18; zWin <= HABITAT_CENTER_Z + 12; zWin += 6) {
      if (x !== 0 || y !== 0) {
        const winAngle = Math.atan2(y, x);
        const win = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.3), WINDOW_GLOW_MAT);
        win.position.set(x + Math.cos(winAngle) * 2.02, y + Math.sin(winAngle) * 2.02, zWin);
        group.add(win);
      }
    }
  }

  const crossChannelH = new THREE.Mesh(new THREE.BoxGeometry(15.6, 0.8, 0.4), PANEL_GROOVE_MAT);
  crossChannelH.position.set(0, 0, HABITAT_CENTER_Z);
  group.add(crossChannelH);

  const crossChannelV = new THREE.Mesh(new THREE.BoxGeometry(0.8, 15.6, 0.4), PANEL_GROOVE_MAT);
  crossChannelV.position.set(0, 0, HABITAT_CENTER_Z);
  group.add(crossChannelV);

  return group;
}

/** 居住区下部の太陽電池パドル一対 — 可動ブームと、六角セルのハニカム集積体。 */
function buildSolarPaddles(): THREE.Group {
  const group = new THREE.Group();

  for (const sideX of [-1, 1]) {
    const paddleGroup = new THREE.Group();
    paddleGroup.position.set(sideX * 7.8, 0, 54);

    const gimbal = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 2.5, 10), SENSOR_POD_MAT);
    gimbal.rotation.z = Math.PI / 2;
    group.add(gimbal);

    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 9.0, 8), CONDUIT_MAT);
    boom.position.set(sideX * 4.5, 0, 0);
    boom.rotation.z = Math.PI / 2;
    paddleGroup.add(boom);

    const hexCellGeo = new THREE.CylinderGeometry(1.1, 1.1, 0.45, 6);
    const hexBezelGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.4, 6);

    for (let ix = -3; ix <= 3; ix++) {
      const posX = sideX * 13.5 + ix * 2.1;
      for (let iz = -2; iz <= 2; iz++) {
        // 一列おきに半ピッチずらして六角を噛み合わせ、はみ出す列を落として矩形に切り揃える。
        const posZ = iz * 2.0 + (Math.abs(ix) % 2 === 1 ? 1.0 : 0);
        if (Math.abs(posZ) <= 4.2) {
          const bezel = new THREE.Mesh(hexBezelGeo, CONDUIT_JOINT_MAT);
          bezel.position.set(posX, 0, posZ);
          paddleGroup.add(bezel);

          const cell = new THREE.Mesh(hexCellGeo, SOLAR_CELL_MAT);
          cell.position.set(posX, 0, posZ);
          paddleGroup.add(cell);
        }
      }
    }

    group.add(paddleGroup);
  }
  return group;
}

/** 居住区先端の立方八面体レドームと、その土台のマウントアダプターカラー。 */
function buildRadome(): THREE.Group {
  const group = new THREE.Group();
  const radomeRadius = 5.1;

  const radomeGroup = new THREE.Group();
  radomeGroup.position.set(0, 0, HABITAT_CENTER_Z + 25);

  // 立方八面体 (12頂点, 8正三角形面 + 6正方形面)
  const c = 1 / Math.sqrt(2);
  const vertices = [
    -c, -c, 0, c, -c, 0, c, c, 0, -c, c, 0,
    -c, 0, -c, c, 0, -c, c, 0, c, -c, 0, c,
    0, -c, -c, 0, c, -c, 0, c, c, 0, -c, c,
  ];
  const indices = [
    // 8つの正三角形面
    0, 8, 1, 1, 5, 2, 2, 9, 3, 3, 4, 0,
    0, 7, 11, 1, 11, 6, 2, 6, 10, 3, 10, 4,
    // 6つの正方形面 (各2つの三角形で構成)
    0, 1, 11, 0, 11, 7,
    1, 2, 6, 1, 6, 5,
    2, 3, 10, 2, 10, 9,
    3, 0, 4, 3, 4, 7,
    4, 5, 9, 4, 8, 5,
    7, 6, 10, 7, 11, 6,
  ];

  const geo = new THREE.PolyhedronGeometry(vertices, indices, radomeRadius, 0);
  radomeGroup.add(new THREE.Mesh(geo, WHITE_MODULE_MAT));

  // 頂点・稜線の継手フレーム
  const wireLines = new THREE.LineSegments(
    new THREE.WireframeGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x475569 }),
  );
  radomeGroup.add(wireLines);

  const radomeCollar = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.5, 1.4, 10), WHITE_FRAME_MAT);
  radomeCollar.position.set(0, 0, HABITAT_CENTER_Z + 19.5);
  radomeCollar.rotation.x = Math.PI / 2;
  group.add(radomeCollar);

  group.add(radomeGroup);
  return group;
}

/** 居住区先端から伸びる磁気センサーブームと、その先端の3軸センサー。 */
function buildMagnetometerBoom(): THREE.Group {
  const group = new THREE.Group();
  const tipZ = HABITAT_CENTER_Z + 70.5;

  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.15, 45, 6), RED_TRUSS_MAT);
  boom.position.set(0, 0, HABITAT_CENTER_Z + 48);
  boom.rotation.x = Math.PI / 2;
  group.add(boom);

  const magCube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), SENSOR_POD_MAT);
  magCube.position.set(0, 0, tipZ);
  group.add(magCube);

  // センサーキューブから直交3方向へ突き出るプローブ
  for (const axis of [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ]) {
    const probe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.5, 6), NEON_ACCENT_MAT);
    probe.position.set(0, 0, tipZ).add(axis.clone().multiplyScalar(1.5));
    group.add(probe);
  }
  return group;
}

/** カウンターウェイト部の貨物区躯体と、その表面の配線・計測デバイス箱・パネル溝。 */
function buildCargoHull(): THREE.Group {
  const group = new THREE.Group();

  const core = new THREE.Mesh(new THREE.BoxGeometry(14, 14, 136), WHITE_FRAME_MAT);
  core.position.set(0, 0, COUNTERWEIGHT_CENTER_Z);
  group.add(core);

  // 4隅を通る長尺配線・流体パイプラインと、その固定クランプ
  for (const bx of [-7.1, 7.1]) {
    for (const by of [-7.1, 7.1]) {
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 138, 8), CONDUIT_MAT);
      cable.position.set(bx, by, COUNTERWEIGHT_CENTER_Z);
      cable.rotation.x = Math.PI / 2;
      group.add(cable);

      for (let zClamp = COUNTERWEIGHT_CENTER_Z - 60; zClamp <= COUNTERWEIGHT_CENTER_Z + 60; zClamp += 15) {
        const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.5), CONDUIT_JOINT_MAT);
        clamp.position.set(bx, by, zClamp);
        group.add(clamp);
      }
    }
  }

  // 表面計測デバイス箱。4つの壁面へ順ぐりに割り付ける。
  for (let dIdx = 0; dIdx < 16; dIdx++) {
    const zBox = COUNTERWEIGHT_CENTER_Z - 56 + dIdx * 7.5;
    const face = dIdx % 4;
    const boxX = face === 0 ? 7.2 : (face === 1 ? -7.2 : 0);
    const boxY = face === 2 ? 7.2 : (face === 3 ? -7.2 : 0);

    const devBox = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 2.5), SENSOR_POD_MAT);
    devBox.position.set(boxX, boxY, zBox);
    group.add(devBox);

    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), NEON_ACCENT_MAT);
    lens.position.set(boxX * 1.05, boxY * 1.05, zBox);
    group.add(lens);
  }

  // リセスパネル溝ライン
  for (let zSeam = COUNTERWEIGHT_CENTER_Z - 60; zSeam <= COUNTERWEIGHT_CENTER_Z + 60; zSeam += 16) {
    const seam = new THREE.Mesh(new THREE.BoxGeometry(14.4, 14.4, 0.35), PANEL_GROOVE_MAT);
    seam.position.set(0, 0, zSeam);
    group.add(seam);
  }
  return group;
}

/** 貨物部上部から放射状に伸びる4枚の蛇腹状放熱板と、逆位相の暗色骨格。 */
function buildRadiators(): THREE.Group {
  const group = new THREE.Group();

  for (let radIdx = 0; radIdx < 4; radIdx++) {
    const radGroup = new THREE.Group();
    radGroup.position.set(0, 0, -132);
    radGroup.rotation.z = (radIdx * Math.PI) / 2 + Math.PI / 4;

    const segCount = 6;
    const segLen = 2.8;
    let currR = 7.2;

    for (let k = 0; k < segCount; k++) {
      // 一節ごとに折れの向きを反転させて蛇腹にする。骨格は放熱板と逆位相へ寄せる。
      const phaseSign = k % 2 === 0 ? 1 : -1;
      const rMid = currR + segLen / 2;

      const leafPanel = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.15, 14.0), RADIATOR_PANEL_MAT);
      leafPanel.position.set(rMid, phaseSign * 0.9, 0);
      leafPanel.rotation.z = phaseSign * 0.18;
      radGroup.add(leafPanel);

      const darkTruss = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.4, 0.4), DARK_SKELETON_MAT);
      darkTruss.position.set(rMid, -phaseSign * 0.9, 0);
      darkTruss.rotation.z = -phaseSign * 0.18;
      radGroup.add(darkTruss);

      // 放熱板と骨格を結ぶクロスリンクドローバー
      const linkBar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.8, 6), DARK_SKELETON_MAT);
      linkBar.position.set(rMid, 0, 0);
      radGroup.add(linkBar);

      // 蛇腹ピボットヒンジジョイント
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 14.4, 8), CONDUIT_JOINT_MAT);
      hinge.position.set(currR, 0, 0);
      hinge.rotation.x = Math.PI / 2;
      radGroup.add(hinge);

      currR += segLen;
    }

    group.add(radGroup);
  }
  return group;
}

/** カウンターウェイト部の化学プラント — 段付き蒸留塔2基と、高圧多面体ガスタンク3基。 */
function buildDistillationPlant(): THREE.Group {
  const group = new THREE.Group();

  const tower1 = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 100, 16), TANK_MATS[0]!);
  tower1.position.set(13, 13, COUNTERWEIGHT_CENTER_Z - 5);
  tower1.rotation.x = Math.PI / 2;
  group.add(tower1);

  // 蒸留塔の段数フランジリング。3段おきにキャットウォークが回る。
  for (let zFlange = COUNTERWEIGHT_CENTER_Z - 52; zFlange <= COUNTERWEIGHT_CENTER_Z + 42; zFlange += 6) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(6.3, 6.3, 0.5, 16), CONDUIT_JOINT_MAT);
    flange.position.set(13, 13, zFlange);
    flange.rotation.x = Math.PI / 2;
    group.add(flange);

    if ((zFlange - COUNTERWEIGHT_CENTER_Z) % 18 === 0) {
      const catwalk = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 0.4, 12), CONDUIT_MAT);
      catwalk.position.set(13, 13, zFlange);
      catwalk.rotation.x = Math.PI / 2;
      group.add(catwalk);
    }
  }

  const tower2 = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 4.8, 84, 14), TANK_MATS[1]!);
  tower2.position.set(-13, -13, COUNTERWEIGHT_CENTER_Z + 2);
  tower2.rotation.x = Math.PI / 2;
  group.add(tower2);

  for (let zFlange = COUNTERWEIGHT_CENTER_Z - 40; zFlange <= COUNTERWEIGHT_CENTER_Z + 40; zFlange += 7) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 0.5, 14), CONDUIT_JOINT_MAT);
    flange.position.set(-13, -13, zFlange);
    flange.rotation.x = Math.PI / 2;
    group.add(flange);
  }

  const gasTankGeo = new THREE.IcosahedronGeometry(6.0, 0);
  const gasTankPositions: readonly [number, number, number][] = [[-13, 13, -35], [13, -13, 20], [0, 15, -45]];
  for (const [sX, sY, sZ] of gasTankPositions) {
    const sphereTank = new THREE.Mesh(gasTankGeo, TANK_MATS[2]!);
    sphereTank.position.set(sX, sY, COUNTERWEIGHT_CENTER_Z + sZ);
    group.add(sphereTank);

    const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 2, 8), HAZARD_ORANGE_MAT);
    valve.position.set(sX, sY + 6.2, COUNTERWEIGHT_CENTER_Z + sZ);
    group.add(valve);
  }
  return group;
}

/** ISO 規格風の宇宙貨物コンテナ1個。tagMat を渡すと扉に識別タグが付く。 */
function buildContainer(w: number, h: number, d: number, mat: THREE.Material, tagMat?: THREE.Material): THREE.Group {
  const container = new THREE.Group();
  container.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));

  // 8隅のコーナーキャスティング
  const cSize = Math.min(w, h, d) * 0.16;
  const cornerGeo = new THREE.BoxGeometry(cSize, cSize, cSize);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const corner = new THREE.Mesh(cornerGeo, CARGO_FITTING_MAT);
        corner.position.set(sx * (w / 2), sy * (h / 2), sz * (d / 2));
        container.add(corner);
      }
    }
  }

  // 側面の波板リブ
  const ribCount = Math.max(3, Math.floor(d / 1.6));
  for (let i = 0; i < ribCount; i++) {
    const zPos = -d / 2 + ((i + 0.5) * d) / ribCount;
    for (const sx of [-1, 1]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.12, h * 0.85, 0.45), CARGO_GROOVE_MAT);
      rib.position.set(sx * (w / 2 + 0.04), 0, zPos);
      container.add(rib);
    }
  }

  // 扉面 — 合わせ目・ロックバー・ハンドル
  const doorZ = d / 2 + 0.05;
  const doorSeam = new THREE.Mesh(new THREE.BoxGeometry(0.08, h * 0.88, 0.12), CARGO_GROOVE_MAT);
  doorSeam.position.set(0, 0, doorZ);
  container.add(doorSeam);

  const barGeo = new THREE.CylinderGeometry(0.08, 0.08, h * 0.82, 6);
  for (const bx of [-w * 0.24, w * 0.24]) {
    const lockBar = new THREE.Mesh(barGeo, CARGO_BAR_MAT);
    lockBar.position.set(bx, 0, doorZ);
    container.add(lockBar);

    const handle = new THREE.Mesh(new THREE.BoxGeometry(w * 0.18, 0.08, 0.1), CARGO_BAR_MAT);
    handle.position.set(bx + (bx > 0 ? -w * 0.08 : w * 0.08), -h * 0.15, doorZ + 0.04);
    container.add(handle);
  }

  if (tagMat) {
    const tag = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, h * 0.25, 0.1), tagMat);
    tag.position.set(w * 0.22, h * 0.22, doorZ + 0.02);
    container.add(tag);
  }

  return container;
}

/** 規格化貨物モジュール1個。typeIdx が8種類の造形を選ぶ。 */
function buildCargoModule(typeIdx: number, mat: THREE.Material, tagMat?: THREE.Material): THREE.Group {
  switch (typeIdx % 8) {
    case 0: return buildContainer(CARGO_MODULE_WIDTH, CARGO_MODULE_HEIGHT, CARGO_MODULE_DEPTH, mat, tagMat);
    case 1: return buildReeferCargo(tagMat);
    case 2: return buildTankCargo(mat);
    case 3: return buildFlatbedCargo();
    case 4: return buildBottleRackCargo();
    case 5: return buildSphereTankCargo();
    case 6: return buildHexCapsuleCargo();
    default: return buildAvionicsRackCargo();
  }
}

/** 規格寸法の外枠ボックス。中身をこの中へ納める造形が共有する。 */
function buildCargoFrame(mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.BoxGeometry(CARGO_MODULE_WIDTH, CARGO_MODULE_HEIGHT, CARGO_MODULE_DEPTH);
  return new THREE.Mesh(geo, mat);
}

/** 冷凍コンテナ — 背面に冷却ユニットと稼働 LED を負う。 */
function buildReeferCargo(tagMat?: THREE.Material): THREE.Group {
  const reefer = buildContainer(CARGO_MODULE_WIDTH, 4.8, CARGO_MODULE_DEPTH, CONTAINER_MATS[0]!, tagMat);

  const cooler = new THREE.Mesh(new THREE.BoxGeometry(4.0, 4.0, 0.4), SENSOR_POD_MAT);
  cooler.position.set(0, 0, -4.5);
  reefer.add(cooler);

  const coolerLed = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 6), NEON_ACCENT_MAT);
  coolerLed.position.set(1.5, 1.5, -4.7);
  reefer.add(coolerLed);

  return reefer;
}

/** 横置きの円筒タンクを外枠へ納めた貨物。鏡板は両端の半球で塞ぐ。 */
function buildTankCargo(mat: THREE.Material): THREE.Group {
  const cargo = new THREE.Group();

  const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 8.4, 12), mat);
  tank.rotation.x = Math.PI / 2;
  cargo.add(tank);

  for (const sz of [-4.2, 4.2]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(2.0, 12, 8), mat);
    cap.position.set(0, 0, sz);
    cargo.add(cap);
  }

  cargo.add(buildCargoFrame(CARGO_FITTING_MAT));
  return cargo;
}

/** フラットベッド — 薄い台板に載せた機械を、固縛帯で3本留めにする。 */
function buildFlatbedCargo(): THREE.Group {
  const cargo = new THREE.Group();
  const bedGeo = new THREE.BoxGeometry(CARGO_MODULE_WIDTH, 1.0, CARGO_MODULE_DEPTH);
  cargo.add(new THREE.Mesh(bedGeo, CONTAINER_MATS[1]!));

  const machine = new THREE.Mesh(new THREE.BoxGeometry(3.6, 3.2, 7.0), SENSOR_POD_MAT);
  machine.position.set(0, 2.1, 0);
  cargo.add(machine);

  for (const zS of [-2.5, 0, 2.5]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.4, 0.3), HAZARD_ORANGE_MAT);
    strap.position.set(0, 2.0, zS);
    cargo.add(strap);
  }
  return cargo;
}

/** ボトルラック — 外枠に長尺ガスボンベを4本立てる。 */
function buildBottleRackCargo(): THREE.Group {
  const cargo = new THREE.Group();
  cargo.add(buildCargoFrame(CONTAINER_MATS[3]!));

  for (const bx of [-1.2, 1.2]) {
    for (const by of [-1.2, 1.2]) {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 8.0, 10), TANK_MATS[1]!);
      bottle.position.set(bx, by, 0);
      bottle.rotation.x = Math.PI / 2;
      cargo.add(bottle);
    }
  }
  return cargo;
}

/** 球形タンク2基を外枠へ縦列に納めた貨物。 */
function buildSphereTankCargo(): THREE.Group {
  const cargo = new THREE.Group();
  cargo.add(buildCargoFrame(CONTAINER_MATS[3]!));

  for (const zSph of [-2.2, 2.2]) {
    const sphereTank = new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 10), TANK_MATS[0]!);
    sphereTank.position.set(0, 0, zSph);
    cargo.add(sphereTank);
  }
  return cargo;
}

/** 六角断面のバルクカプセル。補強リングを3枚巻く。 */
function buildHexCapsuleCargo(): THREE.Group {
  const cargo = new THREE.Group();

  const hexBody = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 8.8, 6), CONTAINER_MATS[2]!);
  hexBody.rotation.x = Math.PI / 2;
  cargo.add(hexBody);

  for (const zRing of [-3.0, 0, 3.0]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.4, 6), CONDUIT_JOINT_MAT);
    ring.position.set(0, 0, zRing);
    ring.rotation.x = Math.PI / 2;
    cargo.add(ring);
  }
  return cargo;
}

/** アビオニクスラック — 外枠に機器キューブを2基収める。 */
function buildAvionicsRackCargo(): THREE.Group {
  const cargo = new THREE.Group();
  cargo.add(buildCargoFrame(CARGO_TRUSS_FRAME_MAT));

  for (const zCube of [-2.0, 2.0]) {
    const avCube = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 3.2), SENSOR_POD_MAT);
    avCube.position.set(0, 0, zCube);
    cargo.add(avCube);
  }
  return cargo;
}

/** 居住区の四隅へ抱かせる小型貨物ポッド群。 */
function buildHabitatCargoPods(): THREE.Group {
  const group = new THREE.Group();
  let idx = 0;

  // 四隅それぞれに、居住区の高さ方向へ3個ずつ並べる。
  for (const quadX of [-1, 1]) {
    for (const quadY of [-1, 1]) {
      for (let zH = HABITAT_CENTER_Z - 14; zH <= HABITAT_CENTER_Z + 10; zH += 12) {
        const pod = buildCargoModule(idx, CONTAINER_MATS[idx % CONTAINER_MATS.length]!);
        pod.position.set(quadX * 9.2, quadY * 9.2, zH);
        pod.scale.setScalar(0.65);
        group.add(pod);
        idx++;
      }
    }
  }
  return group;
}

/** 貨物区の4壁面へ不規則にへばりつく貨物モジュール群。姿勢は揃える。 */
function buildCargoMatrix(): THREE.Group {
  const group = new THREE.Group();
  const moduleLimit = 100;
  let idx = 0;

  for (let zStep = 0; zStep < 42 && idx < moduleLimit; zStep++) {
    const zBase = COUNTERWEIGHT_CENTER_Z - 62 + zStep * 3.0;

    for (let face = 0; face < 4 && idx < moduleLimit; face++) {
      const randSeed = zStep * 100 + face * 13;
      if (pseudoHash(randSeed) < 0.48) continue; // 不均等な空き・虫食いスロット

      const stackLimit = 1 + Math.floor(pseudoHash(randSeed * 1.7) * 2.8); // 1〜3段積み

      for (let layer = 0; layer < stackLimit && idx < moduleLimit; layer++) {
        const zOffset = (pseudoHash(randSeed + layer * 7) - 0.5) * 2.4;
        const latOffset = (pseudoHash(randSeed * 2.3 + layer) - 0.5) * 5.2; // 壁面に沿う横シフト
        const surfDist = 9.25 + layer * 4.4; // 壁面(R=7.0m)へへばりつく距離

        // face 0..3 が +X / -X / +Y / -Y の壁面に対応する。
        const alongX = face === 0 || face === 1;
        const outward = face === 0 || face === 2 ? surfDist : -surfDist;

        const tagMat = idx % 4 === 0 ? (idx % 8 === 0 ? NEON_ACCENT_MAT : HAZARD_ORANGE_MAT) : undefined;
        const cargo = buildCargoModule(idx, CONTAINER_MATS[idx % CONTAINER_MATS.length]!, tagMat);
        cargo.position.set(alongX ? outward : latOffset, alongX ? latOffset : outward, zBase + zOffset);
        group.add(cargo);

        idx++;
      }
    }
  }
  return group;
}

/** 再現性のある不規則配置のための決定論的疑似乱数。 */
function pseudoHash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
