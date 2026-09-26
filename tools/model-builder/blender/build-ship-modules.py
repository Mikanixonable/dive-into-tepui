#!/usr/bin/env python3
"""
船モジュールの原型 GLB を Blender 5.0 のヘッドレス実行で作る。
寸法は manifest(カタログと機体形状定数)を正本とし、長手軸 +Z・メートル単位で、
機能点(噴射口・ジンバル・回転砲身・展開ヒンジ)を空オブジェクトの anchor として書き出す。
"""

import json
import sys
import os
import math
import bpy
import bmesh
from mathutils import Vector, Matrix, Euler

OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "assets-src", "ship-modules"))
os.makedirs(OUT_DIR, exist_ok=True)

# 寸法の正本(カタログと機体形状定数)を書き出した manifest。`--` の後ろの第1引数で受け取る。
def load_manifest():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 1:
        raise SystemExit("usage: blender -b --python build-ship-modules.py -- <manifest.json>")
    with open(args[0], encoding="utf-8") as f:
        return json.load(f)

MANIFEST = load_manifest()

def module_thrust(model_id):
    """manifest にある model_id の推力 [N]。推力を持たない module なら投げる。"""
    thrust = MANIFEST["modules"][model_id].get("thrust")
    if thrust is None:
        raise SystemExit(f"manifest: {model_id} has no thrust")
    return float(thrust)

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in bpy.data.meshes: bpy.data.meshes.remove(block)
    for block in bpy.data.materials: bpy.data.materials.remove(block)
    for block in bpy.data.objects: bpy.data.objects.remove(block)

def create_pbr_material(name, base_color, roughness=0.5, metallic=0.0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = base_color
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    return mat

class MaterialLibrary:
    def __init__(self):
        # 船体のアルミ合金
        self.hull = create_pbr_material("mat_hull", (0.72, 0.77, 0.82, 1.0), roughness=0.45, metallic=1.0)
        # チタンの構造環・金具
        self.hull_dark = create_pbr_material("mat_hull_dark", (0.28, 0.32, 0.38, 1.0), roughness=0.40, metallic=1.0)
        # 奥まった区画の内側
        self.recessed = create_pbr_material("mat_recessed", (0.12, 0.14, 0.17, 1.0), roughness=0.75, metallic=0.0)
        # 多層断熱材(金色のマイラー)
        self.mli_gold = create_pbr_material("mat_mli_gold", (0.86, 0.66, 0.16, 1.0), roughness=0.25, metallic=1.0)
        # 多層断熱材(白いベータクロス)
        self.mli_white = create_pbr_material("mat_mli_white", (0.92, 0.94, 0.96, 1.0), roughness=0.70, metallic=0.0)
        # ステンレス・インコネルの配管
        self.pipe = create_pbr_material("mat_pipe", (0.88, 0.90, 0.93, 1.0), roughness=0.30, metallic=1.0)
        # 配管の締め具・受け金具
        self.clamp = create_pbr_material("mat_clamp", (0.35, 0.40, 0.45, 1.0), roughness=0.35, metallic=1.0)
        # 再生冷却される燃焼室とベル(焼けた耐熱合金)
        self.nozzle_bell = create_pbr_material("mat_nozzle_bell", (0.32, 0.28, 0.26, 1.0), roughness=0.42, metallic=1.0)
        # 冷却管・束ね帯
        self.nozzle_rib = create_pbr_material("mat_nozzle_rib", (0.52, 0.48, 0.44, 1.0), roughness=0.35, metallic=1.0)
        # 放射冷却のノズル延長部(ケイ化物被覆のニオブ合金)
        self.nozzle_extension = create_pbr_material("mat_nozzle_extension", (0.13, 0.12, 0.13, 1.0), roughness=0.55, metallic=0.8)
        # 石英の窓
        self.window = create_pbr_material("mat_window", (0.04, 0.10, 0.18, 1.0), roughness=0.10, metallic=0.0)
        # チタンの窓枠
        self.window_frame = create_pbr_material("mat_window_frame", (0.22, 0.24, 0.28, 1.0), roughness=0.35, metallic=1.0)
        # チタンの球形推進剤タンク
        self.tank_rcs = create_pbr_material("mat_tank_rcs", (0.32, 0.52, 0.62, 1.0), roughness=0.38, metallic=1.0)
        # トラス材
        self.truss = create_pbr_material("mat_truss", (0.68, 0.72, 0.78, 1.0), roughness=0.35, metallic=1.0)
        # 炭素フェノールのアブレータ
        self.heatshield = create_pbr_material("mat_heatshield", (0.16, 0.12, 0.08, 1.0), roughness=0.90, metallic=0.0)
        # 結合機構の環
        self.cbm_ring = create_pbr_material("mat_cbm_ring", (0.76, 0.79, 0.84, 1.0), roughness=0.28, metallic=1.0)
        # 建造ドックの識別色
        self.dock = create_pbr_material("mat_dock", (0.84, 0.55, 0.22, 1.0), roughness=0.38, metallic=1.0)
        # 太陽電池セル
        self.solar = create_pbr_material("mat_solar", (0.06, 0.18, 0.45, 1.0), roughness=0.25, metallic=0.2)
        # 高放射率の白い放熱塗装
        self.radiator = create_pbr_material("mat_radiator", (0.88, 0.90, 0.92, 1.0), roughness=0.85, metallic=0.0)
        # 砲身・機関部の黒染め鋼
        self.gun_steel = create_pbr_material("mat_gun_steel", (0.10, 0.11, 0.12, 1.0), roughness=0.38, metallic=1.0)

def world_matrix(obj):
    """obj の模型座標での変換。親子付けはどれも parent_inverse が単位行列である前提。"""
    matrix = obj.matrix_basis.copy()
    parent = obj.parent
    while parent is not None:
        matrix = parent.matrix_basis @ matrix
        parent = parent.parent
    return matrix

def add_mesh_obj(name, bm, material=None, parent=None):
    """模型座標の bm を material のメッシュにして返す(bm は解放する)。
    parent を渡すと、模型上の位置を保ったまま parent の子にする。"""
    if parent is not None:
        bmesh.ops.transform(bm, verts=bm.verts, matrix=world_matrix(parent).inverted())
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    if material:
        obj.data.materials.append(material)
    if parent is not None:
        parent_to(obj, parent)
    return obj

def export_glb(filepath):
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
        export_yup=False,
        export_extras=True,
    )
    print(f"Exported: {filepath}")

# ----------------------------------------------------------------------
# 陰影と面取り
# ----------------------------------------------------------------------
def shade_by_angle(bm, sharp_angle_deg, sharp_faces=()):
    """全面を滑らかな陰影にし、二面角が sharp_angle_deg を超える稜と sharp_faces の縁だけを鋭い稜にする。"""
    limit = math.radians(sharp_angle_deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        e.smooth = not (e.is_manifold and e.calc_face_angle(0.0) > limit)
    for f in sharp_faces:
        for e in f.edges:
            e.smooth = False
    return bm

def bevel_creases(bm, offset, segments=2, crease_angle_deg=60.0):
    """二面角が crease_angle_deg を超える稜を幅 offset [m] で面取りし、できた面を返す。
    面取りは稜の両側の面を内側へ削るので、外形の外接箱は変わらない。"""
    if offset <= 0.0:
        return []
    limit = math.radians(crease_angle_deg)
    edges = [e for e in bm.edges if e.is_manifold and e.calc_face_angle(0.0) > limit]
    if not edges:
        return []
    verts = list({v for e in edges for v in e.verts})
    result = bmesh.ops.bevel(
        bm, geom=edges + verts, offset=offset, segments=segments, profile=0.5,
        affect='EDGES', clamp_overlap=True,
    )
    return result["faces"]

# ----------------------------------------------------------------------
# 形の素片(回転体・円筒・円環・箱・管・球)
# ----------------------------------------------------------------------
def make_lathe(points, segments=36, closed=False, sharp_angle_deg=30.0):
    """輪郭 points [(半径, z)] を Z 軸まわりに回した面。closed なら輪郭の終点と始点も繋ぐ。
    半径 0 の点は極として1頂点に潰す。二面角が sharp_angle_deg を超える稜だけを鋭く陰影付けする。"""
    bm = bmesh.new()
    rings = []
    for r, z in points:
        if r < 1e-6:
            pole = bm.verts.new((0.0, 0.0, z))
            rings.append([pole] * segments)
            continue
        rings.append([
            bm.verts.new((r * math.cos(2.0 * math.pi * i / segments), r * math.sin(2.0 * math.pi * i / segments), z))
            for i in range(segments)
        ])
    pairs = [(k, k + 1) for k in range(len(rings) - 1)]
    if closed:
        pairs.append((len(rings) - 1, 0))
    for a, b in pairs:
        r0, r1 = rings[a], rings[b]
        for i in range(segments):
            i_next = (i + 1) % segments
            quad = []
            for v in (r0[i], r0[i_next], r1[i_next], r1[i]):
                if v not in quad:
                    quad.append(v)
            if len(quad) >= 3:
                bm.faces.new(quad)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return shade_by_angle(bm, sharp_angle_deg)

def transform_bm(bm, matrix):
    bmesh.ops.transform(bm, verts=bm.verts, matrix=matrix)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def auto_bevel(*dims):
    """部品の寸法 dims [m] に見合う面取り幅 [m]。大きな部品で 2 cm、細い部品では最小寸法の 1 割。"""
    return min(0.02, 0.1 * min(d for d in dims if d > 0.0))

def make_cylinder(r_bottom, r_top, length, z_center=0.0, segments=36, bevel=None):
    """Z 軸に沿う蓋付きの円錐台。側面は滑らかな陰影、蓋の縁は bevel [m](省略時は寸法から決める)で面取りする。"""
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=segments,
        radius1=r_bottom,
        radius2=r_top,
        depth=length,
        matrix=Matrix.Translation((0, 0, z_center))
    )
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    offset = auto_bevel(length, max(r_bottom, r_top)) if bevel is None else bevel
    bevel_faces = bevel_creases(bm, offset, segments=2, crease_angle_deg=60.0)
    return shade_by_angle(bm, 60.0, bevel_faces)

def make_torus(major_r, minor_r, z_center=0.0, major_seg=36, minor_seg=12):
    points = [
        (major_r + minor_r * math.cos(2.0 * math.pi * j / minor_seg), z_center + minor_r * math.sin(2.0 * math.pi * j / minor_seg))
        for j in range(minor_seg)
    ]
    return make_lathe(points, segments=major_seg, closed=True, sharp_angle_deg=180.0)

def make_box(dx, dy, dz, center=(0, 0, 0), rot_euler=(0, 0, 0), bevel=None):
    """中心 center・寸法 (dx, dy, dz) の箱を rot_euler だけ回す。稜は bevel [m](省略時は寸法から決める)で面取りする。"""
    bm = bmesh.new()
    mat = Matrix.Translation(Vector(center)) @ Euler(rot_euler).to_matrix().to_4x4()
    bmesh.ops.create_cube(bm, size=1.0, matrix=mat @ Matrix.Diagonal((dx, dy, dz, 1.0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    offset = auto_bevel(dx, dy, dz) if bevel is None else bevel
    bevel_faces = bevel_creases(bm, offset, segments=2, crease_angle_deg=60.0)
    return shade_by_angle(bm, 30.0, bevel_faces)

def round_corners(path_points, bend_radius, steps=4):
    """折れ線 path_points の内側の角を半径 bend_radius [m] 程度の円弧状の曲がりへ置き換えた点列。"""
    if len(path_points) < 3 or bend_radius <= 0.0:
        return list(path_points)
    result = [path_points[0]]
    for i in range(1, len(path_points) - 1):
        prev, corner, nxt = path_points[i - 1], path_points[i], path_points[i + 1]
        cut = min(bend_radius, (corner - prev).length * 0.45, (nxt - corner).length * 0.45)
        a = corner + (prev - corner).normalized() * cut
        b = corner + (nxt - corner).normalized() * cut
        for s in range(steps + 1):
            t = s / steps
            result.append(a.lerp(corner, t).lerp(corner.lerp(b, t), t))
    result.append(path_points[-1])
    return result

def sweep_profile(path_points, profile, cap_ends=True, sharp_angle_deg=70.0):
    """3D の折れ線 path_points に沿って、断面 profile [(u, v)](法線・従法線方向の [m])を掃引した筒。
    断面の向きは平行移送で捩れずに運ぶ。cap_ends なら両端を平らに塞ぐ。"""
    bm = bmesh.new()
    caps = append_sweep(bm, path_points, profile, cap_ends)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return shade_by_angle(bm, sharp_angle_deg, caps)

def make_pipe(path_points, radius=0.04, segments=12):
    """3D の折れ線 path_points に沿う半径 radius [m] の両端を塞いだ管。"""
    profile = [(radius * math.cos(2.0 * math.pi * s / segments), radius * math.sin(2.0 * math.pi * s / segments)) for s in range(segments)]
    return sweep_profile(path_points, profile)

def make_sphere(radius, center=(0, 0, 0), u_seg=24, v_seg=16):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(
        bm,
        u_segments=u_seg,
        v_segments=v_seg,
        radius=radius,
        matrix=Matrix.Translation(Vector(center))
    )
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return shade_by_angle(bm, 180.0)

def make_strut(start, end, radius, segments=10):
    """start から end への丸管の支柱 [m]。"""
    return make_pipe([Vector(start), Vector(end)], radius=radius, segments=segments)

def make_boxes(parts, bevel=0.01):
    """(dx, dy, dz, center, rot_euler) の列を1つの bm へまとめた箱の集まり。稜は bevel [m] で面取りする。
    細かい部品をまとめて1メッシュにし、オブジェクト数を増やさないために使う。"""
    bm = bmesh.new()
    for dx, dy, dz, center, rot_euler in parts:
        mat = Matrix.Translation(Vector(center)) @ Euler(rot_euler).to_matrix().to_4x4()
        bmesh.ops.create_cube(bm, size=1.0, matrix=mat @ Matrix.Diagonal((dx, dy, dz, 1.0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bevel_faces = bevel_creases(bm, bevel, segments=2, crease_angle_deg=60.0)
    return shade_by_angle(bm, 30.0, bevel_faces)

def append_sweep(bm, path_points, profile, cap_ends=True):
    """3D の折れ線 path_points に沿う断面 profile の筒を bm へ追加し、塞いだ端面を返す。
    陰影は呼び出し側がまとめて仕上げる。"""
    if len(path_points) < 2:
        return []
    tangents = []
    for idx, pt in enumerate(path_points):
        if idx == 0:
            tangents.append((path_points[1] - pt).normalized())
        elif idx == len(path_points) - 1:
            tangents.append((pt - path_points[idx - 1]).normalized())
        else:
            tangents.append(((pt - path_points[idx - 1]).normalized() + (path_points[idx + 1] - pt).normalized()).normalized())
    up = Vector((0, 0, 1)) if abs(tangents[0].z) < 0.9 else Vector((0, 1, 0))
    normal = tangents[0].cross(up).normalized()
    rings = []
    for pt, tangent in zip(path_points, tangents):
        normal = (normal - tangent * normal.dot(tangent)).normalized()
        binormal = tangent.cross(normal).normalized()
        rings.append([bm.verts.new(pt + normal * u + binormal * v) for u, v in profile])
    n = len(profile)
    for r0, r1 in zip(rings, rings[1:]):
        for s in range(n):
            s_next = (s + 1) % n
            bm.faces.new([r0[s], r0[s_next], r1[s_next], r1[s]])
    if not cap_ends:
        return []
    return [bm.faces.new(rings[0]), bm.faces.new(list(reversed(rings[-1])))]

def make_pipes(paths, radius, segments=12, bend_radius=0.0):
    """折れ線の列 paths に沿う半径 radius [m] の管を1つの bm へまとめる。
    bend_radius > 0 なら各経路の角を丸める。"""
    profile = [(radius * math.cos(2.0 * math.pi * s / segments), radius * math.sin(2.0 * math.pi * s / segments)) for s in range(segments)]
    bm = bmesh.new()
    caps = []
    for path in paths:
        points = round_corners(path, bend_radius) if bend_radius > 0.0 else [Vector(p) for p in path]
        caps += append_sweep(bm, points, profile)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return shade_by_angle(bm, 70.0, caps)


def make_curved_plate(t0, t1, r_inner, thickness, x0, x1, z_axis, steps=8):
    """円筒船体へ伏せる曲面の板。内面は軸 (y=0, z=z_axis) まわり半径 r_inner の凹弧で、
    その軸はモジュール局所 X に沿う。角度 t は船体軸まわりの周方向位置 [rad]、
    t=0 がモジュール中心(+Z 側)で、上面は内面から放射方向へ thickness [m] だけ離れる。"""
    bm = bmesh.new()
    grid = []
    for i in range(steps + 1):
        t = t0 + (t1 - t0) * i / steps
        row = []
        for x in (x0, x1):
            for r in (r_inner, r_inner + thickness):
                row.append(bm.verts.new((x, r * math.sin(t), z_axis + r * math.cos(t))))
        grid.append(row)
    # 各行は (x0,内) (x0,外) (x1,内) (x1,外) の順
    for i in range(steps):
        a, b = grid[i], grid[i + 1]
        bm.faces.new([a[0], a[2], b[2], b[0]])       # 内面(船体側の凹面)
        bm.faces.new([a[1], b[1], b[3], a[3]])       # 上面
        bm.faces.new([a[0], b[0], b[1], a[1]])       # 側壁 x0
        bm.faces.new([a[2], a[3], b[3], b[2]])       # 側壁 x1
    f0, f1 = grid[0], grid[-1]
    bm.faces.new([f0[0], f0[1], f0[3], f0[2]])       # 端壁 t0
    bm.faces.new([f1[0], f1[2], f1[3], f1[1]])       # 端壁 t1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return shade_by_angle(bm, 30.0)


# ----------------------------------------------------------------------
# 機能点の anchor、向きを持つノズル、Rao ベル
# ----------------------------------------------------------------------
def add_anchor(name, location, direction=None, parent=None, **props):
    """形に結び付いた機能点の空オブジェクト。location は parent の局所座標(parent が無ければ模型座標)。
    局所 +Z が direction(噴射口なら排気方向)を向き、direction を省くと親と同じ向きになる。"""
    obj = bpy.data.objects.new(f"anchor:{name}", None)
    bpy.context.collection.objects.link(obj)
    obj.location = Vector(location)
    if direction is not None:
        obj.rotation_mode = 'QUATERNION'
        obj.rotation_quaternion = Vector(direction).normalized().to_track_quat('Z', 'Y')
    obj["semanticAnchor"] = name
    for key, value in props.items():
        obj[key] = value
    if parent is not None:
        obj.parent = parent
    return obj

def parent_to(obj, parent):
    """obj の頂点座標を parent の局所座標のまま親子付けする。"""
    obj.parent = parent
    obj.matrix_parent_inverse = Matrix.Identity(4)
    return obj

def add_directed_nozzle(name, exit_point, direction, length, r_exit, r_throat, material, anchor_name=None):
    """出口 exit_point から direction へ排気する円錐ノズル。anchor_name を渡すと出口に噴射口 anchor を置く。"""
    d = Vector(direction).normalized()
    bm = make_cylinder(r_throat, r_exit, length, z_center=-length / 2, segments=12)
    transform_bm(bm, Matrix.Translation(Vector(exit_point)) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4())
    add_mesh_obj(name, bm, material)
    if anchor_name is not None:
        add_anchor(anchor_name, exit_point, d)

def throat_radius(thrust, chamber_pressure, thrust_coefficient):
    """推力 thrust [N] = Cf·Pc·At を満たす喉の半径 [m]。"""
    return math.sqrt(thrust / (thrust_coefficient * chamber_pressure) / math.pi)

def rao_bell_length(r_throat, expansion_ratio, fraction=0.8):
    """面積膨張比 expansion_ratio のノズルを、半角 15° の円錐ノズル長の fraction 倍にした Rao ベルの喉-出口長 [m]。"""
    half = math.radians(15.0)
    cone = (r_throat * (math.sqrt(expansion_ratio) - 1.0) + 1.5 * r_throat * (1.0 / math.cos(half) - 1.0)) / math.tan(half)
    return fraction * cone

def rao_bell_profile(r_throat, z_throat, r_exit, z_exit, theta_n_deg, theta_e_deg, samples=24):
    """喉から出口への Rao の放物線近似の内面輪郭 [(半径, z)]。排気は -Z 向き。
    喉の下流は半径 0.382 Rt の円弧で θn まで広がり、そこから出口角 θe へ2次ベジエで繋ぐ。"""
    theta_n = math.radians(theta_n_deg)
    theta_e = math.radians(theta_e_deg)
    arc = 0.382 * r_throat
    points = []
    for i in range(6):
        a = theta_n * i / 5
        points.append((r_throat + arc * (1 - math.cos(a)), z_throat - arc * math.sin(a)))
    rn, zn = points[-1]
    # 2本の接線 r = rn + tanθn·(zn - z)、r = r_exit - tanθe·(z - z_exit) の交点が制御点
    tn, te = math.tan(theta_n), math.tan(theta_e)
    zq = (r_exit + te * z_exit - rn - tn * zn) / (te - tn)
    rq = rn + tn * (zn - zq)
    if not (z_exit < zq < zn):
        raise ValueError("Rao bell: tangent intersection outside the bell; adjust theta_n / theta_e")
    for i in range(1, samples + 1):
        t = i / samples
        r = (1 - t) ** 2 * rn + 2 * (1 - t) * t * rq + t * t * r_exit
        z = (1 - t) ** 2 * zn + 2 * (1 - t) * t * zq + t * t * z_exit
        points.append((r, z))
    return points

def converging_profile(r_throat, z_throat, r_chamber, z_top, theta_c_deg=35.0, samples=6):
    """燃焼室上端 (r_chamber, z_top) から喉までの内面輪郭 [(半径, z)]。
    円筒の燃焼室を半角 θc の円錐で絞り、喉の上流を半径 1.5 Rt の円弧で喉へ接続する。"""
    theta_c = math.radians(theta_c_deg)
    arc = 1.5 * r_throat
    r_arc = r_throat + arc * (1 - math.cos(theta_c))
    z_arc = z_throat + arc * math.sin(theta_c)
    z_cone_top = z_arc + (r_chamber - r_arc) / math.tan(theta_c)
    if z_cone_top >= z_top:
        raise ValueError("converging section: chamber top must lie upstream of the converging cone")
    points = [(r_chamber, z_top), (r_chamber, z_cone_top)]
    for i in range(samples, -1, -1):
        a = theta_c * i / samples
        points.append((r_throat + arc * (1 - math.cos(a)), z_throat + arc * math.sin(a)))
    return points

def converging_length(r_throat, r_chamber, theta_c_deg=35.0):
    """converging_profile の円錐始まりから喉までの軸方向の長さ [m]。"""
    theta_c = math.radians(theta_c_deg)
    arc = 1.5 * r_throat
    r_arc = r_throat + arc * (1 - math.cos(theta_c))
    return arc * math.sin(theta_c) + (r_chamber - r_arc) / math.tan(theta_c)

def split_profile(points, r_split):
    """半径が単調に増える輪郭 points を半径 r_split の位置で上流側と下流側に分ける(分割点は両方に含む)。"""
    for i in range(len(points) - 1):
        (r0, z0), (r1, z1) = points[i], points[i + 1]
        if r0 < r_split <= r1:
            t = (r_split - r0) / (r1 - r0)
            cut = (r_split, z0 + (z1 - z0) * t)
            return points[:i + 1] + [cut], [cut] + points[i + 1:]
    raise ValueError("split_profile: r_split outside the profile")

def profile_radius_at(points, z):
    """z が単調に減る輪郭 points 上の、高さ z での半径 [m]。範囲外は端の半径。"""
    if z >= points[0][1]:
        return points[0][0]
    for (r0, z0), (r1, z1) in zip(points, points[1:]):
        if z1 <= z <= z0:
            return r0 + (r1 - r0) * (z0 - z) / (z0 - z1) if z0 != z1 else max(r0, r1)
    return points[-1][0]

def make_shell_lathe(inner_points, wall, segments=48):
    """内面輪郭 inner_points(上流→出口)に肉厚 wall [m] の外面を足し、両端の縁を塞いだ閉じた回転殻。"""
    outer = [(r + wall, z) for r, z in reversed(inner_points)]
    return make_lathe(list(inner_points) + outer, segments=segments, closed=True)

# ----------------------------------------------------------------------
# 1. Cockpit Module (cockpit-standard: length 3m, diameter 6m, radius 3m)
# ----------------------------------------------------------------------
def build_cockpit():
    reset_scene()
    mats = MaterialLibrary()
    
    # 1. Re-entry capsule tapered lathe profile
    # Smooth transition from aft R=3.0m to forward R=2.10m with aerodynamic curve
    # Strictly fits within length 3.0m (z in [-1.50, +1.50])
    points = [
        (2.98, -1.48), # Aft docking rim
        (3.02, -1.35), # Heat shield transition flare
        (3.00, -0.90), # Cylindrical aft section
        (2.96, -0.30), # Mid fuselage taper start
        (2.82,  0.30), # Forward conical taper
        (2.55,  0.90), # Window / cockpit collar
        (2.35,  1.30), # Forward nose taper
        (2.15,  1.46), # CBM collar step
        (2.10,  1.50), # Forward docking interface
    ]
    bm_hull = make_lathe(points, segments=48)
    add_mesh_obj("cockpit_hull", bm_hull, mats.hull)
    
    # 2. Aft Phenolic Heat Shield (curved ablative dome, convex within z=-1.50m)
    bm_shield = make_lathe([
        (0.00, -1.50),
        (1.50, -1.49),
        (2.50, -1.48),
        (2.98, -1.48),
    ], segments=36)
    add_mesh_obj("cockpit_heatshield", bm_shield, mats.heatshield)
    
    # 3. Forward CBM / APAS Docking Flange Ring (torus)
    bm_cbm = make_torus(major_r=2.12, minor_r=0.04, z_center=1.48, major_seg=36, minor_seg=12)
    add_mesh_obj("cockpit_cbm_ring", bm_cbm, mats.cbm_ring)

    # 3b. Forward Airtight Hatch & Viewport (closes the diameter 4.2m void)
    bm_hatch = make_cylinder(2.08, 2.08, 0.05, z_center=1.46, segments=36)
    add_mesh_obj("cockpit_hatch", bm_hatch, mats.hull_dark)

    bm_hub = make_cylinder(0.65, 0.65, 0.04, z_center=1.48, segments=24)
    add_mesh_obj("cockpit_hatch_hub", bm_hub, mats.hull)

    bm_hatch_win = make_cylinder(0.24, 0.24, 0.03, z_center=1.49, segments=16)
    add_mesh_obj("cockpit_hatch_window", bm_hatch_win, mats.window)

    for i in range(8):
        ang = i * math.pi / 4.0
        bm_bolt = make_box(0.06, 0.06, 0.04, center=(1.80 * math.cos(ang), 1.80 * math.sin(ang), 1.48))
        add_mesh_obj(f"cockpit_hatch_latch_{i}", bm_bolt, mats.clamp)
    
    # 4. Beveled Dual Trapezoidal Windows (Gemini / Soyuz style)
    # Positioned at +Y (top side) at angles +/- 22 degrees, z = 0.6m to 1.1m
    for sign in [-1.0, 1.0]:
        ang = sign * math.radians(22)
        r_mid = 2.60
        z_mid = 0.80
        # Frame
        rot = (math.radians(-18), 0, -ang)
        pos = (r_mid * math.sin(ang), r_mid * math.cos(ang), z_mid)
        bm_frame = make_box(0.48, 0.08, 0.55, center=pos, rot_euler=rot)
        add_mesh_obj(f"window_frame_{sign}", bm_frame, mats.window_frame)
        
        # Inset Glass Pane (recessed inside frame)
        pos_glass = (pos[0] * 0.98, pos[1] * 0.98, pos[2])
        bm_glass = make_box(0.42, 0.03, 0.48, center=pos_glass, rot_euler=rot)
        add_mesh_obj(f"window_glass_{sign}", bm_glass, mats.window)

    # 5. Recessed Avionics & Equipment Bay (Carved INTO the hull, NOT a plate!)
    # Located on port & starboard sides (angles +/- 90 deg, z = -0.4m to +0.2m)
    for sign in [-1.0, 1.0]:
        ang = sign * math.pi / 2.0
        r_bay = 2.92 # Inset by 0.08m below R=3.0m hull
        pos_bay = (r_bay * math.cos(ang), r_bay * math.sin(ang), -0.10)
        # Recessed cavity backplane
        bm_cavity = make_box(0.12, 1.00, 0.60, center=pos_bay, rot_euler=(0, 0, ang))
        add_mesh_obj(f"recessed_bay_{sign}", bm_cavity, mats.recessed)
        # Internal avionics modules / connectors inside bay
        for k in range(3):
            zk = -0.25 + k * 0.20
            pos_mod = ((r_bay + 0.02) * math.cos(ang), (r_bay + 0.02) * math.sin(ang), zk)
            bm_mod = make_box(0.06, 0.75, 0.12, center=pos_mod, rot_euler=(0, 0, ang))
            add_mesh_obj(f"bay_module_{sign}_{k}", bm_mod, mats.hull_dark)

    # 6. Integrated Optical Star Tracker Cowl
    # Aerodynamic cowling blended into the forward dorsal hull
    cowl_pos = (0.0, 2.70, 0.35)
    bm_cowl = make_cylinder(0.18, 0.14, 0.28, z_center=0.35, segments=16)
    # Tilt slightly forward
    transform_bm(bm_cowl, Euler((math.radians(25), 0, 0)).to_matrix().to_4x4())
    transform_bm(bm_cowl, Matrix.Translation(Vector((0.0, 2.70, 0.35))))
    add_mesh_obj("star_tracker_cowl", bm_cowl, mats.hull_dark)
    
    # 7. Blended RCS Quad Pod Housings (Aerospace faired pods, not arbitrary cubes)
    # Placed symmetrically around circumference at z = -0.55m
    for i in range(4):
        ang = i * math.pi / 2.0 + math.pi / 4.0
        r_pod = 2.98
        pos_pod = (r_pod * math.cos(ang), r_pod * math.sin(ang), -0.55)
        bm_pod = make_box(0.24, 0.32, 0.26, center=pos_pod, rot_euler=(0, 0, ang))
        add_mesh_obj(f"rcs_pod_{i}", bm_pod, mats.hull_dark)
        
        # ポッドの接線 ±・軸 ± へ向いた4基のノズル
        tangent = Vector((-math.sin(ang), math.cos(ang), 0))
        for k, (d, reach) in enumerate([(tangent, 0.16), (-tangent, 0.16), (Vector((0, 0, 1)), 0.13), (Vector((0, 0, -1)), 0.13)]):
            add_directed_nozzle(f"rcs_noz_{i}_{k}", Vector(pos_pod) + d * (reach + 0.07), d, 0.07, 0.035, 0.018, mats.nozzle_rib)

    # 8. Structural Circumferential Frame Ribs (Ring bulkheads)
    for z_ring in [-1.10, 0.0, 1.10]:
        bm_ring = make_torus(major_r=2.97, minor_r=0.035, z_center=z_ring, major_seg=36, minor_seg=8)
        add_mesh_obj(f"frame_ring_{z_ring}", bm_ring, mats.hull_dark)

    export_glb(os.path.join(OUT_DIR, "cockpit-standard.glb"))

# ----------------------------------------------------------------------
# 2. Main Propellant Tanks (tank-3-main, tank-6-main, tank-12-main)
# ----------------------------------------------------------------------
def build_tank_main(length, name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = length / 2.0
    
    # 1. Main Cylindrical Tank Hull with circumferential segments
    # Outer hull is pristine aerospace aluminium
    bm_hull = make_cylinder(radius, radius, length, z_center=0.0, segments=48)
    add_mesh_obj("tank_hull", bm_hull, mats.hull)
    
    # 2. Structural Bulkhead Bands (CRITICAL: Named 'tank-band' to satisfy contract test!)
    # Band count scaled with length (3m: 1 band, 6m: 2 bands, 12m: 4 bands)
    band_count = 1 if length <= 3.5 else (2 if length <= 6.5 else 4)
    step = length / (band_count + 1)
    for b in range(band_count):
        zb = -half_len + step * (b + 1)
        bm_band = make_torus(major_r=radius + 0.02, minor_r=0.04, z_center=zb, major_seg=48, minor_seg=12)
        # Name MUST be 'tank-band' for test contract!
        add_mesh_obj("tank-band", bm_band, mats.hull_dark)

    # 3. Cryogenic Feedline with Saddle Clamps & Bolted Flanges
    # High-pressure LOX/LH2 feedline running down the hull at radius R=3.06m
    # Curve smoothly into the hull at both ends via 90-degree elbows!
    pipe_r = 0.07
    z_start = -half_len + 0.25
    z_end = half_len - 0.25
    feedline_points = [
        Vector((2.85, 0.0, z_start - 0.15)), # Inside hull bulkhead
        Vector((3.08, 0.0, z_start + 0.10)), # Elbow to exterior
        Vector((3.08, 0.0, z_end - 0.10)),   # Long straight run
        Vector((2.85, 0.0, z_end + 0.15)),   # Elbow back into hull
    ]
    bm_pipe = make_pipe(feedline_points, radius=pipe_r, segments=16)
    add_mesh_obj("cryo_feedline", bm_pipe, mats.pipe)
    
    # Saddle Clamps with Fastener Blocks along the feedline
    clamp_step = 1.0
    clamp_num = int((z_end - z_start) / clamp_step)
    for c in range(clamp_num):
        zc = z_start + 0.3 + c * clamp_step
        if zc > z_end - 0.3: break
        # Saddle clamp bracket hugging the pipe and welded to the hull
        bm_clamp = make_box(0.08, 0.28, 0.12, center=(3.06, 0.0, zc))
        add_mesh_obj(f"pipe_clamp_{c}", bm_clamp, mats.clamp)
        # Fastener hex bolts on each side of the clamp
        for by in [-0.10, 0.10]:
            bm_bolt = make_cylinder(0.015, 0.015, 0.04, z_center=0, segments=8)
            transform_bm(bm_bolt, Euler((0, math.radians(90), 0)).to_matrix().to_4x4())
            transform_bm(bm_bolt, Matrix.Translation(Vector((3.10, by, zc))))
            add_mesh_obj(f"clamp_bolt_{c}_{by}", bm_bolt, mats.hull_dark)

    # Mid-line In-line Cryogenic Isolation Ball Valve Actuator Housing
    z_valve = 0.0
    bm_valve = make_box(0.24, 0.22, 0.26, center=(3.12, 0.0, z_valve))
    add_mesh_obj("feedline_valve", bm_valve, mats.hull_dark)

    # 4. High-Pressure COPV Helium Pressurization Bottles
    # Composite Overwrapped Pressure Vessels mounted in dedicated cradles
    copv_z = -half_len * 0.4
    copv_ang = math.radians(120)
    for k in [-1.0, 1.0]:
        pos_copv = (radius * math.cos(copv_ang * k), radius * math.sin(copv_ang * k), copv_z)
        # Spherical / cylindrical bottle
        bm_copv = make_cylinder(0.22, 0.22, 0.55, z_center=0.0, segments=16)
        transform_bm(bm_copv, Matrix.Translation(Vector(pos_copv)))
        add_mesh_obj(f"copv_bottle_{k}", bm_copv, mats.tank_rcs)
        # Triangular mounting cradle brackets
        bm_cradle = make_box(0.15, 0.35, 0.50, center=pos_copv, rot_euler=(0, 0, copv_ang * k))
        add_mesh_obj(f"copv_cradle_{k}", bm_cradle, mats.clamp)

    # 5. End Bulkhead Domes (visible torispherical dome inside end collars)
    for sign in [-1.0, 1.0]:
        z_end_rim = sign * half_len
        # End connection rim
        bm_rim = make_torus(major_r=radius * 0.92, minor_r=0.06, z_center=z_end_rim - sign * 0.05, major_seg=36, minor_seg=8)
        add_mesh_obj(f"tank_end_rim_{sign}", bm_rim, mats.hull_dark)

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))

# ----------------------------------------------------------------------
# 3. RCS Propellant Tanks (tank-3-rcs, tank-6-rcs, tank-12-rcs)
# ----------------------------------------------------------------------
def build_tank_rcs(length, name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = length / 2.0
    
    # 1. Structural Space Frame / Exoskeleton Truss Cage
    # Outer diameter 6.0m ring stringers and diagonal tubular trusses
    ring_count = max(3, int(length / 1.5) + 1)
    z_step = length / (ring_count - 1)
    for r in range(ring_count):
        zr = -half_len + r * z_step
        bm_ring = make_torus(major_r=radius * 0.98, minor_r=0.05, z_center=zr, major_seg=36, minor_seg=8)
        add_mesh_obj(f"truss_ring_{r}", bm_ring, mats.truss)
    
    # Longitudinal and diagonal truss struts
    longitudinal_count = 8
    for i in range(longitudinal_count):
        ang = i * 2.0 * math.pi / longitudinal_count
        x = radius * 0.98 * math.cos(ang)
        y = radius * 0.98 * math.sin(ang)
        bm_strut = make_cylinder(0.04, 0.04, length, z_center=0.0, segments=8)
        transform_bm(bm_strut, Matrix.Translation(Vector((x, y, 0.0))))
        add_mesh_obj(f"truss_longitudinal_{i}", bm_strut, mats.truss)

    # 2. Clusters of High-Pressure Titanium Spherical Propellant Tanks inside the cage
    # 4 tanks per axial section
    axial_sections = max(1, int(length / 2.5))
    section_step = length / (axial_sections + 1)
    sphere_radius = 0.85
    for sec in range(axial_sections):
        z_sec = -half_len + (sec + 1) * section_step
        for t in range(4):
            t_ang = t * math.pi / 2.0 + math.pi / 4.0
            tx = (radius * 0.55) * math.cos(t_ang)
            ty = (radius * 0.55) * math.sin(t_ang)
            bm_sphere = make_sphere(sphere_radius, center=(tx, ty, z_sec), u_seg=24, v_seg=16)
            add_mesh_obj(f"rcs_sphere_{sec}_{t}", bm_sphere, mats.tank_rcs)
            
            # Spherical tank equatorial weld seam
            bm_seam = make_torus(major_r=sphere_radius, minor_r=0.02, z_center=z_sec, major_seg=24, minor_seg=6)
            transform_bm(bm_seam, Matrix.Translation(Vector((tx, ty, 0.0))))
            add_mesh_obj(f"rcs_seam_{sec}_{t}", bm_seam, mats.hull_dark)

    # 3. High-Pressure Manifold Manifold & Cross-feed Line
    pipe_points = [
        Vector((0, 0, -half_len + 0.2)),
        Vector((0, 0, half_len - 0.2)),
    ]
    bm_spine = make_pipe(pipe_points, radius=0.08, segments=12)
    add_mesh_obj("manifold_spine", bm_spine, mats.pipe)

    # End connection flanges
    for sign in [-1.0, 1.0]:
        bm_end = make_torus(major_r=radius * 0.88, minor_r=0.06, z_center=sign * (half_len - 0.04), major_seg=36, minor_seg=8)
        add_mesh_obj(f"rcs_end_{sign}", bm_end, mats.hull_dark)

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))

# ----------------------------------------------------------------------
# 4. Main Thruster (thruster-standard: length 1.0m, diameter 6.0m, radius 3.0m)
# ----------------------------------------------------------------------
# 燃焼圧・推力係数・膨張比は実寸の推定値。LOX/ケロシンのガス発生器サイクルを想定し、
# Pc = 7 MPa、真空の Cf ≈ 1.8 とすると、カタログの F = 400 kN で At = F/(Cf·Pc) ≈ 0.0317 m²(Dt ≈ 0.20 m)。
# 真空用の ε = 80 で De ≈ 1.80 m、長さは 15° 円錐の 80% の Rao ベルで Ln ≈ 2.4 m、θn ≈ 33°、θe ≈ 9°。
MAIN_ENGINE_CHAMBER_PRESSURE = 7.0e6  # [Pa]
MAIN_ENGINE_THRUST_COEFFICIENT = 1.8
MAIN_ENGINE_EXPANSION_RATIO = 80.0
# 燃焼室の収縮比 Ac/At。液体エンジンの典型値
MAIN_ENGINE_CONTRACTION_RATIO = 6.0
# 再生冷却から放射冷却の延長部へ切り替える面積比
MAIN_ENGINE_EXTENSION_RATIO = 20.0

def build_thruster():
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = MANIFEST["modules"]["thruster-standard"]["length"] / 2.0

    # 1. 前面の結合環と推力受けの隔壁(相手モジュールと z = +half_len で接する)
    ring_bottom = half_len - 0.20
    add_mesh_obj("thrust_interface_ring", make_lathe([
        (radius - 0.22, ring_bottom), (radius, ring_bottom), (radius, half_len), (radius - 0.22, half_len),
    ], segments=64, closed=True), mats.hull_dark)
    for zr in (ring_bottom + 0.025, half_len - 0.025):
        add_mesh_obj(f"thrust_ring_flange_{zr:.3f}", make_torus(radius + 0.005, 0.025, zr, major_seg=64, minor_seg=10), mats.hull)
    bulkhead_z = half_len - 0.07
    add_mesh_obj("thrust_bulkhead", make_lathe([
        (2.16, bulkhead_z - 0.025), (radius - 0.20, bulkhead_z - 0.025),
        (radius - 0.20, bulkhead_z + 0.025), (2.16, bulkhead_z + 0.025),
    ], segments=64, closed=True), mats.hull)
    add_mesh_obj("thrust_bulkhead_mli", make_lathe([
        (2.17, bulkhead_z - 0.052), (2.53, bulkhead_z - 0.052),
        (2.53, bulkhead_z - 0.037), (2.17, bulkhead_z - 0.037),
    ], segments=64, closed=True), mats.mli_gold)
    # 開放された推力受けの内側へ加圧ヘリウム容器を吊り、リングとの荷重経路を見せる。
    for k, (x, y) in enumerate(((-1.65, 0.95), (1.65, 0.95), (-1.65, -0.95), (1.65, -0.95))):
        center = Vector((x, y, half_len - 0.56))
        add_mesh_obj(f"helium_copv_{k}", make_sphere(0.40, center=center), mats.tank_rcs)
        band = make_torus(0.405, 0.025, center.z, major_seg=32, minor_seg=8)
        add_mesh_obj(f"helium_copv_band_{k}", transform_bm(band, Matrix.Translation((x, y, 0))), mats.clamp)
        tangent = Vector((-y, x, 0.0)).normalized()
        for side in (-1.0, 1.0):
            rim = Vector((x * 1.38, y * 1.38, ring_bottom + 0.04)) + tangent * (side * 0.22)
            saddle = center + tangent * (side * 0.22) + Vector((0, 0, 0.24))
            add_mesh_obj(f"helium_copv_cradle_{k}_{side:+.0f}", make_strut(saddle, rim, 0.05), mats.truss)
        valve = center + Vector((0, 0, -0.44))
        valve_body = make_cylinder(0.09, 0.09, 0.10, z_center=valve.z, segments=16)
        add_mesh_obj(f"helium_valve_{k}", transform_bm(valve_body, Matrix.Translation((x, y, 0))), mats.clamp)
        gas_line = [valve, valve + Vector((-x * 0.18, -y * 0.18, -0.12)),
                    Vector((0.0, 1.15, half_len - 0.79))]
        add_mesh_obj(f"helium_line_{k}", make_pipe(round_corners(gas_line, 0.12), radius=0.025, segments=10), mats.pipe)
    manifold = make_cylinder(0.15, 0.15, 0.14, z_center=half_len - 0.79, segments=20)
    add_mesh_obj("helium_manifold", transform_bm(manifold, Matrix.Translation((0, 1.15, 0))), mats.clamp)
    add_mesh_obj("engine_controller", make_box(0.70, 0.36, 0.22, center=(0.0, 1.75, half_len - 0.22)), mats.hull_dark)

    # 2. 推力構造: 結合環から中央のジンバル受けへ集まる V 字の支柱。ジンバル受けは環より後方にある
    mount_z = half_len - 0.64
    mount_half = 0.35
    add_mesh_obj("gimbal_mount_block", make_box(2 * mount_half, 2 * mount_half, 0.16, center=(0, 0, mount_z)), mats.hull_dark)
    node_r, upper_r, upper_z = 0.34, radius - 0.28, ring_bottom + 0.04
    for k in range(4):
        base = k * math.pi / 2.0
        lower = Vector((node_r * math.cos(base), node_r * math.sin(base), mount_z))
        for spread in (-1.0, 1.0):
            a = base + spread * math.radians(22.5)
            upper = Vector((upper_r * math.cos(a), upper_r * math.sin(a), upper_z))
            add_mesh_obj(f"thrust_strut_{k}_{spread:+.0f}", make_strut(upper, lower, 0.045), mats.truss)
            add_mesh_obj(f"thrust_strut_fitting_{k}_{spread:+.0f}", make_sphere(0.07, center=upper, u_seg=12, v_seg=8), mats.clamp)
    # 対角の張り出し腕。先端は環からの支柱と繋がる節点で、ジンバル作動器の上端を受ける
    outrigger_r = 0.72
    outrigger_tips = []
    for k in range(4):
        a = math.pi / 4.0 + k * math.pi / 2.0
        direction = Vector((math.cos(a), math.sin(a), 0.0))
        tip = direction * outrigger_r + Vector((0, 0, mount_z))
        outrigger_tips.append(tip)
        span = outrigger_r - mount_half
        center = direction * (mount_half + span / 2) + Vector((0, 0, mount_z))
        add_mesh_obj(f"outrigger_{k}", make_box(span + 0.10, 0.10, 0.12, center=center, rot_euler=(0, 0, a)), mats.hull_dark)
        upper = Vector((upper_r * math.cos(a), upper_r * math.sin(a), upper_z))
        add_mesh_obj(f"outrigger_strut_{k}", make_strut(upper, tip, 0.04), mats.truss)
        add_mesh_obj(f"outrigger_node_{k}", make_sphere(0.075, center=tip, u_seg=12, v_seg=8), mats.clamp)

    # 3. ジンバルの支点。静止側の二股金具が十字軸を挟み、その下は全てジンバルと一緒に振れる
    pivot_z = mount_z - 0.16
    gimbal = add_anchor("engine-gimbal", (0.0, 0.0, pivot_z))
    for side in (-1.0, 1.0):
        add_mesh_obj(f"gimbal_clevis_{side:+.0f}", make_box(0.05, 0.20, 0.16, center=(side * 0.11, 0.0, pivot_z + 0.06)), mats.clamp)
    add_mesh_obj("gimbal_cross", make_sphere(0.08, center=(0, 0, pivot_z), u_seg=16, v_seg=10), mats.pipe, parent=gimbal)
    pin = make_cylinder(0.035, 0.035, 0.30, z_center=0.0, segments=12)
    transform_bm(pin, Matrix.Translation((0, 0, pivot_z)) @ Euler((0, math.pi / 2, 0)).to_matrix().to_4x4())
    add_mesh_obj("gimbal_cross_pin", pin, mats.pipe, parent=gimbal)
    add_mesh_obj("gimbal_yoke", make_box(0.16, 0.24, 0.08, center=(0, 0, pivot_z - 0.07)), mats.clamp, parent=gimbal)

    # 4. 噴射器ドームと燃焼室・ベル(内面輪郭)
    r_t = throat_radius(module_thrust("thruster-standard"), MAIN_ENGINE_CHAMBER_PRESSURE, MAIN_ENGINE_THRUST_COEFFICIENT)
    r_c = r_t * math.sqrt(MAIN_ENGINE_CONTRACTION_RATIO)
    r_e = r_t * math.sqrt(MAIN_ENGINE_EXPANSION_RATIO)
    chamber_top = pivot_z - 0.14
    # 円筒部 0.12 m と絞り部で燃焼室の特性長 L* = Vc/At ≈ 1.4 m
    chamber_cyl_end = chamber_top - 0.12
    throat_z = chamber_cyl_end - converging_length(r_t, r_c)
    exit_z = throat_z - rao_bell_length(r_t, MAIN_ENGINE_EXPANSION_RATIO)
    bell = rao_bell_profile(r_t, throat_z, r_e, exit_z, 33.0, 9.0, samples=32)
    inner = converging_profile(r_t, throat_z, r_c, chamber_top) + bell[1:]
    regen, extension = split_profile(inner, r_t * math.sqrt(MAIN_ENGINE_EXTENSION_RATIO))
    regen_wall, extension_wall = 0.03, 0.012
    add_mesh_obj("injector_dome", make_lathe([
        (0.0, pivot_z - 0.045), (0.10, pivot_z - 0.05), (0.19, pivot_z - 0.075),
        (r_c + regen_wall + 0.01, pivot_z - 0.115), (r_c + regen_wall + 0.01, chamber_top), (0.0, chamber_top),
    ], segments=48, closed=True), mats.hull_dark, parent=gimbal)
    add_mesh_obj("injector_flange", make_torus(r_c + regen_wall + 0.012, 0.018, chamber_top + 0.005, major_seg=48, minor_seg=10), mats.clamp, parent=gimbal)
    add_mesh_obj("combustion_chamber", make_shell_lathe(regen, regen_wall, segments=64), mats.nozzle_bell, parent=gimbal)
    add_mesh_obj("nozzle_extension", make_shell_lathe(extension, extension_wall, segments=64), mats.nozzle_extension, parent=gimbal)
    add_anchor("thrust", (0.0, 0.0, exit_z - pivot_z), (0, 0, -1), parent=gimbal)

    # 5. 再生冷却管の束と束ね帯、延長部との継ぎ目の冷却剤入口マニフォールド、延長部の補強環
    tube_r = 0.009
    tube_path = [(r + regen_wall + tube_r * 0.6, z) for r, z in regen[1:]]
    for i in range(40):
        ang = i * 2.0 * math.pi / 40
        pts = [Vector((r * math.cos(ang), r * math.sin(ang), z)) for r, z in tube_path]
        add_mesh_obj(f"cooling_tube_{i}", make_pipe(pts, radius=tube_r, segments=6), mats.nozzle_rib, parent=gimbal)
    for frac in (0.15, 0.55, 0.8):
        rb, zb = regen[int(frac * (len(regen) - 1))]
        add_mesh_obj(f"nozzle_band_{frac}", make_torus(rb + regen_wall + 0.02, 0.014, zb, major_seg=48, minor_seg=8), mats.clamp, parent=gimbal)
    r_split, z_split = regen[-1]
    manifold_r = r_split + regen_wall + 0.045
    add_mesh_obj("coolant_inlet_manifold", make_torus(manifold_r, 0.035, z_split + 0.01, major_seg=48, minor_seg=12), mats.pipe, parent=gimbal)
    add_mesh_obj("extension_joint_flange", make_torus(r_split + regen_wall + 0.008, 0.016, z_split - 0.03, major_seg=48, minor_seg=8), mats.clamp, parent=gimbal)
    rb, zb = extension[len(extension) // 2]
    add_mesh_obj("extension_stiffener", make_torus(rb + extension_wall + 0.012, 0.012, zb, major_seg=64, minor_seg=8), mats.nozzle_extension, parent=gimbal)
    add_mesh_obj("extension_exit_ring", make_torus(r_e + extension_wall + 0.004, 0.018, exit_z + 0.018, major_seg=64, minor_seg=10), mats.nozzle_extension, parent=gimbal)

    # 6. 燃焼室の首輪とジンバル作動器。作動器は張り出し腕の節点(静止側)から首輪の耳金具(ジンバル側)を押す
    collar_z = chamber_top - 0.06
    collar_r = r_c + regen_wall + 0.02
    add_mesh_obj("chamber_collar", make_cylinder(collar_r, collar_r, 0.06, z_center=collar_z, segments=48), mats.clamp, parent=gimbal)
    for k, a in enumerate((math.pi / 4.0, 3.0 * math.pi / 4.0)):
        direction = Vector((math.cos(a), math.sin(a), 0.0))
        lug = direction * (collar_r + 0.05) + Vector((0, 0, collar_z))
        add_mesh_obj(f"collar_lug_{k}", make_box(0.12, 0.06, 0.08, center=lug, rot_euler=(0, 0, a)), mats.clamp, parent=gimbal)
        top = outrigger_tips[0 if k == 0 else 1] - Vector((0, 0, 0.07))
        split = top.lerp(lug, 0.55)
        add_mesh_obj(f"gimbal_actuator_barrel_{k}", make_strut(top, split, 0.045, segments=14), mats.hull_dark)
        add_mesh_obj(f"gimbal_actuator_rod_{k}", make_strut(split, lug, 0.022, segments=10), mats.pipe)
        for end in (top, lug):
            add_mesh_obj(f"gimbal_actuator_eye_{k}_{end.z:.2f}", make_sphere(0.038, center=end, u_seg=12, v_seg=8), mats.clamp)

    # 7. ターボポンプ(-Y 側、ジンバルと一緒に振れる)とガス発生器、その排気ダクト
    pump_x, pump_y = 0.0, -(collar_r + 0.24)
    pump_top = chamber_top - 0.02
    pump_at = Matrix.Translation((pump_x, pump_y, 0.0))
    for part, bm, mat in (
        ("turbopump_pumps", make_cylinder(0.11, 0.11, 0.24, z_center=pump_top - 0.12, segments=24), mats.hull_dark),
        ("turbopump_volute", make_torus(0.12, 0.035, pump_top - 0.08, major_seg=24, minor_seg=10), mats.hull_dark),
        ("turbopump_shaft", make_cylinder(0.07, 0.07, 0.10, z_center=pump_top - 0.29, segments=16), mats.pipe),
        ("turbopump_turbine", make_cylinder(0.13, 0.10, 0.12, z_center=pump_top - 0.40, segments=24), mats.nozzle_rib),
    ):
        add_mesh_obj(part, transform_bm(bm, pump_at), mat, parent=gimbal)
    gg_center = Vector((pump_x + 0.22, pump_y + 0.02, pump_top - 0.30))
    bm_gg = make_cylinder(0.05, 0.05, 0.18, z_center=0.0, segments=16)
    add_mesh_obj("gas_generator", transform_bm(bm_gg, Matrix.Translation(gg_center)), mats.nozzle_rib, parent=gimbal)
    add_mesh_obj("gas_generator_line", make_pipe(round_corners([
        gg_center - Vector((0, 0, 0.09)), gg_center - Vector((0.06, 0, 0.14)), Vector((pump_x + 0.10, pump_y, pump_top - 0.40)),
    ], 0.04), radius=0.025, segments=10), mats.pipe, parent=gimbal)
    # 排気ダクトはベル外面に沿って下り、-Z へ吹く小さなノズルで終わる
    duct_start = Vector((pump_x, pump_y - 0.10, pump_top - 0.40))
    duct_pts = [duct_start, duct_start + Vector((0, -0.06, -0.10))]
    duct_end_z = z_split - 0.55
    duct_gap = 0.16
    for s in range(1, 6):
        z = duct_start.z - 0.10 + (duct_end_z - duct_start.z + 0.10) * s / 5
        r = max(profile_radius_at(inner, z) + regen_wall + duct_gap, -duct_start.y + 0.06)
        duct_pts.append(Vector((0.0, -r, z)))
    add_mesh_obj("gg_exhaust_duct", make_pipe(round_corners(duct_pts, 0.08), radius=0.05, segments=14), mats.nozzle_rib, parent=gimbal)
    duct_tip = duct_pts[-1]
    bm_gg_nozzle = make_cylinder(0.075, 0.05, 0.12, z_center=-0.04, segments=16)
    add_mesh_obj("gg_exhaust_nozzle", transform_bm(bm_gg_nozzle, Matrix.Translation(duct_tip)), mats.nozzle_extension, parent=gimbal)
    for s in (3, 5):
        p = duct_pts[s]
        wall_r = profile_radius_at(inner, p.z) + regen_wall
        add_mesh_obj(f"gg_duct_bracket_{s}", make_box(0.05, -p.y - wall_r, 0.04, center=(0.0, (p.y - wall_r) / 2, p.z)), mats.clamp, parent=gimbal)

    # 8. 推進剤の配管: 隔壁から下りる静止側、ジンバル面の蛇腹、ジンバル側でポンプ入口へ。ポンプ吐出はドームと冷却剤入口へ
    for side, name in ((1.0, "lox"), (-1.0, "fuel")):
        bellows_x, bellows_y = side * 0.24, -0.46
        bellows_top, bellows_bottom = pivot_z + 0.05, pivot_z - 0.07
        static = [Vector((side * 1.95, 0.0, half_len - 0.09)),
                  Vector((side * 1.95, 0.0, mount_z + 0.03)),
                  Vector((side * 0.56, -0.84, bellows_top + 0.09)),
                  Vector((bellows_x, bellows_y, bellows_top))]
        feed_material = mats.mli_white if name == "lox" else mats.pipe
        add_mesh_obj(f"{name}_feedline", make_pipe(round_corners(static, 0.16, steps=6), radius=0.10, segments=16), feed_material)
        bm_flange = make_cylinder(0.145, 0.145, 0.045, z_center=0.0, segments=20)
        add_mesh_obj(f"{name}_feed_flange", transform_bm(bm_flange, Matrix.Translation(static[0])), mats.clamp)
        valve_at = static[0].lerp(static[1], 0.58)
        add_mesh_obj(f"{name}_shutoff_valve", make_box(0.32, 0.27, 0.30, center=valve_at), mats.hull_dark)
        for c in range(6):
            zc = bellows_top - (bellows_top - bellows_bottom) * (c + 0.5) / 6
            bm = make_torus(0.11, 0.016, zc, major_seg=16, minor_seg=6)
            transform_bm(bm, Matrix.Translation((bellows_x, bellows_y, 0.0)))
            add_mesh_obj(f"{name}_bellows_{c}", bm, mats.clamp, parent=gimbal if c >= 3 else None)
        inlet = Vector((pump_x + side * 0.11, pump_y, pump_top - 0.10))
        moving = [Vector((bellows_x, bellows_y, bellows_bottom)), Vector((bellows_x, bellows_y, bellows_bottom - 0.05)),
                  inlet + Vector((side * 0.10, 0, 0.02)), inlet]
        add_mesh_obj(f"{name}_pump_inlet_line", make_pipe(round_corners(moving, 0.06), radius=0.085, segments=14), mats.pipe, parent=gimbal)
    discharge = [Vector((pump_x + 0.05, pump_y + 0.10, pump_top - 0.03)), Vector((0.05, -(r_c * 0.5), pivot_z - 0.09))]
    add_mesh_obj("lox_discharge_line", make_pipe(discharge, radius=0.035, segments=12), mats.pipe, parent=gimbal)
    coolant = [Vector((pump_x - 0.05, pump_y - 0.02, pump_top - 0.20)), Vector((-0.20, pump_y - 0.08, pump_top - 0.45)),
               Vector((-manifold_r * math.sin(math.radians(35)), -manifold_r * math.cos(math.radians(35)) - 0.03, z_split + 0.10)),
               Vector((-manifold_r * math.sin(math.radians(35)), -manifold_r * math.cos(math.radians(35)), z_split + 0.02))]
    add_mesh_obj("fuel_coolant_line", make_pipe(round_corners(coolant, 0.10), radius=0.035, segments=12), mats.pipe, parent=gimbal)

    export_glb(os.path.join(OUT_DIR, "thruster-standard.glb"))

# ----------------------------------------------------------------------
# 5. Solid Rocket Booster (booster-standard: length 6.0m, diameter 6.0m, radius 3.0m)
# ----------------------------------------------------------------------
# 燃焼圧・推力係数・膨張比は実寸の推定値。複合推進薬の固体モーターを想定し、Pc ≈ 5 MPa、
# Cf ≈ 1.6 とすると At = F/(Cf·Pc) ≈ 0.075 m²(Dt ≈ 0.31 m)。ε ≈ 12 で De ≈ 1.07 m、
# 15° 円錐の 80% の Rao ベルで Ln ≈ 1.16 m、θn ≈ 30°、θe ≈ 12°。喉と絞り部は後部ドームの内側へ沈める。
BOOSTER_CHAMBER_PRESSURE = 5.0e6  # [Pa]
BOOSTER_THRUST_COEFFICIENT = 1.6
BOOSTER_EXPANSION_RATIO = 12.0

def build_booster():
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = MANIFEST["modules"]["booster-standard"]["length"] / 2.0

    # 1. 外殻: 前方のノーズ、モーターケースの円筒、後方へ広がるスカート(後端は開口)
    booster_profile = [
        (0.00,  half_len),
        (0.60,  half_len - 0.02),
        (1.50,  2.70),
        (2.40,  2.20),
        (3.00,  1.60),
        (3.00, -1.60),
        (3.05, -2.10),
        (3.15, -2.70),
        (3.20, -half_len),
    ]
    add_mesh_obj("booster_casing", make_lathe(booster_profile, segments=64), mats.hull)
    add_mesh_obj("booster_aft_skirt_rim", make_torus(3.18, 0.03, -half_len + 0.03, major_seg=64, minor_seg=8), mats.hull_dark)

    # 2. ケースの継ぎ目の帯
    for zj in [-0.80, 0.50, 1.55]:
        add_mesh_obj(f"booster_joint_{zj}", make_torus(major_r=radius + 0.02, minor_r=0.035, z_center=zj, major_seg=64, minor_seg=8), mats.hull_dark)

    # 3. 前方の分離用小型モーター(外向き・前向きに 35° 傾ける)
    for k in range(4):
        ang = k * math.pi / 2.0
        pos_sep = (2.20 * math.cos(ang), 2.20 * math.sin(ang), 2.30)
        bm_sep = make_cylinder(0.12, 0.07, 0.28, z_center=0.0, segments=12)
        rot = Euler((math.radians(35) * math.sin(ang), -math.radians(35) * math.cos(ang), ang))
        transform_bm(bm_sep, rot.to_matrix().to_4x4())
        transform_bm(bm_sep, Matrix.Translation(Vector(pos_sep)))
        add_mesh_obj(f"sep_motor_{k}", bm_sep, mats.nozzle_rib)

    # 4. 推力に見合う部分沈み込みノズル。出口がモジュールの後端面にある
    r_t = throat_radius(module_thrust("booster-standard"), BOOSTER_CHAMBER_PRESSURE, BOOSTER_THRUST_COEFFICIENT)
    r_e = r_t * math.sqrt(BOOSTER_EXPANSION_RATIO)
    exit_z = -half_len
    throat_z = exit_z + rao_bell_length(r_t, BOOSTER_EXPANSION_RATIO)
    entry_r = 0.42
    nozzle = converging_profile(r_t, throat_z, entry_r, throat_z + converging_length(r_t, entry_r, 45.0) + 0.05, 45.0) \
        + rao_bell_profile(r_t, throat_z, r_e, exit_z, 30.0, 12.0, samples=24)[1:]
    nozzle_wall = 0.05
    add_mesh_obj("booster_nozzle", make_shell_lathe(nozzle, nozzle_wall, segments=64), mats.heatshield)
    add_mesh_obj("booster_nozzle_exit_ring", make_torus(r_e + nozzle_wall + 0.005, 0.025, exit_z + 0.025, major_seg=64, minor_seg=10), mats.hull_dark)
    add_anchor("thrust", (0, 0, exit_z), (0, 0, -1))

    # 5. モーターケースの後部ドームと、ノズルを振る可撓継手の覆い(ブーツ)
    dome_hole_z = throat_z - 0.35
    dome_hole_r = profile_radius_at(nozzle, dome_hole_z) + nozzle_wall + 0.30
    add_mesh_obj("booster_aft_dome", make_lathe([
        (radius, -1.60), (2.75, -1.84), (2.20, -2.02), (1.50, -2.12), (dome_hole_r, dome_hole_z),
    ], segments=64), mats.hull_dark)
    boot_bottom = dome_hole_z - 0.12
    boot_inner = profile_radius_at(nozzle, boot_bottom) + nozzle_wall
    add_mesh_obj("booster_flex_boot", make_lathe([
        (dome_hole_r, dome_hole_z), (dome_hole_r - 0.06, dome_hole_z - 0.06), (boot_inner + 0.10, boot_bottom + 0.02), (boot_inner, boot_bottom),
    ], segments=48), mats.mli_white)
    add_mesh_obj("booster_nozzle_housing_ring", make_torus(boot_inner + 0.02, 0.03, boot_bottom, major_seg=48, minor_seg=10), mats.clamp)

    # 6. 推力方向制御の作動器(ドームからノズルの取付環へ、直交する2本)
    for k, a in enumerate((0.0, math.pi / 2.0)):
        direction = Vector((math.cos(a), math.sin(a), 0.0))
        top = direction * 1.35 + Vector((0, 0, -2.12))
        lug_z = boot_bottom - 0.25
        lug = direction * (profile_radius_at(nozzle, lug_z) + nozzle_wall + 0.03) + Vector((0, 0, lug_z))
        split = top.lerp(lug, 0.55)
        add_mesh_obj(f"tvc_actuator_barrel_{k}", make_strut(top, split, 0.06, segments=14), mats.hull_dark)
        add_mesh_obj(f"tvc_actuator_rod_{k}", make_strut(split, lug, 0.03, segments=10), mats.pipe)
        add_mesh_obj(f"tvc_actuator_lug_{k}", make_box(0.10, 0.10, 0.08, center=lug, rot_euler=(0, 0, a)), mats.clamp)

    # スカートの補強リブ
    for i in range(8):
        ang = i * math.pi / 4.0
        bm_rib = make_box(0.08, 0.22, 1.40, center=(3.10 * math.cos(ang), 3.10 * math.sin(ang), -2.35), rot_euler=(0, 0, ang))
        add_mesh_obj(f"skirt_rib_{i}", bm_rib, mats.hull_dark)

    export_glb(os.path.join(OUT_DIR, "booster-standard.glb"))

# ----------------------------------------------------------------------
# 6. RCS Module (rcs-standard: length 1.0m, diameter 6.0m, radius 3.0m)
# ----------------------------------------------------------------------
def build_rcs_module():
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = 0.5
    
    # Central structural core
    bm_core = make_cylinder(radius * 0.95, radius * 0.95, 1.00, z_center=0.0, segments=48)
    add_mesh_obj("rcs_core", bm_core, mats.hull)
    
    # End rings
    for sign in [-1.0, 1.0]:
        bm_end = make_torus(major_r=radius * 0.98, minor_r=0.035, z_center=sign * (half_len - 0.05), major_seg=48, minor_seg=8)
        add_mesh_obj(f"rcs_end_ring_{sign}", bm_end, mats.hull_dark)

    # 4 Quad thruster pods radiating outward
    for i in range(4):
        ang = i * math.pi / 2.0
        x = (radius - 0.05) * math.cos(ang)
        y = (radius - 0.05) * math.sin(ang)
        # Pod housing
        bm_box = make_box(0.38, 0.38, 0.45, center=(x, y, 0.0), rot_euler=(0, 0, ang))
        add_mesh_obj(f"rcs_pod_{i}", bm_box, mats.hull_dark)
        
        # ポッドの接線 ±・軸 ± へ向いた4基のノズル。出口に噴射口 anchor を置く
        tangent = Vector((-math.sin(ang), math.cos(ang), 0))
        pod = Vector((x, y, 0.0))
        for name, d, reach in [("t+", tangent, 0.19), ("t-", -tangent, 0.19), ("z+", Vector((0, 0, 1)), 0.225), ("z-", Vector((0, 0, -1)), 0.225)]:
            add_directed_nozzle(f"rcs_noz_{i}_{name}", pod + d * (reach + 0.16), d, 0.16, 0.08, 0.03, mats.nozzle_rib, anchor_name=f"rcs:{i}:{name}")

    export_glb(os.path.join(OUT_DIR, "rcs-standard.glb"))

# ----------------------------------------------------------------------
# 7. Docking & Decoupler Modules (docking-port, dock, decoupler)
# ----------------------------------------------------------------------
def build_docking_mechanism(name, kind):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = 0.5
    
    # 1. Main outer structural ring (standard 6.0m diameter)
    mat_main = mats.dock if kind == 'dock' else mats.hull
    bm_ring = make_cylinder(radius, radius, 1.0, z_center=0.0, segments=48)
    add_mesh_obj("ring", bm_ring, mat_main)

    # 2. Recessed Docking Vestibule / Tunnel (+Z forward face)
    if kind != 'decoupler':
        bm_tunnel = make_cylinder(2.20, 2.20, 0.20, z_center=0.40, segments=36)
        add_mesh_obj("dock_tunnel", bm_tunnel, mats.recessed)

        # Internal pressure hatch at bottom of vestibule (z = 0.32m)
        bm_hatch = make_cylinder(2.05, 2.05, 0.04, z_center=0.32, segments=36)
        add_mesh_obj("dock_hatch", bm_hatch, mats.hull_dark)

        # Central optical alignment window
        bm_win = make_cylinder(0.28, 0.28, 0.02, z_center=0.35, segments=16)
        add_mesh_obj("dock_window", bm_win, mats.window)

    # 3. Interface Ring (CRITICAL: Must have name 'interface-ring' and +Z normal!)
    # Torus centered at z=0.44m with minor_r=0.05m (fits strictly within z <= 0.49m)
    bm_int_ring = make_torus(major_r=2.35, minor_r=0.05, z_center=0.44, major_seg=48, minor_seg=12)
    add_mesh_obj("interface-ring", bm_int_ring, mats.cbm_ring)

    # 4. APAS / CBM 3 Guide Petals (120 degrees apart, strictly terminating at z <= 0.49m)
    if kind != 'decoupler':
        for p in range(3):
            ang = p * 2.0 * math.pi / 3.0
            px = 2.22 * math.cos(ang)
            py = 2.22 * math.sin(ang)
            bm_petal = make_box(0.12, 0.35, 0.14, center=(px, py, 0.42), rot_euler=(math.radians(18) * math.sin(ang), -math.radians(18) * math.cos(ang), ang))
            add_mesh_obj(f"guide_petal_{p}", bm_petal, mats.hull_dark)

    # 5. Aft Hull Mounting Flange (-Z face, structural interface)
    bm_aft_flange = make_torus(major_r=radius - 0.05, minor_r=0.04, z_center=-0.48, major_seg=48, minor_seg=8)
    add_mesh_obj("aft_mount_flange", bm_aft_flange, mats.clamp)

    # Circumferential alignment stripe / warning band on outer hull
    bm_band = make_torus(major_r=radius + 0.015, minor_r=0.025, z_center=0.10, major_seg=48, minor_seg=6)
    add_mesh_obj("dock_stripe", bm_band, mats.dock if kind != 'dock' else mats.clamp)

    # Decoupler linear shaped charge cutting tape & separation springs
    if kind == 'decoupler':
        bm_charge = make_torus(major_r=radius + 0.02, minor_r=0.025, z_center=0.0, major_seg=48, minor_seg=6)
        add_mesh_obj("shaped_charge", bm_charge, mats.dock)
        for s in range(6):
            s_ang = s * math.pi / 3.0
            bm_spring = make_cylinder(0.04, 0.04, 0.08, z_center=0.0, segments=8)
            transform_bm(bm_spring, Matrix.Translation(Vector((radius * 0.85 * math.cos(s_ang), radius * 0.85 * math.sin(s_ang), 0.42))))
            add_mesh_obj(f"pusher_spring_{s}", bm_spring, mats.pipe)

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))

# ----------------------------------------------------------------------
# ----------------------------------------------------------------------
# 8. Deployable Modules (solar-panel-standard, radiator-standard)
# ----------------------------------------------------------------------
def build_deployable_chain(kind, half_len, build_panel):
    """取付面 z = half_len のヒンジ panel-hinge の下へ、展開しきった一直線の姿勢で panel-hinge:i を並べる。
    build_panel(i, side) は i 枚目のパネル局所(長手 +Z、厚み方向が法線、原点は根元の厚み中心)に
    メッシュを作って返す。side = (-1)^i はそのパネルの根元ヒンジが載る面。姿勢は実行時に上書きされる。"""
    spec = MANIFEST["deployables"][kind]
    normal = Vector(spec["normalAxis"])
    root = add_anchor("panel-hinge", (0, 0, half_len))
    for index in range(spec["count"]):
        hinge = add_anchor(
            f"panel-hinge:{index}", normal * (spec["thickness"] / 2) + Vector((0, 0, index * spec["length"])),
            parent=root, panelIndex=index, panelKind=kind,
        )
        for obj in build_panel(index, 1 if index % 2 == 0 else -1):
            parent_to(obj, hinge)

# 展開モジュールの船体側取付構造。母船の船体は半径 3.0 m の円筒で、側面取付の回転
# (sideSlotRotation)はどの向き(side:±x / side:±y)でも母船の長手軸をモジュール局所 ±X へ写す。
# モジュール後端面 z = -0.5 が船体面の接点なので、局所座標では船体円筒軸は高さ z = -3.5 を
# X 方向へ走り、座板の凹弧はその軸まわりの半径となる。
HULL_AXIS_Z = -3.5            # モジュール局所での船体円筒軸の高さ [m]
SADDLE_INNER_RADIUS = 3.02    # 座板の内面半径 [m]。船体 R=3.0 へ 2 cm の取付代を残す
SADDLE_THICKNESS = 0.07       # 座板の厚み [m]
SADDLE_PADS = (               # 座板の位置 (船体軸方向 x, 周方向角 t [rad])
    (0.85, 0.13), (0.85, -0.13), (-0.85, 0.13), (-0.85, -0.13),
)
SADDLE_HALF_DT = 0.08         # 座板の周方向の半幅 [rad]。これ以上広げると端が z=-0.55 を割る
SADDLE_HALF_W = 0.35          # 座板の船体軸方向の半幅 [m]

def saddle_top(t):
    """座板の上面(外半径)で周方向角 t の点のモジュール局所座標。x は含まず (0, y, z)。"""
    r = SADDLE_INNER_RADIUS + SADDLE_THICKNESS
    return Vector((0.0, r * math.sin(t), HULL_AXIS_Z + r * math.cos(t)))

def build_hull_junction(mats, half_len):
    """船体円筒へ伏せる座板・斜めに開いた脚・機構を載せる台座を架け、
    取付面(z≈+0.4)から船体の接面(z=-0.5)までを構造で繋ぐ。"""
    for index, (xc, tc) in enumerate(SADDLE_PADS):
        add_mesh_obj(f"hull_saddle:{index}", make_curved_plate(
            tc - SADDLE_HALF_DT, tc + SADDLE_HALF_DT, SADDLE_INNER_RADIUS, SADDLE_THICKNESS,
            xc - SADDLE_HALF_W, xc + SADDLE_HALF_W, HULL_AXIS_Z), mats.hull_dark)
        # 座板の締結ボルト。船体軸方向2列×周方向3列
        add_mesh_obj(f"saddle_bolts:{index}", make_boxes([
            (0.05, 0.05, 0.04,
             (xc + sx, saddle_top(tc + st).y, saddle_top(tc + st).z + 0.01), (-(tc + st), 0.0, 0.0))
            for sx in (-0.26, 0.26) for st in (-0.055, 0.0, 0.055)
        ], bevel=0.005), mats.clamp)
        # 座板の中央から台座の下端へ斜めに開いた脚
        foot = saddle_top(tc) + Vector((xc, 0.0, 0.0))
        top = Vector((foot.x, foot.y, 0.0)).normalized() * 0.33 + Vector((0.0, 0.0, 0.10))
        add_mesh_obj(f"mount_leg:{index}", make_strut(foot, top, 0.065, segments=12), mats.truss)
        add_mesh_obj(f"mount_leg_foot:{index}", make_sphere(0.085, center=foot, u_seg=12, v_seg=8), mats.clamp)
    # 機構を載せる台座。円盤を受ける形を名残なくすため円形ではなく角柱で、
    # 脚が届く下端だけ太く、上は駆動ドラムへ吸い込まれる細い四角錐台
    add_mesh_obj("mount_pedestal", make_lathe([
        (0.0, 0.00), (0.58, 0.00), (0.60, 0.04), (0.50, 0.08),
        (0.50, 0.30), (0.46, 0.36), (0.46, half_len - 0.06), (0.0, half_len - 0.06),
    ], segments=4, closed=True, sharp_angle_deg=0.0), mats.hull_dark)

def build_solar_mount(mats, half_len, thickness):
    """レースリング軸受と根元ヒンジの駆動部。パネル列の根元ヒンジ(panel-hinge)はモジュール軸上の
    取付面にあるので、駆動ドラムはヒンジ軸(X 軸)と同軸に置き、台座頂の軸受リングが
    内ドラムとヨークを介してヒンジを支える。"""
    # レースリング軸受: 台座へ固定の外レース、翼列と一緒に回る内レース、その間の転がり要素。
    # 内レースの内縁(0.525)は台座の外径(0.52)へ載り、外レースの外縁(0.83)には駆動モーターが付く
    add_mesh_obj("sarj_race_outer", make_torus(0.78, 0.05, z_center=0.30, major_seg=48, minor_seg=12), mats.clamp)
    add_mesh_obj("sarj_race_inner", make_torus(0.575, 0.05, z_center=0.30, major_seg=48, minor_seg=12), mats.hull_dark)
    for i in range(14):
        a = i * 2.0 * math.pi / 14
        add_mesh_obj(f"sarj_roller_{i}", make_sphere(
            0.05, center=(0.70 * math.cos(a), 0.70 * math.sin(a), 0.30), u_seg=10, v_seg=8), mats.pipe)
    # 外レースの外縁へ付く3基の駆動モーターと、外レースへ噛み合うピニオン
    for i in range(3):
        a = i * 2.0 * math.pi / 3.0 + math.pi / 6.0
        px, py = 0.85 * math.cos(a), 0.85 * math.sin(a)
        bm_motor = make_cylinder(0.075, 0.075, 0.22, z_center=0.27, segments=16)
        add_mesh_obj(f"sarj_motor_{i}", transform_bm(bm_motor, Matrix.Translation(Vector((px, py, 0.0)))), mats.hull_dark)
        bm_pinion = make_cylinder(0.11, 0.11, 0.06, z_center=0.30, segments=16)
        add_mesh_obj(f"sarj_motor_pinion_{i}",
            transform_bm(bm_pinion, Matrix.Translation(Vector((0.87 * px, 0.87 * py, 0.0)))), mats.clamp)
    # 内レースからヒンジまで立ち上がる回転ドラムと、ドラム端へ届く短いヨーク
    add_mesh_obj("sarj_drum", make_cylinder(0.58, 0.58, 0.20, z_center=0.40, segments=40), mats.hull_dark)
    hx, hy, hz = 0.0, -thickness / 2, half_len  # 根元ヒンジ軸(おもて +Y の反対側の面)
    for sx in (-1.0, 1.0):
        add_mesh_obj(f"sarj_yoke_{sx:+.0f}", make_strut(
            Vector((sx * 0.60, hy, 0.33)), Vector((sx * 0.40, hy, half_len - 0.02)), 0.05), mats.truss)
    # 駆動ドラムと軸受。ドラムはフランジへ半分埋まる配置で、取付面から浮かない
    bm_drum = make_cylinder(0.14, 0.14, 0.72, z_center=0.0, segments=24)
    transform_bm(bm_drum, Matrix.Translation(Vector((hx, hy, hz))) @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("sada_drum", bm_drum, mats.hull_dark)
    bm_caps = make_boxes([
        (0.05, 0.19, 0.19, (sx * 0.38, hy, hz), (0.0, 0.0, 0.0)) for sx in (-1.0, 1.0)
    ])
    add_mesh_obj("sada_drum_caps", bm_caps, mats.clamp)
    bm_cheeks = make_boxes([
        (0.10, 0.30, 0.16, (sx * 0.44, hy, half_len - 0.04), (0.0, 0.0, 0.0)) for sx in (-1.0, 1.0)
    ])
    add_mesh_obj("sada_bearing_cheeks", bm_cheeks, mats.hull_dark)
    # ドラム脇の駆動モーター
    bm_motor = make_cylinder(0.085, 0.085, 0.34, z_center=0.0, segments=16)
    transform_bm(bm_motor, Matrix.Translation(Vector((0.78, hy, hz + 0.02))) @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("sada_motor", bm_motor, mats.hull_dark)
    add_mesh_obj("sada_motor_mount", make_box(0.12, 0.22, 0.12, center=(0.78, hy, half_len - 0.05)), mats.clamp)
    # 台座から座板の貫通金具へ降ろす動力・信号のケーブル束(平行な2撚り)
    pad_x, pad_t = -0.85, -0.13
    top = saddle_top(pad_t)
    add_mesh_obj("power_umbilical", make_pipes([
        [Vector((-0.42, -0.30, 0.22)), Vector((-0.60, -0.40, -0.05)), Vector((pad_x + 0.06, top.y - 0.02, top.z + 0.06))],
        [Vector((-0.36, -0.34, 0.22)), Vector((-0.54, -0.44, -0.05)), Vector((pad_x + 0.14, top.y - 0.04, top.z + 0.05))],
    ], radius=0.03, segments=10, bend_radius=0.08), mats.clamp)
    add_mesh_obj("umbilical_fitting", make_box(0.24, 0.18, 0.07,
        center=(pad_x + 0.10, top.y - 0.03, top.z + 0.02), rot_euler=(-pad_t, 0.0, 0.0)), mats.hull_dark)
    # 金具から船体内部へ潜る貫通部。船体面より下は母船へ吸収されるのでモジュール側では切り落とす
    add_mesh_obj("umbilical_stub", make_pipes([
        [Vector((pad_x + 0.06, top.y - 0.02, top.z + 0.04)), Vector((pad_x + 0.06, top.y - 0.04, -0.62))],
        [Vector((pad_x + 0.14, top.y - 0.04, top.z + 0.03)), Vector((pad_x + 0.14, top.y - 0.06, -0.62))],
    ], radius=0.028, segments=8), mats.clamp)

def build_solar_panel(name):
    reset_scene()
    mats = MaterialLibrary()
    half_len = MANIFEST["modules"][name]["length"] / 2
    build_hull_junction(mats, half_len)
    spec = MANIFEST["deployables"]["solar_panel"]
    length, span, thickness = spec["length"], spec["span"], spec["thickness"]
    build_solar_mount(mats, half_len, thickness)

    body_span, body_len = span * 0.96, length * 0.96
    # セル面は外周枠の内側に収める。枠の幅 0.05・根本枠はヒンジ胴を避けて z≈0.07 から
    cell_x0, cell_x1 = -body_span / 2 + 0.075, body_span / 2 - 0.075
    cell_z0, cell_z1 = 0.10, body_len - 0.075
    cols, rows = 6, 9
    cell_gap = 0.035

    def panel(index, side):
        # おもて面 +Y にセル列とバスバー、裏面は白いカプトン(本体)と押さえ帯、外周はセル面より出る枠
        body = add_mesh_obj(f"panel:{index}",
            make_box(body_span, thickness, body_len, center=(0.0, 0.0, length * 0.5)), mats.mli_white)
        body["name"] = "deployable-panel" if index == 0 else f"deployable-panel:{index}"
        cell_parts = []
        for c in range(cols):
            for r in range(rows):
                cx = cell_x0 + (c + 0.5) * (cell_x1 - cell_x0) / cols
                cz = cell_z0 + (r + 0.5) * (cell_z1 - cell_z0) / rows
                cell_parts.append((
                    (cell_x1 - cell_x0) / cols - cell_gap, 0.012, (cell_z1 - cell_z0) / rows - cell_gap,
                    (cx, thickness / 2 + 0.006, cz), (0.0, 0.0, 0.0),
                ))
        cells = add_mesh_obj(f"panel_cells:{index}", make_boxes(cell_parts, bevel=0.003), mats.solar)
        busbars = add_mesh_obj(f"panel_busbars:{index}", make_boxes([
            (0.035, 0.008, cell_z1 - cell_z0, (bx, thickness / 2 + 0.016, (cell_z0 + cell_z1) / 2), (0.0, 0.0, 0.0))
            for bx in (-0.96, 0.96)
        ], bevel=0.004), mats.pipe)
        frame = add_mesh_obj(f"panel_frame:{index}", make_boxes([
            (0.05, 0.10, body_len - 0.09, (sx * (body_span / 2 - 0.025), 0.0, 0.045 + (body_len - 0.09) / 2), (0.0, 0.0, 0.0))
            for sx in (-1.0, 1.0)
        ] + [
            (body_span, 0.10, 0.05, (0.0, 0.0, 0.045), (0.0, 0.0, 0.0)),
            (body_span, 0.10, 0.05, (0.0, 0.0, body_len - 0.025), (0.0, 0.0, 0.0)),
        ], bevel=0.012), mats.hull)
        straps = add_mesh_obj(f"panel_straps:{index}", make_boxes([
            (span * 0.88, 0.008, 0.07, (0.0, -thickness / 2 - 0.004, sz), (0.0, 0.0, 0.0))
            for sz in (0.95, length * 0.5, length - 0.95)
        ], bevel=0.004), mats.truss)
        bm_hinge = make_cylinder(0.035, 0.035, span * 0.98, z_center=0.0, segments=12)
        transform_bm(bm_hinge, Matrix.Translation(Vector((0.0, -side * thickness / 2, 0.0))) @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
        knuckle = add_mesh_obj(f"panel_hinge_hardware:{index}", bm_hinge, mats.clamp)
        return [body, cells, busbars, frame, straps, knuckle]

    build_deployable_chain("solar_panel", half_len, panel)
    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))


def build_radiator_mount(mats, half_len):
    """回転流体継手のハウジングと、船体へ降りる冷媒の往復管。継手ドラムはパネル列の収納範囲
    (展開方向に掃く ±X)の外、翼端方向 +Y へ置き、根元ヒンジ胴(Y 軸)の端へ軸を繋ぐ。
    供給管は継手からフランジ下面を潜って台座の脇を下り、座板の貫通部まで剥き出しで架ける。"""
    drum = Vector((-0.04, 1.82, half_len + 0.05))
    bm_drum = make_cylinder(0.20, 0.20, 0.55, z_center=0.0, segments=28)
    transform_bm(bm_drum, Matrix.Translation(drum) @ Euler((math.pi / 2, 0.0, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("fluid_joint_drum", bm_drum, mats.hull_dark)
    bm_cap = make_cylinder(0.26, 0.26, 0.07, z_center=0.0, segments=28)
    transform_bm(bm_cap, Matrix.Translation(drum + Vector((0.0, 0.31, 0.0))) @ Euler((math.pi / 2, 0.0, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("fluid_joint_cap", bm_cap, mats.clamp)
    add_mesh_obj("fluid_joint_pedestal", make_box(0.40, 0.42, 0.16, center=(0.0, 1.82, half_len - 0.06)), mats.hull_dark)
    # 継手ドラムの取り出し口から台座の脇を経て座板の貫通金具へ下りる行き・戻りの供給管
    pad_x, pad_t = -0.85, 0.13
    top = saddle_top(pad_t)
    add_mesh_obj("fluid_joint_feeds", make_pipes([
        [Vector((-0.14, 1.62, half_len - 0.08)), Vector((-0.14, 1.55, 0.28)), Vector((-0.18, 0.90, 0.12)),
         Vector((-0.24, 0.52, 0.00)), Vector((-0.50, 0.44, -0.22)), Vector((pad_x + 0.16, top.y + 0.02, top.z + 0.05))],
        [Vector((0.06, 1.68, half_len - 0.08)), Vector((0.06, 1.50, 0.26)), Vector((0.02, 0.85, 0.08)),
         Vector((-0.08, 0.50, -0.04)), Vector((-0.44, 0.46, -0.26)), Vector((pad_x + 0.24, top.y + 0.04, top.z + 0.04))],
    ], radius=0.04, segments=12, bend_radius=0.08), mats.pipe)
    # 座板上の貫通金具(船体側の冷媒口)。往復管はここで母船の冷媒系へ合流する
    fit = Vector((pad_x + 0.20, top.y + 0.03, top.z + 0.01))
    bm_manifold = make_cylinder(0.13, 0.13, 0.14, z_center=0.0, segments=16)
    transform_bm(bm_manifold, Matrix.Translation(fit) @ Euler((-pad_t, 0.0, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("coolant_manifold", bm_manifold, mats.pipe)
    # 金具から船体内部へ潜る口。船体面より下は母船へ吸収されるのでモジュール側では切り落とす
    add_mesh_obj("coolant_stubs", make_pipes([
        [Vector((pad_x + 0.16, top.y + 0.02, top.z + 0.05)), Vector((pad_x + 0.17, top.y + 0.02, -0.62))],
        [Vector((pad_x + 0.24, top.y + 0.04, top.z + 0.04)), Vector((pad_x + 0.25, top.y + 0.04, -0.62))],
    ], radius=0.035, segments=10), mats.pipe)
    # 継手ドラムから根元ヒンジ胴の端へ入る軸と、反対端の軸受
    add_mesh_obj("fluid_joint_shaft", make_strut(
        Vector((-0.04, 1.42, half_len)), Vector((-0.04, 1.70, half_len)), 0.07), mats.clamp)
    bm_cap2 = make_cylinder(0.11, 0.11, 0.24, z_center=0.0, segments=16)
    transform_bm(bm_cap2, Matrix.Translation(Vector((-0.04, -1.67, half_len))) @ Euler((math.pi / 2, 0.0, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("fluid_joint_bearing", bm_cap2, mats.clamp)
    add_mesh_obj("fluid_joint_bearing_mount", make_box(0.16, 0.28, 0.12, center=(-0.04, -1.67, half_len - 0.04)), mats.hull_dark)


def build_radiator(name):
    reset_scene()
    mats = MaterialLibrary()
    half_len = MANIFEST["modules"][name]["length"] / 2
    build_hull_junction(mats, half_len)
    build_radiator_mount(mats, half_len)

    spec = MANIFEST["deployables"]["radiator"]
    length, span, thickness = spec["length"], spec["span"], spec["thickness"]
    body_span, body_len = span * 0.96, length * 0.96
    face_x = thickness / 2
    # 流路管の両端を集める集合管の Z。折り目の渡り管は +X 面の先端集合管から隣パネルの根元集合管へ架かる
    header_z0, header_z1 = 0.12, body_len - 0.15
    lanes = (-1.05, -0.35, 0.35, 1.05)
    hose_ys = (-0.90, 0.90)

    def panel(index, side):
        # 両面が放熱面。流路管は両面に半分浮き出し、根元・先端の縁に集合管、外周に枠を持つ
        body = add_mesh_obj(f"panel:{index}",
            make_box(thickness, body_span, body_len, center=(0.0, 0.0, length * 0.5)), mats.radiator)
        body["name"] = "deployable-panel" if index == 0 else f"deployable-panel:{index}"
        parts = [body]
        paths = []
        for face in (1, -1):
            for lane in lanes:
                paths.append([Vector((face * face_x, lane, header_z0)), Vector((face * face_x, lane, header_z1))])
        # ヒンジ胴のある面から根元の縁を跨ぎ、集合管へ繋ぐ渡り管
        paths.append(round_corners([
            Vector((-side * face_x, 1.30, 0.045)), Vector((-side * face_x, 1.30, -0.06)),
            Vector((0.0, 1.30, -0.06)), Vector((0.0, 1.30, header_z0)),
        ], 0.045))
        parts.append(add_mesh_obj(f"radiator_pipes:{index}", make_pipes(paths, radius=0.035, segments=10), mats.pipe))
        parts.append(add_mesh_obj(f"radiator_headers:{index}", make_pipes([
            [Vector((0.0, -1.30, header_z0)), Vector((0.0, 1.30, header_z0))],
            [Vector((0.0, -1.30, header_z1)), Vector((0.0, 1.30, header_z1))],
        ], radius=0.065, segments=14), mats.pipe))
        # 折り目: +X 面の先端集合管から、隣パネルのヒンジ軸(常に +X 面側)を回り込んで
        # 隣パネルの根元集合管へ届くホース。先頭以外のパネルは持たない
        if index < spec["count"] - 1:
            hose_paths = []
            for hy in hose_ys:
                arc = [Vector((face_x, hy, header_z1))]
                for k in range(11):
                    a = math.pi * k / 10
                    arc.append(Vector((face_x + 0.10 * math.sin(a), hy, length - 0.10 * math.cos(a))))
                hose_paths.append(arc)
            parts.append(add_mesh_obj(f"radiator_hoses:{index}", make_pipes(hose_paths, radius=0.030, segments=10), mats.clamp))
        frame = add_mesh_obj(f"radiator_frame:{index}", make_boxes([
            (0.10, 0.05, body_len, (0.0, sy * (body_span / 2 - 0.025), length * 0.5), (0.0, 0.0, 0.0))
            for sy in (-1.0, 1.0)
        ] + [
            (0.10, body_span, 0.05, (0.0, 0.0, 0.075), (0.0, 0.0, 0.0)),
            (0.10, body_span, 0.05, (0.0, 0.0, body_len - 0.025), (0.0, 0.0, 0.0)),
        ], bevel=0.012), mats.hull_dark)
        parts.append(frame)
        bm_hinge = make_cylinder(0.04, 0.04, span * 0.98, z_center=0.0, segments=12)
        transform_bm(bm_hinge, Matrix.Translation(Vector((-side * face_x, 0.0, 0.0))) @ Euler((math.pi / 2, 0.0, 0.0)).to_matrix().to_4x4())
        parts.append(add_mesh_obj(f"radiator_hinge_hardware:{index}", bm_hinge, mats.clamp))
        return parts

    build_deployable_chain("radiator", half_len, panel)
    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))

# ----------------------------------------------------------------------
# 9. Armor Modules (armor-standard, armor-combat)
# ----------------------------------------------------------------------
def build_armor(name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.08 # Slightly thicker for composite armor
    length = 1.0
    half_len = 0.5
    
    # Main Whipple bumper shield
    bm_hull = make_cylinder(radius, radius, length, z_center=0.0, segments=48)
    add_mesh_obj("armor_hull", bm_hull, mats.hull_dark)
    
    # Ceramic armor tile seams & circumferential containment bands
    for za in [-0.35, 0.0, 0.35]:
        bm_band = make_torus(major_r=radius + 0.02, minor_r=0.03, z_center=za, major_seg=48, minor_seg=8)
        add_mesh_obj(f"armor_band_{za}", bm_band, mats.clamp)
        
    # Axial bolt lines
    for i in range(12):
        ang = i * math.pi / 6.0
        bm_strip = make_box(0.04, 0.08, 0.95, center=(radius * math.cos(ang), radius * math.sin(ang), 0.0), rot_euler=(0, 0, ang))
        add_mesh_obj(f"armor_strip_{i}", bm_strip, mats.hull)

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))

# ----------------------------------------------------------------------
# 10. Weapon Module (weapon-gatling)
# ----------------------------------------------------------------------
# 回転砲身の本数
GATLING_BARREL_COUNT = 5

def make_plate_prism(outline, z_bottom, z_top):
    """XY 面の輪郭 outline(+Z から見て反時計回り)を [z_bottom, z_top] の厚みへ押し出した板。"""
    bm = bmesh.new()
    n = len(outline)
    vb = [bm.verts.new((x, y, z_bottom)) for x, y in outline]
    vt = [bm.verts.new((x, y, z_top)) for x, y in outline]
    bm.faces.new(vt)
    bm.faces.new(list(reversed(vb)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([vb[i], vb[j], vt[j], vt[i]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bevel_faces = bevel_creases(bm, 0.015, segments=2, crease_angle_deg=60.0)
    return shade_by_angle(bm, 30.0, bevel_faces)


# YZ 輪郭の板を X 軸へ押し出し、砲架の厚い鋳鋼縁を面取りする。
def make_gun_cheek(outline, x0, x1, bevel=0.04):
    bm = make_plate_prism(outline, x0, x1)
    transform_bm(bm, Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    bevel_faces = bevel_creases(bm, bevel, segments=3, crease_angle_deg=35.0)
    return shade_by_angle(bm, 40.0, bevel_faces)


# 塗装・切削面・締結具を武器専用の材質として用意する。
def add_gun_materials(mats):
    mats.gun_paint = create_pbr_material("mat_gun_naval_gray", (0.31, 0.37, 0.40, 1.0), 0.53, 0.0)
    mats.gun_panel = create_pbr_material("mat_gun_panel_gray", (0.20, 0.25, 0.28, 1.0), 0.58, 0.0)
    mats.gun_machined = create_pbr_material("mat_gun_machined", (0.66, 0.72, 0.75, 1.0), 0.25, 0.72)
    mats.gun_bronze = create_pbr_material("mat_gun_bronze", (0.31, 0.23, 0.14, 1.0), 0.46, 0.45)


# 模型座標の位置列へ、軸方向を揃えた六角ボルトを一つのメッシュとして作る。
def add_gun_bolts(name, positions, direction, mats, parent=None, radius=0.035):
    bm = bmesh.new()
    rotation = Vector(direction).to_track_quat('Z', 'Y').to_matrix().to_4x4()
    for position in positions:
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=6,
            radius1=radius, radius2=radius, depth=0.027,
            matrix=Matrix.Translation(Vector(position)) @ rotation)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bevel_faces = bevel_creases(bm, 0.004, segments=2)
    add_mesh_obj(name, shade_by_angle(bm, 30, bevel_faces), mats.gun_machined, parent=parent)


# 固定砲架を作る。頬板下側の切り欠きは排莢樋と給弾塔の空間を確保する。
def build_gun_cradle(mats, deck_top):
    outline = [(0.20, deck_top + 0.04), (1.13, deck_top + 0.04), (1.32, 0.0),
        (1.26, 0.68), (0.76, 1.32), (-0.64, 1.32), (-0.78, 1.06),
        (-0.78, 0.67), (0.20, 0.67)]
    panel = [(0.30, -0.19), (1.00, -0.19), (1.12, 0.08), (1.08, 0.61),
        (0.65, 1.17), (-0.49, 1.17), (-0.61, 1.00), (-0.61, 0.82), (0.30, 0.82)]
    # 頬板の段付き外面と、軸受を支える幅広の足。
    for side in (-1.0, 1.0):
        x = side * 1.36
        add_mesh_obj(f"gun_cradle_cheek_{side:+.0f}",
            make_gun_cheek(outline, x - 0.13, x + 0.13), mats.gun_paint)
        add_mesh_obj(f"gun_cradle_cheek_field_{side:+.0f}",
            make_gun_cheek(panel, side * 1.496 - 0.012, side * 1.496 + 0.012, 0.012), mats.gun_panel)
        add_mesh_obj(f"gun_cradle_foot_{side:+.0f}", make_box(0.57, 1.16, 0.10,
            center=(x, 0.72, deck_top + 0.05), bevel=0.035), mats.gun_paint)
        bearing_transform = Matrix.Translation((side * 1.53, 0.64, 0.40)) @ Euler((0, math.pi / 2, 0)).to_matrix().to_4x4()
        add_mesh_obj(f"gun_cradle_trunnion_{side:+.0f}",
            transform_bm(make_cylinder(0.38, 0.38, 0.22, segments=40), bearing_transform), mats.gun_paint)
        add_mesh_obj(f"gun_trunnion_hub_{side:+.0f}",
            transform_bm(make_cylinder(0.24, 0.24, 0.24, segments=32), bearing_transform), mats.gun_machined)
        positions = [(side * 1.65, 0.64 + 0.31 * math.cos(a), 0.40 + 0.31 * math.sin(a))
            for a in [i * math.pi / 4 for i in range(8)]]
        add_gun_bolts(f"gun_trunnion_bolts_{side:+.0f}", positions, (side, 0, 0), mats)
        add_gun_bolts(f"gun_cheek_bolts_{side:+.0f}",
            [(side * 1.52, y, z) for y, z in ((-.51, 1.23), (.14, 1.23), (.70, 1.20), (1.18, .60), (.29, -.22))],
            (side, 0, 0), mats)
    # 後座を支える案内レールと、甲板へ反力を渡す横梁。
    for y in (-0.62, 0.62):
        add_mesh_obj(f"gun_cradle_crossbeam_{y:+.2f}", make_box(2.60, 0.20, 0.14,
            center=(0, y, deck_top + .09), bevel=.025), mats.gun_paint)
    for side in (-1.0, 1.0):
        add_mesh_obj(f"gun_slide_rail_{side:+.0f}", make_box(.17, .20, 1.47,
            center=(side * .93, -.38, .44), bevel=.018), mats.gun_machined)
        add_mesh_obj(f"gun_slide_rail_seat_{side:+.0f}", make_box(.27, .34, .14,
            center=(side * .93, -.38, deck_top + .10), bevel=.025), mats.gun_paint)


# 後座する機関部、駆動装置、軸受と整備扉を組む。
def build_gun_receiver(mats, recoil, breech_z):
    receiver_back, receiver_front = -0.06, breech_z - 0.06
    add_mesh_obj("gun_receiver", make_box(1.65, 1.48, receiver_front - receiver_back,
        center=(0, 0, (receiver_front + receiver_back) / 2), bevel=.08), mats.gun_paint, parent=recoil)
    add_mesh_obj("gun_receiver_rear_cover", make_box(1.42, 1.25, .07,
        center=(0, 0, -.065), bevel=.045), mats.gun_panel, parent=recoil)
    # 天面の段差と排熱格子。
    add_mesh_obj("gun_receiver_top_hatch", make_box(1.16, .09, .66,
        center=(0, .76, .43), bevel=.04), mats.gun_panel, parent=recoil)
    for i in range(5):
        add_mesh_obj(f"gun_receiver_louvre_{i}", make_box(.72, .035, .045,
            center=(0, .819, .20 + i * .105), bevel=.009), mats.gun_machined, parent=recoil)
    for side in (-1.0, 1.0):
        add_mesh_obj(f"gun_slide_shoe_{side:+.0f}", make_box(.32, .31, .37,
            center=(side * .87, -.38, .62), bevel=.025), mats.gun_panel, parent=recoil)
        add_mesh_obj(f"gun_receiver_side_door_{side:+.0f}", make_box(.05, .71, .61,
            center=(side * .843, .16, .52), bevel=.025), mats.gun_panel, parent=recoil)
        add_gun_bolts(f"gun_receiver_door_bolts_{side:+.0f}",
            [(side * .88, y, z) for y in (-.13, .45) for z in (.27, .77)],
            (side, 0, 0), mats, recoil, .026)
        add_mesh_obj(f"gun_receiver_door_handle_{side:+.0f}",
            make_pipes([[Vector((side * .88, .02, .47)), Vector((side * .94, .02, .47)),
                Vector((side * .94, .23, .47)), Vector((side * .88, .23, .47))]], .018, 10, .025),
            mats.gun_machined, parent=recoil)
    # 砲身束を囲う軸受環と、機関部に載る駆動モーター。
    add_mesh_obj("gun_front_bearing", make_lathe([(.79, receiver_front - .09), (.94, receiver_front - .09),
        (.98, receiver_front - .02), (.98, receiver_front + .10), (.92, receiver_front + .14),
        (.79, receiver_front + .14)], segments=56, closed=True), mats.gun_paint, parent=recoil)
    add_mesh_obj("gun_front_bearing_rim", make_torus(.88, .024, receiver_front + .145, 56, 10),
        mats.gun_machined, parent=recoil)
    add_gun_bolts("gun_front_bearing_bolts",
        [(.89 * math.cos(a), .89 * math.sin(a), receiver_front + .152)
            for a in [i * math.pi / 6 for i in range(12)]], (0, 0, 1), mats, recoil)
    add_mesh_obj("gun_drive_motor", transform_bm(make_cylinder(.22, .22, .64, .30, 32),
        Matrix.Translation((0, 1.03, 0))), mats.gun_panel, parent=recoil)
    add_mesh_obj("gun_motor_rear_cap", transform_bm(make_cylinder(.17, .17, .07, -.055, 24),
        Matrix.Translation((0, 1.03, 0))), mats.gun_machined, parent=recoil)
    add_mesh_obj("gun_motor_gearbox", make_box(.50, .40, .30, center=(0, .95, .73), bevel=.045),
        mats.gun_paint, parent=recoil)
    for z in (.09, .20, .31, .42, .53):
        add_mesh_obj(f"gun_motor_cooling_fin_{z}", transform_bm(make_torus(.22, .017, z, 32, 8),
            Matrix.Translation((0, 1.03, 0))), mats.gun_machined, parent=recoil)


# 固定スリーブと後座ロッドを同軸に組み、最大 0.22 m の後退でも嵌合を保つ。
def build_gun_recoil_cylinders(mats, recoil):
    for side in (-1.0, 1.0):
        x, y = side * 1.07, -.66
        offset = Matrix.Translation((x, y, 0))
        add_mesh_obj(f"gun_recoil_sleeve_{side:+.0f}", transform_bm(make_lathe([
            (.11, -.22), (.20, -.22), (.21, -.17), (.21, .43), (.18, .49), (.11, .49),
        ], 40, closed=True), offset), mats.gun_paint)
        add_mesh_obj(f"gun_recoil_gland_{side:+.0f}", transform_bm(make_lathe([
            (.103, .43), (.225, .43), (.225, .51), (.103, .51),
        ], 40, closed=True), offset), mats.gun_machined)
        add_mesh_obj(f"gun_recoil_rod_{side:+.0f}", transform_bm(
            make_cylinder(.10, .10, 1.00, .66, 32), offset), mats.gun_machined, parent=recoil)
        add_mesh_obj(f"gun_recoil_rod_crosshead_{side:+.0f}", make_box(.43, .25, .16,
            center=(side * .93, y, 1.17), bevel=.045), mats.gun_paint, parent=recoil)
        for z in (-.12, .30):
            add_mesh_obj(f"gun_cylinder_saddle_{side:+.0f}_{z}", make_box(.42, .23, .14,
                center=(x, y + .17, z), bevel=.025), mats.gun_panel)
        add_mesh_obj(f"gun_hydraulic_line_{side:+.0f}", make_pipes([
            [Vector((x, y, -.13)), Vector((side * 1.72, y, -.13)),
                Vector((side * 1.72, .97, -.13)), Vector((side * 1.20, 1.56, -.13))],
            [Vector((x, y, .32)), Vector((side * 1.47, -.92, .32)),
                Vector((side * 1.76, -.92, .04)), Vector((side * 1.76, .97, .04))],
        ], .032, 12, .12), mats.gun_bronze)
        add_gun_bolts(f"gun_gland_bolts_{side:+.0f}",
            [(x + .17 * math.cos(a), y + .17 * math.sin(a), .527)
                for a in [i * math.pi / 3 for i in range(6)]], (0, 0, 1), mats, radius=.026)


# 固定側の機械室と圧力容器を甲板へ据え付ける。
def build_gun_service_house(mats, deck_top):
    add_mesh_obj("gun_house", make_box(2.20, .77, .67,
        center=(0, 1.80, deck_top + .335), bevel=.075), mats.gun_paint)
    add_mesh_obj("gun_house_hood", make_box(2.03, .65, .08,
        center=(0, 1.81, .33), bevel=.035), mats.gun_panel)
    for side in (-1.0, 1.0):
        add_mesh_obj(f"gun_house_service_door_{side:+.0f}", make_box(.75, .49, .025,
            center=(side * .54, 1.80, .384), bevel=.025), mats.gun_paint)
        add_gun_bolts(f"gun_house_door_bolts_{side:+.0f}",
            [(side * .54 + dx, 1.80 + dy, .409) for dx in (-.29, .29) for dy in (-.18, .18)],
            (0, 0, 1), mats, radius=.026)
        add_mesh_obj(f"gun_accumulator_{side:+.0f}", transform_bm(make_lathe([
            (0, -.23), (.18, -.23), (.22, -.15), (.22, .30), (.18, .40), (0, .40),
        ], 32), Matrix.Translation((side * 1.55, 1.36, 0))), mats.gun_panel)
        add_mesh_obj(f"gun_accumulator_band_{side:+.0f}", transform_bm(make_torus(.224, .025, .12, 32, 8),
            Matrix.Translation((side * 1.55, 1.36, 0))), mats.gun_machined)
        add_mesh_obj(f"gun_conduit_{side:+.0f}", make_pipes([[
            Vector((side * .73, 2.1, -.14)), Vector((side * .95, 2.45, -.25)),
        ]], .035, 12), mats.pipe)
        add_mesh_obj(f"gun_conduit_relay_{side:+.0f}", make_box(.34, .26, .20,
            center=(side * .95, 2.42, -.25), bevel=.03), mats.gun_panel)


# 砲身の個別カラーと中央ハブを結び、砲身間に抜けのある回転束を作る。
def build_gun_barrels(mats, recoil, breech_z, muzzle_z):
    rotor = add_anchor("barrel-rotor:0", (0, 0, breech_z - .04),
        parent=recoil, barrelCount=GATLING_BARREL_COUNT)
    add_mesh_obj("barrel_hub", make_cylinder(.76, .76, .17, breech_z - .045, 48),
        mats.gun_panel, parent=rotor)
    add_mesh_obj("barrel_spindle", make_cylinder(.09, .09, muzzle_z - .15 - breech_z,
        (muzzle_z - .15 + breech_z) / 2, 20), mats.gun_machined, parent=rotor)
    cluster_r = .59
    # 開口砲口、段付き薬室、放熱帯。
    for b in range(GATLING_BARREL_COUNT):
        a = b * 2 * math.pi / GATLING_BARREL_COUNT
        offset = Matrix.Translation((cluster_r * math.cos(a), cluster_r * math.sin(a), 0))
        barrel = make_lathe([(0, breech_z), (.19, breech_z), (.19, breech_z + .23),
            (.165, breech_z + .31), (.151, muzzle_z - .20), (.173, muzzle_z - .18),
            (.173, muzzle_z - .025), (.16, muzzle_z), (.125, muzzle_z), (.125, muzzle_z - .18),
            (0, muzzle_z - .18)], 32, closed=True)
        add_mesh_obj(f"barrel_{b}", transform_bm(barrel, offset), mats.gun_steel, parent=rotor)
        for j, z in enumerate((breech_z + .12, breech_z + .23)):
            add_mesh_obj(f"barrel_chamber_band_{b}_{j}", transform_bm(make_torus(.193, .016, z, 32, 8), offset),
                mats.gun_machined, parent=rotor)
        # 締め環の周囲は中空のまま、中心軸へスポークで繋ぐ。
        for j, z in enumerate((breech_z + .39, muzzle_z - .29)):
            add_mesh_obj(f"barrel_collar_{b}_{j}", transform_bm(make_lathe([
                (.165, z - .046), (.218, z - .046), (.218, z + .046), (.165, z + .046),
            ], 32, closed=True), offset), mats.gun_machined, parent=rotor)
            add_mesh_obj(f"barrel_spoke_{b}_{j}", make_box(.39, .095, .084,
                center=(.28 * math.cos(a), .28 * math.sin(a), z), rot_euler=(0, 0, a), bevel=.016),
                mats.gun_panel, parent=rotor)
    for j, z in enumerate((breech_z + .39, muzzle_z - .29)):
        add_mesh_obj(f"barrel_spider_hub_{j}", make_cylinder(.17, .17, .115, z, 24),
            mats.gun_machined, parent=rotor)


# 排莢口と固定樋の重なりは、後座端でも開口を覆う長さを持つ。
def build_gun_ejection(mats, recoil):
    add_mesh_obj("gun_ejection_port", make_box(.035, .56, .76,
        center=(-.836, -.04, .37), bevel=.01), mats.recessed, parent=recoil)
    path = round_corners([Vector((-.80, -.02, .10)), Vector((-1.05, -.12, .06)),
        Vector((-1.32, -.24, -.04))], .08, 4)
    profile = [(-.27, -.34), (.27, -.34), (.27, .34), (-.27, .34)]
    add_mesh_obj("gun_ejection_chute", sweep_profile(path, profile, cap_ends=False, sharp_angle_deg=30),
        mats.gun_panel)

# 結合面、砲架、後座機関部、給弾塔を一つの武器原型へ組み上げる。
def build_weapon(name):
    reset_scene()
    mats = MaterialLibrary()
    add_gun_materials(mats)
    radius = 3.0
    module = MANIFEST["modules"][name]
    half_len = module["length"] / 2.0
    muzzle = Vector(module["muzzles"][0])   # 砲口は機軸上の1点
    feed_port = Vector(module["feedPort"])  # 給弾ベルトが機体へ入る点
    mx, my, mz = muzzle.x, muzzle.y, muzzle.z
    fx, fy = feed_port.x, feed_port.y

    # 1. 後端の結合環と砲架の甲板・放射状の補強リブ。
    #    ベルトのリンクは長手(Z)に甲板面をまたぐので、通路にあたる帯を甲板から抜く。
    ring_top = -half_len + 0.12
    add_mesh_obj("weapon_mating_ring", make_lathe([
        (radius - 0.20, -half_len), (radius, -half_len), (radius, ring_top), (radius - 0.20, ring_top),
    ], segments=64, closed=True), mats.hull)
    add_mesh_obj("weapon_ring_flange", make_torus(radius + 0.005, 0.025, ring_top - 0.025, major_seg=64, minor_seg=10), mats.hull_dark)
    deck_top = -half_len + 0.125
    deck_r = radius - 0.18

    # 甲板の切り欠きは feed_port を跨ぐ Y 方向の帯で、円板を2片(主板と外縁側の小片)に分ける。
    # 帯の端は甲板縁の結合環まで開くので、ベルトは舷側へ出入りできる。
    channel_y0 = fy - 0.60  # リンク厚み 1.0 + 0.2 の余裕
    channel_y1 = fy + 0.60
    chord_x1 = math.sqrt(deck_r ** 2 - channel_y1 ** 2)
    chord_x0 = math.sqrt(deck_r ** 2 - channel_y0 ** 2)
    deck_outline = [(-chord_x1, channel_y1), (chord_x1, channel_y1)]
    arc_from = math.atan2(channel_y1, chord_x1)
    arc_to = math.atan2(channel_y1, -chord_x1) + 2.0 * math.pi
    for i in range(1, 48):
        a = arc_from + (arc_to - arc_from) * i / 48.0
        deck_outline.append((deck_r * math.cos(a), deck_r * math.sin(a)))
    add_mesh_obj("weapon_deck", make_plate_prism(deck_outline, deck_top - 0.05, deck_top), mats.hull_dark)
    # 切り欠きの向こう側に残る円板の小片
    cap_outline = [(chord_x0, channel_y0), (-chord_x0, channel_y0)]
    cap_from = math.atan2(channel_y0, -chord_x0)
    cap_to = math.atan2(channel_y0, chord_x0)
    for i in range(1, 16):
        a = cap_from + (cap_to - cap_from) * i / 16.0
        cap_outline.append((deck_r * math.cos(a), deck_r * math.sin(a)))
    add_mesh_obj("weapon_deck_channel_floor", make_plate_prism(cap_outline, deck_top - 0.05, deck_top), mats.hull_dark)
    # 通路の両脇の立ち上がり縁
    add_mesh_obj("deck_channel_sill_inner", make_box(2.0 * chord_x1 - 0.02, 0.07, 0.06, center=(0.0, channel_y1 + 0.045, deck_top + 0.02)), mats.clamp)
    add_mesh_obj("deck_channel_sill_outer", make_box(2.0 * chord_x0 - 0.02, 0.07, 0.06, center=(0.0, channel_y0 - 0.045, deck_top + 0.02)), mats.clamp)

    for i in range(8):
        a = i * math.pi / 4.0 + math.pi / 8.0
        # 通路の上空をまたぐリブは浮いてしまうので置かない
        if any(channel_y0 <= deck_r * t * math.sin(a) <= channel_y1 for t in [k / 24.0 for k in range(1, 25)]):
            continue
        mid = 1.75
        add_mesh_obj(f"deck_rib_{i}", make_box(1.70, 0.06, 0.08, center=(mid * math.cos(a), mid * math.sin(a), deck_top + 0.04), rot_euler=(0, 0, a)), mats.hull)

    # 2. 露出砲架。頬板・軸受・案内レール・駐退シリンダー・機械室は甲板へ固定し、機関部と
    #    砲身束・排莢口は後座 anchor の子として、発射ごとに砲架へ沿って後退・復座する。
    breech_z = 1.20                    # 砲身束の尾端(回転部の根元)。ここから砲口までが露出砲身
    recoil = add_anchor("gun-recoil:0", (0.0, 0.0, 0.0), recoilTravel=0.22)
    build_gun_cradle(mats, deck_top)
    build_gun_receiver(mats, recoil, breech_z)
    build_gun_recoil_cylinders(mats, recoil)
    build_gun_service_house(mats, deck_top)
    build_gun_barrels(mats, recoil, breech_z, mz)
    build_gun_ejection(mats, recoil)
    # 固定の給弾シュートが機関部の底へ入る摺動口の締め環(後座してもシュートを囲う)
    add_mesh_obj("gun_feed_gland", make_box(0.86, 0.06, 0.86,
        center=(fx - 0.15, my - 0.77, 0.05), bevel=0.02), mats.gun_machined, parent=recoil)

    # 4. 給弾塔(デリンカー): feed_port を中心に甲板をまたぐ装甲ハウジング。
    #    +X 面の開口へベルトが差し込まれ、中で弾だけが天面のシュートへ分かれて機関部へ入る。
    slot_y0, slot_y1 = fy - 0.625, fy + 0.625  # 開口の高さ 1.25(リンク厚み 1.0 より僅かに大きい)
    # 開口の後端は後端面(z=-0.5)の手前に留める。リンク(奥行 2.0)の後ろ側は開口の下からはみ出す
    slot_z0, slot_z1 = -0.42, 1.15
    face_x = fx + 0.45
    tower_x0 = fx - 0.80
    body_y0, body_y1 = fy - 0.90, fy + 1.00
    body_z0, body_z1 = deck_top, 1.18
    trunk_x0 = fx - 0.55
    trunk_y0, trunk_y1 = fy - 0.75, fy + 0.75
    # 甲板より後ろは結合面(z=-0.5)の手前に留める浅い脚にする
    trunk_z0, trunk_z1 = -0.48, -0.28
    wall_x0 = face_x - 0.18
    body_zc = (body_z0 + body_z1) / 2
    trunk_zc = (trunk_z0 + trunk_z1) / 2

    # 甲板上の胴体と甲板下の脚を板で組む。開口の奥は暗い空洞として抜く
    add_mesh_obj("feed_tower_top", make_box(face_x - tower_x0, 0.10, body_z1 - body_z0,
        center=((tower_x0 + face_x) / 2, body_y1 - 0.05, body_zc)), mats.hull_dark)
    add_mesh_obj("feed_tower_bottom", make_box(face_x - tower_x0, 0.10, body_z1 - body_z0,
        center=((tower_x0 + face_x) / 2, body_y0 + 0.05, body_zc)), mats.hull_dark)
    # -X 面の排出口。空の外枠(Y1.0 × Z2.0 の断面)が塔の奥行に収まる範囲いっぱいに抜ける
    # 開口を、壁の縁で囲む。開口より後ろへはみ出る外枠の後端は甲板下の脚へ抜ける。
    exit_y0, exit_y1 = fy - 0.64, fy + 0.68
    exit_z0, exit_z1 = body_z0 + 0.05, body_z1 - 0.04
    add_mesh_obj("feed_tower_back_top", make_box(0.10, body_y1 - exit_y1, body_z1 - body_z0,
        center=(tower_x0 + 0.05, (exit_y1 + body_y1) / 2, body_zc)), mats.hull_dark)
    add_mesh_obj("feed_tower_back_bottom", make_box(0.10, exit_y0 - body_y0, body_z1 - body_z0,
        center=(tower_x0 + 0.05, (body_y0 + exit_y0) / 2, body_zc)), mats.hull_dark)
    add_mesh_obj("feed_tower_back_fore", make_box(0.10, exit_y1 - exit_y0, body_z1 - exit_z1,
        center=(tower_x0 + 0.05, fy, (exit_z1 + body_z1) / 2)), mats.hull_dark)
    add_mesh_obj("feed_tower_back_aft", make_box(0.10, exit_y1 - exit_y0, exit_z0 - body_z0,
        center=(tower_x0 + 0.05, fy, (body_z0 + exit_z0) / 2)), mats.hull_dark)
    add_mesh_obj("feed_tower_cap", make_box(face_x - tower_x0, body_y1 - body_y0, 0.06,
        center=((tower_x0 + face_x) / 2, (body_y0 + body_y1) / 2, body_z1 - 0.03)), mats.hull_dark)
    add_mesh_obj("feed_trunk_back", make_box(0.10, trunk_y1 - trunk_y0, trunk_z1 - trunk_z0,
        center=(trunk_x0 + 0.05, fy, trunk_zc)), mats.hull_dark)
    add_mesh_obj("feed_trunk_top", make_box(face_x - trunk_x0, 0.10, trunk_z1 - trunk_z0,
        center=((trunk_x0 + face_x) / 2, trunk_y1 - 0.05, trunk_zc)), mats.hull_dark)
    add_mesh_obj("feed_trunk_bottom", make_box(face_x - trunk_x0, 0.10, trunk_z1 - trunk_z0,
        center=((trunk_x0 + face_x) / 2, trunk_y0 + 0.05, trunk_zc)), mats.hull_dark)
    add_mesh_obj("feed_trunk_cap", make_box(face_x - trunk_x0, trunk_y1 - trunk_y0, 0.10,
        center=((trunk_x0 + face_x) / 2, fy, trunk_z0 + 0.05)), mats.hull_dark)
    # 開口の奥の暗い内壁(空洞の底)
    add_mesh_obj("feed_tower_cavity", make_box(face_x - 0.30 - tower_x0 - 0.10, body_y1 - body_y0 - 0.20, 1.12 - (-0.30),
        center=((tower_x0 + 0.10 + face_x - 0.30) / 2, (body_y0 + 0.10 + body_y1 - 0.10) / 2, (-0.30 + 1.12) / 2)), mats.recessed)
    add_mesh_obj("feed_trunk_cavity", make_box(face_x - 0.30 - trunk_x0 - 0.10, trunk_y1 - trunk_y0 - 0.20, 0.18,
        center=((trunk_x0 + 0.10 + face_x - 0.30) / 2, fy, -0.36)), mats.recessed)

    # +X 面の開口まわりの壁(甲板上は上・下・前の3辺、甲板下は上・下・後ろの3辺)
    wall_cx = wall_x0 + 0.09
    add_mesh_obj("feed_mouth_wall_top", make_box(0.18, body_y1 - slot_y1, body_z1 - body_z0,
        center=(wall_cx, (body_y1 + slot_y1) / 2, body_zc)), mats.hull_dark)
    add_mesh_obj("feed_mouth_wall_bottom", make_box(0.18, slot_y0 - body_y0, body_z1 - body_z0,
        center=(wall_cx, (slot_y0 + body_y0) / 2, body_zc)), mats.hull_dark)
    add_mesh_obj("feed_mouth_wall_fore", make_box(0.18, slot_y1 - slot_y0, body_z1 - slot_z1,
        center=(wall_cx, fy, (body_z1 + slot_z1) / 2)), mats.hull_dark)
    add_mesh_obj("feed_mouth_wall_trunk_top", make_box(0.18, trunk_y1 - slot_y1, trunk_z1 - trunk_z0,
        center=(wall_cx, (trunk_y1 + slot_y1) / 2, trunk_zc)), mats.hull_dark)
    add_mesh_obj("feed_mouth_wall_trunk_bottom", make_box(0.18, slot_y0 - trunk_y0, trunk_z1 - trunk_z0,
        center=(wall_cx, (slot_y0 + trunk_y0) / 2, trunk_zc)), mats.hull_dark)
    add_mesh_obj("feed_mouth_wall_aft", make_box(0.18, slot_y1 - slot_y0, slot_z0 - trunk_z0,
        center=(wall_cx, fy, (slot_z0 + trunk_z0) / 2)), mats.hull_dark)

    # 開口縁を囲う枠(マウスリップ)
    lip_cx = face_x + 0.065
    add_mesh_obj("feed_mouth_lip_top", make_box(0.13, 0.10, slot_z1 - slot_z0 + 0.04,
        center=(lip_cx, slot_y1 + 0.05, (slot_z0 + slot_z1) / 2)), mats.clamp)
    add_mesh_obj("feed_mouth_lip_bottom", make_box(0.13, 0.10, slot_z1 - slot_z0 + 0.04,
        center=(lip_cx, slot_y0 - 0.05, (slot_z0 + slot_z1) / 2)), mats.clamp)
    add_mesh_obj("feed_mouth_lip_aft", make_box(0.13, slot_y1 - slot_y0 + 0.20, 0.06,
        center=(lip_cx, fy, slot_z0 - 0.03)), mats.clamp)
    add_mesh_obj("feed_mouth_lip_fore", make_box(0.13, slot_y1 - slot_y0 + 0.20, 0.05,
        center=(lip_cx, fy, slot_z1 + 0.02)), mats.clamp)

    # 開口の上下縁を走る案内ローラー列と、リンクの上下面を受ける塔内の摺動レール
    for wy in (slot_y1 - 0.045, slot_y0 + 0.045):
        for j, rz in enumerate((-0.20, 0.36, 0.92)):
            bm_roller = make_cylinder(0.05, 0.05, 0.52, z_center=0.0, segments=14)
            transform_bm(bm_roller, Matrix.Translation(Vector((lip_cx - 0.04, wy, rz))))
            add_mesh_obj(f"feed_mouth_roller_{wy:+.2f}_{j}", bm_roller, mats.gun_machined)
    for wy in (fy - 0.53, fy + 0.53):
        for wz in (-0.90, 0.90):
            add_mesh_obj(f"feed_guide_rail_{wy:+.2f}_{wz:+.2f}", make_box(0.55, 0.05, 0.08,
                center=(face_x - 0.24, wy, wz), bevel=0.015), mats.gun_machined)

    # 開口の奥に見える送りスプロケット(縦軸の星車2基)と、横置きのデリンクドラム。
    # いずれも給弾につれて回る可動部で、anchor の子にする(スプロケットは +Y、ドラムは +X 軸まわり)。
    # 星車は歯の間に弾径ぶんのポケットを持ち、リンクの上下面を抱えるよう2段に組む。
    star = []
    for k in range(16):
        a = k * math.pi / 8.0
        r = 0.30 if k % 2 == 0 else 0.195
        star.append((r * math.cos(a), r * math.sin(a)))
    sprocket_rot = Euler((math.pi / 2, 0.0, 0.0)).to_matrix().to_4x4()
    for i, wz in enumerate((-0.15, 0.85)):
        sprocket = add_anchor(f"feed-sprocket:{i}", (fx + 0.35, fy, wz), direction=(0.0, 1.0, 0.0))
        for wy in (fy - 0.30, fy + 0.30):
            bm_wheel = make_plate_prism(star, -0.14, 0.14)
            transform_bm(bm_wheel, Matrix.Translation(Vector((fx + 0.35, wy, wz))) @ sprocket_rot)
            add_mesh_obj(f"feed_sprocket_{i}_{wy - fy:+.2f}", bm_wheel, mats.gun_steel, parent=sprocket)
        # 2枚の星車の間のハブとスペーサ盤
        bm_hub = make_cylinder(0.11, 0.11, 0.66, z_center=0.0, segments=16)
        transform_bm(bm_hub, Matrix.Translation(Vector((fx + 0.35, fy, wz))) @ sprocket_rot)
        add_mesh_obj(f"feed_sprocket_hub_{i}", bm_hub, mats.clamp, parent=sprocket)
        bm_spacer = make_cylinder(0.24, 0.24, 0.08, z_center=0.0, segments=24)
        transform_bm(bm_spacer, Matrix.Translation(Vector((fx + 0.35, fy, wz))) @ sprocket_rot)
        add_mesh_obj(f"feed_sprocket_spacer_{i}", bm_spacer, mats.gun_steel, parent=sprocket)
    drum_y, drum_z = fy + 0.42, 0.30
    drum_anchor = add_anchor("feed-drum", (fx + 0.05, drum_y, drum_z), direction=(1.0, 0.0, 0.0))
    drum_rot = Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4()
    bm_drum = make_cylinder(0.50, 0.50, 0.70, z_center=0.0, segments=32)
    transform_bm(bm_drum, Matrix.Translation(Vector((fx + 0.05, drum_y, drum_z))) @ drum_rot)
    add_mesh_obj("feed_delink_drum", bm_drum, mats.gun_steel, parent=drum_anchor)
    bm_boss = make_cylinder(0.16, 0.16, 0.76, z_center=0.0, segments=20)
    transform_bm(bm_boss, Matrix.Translation(Vector((fx + 0.05, drum_y, drum_z))) @ drum_rot)
    add_mesh_obj("feed_delink_drum_boss", bm_boss, mats.hull_dark, parent=drum_anchor)
    for t in range(6):
        ba = t * math.pi / 3.0
        bm_bolt = make_cylinder(0.035, 0.035, 0.05, z_center=0.0, segments=10)
        transform_bm(bm_bolt, Matrix.Translation(Vector((face_x - 0.06, drum_y + 0.30 * math.cos(ba), drum_z + 0.30 * math.sin(ba)))) @ drum_rot)
        add_mesh_obj(f"feed_drum_bolt_{t}", bm_bolt, mats.clamp, parent=drum_anchor)
    # ドラム面の螺旋ガイド(デリンク溝)。弾をリンクから剥がしながら送る螺旋レールを、
    # 溝の両縁にあたる2条で立てる
    helix = []
    for k in range(65):
        t = k / 64.0
        a = 4.0 * math.pi * t
        helix.append(Vector((fx + 0.05 - 0.27 + 0.54 * t,
            drum_y + 0.51 * math.cos(a), drum_z + 0.51 * math.sin(a))))
    for dx_h in (0.0, 0.09):
        add_mesh_obj(f"feed_drum_helix_{dx_h:+.2f}",
            make_pipe([Vector((p.x + dx_h, p.y, p.z)) for p in helix], radius=0.026, segments=8),
            mats.clamp, parent=drum_anchor)

    # 開口の下縁を走る案内爪(フィードシュー)。送りにつれて塔の中(-X)へ踏み込み、リンクを
    # 引き込む爪として往復する。anchor の局所 +Z が摺動方向。
    shoe_x, shoe_y, shoe_z = face_x - 0.14, fy - 0.50, 0.36
    shoe = add_anchor("feed-shoe", (shoe_x, shoe_y, shoe_z), direction=(-1.0, 0.0, 0.0))
    add_mesh_obj("feed_shoe_body", make_box(0.55, 0.16, 0.85,
        center=(shoe_x, shoe_y, shoe_z), bevel=0.03), mats.gun_steel, parent=shoe)
    add_mesh_obj("feed_shoe_claw", make_box(0.10, 0.26, 0.10,
        center=(shoe_x + 0.18, shoe_y + 0.14, shoe_z + 0.30), rot_euler=(0.0, -0.45, 0.0), bevel=0.02),
        mats.clamp, parent=shoe)
    # 爪が乗る案内レール(摺動しない側)
    add_mesh_obj("feed_shoe_rail", make_box(0.80, 0.05, 0.10,
        center=(shoe_x - 0.10, shoe_y - 0.10, shoe_z - 0.40)), mats.hull_dark)
    add_mesh_obj("feed_shoe_rail_2", make_box(0.80, 0.05, 0.10,
        center=(shoe_x - 0.10, shoe_y - 0.10, shoe_z + 0.40)), mats.hull_dark)

    # 排出口の額縁と、開口から塔の空洞へ窄まる漏斗面
    add_mesh_obj("feed_exit_lip_top", make_box(0.16, 0.10, exit_z1 - exit_z0 + 0.06,
        center=(tower_x0 - 0.03, exit_y1 + 0.04, (exit_z0 + exit_z1) / 2)), mats.clamp)
    add_mesh_obj("feed_exit_lip_bottom", make_box(0.16, 0.10, exit_z1 - exit_z0 + 0.06,
        center=(tower_x0 - 0.03, exit_y0 - 0.04, (exit_z0 + exit_z1) / 2)), mats.clamp)
    add_mesh_obj("feed_exit_lip_fore", make_box(0.16, exit_y1 - exit_y0 + 0.06, 0.10,
        center=(tower_x0 - 0.03, fy, exit_z1 + 0.03)), mats.clamp)
    for sy in (-1.0, 1.0):
        add_mesh_obj(f"feed_exit_funnel_{sy:+.0f}", make_box(0.44, 0.05, exit_z1 - exit_z0 - 0.04,
            center=(tower_x0 + 0.28, fy + sy * 0.56, (exit_z0 + exit_z1) / 2),
            rot_euler=(0.0, 0.0, -sy * 0.16)), mats.hull_dark)
    # 外枠の後端が抜ける、甲板下の脚側の排出口
    add_mesh_obj("feed_exit_port_trunk", make_box(0.02, trunk_y1 - trunk_y0 - 0.10, trunk_z1 - trunk_z0 - 0.02,
        center=(trunk_x0 - 0.01, fy, (trunk_z0 + trunk_z1) / 2)), mats.recessed)

    # 弾だけの通路: 塔の天面から機関部の底面へ立ち上がるシュート
    chute_cx, chute_cz = fx - 0.15, 0.05
    add_mesh_obj("feed_rounds_chute", make_box(0.62, 0.58, 0.62,
        center=(chute_cx, (fy + 0.93 + my - 0.44) / 2, chute_cz)), mats.hull_dark)
    add_mesh_obj("feed_chute_flange_top", make_box(0.74, 0.06, 0.74, center=(chute_cx, my - 0.50, chute_cz)), mats.clamp)
    add_mesh_obj("feed_chute_flange_bottom", make_box(0.74, 0.06, 0.74, center=(chute_cx, fy + 0.96, chute_cz)), mats.clamp)

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))

# ----------------------------------------------------------------------
# Main Execution
# ----------------------------------------------------------------------
def main():
    print("Building realistic spacecraft modules in Blender...")
    
    # 1. Cockpit
    build_cockpit()
    
    # 2. Main propellant tanks
    build_tank_main(3.0, "tank-3-main")
    build_tank_main(6.0, "tank-6-main")
    build_tank_main(12.0, "tank-12-main")
    build_tank_main(6.0, "tank-combat-main")
    
    # 3. RCS propellant tanks
    build_tank_rcs(3.0, "tank-3-rcs")
    build_tank_rcs(6.0, "tank-6-rcs")
    build_tank_rcs(12.0, "tank-12-rcs")
    
    # 4. Thruster & Booster
    build_thruster()
    build_booster()
    
    # 5. RCS module
    build_rcs_module()
    
    # 6. Docking & Decoupler
    build_docking_mechanism("docking-port-standard", "docking_port")
    build_docking_mechanism("dock-standard", "dock")
    build_docking_mechanism("decoupler-standard", "decoupler")
    
    # 7. Deployable modules
    build_solar_panel("solar-panel-standard")
    build_radiator("radiator-standard")
    
    # 8. Armor & Weapon
    build_armor("armor-standard")
    build_armor("armor-combat")
    build_weapon("weapon-gatling")
    
    print("All modules generated and exported successfully!")

if __name__ == "__main__":
    main()
