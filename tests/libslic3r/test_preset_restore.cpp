#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_message.hpp>
#include <catch2/generators/catch_generators.hpp>
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/PrintConfig.hpp"
#include <string>
#include <vector>

using namespace Slic3r;

namespace {
DynamicPrintConfig restore_config(const std::vector<std::string>& names)
{
    DynamicPrintConfig config = DynamicPrintConfig::full_print_config();
    config.opt_string("printer_settings_id", true) = "Standalone printer";
    config.opt_string("print_settings_id", true) = "Standalone process";
    config.option<ConfigOptionStrings>("filament_settings_id", true)->values = names;
    config.opt<ConfigOptionStrings>("filament_colour")->values = {"#102030", "#A0B0C0"};
    config.opt<ConfigOptionStrings>("filament_type")->values = {"PLA", "PETG"};
    config.opt<ConfigOptionFloats>("filament_diameter")->values = {1.75, 1.75};
    config.option<ConfigOptionStrings>("extruder_variant_list", true)->values = {"Direct Drive Standard,Direct Drive High Flow"};
    config.opt<ConfigOptionInts>("filament_self_index")->values = {1, 1, 2, 2};
    config.opt<ConfigOptionStrings>("filament_extruder_variant")->values = {
        "Direct Drive Standard", "Direct Drive High Flow", "Direct Drive Standard", "Direct Drive High Flow"};
    config.opt<ConfigOptionInts>("nozzle_temperature")->values = {201, 211, 231, 241};
    config.opt_float("layer_height") = 0.18;
    for (const auto& key : filament_options_with_variant)
        if (ConfigOption* option = config.option(key); option && option->nullable())
            static_cast<ConfigOptionVectorBase*>(option)->resize(4);
    const std::string changed = Slic3r::escape_strings_cstyle(config.keys());
    config.option<ConfigOptionStrings>("different_settings_to_system", true)->values = {"", changed, changed, ""};
    Preset::normalize(config);
    return config;
}

void require_same_config(const DynamicPrintConfig& before, const DynamicPrintConfig& after)
{
    // Native serialization may expand inactive nullable defaults across variants.
    // Canonicalize only all-nil options; every active setting and variant must match.
    DynamicPrintConfig effective_before(before), effective_after(after);
    effective_before.remove_nil_options();
    effective_after.remove_nil_options();
    const auto differences = effective_before.diff(effective_after);
    std::string changed;
    for (const auto& key : differences) changed += key + ": " + before.opt_serialize(key) + " -> " + after.opt_serialize(key) + "\n";
    INFO(changed);
    REQUIRE(differences.empty());
}
}

TEST_CASE("Agent restore retains parentless preset names and effective variant configuration", "[PresetRestore]")
{
    const bool repeated = GENERATE(false, true);
    const std::string long_name = std::string(140, 'a') + " Černá(import-old.3mf)";
    const std::vector<std::string> names {long_name, repeated ? long_name : "Šedá(import-old.3mf)"};
    DynamicPrintConfig checkpoint = restore_config(names);
    std::vector<std::string> selected;
    for (const std::string filename : {"private-A.3mf", "private-B.3mf", "private-C.3mf"}) {
        PresetBundle bundle;
        bundle.load_config_model(filename, checkpoint, Semver(), nullptr, true);
        const auto restored = bundle.full_config_secure();
        REQUIRE(restored.opt<ConfigOptionStrings>("filament_colour")->values == std::vector<std::string>{"#102030", "#A0B0C0"});
        REQUIRE(restored.opt<ConfigOptionStrings>("filament_type")->values == std::vector<std::string>{"PLA", "PETG"});
        REQUIRE(restored.opt<ConfigOptionInts>("filament_self_index")->values == std::vector<int>{1, 1, 2, 2});
        REQUIRE(restored.opt<ConfigOptionStrings>("filament_extruder_variant")->values == std::vector<std::string>{"Direct Drive Standard", "Direct Drive High Flow", "Direct Drive Standard", "Direct Drive High Flow"});
        if (selected.empty()) {
            selected = bundle.filament_presets;
            REQUIRE(selected.size() == 2);
            REQUIRE(selected[0] != selected[1]);
            REQUIRE(restored.opt<ConfigOptionInts>("nozzle_temperature")->values ==
                std::vector<int>{201, 211, 231, 241});
        } else {
            REQUIRE(bundle.filament_presets == selected);
            require_same_config(checkpoint, restored);
        }
        for (const auto& name : bundle.filament_presets)
            REQUIRE(name.find(filename) == std::string::npos);
        checkpoint = restored;
    }
}

TEST_CASE("Desktop imports retain filename suffixes for standalone presets", "[PresetRestore]")
{
    PresetBundle bundle;
    bundle.load_config_model("desktop.3mf", restore_config({"First", "Second"}));
    REQUIRE(bundle.filament_presets[0] == "First(desktop.3mf)");
    REQUIRE(bundle.filament_presets[1] == "Second(desktop.3mf)");
}

TEST_CASE("Agent restore does not overwrite conflicting non-system presets", "[PresetRestore]")
{
    DynamicPrintConfig checkpoint = restore_config({"Existing", "Existing"});
    std::vector<std::string> selected;
    for (const std::string filename : {"private-A.3mf", "private-B.3mf", "private-C.3mf"}) {
        PresetBundle bundle;
        DynamicPrintConfig existing(bundle.filaments.default_preset().config);
        existing.opt<ConfigOptionInts>("nozzle_temperature")->values = {190};
        bundle.filaments.load_preset("", "Existing", existing, false);
        const DynamicPrintConfig original = bundle.filaments.find_preset("Existing", false, true)->config;
        bundle.load_config_model(filename, checkpoint, Semver(), nullptr, true);
        REQUIRE(bundle.filament_presets[0] != bundle.filament_presets[1]);
        require_same_config(original, bundle.filaments.find_preset("Existing", false, true)->config);
        const auto restored = bundle.full_config_secure();
        REQUIRE(restored.opt<ConfigOptionInts>("nozzle_temperature")->values == std::vector<int>{201, 211, 231, 241});
        REQUIRE(restored.opt<ConfigOptionStrings>("filament_type")->values == std::vector<std::string>{"PLA", "PETG"});
        REQUIRE(restored.opt<ConfigOptionStrings>("filament_colour")->values == std::vector<std::string>{"#102030", "#A0B0C0"});
        if (selected.empty()) selected = bundle.filament_presets;
        else {
            REQUIRE(bundle.filament_presets == selected);
            require_same_config(checkpoint, restored);
        }
        checkpoint = restored;
    }
}

TEST_CASE("Agent restore keeps conflicting system filament slots distinct", "[PresetRestore]")
{
    PresetBundle seed;
    seed.load_config_model("seed.3mf", restore_config({"First", "Second"}), Semver(), nullptr, true);
    DynamicPrintConfig system(seed.filaments.find_preset(seed.filament_presets[1], false, true)->config);
    system.option<ConfigOptionStrings>("filament_settings_id", true)->values = {"System filament"};
    DynamicPrintConfig checkpoint = restore_config({"System filament", "System filament"});
    std::vector<std::string> selected;
    for (const std::string filename : {"private-A.3mf", "private-B.3mf", "private-C.3mf"}) {
        PresetBundle bundle;
        bundle.filaments.load_preset("", "System filament", system, false).is_system = true;
        bundle.load_config_model(filename, checkpoint, Semver(), nullptr, true);
        REQUIRE(bundle.filament_presets[0] != bundle.filament_presets[1]);
        const auto restored = bundle.full_config_secure();
        REQUIRE(restored.opt<ConfigOptionInts>("nozzle_temperature")->values == std::vector<int>{201, 211, 231, 241});
        REQUIRE(restored.opt<ConfigOptionStrings>("filament_type")->values == std::vector<std::string>{"PLA", "PETG"});
        REQUIRE(restored.opt<ConfigOptionStrings>("filament_colour")->values == std::vector<std::string>{"#102030", "#A0B0C0"});
        REQUIRE(bundle.filaments.find_preset(bundle.filament_presets[0], false, true)->inherits() == "System filament");
        require_same_config(system, bundle.filaments.find_preset("System filament", false, true)->config);
        if (selected.empty()) selected = bundle.filament_presets;
        else {
            REQUIRE(bundle.filament_presets == selected);
            require_same_config(checkpoint, restored);
        }
        checkpoint = restored;
    }
}

TEST_CASE("Agent single-filament restore retains ordinary system overrides", "[PresetRestore]")
{
    PresetBundle seed;
    seed.load_config_model("seed.3mf", restore_config({"First", "Second"}), Semver(), nullptr, true);
    DynamicPrintConfig system(seed.filaments.find_preset(seed.filament_presets[1], false, true)->config);
    system.option<ConfigOptionStrings>("filament_settings_id", true)->values = {"System filament"};
    PresetBundle bundle;
    bundle.filaments.load_preset("", "System filament", system, false).is_system = true;
    auto config = restore_config({"System filament"});
    config.opt<ConfigOptionStrings>("filament_colour")->values = {"#102030"};
    config.opt<ConfigOptionStrings>("filament_type")->values = {"PLA"};
    config.opt<ConfigOptionFloats>("filament_diameter")->values = {1.75};
    config.opt<ConfigOptionInts>("filament_self_index")->values = {1, 1};
    config.opt<ConfigOptionStrings>("filament_extruder_variant")->values = {"Direct Drive Standard", "Direct Drive High Flow"};
    config.opt<ConfigOptionInts>("nozzle_temperature")->values = {201, 211};
    bundle.load_config_model("private.3mf", config, Semver(), nullptr, true);
    REQUIRE(bundle.filament_presets == std::vector<std::string>{"System filament"});
    REQUIRE(bundle.full_config_secure().opt<ConfigOptionInts>("nozzle_temperature")->values == std::vector<int>{201, 211});
}
