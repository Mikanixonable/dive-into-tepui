// プリミティブ組み合わせによるローポリ機体・弾・薬莢・デブリのメッシュ生成。
// 機体の機首は +Z 方向。
import * as THREE from 'three/webgpu';

function std(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.6,
    metalness: 0.25,
    ...opts,
  });
}

export function buildPlayerShip(): THREE.Group {
  const g = new THREE.Group();

  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 4.2), std(0xd8dde6));
  g.add(hull);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.6, 6), std(0xb8c2cf));
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 2.9;
  g.add(nose);

  const gun = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 2.2, 6),
    std(0x555c66, { metalness: 0.7, roughness: 0.35 }),
  );
  gun.rotation.x = Math.PI / 2;
  gun.position.set(0, -0.35, 3.2);
  g.add(gun);

  const engine = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 0.85, 0.8, 8),
    std(0x3a3f47, { metalness: 0.6 }),
  );
  engine.rotation.x = Math.PI / 2;
  engine.position.z = -2.4;
  g.add(engine);

  const nozzleGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.62, 0.2, 8),
    new THREE.MeshBasicMaterial({ color: 0x66d9ff, transparent: true, opacity: 0.9 }),
  );
  nozzleGlow.rotation.x = Math.PI / 2;
  nozzleGlow.position.z = -2.85;
  g.add(nozzleGlow);

  // 太陽電池パネル
  const panelMat = std(0x2456c8, { metalness: 0.5, roughness: 0.4 });
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.08, 1.6), panelMat);
    panel.position.set(side * 2.5, 0, -0.6);
    g.add(panel);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.12), std(0x8a919c));
    strut.position.set(side * 1.1, 0, -0.6);
    g.add(strut);
  }

  // RCS スラスタブロック
  const rcsMat = std(0x9aa3ad);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const rcs = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), rcsMat);
      rcs.position.set(sx * 0.75, sy * 0.65, 1.6);
      g.add(rcs);
    }
  }

  // 視認用アクセント灯
  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x4dffc4 }),
  );
  beacon.position.set(0, 0.75, -1.6);
  g.add(beacon);

  return g;
}

export function buildEnemyShip(accent = 0xff4a3d): THREE.Group {
  const g = new THREE.Group();

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), std(0x4a4f58));
  core.scale.set(0.8, 0.8, 1.4);
  g.add(core);

  const ringMat = std(0x666d78, { metalness: 0.5 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.18, 4, 8), ringMat);
  g.add(ring);

  const finMat = std(accent, { metalness: 0.3, roughness: 0.5 });
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.1), finMat);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 1.7, Math.sin(a) * 1.7, -0.9);
    fin.rotation.z = a + Math.PI / 2;
    g.add(fin);
  }

  // 敵識別用の発光部(遠距離でも点として見える)
  const lampMat = new THREE.MeshBasicMaterial({ color: accent });
  const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), lampMat);
  lamp.position.z = 1.9;
  g.add(lamp);

  return g;
}

// 進行方向 +Z に伸びる曳光弾(ジオメトリ・マテリアルは全弾で共有)
const bulletGeo = new THREE.BoxGeometry(0.22, 0.22, 6);
const bulletMat = new THREE.MeshBasicMaterial({
  color: 0xffc86e,
  transparent: true,
  opacity: 0.95,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

export function buildBulletMesh(): THREE.Mesh {
  const m = new THREE.Mesh(bulletGeo, bulletMat);
  m.frustumCulled = false;
  return m;
}

const casingGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.52, 5);
const casingMat = new THREE.MeshStandardMaterial({
  color: 0xd9a441,
  flatShading: true,
  metalness: 0.85,
  roughness: 0.35,
});

export function buildCasingMesh(): THREE.Mesh {
  return new THREE.Mesh(casingGeo, casingMat);
}

// 破片: 塊・外板(パネル)・桁(ロッド)の 3 種をランダムに混ぜる。
// 撃破時の飛散と被弾時の欠片の両方で使う。
export function buildDebrisMesh(accent: number, size: number): THREE.Mesh {
  const kind = Math.random();
  let geo: THREE.BufferGeometry;
  if (kind < 0.45) {
    // 不規則な低ポリ塊
    const tetra = new THREE.TetrahedronGeometry(size, 0);
    const pos = tetra.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * (0.6 + Math.random() * 0.9),
        pos.getY(i) * (0.6 + Math.random() * 0.9),
        pos.getZ(i) * (0.6 + Math.random() * 0.9),
      );
    }
    tetra.computeVertexNormals();
    geo = tetra;
  } else if (kind < 0.78) {
    // ちぎれた外板(タンブリングで表裏がチラつき、破片らしく見える)
    geo = new THREE.BoxGeometry(size * (1.2 + Math.random() * 0.8), size * 0.1, size * (0.8 + Math.random() * 0.6));
  } else {
    // 折れた桁・配管
    geo = new THREE.CylinderGeometry(size * 0.1, size * 0.13, size * (1.6 + Math.random()), 5);
  }
  const dark = Math.random() < 0.6;
  const mat = std(dark ? 0x3c4149 : accent, { roughness: 0.8, metalness: 0.2 });
  return new THREE.Mesh(geo, mat);
}

// カメラ方向を向く発光ビルボード(マズルフラッシュ・爆発)
export function buildFlashMesh(texture: THREE.Texture, color: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    color,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  m.renderOrder = 5;
  return m;
}
