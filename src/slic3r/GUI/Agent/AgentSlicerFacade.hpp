#pragma once

#include <filesystem>
#include <memory>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

namespace Slic3r::GUI {

class Plater;

namespace Agent {

struct FacadeJobState
{
    bool           complete {false};
    bool           failed {false};
    double         progress {0.0};
    nlohmann::json result = nullptr;
    nlohmann::json error = nullptr;
    bool           cancelled {false};
    nlohmann::json warnings = nlohmann::json::array();
    nlohmann::json metadata = nullptr;
};

class AgentSlicerFacade
{
public:
    virtual ~AgentSlicerFacade() = default;

    virtual void create_project() = 0;
    virtual void start_model_import(const std::filesystem::path& path) = 0;
    virtual FacadeJobState model_import_state(bool allow_commit) = 0;
    virtual nlohmann::json scene() const = 0;
    virtual void transform_object(const nlohmann::json& transform) = 0;
    virtual void start_auto_orient(const nlohmann::json& request) = 0;
    virtual FacadeJobState auto_orient_state() const = 0;
    virtual void start_arrange() = 0;
    virtual FacadeJobState arrange_state() const = 0;
    virtual nlohmann::json render_scene(const nlohmann::json& request,
                                        const std::filesystem::path& screenshot_root) = 0;
    virtual nlohmann::json presets_list(const nlohmann::json& request) const = 0;
    virtual nlohmann::json presets_select(const nlohmann::json& request) = 0;
    virtual nlohmann::json settings_describe(const nlohmann::json& request) const = 0;
    virtual nlohmann::json settings_get(const nlohmann::json& request) const = 0;
    virtual nlohmann::json settings_apply(const nlohmann::json& request) = 0;
    virtual nlohmann::json job_metadata() const = 0;
    virtual std::string state_fingerprint() const = 0;
    virtual std::string configuration_fingerprint() const = 0;
    virtual void start_slice(std::optional<std::size_t> plate_index) = 0;
    virtual FacadeJobState slice_state() const = 0;
    virtual void start_gcode_export(const std::filesystem::path& path,
                                    std::size_t plate_index) = 0;
    virtual FacadeJobState gcode_export_state() const = 0;
    virtual void start_project_save(const std::filesystem::path& path) = 0;
    virtual FacadeJobState project_save_state() const = 0;
};

std::shared_ptr<AgentSlicerFacade> make_orca_agent_slicer_facade(Plater& plater);

} // namespace Agent
} // namespace Slic3r::GUI
