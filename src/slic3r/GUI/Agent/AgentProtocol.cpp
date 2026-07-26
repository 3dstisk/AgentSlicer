#include "AgentProtocol.hpp"

#include <algorithm>
#include <limits>

namespace Slic3r::GUI::Agent {

AgentError::AgentError(std::string code, std::string message, nlohmann::json details)
    : std::runtime_error(std::move(message))
    , m_code(std::move(code))
    , m_details(std::move(details))
{
}

Request parse_request(std::string_view payload)
{
    nlohmann::json message;
    try {
        message = nlohmann::json::parse(payload);
    } catch (const nlohmann::json::parse_error& error) {
        throw AgentError(ErrorCode::InvalidJson, "Request is not valid JSON",
                         {{"byte", error.byte}});
    }

    if (!message.is_object())
        throw AgentError(ErrorCode::InvalidRequest, "Request must be a JSON object");
    if (!message.contains("id") || !message["id"].is_string() || message["id"].get_ref<const std::string&>().empty())
        throw AgentError(ErrorCode::InvalidRequest, "Request id must be a non-empty string");
    if (message["id"].get_ref<const std::string&>().size() > MAX_REQUEST_ID_SIZE)
        throw AgentError(ErrorCode::InvalidRequest, "Request id is too long",
                         {{"max_bytes", MAX_REQUEST_ID_SIZE}});
    if (!message.contains("method") || !message["method"].is_string() ||
        message["method"].get_ref<const std::string&>().empty())
        throw AgentError(ErrorCode::InvalidRequest, "Request method must be a non-empty string");
    if (message["method"].get_ref<const std::string&>().size() > MAX_METHOD_SIZE)
        throw AgentError(ErrorCode::InvalidRequest, "Request method is too long",
                         {{"max_bytes", MAX_METHOD_SIZE}});
    if (message.contains("params") && !message["params"].is_object())
        throw AgentError(ErrorCode::InvalidRequest, "Request params must be a JSON object");

    return {
        message["id"].get<std::string>(),
        message["method"].get<std::string>(),
        message.value("params", nlohmann::json::object())
    };
}

nlohmann::json request_id_or_null(std::string_view payload) noexcept
{
    try {
        const nlohmann::json message = nlohmann::json::parse(payload);
        if (message.is_object() && message.contains("id") && message["id"].is_string() &&
            message["id"].get_ref<const std::string&>().size() <= MAX_REQUEST_ID_SIZE)
            return message["id"];
    } catch (...) {
    }
    return nullptr;
}

nlohmann::json success_response(const std::string& id, nlohmann::json result)
{
    return {
        {"id", id},
        {"result", std::move(result)}
    };
}

nlohmann::json error_response(const nlohmann::json& id, const AgentError& error)
{
    return error_response(id, error.code(), error.what(), error.details());
}

nlohmann::json error_response(const nlohmann::json& id, std::string code, std::string message,
                              nlohmann::json details)
{
    nlohmann::json error = {
        {"code", std::move(code)},
        {"message", std::move(message)}
    };
    if (!details.is_null())
        error["details"] = std::move(details);
    return {
        {"id", id},
        {"error", std::move(error)}
    };
}

std::vector<std::uint8_t> encode_frame(std::string_view payload)
{
    if (payload.size() > MAX_MESSAGE_SIZE || payload.size() > std::numeric_limits<std::uint32_t>::max())
        throw AgentError(ErrorCode::MessageTooLarge, "Message exceeds the maximum frame size",
                         {{"max_bytes", MAX_MESSAGE_SIZE}, {"actual_bytes", payload.size()}});

    const auto size = static_cast<std::uint32_t>(payload.size());
    std::vector<std::uint8_t> frame(4 + payload.size());
    frame[0] = static_cast<std::uint8_t>((size >> 24) & 0xff);
    frame[1] = static_cast<std::uint8_t>((size >> 16) & 0xff);
    frame[2] = static_cast<std::uint8_t>((size >> 8) & 0xff);
    frame[3] = static_cast<std::uint8_t>(size & 0xff);
    std::copy(payload.begin(), payload.end(), frame.begin() + 4);
    return frame;
}

std::vector<std::uint8_t> encode_json_frame(const nlohmann::json& message)
{
    const std::string payload = message.dump();
    return encode_frame(std::string_view(payload));
}

FrameDecoder::FrameDecoder(std::size_t max_message_size)
    : m_max_message_size(max_message_size)
{
    if (m_max_message_size == 0 || m_max_message_size > std::numeric_limits<std::uint32_t>::max())
        throw std::invalid_argument("Frame decoder maximum size is invalid");
}

std::vector<std::string> FrameDecoder::append(const std::uint8_t* data, std::size_t size)
{
    if (size != 0 && data == nullptr)
        throw std::invalid_argument("Frame decoder data is null");
    if (size != 0)
        m_buffer.insert(m_buffer.end(), data, data + size);

    std::vector<std::string> messages;
    std::size_t offset = 0;
    while (m_buffer.size() - offset >= 4) {
        const std::uint32_t payload_size =
            (static_cast<std::uint32_t>(m_buffer[offset]) << 24) |
            (static_cast<std::uint32_t>(m_buffer[offset + 1]) << 16) |
            (static_cast<std::uint32_t>(m_buffer[offset + 2]) << 8) |
            static_cast<std::uint32_t>(m_buffer[offset + 3]);
        if (payload_size > m_max_message_size) {
            reset();
            throw AgentError(ErrorCode::MessageTooLarge, "Message exceeds the maximum frame size",
                             {{"max_bytes", m_max_message_size}, {"actual_bytes", payload_size}});
        }
        if (m_buffer.size() - offset - 4 < payload_size)
            break;

        const auto begin = m_buffer.begin() + static_cast<std::ptrdiff_t>(offset + 4);
        messages.emplace_back(begin, begin + payload_size);
        offset += 4 + payload_size;
    }

    if (offset != 0)
        m_buffer.erase(m_buffer.begin(), m_buffer.begin() + static_cast<std::ptrdiff_t>(offset));
    return messages;
}

std::vector<std::string> FrameDecoder::append(std::string_view data)
{
    return append(reinterpret_cast<const std::uint8_t*>(data.data()), data.size());
}

void FrameDecoder::reset()
{
    m_buffer.clear();
}

} // namespace Slic3r::GUI::Agent
