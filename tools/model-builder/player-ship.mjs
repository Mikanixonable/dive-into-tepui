// 自機のモデル。機首は +Z。太陽電池パドルと放熱板は、折り目ごとの Group を入れ子にした蛇腹。
import * as THREE from 'three';
import { importTsDataModule } from '../compile-source.mjs';
import { F0_BURNT_STEEL, F0_STEEL, std } from './materials.mjs';

const { RCS_NOZZLES } = await importTsDataModule('src/render/rcs-nozzles.ts');
const { RADIATOR_HINGE } = await importTsDataModule('src/physics/player-shape.ts');

// 機関砲の銃口位置(機体座標系、前面に縦に並んだ 2 つの大きな短い穴)。
const MUZZLE_OFFSETS = [
  { x: 0, y: 0.55, z: 2.55 },
  { x: 0, y: -0.55, z: 2.55 },
];

// 自機: テーパードハル + 突き出した砲身 + ベルノズルエンジン + 大型ソーラーパネル
// コックピット窓・アンテナ・アーマーストリップを追加してリッチ化。
// 機首は +Z 方向。
export function buildPlayerShip() {
  const g = new THREE.Group();

  // === ハル(前部は細く後部は太い2段テーパー構成) ===
  const hullMat   = std(0xcdd3de, { roughness: 0.55 });
  const noseMat   = std(0xb2bccb, { roughness: 0.50 });
  const armorMat  = std(0xaab4c2, { roughness: 0.48 });

  // 後部胴体(幅広)
  const rearHull = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.0, 3.2), hullMat);
  rearHull.position.z = -1.15;
  g.add(rearHull);

  // 前部胴体(若干細め → テーパー感)
  const fwdHull = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.8, 2.0), hullMat);
  fwdHull.position.z = 1.5;
  g.add(fwdHull);

  // 機首フェイスプレート
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.6, 0.14), noseMat);
  nose.position.z = 2.47;
  g.add(nose);

  // 左右アーマーストリップ(縦通材)
  for (const sx of [-1, 1]) {
    const armor = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.75, 5.0), armorMat);
    armor.position.set(sx * 1.20, 0, -0.10);
    g.add(armor);
  }

  // 上下アーマーストリップ
  for (const sy of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.09, 5.0), armorMat);
    strip.position.set(0, sy * 1.05, -0.10);
    g.add(strip);
  }

  // === コックピット窓(前面に埋め込み暗窓) ===
  const cockpitMat = new THREE.MeshStandardMaterial({
    color: 0x0a1828, flatShading: true, metalness: 0, roughness: 0.18,
  });
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.52, 0.05), cockpitMat);
  cockpit.position.set(0, 0.36, 2.51);
  g.add(cockpit);
  // 窓枠
  const frameGeo = new THREE.BoxGeometry(0.90, 0.64, 0.04);
  const frameMesh = new THREE.Mesh(frameGeo, std(0x9aa3ae, { metalness: 1, roughness: 0.35 }));
  frameMesh.position.set(0, 0.36, 2.48);
  g.add(frameMesh);

  // === 砲身(銃口位置から前方へ突き出す) ===
  // ボアは発射煙のすすで覆われた穴なので金属ではない(色は拡散アルベドとして読まれる)。
  const boreMat    = std(0x10131a, { roughness: 0.65 });
  const rimMat     = std(F0_STEEL, { metalness: 1, roughness: 0.28 });
  const barrelMat  = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.40 });

  for (const m of MUZZLE_OFFSETS) {
    // ハル内部を通る砲身チューブ(z=0.0 〜 z=2.45)
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 2.0, 10), barrelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(m.x, m.y, 1.45);
    g.add(barrel);

    // 砲口カラー(ハル前面との接合部リング)
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.10, 10), rimMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.set(m.x, m.y, m.z - 0.42);
    g.add(collar);

    // マズルブレーキ(3連リング)
    for (let ri = 0; ri < 3; ri++) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.30, 0.07, 10), rimMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(m.x, m.y, m.z - 0.20 + ri * 0.14);
      g.add(ring);
    }

    // 砲口ボア(最前端の暗い穴)
    const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.16, 10), boreMat);
    bore.rotation.x = Math.PI / 2;
    bore.position.set(m.x, m.y, m.z + 0.04);
    g.add(bore);
  }

  // === エンジン(ベルノズル形状) ===
  const engMat     = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.45 });
  const nozzleMat  = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.28 });
  const glowMat    = new THREE.MeshBasicMaterial({ color: 0x77dbff, transparent: true, opacity: 0.92 });
  const heatRingMat = new THREE.MeshBasicMaterial({ color: 0xff7722, transparent: true, opacity: 0.55 });

  // エンジン取付プレート(後端)
  const mountPlate = new THREE.Mesh(
    new THREE.BoxGeometry(2.12, 1.82, 0.18),
    std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.5 }),
  );
  mountPlate.position.z = -2.72;
  g.add(mountPlate);

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      // エンジン外壁(シュラウド)
      const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.44, 0.90, 10), engMat);
      eng.rotation.x = Math.PI / 2;
      eng.position.set(sx * 0.60, sy * 0.56, -2.86);
      g.add(eng);

      // ノズルベル(出口方向に広がる)
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.62, 0.55, 10), nozzleMat);
      nozzle.rotation.x = Math.PI / 2;
      nozzle.position.set(sx * 0.60, sy * 0.56, -3.38);
      g.add(nozzle);

      // ノズル出口エッジリング
      const exitRing = new THREE.Mesh(new THREE.CylinderGeometry(0.63, 0.63, 0.055, 12), rimMat);
      exitRing.rotation.x = Math.PI / 2;
      exitRing.position.set(sx * 0.60, sy * 0.56, -3.68);
      g.add(exitRing);

      // エンジングロー(内部発光)
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.30, 0.12, 10), glowMat);
      glow.rotation.x = Math.PI / 2;
      glow.position.set(sx * 0.60, sy * 0.56, -3.70);
      g.add(glow);
      // ヒートリングは省略
    }
  }

  // === 太陽電池パドル (展開式・蛇腹6折り) ===
  const SOLAR_FOLD_COUNT = 6;
  const SOLAR_LENGTH = 2.4;
  const SOLAR_SEG = SOLAR_LENGTH / SOLAR_FOLD_COUNT;
  const SOLAR_WIDTH = 1.5;
  const SOLAR_STACK_NUDGE = 0.012;
  const panelMat   = std(0x1a3a8c, { roughness: 0.52 });
  const panelFrame = std(F0_STEEL, { metalness: 1, roughness: 0.33 });

  for (const side of [-1, 1]) {
    const baseName = side > 0 ? 'solarUp' : 'solarDown';
    const hinge = new THREE.Group();
    hinge.name = baseName;
    // 胴体側面から伸びる (x = ±1.17, y = 0.52, z = -1.80)
    hinge.position.set(side * 1.17, 0.52, -1.80);
    g.add(hinge);

    let parent = hinge;
    for (let i = 0; i < SOLAR_FOLD_COUNT; i++) {
      const fold = new THREE.Group();
      fold.name = `${baseName}Fold${i}`;
      if (i > 0) fold.position.set(side * SOLAR_SEG, 0, 0);
      parent.add(fold);

      // パネル面 (幅をZ方向に、長さをX方向のセグメントとして配置)
      const panel = new THREE.Mesh(new THREE.BoxGeometry(SOLAR_SEG, 0.02, SOLAR_WIDTH - 0.1), panelMat);
      panel.position.set(side * SOLAR_SEG / 2, 0, i * SOLAR_STACK_NUDGE);
      fold.add(panel);

      // 外枠(上下Z辺)
      for (const fz of [-SOLAR_WIDTH/2 + 0.05, SOLAR_WIDTH/2 - 0.05]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(SOLAR_SEG, 0.04, 0.1), panelFrame);
        bar.position.set(side * SOLAR_SEG / 2, 0, i * SOLAR_STACK_NUDGE + fz);
        fold.add(bar);
      }

      // 内部格子(X辺) - 端点と中央
      for (const fx of [0, SOLAR_SEG/2, SOLAR_SEG]) {
        const div = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, SOLAR_WIDTH), panelFrame);
        div.position.set(side * fx, 0, i * SOLAR_STACK_NUDGE);
        fold.add(div);
      }

      parent = fold;
    }
  }

  // === 展開式ラジエーター(機体側面・太陽電池パドル下に1枚ずつ、蛇腹6折り) ===
  // 1折りはハル幅と揃えた 2.3×2.3 の正方形。折り目 Group を入れ子にし、
  // 各折り目の rotation.y だけで蛇腹全体の伸縮を表現できるようにする
  // (src/game/player/radiator.ts の sync が毎フレーム書き込む)。
  // 折り目名 `${radiatorUp/Down}Fold${i}` は src/render/dynamic/player/radiator-view.ts が引く接頭辞と一致させる。
  // ヒンジは太陽電池パネル(x=±2.62, y=0.52, z=-2.20)の直下・機体側面に取り付ける
  // (up が +X 側、down が -X 側。名称は上下のまま維持)。y=0.30 はパネル下端(y≈0.4925)や
  // パネル接続ストラット/ブラケット(y≈0.47〜0.57)と、蛇腹の骨格張り出し(±0.12)を含めても
  // 干渉しない値。回転軸は Y、伸びる方向はローカル X(up は +X、down は -X)、
  // 放熱面の薄い軸(法線)はローカル Z — 全開でパネル法線が太陽電池パネル(法線 +Y)と
  // 垂直になり、前後方向から見て面積が最大に見える。
  const radiatorMat = std(0xdde3ea, { roughness: 0.8 });
  const radiatorSkeletonMat = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.55 });
  const RADIATOR_FOLD_COUNT = 6;
  const RADIATOR_SEG = (2.3 * 4) / RADIATOR_FOLD_COUNT; // 全長を変えない
  const RADIATOR_WIDTH = 2.3 / 4; // 大きさを1/4に
  const RADIATOR_STACK_NUDGE = 0.012; // 収納時に折り目同士が同一平面へ重なる際の Z ファイティング回避
  const RADIATOR_SKELETON_OFFSET = 0.04; // 骨格を放熱面の反対側へ張り出す量

  for (const sx of [1, -1]) {
    const hinge = new THREE.Group();
    const baseName = sx > 0 ? 'radiatorUp' : 'radiatorDown';
    hinge.name = baseName;
    hinge.position.set(sx * RADIATOR_HINGE.x, RADIATOR_HINGE.y, RADIATOR_HINGE.z);
    g.add(hinge);

    let parent = hinge;
    for (let i = 0; i < RADIATOR_FOLD_COUNT; i++) {
      const fold = new THREE.Group();
      fold.name = `${baseName}Fold${i}`;
      // 次の折り目は側面の外向き(up:+X、down:-X)へローカル X で積み重なる。
      if (i > 0) fold.position.set(sx * RADIATOR_SEG, 0, 0);
      parent.add(fold);

      // 放熱面: 回転中心(折り目)がセグメントの根元に来るよう、板は半分先(次の折り目と同じ向き)へずらす。
      const panel = new THREE.Mesh(new THREE.BoxGeometry(RADIATOR_SEG, RADIATOR_WIDTH, 0.04), radiatorMat);
      panel.position.set(sx * RADIATOR_SEG / 2, 0, i * RADIATOR_STACK_NUDGE);
      fold.add(panel);

      // 骨格: 放熱面と逆位相(偶数折りは +Z、奇数折りは -Z)に張り出す細材2本。
      const skeletonZ = (i % 2 === 0 ? 1 : -1) * RADIATOR_SKELETON_OFFSET;
      for (const wy of [-1, 1]) {
        // 骨格が板の端に来るように移動
        const rodY = wy * (RADIATOR_WIDTH / 2 - 0.04);
        const rod = new THREE.Mesh(new THREE.BoxGeometry(RADIATOR_SEG, 0.08, 0.08), radiatorSkeletonMat);
        rod.position.set(sx * RADIATOR_SEG / 2, rodY, skeletonZ);
        fold.add(rod);
      }

      parent = fold;
    }
  }

  // === 姿勢制御RCS(機首側4隅のブロックに、噴射方向へ開くノズルベルと前進用ノズル) ===
  const rcsMat      = std(0x9aa3ad, { metalness: 1, roughness: 0.5 });
  const rcsNozzMat  = std(0xb5bfc9, { metalness: 1, roughness: 0.28 });
  const rcsBlockKeys = new Set();
  for (const n of RCS_NOZZLES) {
    const blockKey = `${n.pos.x},${n.pos.y},${n.pos.z}`;
    // 同じ取付位置に複数のノズルが載るので、ブロック本体は最初の1基でだけ作る
    if (!rcsBlockKeys.has(blockKey)) {
      rcsBlockKeys.add(blockKey);
      const rcs = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.30, 0.30), rcsMat);
      rcs.position.set(n.pos.x, n.pos.y, n.pos.z);
      g.add(rcs);
      const nozzleSmall = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.11, 6), rcsNozzMat);
      nozzleSmall.rotation.x = Math.PI / 2;
      nozzleSmall.position.set(n.pos.x, n.pos.y, n.pos.z + 0.21);
      g.add(nozzleSmall);
    }
    // 噴射方向へ広がるベル(CylinderGeometry のローカル +Y を dir へ向ける)
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.07, 0.13, 6), rcsNozzMat);
    bell.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(n.dir.x, n.dir.y, n.dir.z),
    );
    bell.position.set(n.pos.x + n.dir.x * 0.2, n.pos.y + n.dir.y * 0.2, n.pos.z + n.dir.z * 0.2);
    g.add(bell);
  }

  // 左右向き並訳RCS (機体中央附近、前後 2 箇所)
  const sideRcsNozzMat = std(0xb5bfc9, { metalness: 1, roughness: 0.28 });
  for (const sideX of [-1, 1]) {
    for (const sz of [0.8, -0.8]) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.20, 0.20), rcsMat);
      block.position.set(sideX * 1.22, 0, sz);
      g.add(block);
      // ノズル（X方向に向く）
      const nzX = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.12, 6), sideRcsNozzMat);
      nzX.rotation.z = Math.PI / 2; // 軸をX方向に向ける
      nzX.position.set(sideX * (1.22 + 0.16), 0, sz);
      g.add(nzX);
    }
  }

  // 上下向き並訳RCS (機体上面/下面、前後 2 箇所)
  for (const sideY of [-1, 1]) {
    for (const sz of [0.6, -0.6]) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.20, 0.20), rcsMat);
      block.position.set(0, sideY * 1.05, sz);
      g.add(block);
      // ノズル（Y方向に向く）
      const nzY = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.12, 6), sideRcsNozzMat);
      nzY.rotation.z = 0; // 已に Y 軸方向
      nzY.position.set(0, sideY * (1.05 + 0.16), sz);
      g.add(nzY);
    }
  }

  // === マガジン取込口(右側+X前方)・排出口(左側-X後方) ===
  const portMat    = std(F0_BURNT_STEEL, { metalness: 1, roughness: 0.35 });
  const portFrameMat = std(F0_STEEL, { metalness: 1, roughness: 0.40 });

  // 取込口(右面 +X, z=+0.5 後方富)
  const intakeSlot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.15, 0.82), portMat);
  intakeSlot.position.set(1.08, 0, 0.5);
  g.add(intakeSlot);
  // 取込口フレーム
  const intakeFrameTop = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.88), portFrameMat);
  intakeFrameTop.position.set(1.08, 0.60, 0.5);
  g.add(intakeFrameTop);
  const intakeFrameBot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.88), portFrameMat);
  intakeFrameBot.position.set(1.08, -0.60, 0.5);
  g.add(intakeFrameBot);
  // ガイドレール(上下内側に細張り)
  for (const gy of [-0.28, 0.28]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.80), portFrameMat);
    rail.position.set(1.10, gy, 0.5);
    g.add(rail);
  }

  // 排出口(左面 -X, z=-0.8 後方)
  const ejectSlot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.05, 0.72), portMat);
  ejectSlot.position.set(-1.08, 0, -0.8);
  g.add(ejectSlot);
  // 排出口フレーム
  const ejectFrameTop = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.78), portFrameMat);
  ejectFrameTop.position.set(-1.08, 0.55, -0.8);
  g.add(ejectFrameTop);
  const ejectFrameBot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.78), portFrameMat);
  ejectFrameBot.position.set(-1.08, -0.55, -0.8);
  g.add(ejectFrameBot);
  // 排出角(後方に傾斜のガイド)
  const ejectRamp = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.70), portFrameMat);
  ejectRamp.position.set(-1.10, 0, -0.8);
  g.add(ejectRamp);

  // === アンテナ ===
  const antMat = std(F0_STEEL, { metalness: 1, roughness: 0.30 });
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 1.50, 5), antMat);
  ant.position.set(0.26, 1.22, 0.32);
  g.add(ant);
  const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 4), std(0xd9e0ea));
  antTip.position.set(0.26, 2.00, 0.32);
  g.add(antTip);

  // === 航法ビーコン ===
  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.16, 0.16),
    new THREE.MeshBasicMaterial({ color: 0x4dffc4 }),
  );
  beacon.position.set(0, 1.12, -1.60);
  g.add(beacon);

  return g;
}
