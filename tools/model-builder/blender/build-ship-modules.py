#!/usr/bin/env python3
"""
Blender 5.0 headless generator for detailed spacecraft modules.
Uses bmesh, curved profiles, recessed equipment bays, thin-panel skins,
clamped feedlines, and aerospace structural geometry.
"""

import sys
import os
import math
import bpy
import bmesh
from mathutils import Vector, Matrix, Euler

OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "assets-src", "ship-modules"))
os.makedirs(OUT_DIR, exist_ok=True)

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in bpy.data.meshes: bpy.data.meshes.remove(block)
    for block in bpy.data.materials: bpy.data.materials.remove(block)
    for block in bpy.data.objects: bpy.data.objects.remove(block)

def create_pbr_material(name, base_color, roughness=0.5, metallic=0.0, transmission=0.0, ior=1.45):
    """Create a glTF-friendly Principled material.

    Keep the authoritative appearance in values that survive glTF export.
    Fine scratches, oxide mottling and cloth weave are represented by geometry
    or later runtime textures rather than unsupported Blender-only procedural nodes.
    """
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = base_color
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
        if "Transmission Weight" in bsdf.inputs:
            bsdf.inputs["Transmission Weight"].default_value = transmission
        if "IOR" in bsdf.inputs:
            bsdf.inputs["IOR"].default_value = ior
    return mat


class MaterialLibrary:
    """1960s crewed-spacecraft material vocabulary with a few future modules.

    Mercury/Gemini references are expressed primarily through material boundaries:
    oxidized nickel-alloy shingles, titanium structure, bare aluminium/beryllium
    panels, dark elastomer seals, glass, and ablative surfaces.  Generic aliases
    are kept because the remaining module builders still use them.
    """

    def __init__(self):
        # Oxidized Rene 41-like heat-resistant shingle skin: dark, metallic,
        # slightly uneven-looking rather than "black paint".
        self.rene41 = create_pbr_material(
            "mat_rene41_oxidized", (0.050, 0.058, 0.066, 1.0), roughness=0.48, metallic=1.0
        )
        self.rene41_alt = create_pbr_material(
            "mat_rene41_oxidized_alt", (0.075, 0.067, 0.064, 1.0), roughness=0.54, metallic=1.0
        )
        self.rene41_edge = create_pbr_material(
            "mat_rene41_exposed_edge", (0.27, 0.29, 0.31, 1.0), roughness=0.34, metallic=1.0
        )

        self.titanium = create_pbr_material(
            "mat_titanium_structure", (0.43, 0.46, 0.49, 1.0), roughness=0.38, metallic=1.0
        )
        self.aluminium = create_pbr_material(
            "mat_aluminium_rolled", (0.72, 0.75, 0.77, 1.0), roughness=0.44, metallic=1.0
        )
        self.beryllium = create_pbr_material(
            "mat_beryllium_skin", (0.56, 0.58, 0.57, 1.0), roughness=0.49, metallic=1.0
        )
        self.fastener = create_pbr_material(
            "mat_fastener", (0.21, 0.23, 0.25, 1.0), roughness=0.30, metallic=1.0
        )
        self.gasket = create_pbr_material(
            "mat_elastomer_gasket", (0.012, 0.014, 0.016, 1.0), roughness=0.82, metallic=0.0
        )
        self.recessed = create_pbr_material(
            "mat_recessed_equipment", (0.055, 0.060, 0.064, 1.0), roughness=0.76, metallic=0.0
        )
        self.window = create_pbr_material(
            "mat_window_glazing", (0.018, 0.028, 0.036, 1.0),
            roughness=0.055, metallic=0.0, transmission=0.08, ior=1.52
        )
        self.window_frame = create_pbr_material(
            "mat_window_frame_titanium", (0.24, 0.26, 0.27, 1.0), roughness=0.32, metallic=1.0
        )

        # Thermal/utility surfaces. Gold MLI is intentionally retained only as
        # an occasional service-bay/internal accent, not a dominant cabin skin.
        self.mli_gold = create_pbr_material(
            "mat_mli_gold", (0.78, 0.57, 0.10, 1.0), roughness=0.31, metallic=1.0
        )
        self.mli_white = create_pbr_material(
            "mat_white_thermal_fabric", (0.88, 0.89, 0.87, 1.0), roughness=0.82, metallic=0.0
        )

        self.pipe = create_pbr_material(
            "mat_stainless_tubing", (0.70, 0.72, 0.73, 1.0), roughness=0.31, metallic=1.0
        )
        self.clamp = create_pbr_material(
            "mat_pipe_clamp", (0.29, 0.31, 0.32, 1.0), roughness=0.37, metallic=1.0
        )
        self.nozzle_bell = create_pbr_material(
            "mat_ablative_nozzle", (0.18, 0.15, 0.13, 1.0), roughness=0.67, metallic=0.35
        )
        self.nozzle_rib = create_pbr_material(
            "mat_nozzle_hardware", (0.42, 0.40, 0.38, 1.0), roughness=0.38, metallic=1.0
        )
        self.tank_rcs = create_pbr_material(
            "mat_titanium_pressure_vessel", (0.42, 0.45, 0.46, 1.0), roughness=0.40, metallic=1.0
        )
        self.truss = create_pbr_material(
            "mat_titanium_truss", (0.52, 0.54, 0.55, 1.0), roughness=0.38, metallic=1.0
        )
        self.heatshield = create_pbr_material(
            "mat_ablation_heatshield", (0.105, 0.073, 0.050, 1.0), roughness=0.94, metallic=0.0
        )
        self.heatshield_char = create_pbr_material(
            "mat_ablation_char", (0.035, 0.028, 0.023, 1.0), roughness=0.98, metallic=0.0
        )
        self.cbm_ring = create_pbr_material(
            "mat_docking_hardware", (0.57, 0.59, 0.60, 1.0), roughness=0.31, metallic=1.0
        )
        self.dock = create_pbr_material(
            "mat_construction_marker", (0.72, 0.39, 0.10, 1.0), roughness=0.48, metallic=0.35
        )

        # Compatibility aliases used by non-cockpit builders.
        self.hull = self.aluminium
        self.hull_dark = self.titanium


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


def make_tangent_trapezoid(thickness, width_bottom, width_top, height, center, angle):
    """Thin trapezoidal plate tangent to a locally cylindrical surface.

    Local +X is radial, local Y is circumferential and local Z is axial.
    Use make_conical_trapezoid for large parts that span a changing radius.
    """
    bm = bmesh.new()
    x0 = -thickness * 0.5
    x1 = thickness * 0.5
    zb = -height * 0.5
    zt = height * 0.5
    verts = []
    for x in [x0, x1]:
        verts.extend([
            bm.verts.new((x, -width_bottom * 0.5, zb)),
            bm.verts.new((x,  width_bottom * 0.5, zb)),
            bm.verts.new((x,  width_top * 0.5, zt)),
            bm.verts.new((x, -width_top * 0.5, zt)),
        ])
    for face in [
        (0, 1, 2, 3), (4, 7, 6, 5),
        (0, 4, 5, 1), (1, 5, 6, 2),
        (2, 6, 7, 3), (3, 7, 4, 0),
    ]:
        bm.faces.new([verts[i] for i in face])
    mat = Matrix.Translation(Vector(center)) @ Euler((0, 0, angle)).to_matrix().to_4x4()
    transform_bm(bm, mat)
    return bm


def make_conical_trapezoid(
    thickness, width_bottom, width_top, z_bottom, z_top, radius_bottom, radius_top, angle
):
    """Trapezoidal plate that follows a conical/frustum surface.

    The bottom and top edges sit at independently specified radii. Widths are
    measured as local circumferential chord lengths, while thickness is radial.
    """
    bm = bmesh.new()
    radial = Vector((math.cos(angle), math.sin(angle), 0.0))
    tangent = Vector((-math.sin(angle), math.cos(angle), 0.0))
    verts = []
    for radial_offset in [-thickness * 0.5, thickness * 0.5]:
        rb = radius_bottom + radial_offset
        rt = radius_top + radial_offset
        verts.extend([
            bm.verts.new(radial * rb - tangent * (width_bottom * 0.5) + Vector((0, 0, z_bottom))),
            bm.verts.new(radial * rb + tangent * (width_bottom * 0.5) + Vector((0, 0, z_bottom))),
            bm.verts.new(radial * rt + tangent * (width_top * 0.5) + Vector((0, 0, z_top))),
            bm.verts.new(radial * rt - tangent * (width_top * 0.5) + Vector((0, 0, z_top))),
        ])
    for face in [
        (0, 1, 2, 3), (4, 7, 6, 5),
        (0, 4, 5, 1), (1, 5, 6, 2),
        (2, 6, 7, 3), (3, 7, 4, 0),
    ]:
        bm.faces.new([verts[i] for i in face])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def radius_at_profile(profile, z):
    """Linearly interpolate a lathed profile radius at axial coordinate z."""
    if z <= profile[0][1]:
        return profile[0][0]
    if z >= profile[-1][1]:
        return profile[-1][0]
    for index in range(len(profile) - 1):
        r0, z0 = profile[index]
        r1, z1 = profile[index + 1]
        if z0 <= z <= z1:
            fraction = (z - z0) / (z1 - z0)
            return r0 + (r1 - r0) * fraction
    raise ValueError(f"z outside profile: {z}")


def add_lowpoly_fastener(name, center, material, radius=0.016):
    bm = make_sphere(radius, center=center, u_seg=8, v_seg=5)
    return add_mesh_obj(name, bm, material)


def add_radial_shingle_skin(mats, bands, sectors=18):
    """Add overlapping Mercury/Gemini-like heat-resistant outer shingles.

    bands contains (z0, z1, r0, r1). Each panel follows the changing hull radius
    instead of approximating a conical band with a constant-radius flat plate.
    """
    dtheta = 2.0 * math.pi / sectors
    axial_gap = 0.012
    for b, (z0, z1, r0, r1) in enumerate(bands):
        panel_z0 = z0 + axial_gap
        panel_z1 = z1 - axial_gap
        span = z1 - z0
        bottom_fraction = (panel_z0 - z0) / span
        top_fraction = (panel_z1 - z0) / span
        panel_r0 = r0 + (r1 - r0) * bottom_fraction + 0.010
        panel_r1 = r0 + (r1 - r0) * top_fraction + 0.010
        width0 = 2.0 * panel_r0 * math.sin(dtheta * 0.5) * 0.955
        width1 = 2.0 * panel_r1 * math.sin(dtheta * 0.5) * 0.955
        for i in range(sectors):
            ang = i * dtheta + (0.5 * dtheta if b % 2 else 0.0)
            mat = mats.rene41 if (i + b) % 4 else mats.rene41_alt
            plate = make_conical_trapezoid(
                0.022, width0, width1, panel_z0, panel_z1, panel_r0, panel_r1, ang
            )
            add_mesh_obj(f"heat_shingle_{b}_{i}", plate, mat)


# ----------------------------------------------------------------------
# 1. Cockpit Module (cockpit-standard: catalog length 3m, diameter 6m)
# Mercury/Gemini visual language: dark heat-resistant shingles, mechanical
# hatch/window hardware, small recessed RCS jets and a compact docking collar.
# ----------------------------------------------------------------------
def build_cockpit():
    reset_scene()
    mats = MaterialLibrary()

    half_len = 1.50

    # Pressure-vessel / primary shape.  Keep the authoritative solid within the
    # catalog's 3 m axial envelope; only tiny hardware may project beyond it.
    profile = [
        (2.92, -1.43),
        (3.00, -1.32),
        (2.98, -0.95),
        (2.90, -0.35),
        (2.70,  0.28),
        (2.38,  0.82),
        (1.98,  1.22),
        (1.73,  1.43),
    ]
    add_mesh_obj("cockpit_pressure_shell", make_lathe(profile, segments=64), mats.titanium)

    # Aft ablative shield: shallow, visibly separate, and darker at the centre.
    shield = make_lathe([
        (0.00, -1.49),
        (1.10, -1.485),
        (2.15, -1.465),
        (2.82, -1.415),
        (2.94, -1.37),
    ], segments=56)
    add_mesh_obj("cockpit_heatshield", shield, mats.heatshield)
    char_disc = make_cylinder(1.05, 1.05, 0.018, z_center=-1.498, segments=40)
    add_mesh_obj("cockpit_heatshield_char", char_disc, mats.heatshield_char)

    # Heat-resistant shingle skin.  This replaces the previous single silver
    # surface and the unrealistic external circumferential frame ribs.
    add_radial_shingle_skin(mats, [
        (-1.30, -0.88, 2.98, 2.97),
        (-0.88, -0.38, 2.97, 2.91),
        (-0.38,  0.16, 2.91, 2.75),
        ( 0.16,  0.68, 2.75, 2.47),
        ( 0.68,  1.10, 2.47, 2.08),
        ( 1.10,  1.38, 2.08, 1.78),
    ], sectors=18)

    # Exposed aft and forward metal transition strips.
    for z, r in [(-1.31, 2.96), (1.39, 1.76)]:
        add_mesh_obj(
            f"transition_strip_{z}",
            make_torus(major_r=r, minor_r=0.025, z_center=z, major_seg=48, minor_seg=8),
            mats.rene41_edge,
        )

    # Twin Gemini-like side hatches integrated into the shingle field.
    # Large hatch/window parts follow the conical hull rather than floating on a
    # constant-radius tangent plane.
    for sign in [-1.0, 1.0]:
        ang = math.pi * 0.5 + sign * math.radians(22.0)
        radial = Vector((math.cos(ang), math.sin(ang), 0.0))
        tangent = Vector((-math.sin(ang), math.cos(ang), 0.0))

        hatch_z0 = -0.30
        hatch_z1 = 0.98
        hatch_r0 = radius_at_profile(profile, hatch_z0) + 0.020
        hatch_r1 = radius_at_profile(profile, hatch_z1) + 0.020
        hatch = make_conical_trapezoid(
            0.050, 1.08, 0.90, hatch_z0, hatch_z1, hatch_r0, hatch_r1, ang
        )
        add_mesh_obj(f"crew_hatch_{sign}", hatch, mats.rene41_alt)

        # Window stack follows the same local hull slope, with each layer moved
        # radially outward only by its physical stand-off.
        window_z0 = 0.43
        window_z1 = 0.91
        window_r0 = radius_at_profile(profile, window_z0)
        window_r1 = radius_at_profile(profile, window_z1)
        gasket = make_conical_trapezoid(
            0.036, 0.72, 0.58, window_z0, window_z1,
            window_r0 + 0.045, window_r1 + 0.045, ang
        )
        add_mesh_obj(f"window_gasket_{sign}", gasket, mats.gasket)

        frame_z0 = 0.46
        frame_z1 = 0.88
        frame = make_conical_trapezoid(
            0.030, 0.65, 0.51, frame_z0, frame_z1,
            radius_at_profile(profile, frame_z0) + 0.070,
            radius_at_profile(profile, frame_z1) + 0.070,
            ang,
        )
        add_mesh_obj(f"window_frame_{sign}", frame, mats.window_frame)

        glass_z0 = 0.515
        glass_z1 = 0.825
        glass = make_conical_trapezoid(
            0.018, 0.53, 0.41, glass_z0, glass_z1,
            radius_at_profile(profile, glass_z0) + 0.090,
            radius_at_profile(profile, glass_z1) + 0.090,
            ang,
        )
        add_mesh_obj(f"window_glass_{sign}", glass, mats.window)

        # Six compact external latch/fastener heads around the hatch perimeter.
        for k, (dy, z) in enumerate([
            (-0.45, -0.09), (0.45, -0.09),
            (-0.49,  0.34), (0.49,  0.34),
            (-0.34,  0.78), (0.34,  0.78),
        ]):
            p = (
                radial * (radius_at_profile(profile, z) + 0.058)
                + tangent * dy
                + Vector((0, 0, z))
            )
            add_lowpoly_fastener(f"hatch_latch_{sign}_{k}", p, mats.fastener, radius=0.022)

    # Compact rendezvous optical sight hood on the dorsal forward quadrant.
    sight_ang = math.pi * 0.5
    sight_z0 = 0.80
    sight_z1 = 1.16
    sight = make_conical_trapezoid(
        0.11, 0.32, 0.25, sight_z0, sight_z1,
        radius_at_profile(profile, sight_z0) + 0.045,
        radius_at_profile(profile, sight_z1) + 0.045,
        sight_ang,
    )
    add_mesh_obj("rendezvous_sight_hood", sight, mats.titanium)
    glass_z0 = 0.90
    glass_z1 = 1.10
    add_mesh_obj(
        "rendezvous_sight_glass",
        make_conical_trapezoid(
            0.022, 0.20, 0.16, glass_z0, glass_z1,
            radius_at_profile(profile, glass_z0) + 0.105,
            radius_at_profile(profile, glass_z1) + 0.105,
            sight_ang,
        ),
        mats.window,
    )

    # Recessed RCS jets: small dark wells with short ablative nozzles rather than
    # modern external quad boxes. Two axial bands give translation/attitude cues.
    for band, z_rcs in enumerate([-0.88, 1.05]):
        count = 8
        for i in range(count):
            ang = i * 2.0 * math.pi / count + (math.pi / count if band else 0.0)
            radial = Vector((math.cos(ang), math.sin(ang), 0.0))
            z0 = z_rcs - 0.10
            z1 = z_rcs + 0.10
            well = make_conical_trapezoid(
                0.035, 0.22, 0.22, z0, z1,
                radius_at_profile(profile, z0) + 0.018,
                radius_at_profile(profile, z1) + 0.018,
                ang,
            )
            add_mesh_obj(f"rcs_recess_{band}_{i}", well, mats.recessed)
            nozzle_radius = radius_at_profile(profile, z_rcs) + 0.075
            nozzle_pos = radial * nozzle_radius + Vector((0, 0, z_rcs))
            nozzle = make_cylinder(0.046, 0.026, 0.075, z_center=0, segments=10)
            # Cylinder local Z -> radial direction.
            q = Vector((0, 0, 1)).rotation_difference(radial)
            transform_bm(nozzle, q.to_matrix().to_4x4())
            transform_bm(nozzle, Matrix.Translation(nozzle_pos))
            add_mesh_obj(f"rcs_nozzle_{band}_{i}", nozzle, mats.nozzle_bell)

    # Forward docking collar: intentionally much smaller and more mechanical
    # than a CBM/APAS ring, with visible capture latches and connector blocks.
    collar_r = 1.72
    add_mesh_obj(
        "cockpit_docking_collar",
        make_cylinder(collar_r, collar_r, 0.12, z_center=1.43, segments=48),
        mats.titanium,
    )
    add_mesh_obj(
        "cockpit_docking_contact_ring",
        make_torus(collar_r * 0.88, 0.055, z_center=1.495, major_seg=48, minor_seg=10),
        mats.rene41_edge,
    )
    for i in range(6):
        ang = i * math.pi / 3.0
        p = (1.38 * math.cos(ang), 1.38 * math.sin(ang), 1.485)
        latch = make_box(0.13, 0.25, 0.08, center=p, rot_euler=(0, 0, ang))
        add_mesh_obj(f"docking_latch_{i}", latch, mats.fastener)

    export_glb(os.path.join(OUT_DIR, "cockpit-standard.glb"))


# ----------------------------------------------------------------------
# 2. Main Propellant Tanks (tank-3-main, tank-6-main, tank-12-main)
# Early-spaceflight service-module language: thin removable skin panels,
# restrained external plumbing, compact umbilicals and visible fasteners.
# ----------------------------------------------------------------------
def build_tank_main(length, name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = length / 2.0

    # Structural pressure shell sits slightly below the removable exterior skin.
    add_mesh_obj(
        "tank_pressure_shell",
        make_cylinder(radius * 0.965, radius * 0.965, length * 0.97, z_center=0.0, segments=48),
        mats.titanium,
    )

    # Longitudinal removable sheet-metal panels.  Real visual richness comes from
    # panel boundaries and material changes rather than arbitrary protrusions.
    sector_count = 12
    bay_count = max(2, int(math.ceil(length / 1.5)))
    dz = length / bay_count
    dtheta = 2.0 * math.pi / sector_count
    panel_r = radius * 0.985
    for bay in range(bay_count):
        z0 = -half_len + bay * dz
        z1 = min(half_len, z0 + dz)
        zc = (z0 + z1) * 0.5
        h = max(0.10, (z1 - z0) - 0.035)
        for i in range(sector_count):
            # Reserve a narrow +X service corridor for plumbing and access.
            if i in (0, sector_count - 1):
                continue
            ang = i * dtheta
            chord = 2.0 * panel_r * math.sin(dtheta * 0.5) * 0.965
            mat = mats.aluminium if (bay + i) % 5 else mats.beryllium
            panel = make_box(
                0.030, chord, h,
                center=((panel_r + 0.010) * math.cos(ang), (panel_r + 0.010) * math.sin(ang), zc),
                rot_euler=(0, 0, ang),
            )
            add_mesh_obj(f"tank_skin_panel_{bay}_{i}", panel, mat)

    # Structural bulkhead bands.  Keep the exact semantic mesh name required by
    # the asset contract; subsequent duplicate names may receive Blender suffixes.
    band_count = 1 if length <= 3.5 else (2 if length <= 6.5 else 4)
    step = length / (band_count + 1)
    for b in range(band_count):
        zb = -half_len + step * (b + 1)
        add_mesh_obj(
            "tank-band",
            make_torus(major_r=radius * 0.984, minor_r=0.026, z_center=zb, major_seg=48, minor_seg=8),
            mats.titanium,
        )

    # Recessed service corridor on +X: dark backplane with restrained feed line,
    # valve blocks, clamps and electrical/pressure connectors.
    corridor_h = max(0.60, length - 0.40)
    add_mesh_obj(
        "service_corridor",
        make_box(0.035, 0.64, corridor_h, center=(radius * 0.965, 0.0, 0.0)),
        mats.recessed,
    )

    pipe_x = radius * 0.995
    feedline_points = [
        Vector((pipe_x, -0.13, -half_len + 0.18)),
        Vector((pipe_x + 0.06, -0.13, -half_len + 0.35)),
        Vector((pipe_x + 0.06, -0.13,  half_len - 0.35)),
        Vector((pipe_x, -0.13, half_len - 0.18)),
    ]
    add_mesh_obj("cryo_feedline", make_pipe(feedline_points, radius=0.045, segments=12), mats.pipe)

    # Parallel smaller pressurization/sensor line.
    sense_points = [
        Vector((pipe_x + 0.02, 0.17, -half_len + 0.28)),
        Vector((pipe_x + 0.02, 0.17,  half_len - 0.28)),
    ]
    add_mesh_obj("pressurization_line", make_pipe(sense_points, radius=0.020, segments=10), mats.pipe)

    clamp_step = 0.75
    clamp_num = max(1, int((length - 0.55) / clamp_step))
    for cidx in range(clamp_num):
        zc = -half_len + 0.38 + cidx * clamp_step
        if zc > half_len - 0.32:
            break
        add_mesh_obj(
            f"feedline_clamp_{cidx}",
            make_box(0.075, 0.42, 0.075, center=(pipe_x + 0.02, -0.03, zc)),
            mats.clamp,
        )
        for sy in [-0.20, 0.20]:
            add_lowpoly_fastener(
                f"feedline_fastener_{cidx}_{sy}",
                (pipe_x + 0.065, sy, zc),
                mats.fastener,
                radius=0.014,
            )

    # Mid-body valve/umbilical cluster with deliberately different materials.
    add_mesh_obj(
        "feedline_valve_body",
        make_box(0.18, 0.24, 0.24, center=(radius * 1.015, -0.13, 0.0)),
        mats.titanium,
    )
    for y, r_conn in [(-0.22, 0.055), (0.02, 0.045), (0.20, 0.035)]:
        connector = make_cylinder(r_conn, r_conn, 0.09, z_center=0.0, segments=12)
        q = Vector((0, 0, 1)).rotation_difference(Vector((1, 0, 0)))
        transform_bm(connector, q.to_matrix().to_4x4())
        transform_bm(connector, Matrix.Translation(Vector((radius * 1.025, y, 0.20))))
        add_mesh_obj(f"umbilical_connector_{y}", connector, mats.fastener)

    # End collars and torispherical hints, kept inside the connection envelope.
    for sign in [-1.0, 1.0]:
        z = sign * (half_len - 0.055)
        add_mesh_obj(
            f"tank_end_rim_{sign}",
            make_torus(major_r=radius * 0.91, minor_r=0.045, z_center=z, major_seg=44, minor_seg=8),
            mats.titanium,
        )

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))


# ----------------------------------------------------------------------
# 3. RCS Propellant Tanks (tank-3-rcs, tank-6-rcs, tank-12-rcs)
# Semi-enclosed service module: most pressure vessels are protected by a skin,
# with two open maintenance bays revealing tanks, valves and cross-feed plumbing.
# ----------------------------------------------------------------------
def build_tank_rcs(length, name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0
    half_len = length / 2.0

    # End frames and hidden internal longitudinal structure.
    ring_count = max(3, int(length / 1.5) + 1)
    z_step = length / (ring_count - 1)
    for r_idx in range(ring_count):
        zr = -half_len + r_idx * z_step
        add_mesh_obj(
            f"rcs_frame_ring_{r_idx}",
            make_torus(major_r=radius * 0.95, minor_r=0.035, z_center=zr, major_seg=40, minor_seg=8),
            mats.titanium,
        )

    # Mostly closed exterior panels; +X and -X sectors remain open as service bays.
    sectors = 10
    dtheta = 2.0 * math.pi / sectors
    panel_r = radius * 0.975
    for i in range(sectors):
        ang = i * dtheta
        if abs(math.cos(ang)) > 0.80:
            continue
        chord = 2.0 * panel_r * math.sin(dtheta * 0.5) * 0.94
        panel = make_box(
            0.032, chord, max(0.10, length - 0.12),
            center=((panel_r + 0.010) * math.cos(ang), (panel_r + 0.010) * math.sin(ang), 0.0),
            rot_euler=(0, 0, ang),
        )
        add_mesh_obj(f"rcs_outer_panel_{i}", panel, mats.aluminium if i % 2 else mats.beryllium)

    # Dark recessed service-bay backplanes emphasize depth.
    for sign in [-1.0, 1.0]:
        add_mesh_obj(
            f"rcs_service_bay_{sign}",
            make_box(0.035, 1.18, max(0.30, length - 0.28), center=(sign * radius * 0.935, 0.0, 0.0)),
            mats.recessed,
        )

    # Titanium propellant spheres live inside the envelope, visible only through
    # the two service corridors.  Keep them neutral metal instead of bright blue.
    axial_sections = max(1, int(math.ceil(length / 2.4)))
    section_step = length / (axial_sections + 1)
    sphere_radius = 0.66
    for sec in range(axial_sections):
        z_sec = -half_len + (sec + 1) * section_step
        for side in [-1.0, 1.0]:
            tx = side * 1.70
            ty = 0.0
            add_mesh_obj(
                f"rcs_pressure_vessel_{sec}_{side}",
                make_sphere(sphere_radius, center=(tx, ty, z_sec), u_seg=24, v_seg=16),
                mats.tank_rcs,
            )
            vessel_weld = make_torus(
                major_r=sphere_radius, minor_r=0.012, z_center=z_sec, major_seg=28, minor_seg=6
            )
            transform_bm(vessel_weld, Matrix.Translation(Vector((tx, ty, 0.0))))
            add_mesh_obj(f"rcs_vessel_weld_{sec}_{side}", vessel_weld, mats.fastener)
            # Short branch line from vessel to centre manifold.
            add_mesh_obj(
                f"rcs_branch_{sec}_{side}",
                make_pipe([
                    Vector((side * 1.05, 0.0, z_sec)),
                    Vector((side * 0.15, 0.0, z_sec)),
                ], radius=0.032, segments=10),
                mats.pipe,
            )

    # Central manifold and compact valve blocks.
    add_mesh_obj(
        "manifold_spine",
        make_pipe([
            Vector((0, 0, -half_len + 0.16)),
            Vector((0, 0, half_len - 0.16)),
        ], radius=0.060, segments=12),
        mats.pipe,
    )
    for sec in range(axial_sections):
        z_sec = -half_len + (sec + 1) * section_step
        add_mesh_obj(
            f"rcs_valve_block_{sec}",
            make_box(0.24, 0.32, 0.18, center=(0.0, 0.0, z_sec)),
            mats.titanium,
        )

    for sign in [-1.0, 1.0]:
        add_mesh_obj(
            f"rcs_end_{sign}",
            make_torus(major_r=radius * 0.90, minor_r=0.050, z_center=sign * (half_len - 0.045), major_seg=40, minor_seg=8),
            mats.titanium,
        )

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))


# ----------------------------------------------------------------------
# 4. Main Thruster (thruster-standard: catalog body length 1m)
# The mount stays inside ±0.5m; the nozzle intentionally projects aft.
# Visual language is closer to compact early pressure-fed/hypergolic hardware
# than to a modern high-area-ratio cryogenic engine.
# ----------------------------------------------------------------------
def build_thruster():
    reset_scene()
    mats = MaterialLibrary()

    # Mounting/thrust structure inside the module envelope.
    add_mesh_obj(
        "thrust_structure",
        make_cylinder(1.45, 1.45, 0.42, z_center=0.28, segments=40),
        mats.titanium,
    )
    for zr in [0.11, 0.43]:
        add_mesh_obj(
            f"thrust_mount_ring_{zr}",
            make_torus(major_r=1.43, minor_r=0.032, z_center=zr, major_seg=40, minor_seg=8),
            mats.fastener,
        )

    # Injector dome and valve block.
    add_mesh_obj(
        "injector_dome",
        make_lathe([
            (0.00, 0.24),
            (0.38, 0.22),
            (0.62, 0.15),
            (0.74, 0.06),
        ], segments=32),
        mats.titanium,
    )
    add_mesh_obj(
        "engine_valve_block",
        make_box(0.62, 0.48, 0.24, center=(0.0, 0.0, 0.37)),
        mats.recessed,
    )

    # Compact spherical gimbal bearing.
    add_mesh_obj("gimbal_bearing", make_sphere(0.25, center=(0, 0, 0.02), u_seg=20, v_seg=12), mats.fastener)

    # Ablative bell; less exaggerated than the former 3.5 m-long modern Rao unit.
    bell_points = [
        (0.31,  0.10),
        (0.29,  0.04),
        (0.34, -0.08),
        (0.46, -0.28),
        (0.64, -0.52),
        (0.86, -0.77),
        (1.08, -1.00),
    ]
    add_mesh_obj("nozzle_bell", make_lathe(bell_points, segments=48), mats.nozzle_bell)

    # Bell retaining/stiffener bands and a metallic exit lip.
    for z, r in [(-0.30, 0.47), (-0.58, 0.69), (-0.82, 0.90)]:
        add_mesh_obj(
            f"nozzle_retainer_{z}",
            make_torus(major_r=r, minor_r=0.018, z_center=z, major_seg=40, minor_seg=6),
            mats.nozzle_rib,
        )
    add_mesh_obj(
        "nozzle_exit_lip",
        make_torus(major_r=1.08, minor_r=0.028, z_center=-1.00, major_seg=48, minor_seg=8),
        mats.nozzle_rib,
    )

    # Two large propellant feeds and two smaller control/pressurization lines.
    feed_paths = [
        [Vector((0.95, 0.25, 0.45)), Vector((0.72, 0.20, 0.18)), Vector((0.46, 0.14, 0.02))],
        [Vector((-0.95, -0.25, 0.45)), Vector((-0.72, -0.20, 0.18)), Vector((-0.46, -0.14, 0.02))],
    ]
    for i, pts in enumerate(feed_paths):
        add_mesh_obj(f"main_feed_{i}", make_pipe(pts, radius=0.055, segments=12), mats.pipe)
    for i, y in enumerate([-0.46, 0.46]):
        add_mesh_obj(
            f"control_line_{i}",
            make_pipe([
                Vector((0.62, y, 0.44)),
                Vector((0.46, y * 0.72, 0.16)),
                Vector((0.34, y * 0.45, -0.02)),
            ], radius=0.022, segments=10),
            mats.pipe,
        )

    # Two-axis gimbal actuators represented as actual endpoint-to-endpoint rods.
    for i, (top, bottom) in enumerate([
        (Vector((0.88, 0.0, 0.42)), Vector((0.34, 0.0, -0.10))),
        (Vector((0.0, 0.88, 0.42)), Vector((0.0, 0.34, -0.10))),
    ]):
        add_mesh_obj(f"gimbal_actuator_{i}", make_pipe([top, bottom], radius=0.045, segments=12), mats.pipe)
        add_lowpoly_fastener(f"gimbal_pivot_top_{i}", top, mats.fastener, radius=0.055)
        add_lowpoly_fastener(f"gimbal_pivot_bottom_{i}", bottom, mats.fastener, radius=0.050)

    export_glb(os.path.join(OUT_DIR, "thruster-standard.glb"))


# ----------------------------------------------------------------------
# 5. Solid Rocket Booster (booster-standard: catalog length 6m)
# Early large solid-stage cues: segmented steel case, modest ogive cap,
# service conduit, separation motors and a dark ablative nozzle.
# ----------------------------------------------------------------------
def build_booster():
    reset_scene()
    mats = MaterialLibrary()
    radius = 1.75
    half_len = 3.00

    booster_profile = [
        (0.26,  3.00),
        (0.78,  2.78),
        (1.34,  2.42),
        (1.68,  2.05),
        (1.75,  1.82),
        (1.75, -1.92),
        (1.80, -2.20),
        (1.91, -2.72),
        (1.94, -3.00),
    ]
    add_mesh_obj("booster_casing", make_lathe(booster_profile, segments=56), mats.aluminium)

    # Field-joint / segment bands.
    for zj in [-1.15, -0.10, 0.95, 1.80]:
        add_mesh_obj(
            f"booster_joint_{zj}",
            make_torus(major_r=radius + 0.012, minor_r=0.030, z_center=zj, major_seg=44, minor_seg=8),
            mats.titanium,
        )

    # Longitudinal instrumentation/service conduit with bolted covers.
    add_mesh_obj(
        "booster_service_conduit",
        make_box(0.055, 0.30, 3.70, center=(radius * 0.992, 0.0, 0.05)),
        mats.titanium,
    )
    for k in range(7):
        z = -1.45 + k * 0.50
        add_lowpoly_fastener(
            f"booster_conduit_fastener_{k}",
            (radius * 1.015, 0.0, z),
            mats.fastener,
            radius=0.016,
        )

    # Four canted separation motors near the forward shoulder.
    for k in range(4):
        ang = k * math.pi / 2.0
        radial = Vector((math.cos(ang), math.sin(ang), 0.0))
        pos = radial * 1.60 + Vector((0, 0, 2.17))
        nozzle = make_cylinder(0.090, 0.048, 0.23, z_center=0.0, segments=12)
        direction = (radial * 0.72 + Vector((0, 0, 0.69))).normalized()
        q = Vector((0, 0, 1)).rotation_difference(direction)
        transform_bm(nozzle, q.to_matrix().to_4x4())
        transform_bm(nozzle, Matrix.Translation(pos))
        add_mesh_obj(f"sep_motor_{k}", nozzle, mats.nozzle_bell)

    # Aft skirt and ablative nozzle.
    nozzle_profile = [
        (0.38, -1.88),
        (0.47, -2.08),
        (0.66, -2.35),
        (0.91, -2.67),
        (1.15, -2.95),
    ]
    add_mesh_obj("booster_nozzle", make_lathe(nozzle_profile, segments=44), mats.nozzle_bell)
    add_mesh_obj(
        "booster_nozzle_lip",
        make_torus(major_r=1.15, minor_r=0.028, z_center=-2.95, major_seg=44, minor_seg=8),
        mats.nozzle_rib,
    )
    for i in range(8):
        ang = i * math.pi / 4.0
        add_mesh_obj(
            f"skirt_rib_{i}",
            make_box(
                0.055, 0.14, 0.76,
                center=(1.86 * math.cos(ang), 1.86 * math.sin(ang), -2.55),
                rot_euler=(0, 0, ang),
            ),
            mats.titanium,
        )

    export_glb(os.path.join(OUT_DIR, "booster-standard.glb"))


# ----------------------------------------------------------------------
# 6. RCS Module (rcs-standard: catalog length 1m)
# Compact annular control package with recessed jets and exposed manifold detail.
# ----------------------------------------------------------------------
def build_rcs_module():
    reset_scene()
    mats = MaterialLibrary()
    radius = 1.12
    half_len = 0.50

    # Thin equipment drum with removable skin sectors.
    add_mesh_obj(
        "rcs_core",
        make_cylinder(radius * 0.84, radius * 0.84, 0.90, z_center=0.0, segments=36),
        mats.titanium,
    )
    for sign in [-1.0, 1.0]:
        add_mesh_obj(
            f"rcs_end_ring_{sign}",
            make_torus(major_r=radius * 0.91, minor_r=0.035, z_center=sign * 0.455, major_seg=36, minor_seg=8),
            mats.fastener,
        )

    # Eight removable panels; cardinal sectors become recessed thruster stations.
    sectors = 8
    dtheta = 2.0 * math.pi / sectors
    for i in range(sectors):
        # Cardinal sectors are open thruster bays, not covered access panels.
        if i % 2 == 0:
            continue
        ang = i * dtheta
        chord = 2.0 * radius * math.sin(dtheta * 0.5) * 0.88
        radial = Vector((math.cos(ang), math.sin(ang), 0.0))
        centre = radial * (radius * 0.92)
        add_mesh_obj(
            f"rcs_access_panel_{i}",
            make_box(0.030, chord, 0.79, center=centre, rot_euler=(0, 0, ang)),
            mats.aluminium,
        )

    # Four deeply recessed control stations.  Each has paired radial jets and
    # two axial jets, producing a dense but believable valve/nozzle cluster.
    for i in range(4):
        ang = i * math.pi / 2.0
        radial = Vector((math.cos(ang), math.sin(ang), 0.0))
        tangent = Vector((-math.sin(ang), math.cos(ang), 0.0))
        bay_center = radial * (radius * 0.955)
        add_mesh_obj(
            f"rcs_thruster_bay_{i}",
            make_tangent_trapezoid(0.040, 0.38, 0.38, 0.56, bay_center, ang),
            mats.recessed,
        )

        directions = [
            (radial + tangent * 0.42).normalized(),
            (radial - tangent * 0.42).normalized(),
            (radial + Vector((0, 0, 0.55))).normalized(),
            (radial + Vector((0, 0, -0.55))).normalized(),
        ]
        offsets = [
            tangent * 0.10 + Vector((0, 0, 0.11)),
            -tangent * 0.10 + Vector((0, 0, 0.11)),
            tangent * 0.10 + Vector((0, 0, -0.12)),
            -tangent * 0.10 + Vector((0, 0, -0.12)),
        ]
        for j, (direction, offset) in enumerate(zip(directions, offsets)):
            nozzle = make_cylinder(0.044, 0.024, 0.090, z_center=0.0, segments=10)
            q = Vector((0, 0, 1)).rotation_difference(direction)
            transform_bm(nozzle, q.to_matrix().to_4x4())
            transform_bm(nozzle, Matrix.Translation(bay_center + radial * 0.055 + offset))
            add_mesh_obj(f"rcs_nozzle_{i}_{j}", nozzle, mats.nozzle_bell)

        # Valve box and short visible manifold inside the bay.
        valve_pos = bay_center - radial * 0.035 + Vector((0, 0, -0.05))
        add_mesh_obj(
            f"rcs_valve_box_{i}",
            make_box(0.12, 0.22, 0.16, center=valve_pos, rot_euler=(0, 0, ang)),
            mats.titanium,
        )
        add_mesh_obj(
            f"rcs_manifold_{i}",
            make_pipe([
                valve_pos + tangent * -0.13,
                valve_pos + tangent * 0.13,
            ], radius=0.020, segments=8),
            mats.pipe,
        )

    export_glb(os.path.join(OUT_DIR, "rcs-standard.glb"))


# ----------------------------------------------------------------------
# 7. Docking & Decoupler Modules (docking-port, dock, decoupler)
# Compact capture collar, exposed mechanical latches/contact pads and service
# connectors; avoids the visually modern oversized CBM/APAS petal language.
# ----------------------------------------------------------------------
def build_docking_mechanism(name, kind):
    reset_scene()
    mats = MaterialLibrary()
    radius = 2.95 if kind == 'decoupler' else 1.92
    half_len = 0.50

    body_mat = mats.dock if kind == 'dock' else mats.titanium
    add_mesh_obj(
        "ring",
        make_cylinder(radius, radius, 0.84, z_center=-0.04, segments=48),
        body_mat,
    )

    # Thin removable outer cover panels around the mechanism drum.
    panel_count = 12
    dtheta = 2.0 * math.pi / panel_count
    for i in range(panel_count):
        ang = i * dtheta
        chord = 2.0 * radius * math.sin(dtheta * 0.5) * 0.91
        centre = ((radius + 0.012) * math.cos(ang), (radius + 0.012) * math.sin(ang), -0.05)
        add_mesh_obj(
            f"dock_cover_panel_{i}",
            make_box(0.025, chord, 0.67, center=centre, rot_euler=(0, 0, ang)),
            mats.aluminium if i % 4 else mats.rene41,
        )

    # Contract-critical interface ring: torus axis remains +Z.
    contact_r = radius * (0.78 if kind == 'decoupler' else 0.74)
    add_mesh_obj(
        "interface-ring",
        make_torus(major_r=contact_r, minor_r=0.055, z_center=0.455, major_seg=48, minor_seg=10),
        mats.rene41_edge,
    )

    if kind != 'decoupler':
        # Six exposed capture latches and alternating electrical/contact blocks.
        for i in range(6):
            ang = i * math.pi / 3.0
            radial = Vector((math.cos(ang), math.sin(ang), 0.0))
            tangent = Vector((-math.sin(ang), math.cos(ang), 0.0))
            latch_pos = radial * (contact_r * 0.94) + Vector((0, 0, 0.445))
            add_mesh_obj(
                f"capture_latch_{i}",
                make_box(0.16, 0.29, 0.10, center=latch_pos, rot_euler=(0, 0, ang)),
                mats.fastener,
            )
            if i % 2 == 0:
                connector_pos = radial * (contact_r * 0.72) + tangent * 0.05 + Vector((0, 0, 0.47))
                add_mesh_obj(
                    f"docking_connector_{i}",
                    make_box(0.12, 0.18, 0.07, center=connector_pos, rot_euler=(0, 0, ang)),
                    mats.recessed,
                )

        # Small central guide/probe rather than oversized petals.
        add_mesh_obj(
            "docking_guide_probe",
            make_cylinder(0.10, 0.065, 0.26, z_center=0.43, segments=16),
            mats.titanium,
        )
        add_mesh_obj(
            "docking_probe_tip",
            make_sphere(0.085, center=(0, 0, 0.57), u_seg=14, v_seg=8),
            mats.fastener,
        )

        # External alignment target plate gives the otherwise symmetric mechanism
        # an operationally legible orientation.
        target = make_box(0.035, 0.28, 0.20, center=(radius + 0.025, 0.0, 0.28))
        add_mesh_obj("alignment_target", target, mats.mli_white)

    else:
        # Decoupler retains a full-diameter severance path and multiple pushers.
        add_mesh_obj(
            "shaped_charge",
            make_torus(major_r=radius * 0.985, minor_r=0.022, z_center=0.0, major_seg=48, minor_seg=6),
            mats.dock,
        )
        for s in range(8):
            ang = s * math.pi / 4.0
            radial = Vector((math.cos(ang), math.sin(ang), 0.0))
            p0 = radial * (radius * 0.79) + Vector((0, 0, 0.34))
            p1 = radial * (radius * 0.79) + Vector((0, 0, 0.47))
            add_mesh_obj(
                f"pusher_spring_{s}",
                make_pipe([p0, p1], radius=0.035, segments=8),
                mats.pipe,
            )

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))


# ----------------------------------------------------------------------
# 8. Deployable Modules Support Base (solar-panel-standard, radiator-standard)
# 1960s aerospace mechanism cues: machined gearbox, forked bearing yoke,
# exposed cable loop, round connector and bolted inspection cover.
# ----------------------------------------------------------------------
def build_deployable_base(name, kind):
    reset_scene()
    mats = MaterialLibrary()
    radius = 0.50
    half_len = 0.50

    # Main machined housing and end covers.
    add_mesh_obj(
        "drive_housing",
        make_cylinder(radius * 0.66, radius * 0.66, 0.82, z_center=-0.03, segments=28),
        mats.titanium,
    )
    for z in [-0.39, 0.35]:
        add_mesh_obj(
            f"drive_cover_{z}",
            make_torus(major_r=radius * 0.64, minor_r=0.028, z_center=z, major_seg=28, minor_seg=8),
            mats.fastener,
        )

    add_mesh_obj(
        "rotary_bearing",
        make_torus(major_r=radius * 0.72, minor_r=0.045, z_center=0.10, major_seg=28, minor_seg=8),
        mats.pipe,
    )

    # Forked yoke and hinge bosses.
    for y_sign in [-1.0, 1.0]:
        add_mesh_obj(
            f"yoke_fork_{y_sign}",
            make_box(0.075, 0.085, 0.48, center=(0.0, y_sign * 0.30, 0.22)),
            mats.aluminium,
        )
        add_lowpoly_fastener(
            f"yoke_pivot_{y_sign}",
            (0.0, y_sign * 0.30, 0.43),
            mats.fastener,
            radius=0.045,
        )

    # Compact electric actuator can and removable rectangular inspection cover.
    add_mesh_obj(
        "deploy_canister",
        make_cylinder(0.18, 0.18, 0.24, z_center=0.34, segments=18),
        mats.titanium,
    )
    add_mesh_obj(
        "inspection_cover",
        make_box(0.035, 0.34, 0.30, center=(radius * 0.68, 0.0, -0.08)),
        mats.aluminium,
    )
    for y in [-0.13, 0.13]:
        for z in [-0.18, 0.02]:
            add_lowpoly_fastener(
                f"inspection_fastener_{y}_{z}",
                (radius * 0.71, y, z),
                mats.fastener,
                radius=0.013,
            )

    # Exposed service cable loop and round connector.
    add_mesh_obj(
        "deploy_cable_loop",
        make_pipe([
            Vector((-0.16, -0.34, -0.18)),
            Vector((-0.27, -0.40, 0.02)),
            Vector((-0.18, -0.34, 0.24)),
        ], radius=0.018, segments=8),
        mats.gasket,
    )
    connector = make_cylinder(0.055, 0.055, 0.07, z_center=0, segments=12)
    q = Vector((0, 0, 1)).rotation_difference(Vector((1, 0, 0)))
    transform_bm(connector, q.to_matrix().to_4x4())
    transform_bm(connector, Matrix.Translation(Vector((radius * 0.70, 0.16, 0.12))))
    add_mesh_obj("deploy_round_connector", connector, mats.fastener)

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))


# ----------------------------------------------------------------------
# 9. Armor Modules (armor-standard, armor-combat)
# Future protection rendered with the same fabrication language: overlapping
# metallic bumper plates, dark stand-off gaps, retention straps and fasteners.
# ----------------------------------------------------------------------
def build_armor(name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0

    add_mesh_obj(
        "armor_inner_shell",
        make_cylinder(radius * 0.965, radius * 0.965, 0.92, z_center=0.0, segments=48),
        mats.titanium,
    )

    sectors = 16
    dtheta = 2.0 * math.pi / sectors
    for i in range(sectors):
        ang = i * dtheta
        chord = 2.0 * radius * math.sin(dtheta * 0.5) * 0.91
        centre = ((radius + 0.025) * math.cos(ang), (radius + 0.025) * math.sin(ang), 0.0)
        mat = mats.rene41 if "combat" in name else mats.aluminium
        add_mesh_obj(
            f"armor_bumper_plate_{i}",
            make_box(0.038, chord, 0.82, center=centre, rot_euler=(0, 0, ang)),
            mat,
        )

        # A pair of visible retention fasteners per plate.
        radial = Vector((math.cos(ang), math.sin(ang), 0.0))
        tangent = Vector((-math.sin(ang), math.cos(ang), 0.0))
        for z in [-0.31, 0.31]:
            p = radial * (radius + 0.052) + tangent * (chord * 0.32) + Vector((0, 0, z))
            add_lowpoly_fastener(f"armor_fastener_{i}_{z}", p, mats.fastener, radius=0.014)

    for za in [-0.37, 0.37]:
        add_mesh_obj(
            f"armor_retention_band_{za}",
            make_torus(major_r=radius + 0.045, minor_r=0.018, z_center=za, major_seg=48, minor_seg=6),
            mats.clamp,
        )

    export_glb(os.path.join(OUT_DIR, f"{name}.glb"))


# ----------------------------------------------------------------------
# 10. Weapon Module (weapon-gatling)
# Future weapon mechanism styled as exposed aerospace machinery rather than a
# seamless sci-fi turret: sheet-metal fairings, machined supports and cable runs.
# ----------------------------------------------------------------------
def build_weapon(name):
    reset_scene()
    mats = MaterialLibrary()
    radius = 3.0

    # Structural carrier with segmented covers.
    add_mesh_obj(
        "weapon_ring",
        make_cylinder(radius * 0.97, radius * 0.97, 0.92, z_center=0.0, segments=44),
        mats.titanium,
    )
    for i in range(12):
        ang = i * math.pi / 6.0
        chord = 2.0 * radius * math.sin(math.pi / 12.0) * 0.90
        centre = ((radius * 0.985) * math.cos(ang), (radius * 0.985) * math.sin(ang), 0.0)
        add_mesh_obj(
            f"weapon_access_panel_{i}",
            make_box(0.028, chord, 0.76, center=centre, rot_euler=(0, 0, ang)),
            mats.aluminium if i % 3 else mats.rene41,
        )

    # Twin rotary cannon units retain the established gameplay silhouettes.
    for sign in [-1.0, 1.0]:
        x_base = sign * 1.50

        # Machined receiver block plus thin outer cowl.
        add_mesh_obj(
            f"gun_receiver_{sign}",
            make_box(0.52, 0.72, 0.46, center=(x_base, 0.0, 0.12)),
            mats.fastener,
        )
        housing = make_cylinder(0.40, 0.36, 0.58, z_center=0.16, segments=18)
        transform_bm(housing, Matrix.Translation(Vector((x_base, 0.0, 0.0))))
        add_mesh_obj(f"gun_housing_{sign}", housing, mats.titanium)

        # Six barrels end close to the gameplay muzzle anchor at z ≈ +0.75 m.
        for b in range(6):
            b_ang = b * math.pi / 3.0
            bx = x_base + 0.15 * math.cos(b_ang)
            by = 0.15 * math.sin(b_ang)
            barrel = make_cylinder(0.030, 0.030, 0.72, z_center=0.42, segments=10)
            transform_bm(barrel, Matrix.Translation(Vector((bx, by, 0.0))))
            add_mesh_obj(f"barrel_{sign}_{b}", barrel, mats.pipe)

        for z in [0.32, 0.73]:
            clamp = make_torus(major_r=0.17, minor_r=0.022, z_center=z, major_seg=18, minor_seg=6)
            transform_bm(clamp, Matrix.Translation(Vector((x_base, 0.0, 0.0))))
            add_mesh_obj(f"barrel_clamp_{sign}_{z}", clamp, mats.fastener)

        # Feed motor and visible cable/harness.
        add_mesh_obj(
            f"feed_motor_{sign}",
            make_cylinder(0.15, 0.15, 0.26, z_center=0.02, segments=16),
            mats.titanium,
        )
        motor_obj = bpy.data.objects.get(f"feed_motor_{sign}")
        if motor_obj:
            motor_obj.location.x += x_base
            motor_obj.location.y += 0.46

        add_mesh_obj(
            f"weapon_harness_{sign}",
            make_pipe([
                Vector((x_base, 0.48, 0.02)),
                Vector((sign * 1.82, 0.44, -0.18)),
                Vector((sign * 2.12, 0.30, -0.24)),
            ], radius=0.022, segments=8),
            mats.gasket,
        )

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
    
    # 7. Deployable bases
    build_deployable_base("solar-panel-base", "solar_panel")
    build_deployable_base("radiator-base", "radiator")
    
    # 8. Armor & Weapon
    build_armor("armor-standard")
    build_armor("armor-combat")
    build_weapon("weapon-gatling")
    
    print("All modules generated and exported successfully!")

if __name__ == "__main__":
    main()
