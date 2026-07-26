#pragma once

#include "AgentController.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <thread>

namespace Slic3r::GUI::Agent {

class AgentBridge
{
public:
    using Scheduler = std::function<void(std::function<void()>)>;
    using SocketCleanupHook = std::function<void()>;

    AgentBridge(std::string socket_path, Scheduler gui_scheduler,
                std::chrono::milliseconds request_timeout,
                std::shared_ptr<AgentSlicerFacade> facade,
                std::string workspace_root = "/workspace",
                std::string screenshot_root = "/screenshots/mcp",
                std::uintmax_t max_import_bytes = 512u * 1024u * 1024u,
                std::string output_root = "/outputs",
                std::string import_staging_root = "/run/agent-slicer/imports",
                std::string artifact_staging_root = "/run/agent-slicer/artifacts",
                SocketCleanupHook before_socket_quarantine = {});
    ~AgentBridge();

    AgentBridge(const AgentBridge&) = delete;
    AgentBridge& operator=(const AgentBridge&) = delete;

    bool start(std::string& error);
    void stop();
    bool running() const noexcept { return m_running.load(std::memory_order_acquire); }
    const std::string& socket_path() const noexcept { return m_socket_path; }

private:
    struct Impl;
    struct DispatchResult
    {
        nlohmann::json result;
        std::shared_ptr<std::atomic<bool>> publication_lease;
    };

    void run();
    DispatchResult dispatch(const Request& request);
    bool active_connection_alive();

    std::string               m_socket_path;
    Scheduler                  m_gui_scheduler;
    SocketCleanupHook          m_before_socket_quarantine;
    std::chrono::milliseconds m_request_timeout;
    AgentController            m_controller;
    std::unique_ptr<Impl>      m_impl;
    std::thread                m_io_thread;
    std::atomic<bool>          m_running {false};
    std::atomic<bool>          m_stop_requested {false};
};

} // namespace Slic3r::GUI::Agent
