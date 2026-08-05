#include <catch2/catch_all.hpp>

#include "slic3r/GUI/Agent/AgentBridge.hpp"
#include "slic3r/GUI/Agent/AgentImportLimits.hpp"
#include "slic3r/GUI/Agent/AgentController.hpp"
#include "slic3r/GUI/Agent/AgentProtocol.hpp"
#include "slic3r/GUI/Agent/AgentProcessTracker.hpp"
#include "slic3r/GUI/Agent/AgentSettingValidation.hpp"
#include "slic3r/GUI/Agent/AgentToolpathRenderer.hpp"
#include "slic3r/GUI/Agent/RenderArtifactRollback.hpp"
#include "slic3r/GUI/Agent/SecureFile.hpp"
#include "libslic3r/GCode/GCodeProcessor.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <future>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#if defined(__linux__)
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#endif

using namespace Slic3r::GUI::Agent;

namespace {

class FakeFacade final : public AgentSlicerFacade
{
public:
    void create_project() override
    {
        ++create_calls;
        if (on_create)
            on_create();
        if (fail_create)
            throw AgentError(ErrorCode::InternalError, "native reset failed");
    }
    void start_model_import(const std::filesystem::path& path) override
    {
        imported_path = path;
        std::ifstream input(path, std::ios::binary);
        imported_contents.assign(std::istreambuf_iterator<char>(input),
                                 std::istreambuf_iterator<char>());
        if (on_import)
            on_import(path);
        if (fail_import)
            throw AgentError(ErrorCode::InternalError, "native import failed");
        import_started = true;
    }
    FacadeJobState model_import_state(bool allow_commit) override
    {
        if (!import_started)
            return {true, true, 1.0, nullptr, {{"message", "not started"}}};
        if (!allow_commit)
            return {true, false, 1.0, nullptr, nullptr, true};
        const std::size_t previous_objects = live_import_objects;
        for (std::size_t index = 0; index < fake_import_object_count; ++index) {
            ++live_import_objects;
            if (inject_import_commit_failure_after != 0 &&
                live_import_objects - previous_objects ==
                    inject_import_commit_failure_after) {
                agent_import_rollback_used = true;
                import_rollback_snapshot = import_owned_snapshot;
                failed_import_redo_discarded = true;
                live_import_objects = previous_objects;
                return {true, true, 1.0, nullptr,
                        {{"message", "injected import commit failure"}}};
            }
        }
        import_committed = true;
        return next_import_state.complete ? next_import_state :
            FacadeJobState {true, false, 1.0, {{"object_ids", {"object_10"}}}, nullptr};
    }
    nlohmann::json scene() const override
    {
        return {{"objects", {{{"object_id", "object_10"}}}}, {"plates", nlohmann::json::array()}};
    }
    void transform_object(const nlohmann::json& value) override { last_transform = value; }
    void start_auto_orient(const nlohmann::json& request) override
    {
        auto_orient_started = true;
        last_auto_orient = request;
        auto_orient_owned_fingerprint = fingerprint;
        if (on_auto_orient_start)
            on_auto_orient_start();
    }
    FacadeJobState auto_orient_state() const override
    {
        FacadeJobState state = next_auto_orient_state;
        if (state.complete && !state.failed && state.result.is_object())
            state.result["scene_fingerprint"] = auto_orient_owned_fingerprint;
        return state;
    }
    void start_arrange() override
    {
        arrange_started = true;
        if (on_arrange_start)
            on_arrange_start();
        arrange_owned_fingerprint = fingerprint;
    }
    FacadeJobState arrange_state() const override
    {
        FacadeJobState state = next_arrange_state;
        if (state.complete && !state.failed && state.result.is_object())
            state.result["scene_fingerprint"] = arrange_owned_fingerprint;
        return state;
    }
    nlohmann::json render_scene(const nlohmann::json& request,
                                const std::filesystem::path& root) override
    {
        last_render = request;
        render_root = root;
        return {{"images", {{{"view", request["views"][0]}, {"path", (root / "fake.png").string()}}}}};
    }
    nlohmann::json render_toolpaths(const nlohmann::json& request,
                                    const std::filesystem::path& root,
                                    std::size_t plate_index) override
    {
        last_toolpath_render = request;
        render_root = root;
        rendered_plate_index = plate_index;
        return {
            {"plate_index", plate_index},
            {"available_layer_range", {{"start", 0}, {"end", 20}}},
            {"rendered_layer_range", request.value(
                "layer_range", nlohmann::json {{"start", 0}, {"end", 20}})},
            {"legend", nlohmann::json::array()},
            {"excluded_move_types", {"travel", "wipe"}},
            {"images", {{{"view", request["views"][0]},
                           {"path", (root / "toolpath.png").string()}}}}
        };
    }
    nlohmann::json presets_list(const nlohmann::json& request) const override
    {
        last_presets_list = request;
        return {
            {"selected", {{"printer", "Printer A"}, {"process", "Process A"}, {"filaments", {"PLA A", "PLA B"}}}},
            {"presets", {{{"scope", "printer"}, {"name", "Printer A"}, {"selected", true}, {"compatible", true}}}}
        };
    }
    nlohmann::json presets_select(const nlohmann::json& request) override
    {
        last_presets_select = request;
        if (fail_presets_select)
            throw AgentError(ErrorCode::InvalidRequest, "invalid native selection");
        const auto& selection = request.at("selection");
        return {{"selected",
                 {{"printer", selection.value("printer", "Printer A")},
                  {"process", selection.value("process", "Process A")},
                  {"filaments", selection.value("filaments", nlohmann::json::array({"PLA A", "PLA B"}))}}},
                {"changed", preset_selection_changed}};
    }
    nlohmann::json settings_describe(const nlohmann::json& request) const override
    {
        last_settings_describe = request;
        return {
            {"items", {{{"key", "layer_height"}, {"scope", "process"}, {"label", "Layer height"},
                        {"description", "Layer height"}, {"type", "float"}, {"nullable", false},
                        {"read_only", false}, {"unit", "mm"}, {"min", 0.01}, {"max", 2.0},
                        {"max_literal", nullptr}, {"enum_values", nullptr}}}},
            {"next_cursor", nullptr}
        };
    }
    nlohmann::json settings_get(const nlohmann::json& request) const override
    {
        last_settings_get = request;
        return {{"values", {{{"key", "layer_height"}, {"scope", "process"},
                             {"value", 0.2}, {"unit", "mm"}}}}};
    }
    nlohmann::json settings_apply(const nlohmann::json& request) override
    {
        last_settings_apply = request;
        if (fail_settings_apply)
            throw AgentError(ErrorCode::InvalidRequest, "invalid native settings");
        return {{"dry_run", request.value("dry_run", false)}, {"applied", request.at("changes")}};
    }
    nlohmann::json job_metadata() const override
    {
        if (throw_metadata_runtime)
            throw std::runtime_error("sensitive metadata failure");
        if (throw_metadata_unknown)
            throw 7;
        if (!custom_job_metadata.is_null())
            return custom_job_metadata;
        return {{"selected_presets", {{"printer", "Printer A"}, {"process", "Process A"},
                                      {"filaments", {"PLA A"}}}},
                {"config_snapshot",
                 {{"schema_version", 2},
                  {"settings", {{"layer_height", "0.2"}}},
                  {"overrides", nlohmann::json::array()},
                  {"redacted_keys", nlohmann::json::array()},
                  {"sha256", std::string(64, 'a')},
                  {"bytes", 22}}}};
    }
    std::string state_fingerprint() const override { return fingerprint; }
    std::string configuration_fingerprint() const override
    {
        return config_fingerprint;
    }
    void start_slice(std::optional<std::size_t> plate_index) override
    {
        last_plate_index = plate_index;
        slice_started = true;
    }
    FacadeJobState slice_state() const override { return next_slice_state; }
    void start_gcode_export(const std::filesystem::path& path,
                            std::size_t plate_index) override
    {
        export_path = path;
        export_plate_index = plate_index;
        if (write_export)
            std::ofstream(path) << export_contents;
    }
    FacadeJobState gcode_export_state() const override
    {
        if (on_export_state)
            on_export_state();
        return next_export_state;
    }
    void start_project_save(const std::filesystem::path& path) override
    {
        save_path = path;
        if (on_save)
            on_save();
        if (fail_save)
            throw AgentError(ErrorCode::InternalError, "native save startup failed");
        if (write_save)
            std::ofstream(path) << "3MF";
    }
    FacadeJobState project_save_state() const override
    {
        FacadeJobState state = next_save_state;
        state.metadata = job_metadata();
        return state;
    }
    void cancel_job(std::string_view type) override
    {
        cancelled_job_types.emplace_back(type);
        if (fail_cancel)
            throw AgentError(ErrorCode::InvalidJobTransition,
                             "native job is no longer cancellable");
    }

    int create_calls {0};
    std::function<void()> on_create;
    bool fail_create {false};
    bool arrange_started {false};
    std::function<void()> on_arrange_start;
    std::string arrange_owned_fingerprint;
    std::filesystem::path imported_path;
    std::string imported_contents;
    std::function<void(const std::filesystem::path&)> on_import;
    bool fail_import {false};
    bool import_started {false};
    bool import_committed {false};
    std::size_t live_import_objects {0};
    std::size_t fake_import_object_count {1};
    std::size_t inject_import_commit_failure_after {0};
    bool assemble_view_blocks_ui_undo {false};
    bool agent_import_rollback_used {false};
    std::size_t import_pre_transaction_snapshot {41};
    std::size_t import_owned_snapshot {73};
    std::size_t import_rollback_snapshot {0};
    bool failed_import_redo_discarded {false};
    FacadeJobState next_import_state;
    std::filesystem::path render_root;
    nlohmann::json last_transform;
    bool auto_orient_started {false};
    nlohmann::json last_auto_orient;
    std::function<void()> on_auto_orient_start;
    std::string auto_orient_owned_fingerprint;
    FacadeJobState next_auto_orient_state;
    nlohmann::json last_render;
    nlohmann::json last_toolpath_render;
    std::optional<std::size_t> rendered_plate_index;
    mutable nlohmann::json last_presets_list;
    nlohmann::json last_presets_select;
    mutable nlohmann::json last_settings_describe;
    mutable nlohmann::json last_settings_get;
    nlohmann::json last_settings_apply;
    bool fail_presets_select {false};
    bool preset_selection_changed {true};
    bool fail_settings_apply {false};
    FacadeJobState next_arrange_state;
    bool slice_started {false};
    std::optional<std::size_t> last_plate_index;
    FacadeJobState next_slice_state;
    bool write_export {true};
    std::string export_contents {"G1 X0\n"};
    bool write_save {true};
    bool fail_save {false};
    std::function<void()> on_save;
    std::filesystem::path export_path;
    std::optional<std::size_t> export_plate_index;
    std::filesystem::path save_path;
    FacadeJobState next_export_state;
    mutable std::function<void()> on_export_state;
    FacadeJobState next_save_state;
    std::vector<std::string> cancelled_job_types;
    bool fail_cancel {false};
    std::string fingerprint {"native-1"};
    std::string config_fingerprint {"config-1"};
    nlohmann::json custom_job_metadata;
    bool throw_metadata_runtime {false};
    bool throw_metadata_unknown {false};
};

class TestWorkspace
{
public:
    TestWorkspace()
    {
        root = std::filesystem::temp_directory_path() /
               ("agent-slicer-controller-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(root);
        std::filesystem::create_directories(root / "imports");
        std::filesystem::create_directories(root / "artifacts");
        std::ofstream(root / "part.stl") << "solid empty\nendsolid empty\n";
        std::ofstream(root / "not-model.txt") << "text";
        std::ofstream(root / "oversized.stl") << std::string(64, 'x');
    }
    ~TestWorkspace() { std::filesystem::remove_all(root); }
    std::filesystem::path root;
};

nlohmann::json metadata_near_snapshot_limit()
{
    constexpr std::size_t snapshot_limit = 512u * 1024u;
    constexpr std::size_t native_target = snapshot_limit - 8u;
    nlohmann::json metadata {
        {"selected_presets", {{"printer", "Printer A"}, {"process", "Process A"},
                              {"filaments", {"PLA A"}}}},
        {"config_snapshot",
         {{"schema_version", 2},
          {"settings", {{"padding", ""}}},
          {"overrides", nlohmann::json::array()},
          {"redacted_keys", nlohmann::json::array()},
          {"sha256", std::string(64, 'a')},
          {"bytes", 1}}}
    };
    auto& native = metadata["config_snapshot"];
    const std::size_t base = native.dump().size();
    if (base >= native_target)
        throw std::logic_error("Snapshot boundary fixture is unexpectedly large");
    native["settings"]["padding"] = std::string(native_target - base, 'x');
    if (native.dump().size() != native_target)
        throw std::logic_error("Snapshot boundary fixture is not exact");
    return metadata;
}

nlohmann::json print_metrics_fixture()
{
    return {
        {"time", {{"normal_seconds", 3725.5}, {"silent_seconds", nullptr},
                  {"preparation_seconds", 18.25}}},
        {"filament", {
            {"used_length_mm", 12345.6}, {"extruded_volume_mm3", 29700.2},
            {"weight_g", 36.8}, {"total_cost", 1.42},
            {"wipe_tower_used_length_mm", 320.5}, {"wipe_tower_cost", 0.08},
            {"per_extruder", {{{"extruder_id", 0}, {"model_volume_mm3", 28000.0},
                                {"support_volume_mm3", 500.0},
                                {"wipe_tower_volume_mm3", 700.0},
                                {"flushed_volume_mm3", 500.2},
                                {"total_volume_mm3", 29700.2}}}},
            {"per_feature", {{{"feature", "outer_wall"},
                               {"used_length_mm", 2345.6}, {"weight_g", 7.1}}}}
        }},
        {"changes", {{"tool_changes", 2}, {"filament_changes", 3},
                     {"extruder_changes", 2}}},
        {"travel", {{"distance_mm", 40000.0}, {"move_count", 900}}},
        {"initial_tool", 0}
    };
}

} // namespace

TEST_CASE("Structured settings validate every numeric component against bounds", "[AgentBridge]")
{
    const auto within_probe_distance = [](double value) {
        return value >= 0.0 && value <= 100.0;
    };

    REQUIRE_NOTHROW(validate_structured_setting(
        nlohmann::json::array({50.0, 25.0}), StructuredSettingShape::Point2,
        "bed_mesh_probe_distance", within_probe_distance));
    REQUIRE_THROWS_AS(validate_structured_setting(
        nlohmann::json::array({50.0, -1.0}), StructuredSettingShape::Point2,
        "bed_mesh_probe_distance", within_probe_distance), AgentError);

    REQUIRE_NOTHROW(validate_structured_setting(
        nlohmann::json::array({
            nlohmann::json::array({0.0, 0.0}),
            nlohmann::json::array({100.0, 100.0})
        }),
        StructuredSettingShape::Point2Array, "bed_shape", within_probe_distance));
    REQUIRE_THROWS_AS(validate_structured_setting(
        nlohmann::json::array({
            nlohmann::json::array({0.0, 0.0}),
            nlohmann::json::array({101.0, 100.0})
        }),
        StructuredSettingShape::Point2Array, "bed_shape", within_probe_distance), AgentError);

    REQUIRE_NOTHROW(validate_structured_setting(
        nlohmann::json::array({
            nlohmann::json::array({
                nlohmann::json::array({0.0, 0.0}),
                nlohmann::json::array({100.0, 100.0})
            })
        }),
        StructuredSettingShape::Point2Groups, "extruder_printable_area",
        within_probe_distance));
    REQUIRE_THROWS_AS(validate_structured_setting(
        nlohmann::json::array({
            nlohmann::json::array({
                nlohmann::json::array({0.0, -0.01})
            })
        }),
        StructuredSettingShape::Point2Groups, "extruder_printable_area",
        within_probe_distance), AgentError);

    REQUIRE_NOTHROW(validate_structured_setting(
        nlohmann::json::array({
            nlohmann::json::array({0, 50, 100})
        }),
        StructuredSettingShape::IntegerGroups, "integer_groups",
        within_probe_distance));
    REQUIRE_THROWS_AS(validate_structured_setting(
        nlohmann::json::array({
            nlohmann::json::array({0, 101})
        }),
        StructuredSettingShape::IntegerGroups, "integer_groups",
        within_probe_distance), AgentError);
}

TEST_CASE("Agent process tracker ignores stale prior-run progress and completion", "[AgentBridge]")
{
    AgentProcessTracker tracker;
    tracker.begin(42);
    REQUIRE_FALSE(tracker.update_progress(41, 0.9));
    REQUIRE_FALSE(tracker.finish(41, AgentProcessOutcome::Cancelled));
    REQUIRE(tracker.snapshot().active);
    REQUIRE_FALSE(tracker.snapshot().terminal);
    REQUIRE(tracker.snapshot().progress == 0.0);

    REQUIRE(tracker.update_progress(42, 0.35));
    REQUIRE(tracker.update_progress(42, 0.2));
    REQUIRE(tracker.snapshot().progress == 0.35);
    REQUIRE(tracker.finish(42, AgentProcessOutcome::Succeeded));
    REQUIRE(tracker.snapshot().terminal);
    REQUIRE(tracker.snapshot().succeeded);
    REQUIRE(tracker.snapshot().progress == 1.0);
}

TEST_CASE("Bridge framing decodes fragmented and consecutive messages", "[AgentBridge]")
{
    const auto first = encode_frame(R"({"id":"one"})");
    const auto second = encode_frame(R"({"id":"two"})");
    std::vector<std::uint8_t> bytes = first;
    bytes.insert(bytes.end(), second.begin(), second.end());

    FrameDecoder decoder;
    const auto incomplete = decoder.append(bytes.data(), 3);
    REQUIRE(incomplete.empty());

    const auto messages = decoder.append(bytes.data() + 3, bytes.size() - 3);
    REQUIRE(messages.size() == 2);
    REQUIRE(messages[0] == R"({"id":"one"})");
    REQUIRE(messages[1] == R"({"id":"two"})");
}

TEST_CASE("Bridge framing rejects oversized messages", "[AgentBridge]")
{
    FrameDecoder decoder(8);
    const std::vector<std::uint8_t> header {0, 0, 0, 9};

    try {
        decoder.append(header.data(), header.size());
        FAIL("Expected an AgentError");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::MessageTooLarge);
    }

    const nlohmann::json oversized_response {
        {"result", std::string(MAX_MESSAGE_SIZE, 'x')}
    };
    REQUIRE_THROWS_AS(encode_json_frame(oversized_response), AgentError);
}

TEST_CASE("Bridge requests require stable identifiers and object parameters", "[AgentBridge]")
{
    const Request request = parse_request(R"({"id":"request-1","method":"slicer_status"})");
    REQUIRE(request.id == "request-1");
    REQUIRE(request.method == "slicer_status");
    REQUIRE(request.params.is_object());

    REQUIRE_THROWS_AS(parse_request(R"({"method":"slicer_status"})"), AgentError);
    REQUIRE_THROWS_AS(
        parse_request(R"({"id":"request-1","method":"slicer_status","params":[]})"),
        AgentError);
    REQUIRE(request_id_or_null(
                R"({"id":"request-1","method":"slicer_status","params":[]})") == "request-1");
    REQUIRE_THROWS_AS(
        parse_request(nlohmann::json({
            {"id", std::string(MAX_REQUEST_ID_SIZE + 1, 'i')},
            {"method", "slicer_status"}
        }).dump()),
        AgentError);
}

TEST_CASE("Project handles are opaque and revisions increase monotonically", "[AgentBridge]")
{
    AgentController controller(std::make_shared<FakeFacade>());
    const auto initial = controller.handle({"status", "slicer_status", {}});
    REQUIRE(initial["project_id"].is_null());
    REQUIRE(initial["revision"].get<std::uint64_t>() == 0);

    const auto first = controller.handle({"create-1", "project_create", {}});
    const std::string first_id = first["project_id"].get<std::string>();
    REQUIRE(first_id.rfind("project_", 0) == 0);
    REQUIRE(first["revision"].get<std::uint64_t>() == 1);

    const auto current = controller.handle(
        {"get-1", "project_get", {{"project_id", first_id}, {"expected_revision", 1}}});
    REQUIRE(current["project_id"] == first_id);

    const auto second = controller.handle({"create-2", "project_create", {}});
    REQUIRE(second["project_id"] != first_id);
    REQUIRE(second["revision"].get<std::uint64_t>() == 2);

    try {
        controller.handle({"stale", "project_get",
                           {{"project_id", second["project_id"]}, {"expected_revision", 1}}});
        FAIL("Expected a revision conflict");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::RevisionConflict);
        REQUIRE(error.details()["actual_revision"] == 2);
    }
}

TEST_CASE("Native project failure does not publish controller state", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    facade->fail_create = true;
    REQUIRE_THROWS_AS(controller.handle({"create", "project_create", {}}), AgentError);
    const auto status = controller.handle({"status", "slicer_status", {}});
    REQUIRE(status["project_id"].is_null());
    REQUIRE(status["revision"] == 0);
}

TEST_CASE("Import paths stay beneath workspace and revision commits after native success", "[AgentBridge]")
{
    TestWorkspace workspace;
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, workspace.root / "outputs",
                               workspace.root / "imports");
    const auto project = controller.handle({"create", "project_create", {}});

    const auto imported = controller.handle(
        {"import", "model_import", {{"project_id", project["project_id"]},
                                    {"expected_revision", project["revision"]},
                                    {"path", "part.stl"}}});
    REQUIRE(facade->imported_path.parent_path() == workspace.root / "imports");
    REQUIRE(facade->imported_path.extension() == ".stl");
    REQUIRE(facade->imported_contents == "solid empty\nendsolid empty\n");
    REQUIRE(std::filesystem::exists(facade->imported_path));
    const auto completed =
        controller.handle({"import-get", "job_get", {{"job_id", imported["job_id"]}}});
    REQUIRE_FALSE(std::filesystem::exists(facade->imported_path));
    REQUIRE(completed["result"]["object_ids"][0] == "object_10");
    REQUIRE(completed["revision"] == 2);
    REQUIRE(completed["metadata"].is_object());
    REQUIRE(completed["metadata"].empty());

    REQUIRE_THROWS_AS(
        controller.handle({"escape", "model_import",
                           {{"project_id", project["project_id"]}, {"expected_revision", 2},
                            {"path", "../outside.stl"}}}),
        AgentError);
    REQUIRE_THROWS_AS(
        controller.handle({"format", "model_import",
                           {{"project_id", project["project_id"]}, {"expected_revision", 2},
                            {"path", "not-model.txt"}}}),
        AgentError);
}

TEST_CASE("Import preparation accepts STEP extensions", "[AgentBridge]")
{
    TestWorkspace workspace;
    for (const std::string extension : {".step", ".STP"}) {
        DYNAMIC_SECTION("Extension " << extension) {
            const std::string filename = "part" + extension;
            std::ofstream(workspace.root / filename) << "STEP fixture";
            TemporaryFile snapshot = snapshot_workspace_import(
                workspace.root, workspace.root / "imports", filename, 1024);
            const std::string expected_extension =
                extension == ".STP" ? ".stp" : extension;
            REQUIRE(snapshot.path().extension().string() == expected_extension);
            std::ifstream input(snapshot.path());
            std::string contents;
            std::getline(input, contents);
            REQUIRE(contents == "STEP fixture");
        }
    }
}

TEST_CASE("Import paths enforce the configured file size limit", "[AgentBridge]")
{
    TestWorkspace workspace;
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots", 32,
                               workspace.root / "outputs", workspace.root / "imports");
    const auto project = controller.handle({"create", "project_create", {}});

    try {
        controller.handle(
            {"import", "model_import",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]}, {"path", "oversized.stl"}}});
        FAIL("Expected an oversized import to be rejected");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::InvalidPath);
        REQUIRE(error.details()["bytes"] == 64);
        REQUIRE(error.details()["max_bytes"] == 32);
    }
    REQUIRE(facade->imported_path.empty());
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));
}

TEST_CASE("Import rejects symlinks and snapshots content before native import", "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto nested = workspace.root / "nested";
    std::filesystem::create_directories(nested);
    std::ofstream(nested / "part.obj") << "original";
    std::error_code symlink_error;
    std::filesystem::create_symlink(nested / "part.obj", workspace.root / "linked.obj",
                                    symlink_error);
    if (symlink_error)
        SKIP("Symlinks are unavailable on this platform");

    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots", 1024,
                               workspace.root / "outputs", workspace.root / "imports");
    const auto project = controller.handle({"create", "project_create", {}});

    REQUIRE_THROWS_AS(
        controller.handle({"symlink", "model_import",
                           {{"project_id", project["project_id"]},
                            {"expected_revision", project["revision"]}, {"path", "linked.obj"}}}),
        AgentError);
    std::filesystem::create_directory_symlink(nested, workspace.root / "linked-dir",
                                              symlink_error);
    REQUIRE_FALSE(symlink_error);
    REQUIRE_THROWS_AS(
        controller.handle({"directory-symlink", "model_import",
                           {{"project_id", project["project_id"]},
                            {"expected_revision", project["revision"]},
                            {"path", "linked-dir/part.obj"}}}),
        AgentError);
    facade->on_import = [&](const std::filesystem::path&) {
        std::ofstream(nested / "part.obj", std::ios::trunc) << "replacement";
    };
    controller.handle({"snapshot", "model_import",
                       {{"project_id", project["project_id"]},
                        {"expected_revision", project["revision"]},
                        {"path", "nested/part.obj"}}});
    REQUIRE(facade->imported_contents == "original");
    REQUIRE(std::filesystem::exists(facade->imported_path));
}

TEST_CASE("Import snapshot is cleaned when native import fails", "[AgentBridge]")
{
    TestWorkspace workspace;
    auto facade = std::make_shared<FakeFacade>();
    facade->fail_import = true;
    AgentController controller(facade, workspace.root, workspace.root / "shots", 1024,
                               workspace.root / "outputs", workspace.root / "imports");
    const auto project = controller.handle({"create", "project_create", {}});

    const auto failed = controller.handle(
        {"import", "model_import", {{"project_id", project["project_id"]},
                                    {"expected_revision", project["revision"]},
                                    {"path", "part.stl"}}});
    REQUIRE(controller.handle({"failed-get", "job_get", {{"job_id", failed["job_id"]}}})
                ["state"] == "failed");
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));
}

TEST_CASE("Import commit failure rolls back and preserves project revision", "[AgentBridge]")
{
    TestWorkspace workspace;
    auto facade = std::make_shared<FakeFacade>();
    facade->fake_import_object_count = 2;
    facade->inject_import_commit_failure_after = 1;
    facade->assemble_view_blocks_ui_undo = true;
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               1024, workspace.root / "outputs",
                               workspace.root / "imports");
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"import", "model_import",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]}, {"path", "part.stl"}}});
    const auto failed =
        controller.handle({"get", "job_get", {{"job_id", started["job_id"]}}});

    REQUIRE(failed["state"] == "failed");
    REQUIRE(failed["revision"] == project["revision"]);
    REQUIRE(facade->live_import_objects == 0);
    REQUIRE(facade->assemble_view_blocks_ui_undo);
    REQUIRE(facade->agent_import_rollback_used);
    REQUIRE(facade->import_rollback_snapshot ==
            facade->import_owned_snapshot);
    REQUIRE(facade->import_rollback_snapshot !=
            facade->import_pre_transaction_snapshot);
    REQUIRE(facade->failed_import_redo_discarded);
    REQUIRE_FALSE(facade->import_committed);
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));
}

TEST_CASE("Import complexity accumulation enforces explicit structural caps", "[AgentBridge]")
{
    std::size_t triangles = MaxImportedTriangles - 1;
    REQUIRE_NOTHROW(add_import_complexity(
        triangles, 1, MaxImportedTriangles, "triangle"));
    REQUIRE(triangles == MaxImportedTriangles);
    REQUIRE_THROWS_AS(add_import_complexity(
        triangles, 1, MaxImportedTriangles, "triangle"), AgentError);

    std::size_t vertices = 0;
    REQUIRE_THROWS_AS(add_import_complexity(
        vertices, MaxImportedVertices + 1, MaxImportedVertices, "vertex"),
        AgentError);
    std::size_t instances = MaxImportedInstances;
    REQUIRE_THROWS_AS(add_import_complexity(
        instances, std::numeric_limits<std::size_t>::max(),
        MaxImportedInstances, "instance"), AgentError);
}

TEST_CASE("3MF preflight rejects compressed bombs before parser dispatch", "[AgentBridge]")
{
    ImportArchiveBudget budget;
    bool parser_invoked = false;
    try {
        validate_3mf_archive_entry(
            budget, {"3D/model.model", 1024,
                     1024 * (Max3mfCompressionRatio + 1), 64, false, false, true});
        parser_invoked = true;
        FAIL("Expected the archive preflight to reject the compressed bomb");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::InvalidRequest);
    }
    REQUIRE_FALSE(parser_invoked);
    REQUIRE(budget.uncompressed_bytes ==
            1024 * (Max3mfCompressionRatio + 1));
}

TEST_CASE("3MF preflight bounds archive structure before parsing", "[AgentBridge]")
{
    REQUIRE_NOTHROW(
        validate_3mf_archive_path_buffer_size(Max3mfEntryPathBytes + 1));
    REQUIRE_THROWS_AS(validate_3mf_archive_path_buffer_size(0), AgentError);
    REQUIRE_THROWS_AS(
        validate_3mf_archive_path_buffer_size(Max3mfEntryPathBytes + 2),
        AgentError);

    ImportArchiveBudget exhausted_entries;
    exhausted_entries.entries = Max3mfArchiveEntries;
    REQUIRE_THROWS_AS(
        validate_3mf_archive_entry(
            exhausted_entries, {"3D/model.model", 1, 1, 0, false, false, true}),
        AgentError);

    ImportArchiveBudget exhausted_bytes;
    exhausted_bytes.uncompressed_bytes = Max3mfTotalBytes;
    REQUIRE_THROWS_AS(
        validate_3mf_archive_entry(
            exhausted_bytes, {"3D/model.model", 1, 1, 0, false, false, true}),
        AgentError);

    ImportArchiveBudget unsafe_path;
    REQUIRE_THROWS_AS(
        validate_3mf_archive_entry(
            unsafe_path, {"../model.model", 1, 1, 0, false, false, true}),
        AgentError);

    ImportArchiveBudget overflowed_offset;
    REQUIRE_THROWS_AS(
        validate_3mf_archive_entry(
            overflowed_offset,
            {"3D/model.model", 2, 2,
             std::numeric_limits<std::uint64_t>::max(), false, false, true}),
        AgentError);
}

TEST_CASE("Import parser lease survives owner abandonment until worker exit", "[AgentBridge]")
{
    auto lease = acquire_import_worker_lease();
    std::promise<void> release_worker;
    std::shared_future<void> released = release_worker.get_future().share();
    std::thread worker(
        [worker_lease = std::move(lease), released] {
            released.wait();
            (void) worker_lease;
        });

    REQUIRE_FALSE(lease);
    REQUIRE_THROWS_AS(acquire_import_worker_lease(), AgentError);
    release_worker.set_value();
    worker.join();
    auto next = acquire_import_worker_lease();
    REQUIRE(next);
}

TEST_CASE("Import preparation snapshots bytes before GUI dispatch", "[AgentBridge]")
{
    TestWorkspace workspace;
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               1024, workspace.root / "outputs",
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    PreparedRequest prepared = controller.prepare(
        {"prepare", "model_import",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]}, {"path", "part.stl"}}});
    REQUIRE(prepared.import_snapshot);
    REQUIRE(std::filesystem::exists(prepared.import_snapshot->path()));
    std::ofstream(workspace.root / "part.stl", std::ios::trunc) << "replacement";

    const auto started = controller.handle_prepared(prepared);
    REQUIRE(facade->imported_contents == "solid empty\nendsolid empty\n");
    REQUIRE(controller.handle({"prepared-get", "job_get",
                               {{"job_id", started["job_id"]}}})["state"] == "succeeded");
    prepared.import_snapshot.reset();
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));
}

TEST_CASE("Import snapshot cancellation removes partial staging files", "[AgentBridge]")
{
    TestWorkspace workspace;
    std::size_t cancellation_checks = 0;
    try {
        (void) snapshot_workspace_import(
            workspace.root, workspace.root / "imports", "part.stl", 1024,
            [&] { return ++cancellation_checks >= 3; });
        FAIL("Expected import preparation to be abandoned");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::RequestTimeout);
    }
    REQUIRE(cancellation_checks >= 3);
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));
}

TEST_CASE("Import snapshot cleanup preserves a raced replacement",
          "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Adversarial inode replacement coverage is POSIX-specific");
#else
    TestWorkspace workspace;
    std::size_t cancellation_checks = 0;
    std::filesystem::path replacement_path;
    try {
        (void) snapshot_workspace_import(
            workspace.root, workspace.root / "imports", "part.stl", 1024,
            [&] {
                ++cancellation_checks;
                if (cancellation_checks != 2)
                    return false;
                const auto entry =
                    *std::filesystem::directory_iterator(
                        workspace.root / "imports");
                replacement_path = entry.path();
                std::filesystem::remove(replacement_path);
                std::ofstream(replacement_path) << "replacement";
                return true;
            });
        FAIL("Expected import preparation to be abandoned");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::RequestTimeout);
    }
    std::ifstream input(replacement_path);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "replacement");
#endif
}

TEST_CASE("Exclusive artifact creation never follows a precreated symlink", "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto victim = workspace.root / "victim.png";
    const auto link = workspace.root / "scene.png";
    std::ofstream(victim) << "untouched";
    std::error_code symlink_error;
    std::filesystem::create_symlink(victim, link, symlink_error);
    if (symlink_error)
        SKIP("Symlinks are unavailable on this platform");

    const std::array<std::uint8_t, 3> png {{1, 2, 3}};
    REQUIRE_THROWS(write_exclusive_file(link, png.data(), png.size()));
    std::ifstream input(victim);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "untouched");
    REQUIRE(std::filesystem::is_symlink(link));
}

TEST_CASE("Secure artifact creation rejects a symlinked directory", "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Directory descriptor confinement is a POSIX production-path guarantee");
#else
    TestWorkspace workspace;
    const auto external = workspace.root / "external";
    const auto link = workspace.root / "screenshots";
    std::filesystem::create_directories(external);
    std::error_code symlink_error;
    std::filesystem::create_directory_symlink(external, link, symlink_error);
    if (symlink_error)
        SKIP("Directory symlinks are unavailable on this platform");

    const std::array<std::uint8_t, 3> png {{1, 2, 3}};
    REQUIRE_THROWS(write_secure_artifact(
        link, "scene-iso-", ".png", png.data(), png.size()));
    REQUIRE(std::filesystem::is_empty(external));
#endif
}

TEST_CASE("Secure artifact write failure preserves a replacement raced before cleanup",
          "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Adversarial inode replacement coverage is POSIX-specific");
#else
    TestWorkspace workspace;
    const auto screenshots = workspace.root / "screenshots";
    std::filesystem::create_directories(screenshots);
    const std::array<std::uint8_t, 3> bytes {{1, 2, 3}};
    std::filesystem::path replacement_path;

    REQUIRE_THROWS_AS(
        write_secure_artifact(
            screenshots, "scene-iso-", ".png", bytes.data(), bytes.size(),
            [&](const std::filesystem::path& path) {
                replacement_path = path;
                std::filesystem::remove(path);
                std::ofstream(path) << "replacement";
                throw std::runtime_error("injected write failure");
            }),
        AgentError);
    std::ifstream input(replacement_path);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "replacement");
#endif
}

TEST_CASE("Trusted artifact publication never overwrites through a target symlink",
          "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto output = workspace.root / "publish-output";
    std::filesystem::create_directories(output);
    const auto staging = workspace.root / "artifacts" / "job.gcode";
    const auto victim = workspace.root / "victim.gcode";
    std::ofstream(staging) << "new";
    std::ofstream(victim) << "untouched";
    std::error_code symlink_error;
    std::filesystem::create_symlink(victim, output / "part.gcode", symlink_error);
    if (symlink_error)
        SKIP("Symlinks are unavailable on this platform");

    REQUIRE_THROWS(publish_trusted_artifact(
        workspace.root / "artifacts", staging, output, "part.gcode", true));
    std::ifstream input(victim);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "untouched");
    REQUIRE(std::filesystem::is_symlink(output / "part.gcode"));
    REQUIRE_FALSE(std::filesystem::exists(staging));
}

TEST_CASE("Artifact publication failure preserves a raced replacement inode",
          "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Publication inode verification is a POSIX production-path guarantee");
#else
    TestWorkspace workspace;
    const auto output = workspace.root / "publish-output";
    std::filesystem::create_directories(output);
    const auto staging = workspace.root / "artifacts" / "job.gcode";
    const auto target = output / "part.gcode";
    std::ofstream(staging) << "published";

    REQUIRE_THROWS(publish_trusted_artifact(
        workspace.root / "artifacts", staging, output, "part.gcode", false,
        [&]() {
            std::filesystem::remove(target);
            std::ofstream(target) << "replacement";
        }));

    std::ifstream input(target);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "replacement");
#endif
}

TEST_CASE("Artifact publication preserves a replaced temporary before cleanup",
          "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Publication inode verification is a POSIX production-path guarantee");
#else
    TestWorkspace workspace;
    const auto output = workspace.root / "publish-output";
    std::filesystem::create_directories(output);
    const auto staging = workspace.root / "artifacts" / "job.gcode";
    std::ofstream(staging) << "published";
    std::filesystem::path replacement_path;

    REQUIRE_THROWS_AS(
        publish_trusted_artifact(
            workspace.root / "artifacts", staging, output, "part.gcode",
            false, {},
            [&](const std::filesystem::path& temporary) {
                replacement_path = temporary;
                std::filesystem::remove(temporary);
                std::ofstream(temporary) << "replacement";
            }),
        AgentError);
    std::ifstream input(replacement_path);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "replacement");
    REQUIRE_FALSE(std::filesystem::exists(output / "part.gcode"));
#endif
}

TEST_CASE("Transform validation is finite and advances revision exactly once", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const nlohmann::json base {
        {"project_id", project["project_id"]},
        {"expected_revision", project["revision"]},
        {"object_id", "object_10"},
        {"instance_id", "instance_11"}
    };

    nlohmann::json transform = base;
    transform["mode"] = "relative";
    transform["offset_mm"] = {1.0, 2.0, 3.0};
    transform["rotation_deg"] = {0.0, 0.0, 90.0};
    transform["scale"] = {1.0, 1.0, 1.0};
    const auto result = controller.handle({"transform", "object_transform", transform});
    REQUIRE(result["revision"] == 2);
    REQUIRE(facade->last_transform["mode"] == "relative");

    transform["offset_mm"] = {1.0, std::numeric_limits<double>::infinity(), 3.0};
    REQUIRE_THROWS_AS(controller.handle({"invalid", "object_transform", transform}), AgentError);
    const auto scene = controller.handle(
        {"scene", "scene_get", {{"project_id", project["project_id"]}}});
    REQUIRE(scene["revision"] == 2);
}

TEST_CASE("Every native scene mutator requires an expected revision", "[AgentBridge]")
{
    TestWorkspace workspace;
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               1024, workspace.root / "outputs",
                               workspace.root / "imports");
    const auto project = controller.handle({"create", "project_create", {}});

    const auto requires_revision = [&](const Request& request) {
        try {
            controller.handle(request);
            FAIL("Expected expected_revision to be required");
        } catch (const AgentError& error) {
            REQUIRE(error.code() == ErrorCode::InvalidRequest);
            REQUIRE(std::string(error.what()) == "expected_revision is required");
        }
    };
    requires_revision({"import", "model_import",
                       {{"project_id", project["project_id"]}, {"path", "part.stl"}}});
    requires_revision(
        {"transform", "object_transform",
         {{"project_id", project["project_id"]}, {"object_id", "object_10"},
          {"instance_id", "instance_11"}, {"offset_mm", {1.0, 0.0, 0.0}}}});
    requires_revision(
        {"orient", "object_auto_orient",
         {{"project_id", project["project_id"]},
          {"targets", {{{"object_id", "object_10"},
                        {"instance_id", "instance_11"}}}}}});
    requires_revision(
        {"arrange", "scene_arrange", {{"project_id", project["project_id"]}}});
    REQUIRE_FALSE(facade->import_started);
    REQUIRE(facade->last_transform.is_null());
    REQUIRE_FALSE(facade->auto_orient_started);
    REQUIRE_FALSE(facade->arrange_started);
}

TEST_CASE("Auto-orient jobs target instances and increment revision on success",
          "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const nlohmann::json targets = {
        {{"object_id", "object_10"}, {"instance_id", "instance_11"}}
    };
    const auto started = controller.handle(
        {"orient", "object_auto_orient",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"targets", targets}}});
    REQUIRE(facade->auto_orient_started);
    REQUIRE(facade->last_auto_orient["targets"] == targets);

    facade->next_auto_orient_state = {false, false, 0.5, nullptr, nullptr};
    REQUIRE(controller.handle(
        {"poll", "job_get", {{"job_id", started["job_id"]}}})["state"] == "running");
    facade->next_auto_orient_state =
        {true, false, 1.0, {{"oriented", true}}, nullptr};
    const auto complete = controller.handle(
        {"done", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(complete["type"] == "auto_orient");
    REQUIRE(complete["state"] == "succeeded");
    REQUIRE(complete["result"] == nlohmann::json {{"oriented", true}});
    REQUIRE(complete["revision"] == 2);
    REQUIRE(complete["source_revision"] == project["revision"]);
    REQUIRE(complete["metadata"]["config_snapshot"]["revision"] ==
            project["revision"]);
}

TEST_CASE("Auto-orient rejects duplicate targets before native startup",
          "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const nlohmann::json target =
        {{"object_id", "object_10"}, {"instance_id", "instance_11"}};
    REQUIRE_THROWS_AS(
        controller.handle(
            {"orient", "object_auto_orient",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]},
              {"targets", {target, target}}}}),
        AgentError);
    REQUIRE_FALSE(facade->auto_orient_started);
}

TEST_CASE("Arrange jobs observe facade completion and increment revision on success", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"arrange", "scene_arrange", {{"project_id", project["project_id"]},
                                      {"expected_revision", project["revision"]}}});
    REQUIRE(facade->arrange_started);

    facade->next_arrange_state = {false, false, 0.5, nullptr, nullptr};
    REQUIRE(controller.handle({"poll", "job_get", {{"job_id", started["job_id"]}}})["state"] == "running");
    facade->next_arrange_state = {true, false, 1.0, {{"arranged", true}}, nullptr};
    const auto complete = controller.handle({"done", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(complete["state"] == "succeeded");
    REQUIRE(complete["revision"] == 2);
    REQUIRE(complete["project_id"] == project["project_id"]);
    REQUIRE(complete["source_revision"] == project["revision"]);
    REQUIRE(complete["metadata"]["config_snapshot"]["revision"] == project["revision"]);
    REQUIRE(complete["metadata"]["config_snapshot"]["presets"]["printer"] == "Printer A");
    REQUIRE(complete["metadata"]["config_snapshot"]["settings"]["layer_height"] == "0.2");
    REQUIRE(complete["metadata"]["config_snapshot"]["schema_version"] == 2);
    REQUIRE(complete["metadata"]["config_snapshot"]["sha256"] == std::string(64, 'a'));
    REQUIRE(complete["metadata"]["config_snapshot"]["bytes"] == 22);
    REQUIRE(complete["metadata"]["config_snapshot"]["redacted_keys"].empty());
}

TEST_CASE("Arrange startup snapshot is baselined during running polls", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    facade->on_arrange_start = [&] { facade->fingerprint = "arrange-start-snapshot"; };
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_arrange_state = {false, false, 0.2, nullptr, nullptr};
    const auto started = controller.handle(
        {"arrange", "scene_arrange", {{"project_id", project["project_id"]},
                                      {"expected_revision", project["revision"]}}});

    const auto first =
        controller.handle({"first", "job_get", {{"job_id", started["job_id"]}}});
    const auto second =
        controller.handle({"second", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(first["state"] == "running");
    REQUIRE(second["state"] == "running");
    REQUIRE(first["revision"] == project["revision"]);
    REQUIRE(second["revision"] == project["revision"]);
}

TEST_CASE("Completed arrange refreshes before another tool observes project state", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    controller.handle(
        {"arrange", "scene_arrange", {{"project_id", project["project_id"]},
                                      {"expected_revision", project["revision"]}}});

    facade->next_arrange_state = {true, false, 1.0, {{"arranged", true}}, nullptr};
    const auto scene = controller.handle(
        {"scene", "scene_get", {{"project_id", project["project_id"]}}});
    REQUIRE(scene["revision"] == 2);

    REQUIRE_NOTHROW(controller.handle(
        {"transform", "object_transform",
         {{"project_id", project["project_id"]},
          {"expected_revision", 2},
          {"object_id", "object_10"},
          {"instance_id", "instance_11"},
          {"offset_mm", {1.0, 2.0, 3.0}}}}));
}

TEST_CASE("Arrange invalidates on unrelated scene mutation while still running", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"arrange", "scene_arrange", {{"project_id", project["project_id"]},
                                      {"expected_revision", project["revision"]}}});
    facade->next_arrange_state = {false, false, 0.25, nullptr, nullptr};
    facade->fingerprint = "unrelated-native-edit";

    const auto pending =
        controller.handle({"pending", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(pending["state"] == "running");
    REQUIRE(pending["revision"] == 2);

    facade->next_arrange_state =
        {true, false, 1.0, {{"arranged", true},
                            {"scene_fingerprint", "arrange-owned-edit"}}, nullptr};
    const auto terminal =
        controller.handle({"terminal", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(terminal["state"] == "failed");
    REQUIRE(terminal["error"]["code"] == ErrorCode::RevisionConflict);
}

TEST_CASE("Arrange attributes its own completion fingerprint", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"arrange", "scene_arrange", {{"project_id", project["project_id"]},
                                      {"expected_revision", project["revision"]}}});
    facade->next_arrange_state =
        {true, false, 1.0, {{"arranged", true}}, nullptr};

    const auto terminal =
        controller.handle({"terminal", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(terminal["state"] == "succeeded");
    REQUIRE(terminal["revision"] == 2);
}

TEST_CASE("Arrange cannot claim an unpolled external completion race", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"arrange", "scene_arrange", {{"project_id", project["project_id"]},
                                      {"expected_revision", project["revision"]}}});

    facade->next_arrange_state =
        {true, false, 1.0, {{"arranged", true}}, nullptr};
    facade->fingerprint = "external-edit-after-last-running-poll";
    const auto terminal =
        controller.handle({"terminal", "job_get", {{"job_id", started["job_id"]}}});

    REQUIRE(terminal["state"] == "failed");
    REQUIRE(terminal["error"]["code"] == ErrorCode::RevisionConflict);
    REQUIRE(terminal["revision"] == project["revision"].get<std::uint64_t>() + 1);
}

TEST_CASE("Configuration changes during arrange invalidate without releasing the lease",
          "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"arrange", "scene_arrange", {{"project_id", project["project_id"]},
                                      {"expected_revision", project["revision"]}}});
    facade->next_arrange_state = {false, false, 0.5, nullptr, nullptr};
    facade->config_fingerprint = "config-browser-change";

    const auto pending =
        controller.handle({"pending", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(pending["state"] == "running");
    REQUIRE(pending["revision"] == project["revision"].get<std::uint64_t>() + 1);
    REQUIRE_THROWS_AS(controller.handle({"replace", "project_create", {}}), AgentError);

    facade->next_arrange_state =
        {true, false, 1.0, {{"arranged", true}}, nullptr};
    const auto terminal =
        controller.handle({"terminal", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(terminal["state"] == "failed");
    REQUIRE(terminal["error"]["code"] == ErrorCode::RevisionConflict);
}

TEST_CASE("Scene render validates views and dimensions before calling native facade", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, "/workspace", "/screenshots");
    const auto project = controller.handle({"create", "project_create", {}});
    const auto rendered = controller.handle(
        {"render", "scene_render",
         {{"project_id", project["project_id"]}, {"views", {"iso", "top"}}, {"width", 640}, {"height", 480}}});
    REQUIRE(rendered["images"][0]["view"] == "iso");
    REQUIRE(facade->last_render["width"] == 640);
    REQUIRE(facade->render_root == "/screenshots");

    REQUIRE_THROWS_AS(
        controller.handle({"bad-view", "scene_render",
                           {{"project_id", project["project_id"]}, {"views", {"diagonal"}}}}),
        AgentError);
}

TEST_CASE("Toolpath rasterizer includes feature lines and seams but excludes motions",
          "[AgentBridge]")
{
    Slic3r::GCodeProcessorResult gcode;
    const auto move = [](Slic3r::EMoveType type, Slic3r::ExtrusionRole role,
                         const Slic3r::Vec3f& position) {
        Slic3r::GCodeProcessorResult::MoveVertex vertex;
        vertex.type = type;
        vertex.extrusion_role = role;
        vertex.position = position;
        vertex.layer_id = 1;
        vertex.width = 0.4f;
        return vertex;
    };
    gcode.moves = {
        move(Slic3r::EMoveType::Travel, Slic3r::erNone,
             Slic3r::Vec3f(0.0f, 0.0f, 0.2f)),
        move(Slic3r::EMoveType::Extrude, Slic3r::erExternalPerimeter,
             Slic3r::Vec3f(10.0f, 0.0f, 0.2f)),
        move(Slic3r::EMoveType::Travel, Slic3r::erNone,
             Slic3r::Vec3f(10.0f, 10.0f, 0.2f)),
        move(Slic3r::EMoveType::Retract, Slic3r::erNone,
             Slic3r::Vec3f(10.0f, 10.0f, 0.2f)),
        move(Slic3r::EMoveType::Seam, Slic3r::erNone,
             Slic3r::Vec3f(10.0f, 0.0f, 0.2f))
    };

    const ToolpathRenderResult rendered = render_toolpaths(
        gcode, {128, 128, "top", std::nullopt});
    REQUIRE(rendered.image.width == 128);
    REQUIRE(rendered.image.height == 128);
    REQUIRE(rendered.image.pixels.size() == 128u * 128u * 4u);
    REQUIRE(rendered.segment_count == 1);
    REQUIRE(rendered.seam_count == 1);
    REQUIRE(rendered.available_layers.start == 0);
    REQUIRE(rendered.available_layers.end == 0);

    const auto contains_rgb = [&rendered](std::array<unsigned char, 3> rgb) {
        for (std::size_t offset = 0; offset < rendered.image.pixels.size(); offset += 4) {
            if (rendered.image.pixels[offset] == rgb[0] &&
                rendered.image.pixels[offset + 1] == rgb[1] &&
                rendered.image.pixels[offset + 2] == rgb[2])
                return true;
        }
        return false;
    };
    REQUIRE(contains_rgb({255, 125, 56}));
    REQUIRE(contains_rgb({230, 230, 230}));
    REQUIRE_FALSE(contains_rgb({56, 72, 155}));
}

TEST_CASE("Toolpath render requires a successful current-revision slice", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, "/workspace", "/screenshots");
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_slice_state =
        {true, false, 1.0,
         {{"sliced", true}, {"print_metrics", print_metrics_fixture()}}, nullptr};
    const auto slice = controller.handle(
        {"slice", "slice_start",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]}, {"plate_index", 2}}});
    const auto completed = controller.handle(
        {"poll", "job_get", {{"job_id", slice["job_id"]}}});
    REQUIRE(completed["state"] == "succeeded");

    const auto rendered = controller.handle(
        {"toolpaths", "toolpath_render",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"slice_job_id", slice["job_id"]},
          {"views", {"topfront"}}, {"width", 800}, {"height", 600},
          {"layer_range", {{"start", 4}, {"end", 8}}}}});
    REQUIRE(rendered["slice_job_id"] == slice["job_id"]);
    REQUIRE(rendered["plate_index"] == 2);
    REQUIRE(facade->rendered_plate_index == 2);
    REQUIRE(facade->last_toolpath_render["width"] == 800);
    REQUIRE(facade->last_toolpath_render["layer_range"]["start"] == 4);
    REQUIRE(facade->render_root == "/screenshots");

    REQUIRE_THROWS_AS(
        controller.handle(
            {"bad-range", "toolpath_render",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]},
              {"slice_job_id", slice["job_id"]}, {"views", {"top"}},
              {"layer_range", {{"start", 9}, {"end", 8}}}}}),
        AgentError);
}

TEST_CASE("Render artifact rollback removes partial output unless committed", "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto first = workspace.root / "first.png";
    const auto second = workspace.root / "second.png";
    std::ofstream(first) << "partial";
    std::ofstream(second) << "partial";
    {
        RenderArtifactRollback rollback;
        rollback.track({first, trusted_artifact_identity(first)});
        rollback.track({second, trusted_artifact_identity(second)});
    }
    REQUIRE_FALSE(std::filesystem::exists(first));
    REQUIRE_FALSE(std::filesystem::exists(second));

    std::ofstream(first) << "complete";
    {
        RenderArtifactRollback rollback;
        rollback.track({first, trusted_artifact_identity(first)});
        rollback.commit();
    }
    REQUIRE(std::filesystem::exists(first));
}

TEST_CASE("Render rollback preserves a replacement raced before cleanup quarantine",
          "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Adversarial inode replacement coverage is POSIX-specific");
#else
    TestWorkspace workspace;
    const auto first = workspace.root / "first.png";
    std::ofstream(first) << "owned";
    bool replaced = false;
    RenderArtifactRollback rollback(
        [&](const std::filesystem::path& path) {
            if (replaced)
                return;
            replaced = true;
            std::filesystem::remove(path);
            std::ofstream(path) << "replacement";
        });
    rollback.track({first, trusted_artifact_identity(first)});

    REQUIRE_THROWS_AS(rollback.rollback(), AgentError);
    std::ifstream input(first);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "replacement");
#endif
}

TEST_CASE("Render rollback retains creation identity across a replacement before tracking",
          "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Adversarial inode replacement coverage is POSIX-specific");
#else
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "screenshots");
    const std::array<std::uint8_t, 3> bytes {{1, 2, 3}};
    std::filesystem::path replacement_path;
    const SecureArtifact artifact = write_secure_artifact(
        workspace.root / "screenshots", "scene-iso-", ".png",
        bytes.data(), bytes.size(),
        [&](const std::filesystem::path& path) {
            replacement_path = path;
            std::filesystem::remove(path);
            std::ofstream(path) << "replacement";
        });

    RenderArtifactRollback rollback;
    rollback.track(artifact);
    REQUIRE_THROWS_AS(rollback.rollback(), AgentError);
    std::ifstream input(replacement_path);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "replacement");
#endif
}

TEST_CASE("Job registry exposes deterministic states and bounded progress", "[AgentBridge]")
{
    AgentController controller(std::make_shared<FakeFacade>());
    const std::string job_id = controller.create_job("slice");
    REQUIRE(controller.update_job(job_id, JobState::Running, 1.5));

    const auto running = controller.handle({"job-1", "job_get", {{"job_id", job_id}}});
    REQUIRE(running["state"] == "running");
    REQUIRE(running["progress"] == 1.0);

    REQUIRE(controller.update_job(job_id, JobState::Succeeded, 1.0, {{"path", "/outputs/test.gcode"}}));
    const auto succeeded = controller.handle({"job-2", "job_get", {{"job_id", job_id}}});
    REQUIRE(succeeded["state"] == "succeeded");
    REQUIRE(succeeded["result"]["path"] == "/outputs/test.gcode");

    REQUIRE_THROWS_AS(
        controller.update_job(job_id, JobState::Running, 1.0),
        AgentError);

    const std::string arrange_job = controller.create_job("arrange");
    REQUIRE_THROWS_AS(controller.create_job("slice"), AgentError);
    REQUIRE(controller.update_job(arrange_job, JobState::Cancelled, 0.0));
    REQUIRE_NOTHROW(controller.create_job("slice"));
}

TEST_CASE("Job cancellation is native, terminal, and idempotent", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_arrange_state = {false, false, 0.4, nullptr, nullptr};
    const auto started = controller.handle(
        {"arrange", "scene_arrange",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]}}});

    const auto cancelled = controller.handle(
        {"cancel", "job_cancel", {{"job_id", started["job_id"]}}});
    REQUIRE(cancelled["state"] == "cancelled");
    REQUIRE(cancelled["progress"] == 0.4);
    REQUIRE(cancelled["result"].is_null());
    REQUIRE(cancelled["error"].is_null());
    REQUIRE(cancelled["revision"] == project["revision"]);
    REQUIRE(facade->cancelled_job_types == std::vector<std::string> {"arrange"});

    const auto repeated = controller.handle(
        {"cancel-again", "job_cancel", {{"job_id", started["job_id"]}}});
    REQUIRE(repeated == cancelled);
    REQUIRE(facade->cancelled_job_types == std::vector<std::string> {"arrange"});
}

TEST_CASE("Job cancellation preserves completed jobs and rejects unknown jobs", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const std::string completed_id = controller.create_job("slice");
    REQUIRE(controller.update_job(completed_id, JobState::Running, 0.5));
    REQUIRE(controller.update_job(
        completed_id, JobState::Succeeded, 1.0, {{"sliced", true}}));

    const auto completed = controller.handle(
        {"cancel-complete", "job_cancel", {{"job_id", completed_id}}});
    REQUIRE(completed["state"] == "succeeded");
    REQUIRE(completed["result"]["sliced"] == true);
    REQUIRE(facade->cancelled_job_types.empty());

    try {
        controller.handle(
            {"cancel-missing", "job_cancel", {{"job_id", "job_missing"}}});
        FAIL("Expected a missing job error");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::JobNotFound);
    }
}

TEST_CASE("Cancelling artifact jobs removes their trusted staging output", "[AgentBridge]")
{
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    auto facade = std::make_shared<FakeFacade>();
    facade->next_save_state = {false, false, 0.5, nullptr, nullptr};
    AgentController controller(
        facade, workspace.root, workspace.root / "shots", 1024,
        workspace.root / "outputs", workspace.root / "imports",
        workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"save", "project_save",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"output_path", "cancelled.3mf"}}});
    REQUIRE(std::filesystem::is_regular_file(facade->save_path));

    const auto cancelled = controller.handle(
        {"cancel", "job_cancel", {{"job_id", started["job_id"]}}});
    REQUIRE(cancelled["state"] == "cancelled");
    REQUIRE_FALSE(std::filesystem::exists(facade->save_path));
    REQUIRE_FALSE(std::filesystem::exists(workspace.root / "outputs" / "cancelled.3mf"));
    REQUIRE(facade->cancelled_job_types ==
            std::vector<std::string> {"project_save"});
}

TEST_CASE("Project replacement honors the mutation lease and preserves job history", "[AgentBridge]")
{
    AgentController controller(std::make_shared<FakeFacade>());
    const auto project = controller.handle({"create-1", "project_create", {}});
    const std::string job_id = controller.create_job("arrange");

    try {
        controller.handle({"create-2", "project_create", {}});
        FAIL("Expected an active mutation conflict");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::MutationInProgress);
        REQUIRE(error.details()["job_id"] == job_id);
    }

    const auto current = controller.handle(
        {"get", "project_get", {{"project_id", project["project_id"]}}});
    REQUIRE(current["project_id"] == project["project_id"]);

    REQUIRE_THROWS_AS(
        controller.update_job(job_id, JobState::Running, std::numeric_limits<double>::quiet_NaN()),
        AgentError);
    REQUIRE_THROWS_AS(
        controller.update_job(job_id, JobState::Running, std::numeric_limits<double>::infinity()),
        AgentError);

    REQUIRE(controller.update_job(job_id, JobState::Cancelled, 0.0));
    const auto replacement = controller.handle({"create-3", "project_create", {}});
    REQUIRE(replacement["project_id"] != project["project_id"]);
    const auto preserved = controller.handle({"job", "job_get", {{"job_id", job_id}}});
    REQUIRE(preserved["state"] == "cancelled");
}

TEST_CASE("Agent controller rejects a missing native facade", "[AgentBridge]")
{
    REQUIRE_THROWS_AS(AgentController(nullptr), std::invalid_argument);
}

TEST_CASE("Synchronous model mutations honor the active mutation lease", "[AgentBridge]")
{
    TestWorkspace workspace;
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, workspace.root / "outputs",
                               workspace.root / "imports");
    const auto project = controller.handle({"create", "project_create", {}});
    const std::string job_id = controller.create_job("arrange");

    const nlohmann::json project_params {
        {"project_id", project["project_id"]},
        {"expected_revision", project["revision"]}
    };
    try {
        auto import_params = project_params;
        import_params["path"] = "part.stl";
        controller.handle({"import", "model_import", import_params});
        FAIL("Expected import to honor the mutation lease");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::MutationInProgress);
        REQUIRE(error.details()["job_id"] == job_id);
    }

    try {
        auto transform_params = project_params;
        transform_params["object_id"] = "object_10";
        transform_params["instance_id"] = "instance_11";
        transform_params["offset_mm"] = {1.0, 2.0, 3.0};
        controller.handle({"transform", "object_transform", transform_params});
        FAIL("Expected transform to honor the mutation lease");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::MutationInProgress);
        REQUIRE(error.details()["job_id"] == job_id);
    }

    REQUIRE(facade->imported_path.empty());
    REQUIRE(facade->last_transform.is_null());
    REQUIRE(controller.update_job(job_id, JobState::Cancelled, 0.0));
    REQUIRE_NOTHROW(controller.handle(
        {"import", "model_import",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"path", "part.stl"}}}));
}

TEST_CASE("Preset tools preserve exact result shapes and commit one revision", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});

    const auto listed = controller.handle(
        {"list", "presets_list",
         {{"project_id", project["project_id"]}, {"scopes", {"printer", "filament"}},
          {"compatible_only", true}}});
    REQUIRE(listed["revision"] == 1);
    REQUIRE(listed["selected"]["filaments"].size() == 2);
    REQUIRE(listed["presets"][0] == (nlohmann::json{
        {"scope", "printer"}, {"name", "Printer A"}, {"selected", true}, {"compatible", true}}));

    nlohmann::json selection_params {
        {"project_id", project["project_id"]},
        {"expected_revision", 1},
        {"selection", {
            {"printer", "Printer A"},
            {"process", "Process A"},
            {"filaments", {"PLA A", "PLA B"}}
        }}
    };
    const auto selected = controller.handle({"select", "presets_select", selection_params});
    REQUIRE(selected["revision"] == 2);
    REQUIRE(selected["selected"]["process"] == "Process A");
    REQUIRE(facade->last_presets_select["selection"]["filaments"].size() == 2);

    facade->preset_selection_changed = false;
    selection_params["expected_revision"] = 2;
    selection_params["discard_dirty"] = true;
    const auto idempotent = controller.handle({"select-again", "presets_select", selection_params});
    REQUIRE(idempotent["revision"] == 2);
    REQUIRE(facade->last_presets_select["discard_dirty"] == true);

    facade->fail_presets_select = true;
    REQUIRE_THROWS_AS(
        controller.handle(
            {"bad-select", "presets_select",
             {{"project_id", project["project_id"]}, {"expected_revision", 2},
              {"selection", {{"printer", "Missing"}}}}}),
        AgentError);
    REQUIRE(controller.handle(
        {"get", "project_get", {{"project_id", project["project_id"]}}})["revision"] == 2);
}

TEST_CASE("Settings tools validate batches and dry run is revision neutral", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const auto base = nlohmann::json{{"project_id", project["project_id"]}};

    auto describe_params = base;
    describe_params["query"] = "layer";
    describe_params["scopes"] = {"process"};
    describe_params["limit"] = 25;
    const auto described = controller.handle({"describe", "settings_describe", describe_params});
    REQUIRE(described["items"][0]["unit"] == "mm");
    REQUIRE(described["items"][0]["enum_values"].is_null());
    REQUIRE(facade->last_settings_describe["limit"] == 25);

    auto get_params = base;
    get_params["settings"] = {{{"key", "layer_height"}, {"scope", "process"}}};
    const auto values = controller.handle({"get-settings", "settings_get", get_params});
    REQUIRE(values["values"][0]["value"] == 0.2);
    REQUIRE(values["values"][0]["unit"] == "mm");

    nlohmann::json changes = nlohmann::json::array(
        {{{"key", "layer_height"}, {"scope", "process"}, {"value", 0.24}}});
    auto dry_params = base;
    dry_params["expected_revision"] = 1;
    dry_params["changes"] = changes;
    dry_params["dry_run"] = true;
    const auto dry = controller.handle({"dry", "settings_apply", dry_params});
    REQUIRE(dry["dry_run"] == true);
    REQUIRE(dry["revision"] == 1);

    auto apply_params = dry_params;
    apply_params["dry_run"] = false;
    const auto applied = controller.handle({"apply", "settings_apply", apply_params});
    REQUIRE(applied["revision"] == 2);
    REQUIRE(applied["applied"][0]["value"] == 0.24);

    auto per_filament = base;
    per_filament["expected_revision"] = 2;
    per_filament["dry_run"] = true;
    per_filament["changes"] = nlohmann::json::array({
        {{"key", "line_width"}, {"scope", "filament"}, {"filament_index", 0},
         {"value", {{"value", 105.0}, {"percent", true}}}},
        {{"key", "line_width"}, {"scope", "filament"}, {"filament_index", 1},
         {"value", {{"value", 0.45}, {"percent", false}}}},
        {{"key", "extruder_printable_area"}, {"scope", "printer"},
         {"value", nlohmann::json::array({
             nlohmann::json::array({
                 nlohmann::json::array({0.0, 0.0}),
                 nlohmann::json::array({100.0, 0.0}),
                 nlohmann::json::array({100.0, 100.0})
             })
         })}}
    });
    REQUIRE_NOTHROW(controller.handle({"per-filament", "settings_apply", per_filament}));
    REQUIRE(facade->last_settings_apply["changes"][1]["filament_index"] == 1);

    auto duplicate_filament = per_filament;
    duplicate_filament["changes"] = nlohmann::json::array({
        {{"key", "temperature"}, {"scope", "filament"}, {"value", 210}},
        {{"key", "temperature"}, {"scope", "filament"}, {"filament_index", 0}, {"value", 220}}
    });
    REQUIRE_THROWS_AS(
        controller.handle({"duplicate-filament", "settings_apply", duplicate_filament}), AgentError);

    auto invalid_index_scope = per_filament;
    invalid_index_scope["changes"] = nlohmann::json::array({
        {{"key", "layer_height"}, {"scope", "process"}, {"filament_index", 1}, {"value", 0.2}}
    });
    REQUIRE_THROWS_AS(
        controller.handle({"invalid-index-scope", "settings_apply", invalid_index_scope}), AgentError);

    auto duplicate_params = base;
    duplicate_params["changes"] = nlohmann::json::array(
        {{{"key", "layer_height"}, {"scope", "process"}, {"value", 0.2}},
         {{"key", "layer_height"}, {"scope", "process"}, {"value", 0.3}}});
    REQUIRE_THROWS_AS(
        controller.handle({"duplicates", "settings_apply", duplicate_params}), AgentError);

    auto invalid_params = base;
    invalid_params["changes"] = nlohmann::json::array(
        {{{"key", "layer_height"}, {"scope", "process"},
          {"value", std::numeric_limits<double>::infinity()}}});
    REQUIRE_THROWS_AS(
        controller.handle({"non-finite", "settings_apply", invalid_params}), AgentError);
}

TEST_CASE("Agent settings capability rejects path script plugin network and credential keys",
          "[AgentBridge]")
{
    for (const std::string key : {
             "bed_custom_model", "bed_custom_texture", "printhost_cafile",
             "printhost_apikey", "printhost_password", "post_process",
             "slicing_pipeline_plugin", "plugins", "print_host",
             "print_host_webui", "printer_agent", "bbl_use_printhost",
             "datadir", "logfile", "outputdir", "input_filename_base",
             "filename_format", "print_plugin_config_overrides",
             "printer_plugin_config_overrides", "filament_plugin_config_overrides",
             "host_type", "custom_output_path", "remote_url", "run_command",
             "access_token"}) {
        REQUIRE_FALSE(is_agent_setting_allowed(key));
    }
    REQUIRE(is_agent_setting_allowed("layer_height"));
    REQUIRE(is_agent_setting_allowed("nozzle_diameter"));
    for (const std::string key : {
             "machine_start_gcode", "file_start_gcode", "filament_start_gcode",
             "machine_end_gcode", "layer_change_gcode", "custom_gcode"}) {
        REQUIRE_FALSE(is_agent_setting_allowed(key));
    }
    REQUIRE(is_agent_setting_allowed("gcode_flavor"));

    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    REQUIRE_THROWS_AS(
        controller.handle(
            {"get-unsafe", "settings_get",
             {{"project_id", project["project_id"]},
              {"settings", {{{"key", "printhost_password"}, {"scope", "printer"}}}}}}),
        AgentError);
    REQUIRE(facade->last_settings_get.is_null());
    REQUIRE_THROWS_AS(
        controller.handle(
            {"apply-unsafe", "settings_apply",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]},
              {"changes", {{{"key", "post_process"}, {"scope", "process"},
                            {"value", nlohmann::json::array({"/tmp/run.sh"})}}}}}}),
        AgentError);
    REQUIRE(facade->last_settings_apply.is_null());
}

TEST_CASE("Preset and settings mutations honor the active lease", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    const std::string job_id = controller.create_job("slice");

    REQUIRE_THROWS_AS(
        controller.handle(
            {"select", "presets_select",
             {{"project_id", project["project_id"]}, {"expected_revision", 1},
              {"selection", {{"printer", "Printer A"}}}}}),
        AgentError);
    REQUIRE_THROWS_AS(
        controller.handle(
            {"apply", "settings_apply",
             {{"project_id", project["project_id"]}, {"expected_revision", 1},
              {"changes", {{{"key", "layer_height"}, {"scope", "process"}, {"value", 0.2}}}}}}),
        AgentError);

    REQUIRE(controller.update_job(job_id, JobState::Cancelled, 0.0));
}

TEST_CASE("Oversized setting apply is atomic and revision neutral", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});

    REQUIRE_THROWS_AS(
        controller.handle(
            {"oversized", "settings_apply",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]},
              {"changes",
               {{{"key", "notes"}, {"scope", "process"},
                 {"value", std::string(MaxAgentConfigValueBytes + 1, 'x')}}}}}}),
        AgentError);
    REQUIRE(facade->last_settings_apply.is_null());
    REQUIRE(controller.handle(
                {"get", "project_get", {{"project_id", project["project_id"]}}})
                ["revision"] == project["revision"]);
}

TEST_CASE("Preset and setting failures use stable bridge error codes", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});

    try {
        controller.handle(
            {"stale", "settings_apply",
             {{"project_id", project["project_id"]}, {"expected_revision", 99},
              {"changes", {{{"key", "layer_height"}, {"scope", "process"}, {"value", 0.2}}}}}});
        FAIL("Expected a revision conflict");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::RevisionConflict);
    }

    try {
        controller.handle(
            {"invalid", "presets_select",
             {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
              {"selection", nlohmann::json::object()}, {"discard_dirty", false}}});
        FAIL("Expected invalid request");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::InvalidRequest);
    }
}

TEST_CASE("Bridge responses keep stable success and error shapes", "[AgentBridge]")
{
    const auto success = success_response("one", {{"ready", true}});
    REQUIRE(success["id"] == "one");
    REQUIRE(success["result"]["ready"] == true);
    REQUIRE_FALSE(success.contains("error"));

    const AgentError cause(ErrorCode::UnknownMethod, "No such method", {{"method", "missing"}});
    const auto failure = error_response("two", cause);
    REQUIRE(failure["id"] == "two");
    REQUIRE(failure["error"]["code"] == ErrorCode::UnknownMethod);
    REQUIRE(failure["error"]["details"]["method"] == "missing");
    REQUIRE_FALSE(failure.contains("result"));
}

TEST_CASE("Slice and export jobs preserve revision and publish staged artifacts", "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto output_root = workspace.root / "outputs";
    std::filesystem::create_directories(output_root);
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, output_root,
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_slice_state =
        {true, false, 1.0,
         {{"sliced", true}, {"print_metrics", print_metrics_fixture()}}, nullptr, false,
         nlohmann::json::array({{{"code", "thin_wall"}, {"message", "Thin wall"},
                                 {"details", nullptr}}})};
    const auto slice = controller.handle(
        {"slice", "slice_start",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"plate_index", 1}}});
    const auto sliced = controller.handle(
        {"slice-get", "job_get", {{"job_id", slice["job_id"]}}});
    REQUIRE(sliced["state"] == "succeeded");
    REQUIRE(sliced["revision"] == project["revision"]);
    REQUIRE(sliced["source_revision"] == project["revision"]);
    REQUIRE(sliced["warnings"][0]["code"] == "thin_wall");
    REQUIRE(sliced["metadata"]["config_snapshot"]["revision"] == project["revision"]);
    REQUIRE(sliced["metadata"]["config_snapshot"]["settings"]["layer_height"] == "0.2");
    REQUIRE(sliced["result"]["plate_index"] == 1);
    REQUIRE(sliced["result"]["print_metrics"] == print_metrics_fixture());
    REQUIRE(sliced["result"]["print_metrics"]["time"]["normal_seconds"] == 3725.5);
    REQUIRE(sliced["result"]["print_metrics"]["filament"]["per_feature"][0]["feature"] ==
            "outer_wall");

    facade->next_export_state =
        {true, false, 1.0, {{"exported", true}}, nullptr, false, nlohmann::json::array()};
    const auto started = controller.handle(
        {"export", "gcode_export",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"slice_job_id", slice["job_id"]}, {"output_path", "plate.gcode"}}});
    const auto exported = controller.handle(
        {"export-get", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(exported["state"] == "succeeded");
    REQUIRE(exported["revision"] == project["revision"]);
    REQUIRE(std::filesystem::is_regular_file(output_root / "plate.gcode"));
    REQUIRE(exported["result"]["bytes"].get<std::uintmax_t>() > 0);
    REQUIRE(exported["result"]["path"] ==
            std::filesystem::canonical(output_root / "plate.gcode").string());
    REQUIRE(exported["metadata"]["config_snapshot"] ==
            sliced["metadata"]["config_snapshot"]);
    REQUIRE(exported["metadata"]["config_snapshot"]["settings"]["layer_height"] == "0.2");
    REQUIRE(facade->export_plate_index == 1);
    REQUIRE(facade->export_path.parent_path() == workspace.root / "artifacts");
    REQUIRE_FALSE(std::filesystem::exists(facade->export_path));
    REQUIRE(std::filesystem::is_empty(workspace.root / "artifacts"));
}

TEST_CASE("Final snapshot envelope is rejected before arrange startup", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    facade->custom_job_metadata = metadata_near_snapshot_limit();
    REQUIRE(facade->custom_job_metadata["config_snapshot"].dump().size() <=
            512u * 1024u);
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});

    try {
        controller.handle(
            {"arrange", "scene_arrange",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]}}});
        FAIL("Expected the final snapshot envelope to be rejected");
    } catch (const AgentError& error) {
        REQUIRE(error.code() == ErrorCode::InvalidRequest);
        REQUIRE(std::string(error.what()).find("snapshot") != std::string::npos);
    }
    REQUIRE_FALSE(facade->arrange_started);
}

TEST_CASE("Final snapshot envelope is rejected before slice startup", "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    facade->custom_job_metadata = metadata_near_snapshot_limit();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});

    REQUIRE_THROWS_AS(
        controller.handle(
            {"slice", "slice_start",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]}, {"plate_index", 0}}}),
        AgentError);
    REQUIRE_FALSE(facade->slice_started);
}

TEST_CASE("Job snapshots preserve deterministic override provenance and effective hashes",
          "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    facade->custom_job_metadata = {
        {"selected_presets", {{"printer", "Printer A"}, {"process", "Process A"},
                              {"filaments", {"PLA A"}}}},
        {"config_snapshot",
         {{"schema_version", 2},
          {"settings", {{"layer_height", "0.2"}}},
          {"overrides",
           {{{"kind", "object"}, {"identity", "object_10"},
             {"settings", {{"wall_loops", "3"}}},
             {"effective_sha256", std::string(64, 'b')}},
            {{"kind", "volume"}, {"identity", "object_10/volume_12"},
             {"settings", nlohmann::json::object()},
             {"effective_sha256", std::string(64, 'b')}},
            {{"kind", "plate"}, {"identity", "plate_0"},
             {"settings", {{"curr_bed_type", "1"}}},
             {"effective_sha256", std::string(64, 'c')}}}},
          {"redacted_keys", {"object_2/z_private", "object_10/private_plugin_setting",
                             "object_2/a_private", "object_10/private_plugin_setting"}},
          {"sha256", std::string(64, 'd')},
          {"bytes", 321}}}};
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_slice_state = {true, false, 1.0, {{"sliced", true}}, nullptr};
    const auto started = controller.handle(
        {"slice", "slice_start",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]}, {"plate_index", 0}}});
    const auto snapshot =
        controller.handle({"get", "job_get", {{"job_id", started["job_id"]}}})
            ["metadata"]["config_snapshot"];

    REQUIRE(snapshot["schema_version"] == 2);
    REQUIRE(snapshot["overrides"][0]["identity"] == "object_10");
    REQUIRE(snapshot["overrides"][1]["identity"] == "object_10/volume_12");
    REQUIRE(snapshot["overrides"][0]["effective_sha256"] ==
            snapshot["overrides"][1]["effective_sha256"]);
    REQUIRE(snapshot["overrides"][2]["effective_sha256"] !=
            snapshot["overrides"][0]["effective_sha256"]);
    REQUIRE(snapshot["redacted_keys"] ==
            nlohmann::json::array({"object_10/private_plugin_setting",
                                   "object_2/a_private", "object_2/z_private"}));
    REQUIRE(snapshot["sha256"] == std::string(64, 'd'));
}

TEST_CASE("Native job progress is monotonic and terminal-event driven", "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto output_root = workspace.root / "outputs";
    std::filesystem::create_directories(output_root);
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, output_root,
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_slice_state = {false, false, 0.25, nullptr, nullptr};
    const auto started = controller.handle(
        {"slice", "slice_start",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"plate_index", 0}}});
    REQUIRE(controller.handle({"p1", "job_get", {{"job_id", started["job_id"]}}})["progress"] ==
            0.25);
    facade->next_slice_state = {false, false, 0.1, nullptr, nullptr};
    REQUIRE(controller.handle({"p2", "job_get", {{"job_id", started["job_id"]}}})["progress"] ==
            0.25);
    facade->next_slice_state = {false, false, 0.8, nullptr, nullptr};
    REQUIRE(controller.handle({"p3", "job_get", {{"job_id", started["job_id"]}}})["progress"] ==
            0.8);
    facade->next_slice_state = {true, false, 1.0, {{"sliced", true}}, nullptr};
    const auto done = controller.handle({"done", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(done["state"] == "succeeded");
    REQUIRE(done["progress"] == 1.0);
}

TEST_CASE("Output resolver rejects escapes symlinks extensions and existing targets", "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto output_root = workspace.root / "outputs";
    const auto outside = workspace.root / "outside";
    std::filesystem::create_directories(output_root);
    std::filesystem::create_directories(outside);
    std::ofstream(output_root / "existing.3mf") << "old";
    std::filesystem::create_directory_symlink(outside, output_root / "linked");
    std::filesystem::create_symlink(outside / "escaped.3mf", output_root / "linked.3mf");
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, output_root,
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    const auto base = nlohmann::json{
        {"project_id", project["project_id"]}, {"expected_revision", project["revision"]}};
    for (const std::string path : {"../escape.3mf", "/absolute.3mf", "missing/file.3mf",
                                   "linked/escape.3mf", "linked.3mf", "wrong.gcode",
                                   "existing.3mf"}) {
        auto params = base;
        params["output_path"] = path;
        REQUIRE_THROWS_AS(controller.handle({"save", "project_save", params}), AgentError);
    }

    auto overwrite = base;
    overwrite["output_path"] = "existing.3mf";
    overwrite["overwrite"] = true;
    facade->next_save_state =
        {true, false, 1.0, {{"saved", true}}, nullptr, false, nlohmann::json::array()};
    const auto save = controller.handle({"save-ok", "project_save", overwrite});
    const auto saved =
        controller.handle({"save-get", "job_get", {{"job_id", save["job_id"]}}});
    REQUIRE(saved["state"] == "succeeded");
    REQUIRE(saved["metadata"]["config_snapshot"]["settings"]["layer_height"] == "0.2");
    REQUIRE(facade->save_path.parent_path() == workspace.root / "artifacts");
    REQUIRE(std::filesystem::is_empty(workspace.root / "artifacts"));
}

TEST_CASE("Project save startup failures remain discoverable through the job registry",
          "[AgentBridge]")
{
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    auto facade = std::make_shared<FakeFacade>();
    facade->fail_save = true;
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               1024, workspace.root / "outputs",
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"save", "project_save",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"output_path", "discoverable.3mf"}}});
    REQUIRE(started["state"] == "failed");
    const auto failed =
        controller.handle({"get", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(failed["state"] == "failed");
    REQUIRE(failed["error"]["code"] == "project_save_failed");
}

TEST_CASE("Oversized project save snapshot becomes a schema-consistent failed job",
          "[AgentBridge]")
{
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    auto facade = std::make_shared<FakeFacade>();
    facade->custom_job_metadata = metadata_near_snapshot_limit();
    bool native_save_started = false;
    facade->on_save = [&] { native_save_started = true; };
    facade->next_save_state =
        {true, false, 1.0, {{"saved", true}}, nullptr, false,
         nlohmann::json::array()};
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               1024, workspace.root / "outputs",
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"save", "project_save",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"output_path", "oversized.3mf"}}});
    const auto failed =
        controller.handle({"get", "job_get", {{"job_id", started["job_id"]}}});

    REQUIRE(failed["state"] == "failed");
    REQUIRE(failed["error"]["code"] == ErrorCode::InvalidRequest);
    REQUIRE(failed["metadata"]["output_path"] == "oversized.3mf");
    REQUIRE_FALSE(failed["metadata"].contains("config_snapshot"));
    REQUIRE(failed["revision"] == project["revision"]);
    REQUIRE_FALSE(native_save_started);
    REQUIRE_FALSE(std::filesystem::exists(workspace.root / "outputs" /
                                          "oversized.3mf"));
    REQUIRE(std::filesystem::is_empty(workspace.root / "artifacts"));
}

TEST_CASE("Unexpected project save metadata failure terminalizes its registered job",
          "[AgentBridge]")
{
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    auto facade = std::make_shared<FakeFacade>();
    facade->throw_metadata_runtime = true;
    bool native_save_started = false;
    facade->on_save = [&] { native_save_started = true; };
    AgentController controller(
        facade, workspace.root, workspace.root / "shots", 1024,
        workspace.root / "outputs", workspace.root / "imports",
        workspace.root / "artifacts");
    const auto project =
        controller.handle({"create", "project_create", {}});
    const auto started = controller.handle(
        {"save", "project_save",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"output_path", "metadata-failure.3mf"}}});
    const auto failed = controller.handle(
        {"get", "job_get", {{"job_id", started["job_id"]}}});

    REQUIRE(started["state"] == "failed");
    REQUIRE(failed["state"] == "failed");
    REQUIRE(failed["error"]["code"] == ErrorCode::InternalError);
    REQUIRE(failed["error"]["message"] ==
            "Project save configuration preparation failed");
    REQUIRE(failed.dump().find("sensitive metadata failure") ==
            std::string::npos);
    REQUIRE_FALSE(native_save_started);
    REQUIRE(std::filesystem::is_empty(workspace.root / "artifacts"));

    facade->throw_metadata_runtime = false;
    const auto transformed = controller.handle(
        {"transform", "object_transform",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"object_id", "object_10"},
          {"instance_id", "instance_11"},
          {"mode", "relative"},
          {"offset_mm", {0.0, 0.0, 0.0}},
          {"rotation_deg", {0.0, 0.0, 0.0}},
          {"scale", {1.0, 1.0, 1.0}}}});
    REQUIRE(transformed["revision"] ==
            project["revision"].get<std::uint64_t>() + 1);
}

TEST_CASE("External oversized configuration cannot wedge native synchronization",
          "[AgentBridge]")
{
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade);
    const auto project = controller.handle({"create", "project_create", {}});
    facade->custom_job_metadata = metadata_near_snapshot_limit();
    facade->config_fingerprint = "bounded-external-oversize-a";

    const auto first = controller.handle(
        {"get", "project_get", {{"project_id", project["project_id"]}}});
    REQUIRE(first["revision"] == project["revision"].get<std::uint64_t>() + 1);
    facade->config_fingerprint = "bounded-external-oversize-b";
    const auto second = controller.handle(
        {"get-2", "project_get", {{"project_id", project["project_id"]}}});
    REQUIRE(second["revision"] == project["revision"].get<std::uint64_t>() + 2);
}

TEST_CASE("Out-of-band native changes advance revision and invalidate active jobs",
          "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto output_root = workspace.root / "outputs";
    std::filesystem::create_directories(output_root);
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, output_root,
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_slice_state = {true, false, 1.0, {{"sliced", true}}, nullptr};
    const auto slice = controller.handle(
        {"slice", "slice_start",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]}, {"plate_index", 0}}});
    controller.handle({"slice-get", "job_get", {{"job_id", slice["job_id"]}}});
    facade->next_export_state = {false, false, 0.25, nullptr, nullptr};
    const auto started = controller.handle(
        {"export", "gcode_export",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"slice_job_id", slice["job_id"]}, {"output_path", "invalidated.gcode"}}});

    facade->fingerprint = "native-external-change";
    const auto invalidated =
        controller.handle({"job", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(invalidated["state"] == "running");
    REQUIRE(invalidated["revision"] == project["revision"].get<std::uint64_t>() + 1);
    REQUIRE_THROWS_AS(
        controller.handle(
            {"transform", "object_transform",
             {{"project_id", project["project_id"]},
              {"object_id", "object_10"}, {"instance_id", "instance_11"},
              {"offset_mm", {1.0, 0.0, 0.0}}}}),
        AgentError);

    facade->next_export_state =
        {true, false, 1.0, {{"exported", true}}, nullptr};
    const auto complete =
        controller.handle({"complete", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(complete["state"] == "failed");
    REQUIRE(complete["error"]["code"] == ErrorCode::RevisionConflict);
    REQUIRE_FALSE(std::filesystem::exists(output_root / "invalidated.gcode"));
    REQUIRE(std::filesystem::is_empty(workspace.root / "artifacts"));
}

TEST_CASE("External mutation beats terminal export publication on the first poll",
          "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto output_root = workspace.root / "outputs";
    std::filesystem::create_directories(output_root);
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, output_root,
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_slice_state = {true, false, 1.0, {{"sliced", true}}, nullptr};
    const auto slice = controller.handle(
        {"slice", "slice_start",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]}, {"plate_index", 0}}});
    controller.handle({"slice-get", "job_get", {{"job_id", slice["job_id"]}}});
    facade->next_export_state = {false, false, 0.5, nullptr, nullptr};
    const auto started = controller.handle(
        {"export", "gcode_export",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"slice_job_id", slice["job_id"]}, {"output_path", "stale.gcode"}}});

    facade->fingerprint = "native-external-terminal-race";
    facade->next_export_state =
        {true, false, 1.0, {{"exported", true}}, nullptr};
    const auto terminal =
        controller.handle({"terminal", "job_get", {{"job_id", started["job_id"]}}});
    REQUIRE(terminal["state"] == "failed");
    REQUIRE(terminal["error"]["code"] == ErrorCode::RevisionConflict);
    REQUIRE_FALSE(std::filesystem::exists(output_root / "stale.gcode"));
    REQUIRE(std::filesystem::is_empty(workspace.root / "artifacts"));
}

TEST_CASE("Artifact publication revalidates a target created after job start", "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto output_root = workspace.root / "outputs";
    std::filesystem::create_directories(output_root);
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, output_root,
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    facade->next_slice_state = {true, false, 1.0, {{"sliced", true}}, nullptr};
    const auto slice = controller.handle(
        {"slice", "slice_start",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"plate_index", 0}}});
    controller.handle({"slice-get", "job_get", {{"job_id", slice["job_id"]}}});
    facade->next_export_state =
        {true, false, 1.0, {{"exported", true}}, nullptr, false, nlohmann::json::array()};
    const auto export_job = controller.handle(
        {"export", "gcode_export",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"slice_job_id", slice["job_id"]}, {"output_path", "race.gcode"}}});
    std::ofstream(output_root / "race.gcode") << "concurrent";
    const auto failed = controller.handle(
        {"export-get", "job_get", {{"job_id", export_job["job_id"]}}});
    REQUIRE(failed["state"] == "failed");
    REQUIRE(failed["error"]["code"] == ErrorCode::InvalidPath);
    std::ifstream input(output_root / "race.gcode");
    std::string content;
    input >> content;
    REQUIRE(content == "concurrent");
}

TEST_CASE("Export rejects stale or mismatched slice jobs and cleans failed staging", "[AgentBridge]")
{
    TestWorkspace workspace;
    const auto output_root = workspace.root / "outputs";
    std::filesystem::create_directories(output_root);
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(facade, workspace.root, workspace.root / "shots",
                               512u * 1024u * 1024u, output_root,
                               workspace.root / "imports", workspace.root / "artifacts");
    const auto project = controller.handle({"create", "project_create", {}});
    REQUIRE_THROWS_AS(
        controller.handle(
            {"export", "gcode_export",
             {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
              {"slice_job_id", "missing"}, {"output_path", "plate.gcode"}}}),
        AgentError);

    facade->next_slice_state = {true, false, 1.0, {{"sliced", true}}, nullptr};
    const auto slice = controller.handle(
         {"slice", "slice_start",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"plate_index", 0}}});
    controller.handle({"slice-get", "job_get", {{"job_id", slice["job_id"]}}});
    facade->write_export = false;
    facade->next_export_state =
        {true, false, 1.0, {{"exported", true}}, nullptr, false, nlohmann::json::array()};
    const auto export_job = controller.handle(
        {"export", "gcode_export",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"slice_job_id", slice["job_id"]}, {"output_path", "plate.gcode"}}});
    const auto failed = controller.handle(
        {"export-get", "job_get", {{"job_id", export_job["job_id"]}}});
    REQUIRE(failed["state"] == "failed");
    REQUIRE(failed["error"]["code"] == ErrorCode::InvalidPath);
    REQUIRE(failed["error"]["details"].is_null());
    REQUIRE_FALSE(std::filesystem::exists(facade->export_path));

    facade->next_slice_state = {true, false, 1.0, {{"sliced", true}}, nullptr};
    const auto second_slice = controller.handle(
        {"slice-empty", "slice_start",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"plate_index", 0}}});
    controller.handle({"slice-empty-get", "job_get", {{"job_id", second_slice["job_id"]}}});
    facade->write_export = true;
    facade->export_contents.clear();
    const auto empty_export = controller.handle(
        {"export-empty", "gcode_export",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"slice_job_id", second_slice["job_id"]}, {"output_path", "empty.gcode"}}});
    const auto empty_failed = controller.handle(
        {"export-empty-get", "job_get", {{"job_id", empty_export["job_id"]}}});
    REQUIRE(empty_failed["state"] == "failed");
    REQUIRE(empty_failed["error"]["code"] == ErrorCode::InvalidPath);
    REQUIRE(empty_failed["error"]["details"].is_null());
    REQUIRE_FALSE(std::filesystem::exists(output_root / "empty.gcode"));

    facade->next_slice_state =
        {true, false, 0.5, nullptr, nullptr, true, nlohmann::json::array()};
    const auto cancelled_job = controller.handle(
        {"slice-cancel", "slice_start",
         {{"project_id", project["project_id"]}, {"expected_revision", project["revision"]},
          {"plate_index", 0}}});
    const auto cancelled = controller.handle(
        {"slice-cancel-get", "job_get", {{"job_id", cancelled_job["job_id"]}}});
    REQUIRE(cancelled["state"] == "cancelled");
    REQUIRE(cancelled["result"].is_null());
    REQUIRE(cancelled["error"].is_null());
    REQUIRE(cancelled["revision"] == project["revision"]);
}

TEST_CASE("Controller terminal cleanup preserves a replaced staging artifact",
          "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Adversarial inode replacement coverage is POSIX-specific");
#else
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    auto facade = std::make_shared<FakeFacade>();
    AgentController controller(
        facade, workspace.root, workspace.root / "shots", 1024,
        workspace.root / "outputs", workspace.root / "imports",
        workspace.root / "artifacts");
    const auto project =
        controller.handle({"create", "project_create", {}});
    facade->next_slice_state =
        {true, false, 1.0, {{"sliced", true}}, nullptr};
    const auto slice = controller.handle(
        {"slice", "slice_start",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"plate_index", 0}}});
    controller.handle(
        {"slice-get", "job_get", {{"job_id", slice["job_id"]}}});
    facade->next_export_state =
        {true, true, 1.0, nullptr, {{"message", "failed"}}};
    const auto exported = controller.handle(
        {"export", "gcode_export",
         {{"project_id", project["project_id"]},
          {"expected_revision", project["revision"]},
          {"slice_job_id", slice["job_id"]},
          {"output_path", "failed.gcode"}}});
    const auto staging = facade->export_path;
    bool replaced = false;
    facade->on_export_state = [&] {
        if (replaced)
            return;
        replaced = true;
        std::filesystem::remove(staging);
        std::ofstream(staging) << "replacement";
    };
    const auto failed = controller.handle(
        {"export-get", "job_get", {{"job_id", exported["job_id"]}}});

    REQUIRE(failed["state"] == "failed");
    std::ifstream input(staging);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "replacement");
#endif
}

TEST_CASE("Controller destruction preserves a replaced staging artifact",
          "[AgentBridge]")
{
#if defined(_WIN32)
    SKIP("Adversarial inode replacement coverage is POSIX-specific");
#else
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    auto facade = std::make_shared<FakeFacade>();
    std::filesystem::path staging;
    {
        AgentController controller(
            facade, workspace.root, workspace.root / "shots", 1024,
            workspace.root / "outputs", workspace.root / "imports",
            workspace.root / "artifacts");
        const auto project =
            controller.handle({"create", "project_create", {}});
        facade->next_slice_state =
            {true, false, 1.0, {{"sliced", true}}, nullptr};
        const auto slice = controller.handle(
            {"slice", "slice_start",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]},
              {"plate_index", 0}}});
        controller.handle(
            {"slice-get", "job_get", {{"job_id", slice["job_id"]}}});
        facade->next_export_state =
            {false, false, 0.5, nullptr, nullptr};
        controller.handle(
            {"export", "gcode_export",
             {{"project_id", project["project_id"]},
              {"expected_revision", project["revision"]},
              {"slice_job_id", slice["job_id"]},
              {"output_path", "running.gcode"}}});
        staging = facade->export_path;
        std::filesystem::remove(staging);
        std::ofstream(staging) << "replacement";
    }
    std::ifstream input(staging);
    std::string contents;
    input >> contents;
    REQUIRE(contents == "replacement");
#endif
}

#if !defined(__linux__)
TEST_CASE("Native bridge is disabled outside Linux", "[AgentBridge]")
{
    AgentBridge bridge("/unused/orca-agent.sock", [](std::function<void()> callback) {
        callback();
    }, std::chrono::seconds(10), std::make_shared<FakeFacade>());
    std::string error;
    REQUIRE_FALSE(bridge.start(error));
    REQUIRE(error.find("only on Linux") != std::string::npos);
    bridge.stop();
}
#else
namespace {

class TemporaryDirectory
{
public:
    TemporaryDirectory()
    {
        char pattern[] = "/tmp/agent-slicer-bridge-XXXXXX";
        const char* created = ::mkdtemp(pattern);
        if (created == nullptr)
            throw std::runtime_error("Unable to create temporary bridge directory");
        m_path = created;
    }

    ~TemporaryDirectory()
    {
        ::rmdir(m_path.c_str());
    }

    std::string socket_path() const { return m_path + "/orca-agent.sock"; }
    const std::string& path() const { return m_path; }

private:
    std::string m_path;
};

bool write_exact(int socket, const std::uint8_t* data, std::size_t size)
{
    std::size_t offset = 0;
    while (offset < size) {
        const ssize_t count = ::write(socket, data + offset, size - offset);
        if (count <= 0)
            return false;
        offset += static_cast<std::size_t>(count);
    }
    return true;
}

bool read_exact(int socket, std::uint8_t* data, std::size_t size)
{
    std::size_t offset = 0;
    while (offset < size) {
        const ssize_t count = ::read(socket, data + offset, size - offset);
        if (count <= 0)
            return false;
        offset += static_cast<std::size_t>(count);
    }
    return true;
}

nlohmann::json call_bridge(const std::string& path, const nlohmann::json& request)
{
    const int client = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (client < 0)
        throw std::runtime_error("Unable to create bridge client socket");

    sockaddr_un address {};
    address.sun_family = AF_UNIX;
    std::copy(path.begin(), path.end(), address.sun_path);
    address.sun_path[path.size()] = '\0';

    bool connected = false;
    for (int attempt = 0; attempt < 100 && !connected; ++attempt) {
        connected = ::connect(client, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0;
        if (!connected)
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    if (!connected) {
        ::close(client);
        throw std::runtime_error("Unable to connect to bridge socket");
    }

    const auto frame = encode_json_frame(request);
    if (!write_exact(client, frame.data(), frame.size())) {
        ::close(client);
        throw std::runtime_error("Unable to write bridge request");
    }

    std::array<std::uint8_t, 4> header {};
    if (!read_exact(client, header.data(), header.size())) {
        ::close(client);
        throw std::runtime_error("Bridge closed before sending a response");
    }
    const std::uint32_t size =
        (static_cast<std::uint32_t>(header[0]) << 24) |
        (static_cast<std::uint32_t>(header[1]) << 16) |
        (static_cast<std::uint32_t>(header[2]) << 8) |
        static_cast<std::uint32_t>(header[3]);
    std::string payload(size, '\0');
    if (!read_exact(client, reinterpret_cast<std::uint8_t*>(payload.data()), payload.size())) {
        ::close(client);
        throw std::runtime_error("Bridge response was truncated");
    }
    ::close(client);
    return nlohmann::json::parse(payload);
}

} // namespace

TEST_CASE("Linux bridge serves framed requests and reconnects", "[AgentBridge]")
{
    TemporaryDirectory directory;
    AgentBridge bridge(directory.socket_path(), [](std::function<void()> callback) {
        callback();
    }, std::chrono::seconds(10), std::make_shared<FakeFacade>());
    std::string error;
    REQUIRE(bridge.start(error));

    struct stat info {};
    REQUIRE(::lstat(directory.socket_path().c_str(), &info) == 0);
    REQUIRE((info.st_mode & 0777) == 0660);

    const auto first = call_bridge(directory.socket_path(),
                                   {{"id", "one"}, {"method", "slicer_status"}});
    REQUIRE(first["result"]["ready"] == true);
    const auto second = call_bridge(directory.socket_path(),
                                    {{"id", "two"}, {"method", "slicer_status"}});
    REQUIRE(second["id"] == "two");
    bridge.stop();
}

TEST_CASE("Linux bridge shutdown preserves a socket replaced before quarantine",
          "[AgentBridge]")
{
    TemporaryDirectory directory;
    int replacement = -1;
    const std::string path = directory.socket_path();
    AgentBridge bridge(
        path,
        [](std::function<void()> callback) { callback(); },
        std::chrono::seconds(10), std::make_shared<FakeFacade>(),
        "/workspace", "/screenshots/mcp", 512u * 1024u * 1024u,
        "/outputs", "/run/agent-slicer/imports",
        "/run/agent-slicer/artifacts",
        [&] {
            REQUIRE(::unlink(path.c_str()) == 0);
            replacement = ::socket(AF_UNIX, SOCK_STREAM, 0);
            REQUIRE(replacement >= 0);
            sockaddr_un address {};
            address.sun_family = AF_UNIX;
            std::copy(path.begin(), path.end(), address.sun_path);
            address.sun_path[path.size()] = '\0';
            REQUIRE(::bind(
                replacement,
                reinterpret_cast<const sockaddr*>(&address),
                sizeof(address)) == 0);
        });
    std::string error;
    REQUIRE(bridge.start(error));

    bridge.stop();
    struct stat replacement_info {};
    REQUIRE(::lstat(path.c_str(), &replacement_info) == 0);
    REQUIRE(S_ISSOCK(replacement_info.st_mode));
    REQUIRE(replacement >= 0);
    ::close(replacement);
    REQUIRE(::unlink(path.c_str()) == 0);
}

TEST_CASE("Linux bridge abandons queued callbacks after timeout", "[AgentBridge]")
{
    TemporaryDirectory directory;
    std::mutex queue_mutex;
    std::vector<std::function<void()>> queued;
    std::atomic<bool> immediate {false};
    AgentBridge bridge(
        directory.socket_path(),
        [&](std::function<void()> callback) {
            if (immediate.load()) {
                callback();
                return;
            }
            std::lock_guard<std::mutex> lock(queue_mutex);
            queued.emplace_back(std::move(callback));
        },
        std::chrono::milliseconds(50),
        std::make_shared<FakeFacade>());
    std::string error;
    REQUIRE(bridge.start(error));

    const auto timeout = call_bridge(directory.socket_path(),
                                     {{"id", "create"}, {"method", "project_create"}});
    REQUIRE(timeout["error"]["code"] == ErrorCode::RequestTimeout);

    immediate.store(true);
    {
        std::lock_guard<std::mutex> lock(queue_mutex);
        REQUIRE(queued.size() == 1);
        queued.front()();
        queued.clear();
    }
    const auto status = call_bridge(directory.socket_path(),
                                    {{"id", "status"}, {"method", "slicer_status"}});
    REQUIRE(status["result"]["project_id"].is_null());
    bridge.stop();
}

TEST_CASE("Linux bridge times out while a GUI callback is running", "[AgentBridge]")
{
    TemporaryDirectory directory;
    std::promise<void> callback_started;
    std::promise<void> callback_thread_assigned;
    std::promise<void> release_callback;
    auto release = release_callback.get_future().share();
    std::thread callback_thread;
    auto facade = std::make_shared<FakeFacade>();
    facade->on_create = [&] {
        callback_started.set_value();
        release.wait();
    };
    AgentBridge bridge(
        directory.socket_path(),
        [&](std::function<void()> callback) {
            callback_thread = std::thread(std::move(callback));
            callback_thread_assigned.set_value();
        },
        std::chrono::milliseconds(50),
        facade);
    std::string error;
    REQUIRE(bridge.start(error));

    auto response = std::async(std::launch::async, [&] {
        return call_bridge(directory.socket_path(),
                           {{"id", "running"}, {"method", "project_create"}});
    });
    const auto assigned_status =
        callback_thread_assigned.get_future().wait_for(std::chrono::seconds(1));
    const auto started_status =
        callback_started.get_future().wait_for(std::chrono::seconds(1));
    const auto response_status = response.wait_for(std::chrono::seconds(1));
    release_callback.set_value();
    if (callback_thread.joinable())
        callback_thread.join();
    REQUIRE(assigned_status == std::future_status::ready);
    REQUIRE(started_status == std::future_status::ready);
    REQUIRE(response_status == std::future_status::ready);
    REQUIRE(response.get()["error"]["code"] == ErrorCode::RequestTimeout);
    bridge.stop();
}

TEST_CASE("Linux bridge timeout cannot leave a queued model import ghost mutation",
          "[AgentBridge]")
{
    TemporaryDirectory directory;
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    std::mutex queue_mutex;
    std::vector<std::function<void()>> queued;
    std::atomic<bool> immediate {true};
    auto facade = std::make_shared<FakeFacade>();
    AgentBridge bridge(
        directory.socket_path(),
        [&](std::function<void()> callback) {
            if (immediate.load()) {
                callback();
                return;
            }
            std::lock_guard<std::mutex> lock(queue_mutex);
            queued.emplace_back(std::move(callback));
        },
        std::chrono::milliseconds(50), facade, workspace.root.string(),
        (workspace.root / "shots").string(), 1024,
        (workspace.root / "outputs").string(),
        (workspace.root / "imports").string(),
        (workspace.root / "artifacts").string());
    std::string error;
    REQUIRE(bridge.start(error));
    const auto created = call_bridge(
        directory.socket_path(), {{"id", "create"}, {"method", "project_create"}});
    const auto project = created["result"];

    immediate.store(false);
    const auto timed_out = call_bridge(
        directory.socket_path(),
        {{"id", "import"}, {"method", "model_import"},
         {"params", {{"project_id", project["project_id"]},
                     {"expected_revision", project["revision"]},
                     {"path", "part.stl"}}}});
    REQUIRE(timed_out["error"]["code"] == ErrorCode::RequestTimeout);
    {
        std::lock_guard<std::mutex> lock(queue_mutex);
        REQUIRE(queued.size() == 1);
        queued.front()();
        queued.clear();
    }
    REQUIRE_FALSE(facade->import_started);
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));

    immediate.store(true);
    const auto status = call_bridge(
        directory.socket_path(), {{"id", "status"}, {"method", "slicer_status"}});
    REQUIRE(status["result"]["revision"] == project["revision"]);
    bridge.stop();
}

TEST_CASE("Linux bridge deadline includes model import preparation", "[AgentBridge]")
{
    TemporaryDirectory directory;
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    auto facade = std::make_shared<FakeFacade>();
    std::atomic<unsigned> scheduled {0};
    AgentBridge bridge(
        directory.socket_path(),
        [&](std::function<void()> callback) {
            ++scheduled;
            callback();
        },
        std::chrono::milliseconds(5), facade, workspace.root.string(),
        (workspace.root / "shots").string(), 64u * 1024u * 1024u,
        (workspace.root / "outputs").string(),
        (workspace.root / "imports").string(),
        (workspace.root / "artifacts").string());
    std::string error;
    REQUIRE(bridge.start(error));
    const auto project = call_bridge(
        directory.socket_path(), {{"id", "create"}, {"method", "project_create"}})["result"];
    REQUIRE(scheduled.load() == 1);

    {
        std::ofstream large(workspace.root / "part.stl",
                            std::ios::binary | std::ios::trunc);
        const std::string chunk(1024u * 1024u, 'x');
        for (unsigned index = 0; index < 32; ++index)
            large.write(chunk.data(), static_cast<std::streamsize>(chunk.size()));
    }
    const auto timed_out = call_bridge(
        directory.socket_path(),
        {{"id", "slow-import"}, {"method", "model_import"},
         {"params", {{"project_id", project["project_id"]},
                     {"expected_revision", project["revision"]},
                     {"path", "part.stl"}}}});
    REQUIRE(timed_out["error"]["code"] == ErrorCode::RequestTimeout);
    REQUIRE(scheduled.load() == 1);
    REQUIRE_FALSE(facade->import_started);
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));
    bridge.stop();
}

TEST_CASE("Linux bridge abandons model import commit when startup outlives request",
          "[AgentBridge]")
{
    TemporaryDirectory directory;
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    std::promise<void> import_started;
    std::promise<void> release_import;
    auto release = release_import.get_future().share();
    std::thread callback_thread;
    std::atomic<bool> threaded {false};
    auto facade = std::make_shared<FakeFacade>();
    facade->on_import = [&](const std::filesystem::path&) {
        import_started.set_value();
        release.wait();
    };
    AgentBridge bridge(
        directory.socket_path(),
        [&](std::function<void()> callback) {
            if (!threaded.load()) {
                callback();
                return;
            }
            callback_thread = std::thread(std::move(callback));
        },
        std::chrono::milliseconds(50), facade, workspace.root.string(),
        (workspace.root / "shots").string(), 1024,
        (workspace.root / "outputs").string(),
        (workspace.root / "imports").string(),
        (workspace.root / "artifacts").string());
    std::string error;
    REQUIRE(bridge.start(error));
    const auto project = call_bridge(
        directory.socket_path(), {{"id", "create"}, {"method", "project_create"}})["result"];

    threaded.store(true);
    auto response = std::async(std::launch::async, [&] {
        return call_bridge(
            directory.socket_path(),
            {{"id", "import"}, {"method", "model_import"},
             {"params", {{"project_id", project["project_id"]},
                         {"expected_revision", project["revision"]},
                         {"path", "part.stl"}}}});
    });
    REQUIRE(import_started.get_future().wait_for(std::chrono::seconds(1)) ==
            std::future_status::ready);
    REQUIRE(response.wait_for(std::chrono::seconds(1)) == std::future_status::ready);
    REQUIRE(response.get()["error"]["code"] == ErrorCode::RequestTimeout);
    release_import.set_value();
    if (callback_thread.joinable())
        callback_thread.join();

    threaded.store(false);
    const auto status = call_bridge(
        directory.socket_path(), {{"id", "status"}, {"method", "slicer_status"}});
    REQUIRE(status["result"]["revision"] == project["revision"]);
    REQUIRE_FALSE(facade->import_committed);
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));
    bridge.stop();
}

TEST_CASE("Linux bridge abandons import when job response is never delivered",
          "[AgentBridge]")
{
    TemporaryDirectory directory;
    TestWorkspace workspace;
    std::filesystem::create_directories(workspace.root / "outputs");
    std::promise<void> import_started;
    std::promise<void> release_import;
    auto release = release_import.get_future().share();
    std::thread callback_thread;
    std::atomic<bool> threaded {false};
    auto facade = std::make_shared<FakeFacade>();
    facade->on_import = [&](const std::filesystem::path&) {
        import_started.set_value();
        release.wait();
    };
    AgentBridge bridge(
        directory.socket_path(),
        [&](std::function<void()> callback) {
            if (threaded.load())
                callback_thread = std::thread(std::move(callback));
            else
                callback();
        },
        std::chrono::seconds(5), facade, workspace.root.string(),
        (workspace.root / "shots").string(), 1024,
        (workspace.root / "outputs").string(),
        (workspace.root / "imports").string(),
        (workspace.root / "artifacts").string());
    std::string error;
    REQUIRE(bridge.start(error));
    const auto project = call_bridge(
        directory.socket_path(), {{"id", "create"}, {"method", "project_create"}})["result"];

    threaded.store(true);
    const int client = ::socket(AF_UNIX, SOCK_STREAM, 0);
    REQUIRE(client >= 0);
    sockaddr_un address {};
    address.sun_family = AF_UNIX;
    const std::string socket_path = directory.socket_path();
    std::copy(socket_path.begin(), socket_path.end(), address.sun_path);
    address.sun_path[socket_path.size()] = '\0';
    REQUIRE(::connect(client, reinterpret_cast<const sockaddr*>(&address),
                      sizeof(address)) == 0);
    const auto frame = encode_json_frame(
        {{"id", "unpublished-import"}, {"method", "model_import"},
         {"params", {{"project_id", project["project_id"]},
                     {"expected_revision", project["revision"]},
                     {"path", "part.stl"}}}});
    REQUIRE(write_exact(client, frame.data(), frame.size()));
    REQUIRE(import_started.get_future().wait_for(std::chrono::seconds(1)) ==
            std::future_status::ready);
    ::shutdown(client, SHUT_RDWR);
    ::close(client);
    release_import.set_value();
    if (callback_thread.joinable())
        callback_thread.join();

    threaded.store(false);
    const auto status = call_bridge(
        directory.socket_path(), {{"id", "status"}, {"method", "slicer_status"}});
    REQUIRE(status["result"]["revision"] == project["revision"]);
    REQUIRE_FALSE(facade->import_committed);
    REQUIRE(std::filesystem::is_empty(workspace.root / "imports"));
    bridge.stop();
}

TEST_CASE("Linux bridge shutdown abandons pending callbacks promptly", "[AgentBridge]")
{
    TemporaryDirectory directory;
    AgentBridge bridge(
        directory.socket_path(),
        [](std::function<void()>) {},
        std::chrono::seconds(10),
        std::make_shared<FakeFacade>());
    std::string error;
    REQUIRE(bridge.start(error));

    auto request = std::async(std::launch::async, [&] {
        return call_bridge(directory.socket_path(),
                           {{"id", "pending"}, {"method", "project_create"}});
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    const auto started = std::chrono::steady_clock::now();
    bridge.stop();
    const auto elapsed = std::chrono::steady_clock::now() - started;
    REQUIRE(elapsed < std::chrono::seconds(1));
    REQUIRE(request.wait_for(std::chrono::seconds(1)) == std::future_status::ready);
    try {
        request.get();
    } catch (const std::runtime_error&) {
        // Closing the active socket during shutdown is an allowed client outcome.
    }
}

TEST_CASE("Linux bridge rejects unsafe directories and live sockets", "[AgentBridge]")
{
    TemporaryDirectory directory;
    REQUIRE(::chmod(directory.path().c_str(), 0777) == 0);
    AgentBridge unsafe(directory.socket_path(), [](std::function<void()> callback) {
        callback();
    }, std::chrono::seconds(10), std::make_shared<FakeFacade>());
    std::string error;
    REQUIRE_FALSE(unsafe.start(error));
    REQUIRE(error.find("non-world-writable") != std::string::npos);
    REQUIRE(::chmod(directory.path().c_str(), 0700) == 0);

    AgentBridge first(directory.socket_path(), [](std::function<void()> callback) {
        callback();
    }, std::chrono::seconds(10), std::make_shared<FakeFacade>());
    REQUIRE(first.start(error));
    AgentBridge second(directory.socket_path(), [](std::function<void()> callback) {
        callback();
    }, std::chrono::seconds(10), std::make_shared<FakeFacade>());
    REQUIRE_FALSE(second.start(error));
    REQUIRE(error.find("already accepting") != std::string::npos);
    first.stop();
}
#endif
