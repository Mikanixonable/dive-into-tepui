// hull-loft.ts の回帰テスト。ロフトの物理量は閉形式で求まるはずなので、円柱・直方体・角錐台・円錐の
// 既知の解析解と、対称性から決まる慣性乗積の消失を固定する。輪郭を120点に落とす近似が入るのは曲線を
// 含む断面だけなので、多角形断面については機械精度で一致することを要求する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  CrossSection,
  SectionPrimitive,
  Vec2,
  sectionMoments,
} from '../../src/physics/section-moments';
import {
  InertiaTensor,
  LOFT_SAMPLE_COUNT,
  alignOutlines,
  loftCentroid,
  loftInertia,
  loftProjectedArea,
  loftLateralArea,
  loftVolume,
  sectionOutline,
} from '../../src/physics/hull-loft';
import { v3 } from '../../src/physics/vec3';

function close(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} vs ${expected} (差 ${Math.abs(actual - expected)}, 許容 ${tolerance})`,
  );
}

function primitive(over: Partial<SectionPrimitive> & Pick<SectionPrimitive, 'id' | 'shape'>): SectionPrimitive {
  return { phaseAngle: 0, attachment: null, ...over };
}

function squareSection(radius: number, phaseAngle = 0): CrossSection {
  return { primitives: [primitive({ id: 'square', shape: { kind: 'polygon', sides: 4, radius }, phaseAngle })] };
}

// 正方形の一辺に、辺の長さの等しい正三角形を貼り付けた家型の断面。対称軸が座標軸から傾くため
// 慣性乗積が消えない。
function houseSection(radius: number, phaseAngle: number): CrossSection {
  const side = radius * Math.SQRT2;
  return {
    primitives: [
      primitive({ id: 'square', shape: { kind: 'polygon', sides: 4, radius }, phaseAngle }),
      primitive({
        id: 'roof',
        shape: { kind: 'polygon', sides: 3, radius: side / Math.sqrt(3) },
        attachment: { parentId: 'square', parentFaceIndex: 0, childFaceIndex: 0 },
      }),
    ],
  };
}

// 半径 radius の円に内接する正 count 角形の輪郭。断面の口を持たない素の円を表すため、CrossSection を
// 経由せずに輪郭として直接与える。
function circleOutline(radius: number, count = LOFT_SAMPLE_COUNT, phase = 0): readonly Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const angle = phase + (2 * Math.PI * i) / count;
    points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return points;
}

// 錐の頂点。面積0の断面は CrossSection では書けないため、輪郭として与える。
function apexOutline(count = LOFT_SAMPLE_COUNT): readonly Vec2[] {
  return Array.from({ length: count }, () => ({ x: 0, y: 0 }));
}

function outlineArea(outline: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function outlinePerimeter(outline: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

type Mat3 = number[][];

function tensorMatrix(t: InertiaTensor): Mat3 {
  return [
    [t.ixx, t.ixy, t.ixz],
    [t.ixy, t.iyy, t.iyz],
    [t.ixz, t.iyz, t.izz],
  ];
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[i][k] * b[k][j];
      out[i][j] = sum;
    }
  }
  return out;
}

function transpose(a: Mat3): Mat3 {
  return [
    [a[0][0], a[1][0], a[2][0]],
    [a[0][1], a[1][1], a[2][1]],
    [a[0][2], a[1][2], a[2][2]],
  ];
}

// 質量 mass の剛体の慣性テンソルを、変位 d だけ離れた点まわりへ移す。
function shifted(inertia: Mat3, mass: number, d: readonly number[]): Mat3 {
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = inertia[i][j] + mass * ((i === j ? dd : 0) - d[i] * d[j]);
    }
  }
  return out;
}

// 対称行列の固有値を昇順で返す(ヤコビ法)。
function principalMoments(matrix: Mat3): number[] {
  const a = matrix.map((row) => row.slice());
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (a[p][q] === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const sign = theta >= 0 ? 1 : -1;
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const kp = a[k][p];
          const kq = a[k][q];
          a[k][p] = c * kp - s * kq;
          a[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < 3; k++) {
          const pk = a[p][k];
          const qk = a[q][k];
          a[p][k] = c * pk - s * qk;
          a[q][k] = s * pk + c * qk;
        }
      }
    }
  }
  return [a[0][0], a[1][1], a[2][2]].sort((x, y) => x - y);
}

export function register(): void {
  test('hull-loft: 円断面の等断面ロフトが円柱の解析値と一致する', () => {
    const radius = 1.7;
    const length = 4.3;
    const density = 850;
    const outline = circleOutline(radius);
    const mass = density * Math.PI * radius * radius * length;

    // 輪郭を120点に落とすため、円柱との差は正120角形と円の差(相対1e-3程度)に収まる。
    const volume = loftVolume(outline, outline, length);
    close(volume, Math.PI * radius * radius * length, 1e-3 * volume, '円柱の体積');
    close(loftCentroid(outline, outline, length), length / 2, 1e-12 * length, '円柱の重心位置');

    const inertia = loftInertia(outline, outline, length, density);
    const izz = 0.5 * mass * radius * radius;
    const ixx = (mass * (3 * radius * radius + length * length)) / 12;
    close(inertia.izz, izz, 2e-3 * izz, '円柱の軸まわり慣性');
    close(inertia.ixx, ixx, 2e-3 * ixx, '円柱の横まわり慣性 (x)');
    close(inertia.iyy, ixx, 2e-3 * ixx, '円柱の横まわり慣性 (y)');
    close(inertia.ixy, 0, 1e-9 * izz, '円柱の慣性乗積 ixy');
    close(inertia.ixz, 0, 1e-9 * izz, '円柱の慣性乗積 ixz');
    close(inertia.iyz, 0, 1e-9 * izz, '円柱の慣性乗積 iyz');
  });

  test('hull-loft: 正方形断面の角柱の慣性テンソルが直方体の教科書式と一致する', () => {
    const radius = 1.25;
    const side = radius * Math.SQRT2;
    const length = 3.5;
    const density = 1200;
    const section = squareSection(radius);
    const mass = density * side * side * length;

    // 多角形の輪郭は120点でも厳密に表せるので、ここは機械精度で一致しなければならない。
    close(loftVolume(section, section, length), side * side * length, 1e-9 * side * side * length, '角柱の体積');

    const inertia = loftInertia(section, section, length, density);
    close(inertia.izz, (mass * side * side) / 6, 1e-9 * mass, '角柱の軸まわり慣性');
    close(inertia.ixx, (mass * (side * side + length * length)) / 12, 1e-9 * mass, '角柱の横まわり慣性 (x)');
    close(inertia.iyy, (mass * (side * side + length * length)) / 12, 1e-9 * mass, '角柱の横まわり慣性 (y)');
  });

  test('hull-loft: 両端が同じ断面のロフトの体積が A·h になる', () => {
    const section = houseSection(1.1, 0.37);
    const area = sectionMoments(section).area;
    const length = 2.75;
    close(loftVolume(section, section, length), area * length, 1e-9 * area * length, '等断面ロフトの体積');
  });

  test('hull-loft: 相似な角錐台の体積が古典的な角錐台の式と一致する', () => {
    const length = 2.4;
    const outlineA = sectionOutline(squareSection(1.6));
    const outlineB = sectionOutline(squareSection(0.6));
    const a1 = outlineArea(outlineA);
    const a2 = outlineArea(outlineB);
    const expected = (length / 3) * (a1 + Math.sqrt(a1 * a2) + a2);
    close(loftVolume(outlineA, outlineB, length), expected, 1e-9 * expected, '角錐台の体積');
  });

  test('hull-loft: 円錐の体積が A·h/3、重心が底から h/4 になる', () => {
    const radius = 2.2;
    const length = 5.0;
    const base = circleOutline(radius);
    const apex = apexOutline();
    const baseArea = outlineArea(base);
    close(loftVolume(base, apex, length), (baseArea * length) / 3, 1e-9 * baseArea * length, '円錐の体積');
    close(loftCentroid(base, apex, length), length / 4, 1e-12 * length, '円錐の重心位置');
  });

  test('hull-loft: 対称なロフトの慣性乗積は0、非対称なロフトでは0にならない', () => {
    const length = 2.0;
    const density = 900;

    const symmetric = loftInertia(squareSection(1.0), squareSection(1.0), length, density);
    close(symmetric.ixy, 0, 1e-9 * symmetric.izz, '正方形断面の ixy');

    // 対称軸が座標軸から傾いた断面。角柱では ixy = −ρ·h·Ixy(断面) になる。
    const tilted = houseSection(1.0, 0.4);
    const moments = sectionMoments(tilted);
    assert.ok(Math.abs(moments.ixy) > 1e-3, `傾けた家型断面の Ixy が0でない: ${moments.ixy}`);
    const asymmetric = loftInertia(tilted, tilted, length, density);
    close(asymmetric.ixy, -density * length * moments.ixy, 1e-9 * Math.abs(asymmetric.izz), '家型断面の ixy');
  });

  test('hull-loft: 断面の重心が軸方向にずれたロフトでは ixz と iyz が0にならない', () => {
    const length = 3.0;
    const density = 1000;
    const base = sectionOutline(squareSection(1.0));
    const offset = base.map((p) => ({ x: p.x + 1.4, y: p.y + 0.9 }));
    const inertia = loftInertia(base, offset, length, density);
    assert.ok(Math.abs(inertia.ixz) > 1e-3, `ixz が0でない: ${inertia.ixz}`);
    assert.ok(Math.abs(inertia.iyz) > 1e-3, `iyz が0でない: ${inertia.iyz}`);
  });

  test('hull-loft: 側面の帯の面積が円柱と角柱の解析値と一致する', () => {
    const radius = 1.3;
    const length = 2.9;
    const circle = circleOutline(radius);
    const lateral = loftLateralArea(circle, circle, length);
    close(lateral, 2 * Math.PI * radius * length, 1e-3 * lateral, '円柱の側面積');

    const square = sectionOutline(squareSection(1.0));
    const perimeter = outlinePerimeter(square);
    close(loftLateralArea(square, square, length), perimeter * length, 1e-9 * perimeter * length, '角柱の側面積');
  });

  test('hull-loft: 投影面積が円柱の軸方向と横方向の解析値と一致する', () => {
    const radius = 1.45;
    const length = 3.6;
    const circle = circleOutline(radius);

    const axial = loftProjectedArea(circle, circle, length, v3(0, 0, 1));
    close(axial, Math.PI * radius * radius, 1e-3 * axial, '円柱を軸方向から見た投影面積');

    const lateral = loftProjectedArea(circle, circle, length, v3(1, 0, 0));
    close(lateral, 2 * radius * length, 1e-3 * lateral, '円柱を横から見た投影面積');
    close(
      loftProjectedArea(circle, circle, length, v3(0, 1, 0)),
      2 * radius * length,
      1e-3 * lateral,
      '円柱を別の横方向から見た投影面積',
    );
  });

  test('hull-loft: 輪郭のサンプリングが角度ではなく弧長で等分される', () => {
    // 正方形は周長が120で割り切れて頂点にも点が乗るため、すべての隣接距離が等しくなる。角度等分では
    // 辺の中央が密になり、比で 1/cos²(45°) = 2 倍のばらつきが出る。
    const square = sectionOutline(squareSection(1.0));
    const step = outlinePerimeter(square) / LOFT_SAMPLE_COUNT;
    for (let i = 0; i < square.length; i++) {
      const a = square[i];
      const b = square[(i + 1) % square.length];
      close(Math.hypot(b.x - a.x, b.y - a.y), step, 1e-9 * step, `正方形断面の隣接点間距離 [${i}]`);
    }

    // 円に側面の口を設けた断面の、口の平面上に乗った点。弧長で等分していれば直線上に等間隔で並ぶ。
    const circle = sectionOutline({
      primitives: [primitive({ id: 'circle', shape: { kind: 'circle', radius: 2, branchCount: 3 } })],
    });
    const flatX = 2 * Math.cos(Math.asin(0.5));
    const onFlat = circle.filter((p) => Math.abs(p.x - flatX) < 1e-9).map((p) => p.y).sort((a, b) => a - b);
    assert.ok(onFlat.length >= 3, `口の平面上に3点以上ある: ${onFlat.length}`);
    const flatStep = onFlat[1] - onFlat[0];
    for (let i = 1; i < onFlat.length; i++) {
      close(onFlat[i] - onFlat[i - 1], flatStep, 1e-9 * Math.abs(flatStep), `口の平面上の間隔 [${i}]`);
    }
    // 口3つが弦で置き換わった円の真の周長。60度の円弧3本と、半径 × PORT_WIDTH_RATIO の弦3本。
    const circlePerimeter = 3 * ((2 * Math.PI) / 3) + 3 * 2;
    close(flatStep, circlePerimeter / LOFT_SAMPLE_COUNT, 1e-5 * flatStep, '口の平面上の間隔が周長の等分値');
  });

  test('hull-loft: 位相のずれた輪郭に対して距離の総和が最小になる対応が選ばれる', () => {
    const square = sectionOutline(squareSection(1.0));
    const shift = 17;
    const rotatedOutline = square.map((_, i) => square[(i + shift) % square.length]);
    const aligned = alignOutlines(square, rotatedOutline);
    for (let i = 0; i < square.length; i++) {
      close(aligned[i].x, square[i].x, 1e-12, `対応づけ後の x [${i}]`);
      close(aligned[i].y, square[i].y, 1e-12, `対応づけ後の y [${i}]`);
    }

    // 位相が90度ずれた正方形断面同士のロフトは、対応が正しければねじれのない角柱になる。
    const turned = squareSection(1.0, Math.PI / 2);
    const length = 2.2;
    const perimeter = outlinePerimeter(square);
    const area = outlineArea(square);
    close(loftVolume(squareSection(1.0), turned, length), area * length, 1e-9 * area * length, 'ねじれない角柱の体積');
    close(
      loftLateralArea(squareSection(1.0), turned, length),
      perimeter * length,
      1e-9 * perimeter * length,
      'ねじれない角柱の側面積',
    );
  });

  test('hull-loft: L字に組んだ2本のロフトの慣性主軸が3値とも異なる', () => {
    const radius = 0.6;
    const side = radius * Math.SQRT2;
    const length = 4.0;
    const density = 1000;
    const section = squareSection(radius);
    const mass = density * side * side * length;
    const local = tensorMatrix(loftInertia(section, section, length, density));

    // 1本目は +z へ伸び、2本目はその先端から +y へ伸びる。
    const armAlongZ = { inertia: local, center: [0, 0, length / 2] };
    const turn: Mat3 = [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ];
    const armAlongY = { inertia: multiply(multiply(turn, local), transpose(turn)), center: [0, length / 2, length] };

    const total = 2 * mass;
    const center = [0, (mass * armAlongY.center[1]) / total, (mass * length) / total + (mass * (length / 2)) / total];
    const combined: Mat3 = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const arm of [armAlongZ, armAlongY]) {
      const d = arm.center.map((c, i) => c - center[i]);
      const moved = shifted(arm.inertia, mass, d);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) combined[i][j] += moved[i][j];
    }

    const principal = principalMoments(combined);
    const scale = principal[2];
    // 3つの主慣性モーメントが互いに異なることが、中間軸まわりの回転が不安定になる(ジャニベコフ効果が
    // 現れる)条件そのものである。
    assert.ok(
      principal[1] - principal[0] > 1e-3 * scale && principal[2] - principal[1] > 1e-3 * scale,
      `主慣性モーメントが3値とも異なる: ${principal.join(', ')}`,
    );
  });
}
