#pragma once

#include "libslic3r/ExtrusionEntity.hpp"
#include "libslic3r/GCode/ThumbnailData.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>

namespace Slic3r {

struct GCodeProcessorResult;

namespace GUI::Agent {

struct ToolpathFeatureStyle
{
    ExtrusionRole                     role;
    std::string_view                  key;
    std::string_view                  label;
    std::string_view                  hex;
    std::array<std::uint8_t, 3>       rgb;
};

struct ToolpathLayerRange
{
    unsigned int start;
    unsigned int end;
};

struct ToolpathRenderRequest
{
    unsigned int                      width;
    unsigned int                      height;
    std::string_view                  view;
    std::optional<ToolpathLayerRange> layer_range;
};

struct ToolpathRenderResult
{
    ThumbnailData      image;
    ToolpathLayerRange available_layers;
    ToolpathLayerRange rendered_layers;
    std::size_t        segment_count {0};
    std::size_t        seam_count {0};
};

const std::array<ToolpathFeatureStyle, 12>& toolpath_feature_styles();
const ToolpathFeatureStyle& toolpath_seam_style();

ToolpathRenderResult render_toolpaths(const GCodeProcessorResult& gcode,
                                      const ToolpathRenderRequest& request);

} // namespace GUI::Agent
} // namespace Slic3r
