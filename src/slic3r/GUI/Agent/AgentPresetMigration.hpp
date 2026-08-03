#pragma once

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/PresetBundle.hpp"

namespace Slic3r::GUI::Agent {

inline bool has_legacy_preset_bootstrap(const PresetBundle& bundle, const AppConfig& config)
{
    static const AppConfig::VendorMap legacy_vendors {
        {PresetBundle::ORCA_DEFAULT_BUNDLE, {{"Generic ToolChanger Printer", {"0.4"}}}}
    };
    static const std::map<std::string, std::string> legacy_filaments {
        {"Generic PLA @MyToolChanger", "true"}
    };
    static const std::vector<std::string> legacy_filament_slots(
        5, "Generic PLA @MyToolChanger");

    return config.vendors() == legacy_vendors &&
        config.has_section(AppConfig::SECTION_FILAMENTS) &&
        config.get_section(AppConfig::SECTION_FILAMENTS) == legacy_filaments &&
        bundle.printers.get_selected_preset_name() == "MyToolChanger 0.4 nozzle" &&
        bundle.prints.get_selected_preset_name() == "0.20mm Standard @MyToolChanger" &&
        bundle.filament_presets == legacy_filament_slots;
}

} // namespace Slic3r::GUI::Agent
