"""Gemini-inspired cockpit shell and its non-colliding surface equipment."""

import math

import bpy
from mathutils import Vector


TAU = math.tau
BLACK_BANDS = ((-3.42, -1.88), (1.88, 4.32))
WHITE_PANEL_BAND = (-1.88, 1.88)
BLACK_BLOCK_COUNT = 24
WHITE_PANEL_COUNT = 16
WHITE_RIB_POSITIONS = (-1.56, -1.04, -0.52, 0.0, 0.52, 1.04, 1.56)
WINDOW_POSITIONS = (2.48, -0.18, -1.57)
CASE_POSITIONS = ((0.70, 0.73), (-0.84, 2.43), (0.92, 3.62), (-0.62, 5.17))


class MeshBuilder:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.material_indices = []

    def add_face(self, points, material_index):
        first = len(self.vertices)
        self.vertices.extend(tuple(point) for point in points)
        self.faces.append(tuple(range(first, first + len(points))))
        self.material_indices.append(material_index)

    def add_grid(self, points, material_at):
        rows = len(points)
        columns = len(points[0])
        first = len(self.vertices)
        self.vertices.extend(tuple(point) for row in points for point in row)
        for row in range(rows - 1):
            for column in range(columns - 1):
                self.faces.append((
                    first + row * columns + column,
                    first + row * columns + column + 1,
                    first + (row + 1) * columns + column + 1,
                    first + (row + 1) * columns + column,
                ))
                self.material_indices.append(material_at(row, column))


def pbr_material(name, color, roughness, metallic=0.0):
    material = bpy.data.materials.new(name=name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    if shader is not None:
        shader.inputs["Base Color"].default_value = (*color, 1.0)
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = metallic
    return material


def materials():
    values = [
        pbr_material("cockpit_graphite_enamel", (0.035, 0.043, 0.054), 0.48, 0.18),
        pbr_material("cockpit_graphite_variant", (0.055, 0.063, 0.071), 0.52, 0.14),
        pbr_material("cockpit_ivory_ceramic", (0.79, 0.80, 0.77), 0.52, 0.12),
        pbr_material("cockpit_seam_gray", (0.37, 0.40, 0.41), 0.63, 0.22),
        pbr_material("cockpit_rib_pale_metal", (0.66, 0.68, 0.67), 0.43, 0.50),
        pbr_material("cockpit_slot_shadow", (0.012, 0.016, 0.021), 0.60, 0.12),
        pbr_material("cockpit_umber_insert", (0.25, 0.15, 0.095), 0.68, 0.25),
        pbr_material("cockpit_dull_brass", (0.43, 0.29, 0.14), 0.48, 0.68),
        pbr_material("cockpit_warning_red", (0.54, 0.038, 0.032), 0.48, 0.10),
        pbr_material("cockpit_case_backing", (0.15, 0.17, 0.17), 0.58, 0.34),
        pbr_material("cockpit_window_glass", (0.30, 0.48, 0.52), 0.20, 0.20),
        pbr_material("cockpit_silver_bezel", (0.66, 0.69, 0.70), 0.30, 0.82),
    ]
    return {index: material for index, material in enumerate(values)}


def angle_distance(left, right):
    return math.atan2(math.sin(left - right), math.cos(left - right))


def smooth_edge(distance, width):
    amount = max(0.0, min(1.0, (width - distance) / width))
    return amount * amount * (3.0 - 2.0 * amount)


def radius_at(profile, z):
    if z <= profile[0]["z"]:
        return profile[0]["radius"]
    for before, after in zip(profile, profile[1:]):
        if z <= after["z"]:
            fraction = (z - before["z"]) / (after["z"] - before["z"])
            return before["radius"] + (after["radius"] - before["radius"]) * fraction
    return profile[-1]["radius"]


def section_radius(profile, indent_fraction, z, theta):
    radius = radius_at(profile, z)
    upper_groove = abs(angle_distance(theta, math.pi * 0.5)) * radius
    lower_groove = abs(angle_distance(theta, math.pi * 1.5)) * radius
    longitudinal_groove = max(
        0.052 * radius * math.exp(-((upper_groove / 0.105) ** 2)),
        0.052 * radius * math.exp(-((lower_groove / 0.105) ** 2)),
    )
    return max(0.1, radius - min(longitudinal_groove, radius * indent_fraction * 0.35))


def black_band(z):
    return next((index for index, (low, high) in enumerate(BLACK_BANDS) if low <= z <= high), None)


def slot_at(profile, z, theta):
    band_index = black_band(z)
    if band_index is None:
        return None
    low, high = BLACK_BANDS[band_index]
    sector_width = TAU / BLACK_BLOCK_COUNT
    sector = int(math.floor((theta % TAU) / sector_width))
    center_theta = (sector + 0.5) * sector_width
    delta_theta = abs(angle_distance(theta, center_theta))
    margin = min(0.13, (high - low) * 0.09)
    usable_length = high - low - margin * 2.0
    row_spacing = usable_length / 6.0
    radius = radius_at(profile, z)
    widths = (0.84, 1.0, 0.76, 0.92, 1.0, 0.86)
    for row in range(6):
        center_z = low + margin + (row + 0.5) * row_spacing
        scale = widths[(sector * 3 + row * 2 + band_index) % len(widths)]
        half_arc = radius * sector_width * 0.47 * scale
        half_height = 0.033 * (0.88 + 0.1 * ((sector + row) % 3))
        distance = max(abs(z - center_z) - half_height, delta_theta * radius - half_arc)
        if distance < 0.024:
            is_umber = (sector * 5 + row * 7 + band_index) % 13 in (3, 9)
            depth = 0.040 * smooth_edge(max(distance, 0.0), 0.024)
            return depth, (6 if is_umber else 5), sector, row

    for row in range(5):
        center_z = low + margin + (row + 1.0) * row_spacing
        half_arc = radius * sector_width * 0.46
        half_height = 0.016
        distance = max(abs(z - center_z) - half_height, delta_theta * radius - half_arc)
        if distance < 0.010:
            depth = 0.014 * smooth_edge(max(distance, 0.0), 0.010)
            return depth, 5, sector, row
    return None


def panel_seam_distance(z, theta):
    if not WHITE_PANEL_BAND[0] <= z <= WHITE_PANEL_BAND[1]:
        return float("inf")
    interval = TAU / WHITE_PANEL_COUNT
    nearest = round((theta % TAU) / interval) * interval
    return abs(angle_distance(theta, nearest))


def transverse_rib(z):
    rib = 0.0
    if WHITE_PANEL_BAND[0] <= z <= WHITE_PANEL_BAND[1]:
        for center in WHITE_RIB_POSITIONS:
            rib = max(rib, 0.026 * math.exp(-(((z - center) / 0.035) ** 2)))
    return rib


def surface_radius(profile, indent_fraction, z, theta):
    radius = section_radius(profile, indent_fraction, z, theta)
    radius += transverse_rib(z)
    slot = slot_at(profile, z, theta)
    if slot is not None:
        radius -= slot[0]
    if WHITE_PANEL_BAND[0] <= z <= WHITE_PANEL_BAND[1]:
        seam_distance = panel_seam_distance(z, theta) * radius
        radius -= 0.018 * smooth_edge(seam_distance, 0.026)
    elif black_band(z) is not None:
        sector_width = TAU / BLACK_BLOCK_COUNT
        edge = round((theta % TAU) / sector_width) * sector_width
        seam_distance = abs(angle_distance(theta, edge)) * radius
        radius -= 0.012 * smooth_edge(seam_distance, 0.020)
    return radius


def surface_point(profile, indent_fraction, z, theta, offset=0.0):
    radius = surface_radius(profile, indent_fraction, z, theta) + offset
    return Vector((radius * math.cos(theta), radius * math.sin(theta), z))


def hull_material(profile, z, theta):
    if black_band(z) is not None:
        slot = slot_at(profile, z, theta)
        if slot is not None:
            return slot[1]
        sector_width = TAU / BLACK_BLOCK_COUNT
        sector = int(math.floor((theta % TAU) / sector_width))
        if abs(angle_distance(theta, round((theta % TAU) / sector_width) * sector_width)) * radius_at(profile, z) < 0.021:
            return 1
        return 1 if sector % 5 == 0 else 0
    if WHITE_PANEL_BAND[0] <= z <= WHITE_PANEL_BAND[1]:
        seam_distance = panel_seam_distance(z, theta) * radius_at(profile, z)
        if seam_distance < 0.032:
            return 3
        if transverse_rib(z) > 0.010:
            return 4
    return 2


def create_hull(profile, indent_fraction, surface_materials):
    axial_steps = 480
    angular_steps = 384
    first_z = profile[0]["z"]
    last_z = profile[-1]["z"]
    points = []
    for axial_index in range(axial_steps + 1):
        z = first_z + (last_z - first_z) * axial_index / axial_steps
        row = []
        for angle_index in range(angular_steps):
            theta = TAU * angle_index / angular_steps
            row.append(surface_point(profile, indent_fraction, z, theta))
        points.append(row)

    hull = MeshBuilder()
    hull.add_grid(
        points,
        lambda row, column: hull_material(
            profile,
            first_z + (last_z - first_z) * (row + 0.5) / axial_steps,
            TAU * (column + 0.5) / angular_steps,
        ),
    )
    for endpoint, z, reverse in ((points[0], first_z, True), (points[-1], last_z, False)):
        center_index = len(hull.vertices)
        hull.vertices.append((0.0, 0.0, z))
        ring_start = 0 if reverse else axial_steps * angular_steps
        for angle_index in range(angular_steps):
            next_index = (angle_index + 1) % angular_steps
            first = ring_start + angle_index
            second = ring_start + next_index
            face = (center_index, second, first) if reverse else (center_index, first, second)
            hull.faces.append(face)
            hull.material_indices.append(2 if z < 0.0 else 0)
    obj = mesh_object("cockpit_pressure_shell", hull, surface_materials)
    for polygon in obj.data.polygons:
        polygon.use_smooth = len(polygon.vertices) == 4
    return obj


def mesh_object(name, builder, surface_materials):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(builder.vertices, [], builder.faces)
    mesh.materials.clear()
    for material in surface_materials:
        mesh.materials.append(material)
    mesh.update()
    for polygon, material_index in zip(mesh.polygons, builder.material_indices):
        polygon.material_index = material_index
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def add_wrap_ring(builder, profile, indent_fraction, z, width, offset, material_index, steps=288):
    low, high = z - width * 0.5, z + width * 0.5
    for angle_index in range(steps):
        theta0 = TAU * angle_index / steps
        theta1 = TAU * (angle_index + 1) / steps
        builder.add_face((
            surface_point(profile, indent_fraction, low, theta0, offset),
            surface_point(profile, indent_fraction, low, theta1, offset),
            surface_point(profile, indent_fraction, high, theta1, offset),
            surface_point(profile, indent_fraction, high, theta0, offset),
        ), material_index)


def create_wrap_hardware(profile, indent_fraction, surface_materials):
    hardware = MeshBuilder()
    for z in (2.13, -2.17):
        add_wrap_ring(hardware, profile, indent_fraction, z, 0.038, 0.023, 8)
    for z, width in ((2.88, 0.058), (3.86, 0.042), (-2.53, 0.050), (-3.24, 0.036)):
        add_wrap_ring(hardware, profile, indent_fraction, z, width, 0.018, 7)
    for z in (-4.02, -3.78, 4.32):
        add_wrap_ring(hardware, profile, indent_fraction, z, 0.035, 0.024, 11)
    mesh_object("cockpit_red_brass_and_silver_wraps", hardware, surface_materials)


def basis_at(theta):
    tangential = Vector((-math.sin(theta), math.cos(theta), 0.0))
    axial = Vector((0.0, 0.0, 1.0))
    normal = Vector((math.cos(theta), math.sin(theta), 0.0))
    return tangential, axial, normal


def add_torus(builder, center, tangential, axial, normal, major_radius, tube_radius,
              material_index, axial_scale=1.0, major_steps=48, tube_steps=8):
    points = []
    for major_index in range(major_steps):
        angle = TAU * major_index / major_steps
        radial = tangential * math.cos(angle) + axial * (math.sin(angle) * axial_scale)
        major_center = center + radial * major_radius
        row = []
        for tube_index in range(tube_steps):
            tube_angle = TAU * tube_index / tube_steps
            row.append(major_center + tube_radius * (
                radial * math.cos(tube_angle) + normal * math.sin(tube_angle)
            ))
        points.append(row)
    for major_index in range(major_steps):
        next_major = (major_index + 1) % major_steps
        for tube_index in range(tube_steps):
            next_tube = (tube_index + 1) % tube_steps
            builder.add_face((
                points[major_index][tube_index], points[next_major][tube_index],
                points[next_major][next_tube], points[major_index][next_tube],
            ), material_index)


def add_disc(builder, center, tangential, axial, radius_u, radius_v, material_index, steps=48):
    center_index = len(builder.vertices)
    builder.vertices.append(tuple(center))
    ring_start = len(builder.vertices)
    for step in range(steps):
        angle = TAU * step / steps
        point = center + tangential * (radius_u * math.cos(angle)) + axial * (radius_v * math.sin(angle))
        builder.vertices.append(tuple(point))
    for step in range(steps):
        next_step = (step + 1) % steps
        builder.faces.append((center_index, ring_start + step, ring_start + next_step))
        builder.material_indices.append(material_index)


def create_windows(profile, indent_fraction, surface_materials):
    windows = MeshBuilder()
    for z in WINDOW_POSITIONS:
        for theta in (0.0, math.pi):
            tangential, axial, normal = basis_at(theta)
            base = surface_point(profile, indent_fraction, z, theta)
            add_disc(windows, base + normal * 0.004, tangential, axial, 0.235, 0.235, 5)
            add_disc(windows, base + normal * 0.018, tangential, axial, 0.177, 0.177, 10)
            add_torus(windows, base + normal * 0.030, tangential, axial, normal,
                      0.207, 0.031, 11, major_steps=56)
            add_torus(windows, base + normal * 0.024, tangential, axial, normal,
                      0.174, 0.009, 3, major_steps=48, tube_steps=6)
    mesh_object("cockpit_six_round_windows", windows, surface_materials)


def case_half_width(z, center_z, width):
    fraction = (z - (center_z - 0.30)) / 0.60
    return width * (0.78 + 0.22 * max(0.0, min(1.0, fraction)))


def add_case(builder, profile, indent_fraction, center_z, center_theta, surface_materials):
    axial_steps = 28
    across_steps = 96
    z_low, z_high = center_z - 0.30, center_z + 0.30
    base_width = 0.43
    front_rows, backing_rows = [], []
    for axial_index in range(axial_steps + 1):
        fraction_z = axial_index / axial_steps
        z = z_low + (z_high - z_low) * fraction_z
        half_width = case_half_width(z, center_z, base_width)
        front_row, backing_row = [], []
        for across_index in range(across_steps + 1):
            fraction_across = across_index / across_steps
            theta = center_theta + (fraction_across * 2.0 - 1.0) * half_width / radius_at(profile, z)
            corrugation = 0.028 * (0.5 + 0.5 * math.cos(TAU * 8.0 * fraction_across))
            front_row.append(surface_point(profile, indent_fraction, z, theta, 0.105 + corrugation))
            backing_row.append(surface_point(profile, indent_fraction, z, theta, 0.025))
        front_rows.append(front_row)
        backing_rows.append(backing_row)

    builder.add_grid(backing_rows, lambda row, column: 9)
    builder.add_grid(front_rows, lambda row, column: 4 if column % 12 in (0, 1, 2, 3) else 9)

    for edge_row in (0, axial_steps):
        for column in range(across_steps):
            builder.add_face((
                backing_rows[edge_row][column], backing_rows[edge_row][column + 1],
                front_rows[edge_row][column + 1], front_rows[edge_row][column],
            ), 4)
    for edge_column in (0, across_steps):
        for row in range(axial_steps):
            builder.add_face((
                backing_rows[row][edge_column], backing_rows[row + 1][edge_column],
                front_rows[row + 1][edge_column], front_rows[row][edge_column],
            ), 4)

    for port_z in (center_z - 0.16, center_z + 0.16):
        theta = center_theta
        tangential, axial, normal = basis_at(theta)
        center = surface_point(profile, indent_fraction, port_z, theta, 0.142)
        add_disc(builder, center + normal * 0.008, tangential, axial, 0.078, 0.043, 5, 40)
        add_torus(builder, center + normal * 0.017, tangential, axial, normal,
                  0.069, 0.012, 7, axial_scale=0.56, major_steps=40, tube_steps=6)


def create_equipment_cases(profile, indent_fraction, surface_materials):
    cases = MeshBuilder()
    for z, theta in CASE_POSITIONS:
        add_case(cases, profile, indent_fraction, z, theta, surface_materials)
    mesh_object("cockpit_corrugated_equipment_cases", cases, surface_materials)


def build_cockpit_surface(cockpit_hull):
    profile = tuple(cockpit_hull["profile"])
    indent_fraction = float(cockpit_hull["sectionIndentFraction"])
    surface_materials = [materials()[index] for index in range(12)]
    create_hull(profile, indent_fraction, surface_materials)
    create_wrap_hardware(profile, indent_fraction, surface_materials)
    create_windows(profile, indent_fraction, surface_materials)
    create_equipment_cases(profile, indent_fraction, surface_materials)
