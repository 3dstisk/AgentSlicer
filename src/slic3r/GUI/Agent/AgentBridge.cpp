#include "AgentBridge.hpp"

#if defined(__linux__)
#include <boost/asio.hpp>
#include <boost/asio/local/stream_protocol.hpp>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#endif

#include <array>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <future>
#include <mutex>
#include <system_error>
#include <vector>

namespace Slic3r::GUI::Agent {

#if defined(__linux__)
namespace {

using LocalProtocol = boost::asio::local::stream_protocol;

struct SocketIdentity
{
    struct Guard
    {
        ~Guard()
        {
            if (descriptor >= 0)
                ::close(descriptor);
        }

        int descriptor {-1};
    };

    dev_t device {};
    ino_t inode {};
    uid_t owner {};
    std::shared_ptr<Guard> generation_guard;
    bool valid {false};
};

bool socket_identity(const std::string& path, SocketIdentity& identity)
{
    struct stat info {};
    if (::lstat(path.c_str(), &info) != 0)
        return false;
    auto guard = std::make_shared<SocketIdentity::Guard>();
    guard->descriptor =
        ::open(path.c_str(), O_PATH | O_CLOEXEC | O_NOFOLLOW);
    struct stat guarded_info {};
    if (guard->descriptor < 0 ||
        ::fstat(guard->descriptor, &guarded_info) != 0 ||
        guarded_info.st_dev != info.st_dev ||
        guarded_info.st_ino != info.st_ino)
        return false;
    identity = {
        info.st_dev, info.st_ino, info.st_uid, std::move(guard),
        S_ISSOCK(info.st_mode)
    };
    return identity.valid;
}

bool remove_owned_socket(const std::string& path, const SocketIdentity* expected,
                         std::string& error,
                         const std::function<void()>& before_quarantine = {})
{
    struct stat info {};
    if (::lstat(path.c_str(), &info) != 0) {
        const int saved_errno = errno;
        if (saved_errno == ENOENT)
            return true;
        error = "Unable to inspect bridge socket: " +
                std::error_code(saved_errno, std::generic_category()).message();
        return false;
    }
    const SocketIdentity current {
        info.st_dev, info.st_ino, info.st_uid, {},
        S_ISSOCK(info.st_mode)
    };
    if (!current.valid) {
        error = "Refusing to remove a non-socket bridge path";
        return false;
    }
    if (current.owner != ::geteuid()) {
        error = "Refusing to remove a bridge socket owned by another user";
        return false;
    }
    if (expected != nullptr &&
        (current.device != expected->device || current.inode != expected->inode)) {
        error = "Refusing to remove a bridge socket that was replaced";
        return false;
    }
    std::string quarantine_template =
        (std::filesystem::path(path).parent_path() /
         ".agent-socket-cleanup-XXXXXX").string();
    std::vector<char> quarantine_buffer(
        quarantine_template.begin(), quarantine_template.end());
    quarantine_buffer.push_back('\0');
    char* quarantine_directory = ::mkdtemp(quarantine_buffer.data());
    if (quarantine_directory == nullptr) {
        error = "Unable to create bridge socket cleanup quarantine: " +
                std::error_code(errno, std::generic_category()).message();
        return false;
    }
    const std::string quarantined =
        (std::filesystem::path(quarantine_directory) / "socket").string();
    if (before_quarantine)
        before_quarantine();
    if (::rename(path.c_str(), quarantined.c_str()) != 0) {
        const int saved_errno = errno;
        ::rmdir(quarantine_directory);
        error = "Unable to quarantine bridge socket: " +
                std::error_code(saved_errno, std::generic_category()).message();
        return false;
    }
    struct stat quarantined_info {};
    if (::lstat(quarantined.c_str(), &quarantined_info) != 0 ||
        !S_ISSOCK(quarantined_info.st_mode) ||
        quarantined_info.st_uid != ::geteuid() ||
        (expected != nullptr &&
         (quarantined_info.st_dev != expected->device ||
          quarantined_info.st_ino != expected->inode))) {
        const bool restored = ::link(quarantined.c_str(), path.c_str()) == 0;
        if (restored) {
            ::unlink(quarantined.c_str());
            ::rmdir(quarantine_directory);
        }
        error = "Refusing to remove a bridge socket that was replaced";
        return false;
    }
    if (::unlink(quarantined.c_str()) != 0 ||
        ::rmdir(quarantine_directory) != 0) {
        error = "Unable to remove quarantined bridge socket: " +
                std::error_code(errno, std::generic_category()).message();
        return false;
    }
    return true;
}

bool remove_stale_owned_socket(const std::string& path, std::string& error)
{
    struct stat info {};
    if (::lstat(path.c_str(), &info) != 0) {
        const int saved_errno = errno;
        if (saved_errno == ENOENT)
            return true;
        error = "Unable to inspect bridge socket: " +
                std::error_code(saved_errno, std::generic_category()).message();
        return false;
    }

    SocketIdentity identity;
    if (!socket_identity(path, identity)) {
        error = "Refusing to replace a non-socket bridge path";
        return false;
    }
    if (identity.owner != ::geteuid()) {
        error = "Refusing to replace a bridge socket owned by another user";
        return false;
    }

    const int probe = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (probe < 0) {
        error = "Unable to probe existing bridge socket";
        return false;
    }
    sockaddr_un address {};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
    const int connect_result = ::connect(probe, reinterpret_cast<const sockaddr*>(&address), sizeof(address));
    const int connect_errno = errno;
    ::close(probe);

    if (connect_result == 0) {
        error = "Bridge socket is already accepting connections";
        return false;
    }
    if (connect_errno != ECONNREFUSED && connect_errno != ENOENT) {
        error = "Unable to prove existing bridge socket is stale: " +
                std::error_code(connect_errno, std::generic_category()).message();
        return false;
    }
    return remove_owned_socket(path, &identity, error);
}

bool is_retryable(const boost::system::error_code& error)
{
    return error == boost::asio::error::would_block || error == boost::asio::error::try_again;
}

bool read_exact(LocalProtocol::socket& socket, std::uint8_t* output, std::size_t size,
                const std::atomic<bool>& stopping)
{
    std::size_t offset = 0;
    while (offset < size && !stopping.load(std::memory_order_acquire)) {
        boost::system::error_code error;
        const std::size_t count = socket.read_some(boost::asio::buffer(output + offset, size - offset), error);
        if (!error) {
            offset += count;
            continue;
        }
        if (is_retryable(error)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }
        return false;
    }
    return offset == size;
}

bool write_all(LocalProtocol::socket& socket, const std::vector<std::uint8_t>& data,
               const std::atomic<bool>& stopping)
{
    std::size_t offset = 0;
    while (offset < data.size() && !stopping.load(std::memory_order_acquire)) {
        boost::system::error_code error;
        const std::size_t count = socket.write_some(boost::asio::buffer(data.data() + offset, data.size() - offset), error);
        if (!error) {
            offset += count;
            continue;
        }
        if (is_retryable(error)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }
        return false;
    }
    return offset == data.size();
}

bool write_response(LocalProtocol::socket& socket, const nlohmann::json& response,
                    const nlohmann::json& request_id, const std::atomic<bool>& stopping) noexcept
{
    try {
        return write_all(socket, encode_json_frame(response), stopping);
    } catch (...) {
        try {
            const auto fallback = error_response(request_id, ErrorCode::MessageTooLarge,
                                                 "Bridge response exceeds the maximum frame size",
                                                 {{"max_bytes", MAX_MESSAGE_SIZE}});
            return write_all(socket, encode_json_frame(fallback), stopping);
        } catch (...) {
            return false;
        }
    }
}

} // namespace

struct AgentBridge::Impl
{
    boost::asio::io_context       io;
    LocalProtocol::acceptor       acceptor {io};
    std::unique_ptr<LocalProtocol::socket> active_socket;
    std::mutex                    socket_mutex;
    SocketIdentity                bound_socket;
};
#else
struct AgentBridge::Impl {};
#endif

AgentBridge::AgentBridge(std::string socket_path, Scheduler gui_scheduler,
                         std::chrono::milliseconds request_timeout,
                         std::shared_ptr<AgentSlicerFacade> facade,
                         std::string workspace_root,
                         std::string screenshot_root,
                         std::uintmax_t max_import_bytes,
                         std::string output_root,
                         std::string import_staging_root,
                         std::string artifact_staging_root,
                         SocketCleanupHook before_socket_quarantine)
    : m_socket_path(std::move(socket_path))
    , m_gui_scheduler(std::move(gui_scheduler))
    , m_before_socket_quarantine(std::move(before_socket_quarantine))
    , m_request_timeout(request_timeout)
    , m_controller(std::move(facade), std::move(workspace_root), std::move(screenshot_root),
                   max_import_bytes, std::move(output_root), std::move(import_staging_root),
                   std::move(artifact_staging_root))
    , m_impl(std::make_unique<Impl>())
{
}

AgentBridge::~AgentBridge()
{
    stop();
}

bool AgentBridge::start(std::string& error)
{
#if !defined(__linux__)
    error = "The native AgentSlicer bridge is supported only on Linux";
    return false;
#else
    if (running())
        return true;
    if (!m_gui_scheduler) {
        error = "GUI scheduler is not configured";
        return false;
    }
    if (m_request_timeout <= std::chrono::milliseconds::zero()) {
        error = "Request timeout must be positive";
        return false;
    }

    const std::filesystem::path path(m_socket_path);
    if (!path.is_absolute() || path.filename().empty()) {
        error = "Bridge socket path must be an absolute file path";
        return false;
    }
    if (m_socket_path.size() >= sizeof(sockaddr_un::sun_path)) {
        error = "Bridge socket path is too long";
        return false;
    }

    struct stat parent_info {};
    if (::lstat(path.parent_path().c_str(), &parent_info) != 0) {
        error = "Bridge socket directory must already exist";
        return false;
    }
    if (!S_ISDIR(parent_info.st_mode) || parent_info.st_uid != ::geteuid() ||
        (parent_info.st_mode & S_IWOTH) != 0) {
        error = "Bridge socket directory must be a non-world-writable directory owned by the current user";
        return false;
    }

    if (!remove_stale_owned_socket(m_socket_path, error))
        return false;

    boost::system::error_code asio_error;
    SocketIdentity created_socket;
    m_impl->acceptor.open(LocalProtocol(), asio_error);
    if (!asio_error)
        m_impl->acceptor.bind(LocalProtocol::endpoint(m_socket_path), asio_error);
    if (!asio_error && (!socket_identity(m_socket_path, created_socket) ||
                        created_socket.owner != ::geteuid())) {
        error = "Unable to identify the bound bridge socket";
        boost::system::error_code ignored;
        m_impl->acceptor.close(ignored);
        return false;
    }
    if (asio_error) {
        error = "Unable to bind bridge socket: " + asio_error.message();
        boost::system::error_code ignored;
        m_impl->acceptor.close(ignored);
        std::string ignored_error;
        if (created_socket.valid)
            remove_owned_socket(m_socket_path, &created_socket, ignored_error);
        return false;
    }
    m_impl->bound_socket = created_socket;
    SocketIdentity secured_socket;
    if (!socket_identity(m_socket_path, secured_socket) ||
        secured_socket.device != m_impl->bound_socket.device ||
        secured_socket.inode != m_impl->bound_socket.inode ||
        ::chmod(m_socket_path.c_str(), 0660) != 0) {
        error = "Unable to secure bridge socket";
        boost::system::error_code ignored;
        m_impl->acceptor.close(ignored);
        std::string ignored_error;
        if (m_impl->bound_socket.valid)
            remove_owned_socket(m_socket_path, &m_impl->bound_socket, ignored_error);
        return false;
    }
    m_impl->acceptor.listen(boost::asio::socket_base::max_listen_connections, asio_error);
    if (!asio_error)
        m_impl->acceptor.non_blocking(true, asio_error);
    if (asio_error) {
        error = "Unable to listen on bridge socket: " + asio_error.message();
        boost::system::error_code ignored;
        m_impl->acceptor.close(ignored);
        std::string ignored_error;
        remove_owned_socket(m_socket_path, &m_impl->bound_socket, ignored_error);
        return false;
    }

    m_stop_requested.store(false, std::memory_order_release);
    m_running.store(true, std::memory_order_release);
    try {
        m_io_thread = std::thread([this] { run(); });
    } catch (const std::exception& exception) {
        m_running.store(false, std::memory_order_release);
        error = std::string("Unable to start bridge I/O thread: ") + exception.what();
        boost::system::error_code ignored;
        m_impl->acceptor.close(ignored);
        std::string ignored_error;
        remove_owned_socket(m_socket_path, &m_impl->bound_socket, ignored_error);
        return false;
    }
    return true;
#endif
}

void AgentBridge::stop()
{
    if (!m_running.exchange(false, std::memory_order_acq_rel))
        return;
    m_stop_requested.store(true, std::memory_order_release);
#if defined(__linux__)
    {
        std::lock_guard<std::mutex> lock(m_impl->socket_mutex);
        if (m_impl->active_socket) {
            boost::system::error_code ignored;
            m_impl->active_socket->shutdown(LocalProtocol::socket::shutdown_both, ignored);
            m_impl->active_socket->close(ignored);
        }
    }
    boost::system::error_code ignored;
    m_impl->acceptor.close(ignored);
#endif
    if (m_io_thread.joinable())
        m_io_thread.join();
#if defined(__linux__)
    std::string ignored_error;
    remove_owned_socket(
        m_socket_path, &m_impl->bound_socket, ignored_error,
        m_before_socket_quarantine);
    m_impl->bound_socket.valid = false;
#endif
}

void AgentBridge::run()
{
#if defined(__linux__)
    while (!m_stop_requested.load(std::memory_order_acquire)) {
        auto socket = std::make_unique<LocalProtocol::socket>(m_impl->io);
        boost::system::error_code error;
        m_impl->acceptor.accept(*socket, error);
        if (error) {
            if (is_retryable(error)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                continue;
            }
            break;
        }
        socket->non_blocking(true, error);
        if (error)
            continue;
        {
            std::lock_guard<std::mutex> lock(m_impl->socket_mutex);
            m_impl->active_socket = std::move(socket);
        }

        while (!m_stop_requested.load(std::memory_order_acquire)) {
            std::array<std::uint8_t, 4> header {};
            LocalProtocol::socket* active = nullptr;
            {
                std::lock_guard<std::mutex> lock(m_impl->socket_mutex);
                active = m_impl->active_socket.get();
            }
            if (active == nullptr || !read_exact(*active, header.data(), header.size(), m_stop_requested))
                break;

            const std::uint32_t payload_size =
                (static_cast<std::uint32_t>(header[0]) << 24) |
                (static_cast<std::uint32_t>(header[1]) << 16) |
                (static_cast<std::uint32_t>(header[2]) << 8) |
                static_cast<std::uint32_t>(header[3]);
            if (payload_size > MAX_MESSAGE_SIZE) {
                const auto response = error_response(nullptr, ErrorCode::MessageTooLarge,
                                                     "Message exceeds the maximum frame size",
                                                     {{"max_bytes", MAX_MESSAGE_SIZE},
                                                      {"actual_bytes", payload_size}});
                write_response(*active, response, nullptr, m_stop_requested);
                break;
            }

            std::string payload(payload_size, '\0');
            if (!read_exact(*active, reinterpret_cast<std::uint8_t*>(payload.data()), payload.size(),
                            m_stop_requested))
                break;

            nlohmann::json response;
            std::shared_ptr<std::atomic<bool>> publication_lease;
            nlohmann::json request_id = request_id_or_null(payload);
            try {
                const Request request = parse_request(payload);
                request_id = request.id;
                DispatchResult dispatched = dispatch(request);
                publication_lease = std::move(dispatched.publication_lease);
                response = success_response(request.id, std::move(dispatched.result));
            } catch (const AgentError& agent_error) {
                response = error_response(request_id, agent_error);
            } catch (const std::exception& exception) {
                response = error_response(request_id, ErrorCode::InternalError, exception.what());
            } catch (...) {
                response = error_response(request_id, ErrorCode::InternalError, "Unknown bridge error");
            }
            if (!write_response(*active, response, request_id, m_stop_requested)) {
                if (publication_lease)
                    publication_lease->store(true, std::memory_order_release);
                break;
            }
        }

        {
            std::lock_guard<std::mutex> lock(m_impl->socket_mutex);
            if (m_impl->active_socket) {
                boost::system::error_code ignored;
                m_impl->active_socket->close(ignored);
                m_impl->active_socket.reset();
            }
        }
    }
#endif
}

AgentBridge::DispatchResult AgentBridge::dispatch(const Request& request)
{
    struct Dispatch
    {
        enum class State { Pending, Running, Abandoned };
        std::atomic<State> state {State::Pending};
        std::promise<nlohmann::json> promise;
    };

    const auto deadline = std::chrono::steady_clock::now() + m_request_timeout;
    auto request_abandoned = std::make_shared<std::atomic<bool>>(false);
    const auto preparation_abandoned = [this, deadline, request_abandoned] {
        const bool abandoned =
            m_stop_requested.load(std::memory_order_acquire) ||
            std::chrono::steady_clock::now() >= deadline ||
            !active_connection_alive();
        if (abandoned)
            request_abandoned->store(true, std::memory_order_release);
        return abandoned;
    };
    PreparedRequest prepared {request, nullptr, request_abandoned};
    try {
        prepared = m_controller.prepare(request, request_abandoned,
                                        preparation_abandoned);
    } catch (const AgentError&) {
        if (m_stop_requested.load(std::memory_order_acquire))
            throw AgentError(ErrorCode::ShuttingDown,
                             "AgentSlicer bridge is shutting down");
        throw;
    }
    if (preparation_abandoned()) {
        if (m_stop_requested.load(std::memory_order_acquire))
            throw AgentError(ErrorCode::ShuttingDown,
                             "AgentSlicer bridge is shutting down");
        throw AgentError(ErrorCode::RequestTimeout,
                         "Request expired during import preparation",
                         {{"timeout_ms", m_request_timeout.count()}});
    }
    auto dispatch = std::make_shared<Dispatch>();
    auto future = dispatch->promise.get_future();
    if (m_stop_requested.load(std::memory_order_acquire))
        throw AgentError(ErrorCode::ShuttingDown, "AgentSlicer bridge is shutting down");

    try {
        m_gui_scheduler([this, dispatch, prepared = std::move(prepared)] {
            auto expected = Dispatch::State::Pending;
            if (!dispatch->state.compare_exchange_strong(expected, Dispatch::State::Running,
                                                         std::memory_order_acq_rel))
                return;
            try {
                dispatch->promise.set_value(m_controller.handle_prepared(prepared));
            } catch (...) {
                dispatch->promise.set_exception(std::current_exception());
            }
        });
    } catch (...) {
        dispatch->state.store(Dispatch::State::Abandoned, std::memory_order_release);
        throw;
    }

    for (;;) {
        const auto status = future.wait_for(std::chrono::milliseconds(10));
        const bool shutting_down = m_stop_requested.load(std::memory_order_acquire);
        const bool timed_out = std::chrono::steady_clock::now() >= deadline;
        const bool disconnected = !active_connection_alive();
        if (status == std::future_status::ready && !shutting_down && !timed_out &&
            !disconnected)
            return {future.get(), request_abandoned};
        if (!shutting_down && !timed_out && !disconnected)
            continue;

        auto expected = Dispatch::State::Pending;
        if (dispatch->state.compare_exchange_strong(expected, Dispatch::State::Abandoned,
                                                    std::memory_order_acq_rel)) {
            if (shutting_down)
                throw AgentError(ErrorCode::ShuttingDown, "AgentSlicer bridge is shutting down");
            if (disconnected)
                throw AgentError(ErrorCode::RequestTimeout,
                                 "Client disconnected before GUI dispatch");
            throw AgentError(ErrorCode::RequestTimeout, "Timed out waiting for the Orca GUI thread",
                             {{"timeout_ms", m_request_timeout.count()}});
        }

        if (expected == Dispatch::State::Running) {
            request_abandoned->store(true, std::memory_order_release);
            if (shutting_down)
                throw AgentError(ErrorCode::ShuttingDown, "AgentSlicer bridge is shutting down");
            if (disconnected)
                throw AgentError(ErrorCode::RequestTimeout,
                                 "Client disconnected while executing a request");
            throw AgentError(ErrorCode::RequestTimeout,
                             "Timed out while executing a request on the Orca GUI thread",
                             {{"timeout_ms", m_request_timeout.count()}});
        }
    }
}

bool AgentBridge::active_connection_alive()
{
#if defined(__linux__)
    std::lock_guard<std::mutex> lock(m_impl->socket_mutex);
    if (!m_impl->active_socket || !m_impl->active_socket->is_open())
        return false;
    char byte = 0;
    const int result = ::recv(m_impl->active_socket->native_handle(), &byte, 1,
                              MSG_PEEK | MSG_DONTWAIT);
    if (result > 0)
        return true;
    if (result == 0)
        return false;
    return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
#else
    return true;
#endif
}

} // namespace Slic3r::GUI::Agent
