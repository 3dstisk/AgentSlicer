#pragma once

#include "AgentProtocol.hpp"
#include "AgentSlicerFacade.hpp"
#include "SecureFile.hpp"

#include <cstdint>
#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace Slic3r::GUI::Agent {

struct PreparedRequest
{
    Request request;
    std::shared_ptr<TemporaryFile> import_snapshot;
    std::shared_ptr<std::atomic<bool>> request_abandoned;
};

enum class JobState
{
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled
};

struct Job
{
    std::string    id;
    std::string    type;
    JobState       state {JobState::Queued};
    double         progress {0.0};
    nlohmann::json result = nullptr;
    nlohmann::json error = nullptr;
    nlohmann::json warnings = nlohmann::json::array();
    nlohmann::json metadata = nullptr;
    std::string    project_id;
    std::uint64_t  source_revision {0};
    std::filesystem::path staging_path;
    std::optional<ArtifactFileIdentity> staging_identity;
    std::optional<ArtifactFileIdentity> staging_temporary_identity;
    std::filesystem::path output_path;
    bool           overwrite {false};
    bool           mutating {true};
    bool           facade_managed {false};
    bool           invalidated {false};
    nlohmann::json invalidation_error = nullptr;
    std::shared_ptr<TemporaryFile> import_snapshot;
    std::shared_ptr<std::atomic<bool>> request_abandoned;
};

class AgentController
{
public:
    explicit AgentController(
        std::shared_ptr<AgentSlicerFacade> facade,
        std::filesystem::path workspace_root = "/workspace",
        std::filesystem::path screenshot_root = "/screenshots/mcp",
        std::uintmax_t max_import_bytes = 512u * 1024u * 1024u,
        std::filesystem::path output_root = "/outputs",
        std::filesystem::path import_staging_root = "/run/agent-slicer/imports",
        std::filesystem::path artifact_staging_root = "/run/agent-slicer/artifacts");
    ~AgentController();

    nlohmann::json handle(const Request& request);
    nlohmann::json handle_prepared(const PreparedRequest& prepared);
    PreparedRequest prepare(
        const Request& request,
        std::shared_ptr<std::atomic<bool>> request_abandoned = nullptr,
        std::function<bool()> cancelled = {}) const;

    std::string create_job(std::string type, bool mutating = true);
    bool update_job(const std::string& id, JobState state, double progress,
                    nlohmann::json result = nullptr, nlohmann::json error = nullptr);

private:
    static std::string make_opaque_id(std::string_view prefix);
    static const char* job_state_name(JobState state);
    static bool is_terminal(JobState state);
    static bool valid_transition(JobState from, JobState to);
    static nlohmann::json serialize_job(const Job& job);
    const Job* active_mutating_job() const;
    void require_no_active_mutation(const char* message) const;
    void refresh_jobs();
    void synchronize_native_state(std::uint64_t revision_before_refresh);
    void record_native_state();

    nlohmann::json status() const;
    nlohmann::json create_project();
    nlohmann::json get_project(const nlohmann::json& params) const;
    nlohmann::json import_model(const nlohmann::json& params,
                                std::shared_ptr<TemporaryFile> snapshot,
                                std::shared_ptr<std::atomic<bool>> request_abandoned);
    nlohmann::json get_scene(const nlohmann::json& params) const;
    nlohmann::json transform_object(const nlohmann::json& params);
    nlohmann::json auto_orient_objects(const nlohmann::json& params);
    nlohmann::json arrange_scene(const nlohmann::json& params);
    nlohmann::json render_scene(const nlohmann::json& params);
    nlohmann::json desktop_capture(const nlohmann::json& params) const;
    nlohmann::json list_presets(const nlohmann::json& params) const;
    nlohmann::json select_presets(const nlohmann::json& params);
    nlohmann::json describe_settings(const nlohmann::json& params) const;
    nlohmann::json get_settings(const nlohmann::json& params) const;
    nlohmann::json apply_settings(const nlohmann::json& params);
    nlohmann::json start_slice(const nlohmann::json& params);
    nlohmann::json start_gcode_export(const nlohmann::json& params);
    nlohmann::json start_project_save(const nlohmann::json& params);
    nlohmann::json get_job(const nlohmann::json& params);
    void require_active_project(const nlohmann::json& params) const;
    std::filesystem::path resolve_output_file(const nlohmann::json& params,
                                              std::string_view extension) const;
    std::filesystem::path make_staging_path(const std::filesystem::path& output) const;
    void finish_artifact(Job& job, FacadeJobState native);

    mutable std::mutex         m_mutex;
    std::shared_ptr<AgentSlicerFacade> m_facade;
    std::filesystem::path      m_workspace_root;
    std::filesystem::path      m_screenshot_root;
    std::filesystem::path      m_output_root;
    std::filesystem::path      m_import_staging_root;
    std::filesystem::path      m_artifact_staging_root;
    std::uintmax_t             m_max_import_bytes;
    std::optional<std::string> m_project_id;
    std::uint64_t              m_revision {0};
    std::string                m_native_fingerprint;
    std::string                m_native_configuration_fingerprint;
    std::map<std::string, Job> m_jobs;
};

} // namespace Slic3r::GUI::Agent
