#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace Slic3r::GUI::Agent {

inline constexpr std::size_t MAX_MESSAGE_SIZE = 1024 * 1024;
inline constexpr std::size_t MAX_REQUEST_ID_SIZE = 128;
inline constexpr std::size_t MAX_METHOD_SIZE = 128;
inline constexpr std::uint32_t PROTOCOL_VERSION = 1;

namespace ErrorCode {
inline constexpr const char* InvalidFrame      = "invalid_frame";
inline constexpr const char* MessageTooLarge   = "message_too_large";
inline constexpr const char* InvalidJson       = "invalid_json";
inline constexpr const char* InvalidRequest    = "invalid_request";
inline constexpr const char* UnknownMethod     = "unknown_method";
inline constexpr const char* InternalError     = "internal_error";
inline constexpr const char* RequestTimeout    = "request_timeout";
inline constexpr const char* ShuttingDown      = "shutting_down";
inline constexpr const char* ProjectNotFound   = "project_not_found";
inline constexpr const char* JobNotFound       = "job_not_found";
inline constexpr const char* InvalidJobTransition = "invalid_job_transition";
inline constexpr const char* MutationInProgress = "mutation_in_progress";
inline constexpr const char* RevisionConflict  = "revision_conflict";
inline constexpr const char* InvalidPath       = "invalid_path";
inline constexpr const char* UnsupportedFormat = "unsupported_format";
inline constexpr const char* ObjectNotFound    = "object_not_found";
inline constexpr const char* RenderFailed      = "render_failed";
} // namespace ErrorCode

class AgentError : public std::runtime_error
{
public:
    AgentError(std::string code, std::string message, nlohmann::json details = nullptr);

    const std::string& code() const noexcept { return m_code; }
    const nlohmann::json& details() const noexcept { return m_details; }

private:
    std::string    m_code;
    nlohmann::json m_details;
};

struct Request
{
    std::string    id;
    std::string    method;
    nlohmann::json params = nlohmann::json::object();
};

Request parse_request(std::string_view payload);
nlohmann::json request_id_or_null(std::string_view payload) noexcept;

nlohmann::json success_response(const std::string& id, nlohmann::json result);
nlohmann::json error_response(const nlohmann::json& id, const AgentError& error);
nlohmann::json error_response(const nlohmann::json& id, std::string code, std::string message,
                              nlohmann::json details = nullptr);

std::vector<std::uint8_t> encode_frame(std::string_view payload);
std::vector<std::uint8_t> encode_json_frame(const nlohmann::json& message);

class FrameDecoder
{
public:
    explicit FrameDecoder(std::size_t max_message_size = MAX_MESSAGE_SIZE);

    std::vector<std::string> append(const std::uint8_t* data, std::size_t size);
    std::vector<std::string> append(std::string_view data);
    void reset();

private:
    std::size_t               m_max_message_size;
    std::vector<std::uint8_t> m_buffer;
};

} // namespace Slic3r::GUI::Agent
