#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <string_view>

namespace Slic3r::GUI::Agent {

class ArtifactIdentityGuard;

struct ArtifactFileIdentity
{
    std::uint64_t device {0};
    std::uint64_t inode {0};
    // Keeps the POSIX inode allocated so an unlinked replacement cannot reuse
    // the same numeric identity while cleanup is still pending.
    std::shared_ptr<ArtifactIdentityGuard> generation_guard;
};

class TemporaryFile
{
public:
    TemporaryFile() = default;
    TemporaryFile(std::filesystem::path path, ArtifactFileIdentity identity);
    ~TemporaryFile();

    TemporaryFile(const TemporaryFile&) = delete;
    TemporaryFile& operator=(const TemporaryFile&) = delete;
    TemporaryFile(TemporaryFile&& other) noexcept;
    TemporaryFile& operator=(TemporaryFile&& other) noexcept;

    const std::filesystem::path& path() const noexcept { return m_path; }
    const ArtifactFileIdentity& identity() const noexcept { return m_identity; }

private:
    void remove() noexcept;

    std::filesystem::path m_path;
    ArtifactFileIdentity m_identity;
};

struct SecureArtifact
{
    std::filesystem::path path;
    ArtifactFileIdentity identity;
};

ArtifactFileIdentity trusted_artifact_identity(
    const std::filesystem::path& path);

void remove_trusted_artifact(
    const std::filesystem::path& path,
    const ArtifactFileIdentity& expected,
    const std::function<void()>& before_quarantine = {});

TemporaryFile snapshot_workspace_import(const std::filesystem::path& workspace_root,
                                        const std::filesystem::path& staging_root,
                                        std::string_view requested_path,
                                        std::uintmax_t max_bytes,
                                        const std::function<bool()>& cancelled = {});

std::filesystem::path write_exclusive_file(const std::filesystem::path& path,
                                           const void* data, std::size_t size);

SecureArtifact write_secure_artifact(
    const std::filesystem::path& directory,
    std::string_view prefix,
    std::string_view extension,
    const void* data, std::size_t size,
    const std::function<void(const std::filesystem::path&)>& after_create = {});

std::uintmax_t publish_trusted_artifact(const std::filesystem::path& staging_root,
                                        const std::filesystem::path& staging_path,
                                        const std::filesystem::path& output_root,
                                        const std::filesystem::path& output_name,
                                        bool overwrite,
                                        const std::function<void()>& before_verify = {},
                                        const std::function<void(const std::filesystem::path&)>&
                                            before_temporary_cleanup = {},
                                        const ArtifactFileIdentity* expected_source = nullptr);

} // namespace Slic3r::GUI::Agent
