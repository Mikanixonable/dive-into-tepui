import * as THREE from 'three/webgpu';
import { markLitOpaque, markSunShadowCaster } from './pipeline/lit-layer';
import { F0_STEEL } from './metal-f0';

// 基地: 中央ハブ + 放射状トラス4本 + ドッキングモジュール4基 + 太陽電池パドル2枚の低ポリ構成。
// 基地: 3倍スケール対応・超大型白基調ステーション (純白エアロスペースカラー・200箱不規則貨物マトリックス・化学蒸留プラント・シダの葉太陽電池・SAR)
export function buildBaseModel(): THREE.Group {
  const g = new THREE.Group();

  // マテリアル定義 (トラス構造はシックなダーククリムゾンレッド, その他は白系セラミックホワイト)
  const redTrussMat = new THREE.MeshStandardMaterial({ color: 0x581111, flatShading: true, roughness: 0.4, metalness: 0 }); // 暗い赤基調主トラス構造
  const grayFrameMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.2, metalness: 0 });  // 白基調外骨格
  const whiteModuleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.15, metalness: 0 }); // 純白セラミック居住区

  // ディテール追加用マテリアル (白系基調のライトアロイ)
  const conduitMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.3, metalness: 1 });
  const conduitJointMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.35, metalness: 1 });
  const windowGlowMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xfde047, emissiveIntensity: 0.95, roughness: 0.2 });
  const sensorPodMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, flatShading: true, roughness: 0.3, metalness: 1 });
  const panelGrooveMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, flatShading: true, roughness: 0.7, metalness: 0 });

  // コンテナ・タンク群用カラーパレット (統一感のあるホワイト・シルバー・プラチナ基調)
  const containerMats = [
    new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.25, metalness: 0 }), // ピュアホワイト
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.3, metalness: 0 }),   // セラミックホワイト
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.35, metalness: 0 }), // エアロスペースホワイト
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.3, metalness: 1 }),   // シルバーホワイト
    new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.35, metalness: 1 }),  // ライトプラチナ
    new THREE.MeshStandardMaterial({ color: F0_STEEL, flatShading: true, roughness: 0.4, metalness: 1 }),  // ピューターアクセント
  ];
  const neonAccentMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x38bdf8, emissiveIntensity: 0.8 });
  const hazardOrangeMat = new THREE.MeshStandardMaterial({ color: 0xd97706, emissive: 0xf59e0b, emissiveIntensity: 0.7 });

  const tankMats = [
    new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.2, metalness: 1 }),  // ピュアホワイトタンク
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.25, metalness: 1 }), // シルバーホワイトタンク
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.25, metalness: 1 }),  // プラチナホワイトタンク
  ];

  // 1) 居住部(+49m)と貨物部(-101m)の間にぴったり挟まれる暗い赤基調トラス構造 (めり込み・貫通なし)
  const zMin = -101; // 貨物部トップ境界
  const zMax = 49;   // 居住部ボトム境界
  const trussLength = zMax - zMin; // 150m
  const trussCenterZ = (zMin + zMax) / 2; // -26m
  const trussRadius = 9;

  // 主ビーム (縦方向コード 3本 + 内側面補強ストリンガー 3本)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);

    // 暗い赤基調主コードビーム
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, trussLength, 6), redTrussMat);
    beam.position.set(cosA * trussRadius, sinA * trussRadius, trussCenterZ);
    beam.rotation.x = Math.PI / 2;
    g.add(beam);

    // 内側面補強ストリンガー
    const innerBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, trussLength, 6), redTrussMat);
    innerBeam.position.set(cosA * (trussRadius * 0.5), sinA * (trussRadius * 0.5), trussCenterZ);
    innerBeam.rotation.x = Math.PI / 2;
    g.add(innerBeam);

    // 沿う流体配管パイプライン
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, trussLength, 6), conduitMat);
    pipe.position.set(cosA * (trussRadius + 1.8), sinA * (trussRadius + 1.8), trussCenterZ);
    pipe.rotation.x = Math.PI / 2;
    g.add(pipe);

    // 配管フランジ継手リング (12mおき)
    for (let pz = zMin; pz <= zMax; pz += 12) {
      const joint = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.6, 8), conduitJointMat);
      joint.position.set(cosA * (trussRadius + 1.8), sinA * (trussRadius + 1.8), pz);
      joint.rotation.x = Math.PI / 2;
      g.add(joint);
    }
  }

  // 鉄塔風・立体Xクロスラティス & 横方向バルクヘッドリング & 内部Kブレース
  const stepZ = 10;
  for (let z = zMin; z < zMax; z += stepZ) {
    const zNext = Math.min(z + stepZ, zMax);

    for (let i = 0; i < 3; i++) {
      const a1 = (i / 3) * Math.PI * 2;
      const a2 = (((i + 1) % 3) / 3) * Math.PI * 2;

      const p1 = new THREE.Vector3(Math.cos(a1) * trussRadius, Math.sin(a1) * trussRadius, z);
      const p2 = new THREE.Vector3(Math.cos(a2) * trussRadius, Math.sin(a2) * trussRadius, z);
      const p1Next = new THREE.Vector3(Math.cos(a1) * trussRadius, Math.sin(a1) * trussRadius, zNext);
      const p2Next = new THREE.Vector3(Math.cos(a2) * trussRadius, Math.sin(a2) * trussRadius, zNext);

      // 横方向リブ（バルクヘッド枠）
      const hMid = p1.clone().add(p2).multiplyScalar(0.5);
      const hLen = p1.distanceTo(p2);
      const hStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, hLen, 4), redTrussMat);
      hStrut.position.copy(hMid);
      hStrut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p2.clone().sub(p1).normalize());
      g.add(hStrut);

      // 斜めXブレース (対角線1: p1 -> p2Next)
      const dMid1 = p1.clone().add(p2Next).multiplyScalar(0.5);
      const dLen1 = p1.distanceTo(p2Next);
      const dStrut1 = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, dLen1, 4), redTrussMat);
      dStrut1.position.copy(dMid1);
      dStrut1.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p2Next.clone().sub(p1).normalize());
      g.add(dStrut1);

      // 斜めXブレース (対角线2: p2 -> p1Next)
      const dMid2 = p2.clone().add(p1Next).multiplyScalar(0.5);
      const dLen2 = p2.distanceTo(p1Next);
      const dStrut2 = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, dLen2, 4), redTrussMat);
      dStrut2.position.copy(dMid2);
      dStrut2.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1Next.clone().sub(p2).normalize());
      g.add(dStrut2);

      // 内部放射状Kブレース (中心軸 z -> ノード p1)
      const centerNode = new THREE.Vector3(0, 0, z);
      const kMid = centerNode.clone().add(p1).multiplyScalar(0.5);
      const kLen = centerNode.distanceTo(p1);
      const kStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, kLen, 4), conduitJointMat);
      kStrut.position.copy(kMid);
      kStrut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(centerNode).normalize());
      g.add(kStrut);

      // 節点ガセットジョイント (Node Gusset Hub)
      const nodeHub = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 8), conduitJointMat);
      nodeHub.position.copy(p1);
      g.add(nodeHub);
    }
  }

  // 3) 中腹ドッキング部 (Z = 0m, 現状の半分スケールに縮小＋詳細メカニカルディテール)
  const dockPalletMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.2, metalness: 0 });

  // 中央メインドッキングハッチ (直系5.2mに縮小)
  const hatchDoor = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 1.4, 16), dockPalletMat);
  hatchDoor.position.set(0, 7, 0);
  g.add(hatchDoor);

  const hatchRing = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 0.3, 16), panelGrooveMat);
  hatchRing.position.set(0, 7.7, 0);
  g.add(hatchRing);

  // 【半分に縮小した格子状ドッキングベイスロット (Dock 0..3 - 5.5m間隔)】
  const gridSlotPos = [
    { x: -5.5, z: -5.5 }, // Slot 0
    { x:  5.5, z: -5.5 }, // Slot 1
    { x: -5.5, z:  5.5 }, // Slot 2
    { x:  5.5, z:  5.5 }, // Slot 3
  ];

  let sIdx = 0;
  for (const slotPos of gridSlotPos) {
    // 縮小ドッキングカラー (径2.4m)
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.7, 0.8, 12), dockPalletMat);
    collar.position.set(slotPos.x, 7.0, slotPos.z);
    g.add(collar);

    // 【ディテール: 空気圧ロックラッチクランプ (4箇所/スロット)】
    for (let cAngle = 0; cAngle < Math.PI * 2; cAngle += Math.PI / 2) {
      const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.4), sensorPodMat);
      clamp.position.set(
        slotPos.x + Math.cos(cAngle) * 2.6,
        7.3,
        slotPos.z + Math.sin(cAngle) * 2.6
      );
      clamp.rotation.y = cAngle;
      g.add(clamp);
    }

    // 【ディテール: 光学レーザーアライメントセンサー (シアンLED)】
    const laserSensor = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), neonAccentMat);
    laserSensor.position.set(slotPos.x, 7.5, slotPos.z);
    g.add(laserSensor);

    // 【ディテール: アンビリカル燃料供給給油ポート】
    const umbilicalPort = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1.2, 6), conduitJointMat);
    umbilicalPort.position.set(slotPos.x + 1.8, 6.8, slotPos.z + 1.8);
    umbilicalPort.rotation.x = Math.PI / 2;
    g.add(umbilicalPort);

    sIdx++;
  }

  // 4) 主要部 (居住区 + クライレスラービル風アールデコ装飾 + 研究所観測ドーム $15.4 \times 15.4 \times 52$m, 太さ0.7倍化, Z = +49m 〜 +101m)
  const mainCenterZ = 75;
  // 白基調外骨格フレーム (太さ0.7倍: 22m -> 15.4m)
  const exoskeleton = new THREE.Mesh(new THREE.BoxGeometry(15.4, 15.4, 52), grayFrameMat);
  exoskeleton.position.set(0, 0, mainCenterZ);
  g.add(exoskeleton);

  // 【クライスラービル風アールデコ・ディテール (0.7倍スケール)】
  // 1) 垂直ピアーモールディング (Vertical Piers & Recessed Seams)
  for (const px of [-7.8, -3.85, 0, 3.85, 7.8]) {
    for (const py of [-7.8, 7.8]) {
      const vPier = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 50), conduitMat);
      vPier.position.set(px, py, mainCenterZ);
      g.add(vPier);

      const vPierY = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.4, 50), conduitMat);
      vPierY.position.set(py, px, mainCenterZ);
      g.add(vPierY);
    }
  }

  // 2) 段層セットバックモールディング (Terraced Step-back Moldings)
  for (let zStep = mainCenterZ - 20; zStep <= mainCenterZ + 20; zStep += 10) {
    const stepMolding = new THREE.Mesh(new THREE.BoxGeometry(16.0, 16.0, 0.8), grayFrameMat);
    stepMolding.position.set(0, 0, zStep);
    g.add(stepMolding);

    const seamRing = new THREE.Mesh(new THREE.BoxGeometry(16.3, 16.3, 0.25), panelGrooveMat);
    seamRing.position.set(0, 0, zStep);
    g.add(seamRing);

    // ホイールキャップ型メダリオンレリーフ (Wheel-cap Medallions)
    for (const mx of [-8.0, 8.0]) {
      const medallion = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.25, 12), conduitJointMat);
      medallion.position.set(mx, 0, zStep);
      medallion.rotation.z = Math.PI / 2;
      g.add(medallion);

      const medallionY = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.25, 12), conduitJointMat);
      medallionY.position.set(0, mx, zStep);
      medallionY.rotation.x = Math.PI / 2;
      g.add(medallionY);
    }
  }

  // 3) ガーゴイル風・翼状コーナーアビオニクススパイア (Eagle-head Gargoyle Corner Spires)
  for (const gx of [-8.2, 8.2]) {
    for (const gy of [-8.2, 8.2]) {
      const gargoyleSpire = new THREE.Mesh(new THREE.ConeGeometry(1.3, 5.0, 4), grayFrameMat);
      gargoyleSpire.position.set(gx * 1.08, gy * 1.08, mainCenterZ + 18);
      gargoyleSpire.rotation.x = Math.PI / 2 + 0.3;
      gargoyleSpire.rotation.z = Math.atan2(gy, gx);
      g.add(gargoyleSpire);
    }
  }

  // 4) サンバースト冠状アールデコアーチ (Sunburst Crown Radiac Arch Ribs)
  for (let aIdx = 0; aIdx < 4; aIdx++) {
    const archRadius = 7.7 - aIdx * 1.3;
    const archZ = mainCenterZ + 20 + aIdx * 1.5;
    const crownArch = new THREE.Mesh(new THREE.CylinderGeometry(archRadius, archRadius + 0.5, 0.8, 16), grayFrameMat);
    crownArch.position.set(0, 0, archZ);
    g.add(crownArch);

    const archGroove = new THREE.Mesh(new THREE.CylinderGeometry(archRadius + 0.6, archRadius + 0.6, 0.2, 16), panelGrooveMat);
    archGroove.position.set(0, 0, archZ);
    g.add(archGroove);
  }

  // 【ディテール: 計測機器ポッド (Sensor / Avionics pods) 4箇所】
  for (const sx of [-7.9, 7.9]) {
    for (const sy of [-7.9, 7.9]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 4.5), sensorPodMat);
      pod.position.set(sx, sy, mainCenterZ);
      g.add(pod);

      // ポッド先端のセンサーレンズ
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), neonAccentMat);
      lens.position.set(sx, sy, mainCenterZ + 2.4);
      g.add(lens);
    }
  }

  // 【居住区上部4隅の切り欠き (Recessed Corner Notches)】
  for (const cx of [-7.7, 7.7]) {
    for (const cy of [-7.7, 7.7]) {
      const cornerNotch = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 12), panelGrooveMat);
      cornerNotch.position.set(cx, cy, mainCenterZ + 20);
      g.add(cornerNotch);
    }
  }

  // 【居住区: 十字状ディテール (中央＋4方向の十字配置モジュール & 十字溝チャネル)】
  const crossPositions: readonly [number, number][] = [
    [0, 0],
    [4.2, 0],
    [-4.2, 0],
    [0, 4.2],
    [0, -4.2],
  ];
  for (const [x, y] of crossPositions) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 40, 10), whiteModuleMat);
    tube.position.set(x, y, mainCenterZ - 3);
    tube.rotation.x = Math.PI / 2;
    g.add(tube);

    const flange = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.6, 10), conduitJointMat);
    flange.position.set(x, y, mainCenterZ - 3);
    flange.rotation.x = Math.PI / 2;
    g.add(flange);

    // 【ディテール: 発光窓 (Portholes / Illuminated Windows)】
    for (let zWin = mainCenterZ - 18; zWin <= mainCenterZ + 12; zWin += 6) {
      if (x !== 0 || y !== 0) {
        const winAngle = Math.atan2(y, x);
        const winX = x + Math.cos(winAngle) * 2.02;
        const winY = y + Math.sin(winAngle) * 2.02;
        const win = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.3), windowGlowMat);
        win.position.set(winX, winY, zWin);
        g.add(win);
      }
    }
  }

  // 十字構造交差溝チャネル (Cross Seam Groove Channels)
  const crossChannelH = new THREE.Mesh(new THREE.BoxGeometry(15.6, 0.8, 0.4), panelGrooveMat);
  crossChannelH.position.set(0, 0, mainCenterZ);
  g.add(crossChannelH);

  const crossChannelV = new THREE.Mesh(new THREE.BoxGeometry(0.8, 15.6, 0.4), panelGrooveMat);
  crossChannelV.position.set(0, 0, mainCenterZ);
  g.add(crossChannelV);

  // 【居住区下部: ハニカム構造集積体ソーラーパドル一対 (彩度の低い明るいターコイズ・鏡面反射)】
  const solarCellMat = new THREE.MeshStandardMaterial({
    color: 0x5eead4,
    emissive: 0x2dd4bf,
    emissiveIntensity: 0.15,
    roughness: 0.02,
    metalness: 0,
  });

  for (const sideX of [-1, 1]) {
    const paddleGroup = new THREE.Group();
    paddleGroup.position.set(sideX * 7.8, 0, 54);

    // 主関節ジンバル & 伸縮可動ブーム
    const gimbal = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 2.5, 10), sensorPodMat);
    gimbal.rotation.z = Math.PI / 2;
    g.add(gimbal);

    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 9.0, 8), conduitMat);
    boom.position.set(sideX * 4.5, 0, 0);
    boom.rotation.z = Math.PI / 2;
    paddleGroup.add(boom);

    // ハニカム構造セル集積体 (Hexagonal Honeycomb Cell Cluster - 19個の六角セル集積)
    const hexCellGeo = new THREE.CylinderGeometry(1.1, 1.1, 0.45, 6);
    const hexBezelGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.4, 6);

    for (let ix = -3; ix <= 3; ix++) {
      const posX = sideX * 13.5 + ix * 2.1;
      for (let iz = -2; iz <= 2; iz++) {
        const posZ = iz * 2.0 + (Math.abs(ix) % 2 === 1 ? 1.0 : 0);
        if (Math.abs(posZ) <= 4.2) {
          const bezel = new THREE.Mesh(hexBezelGeo, conduitJointMat);
          bezel.position.set(posX, 0, posZ);
          paddleGroup.add(bezel);

          const cell = new THREE.Mesh(hexCellGeo, solarCellMat);
          cell.position.set(posX, 0, posZ);
          paddleGroup.add(cell);
        }
      }
    }

    g.add(paddleGroup);
  }

  // 【先端レドーム: 立方八面体 (Cuboctahedron Radome, 直径 10.2m = 居住区の2/3)】
  const radomeRadius = 5.1;
  const radomeGroup = new THREE.Group();
  radomeGroup.position.set(0, 0, mainCenterZ + 25);

  // 立方八面体 (Cuboctahedron: 12頂点, 8正三角形面 + 6正方形面)
  const c = 1 / Math.sqrt(2);
  const cuboctahedronVertices = [
    -c, -c,  0,   c, -c,  0,   c,  c,  0,  -c,  c,  0,
    -c,  0, -c,   c,  0, -c,   c,  0,  c,  -c,  0,  c,
     0, -c, -c,   0,  c, -c,   0,  c,  c,   0, -c,  c
  ];
  const cuboctahedronIndices = [
    // 8つの正三角形面
    0, 8, 1,   1, 5, 2,   2, 9, 3,   3, 4, 0,
    0, 7, 11,  1, 11, 6,  2, 6, 10,  3, 10, 4,
    // 6つの正方形面 (各2つの三角形で構成)
    0, 1, 11,  0, 11, 7,
    1, 2, 6,   1, 6, 5,
    2, 3, 10,  2, 10, 9,
    3, 0, 4,   3, 4, 7,
    4, 5, 9,   4, 8, 5,
    7, 6, 10,  7, 11, 6
  ];

  const cuboctahedronGeo = new THREE.PolyhedronGeometry(cuboctahedronVertices, cuboctahedronIndices, radomeRadius, 0);
  const cuboctahedronMesh = new THREE.Mesh(cuboctahedronGeo, whiteModuleMat);
  radomeGroup.add(cuboctahedronMesh);

  // 立方八面体の頂点・稜線継手フレーム
  const wireGeo = new THREE.WireframeGeometry(cuboctahedronGeo);
  const wireLineMat = new THREE.LineBasicMaterial({ color: 0x475569 });
  const wireLines = new THREE.LineSegments(wireGeo, wireLineMat);
  radomeGroup.add(wireLines);

  // レドーム土台のマウントアダプターカラー
  const radomeCollar = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.5, 1.4, 10), grayFrameMat);
  radomeCollar.position.set(0, 0, mainCenterZ + 19.5);
  radomeCollar.rotation.x = Math.PI / 2;
  g.add(radomeCollar);

  g.add(radomeGroup);

  // 【センサー・アンテナ群 (磁気センサーブーム)】
  // 2) 磁気センサー (Magnetometer Boom - 長尺ブーム先端の3軸センサー)
  const magBoom = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.15, 45, 6), redTrussMat);
  magBoom.position.set(0, 0, mainCenterZ + 48);
  magBoom.rotation.x = Math.PI / 2;
  g.add(magBoom);

  // 3軸磁気センサーキューブ
  const magCube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), sensorPodMat);
  magCube.position.set(0, 0, mainCenterZ + 70.5);
  g.add(magCube);

  for (const magAxis of [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ]) {
    const tipProbe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.5, 6), neonAccentMat);
    tipProbe.position.set(0, 0, mainCenterZ + 70.5).add(magAxis.clone().multiplyScalar(1.5));
    g.add(tipProbe);
  }


  // 5) カウンターウェイト部 (化学蒸留プラントコンプレックス + 136m倍長貨物区 Z = -237m 〜 -101m)
  const cwCenterZ = -169;
  // 貨物区の長さを現状の倍(68m -> 136m)に拡張
  const cwCore = new THREE.Mesh(new THREE.BoxGeometry(14, 14, 136), grayFrameMat);
  cwCore.position.set(0, 0, cwCenterZ);
  g.add(cwCore);

  // 【貨物部トラス接続部: 宇宙ステーション風 分節式小型居住モジュール & 4基の多面体状タンク】
  const habJunctionGroup = new THREE.Group();
  habJunctionGroup.position.set(0, 0, -112);

  // 1) 筒状構造が3分節して接合したモジュール (Segmented Habitation Cylinders)
  for (let s = 0; s < 3; s++) {
    const segZ = -6 + s * 6;
    const segCylinder = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 4.8, 12), whiteModuleMat);
    segCylinder.position.set(0, 0, segZ);
    segCylinder.rotation.x = Math.PI / 2;
    habJunctionGroup.add(segCylinder);

    const segRing = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 0.6, 12), conduitJointMat);
    segRing.position.set(0, 0, segZ);
    segRing.rotation.x = Math.PI / 2;
    habJunctionGroup.add(segRing);

    for (let wA = 0; wA < Math.PI * 2; wA += Math.PI / 2) {
      const pWin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 0.3), windowGlowMat);
      pWin.position.set(Math.cos(wA) * 2.82, Math.sin(wA) * 2.82, segZ);
      habJunctionGroup.add(pWin);
    }
  }

  // 2) 4基の小型多面体状タンク (Polyhedral Fuel/Gas Tanks)
  const polyTankGeo = new THREE.IcosahedronGeometry(2.2, 0);
  const polyTankPositions: readonly [number, number][] = [
    [-5.8, -5.8],
    [ 5.8, -5.8],
    [-5.8,  5.8],
    [ 5.8,  5.8],
  ];

  for (const [ptX, ptY] of polyTankPositions) {
    const pTank = new THREE.Mesh(polyTankGeo, tankMats[0]!);
    pTank.position.set(ptX, ptY, 0);
    habJunctionGroup.add(pTank);

    const mountStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 3.0, 6), conduitMat);
    mountStrut.position.set(ptX * 0.7, ptY * 0.7, 0);
    mountStrut.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(ptX, ptY, 0).normalize()
    );
    habJunctionGroup.add(mountStrut);
  }

  // 【貨物部上部: 4枚の細長い蛇腹状放熱板 & 逆位相暗色骨格 (45°, 135°, 225°, 315° R=7m〜24m, Z=-132m)】
  const radiatorPanelMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.15, metalness: 0 });
  // 骨格は放熱板と明暗を逆にするための暗色塗装。金属だと F0 がこの暗さを取れない。
  const darkSkeletonMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, flatShading: true, roughness: 0.4, metalness: 0 });

  for (let radIdx = 0; radIdx < 4; radIdx++) {
    const angle = (radIdx * Math.PI) / 2 + Math.PI / 4;
    const radGroup = new THREE.Group();
    radGroup.position.set(0, 0, -132);
    radGroup.rotation.z = angle;

    const segCount = 6;
    const segLen = 2.8;
    let currR = 7.2;

    for (let k = 0; k < segCount; k++) {
      const phaseSign = k % 2 === 0 ? 1 : -1;
      const foldZOffset = phaseSign * 0.9;
      const inverseZOffset = -phaseSign * 0.9;

      const rMid = currR + segLen / 2;

      // 1) 蛇腹折れ薄型放熱板パネル (White Radiator Leaf)
      const leafPanel = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.15, 14.0), radiatorPanelMat);
      leafPanel.position.set(rMid, foldZOffset, 0);
      leafPanel.rotation.z = phaseSign * 0.18;
      radGroup.add(leafPanel);

      // 2) 折れの位相と逆位相の暗色骨格トラス (Inverse-Phase Dark Skeleton)
      const darkTruss = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.4, 0.4), darkSkeletonMat);
      darkTruss.position.set(rMid, inverseZOffset, 0);
      darkTruss.rotation.z = -phaseSign * 0.18;
      radGroup.add(darkTruss);

      // 3) 放熱板と逆位相骨格を結ぶクロスリンクドローバー
      const linkBar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.8, 6), darkSkeletonMat);
      linkBar.position.set(rMid, 0, 0);
      radGroup.add(linkBar);

      // 蛇腹ピボットヒンジジョイント
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 14.4, 8), conduitJointMat);
      hinge.position.set(currR, 0, 0);
      hinge.rotation.x = Math.PI / 2;
      radGroup.add(hinge);

      currR += segLen;
    }

    g.add(radGroup);
  }

  // 【貨物区本体の表面凹凸ディテール (配線・計測デバイス箱・パネル溝)】
  // 1) 4隅の長尺配線・流体パイプライン
  for (const bx of [-7.1, 7.1]) {
    for (const by of [-7.1, 7.1]) {
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 138, 8), conduitMat);
      cable.position.set(bx, by, cwCenterZ);
      cable.rotation.x = Math.PI / 2;
      g.add(cable);

      for (let zClamp = cwCenterZ - 60; zClamp <= cwCenterZ + 60; zClamp += 15) {
        const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.5), conduitJointMat);
        clamp.position.set(bx, by, zClamp);
        g.add(clamp);
      }
    }
  }

  // 2) 表面計測デバイス箱 (16箇所) & レンズ
  for (let dIdx = 0; dIdx < 16; dIdx++) {
    const zBox = cwCenterZ - 56 + dIdx * 7.5;
    const face = dIdx % 4;
    const boxX = face === 0 ? 7.2 : (face === 1 ? -7.2 : 0);
    const boxY = face === 2 ? 7.2 : (face === 3 ? -7.2 : 0);

    const devBox = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 2.5), sensorPodMat);
    devBox.position.set(boxX, boxY, zBox);
    g.add(devBox);

    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), neonAccentMat);
    lens.position.set(boxX * 1.05, boxY * 1.05, zBox);
    g.add(lens);
  }

  // 3) リセスパネル溝ライン (8箇所)
  for (let zSeam = cwCenterZ - 60; zSeam <= cwCenterZ + 60; zSeam += 16) {
    const seam = new THREE.Mesh(new THREE.BoxGeometry(14.4, 14.4, 0.35), panelGrooveMat);
    seam.position.set(0, 0, zSeam);
    g.add(seam);
  }



  // 【化学プラント / 蒸留塔 (Distillation Towers Complex - 倍長バージョン)】
  // 蒸留塔 1 (100m長)
  const tower1 = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 100, 16), tankMats[0]!);
  tower1.position.set(13, 13, cwCenterZ - 5);
  tower1.rotation.x = Math.PI / 2;
  g.add(tower1);

  // 蒸留塔の段数フランジリング
  for (let zFlange = cwCenterZ - 52; zFlange <= cwCenterZ + 42; zFlange += 6) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(6.3, 6.3, 0.5, 16), conduitJointMat);
    flange.position.set(13, 13, zFlange);
    flange.rotation.x = Math.PI / 2;
    g.add(flange);

    if ((zFlange - cwCenterZ) % 18 === 0) {
      const catwalk = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 0.4, 12), conduitMat);
      catwalk.position.set(13, 13, zFlange);
      catwalk.rotation.x = Math.PI / 2;
      g.add(catwalk);
    }
  }

  // 蒸留塔 2 (84m長)
  const tower2 = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 4.8, 84, 14), tankMats[1]!);
  tower2.position.set(-13, -13, cwCenterZ + 2);
  tower2.rotation.x = Math.PI / 2;
  g.add(tower2);

  for (let zFlange = cwCenterZ - 40; zFlange <= cwCenterZ + 40; zFlange += 7) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 0.5, 14), conduitJointMat);
    flange.position.set(-13, -13, zFlange);
    flange.rotation.x = Math.PI / 2;
    g.add(flange);
  }

  // 高圧多面体ガスタンク (3基)
  const sphereTankPositions: readonly [number, number, number][] = [[-13, 13, -35], [13, -13, 20], [0, 15, -45]];
  const polyGasTankGeo = new THREE.IcosahedronGeometry(6.0, 0);
  for (const [sX, sY, sZ] of sphereTankPositions) {
    const sphereTank = new THREE.Mesh(polyGasTankGeo, tankMats[2]!);
    sphereTank.position.set(sX, sY, cwCenterZ + sZ);
    g.add(sphereTank);

    const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 2, 8), hazardOrangeMat);
    valve.position.set(sX, sY + 6.2, cwCenterZ + sZ);
    g.add(valve);
  }

  // 【コンテナ生成用ヘルパー】ISO規格リアル宇宙貨物コンテナ
  const containerCornerMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.3, metalness: 1 });
  const containerGrooveMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, flatShading: true, roughness: 0.6, metalness: 0 });
  const containerBarMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, flatShading: true, roughness: 0.2, metalness: 1 });

  const buildContainer = (w: number, h: number, d: number, mat: THREE.Material, tagMat?: THREE.Material): THREE.Group => {
    const container = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    container.add(body);

    const cSize = Math.min(w, h, d) * 0.16;
    const cornerGeo = new THREE.BoxGeometry(cSize, cSize, cSize);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const corner = new THREE.Mesh(cornerGeo, containerCornerMat);
          corner.position.set(sx * (w / 2), sy * (h / 2), sz * (d / 2));
          container.add(corner);
        }
      }
    }

    const ribCount = Math.max(3, Math.floor(d / 1.6));
    for (let i = 0; i < ribCount; i++) {
      const zPos = -d / 2 + ((i + 0.5) * d) / ribCount;
      for (const sx of [-1, 1]) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.12, h * 0.85, 0.45), containerGrooveMat);
        rib.position.set(sx * (w / 2 + 0.04), 0, zPos);
        container.add(rib);
      }
    }

    const doorZ = d / 2 + 0.05;
    const doorSeam = new THREE.Mesh(new THREE.BoxGeometry(0.08, h * 0.88, 0.12), containerGrooveMat);
    doorSeam.position.set(0, 0, doorZ);
    container.add(doorSeam);

    const barGeo = new THREE.CylinderGeometry(0.08, 0.08, h * 0.82, 6);
    for (const bx of [-w * 0.24, w * 0.24]) {
      const lockBar = new THREE.Mesh(barGeo, containerBarMat);
      lockBar.position.set(bx, 0, doorZ);
      container.add(lockBar);

      const handle = new THREE.Mesh(new THREE.BoxGeometry(w * 0.18, 0.08, 0.1), containerBarMat);
      handle.position.set(bx + (bx > 0 ? -w * 0.08 : w * 0.08), -h * 0.15, doorZ + 0.04);
      container.add(handle);
    }

    if (tagMat) {
      const tag = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, h * 0.25, 0.1), tagMat);
      tag.position.set(w * 0.22, h * 0.22, doorZ + 0.02);
      container.add(tag);
    }

    return container;
  };

  // 【多彩な貨物ビルダー: 8種類の多様な規格化宇宙貨物モジュール (白系基調)】
  const buildAdvancedCargoGroup = (typeIdx: number, mat: THREE.Material, tagMat?: THREE.Material): THREE.Group => {
    const cargo = new THREE.Group();
    const kind = typeIdx % 8;

    if (kind === 0) {
      cargo.add(buildContainer(4.5, 4.5, 9.0, mat, tagMat));
    } else if (kind === 1) {
      const reeferMat = containerMats[0]!;
      const c = buildContainer(4.5, 4.8, 9.0, reeferMat, tagMat);
      const cooler = new THREE.Mesh(new THREE.BoxGeometry(4.0, 4.0, 0.4), sensorPodMat);
      cooler.position.set(0, 0, -4.5);
      c.add(cooler);
      const coolerLed = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 6), neonAccentMat);
      coolerLed.position.set(1.5, 1.5, -4.7);
      c.add(coolerLed);
      cargo.add(c);
    } else if (kind === 2) {
      const w = 4.5, h = 4.5, d = 9.0;
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.3, metalness: 1 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 8.4, 12), mat);
      tank.rotation.x = Math.PI / 2;
      cargo.add(tank);
      for (const sz of [-4.2, 4.2]) {
        const cap = new THREE.Mesh(new THREE.SphereGeometry(2.0, 12, 8), mat);
        cap.position.set(0, 0, sz);
        cargo.add(cap);
      }
      cargo.add(frame);
    } else if (kind === 3) {
      const w = 4.5, h = 1.0, d = 9.0;
      const bed = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), containerMats[1]!);
      cargo.add(bed);
      const machine = new THREE.Mesh(new THREE.BoxGeometry(3.6, 3.2, 7.0), sensorPodMat);
      machine.position.set(0, 2.1, 0);
      cargo.add(machine);
      for (const zS of [-2.5, 0, 2.5]) {
        const strap = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.4, 0.3), hazardOrangeMat);
        strap.position.set(0, 2.0, zS);
        cargo.add(strap);
      }
    } else if (kind === 4) {
      const w = 4.5, h = 4.5, d = 9.0;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), containerMats[3]!);
      cargo.add(frame);
      for (const bx of [-1.2, 1.2]) {
        for (const by of [-1.2, 1.2]) {
          const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 8.0, 10), tankMats[1]!);
          bottle.position.set(bx, by, 0);
          bottle.rotation.x = Math.PI / 2;
          cargo.add(bottle);
        }
      }
    } else if (kind === 5) {
      const w = 4.5, h = 4.5, d = 9.0;
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.3, metalness: 1 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
      cargo.add(frame);
      for (const zSph of [-2.2, 2.2]) {
        const sphereTank = new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 10), tankMats[0]!);
        sphereTank.position.set(0, 0, zSph);
        cargo.add(sphereTank);
      }
    } else if (kind === 6) {
      const hexMat = containerMats[2]!;
      const hexBody = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 8.8, 6), hexMat);
      hexBody.rotation.x = Math.PI / 2;
      cargo.add(hexBody);
      for (const zRing of [-3.0, 0, 3.0]) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.4, 6), conduitJointMat);
        ring.position.set(0, 0, zRing);
        ring.rotation.x = Math.PI / 2;
        cargo.add(ring);
      }
    } else {
      const w = 4.5, h = 4.5, d = 9.0;
      const trussFrameMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.25, metalness: 0 });
      const outerFrame = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), trussFrameMat);
      cargo.add(outerFrame);
      for (const zCube of [-2.0, 2.0]) {
        const avCube = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 3.2), sensorPodMat);
        avCube.position.set(0, 0, zCube);
        cargo.add(avCube);
      }
    }
    return cargo;
  };

  // 【居住区用の少量貨物モジュール (12個の小型コンテナポッド群)】
  let habCargoIdx = 0;
  for (const quadX of [-1, 1]) {
    for (const quadY of [-1, 1]) {
      for (let zH = mainCenterZ - 14; zH <= mainCenterZ + 10; zH += 12) {
        const posX = quadX * 9.2;
        const posY = quadY * 9.2;
        const mat = containerMats[habCargoIdx % containerMats.length]!;
        const habCargo = buildAdvancedCargoGroup(habCargoIdx, mat);
        habCargo.position.set(posX, posY, zH);
        habCargo.scale.set(0.65, 0.65, 0.65); // 居住区用小型化
        habCargo.rotation.set(0, 0, 0);
        g.add(habCargo);
        habCargoIdx++;
      }
    }
  }

  // 決定論的疑似乱数ヘルパー (再現性のある不規則乱雑配置)
  const pseudoHash = (n: number): number => {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  // 【貨物区(136m長)表面全周へばりつき不均等配置 (100個) & 角度揃え(0,0,0)】
  let cIdx = 0;
  for (let zStep = 0; zStep < 42; zStep++) {
    const zBase = cwCenterZ - 62 + zStep * 3.0;

    // 貨物区4つの壁面 (+X, -X, +Y, -Y) の全周へばりつきスロット
    for (let face = 0; face < 4; face++) {
      const randSeed = zStep * 100 + face * 13;
      if (pseudoHash(randSeed) < 0.48) continue; // 不均等な空き・虫食いスロット

      const stackLimit = 1 + Math.floor(pseudoHash(randSeed * 1.7) * 2.8); // 1〜3段積み

      for (let layer = 0; layer < stackLimit; layer++) {
        const zOffset = (pseudoHash(randSeed + layer * 7) - 0.5) * 2.4;
        const latOffset = (pseudoHash(randSeed * 2.3 + layer) - 0.5) * 5.2; // 壁面に沿う不均等な横シフト
        const surfDist = 9.25 + layer * 4.4; // 貨物部壁面(R=7.0m)にぴったりへばりつく距離

        let posX = 0;
        let posY = 0;
        if (face === 0) { // +X 面
          posX = surfDist;
          posY = latOffset;
        } else if (face === 1) { // -X 面
          posX = -surfDist;
          posY = latOffset;
        } else if (face === 2) { // +Y 面
          posX = latOffset;
          posY = surfDist;
        } else { // -Y 面
          posX = latOffset;
          posY = -surfDist;
        }

        const mat = containerMats[cIdx % containerMats.length]!;
        const tagMat = cIdx % 4 === 0 ? (cIdx % 8 === 0 ? neonAccentMat : hazardOrangeMat) : undefined;

        const cargoObj = buildAdvancedCargoGroup(cIdx, mat, tagMat);
        cargoObj.position.set(posX, posY, zBase + zOffset);
        cargoObj.rotation.set(0, 0, 0); // 角度は揃える
        g.add(cargoObj);

        cIdx++;
        if (cIdx >= 100) break;
      }
      if (cIdx >= 100) break;
    }
    if (cIdx >= 100) break;
  }

  // 基地の全体サイズを 3倍 に変更
  g.scale.setScalar(3.0);

  markLitOpaque(g);
  markSunShadowCaster(g);
  return g;
}
