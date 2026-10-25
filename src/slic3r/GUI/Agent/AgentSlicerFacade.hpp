#pragma once

#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

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

/** (object_id, instance_id) of one model instance. */
using InstanceTarget = std::pair<std::string, std::string>;

class AgentSlicerFacade
{
public:
    virtual ~AgentSlicerFacade() = default;

    virtual void create_project() = 0;
    virtual void restore_project(const std::filesystem::path& path) = 0;
    virtual void start_scene_export(const std::filesystem::path& path) = 0;
    virtual FacadeJobState scene_export_state() = 0;
    /** `display_name` replaces the snapshot's file name in imported object and volume names. */
    virtual void start_model_import(const std::filesystem::path& path,
                                    const std::string& display_name) = 0;
    virtual FacadeJobState model_import_state(bool allow_commit) = 0;
    virtual nlohmann::json scene() const = 0;
    virtual void transform_object(const nlohmann::json& transform) = 0;
    /** Deletes instances like Orca's object list; all instances delete the object. */
    virtual void delete_instances(const std::vector<InstanceTarget>& targets) = 0;
    /** Mirrors instances along a world axis (0 = X) around their own centers. */
    virtual void mirror_instances(const std::vector<InstanceTarget>& targets, int axis) = 0;
    virtual void rename_object(const std::string& object_id, const std::string& name) = 0;
    /**
     * Assigns a 1-based filament slot to an object, or to one of its model
     * parts or modifiers, like Orca's object list.
     */
    virtual void set_object_filament(const std::string& object_id,
                                     const std::optional<std::string>& volume_id,
                                     int filament) = 0;
    virtual void start_auto_orient(const nlohmann::json& request) = 0;
    virtual FacadeJobState auto_orient_state() const = 0;
    /** Arranges every plate, or only `plate_index` like Orca's plate icon. */
    virtual void start_arrange(std::optional<std::size_t> plate_index) = 0;
    /** Adds an empty plate like Orca's toolbar; returns its zero-based index. */
    virtual int add_plate() = 0;
    virtual void rename_plate(std::size_t plate_index, const std::string& name) = 0;
    /** Removes a plate like Orca's plate icon; its instances move off the plates. */
    virtual void delete_plate(std::size_t plate_index) = 0;
    /** Locked plates are skipped by arrange and auto-orient. */
    virtual void lock_plate(std::size_t plate_index, bool locked) = 0;
    virtual void move_plate_to_front(std::size_t plate_index) = 0;
    virtual FacadeJobState arrange_state() const = 0;
    virtual nlohmann::json render_scene(const nlohmann::json& request,
                                        const std::filesystem::path& screenshot_root) = 0;
    virtual nlohmann::json render_toolpaths(
        const nlohmann::json& request,
        const std::filesystem::path& screenshot_root,
        std::size_t plate_index) = 0;
    virtual nlohmann::json presets_list(const nlohmann::json& request) const = 0;
    virtual nlohmann::json presets_select(const nlohmann::json& request) = 0;
    /** Orca's sidebar printer section: models, variants, user presets and bed types. */
    virtual nlohmann::json printer_state() const = 0;
    // Every FFF printer model in Orca's resources, grouped by vendor.
    virtual nlohmann::json printer_catalog() const = 0;
    // Orca's Add printers wizard for one model: installs the vendor profiles
    // when needed, enables the model variant and selects it.
    virtual nlohmann::json install_printer_model(const std::string& vendor_id, const std::string& model_id,
                                                 const std::string& variant, bool discard_dirty) = 0;
    /** Applies `curr_bed_type` like Orca's bed type combo; `bed_type` is an enum value. */
    virtual void set_bed_type(const std::string& bed_type) = 0;
    /** Orca's sidebar filament section: slots with preset and color, and the presets. */
    virtual nlohmann::json filament_state() const = 0;
    // Orca's Process tab in Simple mode: presets, pages, groups and options.
    virtual nlohmann::json process_state() const = 0;
    // Orca's object settings tab for the given objects: effective values with
    // their overrides, Simple mode.
    virtual nlohmann::json object_settings(const std::vector<std::string>& object_ids) const = 0;
    // Sets per-object overrides (typed like settings_apply) and removes
    // reset_keys overrides on every given object.
    virtual void apply_object_settings(const std::vector<std::string>& object_ids,
                                       const nlohmann::json& changes,
                                       const std::vector<std::string>& reset_keys) = 0;
    /** Sets one slot's solid color (#RRGGBB) like Orca's filament color picker. */
    virtual void set_filament_color(std::size_t index, const std::string& color) = 0;
    // Orca's sidebar add filament button; returns the new zero-based slot.
    virtual std::size_t add_filament() = 0;
    // Orca's sidebar filament removal for one zero-based slot.
    virtual void delete_filament(std::size_t index) = 0;
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
    virtual void start_gcode_3mf_export(const std::filesystem::path& path,
                                        std::size_t plate_index) = 0;
    virtual FacadeJobState gcode_3mf_export_state() const = 0;
    virtual void start_project_save(const std::filesystem::path& path) = 0;
    virtual FacadeJobState project_save_state() const = 0;
    virtual void cancel_job(std::string_view type) = 0;
};

std::shared_ptr<AgentSlicerFacade> make_orca_agent_slicer_facade(Plater& plater);

} // namespace Agent
} // namespace Slic3r::GUI
