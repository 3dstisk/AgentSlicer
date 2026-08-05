#include "AgentController.hpp"
#include "AgentSettingValidation.hpp"
#include "SecureFile.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <iomanip>
#include <random>
#include <sstream>
#include <set>
#include <stdexcept>
#include <tuple>

namespace Slic3r::GUI::Agent {

namespace {

bool is_finite_number(const nlohmann::json& value)
{
    return value.is_number() && std::isfinite(value.get<double>());
}

void validate_vector(const nlohmann::json& params, const char* key, bool positive)
{
    if (!params.contains(key))
        return;
    const auto& value = params.at(key);
    if (!value.is_array() || value.size() != 3)
        throw AgentError(ErrorCode::InvalidRequest, std::string(key) + " must contain three numbers");
    for (const auto& component : value) {
        if (!is_finite_number(component) || (positive && component.get<double>() <= 0.0))
            throw AgentError(ErrorCode::InvalidRequest,
                             std::string(key) + (positive ? " must contain positive finite numbers"
                                                         : " must contain finite numbers"));
    }
}

const std::set<std::string> ConfigurationScopes {"printer", "process", "filament"};

nlohmann::json structured_job_error(const Job& job, const nlohmann::json& native)
{
    if (native.is_object() && native.contains("code") && native.at("code").is_string() &&
        native.contains("message") && native.at("message").is_string()) {
        nlohmann::json result = native;
        if (!result.contains("details"))
            result["details"] = nullptr;
        return result;
    }
    const std::string message =
        native.is_object() && native.contains("message") && native.at("message").is_string() ?
            native.at("message").get<std::string>() : "Native job failed";
    return {{"code", job.type + "_failed"}, {"message", message}, {"details", nullptr}};
}

void capture_staging_identity(Job& job) noexcept
{
    if (job.staging_path.empty())
        return;
    if (!job.staging_identity) {
        try {
            job.staging_identity =
                trusted_artifact_identity(job.staging_path);
        } catch (...) {}
    }
    if (!job.staging_temporary_identity) {
        try {
            job.staging_temporary_identity =
                trusted_artifact_identity(job.staging_path.string() + ".tmp");
        } catch (...) {}
    }
}

void cleanup_staging_temporary(Job& job) noexcept
{
    if (!job.staging_temporary_identity)
        return;
    try {
        remove_trusted_artifact(
            job.staging_path.string() + ".tmp",
            *job.staging_temporary_identity);
    } catch (...) {}
    job.staging_temporary_identity.reset();
}

void cleanup_staging(Job& job) noexcept
{
    cleanup_staging_temporary(job);
    if (job.staging_identity) {
        try {
            remove_trusted_artifact(
                job.staging_path, *job.staging_identity);
        } catch (...) {}
    }
    job.staging_path.clear();
    job.staging_identity.reset();
}

void validate_scopes(const nlohmann::json& params)
{
    if (!params.contains("scopes"))
        return;
    const auto& scopes = params.at("scopes");
    if (!scopes.is_array() || scopes.empty() || scopes.size() > ConfigurationScopes.size())
        throw AgentError(ErrorCode::InvalidRequest, "scopes must contain between one and three entries");
    std::set<std::string> unique;
    for (const auto& scope : scopes) {
        if (!scope.is_string() || ConfigurationScopes.count(scope.get<std::string>()) == 0)
            throw AgentError(ErrorCode::InvalidRequest, "Unsupported configuration scope");
        if (!unique.insert(scope.get<std::string>()).second)
            throw AgentError(ErrorCode::InvalidRequest, "Configuration scopes must be unique");
    }
}

void validate_setting_entries(const nlohmann::json& params, const char* field, bool require_value)
{
    if (!params.contains(field) || !params.at(field).is_array() || params.at(field).empty() ||
        params.at(field).size() > 256)
        throw AgentError(ErrorCode::InvalidRequest,
                         std::string(field) + " must contain between one and 256 entries");
    std::set<std::tuple<std::string, std::string, size_t>> unique;
    for (const auto& entry : params.at(field)) {
        if (!entry.is_object() || !entry.contains("key") || !entry.at("key").is_string() ||
            entry.at("key").get_ref<const std::string&>().empty() ||
            !entry.contains("scope") || !entry.at("scope").is_string() ||
            ConfigurationScopes.count(entry.at("scope").get<std::string>()) == 0 ||
            (require_value && !entry.contains("value")))
            throw AgentError(ErrorCode::InvalidRequest, "Invalid setting entry");
        if (!is_agent_setting_allowed(entry.at("key").get_ref<const std::string&>()))
            throw AgentError(ErrorCode::InvalidRequest,
                             "Setting is not available through the agent capability",
                             {{"key", entry.at("key")}});
        const std::string scope = entry.at("scope").get<std::string>();
        size_t filament_index = 0;
        if (entry.contains("filament_index")) {
            const auto& index = entry.at("filament_index");
            const bool valid_unsigned = index.is_number_unsigned() &&
                index.get<std::uint64_t>() < 64;
            const bool valid_signed = index.is_number_integer() &&
                index.get<std::int64_t>() >= 0 && index.get<std::int64_t>() < 64;
            if (scope != "filament" || (!valid_unsigned && !valid_signed))
                throw AgentError(ErrorCode::InvalidRequest,
                                 "filament_index is only valid for filament scope and must be between 0 and 63");
            filament_index = valid_unsigned ?
                static_cast<size_t>(index.get<std::uint64_t>()) :
                static_cast<size_t>(index.get<std::int64_t>());
        }
        const auto identity = std::make_tuple(scope, entry.at("key").get<std::string>(),
                                              filament_index);
        if (!unique.insert(identity).second)
            throw AgentError(ErrorCode::InvalidRequest,
                             "Setting entries must be unique by scope, key, and filament index");
        if (require_value) {
            const auto valid_value = [](const nlohmann::json& value, const auto& self, unsigned depth) -> bool {
                if (value.is_null() || value.is_boolean() || value.is_string())
                    return true;
                if (value.is_number())
                    return std::isfinite(value.get<double>());
                if (value.is_object())
                    return value.size() == 2 && value.contains("value") &&
                        value.at("value").is_number() &&
                        std::isfinite(value.at("value").get<double>()) &&
                        value.contains("percent") && value.at("percent").is_boolean();
                if (!value.is_array() || depth >= 3)
                    return false;
                return std::all_of(value.begin(), value.end(),
                                   [&](const auto& child) { return self(child, self, depth + 1); });
            };
            if (!valid_value(entry.at("value"), valid_value, 0))
                throw AgentError(ErrorCode::InvalidRequest, "Setting value must be finite typed JSON");
            if (entry.at("value").dump().size() > MaxAgentConfigValueBytes)
                throw AgentError(
                    ErrorCode::InvalidRequest, "Setting value exceeds the size limit",
                    {{"key", entry.at("key")},
                     {"max_bytes", MaxAgentConfigValueBytes}});
        }
    }
}

constexpr std::size_t MaxConfigSnapshotEnvelopeBytes = 512u * 1024u;

nlohmann::json job_config_snapshot(const nlohmann::json& native_metadata,
                                   std::uint64_t revision)
{
    const auto& native = native_metadata.at("config_snapshot");
    std::vector<std::string> redacted_keys =
        native.at("redacted_keys").get<std::vector<std::string>>();
    std::sort(redacted_keys.begin(), redacted_keys.end());
    redacted_keys.erase(std::unique(redacted_keys.begin(), redacted_keys.end()),
                        redacted_keys.end());
    nlohmann::json result = {
        {"schema_version", native.at("schema_version")},
        {"revision", revision},
        {"presets", native_metadata.at("selected_presets")},
        {"settings", native.at("settings")},
        {"sha256", native.at("sha256")},
        {"bytes", native.at("bytes")},
        {"redacted_keys", std::move(redacted_keys)}
    };
    if (native.contains("overrides"))
        result["overrides"] = native.at("overrides");
    const std::size_t envelope_bytes = result.dump().size();
    if (envelope_bytes > MaxConfigSnapshotEnvelopeBytes)
        throw AgentError(
            ErrorCode::InvalidRequest,
            "Final configuration snapshot exceeds the response size limit",
            {{"bytes", envelope_bytes},
             {"max_bytes", MaxConfigSnapshotEnvelopeBytes}});
    return result;
}

} // namespace

AgentController::AgentController(std::shared_ptr<AgentSlicerFacade> facade,
                                 std::filesystem::path workspace_root,
                                 std::filesystem::path screenshot_root,
                                 std::uintmax_t max_import_bytes,
                                 std::filesystem::path output_root,
                                 std::filesystem::path import_staging_root,
                                 std::filesystem::path artifact_staging_root)
    : m_facade(std::move(facade))
    , m_workspace_root(std::move(workspace_root))
    , m_screenshot_root(std::move(screenshot_root))
    , m_output_root(std::move(output_root))
    , m_import_staging_root(std::move(import_staging_root))
    , m_artifact_staging_root(std::move(artifact_staging_root))
    , m_max_import_bytes(max_import_bytes)
{
    if (!m_facade)
        throw std::invalid_argument("AgentController requires an AgentSlicerFacade");
}

AgentController::~AgentController()
{
    for (auto& [id, job] : m_jobs) {
        (void) id;
        cleanup_staging(job);
    }
}

PreparedRequest AgentController::prepare(
    const Request& request,
    std::shared_ptr<std::atomic<bool>> request_abandoned,
    std::function<bool()> cancelled) const
{
    PreparedRequest prepared {request, nullptr, std::move(request_abandoned)};
    if (request.method != "model_import")
        return prepared;
    if (!request.params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        require_active_project(request.params);
        require_no_active_mutation("Cannot import a model while a mutating job is active");
    }
    if (!request.params.contains("path") || !request.params.at("path").is_string())
        throw AgentError(ErrorCode::InvalidRequest, "path must be a string");
    prepared.import_snapshot = std::make_shared<TemporaryFile>(
        snapshot_workspace_import(
            m_workspace_root, m_import_staging_root,
            request.params.at("path").get_ref<const std::string&>(), m_max_import_bytes,
            std::move(cancelled)));
    return prepared;
}

nlohmann::json AgentController::handle(const Request& request)
{
    return handle_prepared(prepare(request));
}

nlohmann::json AgentController::handle_prepared(const PreparedRequest& prepared)
{
    const Request& request = prepared.request;
    const std::uint64_t revision_before_refresh = m_revision;
    synchronize_native_state(revision_before_refresh);
    refresh_jobs();
    synchronize_native_state(revision_before_refresh);
    nlohmann::json result = [&]() -> nlohmann::json {
        if (request.method == "slicer_status")
            return status();
        if (request.method == "project_create")
            return create_project();
        if (request.method == "project_get")
            return get_project(request.params);
        if (request.method == "model_import")
            return import_model(request.params, prepared.import_snapshot,
                                prepared.request_abandoned);
        if (request.method == "scene_get")
            return get_scene(request.params);
        if (request.method == "object_transform")
            return transform_object(request.params);
        if (request.method == "object_auto_orient")
            return auto_orient_objects(request.params);
        if (request.method == "scene_arrange")
            return arrange_scene(request.params);
        if (request.method == "scene_render")
            return render_scene(request.params);
        if (request.method == "desktop_capture")
            return desktop_capture(request.params);
        if (request.method == "presets_list")
            return list_presets(request.params);
        if (request.method == "presets_select")
            return select_presets(request.params);
        if (request.method == "settings_describe")
            return describe_settings(request.params);
        if (request.method == "settings_get")
            return get_settings(request.params);
        if (request.method == "settings_apply")
            return apply_settings(request.params);
        if (request.method == "slice_start")
            return start_slice(request.params);
        if (request.method == "gcode_export")
            return start_gcode_export(request.params);
        if (request.method == "project_save")
            return start_project_save(request.params);
        if (request.method == "job_get")
            return get_job(request.params);
        throw AgentError(ErrorCode::UnknownMethod, "Unknown bridge method",
                         {{"method", request.method}});
    }();
    record_native_state();
    return result;
}

void AgentController::synchronize_native_state(std::uint64_t revision_before_refresh)
{
    const std::string fingerprint = m_facade->state_fingerprint();
    const std::string configuration = m_facade->configuration_fingerprint();
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_native_fingerprint.empty()) {
        m_native_fingerprint = fingerprint;
        m_native_configuration_fingerprint = configuration;
        return;
    }
    const bool scene_changed = fingerprint != m_native_fingerprint;
    const bool configuration_changed =
        configuration != m_native_configuration_fingerprint;
    if (!scene_changed && !configuration_changed)
        return;
    const auto attributed_job = std::find_if(
        m_jobs.begin(), m_jobs.end(), [](const auto& entry) {
            return (entry.second.type == "arrange" ||
                    entry.second.type == "auto_orient") &&
                entry.second.facade_managed && !is_terminal(entry.second.state);
        });
    if (attributed_job != m_jobs.end() && scene_changed && !configuration_changed) {
        const FacadeJobState native = attributed_job->second.type == "arrange" ?
            m_facade->arrange_state() : m_facade->auto_orient_state();
        const std::string attributed_fingerprint =
            native.complete && native.result.is_object() ?
                native.result.value("scene_fingerprint", std::string()) : std::string();
        if (!attributed_fingerprint.empty() && attributed_fingerprint == fingerprint) {
            m_native_fingerprint = fingerprint;
            return;
        }
    }
    if (m_project_id && m_revision == revision_before_refresh) {
        ++m_revision;
        for (auto& [id, job] : m_jobs) {
            (void) id;
            if (!is_terminal(job.state)) {
                nlohmann::json invalidation = {
                    {"code", ErrorCode::RevisionConflict},
                    {"message", "Native GUI state changed outside the agent"},
                    {"details", {{"revision", m_revision}}}
                };
                if (job.facade_managed) {
                    job.invalidated = true;
                    job.invalidation_error = std::move(invalidation);
                } else {
                    job.state = JobState::Failed;
                    job.result = nullptr;
                    job.error = std::move(invalidation);
                }
            }
        }
    }
    m_native_fingerprint = fingerprint;
    m_native_configuration_fingerprint = configuration;
}

void AgentController::record_native_state()
{
    const std::string fingerprint = m_facade->state_fingerprint();
    const std::string configuration = m_facade->configuration_fingerprint();
    std::lock_guard<std::mutex> lock(m_mutex);
    const bool attributed_job_running = std::any_of(
        m_jobs.begin(), m_jobs.end(), [](const auto& entry) {
            return (entry.second.type == "arrange" ||
                    entry.second.type == "auto_orient") &&
                entry.second.facade_managed && !is_terminal(entry.second.state);
        });
    if (attributed_job_running)
        return;
    m_native_fingerprint = fingerprint;
    m_native_configuration_fingerprint = configuration;
}

void AgentController::refresh_jobs()
{
    std::lock_guard<std::mutex> lock(m_mutex);
    for (auto& [id, job] : m_jobs) {
        if (is_terminal(job.state) || !job.facade_managed)
            continue;
        capture_staging_identity(job);
        FacadeJobState native;
        if (job.type == "arrange")
            native = m_facade->arrange_state();
        else if (job.type == "auto_orient")
            native = m_facade->auto_orient_state();
        else if (job.type == "model_import")
            native = m_facade->model_import_state(
                !job.invalidated && m_project_id &&
                job.project_id == *m_project_id && job.source_revision == m_revision &&
                (!job.request_abandoned ||
                 !job.request_abandoned->load(std::memory_order_acquire)));
        else if (job.type == "slice")
            native = m_facade->slice_state();
        else if (job.type == "gcode_export")
            native = m_facade->gcode_export_state();
        else if (job.type == "project_save")
            native = m_facade->project_save_state();
        else
            continue;
        if (job.type == "project_save" && native.metadata.is_object()) {
            try {
                job.metadata["config_snapshot"] =
                    job_config_snapshot(native.metadata, job.source_revision);
            } catch (const AgentError& error) {
                native.complete = true;
                native.failed = true;
                native.cancelled = false;
                native.result = nullptr;
                native.error = {{"code", error.code()},
                                {"message", error.what()},
                                {"details", error.details()}};
            }
        }
        job.progress = std::clamp(native.progress, job.progress, 1.0);
        job.warnings = native.warnings;
        if (!native.complete)
            continue;
        if (job.invalidated) {
            job.state = JobState::Failed;
            job.result = nullptr;
            job.error = job.invalidation_error;
        } else if (native.cancelled) {
            job.state = JobState::Cancelled;
            job.result = nullptr;
            job.error = nullptr;
        } else if (native.failed) {
            job.state = JobState::Failed;
            job.result = nullptr;
            job.error = structured_job_error(job, native.error);
        } else {
            job.progress = 1.0;
            job.result = native.result;
            if (job.type == "auto_orient" && job.result.is_object())
                job.result.erase("scene_fingerprint");
            if (job.type == "arrange" || job.type == "auto_orient" ||
                job.type == "model_import")
                ++m_revision;
            if (job.type == "model_import") {
                job.result["project_id"] = job.project_id;
                job.result["revision"] = m_revision;
            }
            if (job.type == "gcode_export" || job.type == "project_save")
                finish_artifact(job, std::move(native));
            else
                job.state = JobState::Succeeded;
            if (job.state == JobState::Succeeded)
                job.error = nullptr;
            if (job.type == "slice")
                job.result = {{"plate_index", job.metadata.at("plate_index")},
                              {"sliced", true}};
        }
        if (is_terminal(job.state) && !job.staging_path.empty() &&
            job.state != JobState::Succeeded)
            cleanup_staging(job);
        if (is_terminal(job.state))
            job.import_snapshot.reset();
    }
}

std::string AgentController::create_job(std::string type, bool mutating)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (mutating) {
        const auto active = std::find_if(m_jobs.begin(), m_jobs.end(), [](const auto& entry) {
            return entry.second.mutating && !is_terminal(entry.second.state);
        });
        if (active != m_jobs.end())
            throw AgentError(ErrorCode::MutationInProgress, "Another mutating job is active",
                             {{"job_id", active->second.id}});
    }
    const std::string id = make_opaque_id("job");
    Job job;
    job.id = id;
    job.type = std::move(type);
    job.mutating = mutating;
    m_jobs.emplace(id, std::move(job));
    return id;
}

bool AgentController::update_job(const std::string& id, JobState state, double progress,
                                 nlohmann::json result, nlohmann::json error)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    const auto it = m_jobs.find(id);
    if (it == m_jobs.end())
        return false;
    if (!std::isfinite(progress))
        throw AgentError(ErrorCode::InvalidJobTransition, "Job progress must be finite",
                         {{"job_id", id}});
    if (!valid_transition(it->second.state, state))
        throw AgentError(ErrorCode::InvalidJobTransition, "Invalid job state transition",
                         {{"job_id", id},
                          {"from", job_state_name(it->second.state)},
                          {"to", job_state_name(state)}});
    const double bounded_progress = std::clamp(progress, 0.0, 1.0);
    if (bounded_progress < it->second.progress)
        throw AgentError(ErrorCode::InvalidJobTransition, "Job progress cannot decrease",
                         {{"job_id", id},
                          {"current_progress", it->second.progress},
                          {"requested_progress", bounded_progress}});
    it->second.state = state;
    it->second.progress = bounded_progress;
    it->second.result = std::move(result);
    it->second.error = std::move(error);
    return true;
}

bool AgentController::is_terminal(JobState state)
{
    return state == JobState::Succeeded || state == JobState::Failed || state == JobState::Cancelled;
}

bool AgentController::valid_transition(JobState from, JobState to)
{
    if (from == to)
        return !is_terminal(from);
    if (from == JobState::Queued)
        return to == JobState::Running || is_terminal(to);
    if (from == JobState::Running)
        return is_terminal(to);
    return false;
}

const Job* AgentController::active_mutating_job() const
{
    const auto active = std::find_if(m_jobs.begin(), m_jobs.end(), [](const auto& entry) {
        return entry.second.mutating && !is_terminal(entry.second.state);
    });
    return active == m_jobs.end() ? nullptr : &active->second;
}

void AgentController::require_no_active_mutation(const char* message) const
{
    if (const Job* active = active_mutating_job(); active != nullptr)
        throw AgentError(ErrorCode::MutationInProgress, message, {{"job_id", active->id}});
}

std::string AgentController::make_opaque_id(std::string_view prefix)
{
    std::array<std::uint8_t, 16> bytes {};
    std::random_device random;
    for (std::uint8_t& byte : bytes)
        byte = static_cast<std::uint8_t>(random());

    bytes[6] = static_cast<std::uint8_t>((bytes[6] & 0x0f) | 0x40);
    bytes[8] = static_cast<std::uint8_t>((bytes[8] & 0x3f) | 0x80);

    std::ostringstream output;
    output << prefix << '_';
    for (std::size_t index = 0; index < bytes.size(); ++index) {
        if (index == 4 || index == 6 || index == 8 || index == 10)
            output << '-';
        output << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(bytes[index]);
    }
    return output.str();
}

const char* AgentController::job_state_name(JobState state)
{
    switch (state) {
    case JobState::Queued: return "queued";
    case JobState::Running: return "running";
    case JobState::Succeeded: return "succeeded";
    case JobState::Failed: return "failed";
    case JobState::Cancelled: return "cancelled";
    }
    return "failed";
}

nlohmann::json AgentController::serialize_job(const Job& job)
{
    return {
        {"job_id", job.id},
        {"type", job.type},
        {"state", job_state_name(job.state)},
        {"progress", job.progress},
        {"result", job.result},
        {"error", job.error},
        {"warnings", job.warnings},
        {"project_id", job.project_id.empty() ? nlohmann::json(nullptr) :
                                                nlohmann::json(job.project_id)},
        {"source_revision", job.project_id.empty() ? nlohmann::json(nullptr) :
                                                     nlohmann::json(job.source_revision)},
        {"metadata", job.metadata}
    };
}

nlohmann::json AgentController::status() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return {
        {"ready", true},
        {"protocol_version", PROTOCOL_VERSION},
        {"project_id", m_project_id ? nlohmann::json(*m_project_id) : nlohmann::json(nullptr)},
        {"revision", m_revision},
        {"job_count", m_jobs.size()},
        {"capabilities", {"project_foundation", "model_import", "scene_inspection",
                          "object_transform", "object_auto_orient", "scene_arrange", "scene_render",
                          "desktop_capture", "preset_control", "settings_control",
                          "job_registry", "slice", "gcode_export", "project_save"}}
    };
}

nlohmann::json AgentController::create_project()
{
    std::lock_guard<std::mutex> lock(m_mutex);
    require_no_active_mutation("Cannot replace the project while a mutating job is active");
    // The native reset is performed first so a failed Orca operation never
    // publishes a project handle or advances the externally visible revision.
    m_facade->create_project();
    m_project_id = make_opaque_id("project");
    ++m_revision;
    return {
        {"project_id", *m_project_id},
        {"revision", m_revision}
    };
}

nlohmann::json AgentController::import_model(const nlohmann::json& params,
                                             std::shared_ptr<TemporaryFile> snapshot,
                                             std::shared_ptr<std::atomic<bool>> request_abandoned)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    require_no_active_mutation("Cannot import a model while a mutating job is active");
    if (!snapshot || snapshot->path().parent_path() != m_import_staging_root ||
        snapshot->path().filename().empty())
        throw AgentError(ErrorCode::InvalidPath,
                         "Model import requires a trusted prepared snapshot");
    const std::string id = make_opaque_id("job");
    Job job;
    job.id = id;
    job.type = "model_import";
    job.state = JobState::Running;
    job.facade_managed = true;
    job.project_id = *m_project_id;
    job.source_revision = m_revision;
    job.metadata = nlohmann::json::object();
    job.import_snapshot = std::move(snapshot);
    job.request_abandoned = std::move(request_abandoned);
    m_jobs.emplace(id, std::move(job));
    try {
        m_facade->start_model_import(m_jobs.at(id).import_snapshot->path());
    } catch (const std::exception& error) {
        Job& failed = m_jobs.at(id);
        failed.state = JobState::Failed;
        failed.error = {{"code", "model_import_failed"},
                        {"message", error.what()}, {"details", nullptr}};
        failed.import_snapshot.reset();
    } catch (...) {
        Job& failed = m_jobs.at(id);
        failed.state = JobState::Failed;
        failed.error = {{"code", "model_import_failed"},
                        {"message", "Native model import startup failed"},
                        {"details", nullptr}};
        failed.import_snapshot.reset();
    }
    return {{"job_id", id}, {"state", job_state_name(m_jobs.at(id).state)}};
}

nlohmann::json AgentController::get_scene(const nlohmann::json& params) const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    nlohmann::json result = m_facade->scene();
    result["project_id"] = *m_project_id;
    result["revision"] = m_revision;
    return result;
}

nlohmann::json AgentController::transform_object(const nlohmann::json& params)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    if (!params.contains("object_id") || !params["object_id"].is_string() ||
        !params.contains("instance_id") || !params["instance_id"].is_string())
        throw AgentError(ErrorCode::InvalidRequest, "object_id and instance_id must be strings");
    if (params.contains("mode") && !params["mode"].is_string())
        throw AgentError(ErrorCode::InvalidRequest, "mode must be a string");
    const std::string mode = params.value("mode", "absolute");
    if (mode != "absolute" && mode != "relative")
        throw AgentError(ErrorCode::InvalidRequest, "mode must be absolute or relative");
    if (params.contains("place_on_bed") && !params["place_on_bed"].is_boolean())
        throw AgentError(ErrorCode::InvalidRequest, "place_on_bed must be a boolean");
    validate_vector(params, "offset_mm", false);
    validate_vector(params, "rotation_deg", false);
    validate_vector(params, "scale", true);
    if (!params.contains("offset_mm") && !params.contains("rotation_deg") &&
        !params.contains("scale") && !params.value("place_on_bed", false))
        throw AgentError(ErrorCode::InvalidRequest, "At least one transform operation is required");

    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    require_no_active_mutation("Cannot transform an object while a mutating job is active");
    m_facade->transform_object(params);
    ++m_revision;
    return {{"project_id", *m_project_id}, {"revision", m_revision}};
}

nlohmann::json AgentController::auto_orient_objects(const nlohmann::json& params)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    if (params.contains("targets")) {
        const nlohmann::json& targets = params.at("targets");
        if (!targets.is_array() || targets.empty() || targets.size() > 1024)
            throw AgentError(ErrorCode::InvalidRequest,
                             "targets must contain between one and 1024 entries");
        std::set<std::pair<std::string, std::string>> unique_targets;
        for (const nlohmann::json& target : targets) {
            if (!target.is_object() || target.size() != 2 ||
                !target.contains("object_id") || !target.at("object_id").is_string() ||
                !target.contains("instance_id") || !target.at("instance_id").is_string())
                throw AgentError(ErrorCode::InvalidRequest,
                                 "Each target must contain object_id and instance_id strings");
            const auto identity = std::make_pair(
                target.at("object_id").get<std::string>(),
                target.at("instance_id").get<std::string>());
            if (!unique_targets.insert(identity).second)
                throw AgentError(ErrorCode::InvalidRequest,
                                 "Auto-orient targets must be unique");
        }
    }

    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    require_no_active_mutation("Another mutating job is active");
    const std::string id = make_opaque_id("job");
    const nlohmann::json native_metadata = m_facade->job_metadata();
    nlohmann::json config_snapshot =
        job_config_snapshot(native_metadata, m_revision);
    m_facade->start_auto_orient(params);
    m_native_fingerprint = m_facade->state_fingerprint();
    Job job;
    job.id = id;
    job.type = "auto_orient";
    job.state = JobState::Running;
    job.facade_managed = true;
    job.project_id = *m_project_id;
    job.source_revision = m_revision;
    job.metadata = {{"config_snapshot", std::move(config_snapshot)}};
    m_jobs.emplace(id, std::move(job));
    return {{"job_id", id}, {"state", job_state_name(m_jobs.at(id).state)}};
}

nlohmann::json AgentController::arrange_scene(const nlohmann::json& params)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    const std::string id = make_opaque_id("job");
    require_no_active_mutation("Another mutating job is active");
    const nlohmann::json native_metadata = m_facade->job_metadata();
    nlohmann::json config_snapshot =
        job_config_snapshot(native_metadata, m_revision);
    m_facade->start_arrange();
    // Arrange startup takes an Orca undo snapshot. Baseline that attributed
    // native change immediately so a long-running arrange is not mistaken for
    // an unrelated GUI mutation on its first poll.
    m_native_fingerprint = m_facade->state_fingerprint();
    Job job;
    job.id = id;
    job.type = "arrange";
    job.state = JobState::Running;
    job.facade_managed = true;
    job.project_id = *m_project_id;
    job.source_revision = m_revision;
    job.metadata = {{"config_snapshot", std::move(config_snapshot)}};
    m_jobs.emplace(id, std::move(job));
    return {{"job_id", id}, {"state", job_state_name(m_jobs.at(id).state)}};
}

nlohmann::json AgentController::render_scene(const nlohmann::json& params)
{
    static const std::set<std::string> allowed_views {
        "iso", "topfront", "left", "right", "top", "bottom", "front", "rear"
    };
    if (!params.contains("views") || !params["views"].is_array() ||
        params["views"].empty() || params["views"].size() > 6)
        throw AgentError(ErrorCode::InvalidRequest, "views must contain between one and six entries");
    for (const auto& view : params["views"]) {
        if (!view.is_string() || allowed_views.count(view.get<std::string>()) == 0)
            throw AgentError(ErrorCode::InvalidRequest, "Unsupported render view", {{"view", view}});
    }
    const auto dimension = [&params](const char* key) {
        if (!params.contains(key))
            return 512u;
        if (!params[key].is_number_unsigned() && !params[key].is_number_integer())
            throw AgentError(ErrorCode::InvalidRequest, std::string(key) + " must be an integer");
        const auto value = params[key].get<std::int64_t>();
        if (value < 64 || value > 2048)
            throw AgentError(ErrorCode::InvalidRequest, std::string(key) + " must be between 64 and 2048");
        return static_cast<unsigned>(value);
    };
    nlohmann::json request = params;
    request["width"] = dimension("width");
    request["height"] = dimension("height");

    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    nlohmann::json result = m_facade->render_scene(request, m_screenshot_root);
    result["project_id"] = *m_project_id;
    result["revision"] = m_revision;
    return result;
}

nlohmann::json AgentController::desktop_capture(const nlohmann::json& params) const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    return {
        {"project_id", *m_project_id},
        {"revision", m_revision},
        {"capture_requested", true},
        {"path", (m_screenshot_root / "desktop-latest.png").string()}
    };
}

nlohmann::json AgentController::list_presets(const nlohmann::json& params) const
{
    validate_scopes(params);
    if (params.contains("compatible_only") && !params.at("compatible_only").is_boolean())
        throw AgentError(ErrorCode::InvalidRequest, "compatible_only must be a boolean");
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    nlohmann::json result = m_facade->presets_list(params);
    result["project_id"] = *m_project_id;
    result["revision"] = m_revision;
    return result;
}

nlohmann::json AgentController::select_presets(const nlohmann::json& params)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    if (!params.contains("selection") || !params.at("selection").is_object())
        throw AgentError(ErrorCode::InvalidRequest, "selection must be an object");
    const auto& selection = params.at("selection");
    if (selection.empty() ||
        (selection.contains("printer") && !selection.at("printer").is_string()) ||
        (selection.contains("process") && !selection.at("process").is_string()))
        throw AgentError(ErrorCode::InvalidRequest, "Invalid preset selection");
    if (selection.contains("filaments")) {
        const auto& filaments = selection.at("filaments");
        if (!filaments.is_array() || filaments.empty() || filaments.size() > 64 ||
            !std::all_of(filaments.begin(), filaments.end(),
                         [](const auto& value) {
                             return value.is_string() &&
                                 !value.template get_ref<const std::string&>().empty();
                         }))
            throw AgentError(ErrorCode::InvalidRequest,
                             "filaments must contain between one and 64 preset names");
    }
    if (params.contains("discard_dirty") && !params.at("discard_dirty").is_boolean())
        throw AgentError(ErrorCode::InvalidRequest, "discard_dirty must be a boolean");
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    require_no_active_mutation("Cannot select presets while a mutating job is active");
    nlohmann::json result = m_facade->presets_select(params);
    const bool changed = result.value("changed", true);
    result.erase("changed");
    if (changed)
        ++m_revision;
    result["project_id"] = *m_project_id;
    result["revision"] = m_revision;
    return result;
}

nlohmann::json AgentController::describe_settings(const nlohmann::json& params) const
{
    validate_scopes(params);
    if (params.contains("query") &&
        (!params.at("query").is_string() || params.at("query").get_ref<const std::string&>().empty() ||
         params.at("query").get_ref<const std::string&>().size() > 256))
        throw AgentError(ErrorCode::InvalidRequest, "query must contain between one and 256 characters");
    if (params.contains("cursor") && !params.at("cursor").is_string())
        throw AgentError(ErrorCode::InvalidRequest, "cursor must be a string");
    if (params.contains("limit") &&
        (!params.at("limit").is_number_integer() || params.at("limit").get<std::int64_t>() < 1 ||
         params.at("limit").get<std::int64_t>() > 200))
        throw AgentError(ErrorCode::InvalidRequest, "limit must be between one and 200");
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    nlohmann::json request = params;
    request["limit"] = params.value("limit", 100);
    nlohmann::json result = m_facade->settings_describe(request);
    result["project_id"] = *m_project_id;
    result["revision"] = m_revision;
    return result;
}

nlohmann::json AgentController::get_settings(const nlohmann::json& params) const
{
    validate_setting_entries(params, "settings", false);
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    nlohmann::json result = m_facade->settings_get(params);
    result["project_id"] = *m_project_id;
    result["revision"] = m_revision;
    return result;
}

nlohmann::json AgentController::apply_settings(const nlohmann::json& params)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    validate_setting_entries(params, "changes", true);
    if (params.contains("dry_run") && !params.at("dry_run").is_boolean())
        throw AgentError(ErrorCode::InvalidRequest, "dry_run must be a boolean");
    const bool dry_run = params.value("dry_run", false);
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    if (!dry_run)
        require_no_active_mutation("Cannot apply settings while a mutating job is active");
    nlohmann::json result = m_facade->settings_apply(params);
    if (!dry_run)
        ++m_revision;
    result["project_id"] = *m_project_id;
    result["revision"] = m_revision;
    result["dry_run"] = dry_run;
    return result;
}

nlohmann::json AgentController::start_slice(const nlohmann::json& params)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    if (!params.contains("plate_index"))
        throw AgentError(ErrorCode::InvalidRequest, "plate_index is required");
    const auto& plate_value = params.at("plate_index");
    const bool unsigned_value = plate_value.is_number_unsigned();
    const bool signed_value = plate_value.is_number_integer() && !unsigned_value &&
                              plate_value.get<std::int64_t>() >= 0;
    if (!unsigned_value && !signed_value)
        throw AgentError(ErrorCode::InvalidRequest, "plate_index must be an unsigned integer");
    const std::uint64_t raw_plate = unsigned_value ?
        plate_value.get<std::uint64_t>() :
        static_cast<std::uint64_t>(plate_value.get<std::int64_t>());
    if (raw_plate > std::numeric_limits<std::size_t>::max())
        throw AgentError(ErrorCode::InvalidRequest, "plate_index is too large");
    const std::optional<std::size_t> plate_index(static_cast<std::size_t>(raw_plate));
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    require_no_active_mutation("Another mutating job is active");
    const std::string id = make_opaque_id("job");
    const nlohmann::json metadata = m_facade->job_metadata();
    nlohmann::json config_snapshot = job_config_snapshot(metadata, m_revision);
    m_facade->start_slice(plate_index);
    Job job;
    job.id = id;
    job.type = "slice";
    job.state = JobState::Running;
    job.facade_managed = true;
    job.project_id = *m_project_id;
    job.source_revision = m_revision;
    job.metadata = {
        {"plate_index", *plate_index},
        {"config_snapshot", std::move(config_snapshot)}
    };
    m_jobs.emplace(id, std::move(job));
    return {{"job_id", id}, {"state", "running"}};
}

nlohmann::json AgentController::start_gcode_export(const nlohmann::json& params)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    if (!params.contains("slice_job_id") || !params.at("slice_job_id").is_string())
        throw AgentError(ErrorCode::InvalidRequest, "slice_job_id must be a string");
    if (params.contains("overwrite") && !params.at("overwrite").is_boolean())
        throw AgentError(ErrorCode::InvalidRequest, "overwrite must be a boolean");
    const auto output = resolve_output_file(params, ".gcode");
    const bool overwrite = params.value("overwrite", false);
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    require_no_active_mutation("Another mutating job is active");
    const auto source = m_jobs.find(params.at("slice_job_id").get<std::string>());
    if (source == m_jobs.end() || source->second.type != "slice" ||
        source->second.state != JobState::Succeeded ||
        source->second.project_id != *m_project_id ||
        source->second.source_revision != m_revision)
        throw AgentError(ErrorCode::InvalidRequest,
                         "slice_job_id must identify a succeeded slice for this project revision");
    const std::string id = make_opaque_id("job");
    Job job;
    job.id = id;
    job.type = "gcode_export";
    job.state = JobState::Running;
    job.facade_managed = true;
    job.project_id = *m_project_id;
    job.source_revision = m_revision;
    job.metadata = {
        {"slice_job_id", params.at("slice_job_id")},
        {"output_path", params.at("output_path")},
        {"config_snapshot", source->second.metadata.at("config_snapshot")}
    };
    job.output_path = output;
    job.staging_path = make_staging_path(output);
    job.overwrite = overwrite;
    try {
        m_facade->start_gcode_export(
            job.staging_path, source->second.metadata.at("plate_index").get<std::size_t>());
    } catch (...) {
        capture_staging_identity(job);
        cleanup_staging(job);
        throw;
    }
    capture_staging_identity(job);
    m_jobs.emplace(id, std::move(job));
    return {{"job_id", id}, {"state", "running"}};
}

nlohmann::json AgentController::start_project_save(const nlohmann::json& params)
{
    if (!params.contains("expected_revision"))
        throw AgentError(ErrorCode::InvalidRequest, "expected_revision is required");
    if (params.contains("overwrite") && !params.at("overwrite").is_boolean())
        throw AgentError(ErrorCode::InvalidRequest, "overwrite must be a boolean");
    const auto output = resolve_output_file(params, ".3mf");
    const bool overwrite = params.value("overwrite", false);
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    require_no_active_mutation("Another mutating job is active");
    const std::string id = make_opaque_id("job");
    Job job;
    job.id = id;
    job.type = "project_save";
    job.state = JobState::Running;
    job.facade_managed = true;
    job.project_id = *m_project_id;
    job.source_revision = m_revision;
    job.metadata = {{"output_path", params.at("output_path")}};
    job.output_path = output;
    job.staging_path = make_staging_path(output);
    job.overwrite = overwrite;
    m_jobs.emplace(id, std::move(job));
    try {
        const nlohmann::json native_metadata = m_facade->job_metadata();
        m_jobs.at(id).metadata["config_snapshot"] =
            job_config_snapshot(native_metadata, m_revision);
    } catch (const AgentError& error) {
        Job& failed = m_jobs.at(id);
        failed.state = JobState::Failed;
        failed.error = {{"code", error.code()},
                        {"message", error.what()},
                        {"details", error.details()}};
        failed.staging_path.clear();
        return {{"job_id", id}, {"state", job_state_name(failed.state)}};
    } catch (const std::exception&) {
        Job& failed = m_jobs.at(id);
        failed.state = JobState::Failed;
        failed.error = {
            {"code", ErrorCode::InternalError},
            {"message", "Project save configuration preparation failed"},
            {"details", nullptr}
        };
        failed.staging_path.clear();
        return {{"job_id", id}, {"state", job_state_name(failed.state)}};
    } catch (...) {
        Job& failed = m_jobs.at(id);
        failed.state = JobState::Failed;
        failed.error = {
            {"code", ErrorCode::InternalError},
            {"message", "Project save configuration preparation failed"},
            {"details", nullptr}
        };
        failed.staging_path.clear();
        return {{"job_id", id}, {"state", job_state_name(failed.state)}};
    }
    try {
        m_facade->start_project_save(m_jobs.at(id).staging_path);
        capture_staging_identity(m_jobs.at(id));
    } catch (const std::exception& error) {
        Job& failed = m_jobs.at(id);
        failed.state = JobState::Failed;
        failed.error = {{"code", "project_save_failed"},
                        {"message", error.what()}, {"details", nullptr}};
    } catch (...) {
        Job& failed = m_jobs.at(id);
        failed.state = JobState::Failed;
        failed.error = {{"code", "project_save_failed"},
                        {"message", "Native project save startup failed"},
                        {"details", nullptr}};
    }
    if (m_jobs.at(id).state == JobState::Failed)
        cleanup_staging(m_jobs.at(id));
    return {{"job_id", id}, {"state", job_state_name(m_jobs.at(id).state)}};
}

nlohmann::json AgentController::get_project(const nlohmann::json& params) const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    require_active_project(params);
    return {
        {"project_id", *m_project_id},
        {"revision", m_revision}
    };
}

nlohmann::json AgentController::get_job(const nlohmann::json& params)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (!params.contains("job_id") || !params["job_id"].is_string())
        throw AgentError(ErrorCode::InvalidRequest, "job_id must be a string");
    const std::string id = params["job_id"].get<std::string>();
    const auto it = m_jobs.find(id);
    if (it == m_jobs.end())
        throw AgentError(ErrorCode::JobNotFound, "Job does not exist", {{"job_id", id}});
    Job& job = it->second;
    nlohmann::json result = serialize_job(job);
    result["revision"] = m_revision;
    return result;
}

std::filesystem::path AgentController::resolve_output_file(
    const nlohmann::json& params, std::string_view extension) const
{
    if (!params.contains("output_path") || !params.at("output_path").is_string())
        throw AgentError(ErrorCode::InvalidRequest, "output_path must be a string");
    const std::string raw = params.at("output_path").get<std::string>();
    if (raw.empty() || raw.size() > 1024 || raw.find('\0') != std::string::npos)
        throw AgentError(ErrorCode::InvalidPath,
                         "output_path must contain between one and 1024 non-NUL bytes");
    if (raw.find('/') != std::string::npos || raw.find('\\') != std::string::npos)
        throw AgentError(ErrorCode::InvalidPath,
                         "output_path must be a root-level filename without separators");
    const std::filesystem::path relative(raw);
    if (relative.is_absolute() || relative.filename().empty())
        throw AgentError(ErrorCode::InvalidPath, "output_path must be a relative file path");
    if (relative.has_parent_path())
        throw AgentError(ErrorCode::InvalidPath,
                         "output_path must be a single root-level filename in protocol v1");
    for (const auto& component : relative)
        if (component == "." || component == ".." || component.empty())
            throw AgentError(ErrorCode::InvalidPath, "output_path contains an unsafe component");
    std::string actual_extension = relative.extension().string();
    if (actual_extension != extension)
        throw AgentError(ErrorCode::InvalidPath, "output_path has the wrong extension",
                         {{"required_extension", extension}});

    std::error_code error;
    const auto root = std::filesystem::canonical(m_output_root, error);
    if (error || !std::filesystem::is_directory(root, error))
        throw AgentError(ErrorCode::InvalidPath, "Output root is not an existing directory");
    std::filesystem::path cursor = root;
    for (auto it = relative.begin(); it != relative.end(); ++it) {
        cursor /= *it;
        const auto status = std::filesystem::symlink_status(cursor, error);
        if (error && error != std::errc::no_such_file_or_directory)
            throw AgentError(ErrorCode::InvalidPath, "Output path cannot be inspected");
        error.clear();
        const bool final = std::next(it) == relative.end();
        if (std::filesystem::is_symlink(status))
            throw AgentError(ErrorCode::InvalidPath, "Output path must not contain symlinks");
        if (!final && !std::filesystem::is_directory(status))
            throw AgentError(ErrorCode::InvalidPath, "Output parent directory does not exist");
        if (final && std::filesystem::exists(status) &&
            !std::filesystem::is_regular_file(status))
            throw AgentError(ErrorCode::InvalidPath, "Existing output is not a regular file");
        if (final && std::filesystem::exists(status) && !params.value("overwrite", false))
            throw AgentError(ErrorCode::InvalidPath, "Output target already exists");
    }
    return root / relative;
}

std::filesystem::path AgentController::make_staging_path(
    const std::filesystem::path& output) const
{
    return m_artifact_staging_root /
        (make_opaque_id("artifact") + output.extension().string());
}

void AgentController::finish_artifact(Job& job, FacadeJobState)
{
    cleanup_staging_temporary(job);
    if (!job.staging_identity) {
        job.staging_path.clear();
        job.staging_temporary_identity.reset();
        job.state = JobState::Failed;
        job.error = {
            {"code", ErrorCode::InvalidPath},
            {"message", "Native output identity was not captured safely"},
            {"details", nullptr}
        };
        return;
    }
    std::uintmax_t published_size = 0;
    try {
        published_size = publish_trusted_artifact(
            m_artifact_staging_root, job.staging_path, m_output_root,
            job.output_path.filename(), job.overwrite, {}, {},
            &*job.staging_identity);
    } catch (const std::exception&) {
        job.staging_path.clear();
        job.staging_identity.reset();
        job.staging_temporary_identity.reset();
        job.state = JobState::Failed;
        job.error = {{"code", ErrorCode::InvalidPath},
                     {"message", job.overwrite ?
                         "Unable to publish output atomically" :
                         "Output target was concurrently created or cannot be published safely"},
                     {"details", nullptr}};
        return;
    }
    job.staging_path.clear();
    job.staging_identity.reset();
    job.staging_temporary_identity.reset();
    job.state = JobState::Succeeded;
    job.result = {{"path", job.output_path.string()}, {"bytes", published_size}};
    if (job.type == "gcode_export")
        job.result["slice_job_id"] = job.metadata.at("slice_job_id");
}

void AgentController::require_active_project(const nlohmann::json& params) const
{
    if (!m_project_id)
        throw AgentError(ErrorCode::ProjectNotFound, "No project is active");
    if (!params.contains("project_id") || !params["project_id"].is_string())
        throw AgentError(ErrorCode::InvalidRequest, "project_id must be a string");

    const std::string requested_id = params["project_id"].get<std::string>();
    if (requested_id != *m_project_id)
        throw AgentError(ErrorCode::ProjectNotFound, "Project does not exist",
                         {{"project_id", requested_id}});
    if (params.contains("expected_revision")) {
        const nlohmann::json& revision = params["expected_revision"];
        if (!revision.is_number_integer() ||
            (revision.is_number_integer() && !revision.is_number_unsigned() &&
             revision.get<std::int64_t>() < 0))
            throw AgentError(ErrorCode::InvalidRequest, "expected_revision must be an unsigned integer");
        const std::uint64_t expected = revision.get<std::uint64_t>();
        if (expected != m_revision)
            throw AgentError(ErrorCode::RevisionConflict, "Project revision does not match",
                             {{"expected_revision", expected}, {"actual_revision", m_revision}});
    }
}

} // namespace Slic3r::GUI::Agent
