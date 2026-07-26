#pragma once

#include "AgentProtocol.hpp"

#include <cstdint>
#include <cstddef>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>

namespace Slic3r::GUI::Agent {

inline constexpr std::size_t MaxImportedObjects = 256;
inline constexpr std::size_t MaxImportedVolumes = 4096;
inline constexpr std::size_t MaxImportedInstances = 4096;
inline constexpr std::size_t MaxImportedTriangles = 20u * 1000u * 1000u;
inline constexpr std::size_t MaxImportedVertices = 20u * 1000u * 1000u;
inline constexpr std::size_t Max3mfArchiveEntries = 4096;
inline constexpr std::uint64_t Max3mfEntryBytes = 512u * 1024u * 1024u;
inline constexpr std::uint64_t Max3mfTotalBytes = 1024u * 1024u * 1024u;
inline constexpr std::uint64_t Max3mfCompressionRatio = 200;
inline constexpr std::size_t Max3mfEntryPathBytes = 512;

struct ImportArchiveBudget
{
    std::size_t entries {0};
    std::uint64_t uncompressed_bytes {0};
};

struct ImportArchiveEntry
{
    std::string_view path;
    std::uint64_t compressed_bytes {0};
    std::uint64_t uncompressed_bytes {0};
    std::uint64_t local_header_offset {0};
    bool directory {false};
    bool encrypted {false};
    bool supported {true};
};

inline void validate_3mf_archive_path_buffer_size(std::size_t required_bytes)
{
    if (required_bytes == 0 || required_bytes > Max3mfEntryPathBytes + 1)
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive entry path exceeds the size limit");
}

inline void validate_3mf_archive_path(std::string_view path, bool directory)
{
    if (path.empty() || path.size() > Max3mfEntryPathBytes ||
        path.front() == '/' || path.find('\\') != std::string_view::npos ||
        path.find(':') != std::string_view::npos ||
        path.find('\0') != std::string_view::npos)
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive contains an unsafe entry path");
    for (std::size_t begin = 0; begin < path.size();) {
        const std::size_t end = path.find('/', begin);
        const std::string_view segment =
            path.substr(begin, end == std::string_view::npos ?
                                   path.size() - begin : end - begin);
        if (segment.empty() || segment == "." || segment == "..")
            throw AgentError(ErrorCode::InvalidRequest,
                             "3MF archive contains an unsafe entry path");
        if (end == std::string_view::npos)
            break;
        begin = end + 1;
        if (begin == path.size() && !directory)
            throw AgentError(ErrorCode::InvalidRequest,
                             "3MF archive file path ends with a separator");
    }
}

inline void validate_3mf_archive_entry(ImportArchiveBudget& budget,
                                       const ImportArchiveEntry& entry)
{
    if (budget.entries >= Max3mfArchiveEntries)
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive contains too many entries",
                         {{"max_entries", Max3mfArchiveEntries}});
    ++budget.entries;

    validate_3mf_archive_path(entry.path, entry.directory);
    if (entry.encrypted || !entry.supported)
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive contains an encrypted or unsupported entry");
    if (entry.local_header_offset >
        std::numeric_limits<std::uint64_t>::max() - entry.compressed_bytes)
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive entry offsets overflow");
    if (entry.directory)
        return;
    if (entry.compressed_bytes > Max3mfEntryBytes ||
        entry.uncompressed_bytes > Max3mfEntryBytes)
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive entry exceeds the size limit",
                         {{"max_bytes", Max3mfEntryBytes}});
    if (entry.uncompressed_bytes > Max3mfTotalBytes - budget.uncompressed_bytes)
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive exceeds the cumulative size limit",
                         {{"max_bytes", Max3mfTotalBytes}});
    budget.uncompressed_bytes += entry.uncompressed_bytes;
    if (entry.uncompressed_bytes != 0 &&
        (entry.compressed_bytes == 0 ||
         (entry.compressed_bytes <= Max3mfEntryBytes / Max3mfCompressionRatio &&
          entry.uncompressed_bytes >
              entry.compressed_bytes * Max3mfCompressionRatio)))
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive entry exceeds the compression ratio limit",
                         {{"max_ratio", Max3mfCompressionRatio}});
}

class ImportWorkerLease final {};

inline std::shared_ptr<ImportWorkerLease> acquire_import_worker_lease()
{
    static std::mutex lease_mutex;
    static std::weak_ptr<ImportWorkerLease> active_lease;
    std::lock_guard<std::mutex> lock(lease_mutex);
    if (!active_lease.expired())
        throw AgentError(ErrorCode::MutationInProgress,
                         "A model import parser is still active");
    auto lease = std::make_shared<ImportWorkerLease>();
    active_lease = lease;
    return lease;
}

inline void add_import_complexity(std::size_t& total, std::size_t value,
                                  std::size_t limit, const char* name)
{
    if (total > limit || value > limit - total)
        throw AgentError(ErrorCode::InvalidRequest,
                         std::string("Imported model exceeds the ") + name + " limit",
                         {{"limit", limit}});
    total += value;
}

} // namespace Slic3r::GUI::Agent
