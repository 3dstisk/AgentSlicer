#pragma once

#include "AgentProtocol.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <set>
#include <string>
#include <string_view>

namespace Slic3r::GUI::Agent {

inline constexpr std::size_t MaxAgentConfigValueBytes = 64u * 1024u;

inline bool is_agent_setting_allowed(std::string_view key)
{
    static const std::set<std::string> denied {
        "bed_custom_model", "bed_custom_texture", "printhost_cafile",
        "post_process", "slicing_pipeline_plugin", "plugins",
        "print_host", "print_host_webui", "printer_agent", "bbl_use_printhost",
        "datadir", "logfile", "outputdir", "input_filename_base", "filename_format",
        "print_plugin_config_overrides", "printer_plugin_config_overrides",
        "filament_plugin_config_overrides"
    };
    std::string normalized(key);
    std::transform(normalized.begin(), normalized.end(), normalized.begin(),
                   [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    if (denied.count(normalized) != 0 ||
        normalized.rfind("printhost_", 0) == 0 ||
        normalized.rfind("host_", 0) == 0)
        return false;
    static constexpr std::array<std::string_view, 10> unsafe_fragments {
        "password", "credential", "api_key", "apikey", "token", "secret",
        "plugin", "script", "executable", "authorization"
    };
    if (std::any_of(unsafe_fragments.begin(), unsafe_fragments.end(),
                    [&](std::string_view fragment) {
                        return normalized.find(fragment) != std::string::npos;
                    }))
        return false;
    static constexpr std::array<std::string_view, 6> unsafe_suffixes {
        "_path", "_file", "_directory", "_url", "_command", "_gcode"
    };
    return std::none_of(unsafe_suffixes.begin(), unsafe_suffixes.end(),
                        [&](std::string_view suffix) {
                            return normalized.size() >= suffix.size() &&
                                normalized.compare(normalized.size() - suffix.size(),
                                                   suffix.size(), suffix) == 0;
                        });
}

enum class StructuredSettingShape
{
    Point2,
    Point3,
    Point2Array,
    Point2Groups,
    IntegerGroups
};

template<class InRange>
void validate_structured_setting(const nlohmann::json& value, StructuredSettingShape shape,
                                 const std::string& key, InRange in_range)
{
    const auto invalid = [&]() {
        throw AgentError(ErrorCode::InvalidRequest,
                         "Setting value does not match its bounded structured type",
                         {{"key", key}});
    };
    const auto validate_number = [&](const nlohmann::json& number, bool integer) {
        if (!number.is_number() || !std::isfinite(number.get<double>()))
            invalid();
        if (integer) {
            if (!number.is_number_integer())
                invalid();
            if (number.is_number_unsigned()) {
                if (number.get<std::uint64_t>() >
                    static_cast<std::uint64_t>(std::numeric_limits<int>::max()))
                    invalid();
            } else {
                const std::int64_t typed = number.get<std::int64_t>();
                if (typed < std::numeric_limits<int>::min() ||
                    typed > std::numeric_limits<int>::max())
                    invalid();
            }
        }
        const double typed = number.get<double>();
        if (!in_range(typed))
            throw AgentError(ErrorCode::InvalidRequest,
                             "Structured setting component is outside its valid range",
                             {{"key", key}, {"value", typed}});
    };
    const auto validate_point = [&](const nlohmann::json& point, size_t dimensions) {
        if (!point.is_array() || point.size() != dimensions)
            invalid();
        for (const auto& coordinate : point)
            validate_number(coordinate, false);
    };

    switch (shape) {
    case StructuredSettingShape::Point2:
        validate_point(value, 2);
        return;
    case StructuredSettingShape::Point3:
        validate_point(value, 3);
        return;
    case StructuredSettingShape::Point2Array:
        if (!value.is_array())
            invalid();
        for (const auto& point : value)
            validate_point(point, 2);
        return;
    case StructuredSettingShape::Point2Groups:
        if (!value.is_array())
            invalid();
        for (const auto& group : value) {
            if (!group.is_array())
                invalid();
            for (const auto& point : group)
                validate_point(point, 2);
        }
        return;
    case StructuredSettingShape::IntegerGroups:
        if (!value.is_array())
            invalid();
        for (const auto& group : value) {
            if (!group.is_array())
                invalid();
            for (const auto& integer : group)
                validate_number(integer, true);
        }
        return;
    }
}

} // namespace Slic3r::GUI::Agent
