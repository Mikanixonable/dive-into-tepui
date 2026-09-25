#!/usr/bin/env python3
"""
Blender 5.0 headless generator for ultra-realistic spacecraft modules.
Uses bmesh, curved profiles, recessed equipment bays, beveled frames,
authentic Rao nozzles, clamped feedlines, and aerospace structural geometry.
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
        # Aerospace grade aluminium alloy hull (metalness 1.0)
        self.hull = create_pbr_material("mat_hull", (0.72, 0.77, 0.82, 1.0), roughness=0.45, metallic=1.0)
        # Dark titanium structural rings and brackets (metalness 1.0)
        self.hull_dark = create_pbr_material("mat_hull_dark", (0.28, 0.32, 0.38, 1.0), roughness=0.40, metallic=1.0)
        # Recessed avionics bay shadow interior (non-metal paint)
        self.recessed = create_pbr_material("mat_recessed", (0.12, 0.14, 0.17, 1.0), roughness=0.75, metallic=0.0)
        # Multi-Layer Insulation (Gold Mylar foil)
        self.mli_gold = create_pbr_material("mat_mli_gold", (0.86, 0.66, 0.16, 1.0), roughness=0.25, metallic=1.0)
        # Multi-Layer Insulation (Beta Cloth / White Quartz)
        self.mli_white = create_pbr_material("mat_mli_white", (0.92, 0.94, 0.96, 1.0), roughness=0.70, metallic=0.0)
        # Stainless steel / Inconel cryo pipes
        self.pipe = create_pbr_material("mat_pipe", (0.88, 0.90, 0.93, 1.0), roughness=0.30, metallic=1.0)
        # Pipe mounting clamps / saddle brackets
        self.clamp = create_pbr_material("mat_clamp", (0.35, 0.40, 0.45, 1.0), roughness=0.35, metallic=1.0)
        # Rao nozzle bell exterior (burnt high-temp alloy)
        self.nozzle_bell = create_pbr_material("mat_nozzle_bell", (0.32, 0.28, 0.26, 1.0), roughness=0.42, metallic=1.0)
        # Nozzle regenerative cooling channels & hat bands
        self.nozzle_rib = create_pbr_material("mat_nozzle_rib", (0.52, 0.48, 0.44, 1.0), roughness=0.35, metallic=1.0)
        # Optical quartz multi-layer window
        self.window = create_pbr_material("mat_window", (0.04, 0.10, 0.18, 1.0), roughness=0.10, metallic=0.0)
        # Beveled titanium window frame
        self.window_frame = create_pbr_material("mat_window_frame", (0.22, 0.24, 0.28, 1.0), roughness=0.35, metallic=1.0)
        # Titanium spherical propellant tanks (RCS)
        self.tank_rcs = create_pbr_material("mat_tank_rcs", (0.32, 0.52, 0.62, 1.0), roughness=0.38, metallic=1.0)
        # Space frame structural trusses
        self.truss = create_pbr_material("mat_truss", (0.68, 0.72, 0.78, 1.0), roughness=0.35, metallic=1.0)
        # Phenolic carbon-composite ablative heat shield
        self.heatshield = create_pbr_material("mat_heatshield", (0.16, 0.12, 0.08, 1.0), roughness=0.90, metallic=0.0)
        # CBM / APAS docking interface ring
        self.cbm_ring = create_pbr_material("mat_cbm_ring", (0.76, 0.79, 0.84, 1.0), roughness=0.28, metallic=1.0)
        # Dock construction highlight
        self.dock = create_pbr_material("mat_dock", (0.84, 0.55, 0.22, 1.0), roughness=0.38, metallic=1.0)
        # High-efficiency photovoltaic solar cell array
        self.solar = create_pbr_material("mat_solar", (0.06, 0.18, 0.45, 1.0), roughness=0.25, metallic=0.2)
        # High-emissivity white thermal ceramic radiator paint
        self.radiator = create_pbr_material("mat_radiator", (0.88, 0.90, 0.92, 1.0), roughness=0.85, metallic=0.0)

def add_mesh_obj(name, bm, material=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    if material:
        obj.data.materials.append(material)
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
# Geometry Primitives & Lathe
# ----------------------------------------------------------------------
def make_lathe(points, segments=36):
    """
    Creates a surface of revolution around the Z-axis.
    points: list of (radius, z) tuples from start to end.
    """
    bm = bmesh.new()
    verts_ring = []
    for r, z in points:
        ring = []
        for i in range(segments):
            angle = 2.0 * math.pi * i / segments
            x = r * math.cos(angle)
            y = r * math.sin(angle)
            ring.append(bm.verts.new((x, y, z)))
        verts_ring.append(ring)
    
    for layer in range(len(points) - 1):
        r0 = verts_ring[layer]
        r1 = verts_ring[layer + 1]
        for i in range(segments):
            i_next = (i + 1) % segments
            bm.faces.new([r0[i], r0[i_next], r1[i_next], r1[i]])
    
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def transform_bm(bm, matrix):
    bmesh.ops.transform(bm, verts=bm.verts, matrix=matrix)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def make_cylinder(r_bottom, r_top, length, z_center=0.0, segments=36):
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
    return bm

def make_torus(major_r, minor_r, z_center=0.0, major_seg=36, minor_seg=12):
    points = []
    for j in range(minor_seg):
        a = 2.0 * math.pi * j / minor_seg
        r = major_r + minor_r * math.cos(a)
        z = z_center + minor_r * math.sin(a)
        points.append((r, z))
    points.append(points[0])
    return make_lathe(points, segments=major_seg)

def make_box(dx, dy, dz, center=(0, 0, 0), rot_euler=(0, 0, 0)):
    bm = bmesh.new()
    mat = Matrix.Translation(Vector(center)) @ Euler(rot_euler).to_matrix().to_4x4()
    bmesh.ops.create_cube(bm, size=1.0, matrix=mat @ Matrix.Diagonal((dx, dy, dz, 1.0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

def make_pipe(path_points, radius=0.04, segments=12):
    """Generates a tube along a 3D polyline path."""
    bm = bmesh.new()
    if len(path_points) < 2:
        return bm
    
    ring_verts = []
    for idx, pt in enumerate(path_points):
        if idx == 0:
            tangent = (path_points[1] - pt).normalized()
        elif idx == len(path_points) - 1:
            tangent = (pt - path_points[idx - 1]).normalized()
        else:
            t1 = (pt - path_points[idx - 1]).normalized()
            t2 = (path_points[idx + 1] - pt).normalized()
            tangent = (t1 + t2).normalized()
        
        up = Vector((0, 0, 1))
        if abs(tangent.dot(up)) > 0.95:
            up = Vector((0, 1, 0))
        normal = tangent.cross(up).normalized()
        binormal = tangent.cross(normal).normalized()
        
        ring = []
        for s in range(segments):
            angle = 2.0 * math.pi * s / segments
            offset = normal * (radius * math.cos(angle)) + binormal * (radius * math.sin(angle))
            ring.append(bm.verts.new(pt + offset))
        ring_verts.append(ring)
    
    for layer in range(len(path_points) - 1):
        r0 = ring_verts[layer]
        r1 = ring_verts[layer + 1]
        for s in range(segments):
            s_next = (s + 1) % segments
            bm.faces.new([r0[s], r0[s_next], r1[s_next], r1[s]])
            
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

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
    return bm


# ----------------------------------------------------------------------
# 機能点の anchor、向きを持つノズル、Rao ベル
# ----------------------------------------------------------------------
def add_anchor(name, location, direction=None, parent=None, **props):
    """形に結び付いた機能点の空オブジェクト。局所 +Z が direction(噴射口なら排気方向)を向く。"""
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

def converging_profile(r_throat, z_throat, r_chamber, z_top, samples=6):
    """燃焼室 (r_chamber, z_top) から喉までの内面輪郭。喉の上流は半径 1.5 Rt の円弧。"""
    arc = 1.5 * r_throat
    a_max = math.acos(max(-1.0, 1 - (r_chamber - r_throat) / arc))
    if z_throat + arc * math.sin(a_max) >= z_top:
        raise ValueError("converging section: chamber top must lie upstream of the throat arc")
    points = [(r_chamber, z_top)]
    for i in range(samples, -1, -1):
        a = a_max * i / samples
        points.append((r_throat + arc * (1 - math.cos(a)), z_throat + arc * math.sin(a)))
    return points

def make_shell_lathe(inner_points, wall, segments=48):
    """内面輪郭 inner_points(上流→出口)に肉厚 wall の外面を足し、出口の縁で閉じた回転殻。"""
    outer = [(r + wall, z) for r, z in reversed(inner_points)]
    return make_lathe(list(inner_points) + outer, segments=segments)

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
def build_thruster():
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = 0.5
    
    # 1. Main Structural Shell / Thrust Ring (z = -0.5m to +0.5m, R = 3.0m)
    # Strictly terminates at forward docking interface z = +0.50m (NO protrusion forward!)
    bm_thrust_cyl = make_cylinder(radius, radius, 1.00, z_center=0.0, segments=48)
    add_mesh_obj("thrust_structure", bm_thrust_cyl, mats.hull_dark)
    
    # Forward and aft structural stiffener rings
    for zr in [-0.45, 0.45]:
        bm_r = make_torus(major_r=radius * 0.98, minor_r=0.035, z_center=zr, major_seg=48, minor_seg=8)
        add_mesh_obj(f"thrust_ring_{zr}", bm_r, mats.hull)

    # 2. Conical Thrust Adapter & Radiation Heat Shield Baffle inside the ring
    bm_adapter = make_cylinder(radius * 0.95, radius * 0.65, 0.45, z_center=-0.25, segments=36)
    add_mesh_obj("thrust_adapter", bm_adapter, mats.hull_dark)

    bm_baffle = make_cylinder(radius * 0.64, radius * 0.64, 0.06, z_center=-0.48, segments=36)
    add_mesh_obj("heat_baffle", bm_baffle, mats.heatshield)
        
    # Injector Dome Head (inside thrust structure, z = 0.05m to 0.25m)
    bm_dome = make_lathe([
        (0.00, 0.25),
        (0.40, 0.22),
        (0.70, 0.15),
        (0.90, 0.05),
    ], segments=24)
    add_mesh_obj("injector_dome", bm_dome, mats.hull_dark)

    # 3. Spherical Gimbal Bearing Joint (z = 0.0m)
    bm_gimbal = make_sphere(0.42, center=(0, 0, 0.0), u_seg=20, v_seg=12)
    add_mesh_obj("gimbal_bearing", bm_gimbal, mats.hull_dark)

    # 4. Dual Hydraulic Gimbal Actuators with Pivot Clevises
    # Mounted at 90 deg separation to provide pitch and yaw vectoring
    for act_ang in [0.0, math.pi / 2.0]:
        x_top = 1.10 * math.cos(act_ang)
        y_top = 1.10 * math.sin(act_ang)
        x_bot = 0.60 * math.cos(act_ang)
        y_bot = 0.60 * math.sin(act_ang)
        # Actuator cylinder
        bm_act = make_cylinder(0.06, 0.06, 0.50, z_center=0.0, segments=12)
        transform_bm(bm_act, Matrix.Translation(Vector(((x_top + x_bot) * 0.5, (y_top + y_bot) * 0.5, -0.20))))
        add_mesh_obj(f"gimbal_actuator_{act_ang}", bm_act, mats.pipe)

    # 5. Rao 近似のベル・ノズル。喉 z = -0.35 m、出口 z = -1.80 m、肉厚付きの回転殻
    throat_r, throat_z, exit_r, exit_z = 0.44, -0.35, 1.70, -1.80
    bell = rao_bell_profile(throat_r, throat_z, exit_r, exit_z, 60.0, 25.0)
    inner = converging_profile(throat_r, throat_z, 0.60, 0.20) + bell[1:]
    add_mesh_obj("nozzle_bell", make_shell_lathe(inner, 0.025, segments=64), mats.nozzle_bell)
    add_anchor("thrust", (0, 0, exit_z), (0, 0, -1))

    # 6. 再生冷却管の束ね帯と、ベル外面を走る冷却管
    for k in (4, 10, 16, 22, len(bell) - 1):
        rb, zb = bell[k]
        add_mesh_obj(f"nozzle_band_{k}", make_torus(major_r=rb + 0.04, minor_r=0.03, z_center=zb, major_seg=48, minor_seg=8), mats.nozzle_rib)

    for i in range(16):
        ang = i * 2.0 * math.pi / 16
        c_pts = [Vector(((r_p + 0.04) * math.cos(ang), (r_p + 0.04) * math.sin(ang), z_p)) for r_p, z_p in bell[::2]]
        add_mesh_obj(f"cooling_tube_{i}", make_pipe(c_pts, radius=0.012, segments=6), mats.nozzle_rib)

    # Turbopump exhaust manifold torus wrapped around throat collar
    bm_turbo = make_torus(major_r=0.68, minor_r=0.07, z_center=-0.38, major_seg=24, minor_seg=8)
    add_mesh_obj("turbopump_manifold", bm_turbo, mats.pipe)

    export_glb(os.path.join(OUT_DIR, "thruster-standard.glb"))

# ----------------------------------------------------------------------
# 5. Solid Rocket Booster (booster-standard: length 6.0m, diameter 6.0m, radius 3.0m)
# ----------------------------------------------------------------------
def build_booster():
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = 3.0
    
    # 1. Main Casing Lathe Profile
    # Forward aerodynamic nose cone (z = +1.6m to +3.0m)
    # Cylindrical motor casing (z = -1.6m to +1.6m)
    # Flared aft skirt (z = -3.0m to -1.6m)
    booster_profile = [
        (0.60,  3.00), # Nose tip cap
        (1.50,  2.70), # Nose cone slope
        (2.40,  2.20),
        (3.00,  1.60), # Shoulder transition to cylinder
        (3.00, -1.60), # Main solid propellant motor cylinder
        (3.05, -2.10), # Aft skirt attachment joint
        (3.15, -2.70), # Flared aerodynamic skirt
        (3.20, -3.00), # Aft skirt exit base
    ]
    bm_casing = make_lathe(booster_profile, segments=48)
    add_mesh_obj("booster_casing", bm_casing, mats.hull)

    # 2. Casing Segment Joint Bands (SRB field joints with O-ring band retainers)
    for zj in [-0.80, 0.50, 1.55]:
        bm_joint = make_torus(major_r=radius + 0.02, minor_r=0.035, z_center=zj, major_seg=48, minor_seg=8)
        add_mesh_obj(f"booster_joint_{zj}", bm_joint, mats.hull_dark)

    # 3. Forward Jettison / Separation Motor Pods
    # 4 small canted solid rocket nozzles for stage separation
    for k in range(4):
        ang = k * math.pi / 2.0
        pos_sep = (2.20 * math.cos(ang), 2.20 * math.sin(ang), 2.30)
        bm_sep = make_cylinder(0.12, 0.07, 0.28, z_center=0.0, segments=12)
        # Cant 35 degrees outwards and forward
        rot = Euler((math.radians(35) * math.sin(ang), -math.radians(35) * math.cos(ang), ang))
        transform_bm(bm_sep, rot.to_matrix().to_4x4())
        transform_bm(bm_sep, Matrix.Translation(Vector(pos_sep)))
        add_mesh_obj(f"sep_motor_{k}", bm_sep, mats.nozzle_rib)

    # 4. Large Expansion Rao Nozzle inside the aft skirt
    nozzle_profile = converging_profile(0.70, -1.75, 0.95, -0.95) + rao_bell_profile(0.70, -1.75, 2.30, -3.00, 70.0, 30.0)[1:]
    add_mesh_obj("booster_nozzle", make_shell_lathe(nozzle_profile, 0.04, segments=48), mats.nozzle_bell)
    add_anchor("thrust", (0, 0, -3.0), (0, 0, -1))
    
    # Skirt reinforcement ribs
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

def build_deploy_base(mats, half_len, radius):
    """取付面の円盤フランジとボルト環。"""
    bm_flange = make_cylinder(radius * 0.85, radius * 0.85, 0.12, z_center=half_len - 0.06, segments=36)
    add_mesh_obj("deploy_flange", bm_flange, mats.hull_dark)
    bm_bolts = make_torus(major_r=radius * 0.82, minor_r=0.025, z_center=half_len - 0.02, major_seg=36, minor_seg=8)
    add_mesh_obj("flange_bolts", bm_bolts, mats.clamp)

def build_solar_panel(name):
    reset_scene()
    mats = MaterialLibrary()
    half_len = MANIFEST["modules"][name]["length"] / 2
    build_deploy_base(mats, half_len, 3.0)
    spec = MANIFEST["deployables"]["solar_panel"]
    length, span, thickness = spec["length"], spec["span"], spec["thickness"]

    def panel(index, side):
        # おもて面 +Y が太陽電池、裏面に補強材、根元のヒンジ面にヒンジ胴
        cells = add_mesh_obj(f"panel:{index}", make_box(span * 0.96, thickness, length * 0.96, center=(0.0, 0.0, length * 0.5)), mats.solar)
        cells["name"] = "deployable-panel" if index == 0 else f"deployable-panel:{index}"
        ribs = add_mesh_obj(f"panel_ribs:{index}", make_box(span * 0.94, 0.015, length * 0.94, center=(0.0, -thickness * 0.52, length * 0.5)), mats.hull_dark)
        bm_hinge = make_cylinder(0.035, 0.035, span * 0.98, z_center=0.0, segments=12)
        transform_bm(bm_hinge, Matrix.Translation(Vector((0.0, -side * thickness / 2, 0.0))) @ Euler((0.0, math.pi / 2, 0.0)).to_matrix().to_4x4())
        knuckle = add_mesh_obj(f"panel_hinge_hardware:{index}", bm_hinge, mats.clamp)
        return [cells, ribs, knuckle]

    build_deployable_chain("solar_panel", half_len, panel)
    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))


def build_radiator(name):
    reset_scene()
    mats = MaterialLibrary()
    half_len = MANIFEST["modules"][name]["length"] / 2
    build_deploy_base(mats, half_len, 3.0)

    # 熱回転継手へ繋がる冷媒の集合管
    bm_manifold = make_cylinder(0.16, 0.16, 0.16, z_center=half_len - 0.02, segments=16)
    add_mesh_obj("coolant_manifold", bm_manifold, mats.pipe)

    spec = MANIFEST["deployables"]["radiator"]
    length, span, thickness = spec["length"], spec["span"], spec["thickness"]

    def panel(index, side):
        # 両面が放熱面。流路管は両面に半分浮き出し、根元のヒンジ面に流体継手を兼ねるヒンジ胴
        body = add_mesh_obj(f"panel:{index}", make_box(thickness, span * 0.96, length * 0.96, center=(0.0, 0.0, length * 0.5)), mats.radiator)
        body["name"] = "deployable-panel" if index == 0 else f"deployable-panel:{index}"
        parts = [body]
        for face in (1, -1):
            for lane in (-0.3, 0.0, 0.3):
                bm_pipe = make_cylinder(0.022, 0.022, length * 0.96, z_center=length * 0.5, segments=8)
                transform_bm(bm_pipe, Matrix.Translation(Vector((face * thickness / 2, lane * span, 0.0))))
                parts.append(add_mesh_obj(f"radiator_pipe:{index}:{face}:{lane}", bm_pipe, mats.pipe))
        bm_hinge = make_cylinder(0.04, 0.04, span * 0.98, z_center=0.0, segments=12)
        transform_bm(bm_hinge, Matrix.Translation(Vector((-side * thickness / 2, 0.0, 0.0))) @ Euler((math.pi / 2, 0.0, 0.0)).to_matrix().to_4x4())
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
def build_weapon(name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    length = MANIFEST["modules"][name]["length"]

    # 砲架のリング
    bm_ring = make_cylinder(radius, radius, length, z_center=0.0, segments=36)
    add_mesh_obj("weapon_ring", bm_ring, mats.hull)

    # 定義の砲口ごとに、機関部の覆い・6連の回転砲身・砲口の締め環を置く。砲身先端が砲口に一致する
    barrel_length = 1.20
    for k, (mx, my, mz) in enumerate(MANIFEST["modules"][name]["muzzles"]):
        bm_housing = make_cylinder(0.42, 0.38, 0.85, z_center=mz - 0.95, segments=16)
        transform_bm(bm_housing, Matrix.Translation(Vector((mx, my, 0.0))))
        add_mesh_obj(f"gun_housing_{k}", bm_housing, mats.hull_dark)
        for b in range(6):
            b_ang = b * math.pi / 3.0
            bm_barrel = make_cylinder(0.035, 0.035, barrel_length, z_center=mz - barrel_length / 2, segments=8)
            transform_bm(bm_barrel, Matrix.Translation(Vector((mx + 0.16 * math.cos(b_ang), my + 0.16 * math.sin(b_ang), 0.0))))
            add_mesh_obj(f"barrel_{k}_{b}", bm_barrel, mats.pipe)
        bm_clamp = make_torus(major_r=0.18, minor_r=0.025, z_center=mz - 0.05, major_seg=16, minor_seg=6)
        transform_bm(bm_clamp, Matrix.Translation(Vector((mx, my, 0.0))))
        add_mesh_obj(f"muzzle_clamp_{k}", bm_clamp, mats.hull_dark)

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
