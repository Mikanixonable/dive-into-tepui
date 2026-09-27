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
import random
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

def create_pbr_material(name, base_color, roughness=0.5, metallic=0.0, clearcoat=0.0, coat_roughness=0.03):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = base_color
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
        if clearcoat > 0.0:
            bsdf.inputs["Coat Weight"].default_value = clearcoat
            bsdf.inputs["Coat Roughness"].default_value = coat_roughness
    return mat

def make_tank_hull(length, radius=3.0, angular_segments=192):
    """微細な放射方向のゆらぎを加えた、閉じた高密度の円筒外殻を作る。"""
    bm = bmesh.new()
    half_len = length / 2.0
    axial_segments = max(60, round(length * 16.0))
    rng = random.Random(7319)
    rings = []
    for axial_index in range(axial_segments + 1):
        z = -half_len + length * axial_index / axial_segments
        end_ring = axial_index in (0, axial_segments)
        ring = []
        for angular_index in range(angular_segments):
            angle = 2.0 * math.pi * angular_index / angular_segments
            ripple = 0.0 if end_ring else rng.uniform(-0.0012, 0.0012)
            radial = radius + ripple
            ring.append(bm.verts.new((radial * math.cos(angle), radial * math.sin(angle), z)))
        rings.append(ring)
    for axial_index in range(axial_segments):
        lower, upper = rings[axial_index], rings[axial_index + 1]
        for angular_index in range(angular_segments):
            following = (angular_index + 1) % angular_segments
            bm.faces.new((lower[angular_index], lower[following], upper[following], upper[angular_index]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return shade_by_angle(bm, 60.0)

def create_emissive_material(name, color, strength=4.0):
    """自分で光る小さな部品(航法灯など)の材質。glTF の emissive へ焼かれる。"""
    mat = create_pbr_material(name, color, roughness=0.4, metallic=0.0)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Emission Color"].default_value = color
        bsdf.inputs["Emission Strength"].default_value = strength
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
        # 船体を覆う EVI 多層断熱カバーの布(箔より鈍い銀)
        self.evi = create_pbr_material("mat_evi", (0.70, 0.72, 0.76, 1.0), roughness=0.60, metallic=0.7)
        # ステンレス・インコネルの配管
        self.pipe = create_pbr_material("mat_pipe", (0.88, 0.90, 0.93, 1.0), roughness=0.30, metallic=1.0)
        # 配管の締め具・受け金具
        self.clamp = create_pbr_material("mat_clamp", (0.35, 0.40, 0.45, 1.0), roughness=0.35, metallic=1.0)
        # 主ノズルの銀色の延長ベルと、段差を拾う明るいチタンリブ
        self.nozzle_rib = create_pbr_material("mat_nozzle_rib", (0.52, 0.48, 0.44, 1.0), roughness=0.35, metallic=1.0)
        self.nozzle_titanium_rib = create_pbr_material("mat_nozzle_titanium_rib", (0.76, 0.79, 0.82, 1.0), roughness=0.26, metallic=1.0)
        self.nozzle_extension = create_pbr_material("mat_nozzle_extension", (0.64, 0.68, 0.72, 1.0), roughness=0.27, metallic=0.98)
        self.nozzle_copper = create_pbr_material("mat_nozzle_copper", (0.66, 0.25, 0.105, 1.0), roughness=0.29, metallic=0.9)
        # 電装ケース、セラミック被覆部品、ハーネス
        self.electronics_brown = create_pbr_material("mat_electronics_brown", (0.34, 0.20, 0.12, 1.0), roughness=0.52, metallic=0.35)
        self.electronics_white = create_pbr_material("mat_electronics_white", (0.82, 0.84, 0.85, 1.0), roughness=0.48, metallic=0.25)
        self.cable = create_pbr_material("mat_cable", (0.10, 0.12, 0.15, 1.0), roughness=0.72, metallic=0.15)
        self.rivet = create_pbr_material("mat_rivet", (0.57, 0.61, 0.65, 1.0), roughness=0.32, metallic=1.0)
        # 石英の窓
        self.window = create_pbr_material("mat_window", (0.04, 0.10, 0.18, 1.0), roughness=0.10, metallic=0.0)
        # チタンの窓枠
        self.window_frame = create_pbr_material("mat_window_frame", (0.22, 0.24, 0.28, 1.0), roughness=0.35, metallic=1.0)
        # チタンの球形推進剤タンク
        self.tank_rcs = create_pbr_material("mat_tank_rcs", (0.32, 0.52, 0.62, 1.0), roughness=0.38, metallic=1.0)
        # RCS 球タンクの銀箔外装と、地上設備を思わせる赤い外部架構
        self.rcs_foil = create_pbr_material("mat_rcs_foil", (0.88, 0.90, 0.93, 1.0), roughness=0.22, metallic=0.82)
        self.rcs_frame = create_pbr_material("mat_rcs_frame", (0.54, 0.1125, 0.086, 1.0), roughness=0.27, metallic=0.20)
        self.rcs_support = create_pbr_material("mat_rcs_support", (0.90, 0.92, 0.94, 1.0), roughness=0.38, metallic=0.22)
        self.rcs_silver_pipe = create_pbr_material("mat_rcs_silver_pipe", (0.84, 0.86, 0.89, 1.0), roughness=0.26, metallic=0.38)
        self.rcs_white_pipe = create_pbr_material("mat_rcs_white_pipe", (0.92, 0.94, 0.96, 1.0), roughness=0.34, metallic=0.30)
        self.rcs_logo_blue = create_pbr_material("mat_rcs_logo_blue", (0.045, 0.23, 0.70, 1.0), roughness=0.34, metallic=0.06)
        self.rcs_logo_red = create_pbr_material("mat_rcs_logo_red", (0.78, 0.045, 0.025, 1.0), roughness=0.32, metallic=0.2)
        self.rcs_hazard_yellow = create_pbr_material("mat_rcs_hazard_yellow", (0.98, 0.62, 0.035, 1.0), roughness=0.38, metallic=0.12)
        self.rcs_hazard_black = create_pbr_material("mat_rcs_hazard_black", (0.035, 0.04, 0.045, 1.0), roughness=0.46, metallic=0.22)
        self.rcs_instrument = create_pbr_material("mat_rcs_instrument", (0.28, 0.25, 0.12, 1.0), roughness=0.55, metallic=0.48)
        self.rcs_wire_red = create_pbr_material("mat_rcs_wire_red", (0.80, 0.045, 0.025, 1.0), roughness=0.4, metallic=0.05)
        self.rcs_wire_yellow = create_pbr_material("mat_rcs_wire_yellow", (0.96, 0.58, 0.03, 1.0), roughness=0.42, metallic=0.05)
        self.rcs_wire_white = create_pbr_material("mat_rcs_wire_white", (0.90, 0.92, 0.94, 1.0), roughness=0.45, metallic=0.12)
        # 外装の白黒塗装。白の色は保ち、光沢だけコックピットのアイボリー塗膜に揃える。
        self.tank_paint_white = create_pbr_material("mat_tank_paint_white", (0.88, 0.90, 0.92, 1.0), roughness=0.40, metallic=0.02)
        self.tank_paint_black = create_pbr_material("mat_tank_paint_black", (0.05, 0.05, 0.06, 1.0), roughness=0.40, metallic=0.02)
        self.tank_seam = create_pbr_material("mat_tank_seam", (0.68, 0.70, 0.72, 1.0), roughness=0.50, metallic=0.05)
        self.tank_recess = create_pbr_material("mat_tank_recess", (0.16, 0.17, 0.18, 1.0), roughness=0.72, metallic=0.08)
        self.tank_fastener = create_pbr_material("mat_tank_fastener", (0.48, 0.50, 0.51, 1.0), roughness=0.42, metallic=0.35)
        self.tank_brass = create_pbr_material("mat_tank_brass", (0.48, 0.39, 0.25, 1.0), roughness=0.62, metallic=0.32)
        # トラス材
        self.truss = create_pbr_material("mat_truss", (0.68, 0.72, 0.78, 1.0), roughness=0.35, metallic=1.0)
        # 炭素フェノールのアブレータ
        self.heatshield = create_pbr_material("mat_heatshield", (0.16, 0.12, 0.08, 1.0), roughness=0.90, metallic=0.0)
        # 結合機構の環
        self.cbm_ring = create_pbr_material("mat_cbm_ring", (0.76, 0.79, 0.84, 1.0), roughness=0.28, metallic=1.0)
        # 建造ドックの識別色
        self.dock = create_pbr_material("mat_dock", (0.84, 0.55, 0.22, 1.0), roughness=0.38, metallic=1.0)
        # ガラス越しに見える暗い濃青の太陽電池セル。低 roughness で鋭い反射を返す
        self.solar = create_pbr_material("mat_solar", (0.002, 0.005, 0.014, 1.0), roughness=0.035, metallic=0.06, clearcoat=0.75, coat_roughness=0.02)
        # セル区画ごとの明暗ばらつき
        self.solar_shades = [
            create_pbr_material(
                f"mat_solar_shade_{k}",
                (0.002 * f, 0.005 * f, 0.014 * f, 1.0), roughness=0.035, metallic=0.06, clearcoat=0.75, coat_roughness=0.02)
            for k, f in enumerate((0.82, 0.9, 0.96, 1.0, 1.08, 1.16))
        ]
        self.solar_rust_shades = [
            create_pbr_material(
                f"mat_solar_rust_shade_{k}",
                (0.050 * f, 0.033 * f, 0.037 * f, 1.0), roughness=0.045, metallic=0.04, clearcoat=0.75, coat_roughness=0.02)
            for k, f in enumerate((0.86, 0.94, 1.0, 1.08, 1.16))
        ]
        # セル帯のあいだに見えるバス帯と、翼裏の褐色基板・横縞
        self.solar_bus = create_pbr_material("mat_solar_bus", (0.004, 0.009, 0.020, 1.0), roughness=0.12, metallic=0.18)
        self.solar_trace = create_pbr_material("mat_solar_trace", (0.18, 0.21, 0.24, 1.0), roughness=0.28, metallic=0.62)
        self.solar_backing = create_pbr_material("mat_solar_backing", (0.065, 0.038, 0.020, 1.0), roughness=0.68, metallic=0.08)
        self.solar_back_stripe = create_pbr_material("mat_solar_back_stripe", (0.036, 0.022, 0.012, 1.0), roughness=0.74, metallic=0.05)
        # 翼裏の白い骨格と、灰色の小型アクチュエーター
        self.solar_lattice = create_pbr_material("mat_solar_lattice", (0.88, 0.90, 0.92, 1.0), roughness=0.28, metallic=0.22)
        self.solar_actuator = create_pbr_material("mat_solar_actuator", (0.34, 0.38, 0.42, 1.0), roughness=0.34, metallic=0.72)
        # 翼端の航法灯(左舷の赤・右舷の緑)
        self.nav_red = create_emissive_material("mat_nav_red", (0.90, 0.05, 0.03, 1.0))
        self.nav_green = create_emissive_material("mat_nav_green", (0.04, 0.75, 0.18, 1.0))
        # 高放射率の白い放熱塗装
        self.radiator = create_pbr_material("mat_radiator", (0.88, 0.90, 0.92, 1.0), roughness=0.85, metallic=0.0)
        # 砲身・機関部の黒染め鋼
        self.gun_steel = create_pbr_material("mat_gun_steel", (0.10, 0.11, 0.12, 1.0), roughness=0.38, metallic=1.0)

class CockpitMaterialLibrary:
    def __init__(self):
        # 焼き物のような鈍い光沢を持つ、コックピットのエボナイト塗膜とアイボリー塗膜。
        self.ebonite = create_pbr_material("mat_cockpit_ebonite", (0.035, 0.040, 0.048, 1.0), roughness=0.34, metallic=0.02)
        self.ivory = create_pbr_material("mat_cockpit_ivory", (0.79, 0.75, 0.65, 1.0), roughness=0.40, metallic=0.02)
        self.recess = create_pbr_material("mat_cockpit_recess", (0.014, 0.018, 0.024, 1.0), roughness=0.46, metallic=0.0)
        self.red = create_pbr_material("mat_cockpit_red", (0.62, 0.055, 0.040, 1.0), roughness=0.42, metallic=0.02)
        self.fastener = create_pbr_material("mat_cockpit_fastener", (0.43, 0.42, 0.39, 1.0), roughness=0.32, metallic=0.22)

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
        for m in (material if isinstance(material, (list, tuple)) else (material,)):
            obj.data.materials.append(m)
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

def make_spheres(centers, radius, u_seg=8, v_seg=6):
    """同径の小球を1つのメッシュへまとめる。リベットなど反復する小部品向け。"""
    bm = bmesh.new()
    for center in centers:
        bmesh.ops.create_uvsphere(
            bm,
            u_segments=u_seg,
            v_segments=v_seg,
            radius=radius,
            matrix=Matrix.Translation(Vector(center)),
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
# 1. Cockpit Module (cockpit-standard: length 9m, aft diameter 6m, forward diameter 3m)
# ----------------------------------------------------------------------
def cockpit_profile_radius(profile, z):
    """manifest の船殻輪郭から断面の基準半径 [m] を線形補間する。"""
    for previous, current in zip(profile, profile[1:]):
        if z <= current["z"]:
            fraction = (z - previous["z"]) / (current["z"] - previous["z"])
            return previous["radius"] + (current["radius"] - previous["radius"]) * fraction
    return profile[-1]["radius"]

def cockpit_surface_radius(profile, indent_fraction, z, theta):
    """上下にずらした2円の和から、角度thetaにおける長手溝付き断面の外周を返す。"""
    radius = cockpit_profile_radius(profile, z)
    offset = radius * indent_fraction
    circle_radius = radius - offset
    return offset * abs(math.sin(theta)) + math.sqrt(max(0.0, circle_radius ** 2 - offset ** 2 * math.cos(theta) ** 2))

def wrapped_angle_difference(a, b):
    return math.atan2(math.sin(a - b), math.cos(a - b))

def cockpit_short_recess(z, theta, radius):
    """船殻表面へ短冊状の浅い凹みを刻み、継ぎ目と重ならない暗部も返す。"""
    period = 0.64
    column_count = 32
    step = 2.0 * math.pi / column_count
    column = int(round(theta / step)) % column_count
    center_theta = column * step
    delta_theta = abs(wrapped_angle_difference(theta, center_theta))
    phase = (column % 2) * period * 0.5
    delta_z = (z + 4.15 + phase + period * 0.5) % period - period * 0.5
    distance = max(abs(delta_z) - 0.14, delta_theta * radius - 0.055)
    slot = 0.042 * max(0.0, min(1.0, (0.030 - distance) / 0.050))

    joint_z = min(abs(z - seam) for seam in (-3.45, -1.25, 0.5, 2.35, 3.85))
    axial_joint = 0.022 * max(0.0, min(1.0, (0.040 - joint_z) / 0.032))
    joint_angles = tuple(math.radians(degrees) for degrees in (22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5))
    longitudinal_joint = min(abs(wrapped_angle_difference(theta, seam)) for seam in joint_angles) * radius
    longitudinal_joint = 0.015 * max(0.0, min(1.0, (0.026 - longitudinal_joint) / 0.018))
    return max(slot, axial_joint, longitudinal_joint), slot

def cockpit_hull_mesh(profile, indent_fraction):
    """短冊凹み・板継ぎ目を断面メッシュ自体へ刻んだ、黒/アイボリー複材の閉じた船殻を作る。"""
    bm = bmesh.new()
    axial_steps = int(round((profile[-1]["z"] - profile[0]["z"]) / 0.04))
    angular_steps = 288
    rings = []
    for axial_index in range(axial_steps + 1):
        z = profile[0]["z"] + (profile[-1]["z"] - profile[0]["z"]) * axial_index / axial_steps
        ring = []
        for angular_index in range(angular_steps):
            theta = 2.0 * math.pi * angular_index / angular_steps
            radius = cockpit_surface_radius(profile, indent_fraction, z, theta)
            recess, _ = cockpit_short_recess(z, theta, radius)
            surface_radius = max(0.0, radius - recess)
            ring.append(bm.verts.new((surface_radius * math.cos(theta), surface_radius * math.sin(theta), z)))
        rings.append(ring)

    for axial_index in range(axial_steps):
        for angular_index in range(angular_steps):
            next_angle = (angular_index + 1) % angular_steps
            face = bm.faces.new((rings[axial_index][angular_index], rings[axial_index][next_angle],
                                 rings[axial_index + 1][next_angle], rings[axial_index + 1][angular_index]))
            center = face.calc_center_median()
            theta = math.atan2(center.y, center.x)
            radius = cockpit_surface_radius(profile, indent_fraction, center.z, theta)
            recess, slot = cockpit_short_recess(center.z, theta, radius)
            if recess > 0.010 or slot > 0.010:
                face.material_index = 2
            elif center.z < -3.48:
                face.material_index = 1

    for end_index, z in ((0, profile[0]["z"]), (-1, profile[-1]["z"])):
        center = bm.verts.new((0.0, 0.0, z))
        ring = rings[end_index]
        for angular_index in range(angular_steps):
            bm.faces.new((center, ring[angular_index], ring[(angular_index + 1) % angular_steps]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return shade_by_angle(bm, 42.0)

def add_cockpit_surface_patch(name, profile, indent_fraction, z_center, height, theta_center, width,
                              radial_offset, material, axial_segments=6, angular_segments=8):
    """長手断面の曲面に沿った薄いパネル/マーキングを作る。width は船殻に沿う実寸[m]。"""
    radius = cockpit_surface_radius(profile, indent_fraction, z_center, theta_center)
    theta_half = width / (2.0 * max(radius, 0.1))
    bm = bmesh.new()
    grid = []
    for axial_index in range(axial_segments + 1):
        z = z_center - height / 2.0 + height * axial_index / axial_segments
        row = []
        for angular_index in range(angular_segments + 1):
            theta = theta_center - theta_half + 2.0 * theta_half * angular_index / angular_segments
            surface_radius = cockpit_surface_radius(profile, indent_fraction, z, theta) + radial_offset
            row.append(bm.verts.new((surface_radius * math.cos(theta), surface_radius * math.sin(theta), z)))
        grid.append(row)
    for axial_index in range(axial_segments):
        for angular_index in range(angular_segments):
            bm.faces.new((grid[axial_index][angular_index], grid[axial_index][angular_index + 1],
                          grid[axial_index + 1][angular_index + 1], grid[axial_index + 1][angular_index]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return add_mesh_obj(name, bm, material)

def add_cockpit_ring_patch(name, profile, indent_fraction, z_center, width, radial_offset, material, angular_steps=192):
    """非円形断面に沿った全周バンドを作る。"""
    bm = bmesh.new()
    rows = []
    for z in (z_center - width / 2.0, z_center + width / 2.0):
        rows.append([
            bm.verts.new(((cockpit_surface_radius(profile, indent_fraction, z, 2.0 * math.pi * index / angular_steps)
                           + radial_offset) * math.cos(2.0 * math.pi * index / angular_steps),
                          (cockpit_surface_radius(profile, indent_fraction, z, 2.0 * math.pi * index / angular_steps)
                           + radial_offset) * math.sin(2.0 * math.pi * index / angular_steps), z))
            for index in range(angular_steps)
        ])
    for index in range(angular_steps):
        next_index = (index + 1) % angular_steps
        bm.faces.new((rows[0][index], rows[0][next_index], rows[1][next_index], rows[1][index]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return add_mesh_obj(name, bm, material)

def build_cockpit():
    reset_scene()
    cockpit_mats = CockpitMaterialLibrary()
    definition = MANIFEST["modules"]["cockpit-standard"]
    profile = MANIFEST["cockpitHull"]["profile"]
    indent_fraction = MANIFEST["cockpitHull"]["sectionIndentFraction"]
    aft_z, fore_z = profile[0]["z"], profile[-1]["z"]

    # 共通カタログ輪郭を使い、2つの対向円で左右に溝が入る断面を描く。
    add_mesh_obj("cockpit_hull", cockpit_hull_mesh(profile, indent_fraction),
                 [cockpit_mats.ebonite, cockpit_mats.ivory, cockpit_mats.recess])

    # 後部のアイボリー帯と、その前縁に巻いた細い赤い識別線。
    add_cockpit_ring_patch("cockpit_red_aft_mark", profile, indent_fraction, -3.53, 0.055, 0.028, cockpit_mats.red)
    add_cockpit_surface_patch("cockpit_ivory_centerline", profile, indent_fraction,
                              0.0, 8.62, math.pi / 2.0, 0.16, 0.028, cockpit_mats.ivory, 108, 4)
    # 前端の接続縁も閉じた薄いリングで仕上げ、黒い前面は窓のない板面にする。
    add_cockpit_ring_patch("cockpit_forward_rim", profile, indent_fraction, 4.35, 0.065, 0.026, cockpit_mats.ivory)

    # 側面に閉じたハッチを2枚ずつ配置し、両舷で左右対称にする。
    for side, theta in (("port", 0.0), ("starboard", math.pi)):
        for hatch_index, z in enumerate((-1.15, 1.95)):
            add_cockpit_surface_patch(f"cockpit_side_hatch_recess_{side}_{hatch_index}", profile, indent_fraction,
                                      z, 0.96, theta, 0.82, 0.018, cockpit_mats.recess)
            add_cockpit_surface_patch(f"cockpit_side_hatch_door_{side}_{hatch_index}", profile, indent_fraction,
                                      z, 0.82, theta, 0.70, 0.034, cockpit_mats.ivory)
            # 赤い警告枠をハッチ前縁だけに入れる。
            side_radius = cockpit_surface_radius(profile, indent_fraction, z, theta)
            edge_theta = theta + (0.29 / side_radius) * (-1 if side == "port" else 1)
            add_cockpit_surface_patch(f"cockpit_side_hatch_red_frame_{side}_{hatch_index}", profile, indent_fraction,
                                      z, 0.70, edge_theta, 0.045, 0.050, cockpit_mats.red, 6, 2)
            latch_theta = theta + (0.22 / side_radius) * (1 if side == "port" else -1)
            add_cockpit_surface_patch(f"cockpit_side_hatch_latch_{side}_{hatch_index}", profile, indent_fraction,
                                      z, 0.18, latch_theta, 0.052, 0.048, cockpit_mats.fastener, 2, 2)

            half_theta = 0.34 / side_radius
            for corner in range(4):
                corner_theta = theta + (-half_theta if corner % 2 == 0 else half_theta)
                corner_z = z + (-0.37 if corner < 2 else 0.37)
                point_radius = cockpit_surface_radius(profile, indent_fraction, corner_z, corner_theta) + 0.034
                bm_rivet = make_sphere(0.020, center=(point_radius * math.cos(corner_theta),
                                                      point_radius * math.sin(corner_theta), corner_z),
                                       u_seg=10, v_seg=6)
                add_mesh_obj(f"cockpit_side_hatch_rivet_{side}_{hatch_index}_{corner}", bm_rivet,
                             cockpit_mats.fastener)

    # 端板継ぎ目の位置へ小さな締結リベットを揃える。凹みや板面は接触形状には加えない。
    for seam_index, z in enumerate((-3.45, -1.25, 0.5, 2.35, 3.85)):
        for bolt_index in range(12):
            theta = 2.0 * math.pi * bolt_index / 12.0
            radius = cockpit_surface_radius(profile, indent_fraction, z, theta) + 0.026
            bm_rivet = make_sphere(0.018, center=(radius * math.cos(theta), radius * math.sin(theta), z),
                                   u_seg=8, v_seg=6)
            add_mesh_obj(f"cockpit_panel_rivet_{seam_index}_{bolt_index}", bm_rivet, cockpit_mats.fastener)

    export_glb(os.path.join(OUT_DIR, "cockpit-standard.glb"))

# ----------------------------------------------------------------------
# 2. Main Propellant Tanks (tank-3-main, tank-6-main, tank-12-main)
# ----------------------------------------------------------------------
TANK_ROLL_SECTOR_COUNT = 12

def tank_roll_pattern_bounds(length):
    """端部の市松帯・長手帯と中央黒帯の位置を返す。"""
    half_len = length / 2.0
    end_margin = 0.15
    checker_row_height = min(0.75, max(0.30, 0.085 * length))
    roll_bar_height = min(1.60, max(0.55, 0.16 * length))
    stripe_half_height = min(0.25, max(0.08, 0.025 * length)) * 0.5
    top = half_len - end_margin
    checker_mid = top - checker_row_height
    roll_top = top - 2.0 * checker_row_height
    roll_bottom = roll_top - roll_bar_height
    return {
        "top": top,
        "checker_mid": checker_mid,
        "checker_row_height": checker_row_height,
        "roll_top": roll_top,
        "roll_bottom": roll_bottom,
        "stripe_half_height": stripe_half_height,
    }

def paint_roll_pattern(bm, length):
    """円筒側面へ端部の市松帯・交互の長手帯・中央黒帯を割り当てる。"""
    sector_arc = 2.0 * math.pi / TANK_ROLL_SECTOR_COUNT
    bounds = tank_roll_pattern_bounds(length)
    for z in (bounds["top"], bounds["checker_mid"], bounds["roll_top"], bounds["roll_bottom"],
              bounds["stripe_half_height"], -bounds["stripe_half_height"]):
        bmesh.ops.bisect_plane(
            bm,
            geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
            plane_co=(0.0, 0.0, z),
            plane_no=(0.0, 0.0, 1.0),
        )
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for face in bm.faces:
        if abs(face.normal.z) > 0.5:
            continue
        center = face.calc_center_median()
        sector = int((math.atan2(center.y, center.x) + math.pi) / sector_arc) % TANK_ROLL_SECTOR_COUNT
        if bounds["roll_top"] < center.z < bounds["top"]:
            row = 0 if center.z > bounds["checker_mid"] else 1
            if (sector + row) % 2 == 0:
                face.material_index = 1
        elif bounds["roll_bottom"] < center.z <= bounds["roll_top"]:
            if sector % 2 == 0:
                face.material_index = 1
        elif abs(center.z) < bounds["stripe_half_height"]:
            face.material_index = 1

def rounded_panel_outline(width, height, corner_radius, corner_steps=5):
    """平面の角丸長方形を、円筒面へ写す順序で点列化する。"""
    radius = min(corner_radius, width * 0.49, height * 0.49)
    half_width, half_height = width / 2.0, height / 2.0
    corners = (
        (half_width - radius, half_height - radius, 0.0),
        (-half_width + radius, half_height - radius, 90.0),
        (-half_width + radius, -half_height + radius, 180.0),
        (half_width - radius, -half_height + radius, 270.0),
    )
    points = []
    for center_u, center_z, start_degrees in corners:
        for step in range(corner_steps):
            angle = math.radians(start_degrees + 90.0 * step / (corner_steps - 1))
            points.append((center_u + radius * math.cos(angle), center_z + radius * math.sin(angle)))
    return points

def append_curved_panel(bm, center_angle, center_z, width, height, radius, layers,
                        ring_materials, fill_material, corner_radius=0.06):
    """角丸の板・浅い溝を、半径を保つ同心ループで円筒へ沿わせる。"""
    rings = []
    for scale, radial_offset in layers:
        outline = rounded_panel_outline(width * scale, height * scale, corner_radius * scale)
        ring = []
        for arc_offset, axial_offset in outline:
            angle = center_angle + arc_offset / radius
            radial = radius + radial_offset
            ring.append(bm.verts.new((radial * math.cos(angle), radial * math.sin(angle), center_z + axial_offset)))
        rings.append(ring)
    for ring_index, (outer, inner) in enumerate(zip(rings, rings[1:])):
        material_index = ring_materials[ring_index]
        for index in range(len(outer)):
            following = (index + 1) % len(outer)
            face = bm.faces.new((outer[index], outer[following], inner[following], inner[index]))
            face.material_index = material_index
    last_ring = rings[-1]
    center_radial = radius + layers[-1][1]
    center = bm.verts.new((center_radial * math.cos(center_angle), center_radial * math.sin(center_angle), center_z))
    for index in range(len(last_ring)):
        following = (index + 1) % len(last_ring)
        face = bm.faces.new((last_ring[index], last_ring[following], center))
        face.material_index = fill_material

def append_surface_hole(bm, angle, axial, radius, hole_radius, material_index, depth=0.006):
    """曲面にほぼ面一で置く暗い丸穴を追加する。"""
    normal = Vector((math.cos(angle), math.sin(angle), 0.0))
    center = Vector((radius * normal.x, radius * normal.y, axial))
    rotation = normal.to_track_quat("Z", "Y").to_matrix().to_4x4()
    previous_faces = set(bm.faces)
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=16,
        radius1=hole_radius, radius2=hole_radius, depth=depth,
        matrix=Matrix.Translation(center) @ rotation,
    )
    for face in set(bm.faces) - previous_faces:
        face.material_index = material_index

def append_raised_tank_panel(bm, angle, axial, width, height, radius, white_index):
    layers = ((1.0, 0.002), (0.96, 0.010), (0.88, 0.017), (0.66, 0.019), (0.34, 0.019), (0.02, 0.019))
    append_curved_panel(bm, angle, axial, width, height, radius, layers,
                        (white_index,) * (len(layers) - 1), white_index,
                        corner_radius=min(0.085, min(width, height) * 0.22))

def append_recessed_tank_panel(bm, angle, axial, width, height, radius, white_index, seam_index):
    layers = ((1.0, 0.006), (0.98, 0.001), (0.91, 0.0005), (0.70, 0.0005), (0.35, 0.0005), (0.02, 0.0005))
    append_curved_panel(bm, angle, axial, width, height, radius, layers,
                        (seam_index, seam_index, white_index, white_index, white_index), white_index,
                        corner_radius=min(0.12, min(width, height) * 0.20))

def add_tank_surface_details(mats, length, bounds):
    """前方塗装と干渉しない範囲へ、継ぎ目・浅い溝・大きさの異なる板を配置する。"""
    radius = 3.0
    half_len = length / 2.0
    materials = (mats.tank_paint_white, mats.tank_seam, mats.tank_brass, mats.tank_recess)
    white_index, seam_index, brass_index, recess_index = range(len(materials))
    details = bmesh.new()
    groove_angle = math.pi
    groove_center_z = -0.06 * length
    groove_width = 1.38
    groove_height = 0.39 * length
    append_recessed_tank_panel(details, groove_angle, groove_center_z, groove_width, groove_height,
                               radius, white_index, seam_index)

    # 前方の黒い市松セル上へ、塗装色を保った小さな白い識別板を置く。
    sector_count = TANK_ROLL_SECTOR_COUNT
    white_patch_sector = 0
    white_patch_angle = -math.pi + (white_patch_sector + 0.5) * 2.0 * math.pi / sector_count
    white_patch_z = bounds["top"] - 0.45 * bounds["checker_row_height"]
    append_raised_tank_panel(details, white_patch_angle, white_patch_z, 0.42, 0.28,
                             radius, white_index)

    # 薄い角丸のハッチを不規則な間隔で並べる。送り線と外付け COPV の取付角度を避ける。
    rng = random.Random(24091 + round(length * 100))
    panel_count = max(5, round(length * 1.65))
    shapes = ((0.34, 0.31), (0.43, 0.48), (0.58, 0.36), (0.40, 0.72),
              (0.82, 0.52), (0.32, 0.27), (0.54, 0.82), (0.68, 0.42))
    selected = []
    candidate_limit = panel_count * 80
    z_min = -half_len + 0.46
    z_max = bounds["roll_bottom"] - 0.24
    copv_z = -half_len * 0.4
    copv_angles = (math.radians(120), math.radians(240))
    for _ in range(candidate_limit):
        if len(selected) >= panel_count:
            break
        width, height = shapes[rng.randrange(len(shapes))]
        angle = rng.uniform(-math.pi, math.pi)
        axial = rng.uniform(z_min, z_max)
        angular_distance = abs((angle + math.pi) % (2.0 * math.pi) - math.pi)
        if angular_distance < (width * 0.5 + 0.15) / radius:
            continue
        if (abs((angle - groove_angle + math.pi) % (2.0 * math.pi) - math.pi) * radius
                < (groove_width + width) * 0.5 + 0.16
                and abs(axial - groove_center_z) < (groove_height + height) * 0.5 + 0.16):
            continue
        if any(abs((angle - copv_angle + math.pi) % (2.0 * math.pi) - math.pi) < 0.24
               and abs(axial - copv_z) < 0.48 for copv_angle in copv_angles):
            continue
        if any(abs((angle - old_angle + math.pi) % (2.0 * math.pi) - math.pi) * radius
               < (width + old_width) * 0.5 + 0.16
               and abs(axial - old_axial) < (height + old_height) * 0.5 + 0.16
               for old_angle, old_axial, old_width, old_height in selected):
            continue
        selected.append((angle, axial, width, height))

    for panel_index, (angle, axial, width, height) in enumerate(selected):
        if panel_index % 4 == 2:
            append_recessed_tank_panel(details, angle, axial, width, height, radius, white_index, seam_index)
        else:
            append_raised_tank_panel(details, angle, axial, width, height, radius, white_index)
        # 一部のパネルには浅い横スロット、または対になったグレーの締結穴を付ける。
        if panel_index % 3 != 1:
            slot_width = min(0.25, width * 0.46)
            slot_height = 0.045
            slot_layers = ((1.0, 0.004), (0.92, 0.006), (0.75, 0.006), (0.02, 0.006))
            append_curved_panel(details, angle, axial + height * 0.25, slot_width, slot_height, radius,
                                slot_layers, (seam_index, recess_index, recess_index), recess_index,
                                corner_radius=0.02)
        if panel_index % 2 == 0:
            hole_offset = width * 0.40 / radius
            hole_z = axial - height * 0.30
            append_surface_hole(details, angle - hole_offset, hole_z, radius + 0.003, 0.027, recess_index)
            append_surface_hole(details, angle + hole_offset, hole_z, radius + 0.003, 0.027, recess_index)

    # 真鍮色は艶を抑えた小板に限り、黒いセル上の一枚と、長尺型だけ追加の一枚を置く。
    brass_angle = -math.pi + (2.5 * 2.0 * math.pi / sector_count)
    brass_plates = [(brass_angle, white_patch_z, 0.34, 0.26)]
    if length >= 6.0:
        brass_plates.append((2.82, -0.27 * length, 0.48, 0.34))
    if length >= 12.0:
        brass_plates.append((4.82, 0.17 * length, 0.42, 0.31))
    brass_layers = ((1.0, 0.003), (0.95, 0.011), (0.86, 0.015), (0.60, 0.016), (0.25, 0.016), (0.02, 0.016))
    for angle, axial, width, height in brass_plates:
        append_curved_panel(details, angle, axial, width, height, radius, brass_layers,
                            (brass_index,) * (len(brass_layers) - 1), brass_index,
                            corner_radius=0.035)
        for u_sign in (-1.0, 1.0):
            for z_sign in (-1.0, 1.0):
                append_surface_hole(details, angle + u_sign * width * 0.36 / radius,
                                    axial + z_sign * height * 0.30, radius + 0.004,
                                    0.026, recess_index)

    if details.verts:
        bmesh.ops.recalc_face_normals(details, faces=details.faces)
        add_mesh_obj("tank_surface_panels", details, materials)

    # 長手方向の浅い補強線と、周方向の塗装継ぎ目。どちらも白塗装に近い淡い灰色。
    for index in range(8):
        angle = 2.0 * math.pi * index / 8.0 + math.pi / 8.0
        radial = radius + 0.004
        path = [Vector((radial * math.cos(angle), radial * math.sin(angle), -half_len + 0.12)),
                Vector((radial * math.cos(angle), radial * math.sin(angle), half_len - 0.12))]
        add_mesh_obj(f"tank_longitudinal_seam_{index}", make_pipe(path, radius=0.008, segments=8), mats.tank_seam)
    for seam_index, fraction in enumerate((-0.40, -0.12, 0.20, 0.42)):
        z = fraction * length
        add_mesh_obj(f"tank_circumferential_seam_{seam_index}",
                     make_torus(radius + 0.001, 0.007, z_center=z, major_seg=48, minor_seg=6),
                     mats.tank_seam)



def build_tank_main(length, name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = length / 2.0
    pattern_bounds = tank_roll_pattern_bounds(length)

    # 1. Main Cylindrical Tank Hull with circumferential segments
    # ベース色を保った白塗膜へ、前方だけの白黒チェッカーを面割当する。
    bm_hull = make_tank_hull(length, radius=radius)
    paint_roll_pattern(bm_hull, length)
    add_mesh_obj("tank_hull", bm_hull, (mats.tank_paint_white, mats.tank_paint_black))

    # 2. Structural Bulkhead Bands (CRITICAL: Named 'tank-band' to satisfy contract test!)
    # Band count scaled with length (3m: 1 band, 6m: 2 bands, 12m: 4 bands)
    band_count = 1 if length <= 3.5 else (2 if length <= 6.5 else 4)
    step = length / (band_count + 1)
    for b in range(band_count):
        zb = -half_len + step * (b + 1)
        bm_band = make_torus(major_r=radius + 0.02, minor_r=0.04, z_center=zb, major_seg=48, minor_seg=12)
        # Name MUST be 'tank-band' for test contract!
        add_mesh_obj("tank-band", bm_band, mats.tank_paint_white)
        fastener_centers = [((radius + 0.059) * math.cos(2.0 * math.pi * index / 24.0),
                             (radius + 0.059) * math.sin(2.0 * math.pi * index / 24.0), zb)
                            for index in range(24)]
        add_mesh_obj(f"tank_bulkhead_rivets_{b}",
                     make_spheres(fastener_centers, 0.018, u_seg=8, v_seg=6), mats.tank_fastener)

    # 塗装に馴染む前後・周方向の継ぎ目、浅いハッチ、リベット穴を追加する。
    add_tank_surface_details(mats, length, pattern_bounds)

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
def rcs_append_box(bm, center, dimensions, rotation=None):
    matrix = Matrix.Translation(Vector(center))
    if rotation is not None:
        matrix = matrix @ rotation
    matrix = matrix @ Matrix.Diagonal((*dimensions, 1.0))
    bmesh.ops.create_cube(bm, size=1.0, matrix=matrix)

def rcs_append_beam(bm, start, end, width, depth=None):
    start, end = Vector(start), Vector(end)
    direction = end - start
    if direction.length < 1e-5:
        return
    rotation = direction.normalized().to_track_quat('Z', 'Y').to_matrix().to_4x4()
    rcs_append_box(bm, (start + end) * 0.5, (width, depth or width, direction.length), rotation)

def rcs_append_cylinder(bm, center, direction, radius, depth, segments=16):
    rotation = Vector(direction).normalized().to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=radius, depth=depth,
        matrix=Matrix.Translation(Vector(center)) @ rotation,
    )

def rcs_material_mesh(name, bm, material, smooth_angle=30.0):
    if not bm.verts:
        bm.free()
        return
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    add_mesh_obj(name, shade_by_angle(bm, smooth_angle), material)

def wrinkled_foil_sphere(radius, center):
    """金属箔の不規則な反射を拾う細かな皺を、多方向の半径ゆらぎで作る。"""
    center = Vector(center)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(
        bm, u_segments=64, v_segments=44, radius=radius,
        matrix=Matrix.Translation(center),
    )
    for vertex in bm.verts:
        offset = vertex.co - center
        direction = offset.normalized()
        longitude = math.atan2(direction.y, direction.x)
        latitude = math.asin(max(-1.0, min(1.0, direction.z)))
        ripple = (
            0.015 * math.sin(longitude * 13.0 + latitude * 17.0)
            + 0.012 * math.sin(longitude * 23.0 - latitude * 19.0)
            + 0.009 * math.sin(longitude * 37.0 + latitude * 7.0)
            + 0.005 * math.sin(longitude * 53.0 - latitude * 31.0)
        )
        vertex.co = center + direction * radius * (1.0 + ripple)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return shade_by_angle(bm, 34.0)

def rcs_add_spherical_logo(center, radial, sphere_radius, logo_meshes):
    center, radial = Vector(center), Vector(radial).normalized()
    rotation = radial.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    patch_center = center + radial * (sphere_radius * 1.055)
    rcs_append_cylinder(logo_meshes['rim'], patch_center, radial, 0.22, 0.018, 32)
    rcs_append_cylinder(logo_meshes['blue'], patch_center + radial * 0.016, radial, 0.185, 0.02, 32)
    stripe_rotation = rotation @ Euler((0.0, 0.0, math.radians(-34.0))).to_matrix().to_4x4()
    rcs_append_box(
        logo_meshes['white'], patch_center + radial * 0.031,
        (0.25, 0.025, 0.012), stripe_rotation,
    )
    red_rotation = rotation @ Euler((0.0, 0.0, math.radians(-34.0))).to_matrix().to_4x4()
    rcs_append_box(
        logo_meshes['red'], patch_center + radial * 0.039,
        (0.16, 0.018, 0.012), red_rotation,
    )

def build_tank_rcs(length, name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = length / 2.0

    # 1. 赤い角形鋼材とガセットで円柱シルエットを作る外部トラス
    ring_count = max(3, int(length / 1.5) + 1)
    z_step = length / (ring_count - 1)
    sector_count = 16
    column_stride = 2
    frame_radius = radius * 0.97
    frame = bmesh.new()
    fasteners = bmesh.new()
    for r in range(ring_count):
        z = -half_len + r * z_step
        ring_points = []
        for i in range(sector_count):
            angle = 2.0 * math.pi * i / sector_count
            ring_points.append(Vector((frame_radius * math.cos(angle), frame_radius * math.sin(angle), z)))
        for i, point in enumerate(ring_points):
            rcs_append_beam(frame, point, ring_points[(i + 1) % sector_count], 0.12, 0.095)
            if i % column_stride == 0:
                tangent = Vector((-math.sin(2.0 * math.pi * i / sector_count), math.cos(2.0 * math.pi * i / sector_count), 0.0))
                radial = Vector((math.cos(2.0 * math.pi * i / sector_count), math.sin(2.0 * math.pi * i / sector_count), 0.0))
                plate_rotation = radial.to_track_quat('Z', 'Y').to_matrix().to_4x4()
                rcs_append_box(frame, point + radial * 0.035, (0.31, 0.24, 0.055), plate_rotation)
                for side in (-1.0, 1.0):
                    bolt_position = point + radial * 0.072 + tangent * (side * 0.105)
                    bmesh.ops.create_uvsphere(
                        fasteners, u_segments=8, v_segments=6, radius=0.025,
                        matrix=Matrix.Translation(bolt_position),
                    )

    # 円環を結ぶ縦材と、面ごとに向きを変える大きな斜材で三角形を連ねる。
    for i in range(0, sector_count, column_stride):
        angle = 2.0 * math.pi * i / sector_count
        x, y = frame_radius * math.cos(angle), frame_radius * math.sin(angle)
        rcs_append_beam(frame, (x, y, -half_len), (x, y, half_len), 0.12, 0.095)
    for bay in range(ring_count - 1):
        z0 = -half_len + bay * z_step
        z1 = z0 + z_step
        for i in range(0, sector_count, column_stride):
            a0 = 2.0 * math.pi * i / sector_count
            a1 = 2.0 * math.pi * (i + column_stride) / sector_count
            lower_i = Vector((frame_radius * math.cos(a0), frame_radius * math.sin(a0), z0))
            upper_i = Vector((frame_radius * math.cos(a0), frame_radius * math.sin(a0), z1))
            lower_next = Vector((frame_radius * math.cos(a1), frame_radius * math.sin(a1), z0))
            upper_next = Vector((frame_radius * math.cos(a1), frame_radius * math.sin(a1), z1))
            if (bay + i // column_stride) % 2 == 0:
                rcs_append_beam(frame, lower_i, upper_next, 0.15, 0.10)
            else:
                rcs_append_beam(frame, upper_i, lower_next, 0.15, 0.10)

        # 一部の区画だけ中間横梁を足し、全周を同じ密度にはしない。
        reinforced_sectors = []
        if bay == 0:
            reinforced_sectors.append(2)
        if ring_count >= 5 and bay == ring_count - 2:
            reinforced_sectors.append(10)
        for i in reinforced_sectors:
            a0 = 2.0 * math.pi * i / sector_count
            a1 = 2.0 * math.pi * (i + column_stride) / sector_count
            z_mid = (z0 + z1) * 0.5
            lower = Vector((frame_radius * math.cos(a0), frame_radius * math.sin(a0), z_mid))
            upper = Vector((frame_radius * math.cos(a1), frame_radius * math.sin(a1), z_mid))
            rcs_append_beam(frame, lower, upper, 0.18, 0.12)
            for point, angle in ((lower, a0), (upper, a1)):
                radial = Vector((math.cos(angle), math.sin(angle), 0.0))
                bmesh.ops.create_uvsphere(
                    fasteners, u_segments=8, v_segments=6, radius=0.03,
                    matrix=Matrix.Translation(point + radial * 0.075),
                )
    rcs_material_mesh("rcs_red_box_truss", frame, mats.rcs_frame, 40.0)
    rcs_material_mesh("rcs_truss_bolts", fasteners, mats.rivet, 180.0)

    # 2. 軽い銀箔をまとった高圧球タンクと、その白銀色の支持ヨーク
    axial_sections = max(1, int(length / 2.5))
    sphere_radius = 0.85 * 1.2
    section_step = max(length / (axial_sections + 1), 2.0 * (sphere_radius + 0.11 + 0.035) + 0.06)
    sphere_sections = [
        (section - (axial_sections - 1) * 0.5) * section_step
        for section in range(axial_sections)
    ]
    support = bmesh.new()
    logos = {
        'rim': bmesh.new(), 'blue': bmesh.new(),
        'white': bmesh.new(), 'red': bmesh.new(),
    }
    branch_paths = []
    branch_junctions = bmesh.new()
    avionics_count = max(3, min(5, int(round(length / 3.0))))
    avionics_span = half_len * 0.72
    avionics_zs = [
        -avionics_span + 2.0 * avionics_span * index / (avionics_count - 1)
        for index in range(avionics_count)
    ]
    for sec in range(axial_sections):
        z_sec = sphere_sections[sec]
        section_ports = []
        for t in range(4):
            t_ang = t * math.pi / 2.0 + math.pi / 4.0
            radial = Vector((math.cos(t_ang), math.sin(t_ang), 0.0))
            tangent = Vector((-math.sin(t_ang), math.cos(t_ang), 0.0))
            center = Vector((radius * 0.55 * radial.x, radius * 0.55 * radial.y, z_sec))
            add_mesh_obj(f"rcs_sphere_{sec}_{t}", wrinkled_foil_sphere(sphere_radius, center), mats.rcs_foil)

            # 三方向の白い輪で球を囲い、外部ヨークへ荷重を渡す。
            for axis_index, axis in enumerate((Vector((0.0, 0.0, 1.0)), radial, tangent)):
                cage_ring = make_torus(
                    sphere_radius + 0.11, 0.035, major_seg=48, minor_seg=10,
                )
                rotation = Vector((0.0, 0.0, 1.0)).rotation_difference(axis).to_matrix().to_4x4()
                transform_bm(cage_ring, Matrix.Translation(center) @ rotation)
                add_mesh_obj(f"rcs_sphere_cage_{sec}_{t}_{axis_index}", cage_ring, mats.rcs_support)

            # しわの寄った箔面に、薄い溶接縁と斜めに折れるガス配管を重ねる。
            bm_seam = make_torus(major_r=sphere_radius * 1.045, minor_r=0.006, z_center=0.0, major_seg=48, minor_seg=8)
            transform_bm(bm_seam, Matrix.Translation(center))
            add_mesh_obj(f"rcs_seam_{sec}_{t}", bm_seam, mats.rcs_support)
            rcs_add_spherical_logo(center, radial, sphere_radius, logos)

            # 高さを交互に振った内向きポートで支持輪を避け、球面をなぞらず枝配管を始める。
            port_height_sign = 1.0 if t % 2 == 0 else -1.0
            port_direction = (-radial * 0.91 + tangent * 0.30 + Vector((0.0, 0.0, 0.31 * port_height_sign))).normalized()
            port = center + port_direction * (sphere_radius + 0.012)
            section_ports.append((port, port_direction, tangent))

            # 球の外周を受ける二本の白銀ヨーク脚。接触点は球面の上下へ分ける。
            for side in (-1.0, 1.0):
                contact = center + radial * (sphere_radius * 0.72) + Vector((0.0, 0.0, side * sphere_radius * 0.72))
                footing = radial * 2.82 + Vector((0.0, 0.0, z_sec + side * 0.70))
                rcs_append_beam(support, contact, footing, 0.085, 0.085)
            rcs_append_beam(
                support, center + radial * (sphere_radius * 1.02),
                radial * 2.84 + Vector((0.0, 0.0, z_sec)), 0.10, 0.09,
            )

        # 上下の隣接タンクをそれぞれ一つの節点でまとめ、その枝幹を軸方向配管へ合流させる。
        for pair_index, pair in enumerate(((0, 1), (2, 3))):
            sign = 1.0 if pair_index == 0 else -1.0
            pair_ports = [section_ports[index] for index in pair]
            pair_center = (pair_ports[0][0] + pair_ports[1][0]) * 0.5
            spine_z = z_sec + sign * 0.72
            while any(abs(spine_z - avionics_z) < 0.27 for avionics_z in avionics_zs):
                spine_z += sign * 0.35
            junction = Vector((pair_center.x, pair_center.y, z_sec + (spine_z - z_sec) * 0.24))
            bmesh.ops.create_uvsphere(
                branch_junctions, u_segments=12, v_segments=8, radius=0.092,
                matrix=Matrix.Translation(junction),
            )

            for port, port_direction, tangent in pair_ports:
                exit_point = port + port_direction * 0.18
                mid_point = exit_point.lerp(junction, 0.52) + tangent * (0.105 * sign)
                branch_paths.append([port, exit_point, mid_point, junction])

            # 節点から軸へ向かう幹にも短い折れを入れ、電装箱との間隔を保つ。
            toward_axis = Vector((0.0, 0.0, spine_z))
            approach = Vector((junction.x * 0.76, junction.y * 0.76, spine_z))
            inner = Vector((junction.x * 0.36, junction.y * 0.36, spine_z))
            side = Vector((junction.y, -junction.x, 0.0)).normalized()
            jog = inner + side * (0.075 * sign)
            branch_paths.append([junction, approach, jog, inner, toward_axis])

    for key, material in (
        ('rim', mats.rcs_support), ('blue', mats.rcs_logo_blue),
        ('white', mats.mli_white), ('red', mats.rcs_logo_red),
    ):
        rcs_material_mesh(f"rcs_logo_{key}", logos[key], material, 180.0)
    rcs_material_mesh("rcs_silver_support_yokes", support, mats.rcs_support, 40.0)

    # 中央マニホールド、球へ向かう枝管、箔の上を斜めに折れて走る個別配管。
    pipe_points = [
        Vector((0, 0, -half_len + 0.2)),
        Vector((0, 0, half_len - 0.2)),
    ]
    add_mesh_obj("manifold_spine", make_pipe(pipe_points, radius=0.17, segments=20), mats.rcs_silver_pipe)
    rcs_material_mesh("rcs_branch_junctions", branch_junctions, mats.rcs_silver_pipe, 45.0)

    # 中心配管の側面に、支持金具で電装箱を固定する。
    avionics_mounts = bmesh.new()
    avionics_fasteners = bmesh.new()
    avionics_center_radius = 0.45
    for index, z in enumerate(avionics_zs):
        angle = math.pi * 0.5 * index
        radial_rotation = Matrix.Rotation(angle, 4, 'Z')
        center = radial_rotation @ Vector((avionics_center_radius, 0.0, z))
        box = make_box(0.42, 0.34, 0.30, center=(avionics_center_radius, 0.0, z), bevel=0.035)
        transform_bm(box, radial_rotation)
        add_mesh_obj(
            f"rcs_axial_avionics_box_{index}",
            box,
            mats.electronics_white,
        )
        panel_center = radial_rotation @ Vector((avionics_center_radius + 0.42 * 0.5 + 0.014, 0.0, z))
        panel = make_box(
            0.028, 0.24, 0.17,
            center=(avionics_center_radius + 0.42 * 0.5 + 0.014, 0.0, z),
            bevel=0.012,
        )
        transform_bm(panel, radial_rotation)
        add_mesh_obj(
            f"rcs_axial_avionics_panel_{index}",
            panel,
            mats.electronics_brown,
        )
        for side in (-1.0, 1.0):
            rcs_append_beam(
                avionics_mounts,
                radial_rotation @ Vector((0.135, side * 0.10, z)),
                radial_rotation @ Vector((avionics_center_radius - 0.42 * 0.5, side * 0.10, z)),
                0.04,
                0.035,
            )
            for vertical_side in (-1.0, 1.0):
                fastener_center = radial_rotation @ Vector((
                    avionics_center_radius + 0.42 * 0.5 + 0.014 + 0.018,
                    side * 0.075,
                    z + vertical_side * 0.052,
                ))
                bmesh.ops.create_uvsphere(
                    avionics_fasteners, u_segments=8, v_segments=6, radius=0.016,
                    matrix=Matrix.Translation(fastener_center),
                )
    rcs_material_mesh("rcs_axial_avionics_mounts", avionics_mounts, mats.clamp, 40.0)
    rcs_material_mesh("rcs_axial_avionics_fasteners", avionics_fasteners, mats.rivet, 180.0)

    add_mesh_obj("rcs_branch_manifold_pipes", make_pipes(branch_paths, radius=0.046, segments=12, bend_radius=0.045), mats.rcs_white_pipe)

    # 外側を這う白い配管束は赤い縦材へ複数の金属バンドで固定する。
    bundle_angle = math.radians(-30.0)
    bundle_radial = Vector((math.cos(bundle_angle), math.sin(bundle_angle), 0.0))
    bundle_tangent = Vector((-math.sin(bundle_angle), math.cos(bundle_angle), 0.0))
    bundle_paths = []
    bend_offsets = (0.0, 0.035, 0.055, 0.035, 0.0)
    for offset in (-0.13, 0.0, 0.13):
        lower_run = [
            bundle_radial * (2.76 + 0.23 * step / 4.0)
            + bundle_tangent * (offset + bend_offsets[step])
            + Vector((0.0, 0.0, -half_len + 0.18 + 0.12 * step))
            for step in range(5)
        ]
        upper_run = [
            bundle_radial * (2.76 + 0.23 * step / 4.0)
            + bundle_tangent * (offset + bend_offsets[step])
            + Vector((0.0, 0.0, half_len - 0.18 - 0.12 * step))
            for step in reversed(range(5))
        ]
        bundle_paths.append(lower_run + upper_run)
    add_mesh_obj("rcs_white_external_pipe_bundle", make_pipes(bundle_paths, radius=0.038, segments=10, bend_radius=0.12), mats.rcs_white_pipe)
    bundle_clamps = bmesh.new()
    for clamp_index in range(max(2, ring_count - 1)):
        z = -half_len + 0.35 + clamp_index * (length - 0.70) / max(1, ring_count - 2)
        clamp_rotation = Matrix((
            (bundle_radial.x, bundle_tangent.x, 0.0, 0.0),
            (bundle_radial.y, bundle_tangent.y, 0.0, 0.0),
            (0.0, 0.0, 1.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        ))
        rcs_append_box(bundle_clamps, bundle_radial * 3.005 + Vector((0.0, 0.0, z)), (0.075, 0.40, 0.055), clamp_rotation)
    rcs_material_mesh("rcs_external_pipe_clamps", bundle_clamps, mats.clamp, 40.0)

    # 警告ロッドの両端を、外部配管束の継手へ短い折れ配管でつなぐ。
    hazard_radial = bundle_radial
    hazard_tangent = bundle_tangent
    hazard_start = hazard_radial * 2.82 + hazard_tangent * 0.02 + Vector((0.0, 0.0, -0.68))
    hazard_end = hazard_radial * 2.82 - hazard_tangent * 0.02 + Vector((0.0, 0.0, 0.68))
    hazard_direction = (hazard_end - hazard_start).normalized()
    hazard_connection_paths = [
        [
            hazard_start,
            hazard_radial * 2.88 + hazard_tangent * 0.04 + Vector((0.0, 0.0, -0.66)),
            hazard_radial * 2.94 + hazard_tangent * 0.03 + Vector((0.0, 0.0, -0.63)),
            hazard_radial * 2.99 + hazard_tangent * 0.02 + Vector((0.0, 0.0, -0.68)),
        ],
        [
            hazard_end,
            hazard_radial * 2.88 - hazard_tangent * 0.04 + Vector((0.0, 0.0, 0.66)),
            hazard_radial * 2.94 - hazard_tangent * 0.03 + Vector((0.0, 0.0, 0.63)),
            hazard_radial * 2.99 - hazard_tangent * 0.02 + Vector((0.0, 0.0, 0.68)),
        ],
    ]
    hazard = bmesh.new()
    yellow_bands = bmesh.new()
    rcs_append_cylinder(hazard, (hazard_start + hazard_end) * 0.5, hazard_direction, 0.075, (hazard_end - hazard_start).length, 12)
    band_count = 7
    for index in range(band_count):
        t = (index + 0.5) / band_count
        position = hazard_start.lerp(hazard_end, t)
        rcs_append_cylinder(yellow_bands, position, hazard_direction, 0.078, 0.10, 12)
    rcs_material_mesh("rcs_hazard_rod_black", hazard, mats.rcs_hazard_black, 35.0)
    rcs_material_mesh("rcs_hazard_rod_yellow_bands", yellow_bands, mats.rcs_hazard_yellow, 35.0)
    add_mesh_obj("rcs_hazard_rod_pipe_connectors", make_pipes(hazard_connection_paths, radius=0.045, segments=10, bend_radius=0.035), mats.rcs_white_pipe)

    instrument_angle = math.radians(138.0)
    instrument_radial = Vector((math.cos(instrument_angle), math.sin(instrument_angle), 0.0))
    instrument_center = instrument_radial * 2.73 + Vector((0.0, 0.0, 0.16))
    instrument = make_cylinder(0.16, 0.16, 0.76, segments=20)
    transform_bm(instrument, Matrix.Translation(instrument_center))
    add_mesh_obj("rcs_caged_olive_instrument", instrument, mats.rcs_instrument)
    instrument_cage = bmesh.new()
    cage_tangent = Vector((-instrument_radial.y, instrument_radial.x, 0.0))
    cage_center = instrument_radial * 2.76 + Vector((0.0, 0.0, 0.16))
    for side_r in (-1.0, 1.0):
        for side_t in (-1.0, 1.0):
            cage_offset = instrument_radial * (side_r * 0.24) + cage_tangent * (side_t * 0.24)
            rcs_append_beam(instrument_cage, cage_center + cage_offset + Vector((0.0, 0.0, -0.48)), cage_center + cage_offset + Vector((0.0, 0.0, 0.48)), 0.035, 0.035)
    for z in (-0.32, 0.64):
        for side in (-1.0, 1.0):
            rcs_append_beam(
                instrument_cage,
                cage_center + instrument_radial * (side * 0.24) + cage_tangent * 0.24 + Vector((0.0, 0.0, z - 0.16)),
                cage_center + instrument_radial * (side * 0.24) - cage_tangent * 0.24 + Vector((0.0, 0.0, z - 0.16)),
                0.035, 0.035,
            )
    rcs_material_mesh("rcs_instrument_protective_cage", instrument_cage, mats.rcs_support, 35.0)

    bottle_mesh = bmesh.new()
    bottle_cage = bmesh.new()
    bottle_radial = Vector((math.cos(math.radians(18.0)), math.sin(math.radians(18.0)), 0.0))
    bottle_tangent = Vector((-bottle_radial.y, bottle_radial.x, 0.0))
    for index, z in enumerate((-0.62, -0.02)):
        center = bottle_radial * 2.72 + bottle_tangent * (index * 0.30) + Vector((0.0, 0.0, z))
        rcs_append_cylinder(bottle_mesh, center, (0.0, 0.0, 1.0), 0.12, 0.50, 16)
        rcs_append_box(bottle_cage, center + bottle_radial * 0.13 + Vector((0.0, 0.0, 0.0)), (0.045, 0.34, 0.065), Matrix(((bottle_radial.x, bottle_tangent.x, 0.0, 0.0), (bottle_radial.y, bottle_tangent.y, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0))))
    rcs_material_mesh("rcs_small_white_cylinders", bottle_mesh, mats.rcs_white_pipe, 35.0)
    rcs_material_mesh("rcs_small_cylinder_bands", bottle_cage, mats.clamp, 35.0)

    # 赤・黄・白の細い電装ハーネスと固定クリップを配管の脇へ沿わせる。
    cable_paths = {mats.rcs_wire_red: [], mats.rcs_wire_yellow: [], mats.rcs_wire_white: []}
    cable_offsets = (-0.10, 0.0, 0.10)
    for index, (material, offset) in enumerate(zip(cable_paths.keys(), cable_offsets)):
        cable_paths[material].append([
            bundle_radial * 2.82 + bundle_tangent * (offset + 0.14) + Vector((0.0, 0.0, -half_len + 0.2)),
            bundle_radial * 2.89 + bundle_tangent * (offset + 0.11) + Vector((0.0, 0.0, -0.22 + index * 0.10)),
            bundle_radial * 2.84 + bundle_tangent * (offset - 0.08) + Vector((0.0, 0.0, 0.10 + index * 0.12)),
            bundle_radial * 2.89 + bundle_tangent * (offset - 0.12) + Vector((0.0, 0.0, half_len - 0.2)),
        ])
    for index, material in enumerate(cable_paths):
        add_mesh_obj(f"rcs_electrical_cable_{index}", make_pipes(cable_paths[material], radius=0.014, segments=8, bend_radius=0.11), material)
    cable_clips = bmesh.new()
    cable_clip_rotation = Matrix((
        (bundle_radial.x, bundle_tangent.x, 0.0, 0.0),
        (bundle_radial.y, bundle_tangent.y, 0.0, 0.0),
        (0.0, 0.0, 1.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    ))
    for z in (-half_len + 0.38, 0.0, half_len - 0.38):
        rcs_append_box(cable_clips, bundle_radial * 2.91 + bundle_tangent * 0.16 + Vector((0.0, 0.0, z)), (0.065, 0.36, 0.045), cable_clip_rotation)
    rcs_material_mesh("rcs_electrical_cable_clips", cable_clips, mats.clamp, 40.0)

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))

# ----------------------------------------------------------------------
# 4. Main Thruster (thruster-standard: length 1.0m, diameter 6.0m, radius 3.0m)
# ----------------------------------------------------------------------
# 燃焼圧・推力係数・膨張比は実寸の推定値。液体水素/液体酸素のガス発生器サイクルを想定し、
# Pc = 7 MPa、真空の Cf ≈ 1.8 とすると、カタログの F = 400 kN で At = F/(Cf·Pc) ≈ 0.0317 m²(Dt ≈ 0.20 m)。
# 真空用の ε = 80 で De ≈ 1.80 m、長さは 15° 円錐の 80% の Rao ベルで Ln ≈ 2.4 m、θn ≈ 33°、θe ≈ 9°。
MAIN_ENGINE_CHAMBER_PRESSURE = 7.0e6  # [Pa]
MAIN_ENGINE_THRUST_COEFFICIENT = 1.8
MAIN_ENGINE_EXPANSION_RATIO = 80.0
# 燃焼室の収縮比 Ac/At。液体エンジンの典型値
MAIN_ENGINE_CONTRACTION_RATIO = 6.0
# 再生冷却から放射冷却の延長部へ切り替える面積比
MAIN_ENGINE_EXTENSION_RATIO = 20.0

def aft_dome_surface_z(radial, radius, dome_depth, ring_bottom):
    """ドーム隔壁の輪郭上で、半径 radial における軸方向位置を返す。"""
    return ring_bottom - dome_depth * math.sqrt(max(0.0, 1.0 - (radial / radius) ** 2))

def add_thruster_aft_details(radius, ring_bottom, dome_depth, mats):
    """タンク後部ドームの補強板とリベットを加える。"""
    def surface_z(radial):
        return aft_dome_surface_z(radial, radius, dome_depth, ring_bottom)

    rivets = []
    for k in range(10):
        a = k * math.pi / 5.0
        for center_r in (1.20, 1.98):
            radial_slope = dome_depth * center_r / (radius ** 2 * math.sqrt(1.0 - (center_r / radius) ** 2))
            plate = make_box(
                0.58, 0.17, 0.065,
                center=(center_r * math.cos(a), center_r * math.sin(a), surface_z(center_r) - 0.045),
                rot_euler=(0.0, -math.atan(radial_slope), a),
            )
            add_mesh_obj(f"aft_dome_reinforcement_{k}_{center_r:.2f}", plate, mats.hull_dark)
            for radial_offset in (-0.21, 0.21):
                for tangential_offset in (-0.047, 0.047):
                    rivet_r = center_r + radial_offset
                    x = rivet_r * math.cos(a) - tangential_offset * math.sin(a)
                    y = rivet_r * math.sin(a) + tangential_offset * math.cos(a)
                    rivets.append((x, y, surface_z(math.hypot(x, y)) - 0.082))
    add_mesh_obj("aft_dome_panel_rivets", make_spheres(rivets, 0.024), mats.rivet)

def add_powerhead_pipe_cluster(mats, gimbal, pump_top):
    """ノズル基部から下へ続く支持ケージと、束になった主/二次配管を組む。"""
    ring_zs = (pump_top - 0.28, pump_top - 0.76, pump_top - 1.27)
    # 外周の支持環・レール・斜材
    for ring_index, ring_z in enumerate(ring_zs):
        ring = make_torus(1.24, 0.035, ring_z, major_seg=48, minor_seg=8)
        add_mesh_obj(f"powerhead_support_ring_{ring_index}", ring, mats.hull_dark, parent=gimbal)
    for k in range(10):
        a = k * math.tau / 10.0
        top = Vector((1.22 * math.cos(a), 1.22 * math.sin(a), ring_zs[0]))
        bottom = Vector((1.22 * math.cos(a), 1.22 * math.sin(a), ring_zs[2]))
        rail = make_strut(top, bottom, 0.026, segments=8)
        add_mesh_obj(f"powerhead_support_rail_{k}", rail, mats.truss, parent=gimbal)
    for ring_index in range(2):
        z0, z1 = ring_zs[ring_index:ring_index + 2]
        for k in range(5):
            a0 = k * math.tau / 5.0 + ring_index * math.pi / 5.0
            a1 = a0 + math.pi / 5.0
            start = Vector((1.22 * math.cos(a0), 1.22 * math.sin(a0), z0))
            end = Vector((1.22 * math.cos(a1), 1.22 * math.sin(a1), z1))
            brace = make_strut(start, end, 0.022, segments=8)
            add_mesh_obj(f"powerhead_cross_brace_{ring_index}_{k}", brace, mats.clamp, parent=gimbal)

    # ポンプ側から下部マニフォールドへ向かう二次配管と大径の往復管
    line_paths = []
    for side in (-1.0, 1.0):
        for branch in range(6):
            fraction = branch / 5.0
            z_top = pump_top - 0.18 - 0.045 * branch
            z_mid = pump_top - 0.58 - 0.065 * branch
            z_low = pump_top - 1.06 - 0.045 * (5 - branch)
            z_end = pump_top - 1.30 - 0.035 * branch
            line_paths.append([
                Vector((side * (0.62 + 0.09 * fraction), -0.36 + 0.62 * fraction, z_top)),
                Vector((side * (0.96 + 0.18 * math.sin(fraction * math.pi)), -0.55 + 0.88 * fraction, z_mid)),
                Vector((side * (1.04 + 0.12 * math.cos(fraction * math.pi)), -0.72 + 1.02 * fraction, z_low)),
                Vector((side * (0.58 + 0.16 * fraction), 0.18 - 0.70 * fraction, z_end)),
            ])
        heavy_run = [
            Vector((side * 0.82, 0.48, pump_top - 0.20)),
            Vector((side * 1.24, 0.42, pump_top - 0.43)),
            Vector((side * 1.42, -0.02, pump_top - 0.72)),
            Vector((side * 1.34, -0.52, pump_top - 1.02)),
            Vector((side * 0.94, -0.62, pump_top - 1.24)),
        ]
        add_mesh_obj(
            f"powerhead_primary_feed_loop_{side:+.0f}",
            make_pipe(round_corners(heavy_run, 0.12, steps=5), radius=0.060, segments=14),
            mats.pipe,
            parent=gimbal,
        )
    add_mesh_obj(
        "powerhead_secondary_line_bundle",
        make_pipes(line_paths, radius=0.019, segments=8, bend_radius=0.075),
        mats.pipe,
        parent=gimbal,
    )

def add_nozzle_midsection_feeds(mats, gimbal, manifold_r, manifold_z, ftp_x, otp_x, pump_y, pump_top):
    """ノズル中腹の環状マニフォールドと左右のタービンケースを太管でつなぐ。"""
    for side, pump_x, turbine_offset in ((1.0, ftp_x, 0.62), (-1.0, otp_x, 0.46)):
        angle = -math.pi / 2.0 + side * math.radians(28.0)
        port = Vector((manifold_r * math.cos(angle), manifold_r * math.sin(angle), manifold_z))
        turbine_z = pump_top - turbine_offset
        points = [
            port,
            Vector((side * 0.62, -0.98, manifold_z + 0.16)),
            Vector((side * 0.84, -0.82, turbine_z + 0.42)),
            Vector((pump_x, pump_y - 0.34, turbine_z + 0.10)),
            Vector((pump_x, pump_y - 0.16, turbine_z)),
        ]
        feed = make_pipe(round_corners(points, 0.14, steps=6), radius=0.074, segments=14)
        add_mesh_obj(f"nozzle_midsection_feed_{side:+.0f}", feed, mats.pipe, parent=gimbal)

def add_lh2_side_feedline(mats, ftp_x, pump_y, pump_top):
    """上側タンクから側面を下る液体水素ラインと、その防護スリーブを組む。"""
    points = [
        Vector((0.30, 2.76, -0.28)),
        Vector((0.42, 2.72, -0.62)),
        Vector((0.68, 2.52, -1.02)),
        Vector((0.88, 2.08, -1.48)),
        Vector((0.88, 1.54, -1.92)),
        Vector((ftp_x, 0.28, pump_top - 0.10)),
        Vector((ftp_x, pump_y + 0.06, pump_top - 0.04)),
    ]
    line = make_pipe(round_corners(points, 0.12, steps=5), radius=0.095, segments=14)
    add_mesh_obj("lh2_side_feedline", line, mats.pipe)
    # 上側タンク側のラインを覆う断熱防護スリーブと固定環
    shield_points = points[:5]
    shield_radius = 0.155
    shield = make_pipe(round_corners(shield_points, 0.12, steps=5), radius=shield_radius, segments=16)
    add_mesh_obj("lh2_feedline_protective_sleeve", shield, mats.pipe)
    for clip_index in range(1, len(shield_points) - 1):
        point = shield_points[clip_index]
        tangent = (shield_points[clip_index + 1] - shield_points[clip_index - 1]).normalized()
        clip = make_torus(shield_radius + 0.012, 0.018, major_seg=24, minor_seg=8)
        orient = tangent.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        transform_bm(clip, Matrix.Translation(point) @ orient)
        add_mesh_obj(f"lh2_sleeve_clamp_{clip_index}", clip, mats.clamp)

def add_powerhead_electronics(mats, gimbal, collar_r, pump_top):
    """ブラウンの制御機器、白い円筒機器、取付座と支持された電装ハーネスを載せる。"""
    # 制御・計装パッケージと取付座
    add_mesh_obj("engine_control_pkg_mount", make_box(0.40, 0.26, 0.06, center=(0.0, collar_r + 0.12, pump_top - 0.04)), mats.clamp, parent=gimbal)
    add_mesh_obj("engine_control_pkg", make_box(0.34, 0.20, 0.26, center=(0.0, collar_r + 0.12, pump_top - 0.16)), mats.electronics_brown, parent=gimbal)
    add_mesh_obj("instrumentation_pkg_mount", make_box(0.30, 0.24, 0.06, center=(-0.30, collar_r + 0.10, pump_top - 0.20)), mats.clamp, parent=gimbal)
    add_mesh_obj("instrumentation_pkg", make_box(0.24, 0.18, 0.20, center=(-0.30, collar_r + 0.10, pump_top - 0.30)), mats.electronics_brown, parent=gimbal)
    add_mesh_obj("instrumentation_harness", make_pipe(round_corners([
        Vector((-0.30, collar_r + 0.10, pump_top - 0.20)), Vector((-0.10, collar_r + 0.10, pump_top - 0.06)),
        Vector((0.0, collar_r + 0.20, pump_top - 0.10)),
    ], 0.05), radius=0.018, segments=8), mats.cable, parent=gimbal)

    # 外周の円筒電装と、その取付座
    device_points = []
    for i, (side, y, z_offset) in enumerate((
        (-1.0, -0.62, 0.70), (-1.0, 0.62, 0.92),
        (1.0, -0.62, 0.88), (1.0, 0.62, 0.68),
    )):
        x = side * 1.07
        z = pump_top - z_offset
        saddle = make_box(0.24, 0.22, 0.055, center=(x, y, z + 0.13), rot_euler=(0.0, 0.0, side * 0.18))
        add_mesh_obj(f"powerhead_device_saddle_{i}", saddle, mats.clamp, parent=gimbal)
        cylinder = make_cylinder(0.072, 0.072, 0.19, z_center=z)
        transform_bm(cylinder, Matrix.Translation((x, y, 0.0)))
        add_mesh_obj(f"powerhead_white_device_{i}", cylinder, mats.electronics_white, parent=gimbal)
        brown_box = make_box(0.20, 0.15, 0.14, center=(side * 1.02, y + side * 0.18, z - 0.24))
        add_mesh_obj(f"powerhead_brown_box_{i}", brown_box, mats.electronics_brown, parent=gimbal)
        device_points.append(Vector((x, y, z - 0.08)))
    # 各機器から支持ケージに沿って降りる電装ハーネス
    wire_paths = []
    for i, point in enumerate(device_points):
        side = -1.0 if i < 2 else 1.0
        wire_paths.append([
            point,
            point + Vector((side * 0.08, -0.12, -0.18)),
            Vector((side * 0.72, -0.12, pump_top - 1.12)),
            Vector((side * 0.42, 0.16, pump_top - 1.32)),
        ])
    add_mesh_obj(
        "powerhead_electrical_harness_bundle",
        make_pipes(wire_paths, radius=0.010, segments=6, bend_radius=0.055),
        mats.cable,
        parent=gimbal,
    )

def build_thruster():
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = MANIFEST["modules"]["thruster-standard"]["length"] / 2.0

    # 1. 前面の結合環(相手モジュールと z = +half_len で接する)
    ring_bottom = half_len - 0.20
    add_mesh_obj("thrust_interface_ring", make_lathe([
        (radius - 0.22, ring_bottom), (radius, ring_bottom), (radius, half_len), (radius - 0.22, half_len),
    ], segments=64, closed=True), mats.hull_dark)
    for zr in (ring_bottom + 0.025, half_len - 0.025):
        add_mesh_obj(f"thrust_ring_flange_{zr:.3f}", make_torus(radius + 0.005, 0.025, zr, major_seg=64, minor_seg=10), mats.hull)

    # 2. タンク端を模した楕円ドーム隔壁。結合環の側から後方へ張り出した外面が
    #    区画を閉じ、外面の子午線リブと赤道補強環が殻を支える
    dome_depth = 1.20
    dome = [(radius * math.cos(i * math.pi / 40.0),
             ring_bottom - dome_depth * math.sin(i * math.pi / 40.0)) for i in range(21)]
    add_mesh_obj("aft_dome", make_shell_lathe(dome, 0.05, segments=64), mats.mli_white)
    add_mesh_obj("bay_top_rim", make_torus(radius - 0.03, 0.05, ring_bottom - 0.04, major_seg=64, minor_seg=10), mats.hull_dark)
    # 殻の形を支える子午線の補強リブ・赤道補強環
    for k in range(10):
        a = k * math.pi / 5.0
        rib_pts = [Vector((r * math.cos(a), r * math.sin(a), z - 0.03)) for r, z in dome[4:18]]
        add_mesh_obj(f"dome_rib_{k}", make_pipe(rib_pts, radius=0.035, segments=8), mats.truss)
    add_mesh_obj("dome_equator_ring", make_torus(1.90, 0.04, -0.66, major_seg=64, minor_seg=10), mats.truss)

    add_thruster_aft_details(radius, ring_bottom, dome_depth, mats)

    # 3. 推力構造: ドーム頂の推力受け(基座)からエンジンマウント環へ荷重を受け渡す
    mount_r, mount_z = 0.58, -1.35
    add_mesh_obj("engine_mount_ring", make_torus(mount_r, 0.045, mount_z, major_seg=40, minor_seg=10), mats.hull_dark)
    add_mesh_obj("thrust_pedestal", make_lathe([
        (0.60, mount_z + 0.02), (0.60, mount_z + 0.06), (0.72, mount_z + 0.10), (0.74, mount_z + 0.07),
    ], segments=48, closed=True), mats.hull_dark)
    for k in range(8):
        a = k * math.pi / 4.0
        inner = Vector((0.62 * math.cos(a), 0.62 * math.sin(a), mount_z + 0.04))
        outer = Vector((1.15 * math.cos(a), 1.15 * math.sin(a), mount_z + 0.13))
        add_mesh_obj(f"pedestal_gusset_{k}", make_strut(inner, outer, 0.03, segments=10), mats.truss)
    # 対角の張り出し腕。先端はドーム面へ立つ支柱の節点で、ジンバル作動器の上端を受ける
    outrigger_r = 0.88
    outrigger_tips = []
    for k in range(4):
        a = math.pi / 4.0 + k * math.pi / 2.0
        direction = Vector((math.cos(a), math.sin(a), 0.0))
        tip = direction * outrigger_r + Vector((0, 0, mount_z - 0.02))
        outrigger_tips.append(tip)
        span = outrigger_r - mount_r
        center = direction * (mount_r + span / 2) + Vector((0, 0, mount_z - 0.02))
        add_mesh_obj(f"outrigger_{k}", make_box(span + 0.08, 0.09, 0.10, center=center, rot_euler=(0, 0, a)), mats.hull_dark)
        dome_node_r = 1.35
        dome_node = Vector((
            dome_node_r * math.cos(a), dome_node_r * math.sin(a),
            aft_dome_surface_z(dome_node_r, radius, dome_depth, ring_bottom),
        ))
        add_mesh_obj(f"outrigger_strut_{k}", make_strut(dome_node, tip, 0.035), mats.truss)
        add_mesh_obj(f"outrigger_node_{k}", make_sphere(0.07, center=tip, u_seg=12, v_seg=8), mats.clamp)

    # 4. 加圧ヘリウム容器(COPV): 金色の皺付き箔で覆い、ドーム外面へ鞍座で吊る
    for k, (x, y) in enumerate(((-1.55, 1.55), (1.55, 1.55), (-1.55, -1.55), (1.55, -1.55))):
        center = Vector((x, y, -0.86))
        add_mesh_obj(f"helium_copv_{k}", wrinkled_foil_sphere(0.32, center), mats.mli_gold)
        band = make_torus(0.325, 0.022, center.z, major_seg=32, minor_seg=8)
        add_mesh_obj(f"helium_copv_band_{k}", transform_bm(band, Matrix.Translation((x, y, 0))), mats.clamp)
        tangent = Vector((-y, x, 0.0)).normalized()
        for side in (-1.0, 1.0):
            rim = Vector((x * 1.55, y * 1.55, -0.40)) + tangent * (side * 0.18)
            saddle = center + tangent * (side * 0.18) + Vector((0, 0, 0.20))
            add_mesh_obj(f"helium_copv_cradle_{k}_{side:+.0f}", make_strut(saddle, rim, 0.045), mats.truss)
        valve = center + Vector((0, 0, -0.36))
        valve_body = make_cylinder(0.08, 0.08, 0.09, z_center=valve.z, segments=16)
        add_mesh_obj(f"helium_valve_{k}", transform_bm(valve_body, Matrix.Translation((x, y, 0))), mats.clamp)
        gas_line = [valve, valve + Vector((-x * 0.15, -y * 0.15, -0.10)),
                    Vector((0.0, 1.90, -0.72))]
        add_mesh_obj(f"helium_line_{k}", make_pipe(round_corners(gas_line, 0.10), radius=0.025, segments=10), mats.pipe)
    manifold = make_cylinder(0.15, 0.15, 0.14, z_center=-0.72, segments=20)
    add_mesh_obj("helium_manifold", transform_bm(manifold, Matrix.Translation((0, 1.90, 0))), mats.clamp)
    add_mesh_obj("bay_avionics_mount", make_box(0.82, 0.46, 0.06, center=(0.0, 2.30, -0.64)), mats.clamp)
    add_mesh_obj("bay_avionics_box", make_box(0.70, 0.36, 0.22, center=(0.0, 2.30, -0.50)), mats.electronics_brown)

    # 5. ジンバルの支点。静止側の二股金具が十字軸を挟み、その下は全てジンバルと一緒に振れる
    pivot_z = mount_z - 0.18
    add_mesh_obj("gimbal_mount_block", make_box(0.50, 0.50, 0.12, center=(0, 0, mount_z - 0.04)), mats.hull_dark)
    gimbal = add_anchor("engine-gimbal", (0.0, 0.0, pivot_z))
    for side in (-1.0, 1.0):
        add_mesh_obj(f"gimbal_clevis_{side:+.0f}", make_box(0.05, 0.20, 0.16, center=(side * 0.11, 0.0, pivot_z + 0.06)), mats.clamp)
    add_mesh_obj("gimbal_cross", make_sphere(0.08, center=(0, 0, pivot_z), u_seg=16, v_seg=10), mats.pipe, parent=gimbal)
    pin = make_cylinder(0.035, 0.035, 0.30, z_center=0.0, segments=12)
    transform_bm(pin, Matrix.Translation((0, 0, pivot_z)) @ Euler((0, math.pi / 2, 0)).to_matrix().to_4x4())
    add_mesh_obj("gimbal_cross_pin", pin, mats.pipe, parent=gimbal)
    add_mesh_obj("gimbal_yoke", make_box(0.16, 0.24, 0.08, center=(0, 0, pivot_z - 0.07)), mats.clamp, parent=gimbal)

    # 6. 噴射器ドームと燃焼室・ベル(内面輪郭)
    r_t = throat_radius(module_thrust("thruster-standard"), MAIN_ENGINE_CHAMBER_PRESSURE, MAIN_ENGINE_THRUST_COEFFICIENT)
    r_c = r_t * math.sqrt(MAIN_ENGINE_CONTRACTION_RATIO)
    r_e = r_t * math.sqrt(MAIN_ENGINE_EXPANSION_RATIO)
    chamber_top = pivot_z - 0.14
    # 円筒部 0.35 m と絞り部で燃焼室の特性長 L* = Vc/At ≈ 2.9 m
    chamber_cyl_end = chamber_top - 0.35
    throat_z = chamber_cyl_end - converging_length(r_t, r_c)
    exit_z = throat_z - rao_bell_length(r_t, MAIN_ENGINE_EXPANSION_RATIO)
    bell = rao_bell_profile(r_t, throat_z, r_e, exit_z, 33.0, 9.0, samples=32)
    inner = converging_profile(r_t, throat_z, r_c, chamber_top) + bell[1:]
    regen, extension = split_profile(inner, r_t * math.sqrt(MAIN_ENGINE_EXTENSION_RATIO))
    regen_wall, extension_wall = 0.03, 0.012
    add_mesh_obj("injector_dome", make_lathe([
        (0.0, pivot_z - 0.045), (0.12, pivot_z - 0.05), (0.22, pivot_z - 0.075),
        (r_c + regen_wall + 0.01, pivot_z - 0.115), (r_c + regen_wall + 0.01, chamber_top), (0.0, chamber_top),
    ], segments=48, closed=True), mats.hull_dark, parent=gimbal)
    add_mesh_obj("injector_flange", make_torus(r_c + regen_wall + 0.012, 0.018, chamber_top + 0.005, major_seg=48, minor_seg=10), mats.clamp, parent=gimbal)
    add_mesh_obj("combustion_chamber", make_shell_lathe(regen, regen_wall, segments=64), mats.nozzle_copper, parent=gimbal)
    add_mesh_obj("nozzle_extension", make_shell_lathe(extension, extension_wall, segments=64), mats.nozzle_extension, parent=gimbal)
    add_anchor("thrust", (0.0, 0.0, exit_z - pivot_z), (0, 0, -1), parent=gimbal)

    # ノズル延長部の広い周方向補強環。中央の1本は太い流体マニフォールドに置き換える。
    nozzle_midsection_z = (extension[0][1] + extension[-1][1]) * 0.5
    nozzle_midsection_r = profile_radius_at(extension, nozzle_midsection_z) + extension_wall + 0.065
    for i in range(11):
        if i == 5:
            continue
        t = i / 10.0
        z = extension[0][1] + (extension[-1][1] - extension[0][1]) * t
        ring_r = profile_radius_at(extension, z) + extension_wall + 0.018
        add_mesh_obj(
            f"nozzle_circumferential_rib_{i}",
            make_torus(ring_r, 0.025, z, major_seg=64, minor_seg=10),
            mats.nozzle_titanium_rib,
            parent=gimbal,
        )
    add_mesh_obj(
        "nozzle_midsection_manifold",
        make_torus(nozzle_midsection_r, 0.075, nozzle_midsection_z, major_seg=64, minor_seg=16),
        mats.pipe,
        parent=gimbal,
    )

    # 7. 再生冷却管の束と束ね帯、延長部との継ぎ目の冷却剤入口マニフォールド、延長部の補強環
    tube_r = 0.009
    tube_path = [(r + regen_wall + tube_r * 0.6, z) for r, z in regen[1:]]
    for i in range(40):
        ang = i * 2.0 * math.pi / 40
        pts = [Vector((r * math.cos(ang), r * math.sin(ang), z)) for r, z in tube_path]
        add_mesh_obj(f"cooling_tube_{i}", make_pipe(pts, radius=tube_r, segments=6), mats.nozzle_titanium_rib, parent=gimbal)
    for frac in (0.15, 0.55, 0.8):
        rb, zb = regen[int(frac * (len(regen) - 1))]
        add_mesh_obj(f"nozzle_band_{frac}", make_torus(rb + regen_wall + 0.02, 0.014, zb, major_seg=48, minor_seg=8), mats.clamp, parent=gimbal)
    r_split, z_split = regen[-1]
    manifold_r = r_split + regen_wall + 0.045
    add_mesh_obj("coolant_inlet_manifold", make_torus(manifold_r, 0.035, z_split + 0.01, major_seg=48, minor_seg=12), mats.pipe, parent=gimbal)
    add_mesh_obj("extension_joint_flange", make_torus(r_split + regen_wall + 0.008, 0.016, z_split - 0.03, major_seg=48, minor_seg=8), mats.clamp, parent=gimbal)
    # タービン排気の環状マニフォールドは延長部の入口へ排気を導き、壁面を膜冷却する
    exhaust_manifold_r = r_split + regen_wall + 0.11
    exhaust_manifold_z = z_split - 0.16
    add_mesh_obj("turbine_exhaust_manifold", make_torus(exhaust_manifold_r, 0.05, exhaust_manifold_z, major_seg=48, minor_seg=12), mats.pipe, parent=gimbal)
    for k in range(8):
        a = math.pi / 8.0 + k * math.pi / 4.0
        direction = Vector((math.cos(a), math.sin(a), 0.0))
        top = direction * exhaust_manifold_r + Vector((0, 0, exhaust_manifold_z))
        bottom = direction * (profile_radius_at(inner, exhaust_manifold_z - 0.10) + extension_wall + 0.02) \
            + Vector((0, 0, exhaust_manifold_z - 0.10))
        add_mesh_obj(f"exhaust_dump_tube_{k}", make_strut(top, bottom, 0.022, segments=8), mats.pipe, parent=gimbal)

    # マニフォールドから出口近くまで伸びる並行ガス管と、束を押さえる分割クランプ
    gas_line_count = 8
    gas_tube_radius = 0.012
    gas_line_end_z = exit_z + 0.08
    for i in range(gas_line_count):
        angle = math.tau * i / gas_line_count
        path = []
        for sample in range(9):
            fraction = sample / 8.0
            z = nozzle_midsection_z + (gas_line_end_z - nozzle_midsection_z) * fraction
            radial = profile_radius_at(extension, z) + extension_wall + gas_tube_radius * 0.65
            path.append(Vector((radial * math.cos(angle), radial * math.sin(angle), z)))
        add_mesh_obj(f"nozzle_gas_line_{i}", make_pipe(path, radius=gas_tube_radius, segments=8), mats.nozzle_titanium_rib, parent=gimbal)
        for clamp_index, fraction in enumerate((0.23, 0.77)):
            z = nozzle_midsection_z + (gas_line_end_z - nozzle_midsection_z) * fraction
            radial = profile_radius_at(extension, z) + extension_wall + gas_tube_radius * 0.65
            center = Vector((radial * math.cos(angle), radial * math.sin(angle), z))
            clamp = make_torus(0.015, 0.006, major_seg=16, minor_seg=6)
            add_mesh_obj(
                f"nozzle_gas_line_clamp_{i}_{clamp_index}",
                transform_bm(clamp, Matrix.Translation(center)),
                mats.clamp,
                parent=gimbal,
            )
    add_mesh_obj("extension_exit_ring", make_torus(r_e + extension_wall + 0.004, 0.018, exit_z + 0.018, major_seg=64, minor_seg=10), mats.nozzle_extension, parent=gimbal)

    # 8. 燃焼室の首輪とジンバル作動器。作動器は張り出し腕の節点(静止側)から首輪の耳金具(ジンバル側)を押す
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
        add_mesh_obj(f"gimbal_actuator_rod_{k}", make_strut(split, lug, 0.022, segments=10), mats.pipe, parent=gimbal)
        add_mesh_obj(f"gimbal_actuator_eye_top_{k}", make_sphere(0.038, center=top, u_seg=12, v_seg=8), mats.clamp)
        add_mesh_obj(f"gimbal_actuator_eye_lug_{k}", make_sphere(0.038, center=lug, u_seg=12, v_seg=8), mats.clamp, parent=gimbal)

    # 9. 開放パワーヘッド: 燃焼室の両側へ燃料・酸化剤のターボポンプを対向配置し、
    #    ガス発生器・スタートタンク・制御/計装箱をその周りへ載せる。全てジンバル側
    ftp_x, otp_x, pump_y = collar_r + 0.40, -(collar_r + 0.40), -0.05
    pump_top = chamber_top - 0.02
    add_powerhead_pipe_cluster(mats, gimbal, pump_top)
    add_lh2_side_feedline(mats, ftp_x, pump_y, pump_top)

    # 燃料ターボポンプ(誘導段・ボリュート・ギアボックス・タービンの積層)
    ftp_at = Matrix.Translation((ftp_x, pump_y, 0.0))
    for part, bm, mat in (
        ("ftp_inlet_horn", make_cylinder(0.14, 0.21, 0.16, z_center=pump_top - 0.02, segments=24), mats.pipe),
        ("ftp_pump_housing", make_cylinder(0.19, 0.19, 0.28, z_center=pump_top - 0.20, segments=24), mats.hull_dark),
        ("ftp_volute", make_torus(0.17, 0.055, pump_top - 0.32, major_seg=28, minor_seg=12), mats.hull_dark),
        ("ftp_gearbox", make_box(0.28, 0.24, 0.18, center=(0, 0, pump_top - 0.48)), mats.hull_dark),
        ("ftp_turbine", make_cylinder(0.20, 0.16, 0.24, z_center=pump_top - 0.62, segments=28), mats.pipe),
    ):
        add_mesh_obj(part, transform_bm(bm, ftp_at), mat, parent=gimbal)
    # 酸化剤ターボポンプ(一段、直径の反対側)
    otp_at = Matrix.Translation((otp_x, pump_y, 0.0))
    for part, bm, mat in (
        ("otp_inlet", make_cylinder(0.12, 0.17, 0.14, z_center=pump_top - 0.04, segments=22), mats.pipe),
        ("otp_pump_housing", make_cylinder(0.16, 0.16, 0.24, z_center=pump_top - 0.18, segments=24), mats.hull_dark),
        ("otp_volute", make_torus(0.14, 0.05, pump_top - 0.28, major_seg=26, minor_seg=12), mats.hull_dark),
        ("otp_turbine", make_cylinder(0.17, 0.13, 0.20, z_center=pump_top - 0.46, segments=26), mats.pipe),
    ):
        add_mesh_obj(part, transform_bm(bm, otp_at), mat, parent=gimbal)
    add_nozzle_midsection_feeds(mats, gimbal, nozzle_midsection_r, nozzle_midsection_z, ftp_x, otp_x, pump_y, pump_top)
    # ガス発生器は燃料ターボポンプの脇へ配置
    gg_center = Vector((ftp_x - 0.26, pump_y - 0.22, pump_top - 0.28))
    bm_gg = make_cylinder(0.065, 0.065, 0.20, z_center=0.0, segments=16)
    add_mesh_obj("gas_generator", transform_bm(bm_gg, Matrix.Translation(gg_center)), mats.nozzle_rib, parent=gimbal)
    add_mesh_obj("gg_control_valve", make_box(0.10, 0.10, 0.12, center=gg_center + Vector((0.0, 0.0, 0.16))), mats.clamp, parent=gimbal)
    add_mesh_obj("gas_generator_line", make_pipe(round_corners([
        gg_center - Vector((0, 0, 0.10)), gg_center - Vector((0.10, 0, 0.16)), Vector((ftp_x, pump_y, pump_top - 0.66)),
    ], 0.04), radius=0.025, segments=10), mats.pipe, parent=gimbal)
    # 始動用の高圧ガス球(スタートタンク)。放出口から燃料タービンへ導く
    st_center = Vector((0.34, 0.32, pivot_z - 0.26))
    add_mesh_obj("start_tank", make_sphere(0.22, center=st_center, u_seg=20, v_seg=14), mats.tank_rcs, parent=gimbal)
    st_band = make_torus(0.225, 0.02, st_center.z, major_seg=24, minor_seg=8)
    add_mesh_obj("start_tank_band", transform_bm(st_band, Matrix.Translation((st_center.x, st_center.y, 0.0))), mats.clamp, parent=gimbal)
    add_mesh_obj("start_tank_line", make_pipe(round_corners([
        st_center + Vector((0, 0, -0.22)), Vector((0.45, 0.05, pump_top - 0.45)), Vector((ftp_x + 0.05, pump_y + 0.05, pump_top - 0.60)),
    ], 0.05), radius=0.02, segments=10), mats.pipe, parent=gimbal)
    add_powerhead_electronics(mats, gimbal, collar_r, pump_top)

    # 10. タービン排気系: 両タービンの排気を合流させ、ベル外面を下って排気マニフォールドへ。
    #     途中の偏平箱は加圧ガスとヘリウムを加温する熱交換器
    ftp_exhaust = [Vector((ftp_x, pump_y - 0.10, pump_top - 0.71)),
                   Vector((0.40, -0.50, pump_top - 0.78)), Vector((0.06, -0.72, pump_top - 0.94))]
    add_mesh_obj("ftp_exhaust_duct", make_pipe(round_corners(ftp_exhaust, 0.06), radius=0.055, segments=12), mats.pipe, parent=gimbal)
    otp_exhaust = [Vector((otp_x, pump_y - 0.10, pump_top - 0.54)),
                   Vector((-0.30, -0.55, pump_top - 0.80)), Vector((0.06, -0.72, pump_top - 0.94))]
    add_mesh_obj("otp_exhaust_duct", make_pipe(round_corners(otp_exhaust, 0.06), radius=0.055, segments=12), mats.pipe, parent=gimbal)
    hx_center = Vector((0.06, -0.80, pump_top - 0.98))
    add_mesh_obj("heat_exchanger", make_box(0.36, 0.10, 0.28, center=hx_center, rot_euler=(0.35, 0.0, 0.0)), mats.hull_dark, parent=gimbal)
    for k in range(3):
        tube_pts = [hx_center + Vector((-0.14 + 0.14 * k, 0.06, 0.14)), hx_center + Vector((-0.14 + 0.14 * k, 0.06, -0.14))]
        add_mesh_obj(f"hx_coil_{k}", make_pipe(tube_pts, radius=0.022, segments=8), mats.pipe, parent=gimbal)
    duct_pts = [hx_center + Vector((0.0, -0.04, -0.10))]
    duct_gap = 0.15
    for s in range(1, 6):
        z = duct_pts[0].z + (exhaust_manifold_z - duct_pts[0].z) * s / 5
        wall = regen_wall if z >= z_split else extension_wall
        r = profile_radius_at(inner, z) + wall + duct_gap
        duct_pts.append(Vector((0.0, -r, z)))
    add_mesh_obj("turbine_exhaust_duct", make_pipe(round_corners(duct_pts, 0.08), radius=0.065, segments=14), mats.pipe, parent=gimbal)
    for s in (2, 4):
        p = duct_pts[s]
        wall_r = profile_radius_at(inner, p.z) + (regen_wall if p.z >= z_split else extension_wall)
        add_mesh_obj(f"exhaust_duct_bracket_{s}", make_box(0.05, -p.y - wall_r, 0.04, center=(0.0, (p.y - wall_r) / 2, p.z)), mats.clamp, parent=gimbal)

    # 11. 推進剤の配管: ドーム縁から下りる静止側、ジンバル面の蛇腹、ジンバル側でポンプ入口へ。
    #     燃料吐出は冷却剤入口マニフォールドを経て噴射器へ、酸化剤吐出は噴射器へ
    for side, name, pump_x in ((-1.0, "lox", otp_x), (1.0, "fuel", ftp_x)):
        bellows_x = side * 0.50
        bellows_top, bellows_bottom = pivot_z + 0.14, pivot_z - 0.04
        static = [Vector((side * 2.60, 0.10, -0.32)),
                  Vector((side * 2.00, 0.0, -0.64)),
                  Vector((side * 1.20, 0.0, -0.82)),
                  Vector((bellows_x, 0.0, bellows_top))]
        add_mesh_obj(f"{name}_feedline", make_pipe(round_corners(static, 0.14, steps=6), radius=0.10, segments=16), mats.pipe)
        bm_flange = make_cylinder(0.145, 0.145, 0.045, z_center=0.0, segments=20)
        add_mesh_obj(f"{name}_feed_flange", transform_bm(bm_flange, Matrix.Translation(static[0])), mats.clamp)
        valve_at = static[1].lerp(static[2], 0.5)
        add_mesh_obj(f"{name}_shutoff_valve", make_box(0.30, 0.26, 0.28, center=valve_at), mats.hull_dark)
        for c in range(6):
            zc = bellows_top - (bellows_top - bellows_bottom) * (c + 0.5) / 6
            bm = make_torus(0.11, 0.016, zc, major_seg=16, minor_seg=6)
            transform_bm(bm, Matrix.Translation((bellows_x, 0.0, 0.0)))
            add_mesh_obj(f"{name}_bellows_{c}", bm, mats.clamp, parent=gimbal if c >= 3 else None)
        inlet = Vector((pump_x, pump_y, pump_top - 0.04))
        moving = [Vector((bellows_x, 0.0, bellows_bottom)), Vector((bellows_x, 0.0, bellows_bottom - 0.05)),
                  inlet + Vector((side * 0.10, 0, 0.02)), inlet]
        add_mesh_obj(f"{name}_pump_inlet_line", make_pipe(round_corners(moving, 0.06), radius=0.085, segments=14), mats.pipe, parent=gimbal)
    # 吐出配管と主弁(MFV/MOV)
    mov_center = Vector((otp_x * 0.55, pump_y - 0.10, pump_top - 0.10))
    add_mesh_obj("lox_discharge_line", make_pipe(round_corners([
        Vector((otp_x, pump_y + 0.10, pump_top - 0.28)), mov_center, Vector((-0.15, 0.0, pivot_z - 0.10)),
    ], 0.08), radius=0.04, segments=12), mats.pipe, parent=gimbal)
    add_mesh_obj("main_oxidizer_valve", make_box(0.14, 0.14, 0.16, center=mov_center), mats.clamp, parent=gimbal)
    mfv_center = Vector((ftp_x * 0.6, pump_y - 0.20, pump_top - 0.46))
    coolant = [Vector((ftp_x, pump_y - 0.12, pump_top - 0.36)), mfv_center,
               Vector((manifold_r * math.sin(math.radians(35)), -manifold_r * math.cos(math.radians(35)) - 0.03, z_split + 0.10)),
               Vector((manifold_r * math.sin(math.radians(35)), -manifold_r * math.cos(math.radians(35)), z_split + 0.02))]
    add_mesh_obj("fuel_coolant_line", make_pipe(round_corners(coolant, 0.10), radius=0.04, segments=12), mats.pipe, parent=gimbal)
    add_mesh_obj("main_fuel_valve", make_box(0.14, 0.14, 0.16, center=mfv_center), mats.clamp, parent=gimbal)
    # ガス発生器への推進剤供給と、弁駆動用の高圧ガス配管
    for name, src in (("fuel", Vector((ftp_x, pump_y - 0.12, pump_top - 0.38))),
                      ("lox", Vector((otp_x, pump_y - 0.12, pump_top - 0.32)))):
        add_mesh_obj(f"gg_{name}_supply", make_pipe(round_corners([
            src, gg_center + Vector((0.02 if name == "fuel" else -0.02, -0.06, 0.04)),
        ], 0.04), radius=0.022, segments=10), mats.pipe, parent=gimbal)
    add_mesh_obj("helium_ctrl_line", make_pipe(round_corners([
        Vector((0.0, 1.90, -0.80)), Vector((0.0, 0.90, -0.87)), Vector((0.0, 0.45, pivot_z + 0.02)),
    ], 0.10), radius=0.02, segments=8), mats.pipe)
    add_mesh_obj("helium_valve_lines", make_pipes([
        [Vector((0.0, 0.45, pivot_z - 0.02)), mov_center + Vector((0, 0, 0.10))],
        [Vector((0.0, 0.45, pivot_z - 0.02)), mfv_center + Vector((0, 0, 0.10))],
    ], radius=0.015, segments=8, bend_radius=0.06), mats.pipe, parent=gimbal)

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
# ドッキングポート・建造ドックは直径 3.0 m の周辺結合機構(APAS式)、デカプラーは船体と
# 同じ 6.0 m 径の分離リング。どちらも +Z 側の結合面が嵌合相手の同じ面へ隙間なく当たる。
def build_dock_junction(mats, trunk_r):
    """側面取付で、ポートの幹を船体曲面へ架ける取付構造。船体面へ伏せる座板から
    斜めに開いた脚が、幹を抱く襟環まで登る。"""
    add_saddle_pads(mats, DOCK_SADDLE_PADS, DOCK_PAD_HALF_W)
    for index, (xc, tc) in enumerate(DOCK_SADDLE_PADS):
        foot = saddle_top(tc) + Vector((xc, 0.0, 0.0))
        # 座板の中央から襟環へ斜めに開く脚
        top = Vector((foot.x, foot.y, 0.0)).normalized() * (trunk_r + 0.08) + Vector((0.0, 0.0, -0.06))
        add_mesh_obj(f"dock_leg:{index}", make_strut(foot, top, 0.06, segments=12), mats.truss)
        add_mesh_obj(f"dock_leg_foot:{index}", make_sphere(0.085, center=foot, u_seg=12, v_seg=8), mats.clamp)
    # 脚の先を束ねて幹を抱く襟環
    add_mesh_obj("dock_collar", make_torus(trunk_r + 0.03, 0.055, z_center=-0.06, major_seg=40, minor_seg=10), mats.clamp)

def build_dock_port(name, kind):
    """直径 3.0 m・長さ 1.0 m の周辺結合機構。細い幹(気閘のトンネル)が船体へ立ち、その上へ
    広い機構頭部を載せる。結合面は減衰脚に支えられた捕捉環・3枚の内向きガイドペタル・周囲の
    構造ラッチ列を持ち、気閘の底に圧力隔壁と照準窓がある。
    面盤と気閘は1つの回転体で抜く — 嵌め込みの蓋で面を誤魔化さず、共面によるちらつきを残さない。"""
    reset_scene()
    mats = MaterialLibrary()
    spec = MANIFEST["modules"][name]
    radius = spec["diameter"] / 2.0   # 1.5
    trunk_r = 0.9                   # 幹(トンネルアダプタ)の半径 [m]
    mat_body = mats.dock if kind == 'dock' else mats.hull

    # 本体: 幹(後端面 z=-0.5、半径 0.9)から肩部へ広がる機構頭部(半径 1.5、面盤 z=0.46)、
    # その内側へ気閘(床 z=0.28)を抜く、1つの回転体。
    add_mesh_obj("drum", make_lathe([
        (0.00, -0.50), (0.84, -0.50), (0.90, -0.44), (0.90, 0.05),
        (1.05, 0.11), (1.40, 0.17), (1.50, 0.24), (1.50, 0.32),
        (1.42, 0.40), (1.30, 0.44), (1.30, 0.46), (0.98, 0.46),
        (0.90, 0.42), (0.90, 0.30), (0.80, 0.28), (0.00, 0.28),
    ], segments=64, sharp_angle_deg=30.0), mat_body)

    # 気閘の底の圧力隔壁、隔壁ハンドルの輪と中央の照準窓、床のアライメント条
    add_mesh_obj("dock_hatch", make_cylinder(0.62, 0.62, 0.035, z_center=0.295, segments=36), mats.hull_dark)
    add_mesh_obj("dock_hatch_wheel", make_torus(0.16, 0.018, z_center=0.345, major_seg=24, minor_seg=8), mats.clamp)
    add_mesh_obj("dock_hatch_hub", make_cylinder(0.028, 0.028, 0.05, z_center=0.335, segments=12), mats.clamp)
    add_mesh_obj("dock_window", make_cylinder(0.08, 0.08, 0.02, z_center=0.322, segments=16), mats.window)
    add_mesh_obj("dock_align_marks", make_boxes([
        (0.24, 0.035, 0.006, (0.78 * math.cos(a), 0.78 * math.sin(a), 0.281), (0.0, 0.0, a))
        for a in (0.0, math.pi / 2, math.pi, -math.pi / 2)
    ], bevel=0.002), mats.dock)

    # 面盤の結合機構: ハードメイト環(名前は契約)・構造ラッチ列・捕捉環とその減衰脚・ガイドペタル
    # 'interface-ring' の名前と +Z 法線は契約テストが要求する。面盤から盛り上がる環で z<=0.49。
    add_mesh_obj("interface-ring", make_torus(major_r=1.14, minor_r=0.035, z_center=0.455, major_seg=48, minor_seg=12), mats.cbm_ring)
    add_mesh_obj("capture_hooks", make_boxes([
        (0.085, 0.06, 0.045, (1.245 * math.cos(a), 1.245 * math.sin(a), 0.4725), (0.0, 0.0, a))
        for a in (i * math.pi / 6.0 for i in range(12))
    ], bevel=0.008), mats.hull_dark)

    # 捕捉環は面盤より先へ浮いた薄い帯環。6本の減衰脚(外筒+ロッド)が肩の面盤から斜めに支える。
    add_mesh_obj("capture_ring", make_lathe([
        (0.99, 0.475), (1.11, 0.475), (1.11, 0.49), (0.99, 0.49),
    ], segments=48, closed=True), mats.cbm_ring)
    for i in range(6):
        a = i * math.pi / 3.0 + math.pi / 6.0
        d = Vector((math.cos(a), math.sin(a), 0.0))
        # 基部は頭部の肩部(z≈0.375 で表面 r≈1.44)の上、先端は捕捉環の下面へ届く。
        foot = d * 1.44 + Vector((0.0, 0.0, 0.375))
        top = d * 1.05 + Vector((0.0, 0.0, 0.478))
        mid = foot.lerp(top, 0.62)
        add_mesh_obj(f"ring_strut_sleeve:{i}", make_strut(foot, mid, 0.045, segments=12), mats.pipe)
        add_mesh_obj(f"ring_strut_rod:{i}", make_strut(mid, top, 0.022, segments=10), mats.pipe)
        add_mesh_obj(f"strut_joint:{i}", make_sphere(0.05, center=foot, u_seg=10, v_seg=8), mats.clamp)

    # 捕捉環の外縁のキャプチャラッチ(3基)
    add_mesh_obj("capture_latches", make_boxes([
        (0.14, 0.07, 0.02, (1.05 * math.cos(a), 1.05 * math.sin(a), 0.488), (0.0, 0.0, a))
        for a in (i * 2.0 * math.pi / 3.0 + math.pi / 6.0 for i in range(3))
    ], bevel=0.005), mats.hull_dark)

    # 内向きガイドペタル3枚。気閘の縁に根を張り、先端は z<=0.49 に収める。
    for p in range(3):
        ang = p * 2.0 * math.pi / 3.0
        px = 0.92 * math.cos(ang)
        py = 0.92 * math.sin(ang)
        bm_petal = make_box(0.16, 0.10, 0.26, center=(px, py, 0.34), rot_euler=(math.radians(16) * math.sin(ang), -math.radians(16) * math.cos(ang), ang))
        add_mesh_obj(f"guide_petal_{p}", bm_petal, mats.hull_dark)

    # 幹の取付フランジと締結ボルト(端面取付で端壁へ据わる根元)
    add_mesh_obj("aft_mount_flange", make_torus(major_r=trunk_r + 0.08, minor_r=0.05, z_center=-0.44, major_seg=40, minor_seg=10), mats.clamp)
    add_mesh_obj("aft_bolts", make_boxes([
        (0.06, 0.06, 0.05, (0.76 * math.cos(a), 0.76 * math.sin(a), -0.48), (0.0, 0.0, a))
        for a in (i * math.pi / 4.0 + math.pi / 8.0 for i in range(8))
    ], bevel=0.008), mats.clamp)

    # 頭部の断熱パネル境目と識別帯
    add_mesh_obj("panel_seam_fwd", make_torus(major_r=radius + 0.004, minor_r=0.008, z_center=0.30, major_seg=48, minor_seg=6), mats.hull_dark)
    add_mesh_obj("panel_seam_trunk", make_torus(major_r=trunk_r + 0.004, minor_r=0.008, z_center=-0.20, major_seg=40, minor_seg=6), mats.hull_dark)
    add_mesh_obj("dock_stripe", make_torus(major_r=radius + 0.012, minor_r=0.02, z_center=0.24, major_seg=48, minor_seg=6),
                 mats.dock if kind != 'dock' else mats.clamp)

    # 幹を這うアンビリカル導管と貫通金具(側面取付では船体内部へ吸収される)
    add_mesh_obj("umbilical_panel", make_box(0.16, 0.10, 0.20, center=(0.80, -0.42, -0.10), rot_euler=(0.0, 0.0, -0.48)), mats.hull_dark)
    add_mesh_obj("umbilical_duct", make_pipes([
        [Vector((0.80, -0.44, -0.02)), Vector((0.86, -0.52, -0.32)), Vector((0.80, -0.60, -0.50))],
    ], radius=0.028, segments=10, bend_radius=0.05), mats.pipe)

    # 側面取付で船体曲面へ架ける座板・脚・襟環(端面取付では母船へ吸収されて見えない)
    build_dock_junction(mats, trunk_r)

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))

def build_decoupler(name):
    """直径 6.0 m・長さ 1.0 m の分離リング。直線状爆薬の切断テープと分離ばねを持つ。"""
    reset_scene()
    mats = MaterialLibrary()
    spec = MANIFEST["modules"][name]
    radius = spec["diameter"] / 2.0   # 3.0

    # Main outer structural ring (standard 6.0m diameter)
    bm_ring = make_cylinder(radius, radius, 1.0, z_center=0.0, segments=48)
    add_mesh_obj("ring", bm_ring, mats.hull)

    # Interface Ring (CRITICAL: Must have name 'interface-ring' and +Z normal!)
    # Torus centered at z=0.44m with minor_r=0.05m (fits strictly within z <= 0.49m)
    bm_int_ring = make_torus(major_r=2.35, minor_r=0.05, z_center=0.44, major_seg=48, minor_seg=12)
    add_mesh_obj("interface-ring", bm_int_ring, mats.cbm_ring)

    # Aft Hull Mounting Flange (-Z face, structural interface)
    bm_aft_flange = make_torus(major_r=radius - 0.05, minor_r=0.04, z_center=-0.48, major_seg=48, minor_seg=8)
    add_mesh_obj("aft_mount_flange", bm_aft_flange, mats.clamp)

    # Circumferential alignment stripe / warning band on outer hull
    bm_band = make_torus(major_r=radius + 0.015, minor_r=0.025, z_center=0.10, major_seg=48, minor_seg=6)
    add_mesh_obj("dock_stripe", bm_band, mats.dock)

    # Decoupler linear shaped charge cutting tape & separation springs
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
    columns = int(spec.get("columns", 1))
    if columns < 1 or spec["count"] % columns != 0:
        raise ValueError(f"{kind}: panel count must be divisible by its column count")
    rows = spec["count"] // columns
    column_span = spec["span"] / columns
    root = add_anchor("panel-hinge", (0, 0, half_len))
    for index in range(spec["count"]):
        column, row = divmod(index, rows)
        if kind == "solar_panel":
            panel_width = spec["panelPitch"] * spec["faceScale"] * spec["stageScales"][row]
            center_distance = panel_width / 2 + spec["centerlineClearance"]
            x = (column - (columns - 1) / 2) * 2 * center_distance
        else:
            x = (column - (columns - 1) / 2) * column_span
        hinge = add_anchor(
            f"panel-hinge:{index}", normal * (spec["thickness"] / 2) + Vector((x, 0, row * spec["length"])),
            parent=root, panelIndex=index, panelKind=kind,
        )
        for obj in build_panel(index, 1 if row % 2 == 0 else -1):
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

# ドックの幹を受ける座板。幹の直下に収めて、脚が幹を抱く襟環まで届く。
DOCK_SADDLE_PADS = (
    (0.72, 0.13), (0.72, -0.13), (-0.72, 0.13), (-0.72, -0.13),
)
DOCK_PAD_HALF_W = 0.32          # ドック座板の船体軸方向の半幅 [m]

def add_saddle_pads(mats, pads, half_w):
    """船体面へ伏せる座板とその締結ボルトを並べる。pads は (船体軸方向 x, 周方向角 t [rad])。
    座板端はどの配置でもモデル範囲(z>=-0.55)へ収まる角度幅に留める。"""
    for index, (xc, tc) in enumerate(pads):
        add_mesh_obj(f"hull_saddle:{index}", make_curved_plate(
            tc - SADDLE_HALF_DT, tc + SADDLE_HALF_DT, SADDLE_INNER_RADIUS, SADDLE_THICKNESS,
            xc - half_w, xc + half_w, HULL_AXIS_Z), mats.hull_dark)
        # 座板の締結ボルト。船体軸方向2列×周方向3列
        add_mesh_obj(f"saddle_bolts:{index}", make_boxes([
            (0.05, 0.05, 0.04,
             (xc + sx, saddle_top(tc + st).y, saddle_top(tc + st).z + 0.01), (-(tc + st), 0.0, 0.0))
            for sx in (-(half_w - 0.09), (half_w - 0.09)) for st in (-0.055, 0.0, 0.055)
        ], bevel=0.005), mats.clamp)

def build_hull_junction(mats, half_len, pedestal=True):
    """船体円筒へ伏せる座板・斜めに開いた脚を架け、取付面(z≈+0.4)から船体の接面(z=-0.5)
    までを構造で繋ぐ。pedestal なら脚の先へ機構を載せる四角錐台を添える。"""
    add_saddle_pads(mats, SADDLE_PADS, SADDLE_HALF_W)
    for index, (xc, tc) in enumerate(SADDLE_PADS):
        # 座板の中央から取付構造へ斜めに開いた脚
        foot = saddle_top(tc) + Vector((xc, 0.0, 0.0))
        top = Vector((foot.x, foot.y, 0.0)).normalized() * 0.33 + Vector((0.0, 0.0, 0.10))
        add_mesh_obj(f"mount_leg:{index}", make_strut(foot, top, 0.065, segments=12), mats.truss)
        add_mesh_obj(f"mount_leg_foot:{index}", make_sphere(0.085, center=foot, u_seg=12, v_seg=8), mats.clamp)
    if not pedestal:
        return
    # 機構を載せる台座。円盤を受ける形を名残なくすため円形ではなく角柱で、
    # 脚が届く下端だけ太く、上は駆動ドラムへ吸い込まれる細い四角錐台
    add_mesh_obj("mount_pedestal", make_lathe([
        (0.0, 0.00), (0.58, 0.00), (0.60, 0.04), (0.50, 0.08),
        (0.50, 0.30), (0.46, 0.36), (0.46, half_len - 0.06), (0.0, half_len - 0.06),
    ], segments=4, closed=True, sharp_angle_deg=0.0), mats.hull_dark)

def build_solar_mount(mats, half_len, thickness, span, columns, root_hinge_offset):
    """曲面座の脚で二本のトラスレールを支え、中央の段付き回転筒から根元ヒンジへ力を渡す。"""
    hinge_y = -thickness / 2
    root_z = half_len
    upper_rail_y, upper_rail_z = hinge_y - 0.09, root_z - 0.12
    lower_rail_y, lower_rail_z = hinge_y - 0.38, root_z - 0.44
    drive_y, drive_z = hinge_y - 0.24, root_z - 0.035
    column_pitch = root_hinge_offset * 2

    mount = bpy.data.objects.new("solar_mount_iss_a", None)
    bpy.context.collection.objects.link(mount)
    mount["mountPattern"] = "iss-a"

    def add_group(name, role):
        group = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(group)
        group["mountRole"] = role
        return parent_to(group, mount)

    def add_part(parent, name, geometry, material):
        return parent_to(add_mesh_obj(name, geometry, material), parent)

    def cylinder_x(radius, length, x, y, z, segments=24):
        geometry = make_cylinder(radius, radius, length, z_center=0.0, segments=segments)
        return transform_bm(geometry, Matrix.Translation(Vector((x, y, z)))
            @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())

    def torus_x(major_radius, minor_radius, x, y, z):
        geometry = make_torus(major_radius, minor_radius, z_center=0.0, major_seg=28, minor_seg=8)
        return transform_bm(geometry, Matrix.Translation(Vector((x, y, z)))
            @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())

    drive = add_group("solar_mount_rotary_drive", "stepped-transverse-drive")
    saddle = add_group("solar_mount_saddle", "raised-box-saddle")
    rails = add_group("solar_mount_twin_rails", "parallel-spanwise-rails")
    truss = add_group("solar_mount_v_truss", "open-v-bracing")
    clamps = add_group("solar_mount_root_clamps", "hinge-root-clamps")
    actuation = add_group("solar_mount_actuation", "hold-down-and-feed")

    # パネル幅方向(X)の段付き回転筒。端面の暗い軸穴を金属の襟環が囲む。
    add_part(drive, "solar_mount_drive_barrel", cylinder_x(0.17, 0.50, 0.0, drive_y, drive_z), mats.hull)
    for side in (-1.0, 1.0):
        x = side * 0.27
        add_part(drive, f"solar_mount_drive_collar:{side:+.0f}",
            cylinder_x(0.205, 0.075, x, drive_y, drive_z), mats.clamp)
        add_part(drive, f"solar_mount_drive_recess:{side:+.0f}",
            cylinder_x(0.105, 0.016, side * 0.312, drive_y, drive_z), mats.recessed)
        add_part(drive, f"solar_mount_drive_end_rim:{side:+.0f}",
            torus_x(0.125, 0.022, side * 0.322, drive_y, drive_z), mats.pipe)
    drive_bolts = [
        (side * 0.325, drive_y + 0.155 * math.cos(angle), drive_z + 0.155 * math.sin(angle))
        for side in (-1.0, 1.0) for angle in (i * math.pi / 4 for i in range(8))
    ]
    add_part(drive, "solar_mount_drive_bolts", make_spheres(drive_bolts, 0.018, u_seg=8, v_seg=6), mats.clamp)

    # 中央の受けはU字の箱形サドルとし、筒の下に暗い隙間を残す。
    add_part(saddle, "solar_mount_saddle_plates", make_boxes([
        (0.84, 0.09, 0.08, (0.0, drive_y - 0.12, root_z - 0.33), (0.0, 0.0, 0.0)),
        (0.10, 0.25, 0.22, (-0.32, drive_y - 0.015, root_z - 0.18), (0.0, 0.0, 0.0)),
        (0.10, 0.25, 0.22, (0.32, drive_y - 0.015, root_z - 0.18), (0.0, 0.0, 0.0)),
        (0.70, 0.08, 0.06, (0.0, drive_y - 0.12, root_z - 0.20), (0.0, 0.0, 0.0)),
    ], bevel=0.012), mats.hull)
    add_part(saddle, "solar_mount_saddle_bolts", make_spheres([
        (x, drive_y - 0.17, root_z - 0.34) for x in (-0.31, -0.20, 0.20, 0.31)
    ], 0.022, u_seg=8, v_seg=6), mats.clamp)

    # 二本の平行レールを根元と後方に離して渡し、クランプ位置に補強ブロックを置く。
    add_part(rails, "solar_mount_rails", make_boxes([
        (span - 0.16, 0.075, 0.085, (0.0, upper_rail_y, upper_rail_z), (0.0, 0.0, 0.0)),
        (span - 0.16, 0.075, 0.085, (0.0, lower_rail_y, lower_rail_z), (0.0, 0.0, 0.0)),
    ], bevel=0.010), mats.pipe)
    rail_nodes = []
    for column in range(columns):
        x = (column - (columns - 1) / 2) * column_pitch
        rail_nodes.extend([
            (0.22, 0.10, 0.12, (x, upper_rail_y, upper_rail_z), (0.0, 0.0, 0.0)),
            (0.18, 0.10, 0.11, (x, lower_rail_y, lower_rail_z), (0.0, 0.0, 0.0)),
        ])
    add_part(rails, "solar_mount_rail_nodes", make_boxes(rail_nodes, bevel=0.010), mats.clamp)

    # 対称な二本の斜材が中央サドルからレール端へ開く。各根元にも短い三角補強を置く。
    for side in (-1.0, 1.0):
        add_part(truss, f"solar_mount_v_brace:{side:+.0f}", make_strut(
            Vector((side * 0.34, drive_y - 0.04, root_z - 0.20)),
            Vector((side * (span / 2 - 0.18), lower_rail_y, lower_rail_z)), 0.052), mats.truss)
        x = side * column_pitch / 2
        add_part(truss, f"solar_mount_root_gusset:{side:+.0f}", make_strut(
            Vector((x, upper_rail_y, upper_rail_z)),
            Vector((x + side * 0.30, lower_rail_y, lower_rail_z)), 0.043), mats.truss)
        add_part(truss, f"solar_mount_saddle_lift:{side:+.0f}", make_strut(
            Vector((side * 0.32, drive_y - 0.04, root_z - 0.22)),
            Vector((side * 0.32, drive_y - 0.12, root_z - 0.36)), 0.045), mats.truss)
    add_part(truss, "solar_mount_truss_nodes", make_boxes([
        (0.15, 0.09, 0.12, (side * (span / 2 - 0.18), lower_rail_y, lower_rail_z), (0.0, 0.0, 0.0))
        for side in (-1.0, 1.0)
    ], bevel=0.012), mats.clamp)

    # 各根元ヒンジを長いレールへ重ね板で固定し、駆動筒から短いリンクをつなぐ。
    clamp_parts = []
    clamp_bolts = []
    for column in range(columns):
        x = (column - (columns - 1) / 2) * column_pitch
        clamp_parts.extend([
            (0.30, 0.08, 0.15, (x, hinge_y - 0.055, root_z - 0.045), (0.0, 0.0, 0.0)),
            (0.12, 0.20, 0.13, (x, hinge_y - 0.13, root_z - 0.12), (0.0, 0.0, 0.0)),
        ])
        clamp_bolts.extend((x + offset, hinge_y - 0.012, root_z - 0.055)
            for offset in (-0.095, 0.095))
        side = -1.0 if x < 0.0 else 1.0
        add_part(clamps, f"solar_mount_drive_link:{column}", make_strut(
            Vector((side * 0.31, drive_y, drive_z)),
            Vector((x, upper_rail_y - 0.035, upper_rail_z)), 0.032), mats.clamp)
    add_part(clamps, "solar_mount_hinge_clamps", make_boxes(clamp_parts, bevel=0.012), mats.hull)
    add_part(clamps, "solar_mount_clamp_bolts", make_spheres(clamp_bolts, 0.022, u_seg=8, v_seg=6), mats.pipe)

    # 駆動筒から中央桁の最初の節へ荷重を渡す二股のヨーク。
    centerline_yoke = add_group("solar_mount_centerline_yoke", "folding-centerline-spine-root")
    for side in (-1.0, 1.0):
        add_part(centerline_yoke, f"solar_mount_centerline_yoke_strut:{side:+.0f}", make_strut(
            Vector((side * 0.10, drive_y, drive_z)),
            Vector((side * 0.045, hinge_y - 0.12, root_z + 0.015)), 0.055), mats.truss)

    # 非対称な保持解除箱・駆動箱と、座板へ降りる電力/信号線はレールの外側へ残す。
    frame_z = lower_rail_z
    add_part(actuation, "holddown_release_box", make_box(
        0.36, 0.20, 0.15, center=(-span / 2 + 0.30, lower_rail_y - 0.10, frame_z)), mats.hull_dark)
    add_part(actuation, "drive_latch_box", make_box(
        0.30, 0.22, 0.22, center=(span / 2 - 0.29, lower_rail_y - 0.10, frame_z + 0.04)), mats.hull_dark)
    add_part(actuation, "drive_latch_claw", make_box(
        0.10, 0.07, 0.20, center=(span / 4, hinge_y - 0.06, root_z - 0.025),
        rot_euler=(0.0, 0.0, math.radians(18))), mats.clamp)
    bm_latch_motor = make_cylinder(0.06, 0.06, 0.52, z_center=0.0, segments=14)
    transform_bm(bm_latch_motor, Matrix.Translation(Vector((span / 2 - 0.63, lower_rail_y - 0.10, frame_z)))
        @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
    add_part(actuation, "drive_latch_motor", bm_latch_motor, mats.pipe)

    pad_x, pad_t = -0.85, -0.13
    top = saddle_top(pad_t)
    add_part(actuation, "power_umbilical", make_pipes([
        [Vector((-0.44, lower_rail_y - 0.02, lower_rail_z)), Vector((-0.62, -0.40, -0.05)), Vector((pad_x + 0.06, top.y - 0.02, top.z + 0.06))],
        [Vector((-0.38, lower_rail_y - 0.04, lower_rail_z - 0.01)), Vector((-0.56, -0.44, -0.05)), Vector((pad_x + 0.14, top.y - 0.04, top.z + 0.05))],
    ], radius=0.03, segments=10, bend_radius=0.08), mats.clamp)
    add_part(actuation, "umbilical_fitting", make_box(0.24, 0.18, 0.07,
        center=(pad_x + 0.10, top.y - 0.03, top.z + 0.02), rot_euler=(-pad_t, 0.0, 0.0)), mats.hull_dark)
    add_part(actuation, "umbilical_stub", make_pipes([
        [Vector((pad_x + 0.06, top.y - 0.02, top.z + 0.04)), Vector((pad_x + 0.06, top.y - 0.04, -0.62))],
        [Vector((pad_x + 0.14, top.y - 0.04, top.z + 0.03)), Vector((pad_x + 0.14, top.y - 0.06, -0.62))],
    ], radius=0.028, segments=8), mats.clamp)

# 展開した翼が一面に揃わないよう、パネルごとに面法線方向へ振ったオフセット [m]。
# ヒンジまわりの金具は揃ったままにし、本体と表裏の部品だけをずらす決定的な値
PANEL_FACE_Y_OFFSETS = (0.045, -0.032, 0.020, -0.016, -0.024, 0.036, -0.040, 0.008)
RUST_PANEL_STAGE = 2
DIAMOND_BRACE_STAGE = 2

def build_solar_panel(name):
    reset_scene()
    mats = MaterialLibrary()
    half_len = MANIFEST["modules"][name]["length"] / 2
    build_hull_junction(mats, half_len, pedestal=False)
    spec = MANIFEST["deployables"]["solar_panel"]
    length, span, thickness = spec["length"], spec["span"], spec["thickness"]
    columns = int(spec["columns"])
    panels_per_column = int(spec["count"]) // columns
    tile_span = spec["panelPitch"]
    face_scale = spec["faceScale"]
    stage_scales = spec["stageScales"]
    centerline_clearance = spec["centerlineClearance"]
    root_hinge_offset = tile_span * face_scale * stage_scales[0] / 2 + centerline_clearance
    build_solar_mount(mats, half_len, thickness, span, columns, root_hinge_offset)

    # 裏面の細い角材は基板から浮かせ、段に応じた白い筋交いと二本束の中央レールを作る
    lat_h, lat_w = 0.028, 0.024      # 角材の面からの高さ・面内の幅 [m]
    lat_y = -thickness / 2 - lat_h / 2

    def panel(index, side):
        column = index // panels_per_column
        panel_stage = index % panels_per_column
        size_scale = stage_scales[panel_stage]
        body_span = tile_span * face_scale * size_scale
        body_len = length * face_scale * size_scale
        # セル面は枠の内側へ収め、細かなセル区画を並べる
        cell_x0, cell_x1 = -body_span / 2 + 0.075, body_span / 2 - 0.075
        cell_z0, cell_z1 = 0.09, body_len - 0.075
        cell_cols, cell_rows = 8, 10
        cell_gap = 0.012
        cell_pitch_x = (cell_x1 - cell_x0) / cell_cols
        cell_pitch_z = (cell_z1 - cell_z0) / cell_rows
        lat_x0, lat_x1 = -body_span / 2 + 0.055, body_span / 2 - 0.055
        lat_z0, lat_z1 = 0.09, body_len - 0.055
        mid_x, mid_z = (lat_x0 + lat_x1) / 2, (lat_z0 + lat_z1) / 2

        # おもて面 +Y はガラス光沢のセルとバス帯、裏面 -Y は横縞の褐色基板。
        body = add_mesh_obj(f"panel:{index}",
            make_box(body_span, thickness, body_len, center=(0.0, 0.0, length * 0.5)), mats.solar_backing)
        body["name"] = "deployable-panel" if index == 0 else f"deployable-panel:{index}"
        bus_sheet = add_mesh_obj(f"panel_bus_sheet:{index}", make_box(
            cell_x1 - cell_x0 + 0.02, 0.006, cell_z1 - cell_z0 + 0.02,
            center=(0.0, thickness / 2 + 0.003, (cell_z0 + cell_z1) / 2)), mats.solar_bus)
        # 第3段の2枚は、セル全体を青みの赤褐色にする
        is_rust_panel = panel_stage == RUST_PANEL_STAGE
        brace_pattern = "diamond" if panel_stage == DIAMOND_BRACE_STAGE else "x"
        bm_cells = bmesh.new()
        for row in range(cell_rows):
            for col in range(cell_cols):
                n0 = len(bm_cells.faces)
                bmesh.ops.create_cube(bm_cells, size=1.0,
                    matrix=Matrix.Translation(Vector((
                        cell_x0 + (col + 0.5) * cell_pitch_x,
                        thickness / 2 + 0.012,
                        cell_z0 + (row + 0.5) * cell_pitch_z,
                    ))) @ Matrix.Diagonal((
                        cell_pitch_x - cell_gap, 0.012, cell_pitch_z - cell_gap, 1.0,
                    )))
                if is_rust_panel:
                    shade = len(mats.solar_shades) + (index * 7 + col * 13 + row * 29) % len(mats.solar_rust_shades)
                else:
                    shade = (index * 7 + col * 13 + row * 29) % len(mats.solar_shades)
                bm_cells.faces.ensure_lookup_table()
                for i in range(n0, len(bm_cells.faces)):
                    bm_cells.faces[i].material_index = shade
        bmesh.ops.recalc_face_normals(bm_cells, faces=bm_cells.faces)
        cells = add_mesh_obj(f"panel_cells:{index}", shade_by_angle(bm_cells, 30.0), mats.solar_shades + mats.solar_rust_shades)
        traces = add_mesh_obj(f"panel_cell_traces:{index}", make_boxes([
            (0.006, 0.002, cell_z1 - cell_z0,
             (cell_x0 + col * cell_pitch_x, thickness / 2 + 0.019, (cell_z0 + cell_z1) / 2), (0.0, 0.0, 0.0))
            for col in range(1, cell_cols)
        ] + [
            (cell_x1 - cell_x0, 0.002, 0.006,
             (0.0, thickness / 2 + 0.019, cell_z0 + row * cell_pitch_z), (0.0, 0.0, 0.0))
            for row in range(1, cell_rows)
        ], bevel=0.001), mats.solar_trace)
        # セル列を横断するバス帯
        busbars = add_mesh_obj(f"panel_busbars:{index}", make_boxes([
            (cell_x1 - cell_x0, 0.010, 0.045, (0.0, thickness / 2 + 0.014, bz), (0.0, 0.0, 0.0))
            for bz in (cell_z0 + 3 * cell_pitch_z, cell_z0 + 7 * cell_pitch_z)
        ], bevel=0.004), mats.solar_bus)
        frame = add_mesh_obj(f"panel_frame:{index}", make_boxes([
            (0.04, 0.09, body_len - 0.08, (sx * (body_span / 2 - 0.02), 0.0, 0.04 + (body_len - 0.08) / 2), (0.0, 0.0, 0.0))
            for sx in (-1.0, 1.0)
        ] + [
            (body_span, 0.09, 0.04, (0.0, 0.0, 0.04), (0.0, 0.0, 0.0)),
            (body_span, 0.09, 0.04, (0.0, 0.0, body_len - 0.02), (0.0, 0.0, 0.0)),
        ], bevel=0.010), mats.pipe)
        # 裏面の横縞。骨格より下へ沈め、褐色の基板に細い帯として残す
        stripes = add_mesh_obj(f"panel_back_stripes:{index}", make_boxes([
            (lat_x1 - lat_x0, 0.003, 0.008, (0.0, -thickness / 2 - 0.0015, lat_z0 + (lat_z1 - lat_z0) * row / 7),
             (0.0, 0.0, 0.0))
            for row in range(1, 7)
        ], bevel=0.002), mats.solar_back_stripe)

        def diagonal(start, end):
            dx, dz = end[0] - start[0], end[1] - start[1]
            return (lat_w, lat_h, math.hypot(dx, dz),
                ((start[0] + end[0]) / 2, lat_y, (start[1] + end[1]) / 2),
                (0.0, math.atan2(dx, dz), 0.0))

        corner_nodes = ((lat_x0, lat_z0), (lat_x1, lat_z0), (lat_x1, lat_z1), (lat_x0, lat_z1))
        if brace_pattern == "diamond":
            brace_nodes = ((mid_x, lat_z0), (lat_x1, mid_z), (mid_x, lat_z1), (lat_x0, mid_z))
            brace_edges = tuple((brace_nodes[node], brace_nodes[(node + 1) % len(brace_nodes)])
                for node in range(len(brace_nodes)))
            joint_nodes = brace_nodes
        else:
            brace_nodes = corner_nodes
            brace_edges = ((brace_nodes[0], brace_nodes[2]), (brace_nodes[1], brace_nodes[3]))
            joint_nodes = tuple((x, z) for node, (x, z) in enumerate(brace_nodes) if (index + node) % 2 == 0)
        lattice_parts = [diagonal(start, end) for start, end in brace_edges]
        has_center_crossbar = brace_pattern == "diamond"
        if has_center_crossbar:
            lattice_parts.append(diagonal((lat_x0, mid_z), (lat_x1, mid_z)))
        # 二本の中央レールは2列の内側に沿い、連なる4枚のパネルに渡す
        inner_edge_x = body_span / 2 - 0.055 if index < panels_per_column else -body_span / 2 + 0.055
        lattice_parts.extend(
            (lat_w, lat_h, lat_z1 - lat_z0, (inner_edge_x + offset, lat_y, mid_z), (0.0, 0.0, 0.0))
            for offset in (-0.035, 0.035)
        )
        lattice = add_mesh_obj(f"panel_lattice:{index}", make_boxes(lattice_parts, bevel=0.004), mats.solar_lattice)
        lattice["bracePattern"] = brace_pattern
        lattice["centerCrossbar"] = has_center_crossbar

        # 筋交いの交点を白い四角金具で覆う
        joint_y = lat_y - lat_h / 2 - 0.012
        joint_parts = [
            (0.095, 0.05, 0.095, (x, joint_y, z), (0.0, 0.0, 0.0))
            for x, z in joint_nodes
        ]
        if brace_pattern == "x":
            joint_parts.append((0.11, 0.055, 0.11, (mid_x, joint_y, mid_z), (0.0, 0.0, 0.0)))
        joints = add_mesh_obj(f"panel_lattice_joints:{index}", make_boxes(joint_parts, bevel=0.008), mats.solar_lattice)

        # 四隅と中央寄りへ少数の灰色アクチュエーターを非対称に置く
        actuator_sites = {
            0: ((lat_x0 + 0.10, lat_z0 + 0.10),),
            1: ((lat_x0 + 0.12, lat_z1 - 0.12),),
            2: ((mid_x + 0.03, lat_z1 - 0.12),),
            3: ((mid_x - 0.04, lat_z0 + 0.10),),
            4: ((lat_x1 - 0.12, lat_z0 + 0.12),),
            5: ((lat_x1 - 0.10, lat_z1 - 0.11),),
            6: ((lat_x1 - 0.11, mid_z + 0.06),),
            7: ((mid_x + 0.06, lat_z1 - 0.10),),
        }
        actuator_parts = []
        for site, (x, z) in enumerate(actuator_sites.get(index, ())):
            actuator_y = -thickness / 2 - lat_h - 0.035 - site * 0.006
            actuator_parts.append(add_mesh_obj(f"panel_actuator:{index}:{site}", make_box(
                0.13, 0.08, 0.12, center=(x, actuator_y, z), bevel=0.018), mats.solar_actuator))

        bm_hinge = make_cylinder(0.035, 0.035, body_span * 0.98, z_center=0.0, segments=12)
        transform_bm(bm_hinge, Matrix.Translation(Vector((0.0, -side * thickness / 2, 0.0)))
            @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
        knuckle = add_mesh_obj(f"panel_hinge_hardware:{index}", bm_hinge, mats.clamp)
        # ヒンジのばねドラムと引張ケーブル、開ききりを掴むラッチ爪
        bm_drum = make_cylinder(0.055, 0.055, 0.09, z_center=0.0, segments=12)
        transform_bm(bm_drum, Matrix.Translation(Vector((-body_span / 2 + 0.10, -side * thickness / 2, 0.0)))
            @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
        drum = add_mesh_obj(f"panel_spring_drum:{index}", bm_drum, mats.clamp)
        cable = add_mesh_obj(f"panel_tension_cable:{index}", make_pipe([
            Vector((-body_span / 2 + 0.10, -side * thickness / 2 - 0.05, 0.02)),
            Vector((0.0, -side * thickness / 2 - 0.05, 0.05)),
            Vector((body_span / 2 - 0.10, -side * thickness / 2 - 0.05, 0.02)),
        ], radius=0.008, segments=6), mats.hull_dark)
        claw = add_mesh_obj(f"panel_latch_claw:{index}", make_box(
            0.07, 0.09, 0.14,
            center=(body_span / 2 - 0.10, -side * thickness / 2 - 0.02, -0.04),
            rot_euler=(0.0, 0.0, math.radians(-14))), mats.clamp)
        # パネル本体と表裏の部品は、決定的な高さ差のぶん面法線方向へずらす
        face_parts = [body, bus_sheet, cells, traces, busbars, frame, stripes, lattice, joints, *actuator_parts]
        hinge_parts = [knuckle, drum, cable, claw]
        parts = face_parts + hinge_parts
        y_offset = PANEL_FACE_Y_OFFSETS[index % len(PANEL_FACE_Y_OFFSETS)]
        for obj in face_parts:
            obj.data.transform(Matrix.Translation(Vector((0.0, y_offset, 0.0))))

        # 中央桁は各段で分節し、隣り合うパネルと同じヒンジ姿勢で折り畳む。
        centerline_side = 1.0 if column == 0 else -1.0
        center_distance = body_span / 2 + centerline_clearance
        axis_x = centerline_side * center_distance
        spine_half_width = 0.052
        spine_y = -thickness / 2 - 0.14
        support_z = (body_len * 0.32, body_len * 0.68)
        support_groups = []
        if column == 0:
            spine = bpy.data.objects.new(f"solar_panel_center_spine:{panel_stage}", None)
            bpy.context.collection.objects.link(spine)
            spine["mountRole"] = "folding-centerline-spine-segment"
            spine["stageIndex"] = panel_stage
            spine_parts = [
                (0.034, 0.10, length, (axis_x - 0.034, spine_y, length / 2), (0.0, 0.0, 0.0)),
                (0.034, 0.10, length, (axis_x + 0.034, spine_y, length / 2), (0.0, 0.0, 0.0)),
                (0.13, 0.07, 0.045, (axis_x, spine_y, 0.07), (0.0, 0.0, 0.0)),
                (0.13, 0.07, 0.045, (axis_x, spine_y, length - 0.07), (0.0, 0.0, 0.0)),
            ]
            spine_parts.extend(
                (0.13, 0.07, 0.045, (axis_x, spine_y, z), (0.0, 0.0, 0.0))
                for z in support_z
            )
            parent_to(add_mesh_obj(f"solar_panel_center_spine_frame:{panel_stage}",
                make_boxes(spine_parts, bevel=0.006), mats.solar_lattice), spine)
            if panel_stage < panels_per_column - 1:
                bm_spine_joint = make_cylinder(0.045, 0.045, 0.14, z_center=0.0, segments=16)
                transform_bm(bm_spine_joint,
                    Matrix.Translation(Vector((axis_x, spine_y, length)))
                    @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
                parent_to(add_mesh_obj(f"solar_panel_center_spine_joint:{panel_stage}",
                    bm_spine_joint, mats.clamp), spine)
            support_groups.append(spine)

        # 各パネルの内縁を中央桁へ短い斜材と二点のクランプ板で結ぶ。
        mount = bpy.data.objects.new(f"panel_centerline_mount:{index}", None)
        bpy.context.collection.objects.link(mount)
        mount["mountRole"] = "centerline-panel-bracket"
        mount["panelIndex"] = index
        panel_edge_x = centerline_side * body_span / 2
        foot_x = panel_edge_x - centerline_side * 0.08
        spine_edge_x = axis_x - centerline_side * spine_half_width
        foot_y = -thickness / 2 + y_offset - 0.035
        for support_index, z in enumerate(support_z):
            arm = make_strut(
                Vector((spine_edge_x, spine_y, z)),
                Vector((foot_x, foot_y, z)), 0.038)
            parent_to(add_mesh_obj(f"panel_centerline_mount_arm:{index}:{support_index}",
                arm, mats.solar_lattice), mount)
            parent_to(add_mesh_obj(f"panel_centerline_mount_shoe:{index}:{support_index}",
                make_box(0.24, 0.07, 0.17, center=(foot_x, foot_y, z), bevel=0.008), mats.clamp), mount)
            parent_to(add_mesh_obj(f"panel_centerline_mount_bolts:{index}:{support_index}",
                make_spheres([
                    (foot_x - 0.075, foot_y - 0.04, z),
                    (foot_x + 0.075, foot_y - 0.04, z),
                ], 0.018, u_seg=8, v_seg=6), mats.pipe), mount)
        support_groups.append(mount)
        parts.extend(support_groups)
        return parts

    build_deployable_chain("solar_panel", half_len, panel)
    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))


def build_radiator_mount(mats, half_len):
    """回転流体継手の段付きハウジングと、船体へ降りる冷媒の往復管・制御線束。
    継手はパネル列の収納範囲(畳むと -Y 側へ掃く範囲)の外、翼端方向 -X へ置き、
    根元ヒンジ胴(X 軸)の端へ軸を繋ぐ。機構部は座板の上を EVI カバーで覆い、
    畳んだパネル列の脇には保持ラッチとロックピンを立てる。"""
    # 継手ハウジングは段付き: 太い基部、シール帯を挟む中段、先の軸受ナット
    joint = Vector((-1.80, -0.04, half_len + 0.05))
    for i, (r, h, dx) in enumerate(((0.26, 0.14, 0.17), (0.21, 0.24, -0.02), (0.16, 0.12, -0.20))):
        bm_stage = make_cylinder(r, r, h, z_center=0.0, segments=28)
        transform_bm(bm_stage, Matrix.Translation(joint + Vector((dx, 0.0, 0.0)))
            @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
        add_mesh_obj(f"fluid_joint_stage:{i}", bm_stage, mats.hull_dark)
    # 段の境目のシール帯と、先端の六角の軸受ナット
    bm_seal = make_torus(0.215, 0.025, z_center=0.0, major_seg=28, minor_seg=8)
    transform_bm(bm_seal, Matrix.Translation(joint + Vector((0.10, 0.0, 0.0)))
        @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("fluid_joint_seal", bm_seal, mats.clamp)
    bm_nut = make_cylinder(0.20, 0.20, 0.10, z_center=0.0, segments=8)
    transform_bm(bm_nut, Matrix.Translation(joint + Vector((-0.30, 0.0, 0.0)))
        @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("fluid_joint_nut", bm_nut, mats.clamp)
    add_mesh_obj("fluid_joint_pedestal", make_box(0.42, 0.40, 0.16, center=(-1.82, 0.0, half_len - 0.06)), mats.hull_dark)
    # 座板の上・機構部を包む EVI の銀色断熱カバー。配管だけが貫通して出る布状の箱
    add_mesh_obj("evi_cover", make_box(1.00, 1.10, 0.80, center=(0.02, 0.0, 0.95), bevel=0.10), mats.evi)
    add_mesh_obj("evi_cover_flap", make_box(0.56, 0.62, 0.16, center=(-0.10, 0.0, 1.38), bevel=0.05), mats.evi)
    # 継手ハウジングの取り出し口から台座の脇を経て座板の貫通金具へ下りる行き・戻りの供給管
    pad_x, pad_t = -0.85, -0.13
    top = saddle_top(pad_t)
    add_mesh_obj("fluid_joint_feeds", make_pipes([
        [Vector((-1.62, -0.14, half_len - 0.08)), Vector((-1.55, -0.14, 0.28)), Vector((-0.90, -0.18, 0.12)),
         Vector((-0.52, -0.24, 0.00)), Vector((-0.50, -0.44, -0.22)), Vector((pad_x + 0.16, top.y + 0.02, top.z + 0.05))],
        [Vector((-1.68, 0.06, half_len - 0.08)), Vector((-1.50, 0.06, 0.26)), Vector((-0.85, 0.02, 0.08)),
         Vector((-0.50, -0.08, -0.04)), Vector((-0.46, -0.44, -0.26)), Vector((pad_x + 0.24, top.y + 0.04, top.z + 0.04))],
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
    # 展開制御の umbilical 線束。反対側の座板の貫通金具から継手の台座へ3本撚りで上がる
    cp_x, cp_t = 0.85, 0.13
    ctop = saddle_top(cp_t)
    add_mesh_obj("control_umbilical", make_pipes([
        [Vector((cp_x - 0.06, ctop.y + 0.02, ctop.z + 0.05)), Vector((0.20, 0.52, -0.20)),
         Vector((-0.40, 0.55, 0.05)), Vector((-1.10, 0.30, 0.15)), Vector((-1.55, 0.06, half_len - 0.10))],
        [Vector((cp_x - 0.13, ctop.y + 0.04, ctop.z + 0.04)), Vector((0.14, 0.50, -0.24)),
         Vector((-0.48, 0.50, 0.00)), Vector((-1.15, 0.24, 0.10)), Vector((-1.58, 0.00, half_len - 0.10))],
        [Vector((cp_x - 0.20, ctop.y + 0.06, ctop.z + 0.03)), Vector((0.08, 0.48, -0.28)),
         Vector((-0.55, 0.45, -0.05)), Vector((-1.20, 0.18, 0.05)), Vector((-1.62, -0.06, half_len - 0.10))],
    ], radius=0.016, segments=8, bend_radius=0.06), mats.clamp)
    cfit = Vector((cp_x - 0.13, ctop.y + 0.04, ctop.z + 0.01))
    add_mesh_obj("control_umbilical_fitting", make_box(
        0.26, 0.16, 0.07, center=cfit, rot_euler=(-cp_t, 0.0, 0.0)), mats.hull_dark)
    # 継手ハウジングから根元ヒンジ胴の端へ入る軸と、反対端の軸受
    add_mesh_obj("fluid_joint_shaft", make_strut(
        Vector((-1.42, -0.04, half_len)), Vector((-1.62, -0.04, half_len)), 0.07), mats.clamp)
    bm_cap2 = make_cylinder(0.11, 0.11, 0.24, z_center=0.0, segments=16)
    transform_bm(bm_cap2, Matrix.Translation(Vector((1.67, -0.04, half_len))) @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("fluid_joint_bearing", bm_cap2, mats.clamp)
    add_mesh_obj("fluid_joint_bearing_mount", make_box(0.28, 0.16, 0.12, center=(1.67, -0.04, half_len - 0.04)), mats.hull_dark)
    # 畳んだパネル列は取付面の上で y -2.43..0・z が6枚ぶん厚い積層になる。その両脇に立つ
    # 保持ラッチと、積層の天面を跨ぐロックピン
    for sx in (-1.0, 1.0):
        add_mesh_obj(f"stack_latch_arm:{sx:+.0f}", make_box(
            0.10, 0.08, 0.56, center=(sx * 1.60, -1.00, half_len + 0.27)), mats.hull_dark)
        add_mesh_obj(f"stack_latch_jaw:{sx:+.0f}", make_box(
            0.24, 0.10, 0.09, center=(sx * 1.45, -1.00, half_len + 0.49)), mats.clamp)
    bm_pin = make_cylinder(0.030, 0.030, 3.10, z_center=0.0, segments=10)
    transform_bm(bm_pin, Matrix.Translation(Vector((0.0, -1.00, half_len + 0.49)))
        @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
    add_mesh_obj("stack_lock_pin", bm_pin, mats.pipe)


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
    # 流路管の両端を集める集合管の Z。折り目の渡りホースは先端集合管から隣パネルの根元集合管へ架かる
    header_z0, header_z1 = 0.12, body_len - 0.15
    lanes = (-1.25, -0.75, -0.25, 0.25, 0.75, 1.25)
    hose_ys = (-0.95, -0.55, 0.55, 0.95)

    def panel(index, side):
        # おもて面 +X は滑らかな白いフェースシート、裏面 -X にだけ流路管の凹凸が半分浮き出る。
        # 根元・先端の縁には太い集合管、外周に枠を持つ
        body = add_mesh_obj(f"panel:{index}",
            make_box(thickness, body_span, body_len, center=(0.0, 0.0, length * 0.5)), mats.radiator)
        body["name"] = "deployable-panel" if index == 0 else f"deployable-panel:{index}"
        parts = [body]
        paths = []
        for lane in lanes:
            paths.append([Vector((-face_x, lane, header_z0)), Vector((-face_x, lane, header_z1))])
        # ヒンジ胴のある面から根元の縁を跨ぎ、集合管へ繋ぐ渡り管
        paths.append(round_corners([
            Vector((-side * face_x, 1.30, 0.045)), Vector((-side * face_x, 1.30, -0.06)),
            Vector((0.0, 1.30, -0.06)), Vector((0.0, 1.30, header_z0)),
        ], 0.045))
        parts.append(add_mesh_obj(f"radiator_pipes:{index}", make_pipes(paths, radius=0.028, segments=10), mats.pipe))
        parts.append(add_mesh_obj(f"radiator_headers:{index}", make_pipes([
            [Vector((0.0, -1.30, header_z0)), Vector((0.0, 1.30, header_z0))],
            [Vector((0.0, -1.30, header_z1)), Vector((0.0, 1.30, header_z1))],
        ], radius=0.085, segments=14), mats.pipe))
        # 折り目: 先端集合管から隣パネルのヒンジ軸を回り込んで隣パネルの根元集合管へ届く
        # U 字ホースを幅方向に2組。先頭以外のパネルは持たない
        if index < spec["count"] - 1:
            hose_paths = []
            for hy in hose_ys:
                arc = [Vector((face_x, hy, header_z1))]
                for k in range(11):
                    a = math.pi * k / 10
                    arc.append(Vector((face_x + 0.12 * math.sin(a), hy, length - 0.12 * math.cos(a))))
                hose_paths.append(arc)
            parts.append(add_mesh_obj(f"radiator_hoses:{index}", make_pipes(hose_paths, radius=0.034, segments=10), mats.clamp))
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
# 機関部と砲身束が砲架に沿って後退する最大量 [m]
GUN_RECOIL_TRAVEL = 0.42
# 砲架の脚が載る台座上面の z [m]。結合面(z=-0.5)との間に締結フランジ環と格子梁を収める
GUN_MOUNT_Z = -0.25
# 機関部の後端 z [m]。後座端でも台座上面の手前に留まる
GUN_RECEIVER_BACK_Z = 0.30
# 機関部へ送られる弾と、排莢樋を滑る薬莢の送りピッチ [m]
GUN_ROUND_PITCH = 0.30
GUN_CASING_PITCH = 0.24

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


# XZ 輪郭 outline の三角肘板を、Y 位置 y に厚さ thickness で立てる。
def make_gusset_xz(outline, y, thickness=0.04):
    bm = make_plate_prism(outline, y - thickness / 2, y + thickness / 2)
    return transform_bm(bm, Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1))))


# 塗装・切削面・締結具・弾薬・ゴム覆いを武器専用の材質として用意する。
def add_gun_materials(mats):
    mats.gun_paint = create_pbr_material("mat_gun_naval_gray", (0.31, 0.37, 0.40, 1.0), 0.53, 0.0)
    mats.gun_panel = create_pbr_material("mat_gun_panel_gray", (0.20, 0.25, 0.28, 1.0), 0.58, 0.0)
    mats.gun_machined = create_pbr_material("mat_gun_machined", (0.66, 0.72, 0.75, 1.0), 0.25, 0.72)
    mats.gun_bronze = create_pbr_material("mat_gun_bronze", (0.31, 0.23, 0.14, 1.0), 0.46, 0.45)
    mats.gun_brass = create_pbr_material("mat_gun_brass", (0.80, 0.58, 0.26, 1.0), 0.30, 1.0)
    mats.gun_round_tip = create_pbr_material("mat_gun_round_tip", (0.50, 0.53, 0.56, 1.0), 0.40, 0.9)
    mats.gun_rubber = create_pbr_material("mat_gun_rubber", (0.055, 0.06, 0.065, 1.0), 0.82, 0.0)


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


# 軸 axis('x' か 'y')に沿う長さ length の I 形梁を [z_bottom, z_top] の高さで作る箱の列。
def i_beam_parts(axis, center, length, z_bottom, z_top, width, flange=0.035, web=0.04):
    cx, cy = center
    zc = (z_bottom + z_top) / 2
    depth = z_top - z_bottom
    if axis == 'x':
        dims = lambda w, d: (length, w, d)
    else:
        dims = lambda w, d: (w, length, d)
    parts = []
    for z in (z_bottom + flange / 2, z_top - flange / 2):
        parts.append((*dims(width, flange), (cx, cy, z), (0, 0, 0)))
    parts.append((*dims(web, depth - 2 * flange), (cx, cy, zc), (0, 0, 0)))
    return parts


# 弾の輪郭 (半径, z)。薬莢のボトルネックと弾頭を Z 軸上に並べ、全長 0.78 m・最大径 0.24 m。
GUN_ROUND_CASE = [(0.0, -0.39), (0.12, -0.39), (0.12, -0.36), (0.104, -0.34), (0.104, -0.32),
    (0.12, -0.30), (0.12, 0.10), (0.085, 0.16), (0.0, 0.16)]
GUN_ROUND_TIP = [(0.0, 0.14), (0.084, 0.14), (0.084, 0.24), (0.06, 0.33), (0.03, 0.37), (0.0, 0.39)]
# 撃ち終えた薬莢の輪郭 (半径, z)。弾頭の抜けた口を持つ。
GUN_SPENT_CASE = [(0.0, -0.31), (0.10, -0.31), (0.10, -0.28), (0.086, -0.26), (0.086, -0.24),
    (0.10, -0.22), (0.10, 0.12), (0.07, 0.19), (0.07, 0.29), (0.055, 0.29), (0.055, 0.24), (0.0, 0.24)]


# 長手を Z へ向けた弾を center に置く。
def add_gun_round(name, center, mats, parent):
    offset = Matrix.Translation(Vector(center))
    add_mesh_obj(f"{name}_case", transform_bm(make_lathe(GUN_ROUND_CASE, 14, closed=True), offset),
        mats.gun_brass, parent=parent)
    add_mesh_obj(f"{name}_tip", transform_bm(make_lathe(GUN_ROUND_TIP, 14, closed=True), offset),
        mats.gun_round_tip, parent=parent)


# 長手を Z へ向けた空薬莢を center に置く。
def add_gun_spent_case(name, center, mats, parent):
    add_mesh_obj(name, transform_bm(make_lathe(GUN_SPENT_CASE, 12, closed=True),
        Matrix.Translation(Vector(center))), mats.gun_brass, parent=parent)


# 結合面の締結フランジ環と、その上の I 形梁の格子台座、肘板、配管束。
def build_gun_mount_base(mats):
    ring_r0, ring_r1, ring_z0, ring_z1 = 1.20, 1.50, -0.50, -0.43
    grid_z0, grid_z1 = ring_z1, GUN_MOUNT_Z
    # 隣のモジュール端面へ当たる締結フランジ環と、ボルト列・位置決めキー。
    add_mesh_obj("gun_mount_flange", make_lathe([(ring_r0, ring_z0), (ring_r1, ring_z0), (ring_r1, ring_z1 - 0.018),
        (ring_r1 - 0.03, ring_z1), (ring_r0 + 0.03, ring_z1), (ring_r0, ring_z1 - 0.02)], 96, closed=True),
        mats.gun_panel)
    add_mesh_obj("gun_mount_flange_lip", make_torus(ring_r0 + 0.012, 0.018, ring_z1 - 0.012, 96, 8), mats.gun_machined)
    add_gun_bolts("gun_mount_flange_bolts",
        [(1.37 * math.cos(a), 1.37 * math.sin(a), ring_z1 + 0.012)
            for a in [(i + 0.5) * math.pi / 16 for i in range(32)]], (0, 0, 1), mats, radius=0.032)
    add_mesh_obj("gun_mount_flange_keys", make_boxes([
        (0.10, 0.07, 0.05, (1.35 * math.cos(a), 1.35 * math.sin(a), ring_z1 + 0.02), (0, 0, a))
        for a in (0.25 * math.pi, 1.25 * math.pi)], 0.01), mats.gun_machined)

    # 格子台座: 2本の縦通梁と、頬板の脚・給弾機構・機械室を受ける横梁。
    beams = []
    for x in (-1.12, 1.12):
        beams += i_beam_parts('y', (x, -0.275), 5.05, grid_z0, grid_z1, 0.17)
    for y, half in ((0.25, 1.64), (1.20, 1.64), (2.10, 1.12), (-1.05, 1.50)):
        beams += i_beam_parts('x', (0.0, y), 2 * half, grid_z0, grid_z1, 0.15)
    for y in (-1.28, -2.78):
        beams += i_beam_parts('x', (-0.96, y), 0.32, grid_z0, grid_z1, 0.12)
        beams += i_beam_parts('x', (0.785, y), 0.67, grid_z0, grid_z1, 0.12)
    add_mesh_obj("gun_mount_girders", make_boxes(beams, 0.008), mats.gun_paint)
    # 縦通梁がフランジ環を跨ぐ所の山形の留め金具。
    clips = []
    for x in (-1.12, 1.12):
        for sy in (-1.0, 1.0):
            y = sy * math.sqrt(1.35 ** 2 - x ** 2)
            clips.append((0.30, 0.20, 0.035, (x, y, ring_z1 + 0.018), (0, 0, 0)))
            clips.append((0.035, 0.20, 0.14, (x + math.copysign(0.105, -x), y, ring_z1 + 0.07), (0, 0, 0)))
    add_mesh_obj("gun_mount_clips", make_boxes(clips, 0.006), mats.gun_panel)
    add_gun_bolts("gun_mount_clip_bolts",
        [(x + dx, sy * math.sqrt(1.35 ** 2 - x ** 2) + dy, ring_z1 + 0.04)
            for x in (-1.12, 1.12) for sy in (-1.0, 1.0) for dx in (-0.1, 0.1) for dy in (-0.06, 0.06)],
        (0, 0, 1), mats, radius=0.02)

    # 給弾機構の側壁へ立ち上がる肘板。+X 面ではベルトの開口を避けて上下の縁に置く。
    for y in (-1.28, -2.78):
        add_mesh_obj(f"gun_mount_tower_knee_{y:+.2f}_aft", make_gusset_xz(
            [(-1.12, grid_z1), (-0.80, grid_z1), (-0.80, 0.30)], y), mats.gun_paint)
        add_mesh_obj(f"gun_mount_tower_knee_{y:+.2f}_fore", make_gusset_xz(
            [(1.12, grid_z1), (0.45, 0.25), (0.45, grid_z1)], y), mats.gun_paint)
    # 頬板の脚の外側から頬板へ立ち上がる肘板。
    for side in (-1.0, 1.0):
        for y in (0.30, 1.10):
            outline = [(side * 1.49, GUN_MOUNT_Z + 0.10), (side * 1.64, GUN_MOUNT_Z + 0.10), (side * 1.49, 0.40)]
            if side < 0:
                outline.reverse()
            add_mesh_obj(f"gun_cheek_knee_{side:+.0f}_{y}", make_gusset_xz(outline, y, 0.035), mats.gun_paint)
    # 頬板の張り出した後縁を横梁から支える斜材(排莢樋の無い +X 側)と、その端の耳金具。
    add_mesh_obj("gun_cheek_strut", make_strut((1.36, -1.05, grid_z1), (1.36, -0.72, 0.72), 0.055, 16), mats.gun_machined)
    add_mesh_obj("gun_cheek_strut_lugs", make_boxes([
        (0.10, 0.16, 0.08, (1.36, -1.05, grid_z1 + 0.04), (0, 0, 0)),
        (0.10, 0.14, 0.12, (1.36, -0.73, 0.74), (0, 0, 0))], 0.01), mats.gun_panel)

    # 環の内側から出て、横梁に沿って機械室へ届く油圧・電力の配管束。
    add_mesh_obj("gun_umbilical_grommet", make_box(0.62, 0.20, 0.05,
        center=(0.0, 1.02, ring_z0 + 0.03), bevel=0.012), mats.gun_panel)
    for i, (dx, radius, material) in enumerate((
            (-0.21, 0.035, mats.cable), (-0.09, 0.028, mats.pipe), (0.03, 0.035, mats.gun_bronze),
            (0.15, 0.024, mats.cable), (0.24, 0.028, mats.pipe))):
        add_mesh_obj(f"gun_umbilical_{i}", make_pipes([[
            Vector((dx, 1.02, ring_z0 + 0.05)), Vector((dx, 1.02, GUN_MOUNT_Z + 0.08)),
            Vector((dx * 1.3, 1.45, GUN_MOUNT_Z + 0.10)), Vector((dx * 1.3, 1.52, GUN_MOUNT_Z + 0.20)),
        ]], radius, 12, 0.10), material)
    add_mesh_obj("gun_umbilical_clamps", make_boxes([
        (0.62, 0.05, 0.06, (0.0, 1.20, GUN_MOUNT_Z + 0.09), (0, 0, 0)),
        (0.58, 0.05, 0.05, (0.0, 1.02, GUN_MOUNT_Z - 0.05), (0, 0, 0))], 0.008), mats.clamp)


# 固定砲架を作る。頬板下側の切り欠きは排莢樋と給弾機構の空間を確保する。
def build_gun_cradle(mats):
    mount_z = GUN_MOUNT_Z
    outline = [(0.20, mount_z + 0.04), (1.13, mount_z + 0.04), (1.32, 0.0),
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
            center=(x, 0.72, mount_z + 0.05), bevel=0.035), mats.gun_paint)
        add_gun_bolts(f"gun_cradle_foot_bolts_{side:+.0f}",
            [(x + dx, y, mount_z + 0.11) for dx in (-0.2, 0.2) for y in (0.25, 0.72, 1.20)], (0, 0, 1), mats, radius=0.03)
        bearing_transform = Matrix.Translation((side * 1.53, 0.64, 0.40)) @ Euler((0, math.pi / 2, 0)).to_matrix().to_4x4()
        add_mesh_obj(f"gun_cradle_trunnion_{side:+.0f}",
            transform_bm(make_cylinder(0.38, 0.38, 0.22, segments=40), bearing_transform), mats.gun_paint)
        add_mesh_obj(f"gun_trunnion_hub_{side:+.0f}",
            transform_bm(make_cylinder(0.24, 0.24, 0.24, segments=32), bearing_transform), mats.gun_machined)
        positions = [(side * 1.65, 0.64 + 0.31 * math.cos(a), 0.40 + 0.31 * math.sin(a))
            for a in [i * math.pi / 4 for i in range(8)]]
        add_gun_bolts(f"gun_trunnion_bolts_{side:+.0f}", positions, (side, 0, 0), mats)
        add_gun_bolts(f"gun_cheek_bolts_{side:+.0f}",
            [(side * 1.52, y, z) for y, z in ((-.51, 1.23), (.14, 1.23), (.70, 1.20), (1.18, .60), (.29, -.12))],
            (side, 0, 0), mats)
    # 後座を支える案内レールとその座。
    for side in (-1.0, 1.0):
        add_mesh_obj(f"gun_slide_rail_{side:+.0f}", make_box(.17, .20, 1.32,
            center=(side * .93, -.38, .51), bevel=.018), mats.gun_machined)
        add_mesh_obj(f"gun_slide_rail_seat_{side:+.0f}", make_box(.27, .34, .14,
            center=(side * .93, -.38, mount_z + .07), bevel=.025), mats.gun_paint)


# 後座する機関部、駆動装置、軸受と整備扉を組む。
def build_gun_receiver(mats, recoil, breech_z):
    back, front = GUN_RECEIVER_BACK_Z, breech_z - 0.06
    zc, length = (back + front) / 2, front - back
    add_mesh_obj("gun_receiver", make_box(1.65, 1.48, length, center=(0, 0, zc), bevel=.08), mats.gun_paint, parent=recoil)
    add_mesh_obj("gun_receiver_rear_cover", make_box(1.42, 1.25, .07,
        center=(0, 0, back - .035), bevel=.045), mats.gun_panel, parent=recoil)
    # 天面の段差と排熱格子。
    add_mesh_obj("gun_receiver_top_hatch", make_box(1.16, .09, length * 0.72,
        center=(0, .76, zc), bevel=.04), mats.gun_panel, parent=recoil)
    for i in range(5):
        add_mesh_obj(f"gun_receiver_louvre_{i}", make_box(.72, .035, .045,
            center=(0, .819, back + .16 + i * (length - .32) / 4), bevel=.009), mats.gun_machined, parent=recoil)
    for side in (-1.0, 1.0):
        add_mesh_obj(f"gun_slide_shoe_{side:+.0f}", make_box(.32, .31, .37,
            center=(side * .87, -.38, zc), bevel=.025), mats.gun_panel, parent=recoil)
        add_mesh_obj(f"gun_receiver_side_door_{side:+.0f}", make_box(.05, .71, .61,
            center=(side * .843, .16, zc - .05), bevel=.025), mats.gun_panel, parent=recoil)
        add_gun_bolts(f"gun_receiver_door_bolts_{side:+.0f}",
            [(side * .88, y, z) for y in (-.13, .45) for z in (zc - .30, zc + .20)],
            (side, 0, 0), mats, recoil, .026)
        add_mesh_obj(f"gun_receiver_door_handle_{side:+.0f}",
            make_pipes([[Vector((side * .88, .02, zc - .05)), Vector((side * .94, .02, zc - .05)),
                Vector((side * .94, .23, zc - .05)), Vector((side * .88, .23, zc - .05))]], .018, 10, .025),
            mats.gun_machined, parent=recoil)
    # 砲身束を囲う軸受環と、機関部に載る駆動モーター。
    add_mesh_obj("gun_front_bearing", make_lathe([(.79, front - .09), (.94, front - .09),
        (.98, front - .02), (.98, front + .10), (.92, front + .14),
        (.79, front + .14)], segments=56, closed=True), mats.gun_paint, parent=recoil)
    add_mesh_obj("gun_front_bearing_rim", make_torus(.88, .024, front + .145, 56, 10),
        mats.gun_machined, parent=recoil)
    add_gun_bolts("gun_front_bearing_bolts",
        [(.89 * math.cos(a), .89 * math.sin(a), front + .152)
            for a in [i * math.pi / 6 for i in range(12)]], (0, 0, 1), mats, recoil)
    motor_z = zc - .12
    motor_offset = Matrix.Translation((0, 1.03, 0))
    add_mesh_obj("gun_drive_motor", transform_bm(make_cylinder(.22, .22, .64, motor_z, 32), motor_offset),
        mats.gun_panel, parent=recoil)
    add_mesh_obj("gun_motor_rear_cap", transform_bm(make_cylinder(.17, .17, .07, motor_z - .355, 24), motor_offset),
        mats.gun_machined, parent=recoil)
    add_mesh_obj("gun_motor_gearbox", make_box(.50, .40, .30, center=(0, .95, motor_z + .43), bevel=.045),
        mats.gun_paint, parent=recoil)
    for i, dz in enumerate((-.21, -.10, .01, .12, .23)):
        add_mesh_obj(f"gun_motor_cooling_fin_{i}", transform_bm(make_torus(.22, .017, motor_z + dz, 32, 8), motor_offset),
            mats.gun_machined, parent=recoil)


# 固定スリーブと後座ロッドを同軸に組み、ロッドを囲む復座ばねを後座量に応じて縮ませる。
def build_gun_recoil_cylinders(mats, recoil):
    crosshead_z = 1.35
    for index, side in enumerate((-1.0, 1.0)):
        x, y = side * 1.07, -.66
        offset = Matrix.Translation((x, y, 0))
        add_mesh_obj(f"gun_recoil_sleeve_{side:+.0f}", transform_bm(make_lathe([
            (.11, -.22), (.20, -.22), (.21, -.17), (.21, .47), (.18, .53), (.11, .53),
        ], 40, closed=True), offset), mats.gun_paint)
        add_mesh_obj(f"gun_recoil_gland_{side:+.0f}", transform_bm(make_lathe([
            (.103, .47), (.225, .47), (.225, .55), (.103, .55),
        ], 40, closed=True), offset), mats.gun_machined)
        add_mesh_obj(f"gun_recoil_rod_{side:+.0f}", transform_bm(
            make_cylinder(.10, .10, crosshead_z - .25, (crosshead_z + .25) / 2, 32), offset), mats.gun_machined, parent=recoil)
        add_mesh_obj(f"gun_recoil_rod_crosshead_{side:+.0f}", make_box(.43, .25, .16,
            center=(side * .93, y, crosshead_z), bevel=.045), mats.gun_paint, parent=recoil)
        add_mesh_obj(f"gun_recoil_crosshead_yoke_{side:+.0f}", make_box(.24, .22, .34,
            center=(side * .80, -.60, crosshead_z - .15), bevel=.03), mats.gun_paint, parent=recoil)
        # ばね座: 固定側はグランドの前、可動側はクロスヘッドの後ろ。
        seat_fixed, seat_moving = .56, crosshead_z - .08
        add_mesh_obj(f"gun_recuperator_seat_fixed_{side:+.0f}", transform_bm(make_lathe([
            (.11, seat_fixed - .02), (.20, seat_fixed - .02), (.20, seat_fixed + .01), (.11, seat_fixed + .01),
        ], 32, closed=True), offset), mats.gun_panel)
        add_mesh_obj(f"gun_recuperator_seat_moving_{side:+.0f}", transform_bm(make_lathe([
            (.11, seat_moving - .01), (.20, seat_moving - .01), (.20, seat_moving + .02), (.11, seat_moving + .02),
        ], 32, closed=True), offset), mats.gun_panel, parent=recoil)
        spring = add_anchor(f"gun-recoil-compress:0:{index}", (x, y, seat_fixed + .01),
            restLength=seat_moving - seat_fixed - .02)
        coil_length, turns, coil_r = seat_moving - seat_fixed - .02, 6, .165
        helix = [Vector((x + coil_r * math.cos(2 * math.pi * t / 24), y + coil_r * math.sin(2 * math.pi * t / 24),
            seat_fixed + .01 + coil_length * t / (24 * turns))) for t in range(24 * turns + 1)]
        add_mesh_obj(f"gun_recuperator_spring_{side:+.0f}", make_pipes([helix], .018, 8), mats.gun_machined, parent=spring)
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
            [(x + .17 * math.cos(a), y + .17 * math.sin(a), .557)
                for a in [i * math.pi / 3 for i in range(6)]], (0, 0, 1), mats, radius=.026)


# 案内レールの蛇腹覆いと、機関部と頬板をつなぐ復座リンク。どちらも後座量に追従する。
def build_gun_recoil_followers(mats, recoil, breech_z):
    shoe_rear = (GUN_RECEIVER_BACK_Z + breech_z - 0.06) / 2 - .185
    boot_z0 = -.08
    for index, side in enumerate((-1.0, 1.0)):
        x, y = side * .93, -.38
        boot = add_anchor(f"gun-recoil-compress:0:{2 + index}", (x, y, boot_z0), restLength=shoe_rear - boot_z0)
        pleats = 9
        pitch = (shoe_rear - boot_z0) / pleats
        parts = []
        for k in range(pleats):
            z = boot_z0 + (k + 0.5) * pitch
            parts.append((.20, .26, pitch * .55, (x, y, z - pitch * .2), (0, 0, 0)))
            parts.append((.165, .225, pitch * .5, (x, y, z + pitch * .25), (0, 0, 0)))
        add_mesh_obj(f"gun_rail_boot_{side:+.0f}", make_boxes(parts, 0.006), mats.gun_rubber, parent=boot)
        add_mesh_obj(f"gun_rail_boot_collar_{side:+.0f}", make_box(.23, .29, .04,
            center=(x, y, boot_z0 + .02), bevel=.008), mats.gun_machined)

        # 復座リンク: 頬板の軸受から下がる腕が、機関部の溝付き耳金具に沿って振れる。
        pivot = Vector((side * .97, -.05, 1.06))
        arm_length = .55
        lever = add_anchor(f"gun-recoil-lever:0:{index}", pivot, direction=(1.0, 0.0, 0.0), leverRate=-1.0 / arm_length)
        add_mesh_obj(f"gun_runout_arm_{side:+.0f}", make_box(.05, arm_length + .08, .10,
            center=(pivot.x, pivot.y + arm_length / 2, pivot.z), bevel=.015), mats.gun_machined, parent=lever)
        axle = Euler((0, math.pi / 2, 0)).to_matrix().to_4x4()
        add_mesh_obj(f"gun_runout_arm_boss_{side:+.0f}", transform_bm(make_cylinder(.075, .075, .09, 0.0, 20),
            Matrix.Translation(pivot) @ axle), mats.gun_panel, parent=lever)
        add_mesh_obj(f"gun_runout_arm_roller_{side:+.0f}", transform_bm(make_cylinder(.05, .05, .12, 0.0, 16),
            Matrix.Translation(pivot + Vector((0, arm_length, 0))) @ axle), mats.gun_machined, parent=lever)
        add_mesh_obj(f"gun_runout_pivot_bracket_{side:+.0f}", make_box(1.23 - 1.02, .16, .16,
            center=(side * (1.02 + 1.23) / 2, pivot.y, pivot.z), bevel=.02), mats.gun_paint)
        add_mesh_obj(f"gun_runout_slot_lug_{side:+.0f}", make_boxes([
            (.135, .34, .035, (side * .89, pivot.y + arm_length - .05, pivot.z - .07), (0, 0, 0)),
            (.135, .34, .035, (side * .89, pivot.y + arm_length - .05, pivot.z + .07), (0, 0, 0))], 0.008),
            mats.gun_panel, parent=recoil)


# 固定側の機械室と圧力容器を砲架の支持部へ据え付ける。
def build_gun_service_house(mats):
    mz = GUN_MOUNT_Z
    add_mesh_obj("gun_house", make_box(2.20, .77, .67,
        center=(0, 1.80, mz + .335), bevel=.075), mats.gun_paint)
    add_mesh_obj("gun_house_hood", make_box(2.03, .65, .08,
        center=(0, 1.81, mz + .705), bevel=.035), mats.gun_panel)
    for side in (-1.0, 1.0):
        add_mesh_obj(f"gun_house_service_door_{side:+.0f}", make_box(.75, .49, .025,
            center=(side * .54, 1.80, mz + .759), bevel=.025), mats.gun_paint)
        add_gun_bolts(f"gun_house_door_bolts_{side:+.0f}",
            [(side * .54 + dx, 1.80 + dy, mz + .784) for dx in (-.29, .29) for dy in (-.18, .18)],
            (0, 0, 1), mats, radius=.026)
        accumulator = Matrix.Translation((side * 1.55, 1.36, mz + .375))
        add_mesh_obj(f"gun_accumulator_{side:+.0f}", transform_bm(make_lathe([
            (0, -.23), (.18, -.23), (.22, -.15), (.22, .30), (.18, .40), (0, .40),
        ], 32), accumulator), mats.gun_panel)
        add_mesh_obj(f"gun_accumulator_band_{side:+.0f}", transform_bm(make_torus(.224, .025, .12, 32, 8),
            accumulator), mats.gun_machined)
        add_mesh_obj(f"gun_conduit_{side:+.0f}", make_pipes([[
            Vector((side * .73, 2.1, mz + .235)), Vector((side * .95, 2.45, mz + .125)),
        ]], .035, 12), mats.pipe)
        add_mesh_obj(f"gun_conduit_relay_{side:+.0f}", make_box(.34, .26, .20,
            center=(side * .95, 2.42, mz + .125), bevel=.03), mats.gun_panel)


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


# 軸 Z の星形車: ハブ・端板・放射状の6枚の爪を center に作り、loaded 番目の爪の間の、軸から load_r の所へ
# load で弾か薬莢を載せる。
def add_gun_star_wheel(name, center, radius, length, load_r, mats, parent, loaded, load):
    cx, cy, cz = center
    add_mesh_obj(f"{name}_hub", transform_bm(make_cylinder(radius * .28, radius * .28, length + .04, cz, 20),
        Matrix.Translation((cx, cy, 0))), mats.gun_machined, parent=parent)
    for k, z in enumerate((cz - length / 2 + .02, cz + length / 2 - .02)):
        add_mesh_obj(f"{name}_plate_{k}", transform_bm(make_cylinder(radius, radius, .04, z, 6, bevel=.008),
            Matrix.Translation((cx, cy, 0)) @ Euler((0, 0, math.pi / 6)).to_matrix().to_4x4()), mats.gun_steel, parent=parent)
    add_mesh_obj(f"{name}_fins", make_boxes([
        (radius * .72, .03, length - .06, (cx + radius * .62 * math.cos(a), cy + radius * .62 * math.sin(a), cz), (0, 0, a))
        for a in [k * math.pi / 3 for k in range(6)]], 0.006), mats.gun_steel, parent=parent)
    for k in loaded:
        a = (k + 0.5) * math.pi / 3
        load(f"{name}_load_{k}", (cx + load_r * math.cos(a), cy + load_r * math.sin(a), cz), mats, parent)


# 骨組みと窓の枠で組んだ給弾機構。中の送り車・デリンクドラム・案内爪と、機関部へ昇る弾が見える。
def build_gun_feed(mats, recoil, feed_port, breech_z):
    fx, fy = feed_port.x, feed_port.y
    x0, x1 = fx - 0.80, fx + 0.45
    y0, y1 = fy - 0.90, fy + 0.73
    z0, z1 = -0.43, 1.18
    receiver_zc = (GUN_RECEIVER_BACK_Z + breech_z - 0.06) / 2
    slot_y0, slot_y1 = fy - 0.625, fy + 0.625  # ベルトの開口(リンク厚み 1.0 より僅かに大きい)
    slot_z0, slot_z1 = -0.36, 1.15
    conveyor_x = fx - 0.10
    shaft_x0, shaft_x1 = conveyor_x - 0.24, conveyor_x + 0.24

    # 枠の稜: 角柱と上下・前後の横材。
    post = 0.12
    frame = []
    for x in (x0 + post / 2, x1 - post / 2):
        for y in (y0 + post / 2, y1 - post / 2):
            frame.append((post, post, z1 - z0, (x, y, (z0 + z1) / 2), (0, 0, 0)))
    for z in (z0 + post / 2, z1 - post / 2):
        for y in (y0 + post / 2, y1 - post / 2):
            frame.append((x1 - x0, post, post, ((x0 + x1) / 2, y, z), (0, 0, 0)))
        for x in (x0 + post / 2, x1 - post / 2):
            frame.append((post, y1 - y0, post, (x, (y0 + y1) / 2, z), (0, 0, 0)))
    add_mesh_obj("feed_frame", make_boxes(frame, 0.018), mats.gun_paint)

    # 外側の面(-Y)と前面(+Z)は縁板と斜めの帯板だけを残した窓にする。
    panels = []
    border = 0.20
    for z in (z0 + border / 2, z1 - border / 2):
        panels.append((x1 - x0 - 0.02, 0.05, border, ((x0 + x1) / 2, y0 + 0.025, z), (0, 0, 0)))
    for x in (x0 + border / 2, x1 - border / 2):
        panels.append((border, 0.05, z1 - z0 - 0.02, (x, y0 + 0.025, (z0 + z1) / 2), (0, 0, 0)))
    diag = math.hypot(x1 - x0 - 2 * border, z1 - z0 - 2 * border)
    panels.append((diag, 0.035, 0.10, ((x0 + x1) / 2, y0 + 0.03, (z0 + z1) / 2),
        (0, -math.atan2(z1 - z0 - 2 * border, x1 - x0 - 2 * border), 0)))
    for y in (y0 + border / 2, y1 - border / 2):
        panels.append((x1 - x0 - 0.02, border, 0.05, ((x0 + x1) / 2, y, z1 - 0.025), (0, 0, 0)))
    for x in (x0 + border / 2, x1 - border / 2):
        panels.append((border, y1 - y0 - 0.02, 0.05, (x, (y0 + y1) / 2, z1 - 0.025), (0, 0, 0)))
    panels.append((0.08, y1 - y0 - 2 * border, 0.035, ((x0 + x1) / 2 + 0.12, (y0 + y1) / 2, z1 - 0.03), (0, 0, 0)))
    # 天面(+Y)は弾の昇る抜け道を空け、後座で前後に動く分だけ長い溝にする。
    panels.append((shaft_x0 - x0, 0.08, z1 - z0, ((x0 + shaft_x0) / 2, y1 - 0.04, (z0 + z1) / 2), (0, 0, 0)))
    panels.append((x1 - shaft_x1, 0.08, z1 - z0, ((shaft_x1 + x1) / 2, y1 - 0.04, (z0 + z1) / 2), (0, 0, 0)))
    panels.append((shaft_x1 - shaft_x0, 0.08, 0.22, (conveyor_x, y1 - 0.04, z0 + 0.11), (0, 0, 0)))
    # 結合面側(-Z)は塞ぐ。
    panels.append((x1 - x0 - 0.02, y1 - y0 - 0.02, 0.05, ((x0 + x1) / 2, (y0 + y1) / 2, z0 + 0.025), (0, 0, 0)))
    # +X 面はベルトの開口を残し、その上下と前後を壁で囲う。
    panels.append((0.14, slot_y0 - y0, z1 - z0, (x1 - 0.07, (y0 + slot_y0) / 2, (z0 + z1) / 2), (0, 0, 0)))
    panels.append((0.14, y1 - slot_y1, z1 - z0, (x1 - 0.07, (slot_y1 + y1) / 2, (z0 + z1) / 2), (0, 0, 0)))
    panels.append((0.14, slot_y1 - slot_y0, slot_z0 - z0, (x1 - 0.07, fy, (z0 + slot_z0) / 2), (0, 0, 0)))
    # -X 面はリンク排出口を残し、縁を板で囲う。
    exit_y0, exit_y1, exit_z0, exit_z1 = fy - 0.60, fy + 0.60, -0.35, 0.95
    panels.append((0.10, exit_y0 - y0, z1 - z0, (x0 + 0.05, (y0 + exit_y0) / 2, (z0 + z1) / 2), (0, 0, 0)))
    panels.append((0.10, y1 - exit_y1, z1 - z0, (x0 + 0.05, (exit_y1 + y1) / 2, (z0 + z1) / 2), (0, 0, 0)))
    panels.append((0.10, exit_y1 - exit_y0, exit_z0 - z0, (x0 + 0.05, fy, (z0 + exit_z0) / 2), (0, 0, 0)))
    panels.append((0.10, exit_y1 - exit_y0, z1 - exit_z1, (x0 + 0.05, fy, (exit_z1 + z1) / 2), (0, 0, 0)))
    add_mesh_obj("feed_panels", make_boxes(panels, 0.012), mats.gun_panel)
    add_gun_bolts("feed_panel_bolts_outer",
        [(x, y0 - 0.002, z) for x in (x0 + 0.10, x1 - 0.10) for z in (z0 + 0.25, (z0 + z1) / 2, z1 - 0.25)],
        (0, -1, 0), mats, radius=0.024)
    add_gun_bolts("feed_panel_bolts_front",
        [(x, y, z1 + 0.002) for x in (x0 + 0.10, x1 - 0.10) for y in (y0 + 0.30, y1 - 0.30)],
        (0, 0, 1), mats, radius=0.024)

    # ベルト開口の縁の枠。
    lip_x = x1 + 0.065
    add_mesh_obj("feed_mouth_lip", make_boxes([
        (0.13, 0.10, slot_z1 - slot_z0 + 0.04, (lip_x, slot_y1 + 0.05, (slot_z0 + slot_z1) / 2), (0, 0, 0)),
        (0.13, 0.10, slot_z1 - slot_z0 + 0.04, (lip_x, slot_y0 - 0.05, (slot_z0 + slot_z1) / 2), (0, 0, 0)),
        (0.13, slot_y1 - slot_y0 + 0.20, 0.06, (lip_x, fy, slot_z0 - 0.03), (0, 0, 0)),
        (0.13, slot_y1 - slot_y0 + 0.20, 0.05, (lip_x, fy, slot_z1 + 0.02), (0, 0, 0))], 0.01), mats.clamp)

    # 開口の奥の送り車(縦軸の星車2基)。3枚の星形板と軸で組み、ベルトのリンクを噛む。
    for i, wz in enumerate((-0.15, 0.85)):
        sprocket = add_anchor(f"feed-sprocket:{i}", (fx + 0.35, fy, wz), direction=(0.0, 1.0, 0.0))
        to_axis = Matrix.Translation(Vector((fx + 0.35, fy, wz))) @ Euler((-math.pi / 2, 0.0, 0.0)).to_matrix().to_4x4()
        add_mesh_obj(f"feed_sprocket_shaft_{i}", transform_bm(make_cylinder(0.06, 0.06, 1.15, 0.0, 16), to_axis),
            mats.gun_machined, parent=sprocket)
        for k, dy in enumerate((-0.45, 0.0, 0.45)):
            add_mesh_obj(f"feed_sprocket_disc_{i}_{k}", transform_bm(make_cylinder(0.17, 0.17, 0.06, dy, 16), to_axis),
                mats.gun_steel, parent=sprocket)
            add_mesh_obj(f"feed_sprocket_teeth_{i}_{k}", transform_bm(make_boxes([
                (0.13, 0.055, 0.07, (0.20 * math.cos(t * math.pi / 4), 0.20 * math.sin(t * math.pi / 4), dy),
                    (0, 0, t * math.pi / 4)) for t in range(8)], 0.008), to_axis), mats.gun_steel, parent=sprocket)
        add_mesh_obj(f"feed_sprocket_bearings_{i}", make_boxes([
            (0.20, 0.06, 0.20, (fx + 0.35, fy + dy, wz), (0, 0, 0)) for dy in (-0.60, 0.60)], 0.01), mats.gun_panel)

    # デリンクドラム: ベルトから外した弾を6つの爪の間に抱えて、上の送り路へ回す。
    drum_center = (fx - 0.30, fy - 0.13, receiver_zc)
    drum = add_anchor("feed-drum", drum_center, direction=(0.0, 0.0, 1.0))
    add_gun_star_wheel("feed_drum", drum_center, 0.36, 0.80, 0.26, mats, drum, (0, 1, 3, 4), add_gun_round)
    add_mesh_obj("feed_drum_bearings", make_boxes([
        (0.16, 0.50, 0.06, (drum_center[0], drum_center[1] - 0.25, drum_center[2] + dz), (0, 0, 0))
        for dz in (-0.43, 0.43)], 0.01), mats.gun_panel)

    # 開口の下縁を走る案内爪(フィードシュー)。送りにつれて内側(-X)へ踏み込み、リンクを引き込む。
    shoe_x, shoe_y, shoe_z = x1 - 0.14, slot_y0 - 0.085, 0.36
    shoe = add_anchor("feed-shoe", (shoe_x, shoe_y, shoe_z), direction=(-1.0, 0.0, 0.0))
    add_mesh_obj("feed_shoe_body", make_box(0.55, 0.10, 0.85,
        center=(shoe_x, shoe_y, shoe_z), bevel=0.02), mats.gun_steel, parent=shoe)
    add_mesh_obj("feed_shoe_claw", make_box(0.10, 0.20, 0.10,
        center=(shoe_x + 0.18, shoe_y + 0.12, shoe_z + 0.30), rot_euler=(0.0, -0.45, 0.0), bevel=0.02),
        mats.clamp, parent=shoe)
    add_mesh_obj("feed_shoe_rails", make_boxes([
        (0.80, 0.05, 0.10, (shoe_x - 0.10, shoe_y - 0.075, shoe_z + dz), (0, 0, 0)) for dz in (-0.40, 0.40)], 0.008),
        mats.hull_dark)

    # リンク排出口: 上下の案内ローラーと、空の外枠を押し出す爪。
    for i, ry in enumerate((exit_y1 + 0.02, exit_y0 - 0.02)):
        roller_center = Vector((x0 - 0.10, ry, (exit_z0 + exit_z1) / 2))
        roller = add_anchor(f"link-roller:{i}", roller_center, direction=(0.0, 0.0, 1.0))
        add_mesh_obj(f"link_roller_{i}", transform_bm(make_cylinder(0.09, 0.09, 1.20, roller_center.z, 20),
            Matrix.Translation((roller_center.x, ry, 0))), mats.gun_machined, parent=roller)
        add_mesh_obj(f"link_roller_grips_{i}", make_boxes([
            (0.025, 0.025, 1.14, (roller_center.x + 0.09 * math.cos(a), ry + 0.09 * math.sin(a), roller_center.z), (0, 0, a))
            for a in [k * math.pi / 3 for k in range(6)]], 0.004), mats.gun_steel, parent=roller)
    add_mesh_obj("link_exit_flare", make_boxes([
        (0.26, 0.05, exit_z1 - exit_z0 + 0.20, (x0 - 0.13, exit_y1 + 0.12, (exit_z0 + exit_z1) / 2), (0, 0, -0.35)),
        (0.26, 0.05, exit_z1 - exit_z0 + 0.20, (x0 - 0.13, exit_y0 - 0.12, (exit_z0 + exit_z1) / 2), (0, 0, 0.35)),
        (0.24, exit_y1 - exit_y0 + 0.30, 0.05, (x0 - 0.12, fy, exit_z0 - 0.12), (0, 0, 0)),
        (0.24, exit_y1 - exit_y0 + 0.30, 0.05, (x0 - 0.12, fy, exit_z1 + 0.12), (0, 0, 0))], 0.01), mats.gun_paint)
    kicker_center = Vector((x0 + 0.34, fy, exit_z0 + 0.08))
    kicker = add_anchor("link-kicker", kicker_center, direction=(-1.0, 0.0, 0.0))
    add_mesh_obj("link_kicker_pusher", make_boxes([
        (0.06, 1.00, 0.16, (kicker_center.x, fy, kicker_center.z), (0, 0, 0)),
        (0.30, 0.12, 0.10, (kicker_center.x + 0.15, fy, kicker_center.z - 0.02), (0, 0, 0))], 0.01),
        mats.clamp, parent=kicker)
    add_mesh_obj("link_kicker_guide", make_pipes([[
        Vector((x0 + 0.10, fy, kicker_center.z - 0.02)), Vector((x0 + 0.75, fy, kicker_center.z - 0.02))]], 0.03, 10),
        mats.gun_machined)

    # 機関部の底から給弾機構の中へ下りる送り路。後座と一緒に動き、弾を1発ずつ機関部へ送り込む。
    shroud_y0, shroud_y1 = y1 - 0.44, y1 - 0.09
    add_mesh_obj("feed_throat_shroud", make_box(0.44, shroud_y1 - shroud_y0, 0.88,
        center=(conveyor_x, (shroud_y0 + shroud_y1) / 2, receiver_zc), bevel=0.02), mats.hull_dark, parent=recoil)
    add_mesh_obj("feed_chute_rails", make_boxes([
        (0.035, -0.74 - shroud_y1 + 0.04, 0.035, (conveyor_x + sx * 0.16, (shroud_y1 - 0.74) / 2, receiver_zc + sz * 0.40), (0, 0, 0))
        for sx in (-1, 1) for sz in (-1, 1)] + [
        (0.36, 0.03, 0.03, (conveyor_x, shroud_y1 + 0.02, receiver_zc + sz * 0.40), (0, 0, 0)) for sz in (-1, 1)], 0.006),
        mats.gun_machined, parent=recoil)
    first_round_y = shroud_y0 + 0.18
    conveyor = add_anchor("feed-conveyor", (conveyor_x, first_round_y, receiver_zc), direction=(0.0, 1.0, 0.0),
        parent=recoil, conveyorPitch=GUN_ROUND_PITCH)
    for k in range(4):
        add_gun_round(f"feed_conveyor_round_{k}", (conveyor_x, first_round_y + k * GUN_ROUND_PITCH, receiver_zc),
            mats, conveyor)


# 機関部底の排莢口と星形の排莢車、薬莢が滑り落ちる開いた排莢樋。
def build_gun_ejection(mats, recoil, breech_z, ejection_port):
    receiver_zc = (GUN_RECEIVER_BACK_Z + breech_z - 0.06) / 2
    add_mesh_obj("gun_ejection_port", make_box(0.42, 0.03, 0.76,
        center=(-0.62, -0.745, receiver_zc), bevel=0.008), mats.recessed, parent=recoil)
    rotor_center = (-0.60, -0.92, receiver_zc)
    rotor = add_anchor("eject-rotor", rotor_center, direction=(0.0, 0.0, 1.0), parent=recoil)
    add_gun_star_wheel("eject_rotor", rotor_center, 0.19, 0.70, 0.21, mats, rotor, (2, 3, 5), add_gun_spent_case)
    add_mesh_obj("gun_ejection_rotor_hangers", make_boxes([
        (0.12, 0.20, 0.05, (-0.60, -0.83, receiver_zc + dz), (0, 0, 0)) for dz in (-0.39, 0.39)], 0.008),
        mats.gun_panel, parent=recoil)

    # 排莢樋: 受け口から放出口まで下り勾配で -X へ伸び、天面は開けて薬莢を見せる。
    start = Vector((-0.86, -1.10, 0.0))
    end = Vector((ejection_port.x, ejection_port.y, 0.0))
    along = (end - start).normalized()
    up = Vector((-along.y, along.x, 0.0))
    if up.y < 0:
        up = -up
    length = (end - start).length
    angle = math.atan2(along.y, along.x)
    trough_z0, trough_z1 = -0.08, 1.10
    trough_zc = (trough_z0 + trough_z1) / 2
    def on_path(s, lift, z):
        p = start + along * s + up * lift
        return (p.x, p.y, z)
    trough = [
        (length + 0.14, 0.03, trough_z1 - trough_z0, on_path(length / 2 - 0.07, -0.015, trough_zc), (0, 0, angle)),
    ]
    for z in (trough_z0 + 0.02, trough_z1 - 0.02):
        trough.append((length + 0.14, 0.30, 0.04, on_path(length / 2 - 0.07, 0.15, z), (0, 0, angle)))
    add_mesh_obj("gun_ejection_trough", make_boxes(trough, 0.008), mats.gun_panel)
    add_mesh_obj("gun_ejection_guide_rods", make_pipes([
        [Vector(on_path(0.28, 0.27, z)), Vector(on_path(length - 0.30, 0.27, z))] for z in (0.22, 0.82)], 0.018, 10),
        mats.gun_machined)
    # 放出口の覆いと、口を塞ぐゴムのフラップ。
    hood_s0, hood_s1 = length - 0.34, length + 0.07
    add_mesh_obj("gun_ejection_hood", make_box(hood_s1 - hood_s0, 0.03, trough_z1 - trough_z0,
        center=on_path((hood_s0 + hood_s1) / 2, 0.30, trough_zc), rot_euler=(0, 0, angle), bevel=0.008), mats.gun_paint)
    add_mesh_obj("gun_ejection_flap", make_box(0.025, 0.30, trough_z1 - trough_z0 - 0.08,
        center=on_path(length + 0.06, 0.15, trough_zc), rot_euler=(0, 0, angle), bevel=0.006), mats.gun_rubber)
    # 樋を格子台座と給弾機構の角柱へ留める支え。
    girder_end = Vector((-1.12, -1.28, GUN_MOUNT_Z))
    add_mesh_obj("gun_ejection_brackets", make_pipes(
        [[Vector(on_path(0.55, -0.02, z)), girder_end] for z in (trough_z0 + 0.1, trough_z1 - 0.1)]
        + [[Vector(on_path(length - 0.10, -0.02, trough_z0 + 0.1)), girder_end]], 0.028, 10), mats.gun_machined)
    first_case = start + up * 0.13
    conveyor = add_anchor("eject-conveyor", (first_case.x, first_case.y, trough_zc), direction=(along.x, along.y, 0.0),
        conveyorPitch=GUN_CASING_PITCH)
    for k in range(5):
        p = first_case + along * (k * GUN_CASING_PITCH)
        add_gun_spent_case(f"eject_conveyor_case_{k}", (p.x, p.y, trough_zc), mats, conveyor)


# 結合面の台座、砲架、後座機関部、給弾機構、排莢機構を一つの武器原型へ組み上げる。
def build_weapon(name):
    reset_scene()
    mats = MaterialLibrary()
    add_gun_materials(mats)
    module = MANIFEST["modules"][name]
    muzzle = Vector(module["muzzles"][0])   # 砲口は機軸上の1点
    feed_port = Vector(module["feedPort"])  # 給弾ベルトが機体へ入る点
    ejection_port = Vector(module["ejectionPort"])  # 薬莢が放出される点

    # 頬板・軸受・案内レール・駐退シリンダー・機械室・給弾機構は台座へ固定し、機関部と砲身束・
    # 排莢車・弾の送り路は後座 anchor の子として、発射ごとに砲架へ沿って後退・復座する。
    breech_z = 1.20                    # 砲身束の尾端(回転部の根元)。ここから砲口までが露出砲身
    recoil = add_anchor("gun-recoil:0", (0.0, 0.0, 0.0), recoilTravel=GUN_RECOIL_TRAVEL)
    build_gun_mount_base(mats)
    build_gun_cradle(mats)
    build_gun_receiver(mats, recoil, breech_z)
    build_gun_recoil_cylinders(mats, recoil)
    build_gun_recoil_followers(mats, recoil, breech_z)
    build_gun_service_house(mats)
    build_gun_barrels(mats, recoil, breech_z, muzzle.z)
    build_gun_feed(mats, recoil, feed_port, breech_z)
    build_gun_ejection(mats, recoil, breech_z, ejection_port)

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
    build_dock_port("docking-port-standard", "docking_port")
    build_dock_port("dock-standard", "dock")
    build_decoupler("decoupler-standard")
    
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
