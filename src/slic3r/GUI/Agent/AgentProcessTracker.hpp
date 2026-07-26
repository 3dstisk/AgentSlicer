#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <utility>

namespace Slic3r::GUI::Agent {

enum class AgentProcessOutcome
{
    Succeeded,
    Failed,
    Cancelled
};

struct AgentProcessSnapshot
{
    bool active {false};
    bool terminal {false};
    bool succeeded {false};
    bool failed {false};
    bool cancelled {false};
    double progress {0.0};
    std::string error;
    std::uint64_t generation {0};
};

class AgentProcessTracker
{
public:
    void begin(std::uint64_t generation)
    {
        m_state = {};
        m_state.active = true;
        m_state.generation = generation;
    }

    void clear() { m_state = {}; }

    bool accepts(std::uint64_t generation) const
    {
        return m_state.active && !m_state.terminal && m_state.generation == generation;
    }

    bool update_progress(std::uint64_t generation, double progress)
    {
        if (!accepts(generation))
            return false;
        m_state.progress = std::max(m_state.progress, std::clamp(progress, 0.0, 1.0));
        return true;
    }

    bool finish(std::uint64_t generation, AgentProcessOutcome outcome, std::string error = {})
    {
        if (!accepts(generation))
            return false;
        m_state.terminal = true;
        m_state.succeeded = outcome == AgentProcessOutcome::Succeeded;
        m_state.failed = outcome == AgentProcessOutcome::Failed;
        m_state.cancelled = outcome == AgentProcessOutcome::Cancelled;
        if (m_state.succeeded)
            m_state.progress = 1.0;
        m_state.error = std::move(error);
        return true;
    }

    const AgentProcessSnapshot& snapshot() const { return m_state; }

private:
    AgentProcessSnapshot m_state;
};

} // namespace Slic3r::GUI::Agent
