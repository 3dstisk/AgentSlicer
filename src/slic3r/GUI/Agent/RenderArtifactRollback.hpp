#pragma once

#include "SecureFile.hpp"

#include <exception>
#include <filesystem>
#include <functional>
#include <utility>
#include <vector>

namespace Slic3r::GUI::Agent {

class RenderArtifactRollback
{
public:
    using BeforeQuarantine =
        std::function<void(const std::filesystem::path&)>;

    explicit RenderArtifactRollback(BeforeQuarantine before_quarantine = {})
        : m_before_quarantine(std::move(before_quarantine))
    {}

    ~RenderArtifactRollback()
    {
        try {
            rollback();
        } catch (...) {}
    }

    void track(SecureArtifact artifact)
    {
        try {
            m_entries.push_back({artifact.path, artifact.identity});
        } catch (...) {
            const std::exception_ptr failure = std::current_exception();
            remove_trusted_artifact(artifact.path, artifact.identity);
            std::rethrow_exception(failure);
        }
    }

    void rollback()
    {
        if (m_resolved)
            return;
        m_resolved = true;
        std::exception_ptr failure;
        for (auto it = m_entries.rbegin(); it != m_entries.rend(); ++it) {
            std::function<void()> before_quarantine;
            if (m_before_quarantine)
                before_quarantine = [this, path = it->path] {
                    m_before_quarantine(path);
                };
            try {
                remove_trusted_artifact(
                    it->path, it->identity, before_quarantine);
            } catch (...) {
                if (!failure)
                    failure = std::current_exception();
            }
        }
        if (failure)
            std::rethrow_exception(failure);
    }

    void commit() noexcept { m_resolved = true; }

private:
    struct Entry
    {
        std::filesystem::path path;
        ArtifactFileIdentity identity;
    };

    std::vector<Entry> m_entries;
    BeforeQuarantine m_before_quarantine;
    bool m_resolved {false};
};

} // namespace Slic3r::GUI::Agent
