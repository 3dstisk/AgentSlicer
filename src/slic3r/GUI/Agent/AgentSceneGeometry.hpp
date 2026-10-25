#pragma once

#include "AgentImportLimits.hpp"
#include "AgentProtocol.hpp"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace Slic3r::GUI::Agent {

struct SceneMesh
{
    std::string id;
    std::vector<float> positions;
    std::vector<std::uint32_t> indices;
};

inline void append_geometry_u32(std::vector<std::uint8_t>& bytes, std::uint32_t value)
{
    for (unsigned shift = 0; shift < 32; shift += 8)
        bytes.push_back(static_cast<std::uint8_t>(value >> shift));
}

// ASGEOM01: 8-byte magic, little-endian uint32 JSON length, reserved uint32,
// padded UTF-8 JSON, then little-endian float32 positions/uint32 indices.
// Buffer offsets in the manifest are relative to the binary section.
inline std::vector<std::uint8_t> encode_scene_geometry(
    nlohmann::json manifest, const std::vector<SceneMesh>& meshes)
{
    static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
    std::vector<std::uint8_t> binary;
    manifest["meshes"] = nlohmann::json::array();
    std::size_t vertices = 0, triangles = 0;
    for (const SceneMesh& mesh : meshes) {
        if (mesh.positions.size() % 3 != 0 || mesh.indices.size() % 3 != 0)
            throw AgentError(ErrorCode::InvalidRequest, "Invalid scene mesh buffer shape");
        const std::size_t count = mesh.positions.size() / 3;
        if (count > MaxImportedVertices - vertices ||
            mesh.indices.size() / 3 > MaxImportedTriangles - triangles)
            throw AgentError(ErrorCode::InvalidRequest, "Scene geometry exceeds import complexity limits");
        vertices += count;
        triangles += mesh.indices.size() / 3;
        const std::size_t position_offset = binary.size();
        for (float value : mesh.positions) {
            if (!std::isfinite(value))
                throw AgentError(ErrorCode::InvalidRequest, "Scene mesh contains a non-finite vertex");
            std::uint32_t bits;
            std::memcpy(&bits, &value, sizeof(bits));
            append_geometry_u32(binary, bits);
        }
        const std::size_t index_offset = binary.size();
        for (std::uint32_t index : mesh.indices) {
            if (index >= count)
                throw AgentError(ErrorCode::InvalidRequest, "Scene mesh index exceeds its vertex buffer");
            append_geometry_u32(binary, index);
        }
        manifest["meshes"].push_back({
            {"mesh_id", mesh.id}, {"vertex_count", count},
            {"index_count", mesh.indices.size()},
            {"positions_byte_offset", position_offset},
            {"indices_byte_offset", index_offset}
        });
    }
    manifest["schema_version"] = 1;
    manifest["units"] = "millimeter";
    manifest["up_axis"] = "Z";
    manifest["handedness"] = "right";
    manifest["matrix_order"] = "column-major";
    manifest["winding"] = "counter-clockwise";
    manifest["binary_byte_length"] = binary.size();
    std::string json = manifest.dump();
    while (json.size() % 4 != 0) json.push_back(' ');
    if (json.size() > MAX_MESSAGE_SIZE || binary.size() > Max3mfEntryBytes - json.size() - 16)
        throw AgentError(ErrorCode::MessageTooLarge, "Scene geometry exceeds its serialization limit");
    std::vector<std::uint8_t> result {'A','S','G','E','O','M','0','1'};
    append_geometry_u32(result, static_cast<std::uint32_t>(json.size()));
    append_geometry_u32(result, 0);
    result.insert(result.end(), json.begin(), json.end());
    result.insert(result.end(), binary.begin(), binary.end());
    return result;
}

} // namespace Slic3r::GUI::Agent
