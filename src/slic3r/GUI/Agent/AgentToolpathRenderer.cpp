#include "AgentToolpathRenderer.hpp"

#include "libslic3r/GCode/GCodeProcessor.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <vector>

namespace Slic3r::GUI::Agent {
namespace {

constexpr std::array<ToolpathFeatureStyle, 12> FEATURE_STYLES {{
    {erPerimeter,            "inner_wall",           "Inner wall",            "#FFE64D", {255, 230,  77}},
    {erExternalPerimeter,    "outer_wall",           "Outer wall",            "#FF7D38", {255, 125,  56}},
    {erOverhangPerimeter,    "overhang_wall",        "Overhang wall",         "#1F1FFF", { 31,  31, 255}},
    {erInternalInfill,       "sparse_infill",        "Sparse infill",         "#B03029", {176,  48,  41}},
    {erSolidInfill,          "internal_solid_infill", "Internal solid infill", "#9654CC", {150,  84, 204}},
    {erTopSolidInfill,       "top_surface",          "Top surface",           "#F04040", {240,  64,  64}},
    {erBridgeInfill,         "bridge",               "Bridge",                "#4D80BA", { 77, 128, 186}},
    {erGapFill,              "gap_infill",           "Gap infill",            "#FFFFFF", {255, 255, 255}},
    {erCustom,               "custom",               "Custom",                "#5ED194", { 94, 209, 148}},
    {erBottomSurface,        "bottom_surface",       "Bottom surface",        "#665CC7", {102,  92, 199}},
    {erInternalBridgeInfill, "internal_bridge",      "Internal bridge",       "#4D80BA", { 77, 128, 186}},
    {erBrim,                 "brim",                 "Brim",                  "#003B6E", {  0,  59, 110}},
}};

constexpr ToolpathFeatureStyle SEAM_STYLE {
    erNone, "seam", "Seam", "#E6E6E6", {230, 230, 230}
};

constexpr std::array<std::uint8_t, 4> BACKGROUND {32, 33, 36, 255};

struct ProjectedPoint
{
    double x;
    double y;
};

const ToolpathFeatureStyle* style_for(ExtrusionRole role)
{
    const auto found = std::find_if(
        FEATURE_STYLES.begin(), FEATURE_STYLES.end(),
        [role](const ToolpathFeatureStyle& style) { return style.role == role; });
    return found == FEATURE_STYLES.end() ? nullptr : &*found;
}

ProjectedPoint project(const Vec3f& point, std::string_view view)
{
    const double x = point.x();
    const double y = point.y();
    const double z = point.z();
    if (view == "top")
        return {x, y};
    if (view == "bottom")
        return {x, -y};
    if (view == "front")
        return {x, z};
    if (view == "rear")
        return {-x, z};
    if (view == "left")
        return {y, z};
    if (view == "right")
        return {-y, z};
    if (view == "topfront")
        return {x, 0.8 * z - 0.5 * y};
    if (view == "iso")
        return {0.866025403784 * (x - y), z - 0.5 * (x + y)};
    throw std::invalid_argument("Unsupported toolpath render view");
}

bool finite(const Vec3f& point)
{
    return std::isfinite(point.x()) && std::isfinite(point.y()) &&
           std::isfinite(point.z());
}

void put_pixel(ThumbnailData& image, int x, int y,
               const std::array<std::uint8_t, 3>& color)
{
    if (x < 0 || y < 0 || x >= static_cast<int>(image.width) ||
        y >= static_cast<int>(image.height))
        return;
    const std::size_t row = image.height - 1u - static_cast<unsigned int>(y);
    const std::size_t offset = 4u * (row * image.width + static_cast<unsigned int>(x));
    image.pixels[offset] = color[0];
    image.pixels[offset + 1] = color[1];
    image.pixels[offset + 2] = color[2];
    image.pixels[offset + 3] = 255;
}

void draw_disc(ThumbnailData& image, int center_x, int center_y, int radius,
               const std::array<std::uint8_t, 3>& color)
{
    const int radius_squared = radius * radius;
    for (int y = -radius; y <= radius; ++y) {
        for (int x = -radius; x <= radius; ++x) {
            if (x * x + y * y <= radius_squared)
                put_pixel(image, center_x + x, center_y + y, color);
        }
    }
}

void draw_line(ThumbnailData& image, double x0, double y0, double x1, double y1,
               int radius, const std::array<std::uint8_t, 3>& color)
{
    const double dx = x1 - x0;
    const double dy = y1 - y0;
    const int steps = std::max(1, static_cast<int>(std::ceil(std::max(std::abs(dx), std::abs(dy)))));
    for (int step = 0; step <= steps; ++step) {
        const double ratio = static_cast<double>(step) / steps;
        draw_disc(image,
                  static_cast<int>(std::lround(x0 + dx * ratio)),
                  static_cast<int>(std::lround(y0 + dy * ratio)),
                  radius, color);
    }
}

bool in_range(const GCodeProcessorResult::MoveVertex& move,
              const ToolpathLayerRange& range)
{
    const unsigned int layer = move.layer_id == 0 ? 0 : move.layer_id - 1;
    return layer >= range.start && layer <= range.end;
}

} // namespace

const std::array<ToolpathFeatureStyle, 12>& toolpath_feature_styles()
{
    return FEATURE_STYLES;
}

const ToolpathFeatureStyle& toolpath_seam_style()
{
    return SEAM_STYLE;
}

ToolpathRenderResult render_toolpaths(const GCodeProcessorResult& gcode,
                                      const ToolpathRenderRequest& request)
{
    if (request.width < 64 || request.height < 64)
        throw std::invalid_argument("Toolpath render dimensions are too small");

    bool found_layer = false;
    ToolpathLayerRange available {std::numeric_limits<unsigned int>::max(), 0};
    for (const GCodeProcessorResult::MoveVertex& move : gcode.moves) {
        const bool visible_extrusion = move.type == EMoveType::Extrude &&
                                       style_for(move.extrusion_role) != nullptr;
        if (!move.internal_only && (visible_extrusion || move.type == EMoveType::Seam)) {
            const unsigned int layer = move.layer_id == 0 ? 0 : move.layer_id - 1;
            available.start = std::min(available.start, layer);
            available.end = std::max(available.end, layer);
            found_layer = true;
        }
    }
    if (!found_layer)
        throw std::runtime_error("Sliced G-code has no visible toolpaths");

    const ToolpathLayerRange rendered = request.layer_range.value_or(available);
    if (rendered.start > rendered.end || rendered.start < available.start ||
        rendered.end > available.end)
        throw std::invalid_argument("Requested layer range is outside the sliced toolpaths");

    double min_x = std::numeric_limits<double>::infinity();
    double min_y = std::numeric_limits<double>::infinity();
    double max_x = -std::numeric_limits<double>::infinity();
    double max_y = -std::numeric_limits<double>::infinity();
    std::size_t segment_count = 0;
    std::size_t seam_count = 0;
    for (std::size_t index = 0; index < gcode.moves.size(); ++index) {
        const GCodeProcessorResult::MoveVertex& move = gcode.moves[index];
        if (move.internal_only || !in_range(move, rendered) || !finite(move.position))
            continue;
        if (move.type == EMoveType::Extrude && style_for(move.extrusion_role) != nullptr &&
            index > 0 && finite(gcode.moves[index - 1].position)) {
            const ProjectedPoint from = project(gcode.moves[index - 1].position, request.view);
            const ProjectedPoint to = project(move.position, request.view);
            min_x = std::min({min_x, from.x, to.x});
            min_y = std::min({min_y, from.y, to.y});
            max_x = std::max({max_x, from.x, to.x});
            max_y = std::max({max_y, from.y, to.y});
            ++segment_count;
        } else if (move.type == EMoveType::Seam) {
            const ProjectedPoint seam = project(move.position, request.view);
            min_x = std::min(min_x, seam.x);
            min_y = std::min(min_y, seam.y);
            max_x = std::max(max_x, seam.x);
            max_y = std::max(max_y, seam.y);
            ++seam_count;
        }
    }
    if (segment_count == 0 && seam_count == 0)
        throw std::runtime_error("Requested layers have no visible toolpaths");

    ToolpathRenderResult output;
    output.image.width = request.width;
    output.image.height = request.height;
    output.image.pixels.resize(static_cast<std::size_t>(request.width) * request.height * 4u);
    for (std::size_t offset = 0; offset < output.image.pixels.size(); offset += 4) {
        std::copy(BACKGROUND.begin(), BACKGROUND.end(), output.image.pixels.begin() + offset);
    }

    constexpr double margin_fraction = 0.05;
    const double margin = std::max(4.0, margin_fraction * std::min(request.width, request.height));
    const double span_x = std::max(max_x - min_x, 1e-6);
    const double span_y = std::max(max_y - min_y, 1e-6);
    const double scale = std::min(
        (request.width - 2.0 * margin) / span_x,
        (request.height - 2.0 * margin) / span_y);
    const auto screen = [&](const ProjectedPoint& point) {
        return ProjectedPoint {
            margin + (point.x - min_x) * scale,
            request.height - margin - (point.y - min_y) * scale
        };
    };

    for (std::size_t index = 1; index < gcode.moves.size(); ++index) {
        const GCodeProcessorResult::MoveVertex& move = gcode.moves[index];
        const ToolpathFeatureStyle* style = style_for(move.extrusion_role);
        if (move.internal_only || move.type != EMoveType::Extrude || style == nullptr ||
            !in_range(move, rendered) || !finite(move.position) ||
            !finite(gcode.moves[index - 1].position))
            continue;
        const ProjectedPoint from = screen(project(gcode.moves[index - 1].position, request.view));
        const ProjectedPoint to = screen(project(move.position, request.view));
        const int radius = std::clamp(
            static_cast<int>(std::lround(std::max(0.0f, move.width) * scale * 0.5)), 0, 6);
        draw_line(output.image, from.x, from.y, to.x, to.y, radius, style->rgb);
    }
    for (const GCodeProcessorResult::MoveVertex& move : gcode.moves) {
        if (move.internal_only || move.type != EMoveType::Seam ||
            !in_range(move, rendered) || !finite(move.position))
            continue;
        const ProjectedPoint seam = screen(project(move.position, request.view));
        const int x = static_cast<int>(std::lround(seam.x));
        const int y = static_cast<int>(std::lround(seam.y));
        draw_line(output.image, x - 3, y, x + 3, y, 1, SEAM_STYLE.rgb);
        draw_line(output.image, x, y - 3, x, y + 3, 1, SEAM_STYLE.rgb);
    }

    output.available_layers = available;
    output.rendered_layers = rendered;
    output.segment_count = segment_count;
    output.seam_count = seam_count;
    return output;
}

} // namespace Slic3r::GUI::Agent
