#include "SecureFile.hpp"

#include "AgentProtocol.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <exception>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <limits>
#include <optional>
#include <random>
#include <sstream>
#include <string>
#include <system_error>
#include <sys/stat.h>
#include <utility>

#if !defined(_WIN32)
#include <fcntl.h>
#include <unistd.h>
#else
#include <io.h>
#endif

namespace Slic3r::GUI::Agent {

#if !defined(_WIN32)
class ArtifactIdentityGuard
{
public:
    explicit ArtifactIdentityGuard(int descriptor)
        : m_descriptor(::fcntl(descriptor, F_DUPFD_CLOEXEC, 0))
    {
        if (m_descriptor < 0)
            throw std::system_error(
                errno, std::generic_category(), "duplicate artifact identity");
    }

    ~ArtifactIdentityGuard() { ::close(m_descriptor); }

    ArtifactIdentityGuard(const ArtifactIdentityGuard&) = delete;
    ArtifactIdentityGuard& operator=(const ArtifactIdentityGuard&) = delete;

private:
    int m_descriptor;
};
#endif

namespace {

constexpr std::size_t CopyBufferSize = 64u * 1024u;

[[noreturn]] void invalid_path(const char* message)
{
    throw AgentError(ErrorCode::InvalidPath, message);
}

std::string lowercase_extension(const std::filesystem::path& path)
{
    std::string extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    return extension;
}

std::filesystem::path safe_relative_path(const std::filesystem::path& workspace_root,
                                         std::string_view requested_path)
{
    if (requested_path.empty() || requested_path.find('\0') != std::string_view::npos)
        invalid_path("Import path must be a non-empty path without NUL bytes");

    std::filesystem::path path(requested_path);
    if (path.is_absolute()) {
        const auto normalized_root = workspace_root.lexically_normal();
        path = path.lexically_normal().lexically_relative(normalized_root);
    }
    if (path.empty() || path.is_absolute())
        invalid_path("Import path escapes the workspace root");
    for (const auto& component : path) {
        if (component.empty() || component == "." || component == "..")
            invalid_path("Import path contains an unsafe component");
    }

    const std::string extension = lowercase_extension(path);
    if (extension != ".stl" && extension != ".obj" && extension != ".3mf")
        throw AgentError(ErrorCode::UnsupportedFormat,
                         "Only STL, OBJ, and 3MF imports are supported");
    return path;
}

std::string random_token()
{
    std::array<std::uint8_t, 24> bytes {};
    std::random_device random;
    for (auto& byte : bytes)
        byte = static_cast<std::uint8_t>(random());
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (const auto byte : bytes)
        output << std::setw(2) << static_cast<unsigned>(byte);
    return output.str();
}

#if !defined(_WIN32)
class FileDescriptor
{
public:
    explicit FileDescriptor(int value = -1) : m_value(value) {}
    ~FileDescriptor()
    {
        if (m_value >= 0)
            ::close(m_value);
    }
    FileDescriptor(const FileDescriptor&) = delete;
    FileDescriptor& operator=(const FileDescriptor&) = delete;
    FileDescriptor(FileDescriptor&& other) noexcept : m_value(std::exchange(other.m_value, -1)) {}
    FileDescriptor& operator=(FileDescriptor&& other) noexcept
    {
        if (this != &other) {
            if (m_value >= 0)
                ::close(m_value);
            m_value = std::exchange(other.m_value, -1);
        }
        return *this;
    }
    int get() const noexcept { return m_value; }

private:
    int m_value;
};

FileDescriptor open_workspace_file(const std::filesystem::path& root,
                                   const std::filesystem::path& relative)
{
    FileDescriptor current(::open(root.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (current.get() < 0)
        invalid_path("Workspace root cannot be opened securely");

    auto component = relative.begin();
    const auto end = relative.end();
    while (component != end) {
        const bool final = std::next(component) == end;
        const int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | (final ? 0 : O_DIRECTORY);
        FileDescriptor next(::openat(current.get(), component->c_str(), flags));
        if (next.get() < 0)
            invalid_path("Import path cannot be opened securely");
        current = std::move(next);
        ++component;
    }
    return current;
}

FileDescriptor create_staging_file(const std::filesystem::path& root,
                                   const std::string& filename,
                                   std::filesystem::path& path)
{
    FileDescriptor directory(::open(root.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (directory.get() < 0)
        invalid_path("Import staging directory cannot be opened securely");
    const int descriptor = ::openat(directory.get(), filename.c_str(),
                                    O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (descriptor < 0)
        invalid_path("Import snapshot cannot be created securely");
    path = root / filename;
    return FileDescriptor(descriptor);
}

void write_all(int descriptor, const void* data, std::size_t size)
{
    const auto* cursor = static_cast<const std::uint8_t*>(data);
    while (size > 0) {
        const std::size_t request =
            std::min(size, static_cast<std::size_t>(std::numeric_limits<ssize_t>::max()));
        const ssize_t written = ::write(descriptor, cursor, request);
        if (written < 0) {
            if (errno == EINTR)
                continue;
            throw std::system_error(errno, std::generic_category(), "write");
        }
        if (written == 0)
            throw std::runtime_error("write returned zero bytes");
        cursor += static_cast<std::size_t>(written);
        size -= static_cast<std::size_t>(written);
    }
}

bool same_identity(const struct stat& info,
                   const ArtifactFileIdentity& expected) noexcept
{
    return static_cast<std::uint64_t>(info.st_dev) == expected.device &&
        static_cast<std::uint64_t>(info.st_ino) == expected.inode;
}

ArtifactFileIdentity artifact_identity(const struct stat& info, int descriptor)
{
    return {
        static_cast<std::uint64_t>(info.st_dev),
        static_cast<std::uint64_t>(info.st_ino),
        std::make_shared<ArtifactIdentityGuard>(descriptor)
    };
}

void quarantine_and_remove(int directory, const std::string& target,
                           const ArtifactFileIdentity& expected,
                           const std::function<void()>& before_quarantine)
{
    std::string quarantine_name;
    FileDescriptor quarantine;
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        quarantine_name = ".agent-cleanup-" + random_token();
        if (::mkdirat(directory, quarantine_name.c_str(), 0700) == 0) {
            quarantine = FileDescriptor(
                ::openat(directory, quarantine_name.c_str(),
                         O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
            if (quarantine.get() < 0)
                invalid_path("Artifact cleanup quarantine cannot be opened securely");
            break;
        }
        if (errno != EEXIST)
            invalid_path("Artifact cleanup quarantine cannot be created securely");
    }
    if (quarantine.get() < 0)
        invalid_path("Artifact cleanup quarantine cannot be allocated");

    if (before_quarantine)
        before_quarantine();
    if (::renameat(directory, target.c_str(), quarantine.get(), "artifact") != 0) {
        ::unlinkat(directory, quarantine_name.c_str(), AT_REMOVEDIR);
        invalid_path("Artifact cleanup target cannot be quarantined atomically");
    }

    struct stat quarantined {};
    if (::fstatat(quarantine.get(), "artifact", &quarantined,
                  AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(quarantined.st_mode)) {
        throw AgentError(
            ErrorCode::InvalidPath,
            "Artifact cleanup quarantine could not be verified",
            {{"quarantine", quarantine_name}});
    }
    if (!same_identity(quarantined, expected)) {
        const bool restored =
            ::linkat(quarantine.get(), "artifact", directory,
                     target.c_str(), 0) == 0;
        if (restored) {
            if (::unlinkat(quarantine.get(), "artifact", 0) != 0 ||
                ::unlinkat(directory, quarantine_name.c_str(), AT_REMOVEDIR) != 0)
                throw AgentError(
                    ErrorCode::InvalidPath,
                    "Restored replacement cleanup quarantine could not be removed",
                    {{"quarantine", quarantine_name}});
        }
        throw AgentError(
            ErrorCode::InvalidPath,
            "Artifact cleanup encountered a replacement and preserved it",
            {{"restored", restored},
             {"quarantine", restored ? nlohmann::json(nullptr) :
                                        nlohmann::json(quarantine_name)}});
    }
    if (::unlinkat(quarantine.get(), "artifact", 0) != 0)
        throw AgentError(
            ErrorCode::InvalidPath,
            "Owned artifact could not be removed from cleanup quarantine",
            {{"quarantine", quarantine_name}});
    if (::unlinkat(directory, quarantine_name.c_str(), AT_REMOVEDIR) != 0)
        invalid_path("Artifact cleanup quarantine could not be removed");
}
#endif

} // namespace

ArtifactFileIdentity trusted_artifact_identity(
    const std::filesystem::path& path)
{
    if (path.filename().empty())
        invalid_path("Artifact identity path is invalid");
#if !defined(_WIN32)
    FileDescriptor directory(
        ::open(path.parent_path().c_str(),
               O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    FileDescriptor file(
        directory.get() < 0 ? -1 :
        ::openat(directory.get(), path.filename().c_str(),
                 O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
    struct stat info {};
    if (file.get() < 0 || ::fstat(file.get(), &info) != 0 ||
        !S_ISREG(info.st_mode))
        invalid_path("Artifact identity cannot be captured securely");
    return artifact_identity(info, file.get());
#else
    struct _stat64 info {};
    if (::_wstat64(path.c_str(), &info) != 0 ||
        (info.st_mode & _S_IFREG) == 0)
        invalid_path("Artifact identity cannot be captured securely");
    return {static_cast<std::uint64_t>(info.st_dev),
            static_cast<std::uint64_t>(info.st_ino)};
#endif
}

void remove_trusted_artifact(
    const std::filesystem::path& path,
    const ArtifactFileIdentity& expected,
    const std::function<void()>& before_quarantine)
{
    if (path.filename().empty())
        invalid_path("Artifact cleanup path is invalid");
#if !defined(_WIN32)
    FileDescriptor directory(
        ::open(path.parent_path().c_str(),
               O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (directory.get() < 0)
        invalid_path("Artifact cleanup directory cannot be opened securely");
    quarantine_and_remove(directory.get(), path.filename().string(),
                          expected, before_quarantine);
#else
    if (before_quarantine)
        before_quarantine();
    const std::filesystem::path quarantine =
        path.parent_path() / (".agent-cleanup-" + random_token());
    std::error_code error;
    std::filesystem::create_directory(quarantine, error);
    if (error)
        invalid_path("Artifact cleanup quarantine cannot be created securely");
    const std::filesystem::path quarantined = quarantine / "artifact";
    std::filesystem::rename(path, quarantined, error);
    if (error)
        invalid_path("Artifact cleanup target cannot be quarantined atomically");
    const ArtifactFileIdentity actual = trusted_artifact_identity(quarantined);
    if (actual.device != expected.device || actual.inode != expected.inode)
        throw AgentError(
            ErrorCode::InvalidPath,
            "Artifact cleanup encountered a replacement and preserved it",
            {{"quarantine", quarantine.string()}});
    std::filesystem::remove(quarantined, error);
    if (error)
        invalid_path("Owned artifact could not be removed from cleanup quarantine");
    std::filesystem::remove(quarantine, error);
    if (error)
        invalid_path("Artifact cleanup quarantine could not be removed");
#endif
}

TemporaryFile::TemporaryFile(std::filesystem::path path,
                             ArtifactFileIdentity identity)
    : m_path(std::move(path)), m_identity(identity)
{}

TemporaryFile::~TemporaryFile()
{
    remove();
}

TemporaryFile::TemporaryFile(TemporaryFile&& other) noexcept
    : m_path(std::move(other.m_path)), m_identity(other.m_identity)
{
    other.m_path.clear();
    other.m_identity = {};
}

TemporaryFile& TemporaryFile::operator=(TemporaryFile&& other) noexcept
{
    if (this != &other) {
        remove();
        m_path = std::move(other.m_path);
        m_identity = other.m_identity;
        other.m_path.clear();
        other.m_identity = {};
    }
    return *this;
}

void TemporaryFile::remove() noexcept
{
    if (!m_path.empty()) {
        try {
            remove_trusted_artifact(m_path, m_identity);
        } catch (...) {}
        m_path.clear();
        m_identity = {};
    }
}

TemporaryFile snapshot_workspace_import(const std::filesystem::path& workspace_root,
                                        const std::filesystem::path& staging_root,
                                        std::string_view requested_path,
                                        std::uintmax_t max_bytes,
                                        const std::function<bool()>& cancelled)
{
    const auto cancellation_point = [&cancelled] {
        if (cancelled && cancelled())
            throw AgentError(ErrorCode::RequestTimeout,
                             "Import snapshot preparation was abandoned");
    };
    cancellation_point();
    const auto relative = safe_relative_path(workspace_root, requested_path);
    const std::string extension = lowercase_extension(relative);
#if !defined(_WIN32)
    FileDescriptor source = open_workspace_file(workspace_root, relative);
    struct stat info {};
    if (::fstat(source.get(), &info) != 0 || !S_ISREG(info.st_mode))
        invalid_path("Import path is not a regular file");
    if (info.st_size < 0 || static_cast<std::uintmax_t>(info.st_size) > max_bytes)
        throw AgentError(ErrorCode::InvalidPath, "Import file exceeds the configured size limit",
                         {{"bytes", info.st_size}, {"max_bytes", max_bytes}});

    std::filesystem::path snapshot_path;
    const std::string filename = "import-" + random_token() + extension;
    FileDescriptor destination = create_staging_file(staging_root, filename, snapshot_path);
    struct stat destination_info {};
    if (::fstat(destination.get(), &destination_info) != 0 ||
        !S_ISREG(destination_info.st_mode))
        invalid_path("Import snapshot identity cannot be captured securely");
    TemporaryFile cleanup(
        snapshot_path,
        artifact_identity(destination_info, destination.get()));
    std::array<std::uint8_t, CopyBufferSize> buffer {};
    std::uintmax_t total = 0;
    for (;;) {
        cancellation_point();
        const ssize_t count = ::read(source.get(), buffer.data(), buffer.size());
        if (count < 0) {
            if (errno == EINTR)
                continue;
            invalid_path("Import file cannot be read");
        }
        if (count == 0)
            break;
        const auto bytes = static_cast<std::uintmax_t>(count);
        if (bytes > max_bytes - total)
            throw AgentError(ErrorCode::InvalidPath,
                             "Import file exceeds the configured size limit",
                             {{"bytes", total + bytes}, {"max_bytes", max_bytes}});
        try {
            write_all(destination.get(), buffer.data(), static_cast<std::size_t>(count));
        } catch (const std::exception&) {
            invalid_path("Import snapshot cannot be written");
        }
        total += bytes;
        cancellation_point();
    }
    return cleanup;
#else
    const auto source_path = workspace_root / relative;
    std::error_code error;
    if (!std::filesystem::is_regular_file(source_path, error) ||
        std::filesystem::is_symlink(source_path, error))
        invalid_path("Import path is not a regular file");
    std::ifstream source(source_path, std::ios::binary);
    if (!source)
        invalid_path("Import file cannot be read");
    const auto snapshot_path = staging_root / ("import-" + random_token() + extension);
    std::ofstream destination(snapshot_path, std::ios::binary | std::ios::out);
    TemporaryFile cleanup(snapshot_path, trusted_artifact_identity(snapshot_path));
    std::array<char, CopyBufferSize> buffer {};
    std::uintmax_t total = 0;
    while (source) {
        cancellation_point();
        source.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
        const auto count = source.gcount();
        if (count <= 0)
            break;
        const auto bytes = static_cast<std::uintmax_t>(count);
        if (bytes > max_bytes - total)
            throw AgentError(ErrorCode::InvalidPath,
                             "Import file exceeds the configured size limit",
                             {{"bytes", total + bytes}, {"max_bytes", max_bytes}});
        destination.write(buffer.data(), count);
        if (!destination)
            invalid_path("Import snapshot cannot be written");
        total += bytes;
        cancellation_point();
    }
    return cleanup;
#endif
}

std::filesystem::path write_exclusive_file(const std::filesystem::path& path,
                                           const void* data, std::size_t size)
{
#if !defined(_WIN32)
    FileDescriptor descriptor(::open(path.c_str(),
                                     O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
    if (descriptor.get() < 0)
        throw std::system_error(errno, std::generic_category(), "open");
    struct stat created {};
    if (::fstat(descriptor.get(), &created) != 0 || !S_ISREG(created.st_mode))
        invalid_path("Exclusive file identity cannot be captured securely");
    const ArtifactFileIdentity identity =
        artifact_identity(created, descriptor.get());
    try {
        write_all(descriptor.get(), data, size);
    } catch (...) {
        remove_trusted_artifact(path, identity);
        throw;
    }
#else
    std::FILE* file = std::fopen(path.string().c_str(), "wbx");
    if (file == nullptr)
        throw std::system_error(errno, std::generic_category(), "fopen");
    struct _stat64 created {};
    if (::_fstat64(::_fileno(file), &created) != 0 ||
        (created.st_mode & _S_IFREG) == 0) {
        std::fclose(file);
        invalid_path("Exclusive file identity cannot be captured securely");
    }
    const ArtifactFileIdentity identity {
        static_cast<std::uint64_t>(created.st_dev),
        static_cast<std::uint64_t>(created.st_ino)
    };
    const std::size_t written = std::fwrite(data, 1, size, file);
    const int close_result = std::fclose(file);
    if (written != size || close_result != 0) {
        remove_trusted_artifact(path, identity);
        throw std::runtime_error("Unable to write complete file");
    }
#endif
    return path;
}

SecureArtifact write_secure_artifact(
    const std::filesystem::path& directory,
    std::string_view prefix,
    std::string_view extension,
    const void* data, std::size_t size,
    const std::function<void(const std::filesystem::path&)>& after_create)
{
#if !defined(_WIN32)
    FileDescriptor directory_descriptor(
        ::open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (directory_descriptor.get() < 0)
        throw std::system_error(errno, std::generic_category(), "open screenshot directory");
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        const std::string filename =
            std::string(prefix) + random_token() + std::string(extension);
        FileDescriptor descriptor(
            ::openat(directory_descriptor.get(), filename.c_str(),
                     O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
        if (descriptor.get() < 0) {
            if (errno == EEXIST)
                continue;
            throw std::system_error(errno, std::generic_category(), "create screenshot");
        }
        struct stat created {};
        if (::fstat(descriptor.get(), &created) != 0 || !S_ISREG(created.st_mode))
            invalid_path("Screenshot identity cannot be captured securely");
        const ArtifactFileIdentity identity =
            artifact_identity(created, descriptor.get());
        const std::filesystem::path path = directory / filename;
        try {
            if (after_create)
                after_create(path);
            write_all(descriptor.get(), data, size);
        } catch (...) {
            const std::exception_ptr failure = std::current_exception();
            quarantine_and_remove(
                directory_descriptor.get(), filename, identity, {});
            std::rethrow_exception(failure);
        }
        return {path, identity};
    }
#else
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        const auto path = directory /
            (std::string(prefix) + random_token() + std::string(extension));
        std::optional<ArtifactFileIdentity> identity;
        try {
            write_exclusive_file(path, data, size);
            identity = trusted_artifact_identity(path);
            if (after_create)
                after_create(path);
            return {path, *identity};
        } catch (const std::system_error& error) {
            if (identity) {
                remove_trusted_artifact(path, *identity);
                throw;
            }
            if (error.code().value() != EEXIST)
                throw;
        } catch (...) {
            if (identity)
                remove_trusted_artifact(path, *identity);
            throw;
        }
    }
#endif
    throw std::runtime_error("Unable to allocate a unique artifact filename");
}

std::uintmax_t publish_trusted_artifact(const std::filesystem::path& staging_root,
                                        const std::filesystem::path& staging_path,
                                        const std::filesystem::path& output_root,
                                        const std::filesystem::path& output_name,
                                        bool overwrite,
                                        const std::function<void()>& before_verify,
                                        const std::function<void(const std::filesystem::path&)>&
                                            before_temporary_cleanup,
                                        const ArtifactFileIdentity* expected_source)
{
    if (staging_path.parent_path() != staging_root || staging_path.filename().empty() ||
        output_name.has_parent_path() || output_name.filename().empty())
        invalid_path("Artifact publication paths are not confined to their roots");
#if !defined(_WIN32)
    FileDescriptor staging_directory(
        ::open(staging_root.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    FileDescriptor output_directory(
        ::open(output_root.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (staging_directory.get() < 0 || output_directory.get() < 0)
        invalid_path("Artifact directories cannot be opened securely");
    FileDescriptor source(
        ::openat(staging_directory.get(), staging_path.filename().c_str(),
                 O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
    struct stat source_info {};
    if (source.get() < 0 || ::fstat(source.get(), &source_info) != 0 ||
        !S_ISREG(source_info.st_mode) || source_info.st_size <= 0)
        invalid_path("Native operation did not produce a nonempty regular file");
    if (expected_source != nullptr &&
        !same_identity(source_info, *expected_source))
        invalid_path("Native staging artifact identity changed before publication");

    std::string temporary_name;
    FileDescriptor destination;
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        temporary_name = ".agent-publish-" + random_token();
        destination = FileDescriptor(
            ::openat(output_directory.get(), temporary_name.c_str(),
                     O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
        if (destination.get() >= 0)
            break;
        if (errno != EEXIST)
            invalid_path("Artifact publication file cannot be created securely");
    }
    if (destination.get() < 0)
        invalid_path("Artifact publication file cannot be allocated");
    struct stat temporary_info {};
    if (::fstat(destination.get(), &temporary_info) != 0 ||
        !S_ISREG(temporary_info.st_mode))
        invalid_path("Artifact publication identity cannot be captured securely");
    const ArtifactFileIdentity temporary_identity =
        artifact_identity(temporary_info, destination.get());
    const ArtifactFileIdentity source_identity =
        artifact_identity(source_info, source.get());

    bool published_target = false;
    bool staging_removed = false;
    const std::string target = output_name.filename().string();
    struct stat destination_info {};
    try {
        std::array<std::uint8_t, CopyBufferSize> buffer {};
        for (;;) {
            const ssize_t count = ::read(source.get(), buffer.data(), buffer.size());
            if (count < 0) {
                if (errno == EINTR)
                    continue;
                throw std::system_error(errno, std::generic_category(), "read artifact");
            }
            if (count == 0)
                break;
            write_all(destination.get(), buffer.data(), static_cast<std::size_t>(count));
        }
        if (::fchmod(destination.get(), 0644) != 0)
            throw std::system_error(errno, std::generic_category(), "chmod artifact");
        if (::fsync(destination.get()) != 0)
            throw std::system_error(errno, std::generic_category(), "fsync artifact");
        if (::fstat(destination.get(), &destination_info) != 0 ||
            !S_ISREG(destination_info.st_mode) || destination_info.st_size <= 0)
            invalid_path("Copied artifact could not be verified");
        quarantine_and_remove(
            staging_directory.get(), staging_path.filename().string(),
            source_identity, {});
        staging_removed = true;

        if (overwrite) {
            struct stat target_info {};
            errno = 0;
            const int target_result =
                ::fstatat(output_directory.get(), target.c_str(), &target_info,
                          AT_SYMLINK_NOFOLLOW);
            if (target_result == 0 && !S_ISREG(target_info.st_mode))
                invalid_path("Existing output is not a regular file");
            if (target_result != 0 && errno != ENOENT)
                invalid_path("Output target cannot be inspected securely");
            if (::renameat(output_directory.get(), temporary_name.c_str(),
                           output_directory.get(), target.c_str()) != 0)
                throw std::system_error(errno, std::generic_category(), "publish artifact");
            published_target = true;
            temporary_name.clear();
        } else {
            if (::linkat(output_directory.get(), temporary_name.c_str(),
                         output_directory.get(), target.c_str(), 0) != 0)
                throw std::system_error(errno, std::generic_category(), "publish artifact");
            published_target = true;
            if (before_temporary_cleanup)
                before_temporary_cleanup(output_root / temporary_name);
            quarantine_and_remove(
                output_directory.get(), temporary_name, temporary_identity, {});
            temporary_name.clear();
        }
        if (before_verify)
            before_verify();
        if (::fsync(output_directory.get()) != 0)
            throw std::system_error(errno, std::generic_category(), "fsync output directory");

        struct stat published {};
        if (::fstatat(output_directory.get(), target.c_str(), &published,
                      AT_SYMLINK_NOFOLLOW) != 0 ||
            !S_ISREG(published.st_mode) || published.st_size <= 0 ||
            published.st_dev != destination_info.st_dev ||
            published.st_ino != destination_info.st_ino ||
            published.st_size != destination_info.st_size)
            invalid_path("Published artifact could not be verified");
        return static_cast<std::uintmax_t>(published.st_size);
    } catch (...) {
        const std::exception_ptr failure = std::current_exception();
        std::exception_ptr cleanup_failure;
        if (!temporary_name.empty()) {
            try {
                quarantine_and_remove(
                    output_directory.get(), temporary_name,
                    temporary_identity, {});
            } catch (...) {
                cleanup_failure = std::current_exception();
            }
        }
        if (published_target) {
            try {
                quarantine_and_remove(
                    output_directory.get(), target, temporary_identity, {});
            } catch (...) {
                if (!cleanup_failure)
                    cleanup_failure = std::current_exception();
            }
        }
        if (!staging_removed) {
            try {
                remove_trusted_artifact(staging_path, source_identity);
            } catch (...) {
                if (!cleanup_failure)
                    cleanup_failure = std::current_exception();
            }
        }
        if (cleanup_failure)
            std::rethrow_exception(cleanup_failure);
        std::rethrow_exception(failure);
    }
#else
    const auto temporary = output_root / (".agent-publish-" + random_token());
    const ArtifactFileIdentity source_identity =
        trusted_artifact_identity(staging_path);
    if (expected_source != nullptr &&
        (source_identity.device != expected_source->device ||
         source_identity.inode != expected_source->inode))
        invalid_path("Native staging artifact identity changed before publication");
    std::error_code error;
    std::filesystem::copy_file(staging_path, temporary,
                               std::filesystem::copy_options::none, error);
    if (error)
        invalid_path("Artifact publication copy failed");
    const ArtifactFileIdentity temporary_identity =
        trusted_artifact_identity(temporary);
    if (!overwrite && std::filesystem::exists(output_root / output_name, error)) {
        remove_trusted_artifact(temporary, temporary_identity);
        invalid_path("Output target already exists");
    }
    std::filesystem::rename(temporary, output_root / output_name, error);
    if (error)
        invalid_path("Artifact publication failed");
    remove_trusted_artifact(staging_path, source_identity);
    if (before_verify)
        before_verify();
    const ArtifactFileIdentity published_identity =
        trusted_artifact_identity(output_root / output_name);
    if (published_identity.device != temporary_identity.device ||
        published_identity.inode != temporary_identity.inode)
        invalid_path("Published artifact identity changed before verification");
    (void) before_temporary_cleanup;
    return std::filesystem::file_size(output_root / output_name);
#endif
}

} // namespace Slic3r::GUI::Agent
