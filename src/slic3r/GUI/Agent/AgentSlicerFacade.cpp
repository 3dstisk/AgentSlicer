#include "AgentSlicerFacade.hpp"
#include "AgentInstanceTransform.hpp"
#include "AgentPlateUpdateContext.hpp"
#include "AgentSceneGeometry.hpp"
#include "libslic3r/Model.hpp"

#include "AgentProtocol.hpp"
#include "AgentImportLimits.hpp"
#include "AgentSettingValidation.hpp"
#include "AgentToolpathRenderer.hpp"
#include "RenderArtifactRollback.hpp"
#include "SecureFile.hpp"
#include "slic3r/GUI/GLCanvas3D.hpp"
#include "slic3r/GUI/GUI_App.hpp"
#include "slic3r/GUI/GUI_ObjectList.hpp"
#include "slic3r/GUI/Jobs/Worker.hpp"
#include "slic3r/GUI/PartPlate.hpp"
#include "slic3r/GUI/Plater.hpp"
#include "slic3r/Utils/UndoRedo.hpp"
#include "libslic3r/ExtrusionEntity.hpp"
#include "libslic3r/GCode/Thumbnails.hpp"
#include "libslic3r/miniz_extension.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Utils.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <exception>
#include <fstream>
#include <future>
#include <chrono>
#include <mutex>
#include <thread>
#include <iomanip>
#include <limits>
#include <set>
#include <sstream>
#include <string_view>

#include <boost/algorithm/string/case_conv.hpp>
#include <boost/algorithm/string/predicate.hpp>
#include <openssl/sha.h>
#include <wx/thread.h>

namespace Slic3r::GUI::Agent {

namespace {

constexpr double DegreesToRadians = 3.14159265358979323846 / 180.0;
constexpr double RadiansToDegrees = 180.0 / 3.14159265358979323846;
constexpr std::size_t MaxConfigSnapshotBytes = 512u * 1024u;
constexpr std::size_t MaxConfigOverrideEntries = 4096;

class ZipReaderGuard
{
public:
    explicit ZipReaderGuard(const std::string& path)
    {
        mz_zip_zero_struct(&archive);
        opened = open_zip_reader(&archive, path);
    }

    ~ZipReaderGuard()
    {
        if (opened)
            close_zip_reader(&archive);
    }

    ZipReaderGuard(const ZipReaderGuard&) = delete;
    ZipReaderGuard& operator=(const ZipReaderGuard&) = delete;

    mz_zip_archive archive {};
    bool opened {false};
};

void preflight_3mf_archive(const std::string& path)
{
    ZipReaderGuard reader(path);
    if (!reader.opened)
        throw AgentError(ErrorCode::InvalidRequest, "Unable to open the 3MF archive");

    const mz_uint entry_count = mz_zip_reader_get_num_files(&reader.archive);
    if (entry_count > Max3mfArchiveEntries)
        throw AgentError(ErrorCode::InvalidRequest,
                         "3MF archive contains too many entries",
                         {{"entries", entry_count}, {"max_entries", Max3mfArchiveEntries}});

    ImportArchiveBudget budget;
    std::array<char, Max3mfEntryPathBytes + 1> raw_path {};
    std::set<std::string> canonical_paths;
    for (mz_uint index = 0; index < entry_count; ++index) {
        mz_zip_archive_file_stat stat;
        if (!mz_zip_reader_file_stat(&reader.archive, index, &stat))
            throw AgentError(ErrorCode::InvalidRequest,
                             "Unable to inspect a 3MF archive entry");
        const mz_uint required_path_bytes =
            mz_zip_reader_get_filename(&reader.archive, index, nullptr, 0);
        validate_3mf_archive_path_buffer_size(required_path_bytes);
        const mz_uint path_bytes = mz_zip_reader_get_filename(
            &reader.archive, index, raw_path.data(),
            static_cast<mz_uint>(raw_path.size()));
        if (path_bytes != required_path_bytes)
            throw AgentError(ErrorCode::InvalidRequest,
                             "Unable to read a complete 3MF archive entry path");
        const std::string raw(raw_path.data(), path_bytes - 1);
        validate_3mf_archive_path(raw, stat.m_is_directory);
        if (!stat.m_is_utf8 && raw.size() >= sizeof(stat.m_filename))
            throw AgentError(ErrorCode::InvalidRequest,
                             "3MF archive entry path cannot be decoded safely");
        const std::string decoded = stat.m_is_utf8 ?
            raw : decode_archive_entry_path(&reader.archive, stat);
        if (!canonical_paths.insert(boost::algorithm::to_lower_copy(decoded)).second)
            throw AgentError(ErrorCode::InvalidRequest,
                             "3MF archive contains duplicate entry paths");
        validate_3mf_archive_entry(
            budget,
            {decoded, stat.m_comp_size, stat.m_uncomp_size,
             stat.m_local_header_ofs, stat.m_is_directory != 0,
             stat.m_is_encrypted != 0, stat.m_is_supported != 0});
    }
}

void validate_import_complexity(const Model& model)
{
    if (model.objects.size() > MaxImportedObjects)
        throw AgentError(ErrorCode::InvalidRequest, "Imported model has too many objects",
                         {{"objects", model.objects.size()},
                          {"max_objects", MaxImportedObjects}});
    std::size_t volumes = 0;
    std::size_t instances = 0;
    std::size_t triangles = 0;
    std::size_t vertices = 0;
    for (const ModelObject* object : model.objects) {
        add_import_complexity(instances, object->instances.size(),
                              MaxImportedInstances, "instance");
        add_import_complexity(volumes, object->volumes.size(),
                              MaxImportedVolumes, "volume");
        for (const ModelVolume* volume : object->volumes) {
            add_import_complexity(triangles, volume->mesh().facets_count(),
                                  MaxImportedTriangles, "triangle");
            add_import_complexity(vertices, volume->mesh().its.vertices.size(),
                                  MaxImportedVertices, "vertex");
        }
    }
}

std::string sha256_hex(std::string_view value)
{
    std::array<unsigned char, SHA256_DIGEST_LENGTH> digest {};
    SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), digest.data());
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (const unsigned char byte : digest)
        output << std::setw(2) << static_cast<unsigned>(byte);
    return output.str();
}

std::string object_id(const ModelObject& object)
{
    return "object_" + std::to_string(object.id().id);
}

std::string instance_id(const ModelInstance& instance)
{
    return "instance_" + std::to_string(instance.id().id);
}

nlohmann::json vector_json(const Vec3d& value)
{
    return nlohmann::json::array({value.x(), value.y(), value.z()});
}

nlohmann::json bounds_json(const BoundingBoxf3& bounds)
{
    if (!bounds.defined)
        return nullptr;
    return {
        {"min_mm", vector_json(bounds.min)},
        {"max_mm", vector_json(bounds.max)},
        {"size_mm", vector_json(bounds.size())}
    };
}

Camera::ViewAngleType view_type(const std::string& view)
{
    if (view == "iso") return Camera::ViewAngleType::Iso;
    if (view == "topfront") return Camera::ViewAngleType::Top_Front;
    if (view == "left") return Camera::ViewAngleType::Left;
    if (view == "right") return Camera::ViewAngleType::Right;
    if (view == "top") return Camera::ViewAngleType::Top;
    if (view == "bottom") return Camera::ViewAngleType::Bottom;
    if (view == "front") return Camera::ViewAngleType::Front;
    if (view == "rear") return Camera::ViewAngleType::Rear;
    throw AgentError(ErrorCode::InvalidRequest, "Unsupported render view", {{"view", view}});
}

const char* scope_name(Preset::Type type)
{
    if (type == Preset::TYPE_PRINTER) return "printer";
    if (type == Preset::TYPE_PRINT || type == Preset::TYPE_SLA_PRINT) return "process";
    return "filament";
}

std::set<std::string> requested_scopes(const nlohmann::json& request)
{
    if (!request.contains("scopes"))
        return {"printer", "process", "filament"};
    std::set<std::string> result;
    for (const auto& scope : request.at("scopes"))
        result.insert(scope.get<std::string>());
    return result;
}

PresetCollection& process_presets(PresetBundle& bundle)
{
    return bundle.printers.get_edited_preset().printer_technology() == ptFFF ?
        bundle.prints : bundle.sla_prints;
}

const PresetCollection& process_presets(const PresetBundle& bundle)
{
    return process_presets(const_cast<PresetBundle&>(bundle));
}

PresetCollection& filament_presets(PresetBundle& bundle)
{
    return bundle.materials(bundle.printers.get_edited_preset().printer_technology());
}

const PresetCollection& filament_presets(const PresetBundle& bundle)
{
    return filament_presets(const_cast<PresetBundle&>(bundle));
}

nlohmann::json selected_presets(const PresetBundle& bundle)
{
    const std::string printer = bundle.printers.get_selected_preset_name();
    const std::string process = process_presets(bundle).get_selected_preset_name();
    return {
        {"printer", printer.empty() ? nlohmann::json(nullptr) : nlohmann::json(printer)},
        {"process", process.empty() ? nlohmann::json(nullptr) : nlohmann::json(process)},
        {"filaments", bundle.printers.get_edited_preset().printer_technology() == ptFFF ?
            nlohmann::json(bundle.filament_presets) :
            nlohmann::json::array({filament_presets(bundle).get_selected_preset_name()})}
    };
}

void append_presets(nlohmann::json& output, const PresetCollection& collection,
                    const std::string& scope, bool compatible_only,
                    const std::set<std::string>& selected)
{
    for (const Preset& preset : collection.get_presets()) {
        const bool is_selected = selected.count(preset.name) != 0;
        if ((!preset.is_visible && !is_selected) || (compatible_only && !preset.is_compatible && !is_selected))
            continue;
        output.push_back({
            {"scope", scope},
            {"name", preset.name},
            {"selected", is_selected},
            {"compatible", preset.is_compatible}
        });
    }
}

bool presets_are_dirty(const PresetBundle& bundle)
{
    return bundle.printers.current_is_dirty() || bundle.prints.current_is_dirty() ||
        bundle.sla_prints.current_is_dirty() || bundle.filaments.current_is_dirty() ||
        bundle.sla_materials.current_is_dirty();
}

void require_clean_presets(const PresetBundle& bundle)
{
    if (presets_are_dirty(bundle))
        throw AgentError(ErrorCode::InvalidRequest,
                         "Preset selection is unavailable while a preset has unsaved changes");
}

void discard_preset_changes(PresetBundle& bundle)
{
    bundle.printers.discard_current_changes();
    bundle.prints.discard_current_changes();
    bundle.sla_prints.discard_current_changes();
    bundle.filaments.discard_current_changes();
    bundle.sla_materials.discard_current_changes();
}

Preset& select_exact(PresetCollection& collection, const std::string& name, const char* scope)
{
    Preset* preset = collection.find_preset(name, false, true);
    if (preset == nullptr || preset->name != name || !preset->is_visible)
        throw AgentError(ErrorCode::InvalidRequest, "Preset does not exist or is hidden",
                         {{"scope", scope}, {"name", name}});
    if (collection.get_selected_preset_name() == name)
        return collection.get_edited_preset();
    if (!collection.select_preset_by_name(name, false))
        throw AgentError(ErrorCode::InvalidRequest, "Preset could not be selected",
                         {{"scope", scope}, {"name", name}});
    return collection.get_edited_preset();
}

DynamicPrintConfig& config_for_scope(PresetBundle& bundle, const std::string& scope)
{
    if (scope == "printer") return bundle.printers.get_edited_preset().config;
    if (scope == "process") return process_presets(bundle).get_edited_preset().config;
    if (scope == "filament") return filament_presets(bundle).get_edited_preset().config;
    throw AgentError(ErrorCode::InvalidRequest, "Unsupported configuration scope", {{"scope", scope}});
}

const DynamicPrintConfig& config_for_scope(const PresetBundle& bundle, const std::string& scope)
{
    return config_for_scope(const_cast<PresetBundle&>(bundle), scope);
}

size_t filament_index(const nlohmann::json& entry)
{
    return entry.value("filament_index", size_t(0));
}

const Preset& filament_preset_for_index(const PresetBundle& bundle, size_t index)
{
    const bool fff = bundle.printers.get_edited_preset().printer_technology() == ptFFF;
    const size_t count = fff ? bundle.filament_presets.size() : size_t(1);
    if (index >= count)
        throw AgentError(ErrorCode::InvalidRequest, "filament_index exceeds the selected filament slots",
                         {{"filament_index", index}, {"filament_count", count}});
    const std::string name = fff ? bundle.filament_presets[index] :
        filament_presets(bundle).get_selected_preset_name();
    const Preset* preset = filament_presets(bundle).find_preset(name, false);
    if (preset == nullptr)
        throw AgentError(ErrorCode::InvalidRequest, "Selected filament preset no longer exists",
                         {{"filament_index", index}, {"name", name}});
    return *preset;
}

const DynamicPrintConfig& config_for_setting(const PresetBundle& bundle,
                                             const nlohmann::json& entry)
{
    const std::string scope = entry.at("scope").get<std::string>();
    if (scope != "filament")
        return config_for_scope(bundle, scope);
    return filament_preset_for_index(bundle, filament_index(entry)).config;
}

bool starts_with(const std::string& value, const std::string& prefix)
{
    return value.size() >= prefix.size() &&
        std::equal(prefix.begin(), prefix.end(), value.begin());
}

DynamicPrintConfig& editable_filament_config(PresetBundle& bundle, size_t index)
{
    const Preset& source = filament_preset_for_index(bundle, index);
    if (bundle.printers.get_edited_preset().printer_technology() != ptFFF)
        return bundle.sla_materials.get_edited_preset().config;
    const std::string prefix = "AgentSlicer extruder " + std::to_string(index + 1) + " - ";
    if (source.is_project_embedded && starts_with(source.name, prefix)) {
        Preset* existing = bundle.filaments.find_preset(source.name, false, true);
        if (existing == nullptr)
            throw AgentError(ErrorCode::InternalError, "Agent filament override disappeared");
        return existing->config;
    }

    Preset embedded(source);
    std::string name = prefix + source.name;
    for (size_t suffix = 2; bundle.filaments.find_preset(name, false, true) != nullptr; ++suffix)
        name = prefix + source.name + " " + std::to_string(suffix);
    embedded.name = name;
    embedded.is_default = false;
    embedded.is_system = false;
    embedded.is_external = false;
    embedded.is_project_embedded = true;
    embedded.is_dirty = false;
    embedded.vendor = nullptr;
    embedded.file.clear();
    Preset::inherits(embedded.config) = source.name;
    if (auto* ids = embedded.config.option<ConfigOptionStrings>("filament_settings_id", true)) {
        if (ids->values.empty())
            ids->values.emplace_back(name);
        else
            ids->values.front() = name;
    }

    std::vector<Preset*> additions {&embedded};
    try {
        bundle.load_project_embedded_presets(
            additions, ForwardCompatibilitySubstitutionRule::Disable);
    } catch (const std::exception& error) {
        throw AgentError(ErrorCode::InvalidRequest, "Unable to create a per-extruder filament override",
                         {{"filament_index", index}, {"reason", error.what()}});
    }
    Preset* created = bundle.filaments.find_preset(name, false, true);
    if (created == nullptr || !created->is_project_embedded)
        throw AgentError(ErrorCode::InternalError, "Per-extruder filament override was not created");
    bundle.filament_presets[index] = name;
    return created->config;
}

const char* option_type_name(ConfigOptionType type)
{
    switch (type) {
    case coFloat: return "float";
    case coFloats: return "float[]";
    case coInt: return "integer";
    case coInts: return "integer[]";
    case coString: return "string";
    case coStrings: return "string[]";
    case coPercent: return "percent";
    case coPercents: return "percent[]";
    case coFloatOrPercent: return "float_or_percent";
    case coFloatsOrPercents: return "float_or_percent[]";
    case coPoint: return "point2";
    case coPoints: return "point2[]";
    case coPoint3: return "point3";
    case coBool: return "boolean";
    case coBools: return "boolean[]";
    case coEnum: return "enum";
    case coEnums: return "enum[]";
    case coPointsGroups: return "point2[][]";
    case coIntsGroups: return "integer[][]";
    default: return "unsupported";
    }
}

std::string enum_name(const ConfigOptionDef& def, int value)
{
    if (def.enum_keys_map != nullptr) {
        for (const auto& [key, mapped] : *def.enum_keys_map)
            if (mapped == value)
                return key;
    }
    throw AgentError(ErrorCode::InternalError, "Enum value has no declared name",
                     {{"key", def.opt_key}, {"value", value}});
}

template<class Values, class Convert>
nlohmann::json vector_value(const Values& values, Convert convert)
{
    nlohmann::json result = nlohmann::json::array();
    for (size_t index = 0; index < values.size(); ++index)
        result.push_back(convert(values[index], index));
    return result;
}

nlohmann::json option_value(const ConfigOption& option, const ConfigOptionDef& def)
{
    switch (option.type()) {
    case coFloat: return static_cast<const ConfigOptionFloat&>(option).value;
    case coFloats: {
        if (def.nullable) {
            const auto& typed = static_cast<const ConfigOptionFloatsNullable&>(option);
            return vector_value(typed.values, [&](double value, size_t index) {
                return typed.is_nil(index) ? nlohmann::json(nullptr) : nlohmann::json(value);
            });
        }
        return static_cast<const ConfigOptionFloats&>(option).values;
    }
    case coInt: return static_cast<const ConfigOptionInt&>(option).value;
    case coInts: {
        if (def.nullable) {
            const auto& typed = static_cast<const ConfigOptionIntsNullable&>(option);
            return vector_value(typed.values, [&](int value, size_t index) {
                return typed.is_nil(index) ? nlohmann::json(nullptr) : nlohmann::json(value);
            });
        }
        return static_cast<const ConfigOptionInts&>(option).values;
    }
    case coString: return static_cast<const ConfigOptionString&>(option).value;
    case coStrings: return static_cast<const ConfigOptionStrings&>(option).values;
    case coPercent: return static_cast<const ConfigOptionPercent&>(option).value;
    case coPercents: {
        if (def.nullable) {
            const auto& typed = static_cast<const ConfigOptionPercentsNullable&>(option);
            return vector_value(typed.values, [&](double value, size_t index) {
                return typed.is_nil(index) ? nlohmann::json(nullptr) : nlohmann::json(value);
            });
        }
        return static_cast<const ConfigOptionPercents&>(option).values;
    }
    case coFloatOrPercent: {
        const auto& typed = static_cast<const ConfigOptionFloatOrPercent&>(option);
        return {{"value", typed.value}, {"percent", typed.percent}};
    }
    case coFloatsOrPercents: {
        if (def.nullable) {
            const auto& typed = static_cast<const ConfigOptionFloatsOrPercentsNullable&>(option);
            return vector_value(typed.values, [&](const FloatOrPercent& value, size_t index) {
                return typed.is_nil(index) ? nlohmann::json(nullptr) :
                    nlohmann::json{{"value", value.value}, {"percent", value.percent}};
            });
        }
        return vector_value(static_cast<const ConfigOptionFloatsOrPercents&>(option).values,
                            [](const FloatOrPercent& value, size_t) {
                                return nlohmann::json{
                                    {"value", value.value}, {"percent", value.percent}};
                            });
    }
    case coPoint: {
        const Vec2d& value = static_cast<const ConfigOptionPoint&>(option).value;
        return nlohmann::json::array({value.x(), value.y()});
    }
    case coPoints:
        return vector_value(static_cast<const ConfigOptionPoints&>(option).values,
                            [](const Vec2d& value, size_t) {
                                return nlohmann::json::array({value.x(), value.y()});
                            });
    case coPoint3: {
        const Vec3d& value = static_cast<const ConfigOptionPoint3&>(option).value;
        return nlohmann::json::array({value.x(), value.y(), value.z()});
    }
    case coPointsGroups:
        return vector_value(static_cast<const ConfigOptionPointsGroups&>(option).values,
                            [](const Vec2ds& group, size_t) {
                                return vector_value(group, [](const Vec2d& point, size_t) {
                                    return nlohmann::json::array({point.x(), point.y()});
                                });
                            });
    case coIntsGroups:
        return static_cast<const ConfigOptionIntsGroups&>(option).values;
    case coBool: return static_cast<const ConfigOptionBool&>(option).value;
    case coBools: {
        if (def.nullable) {
            const auto& typed = static_cast<const ConfigOptionBoolsNullable&>(option);
            return vector_value(typed.values, [&](unsigned char value, size_t index) {
                return typed.is_nil(index) ? nlohmann::json(nullptr) : nlohmann::json(value != 0);
            });
        }
        return vector_value(static_cast<const ConfigOptionBools&>(option).values,
                            [](unsigned char value, size_t) { return nlohmann::json(value != 0); });
    }
    case coEnum:
        return enum_name(def, static_cast<const ConfigOptionEnumGeneric&>(option).value);
    case coEnums: {
        if (def.nullable) {
            const auto& typed = static_cast<const ConfigOptionEnumsGenericNullable&>(option);
            return vector_value(typed.values, [&](int value, size_t index) {
                return typed.is_nil(index) ? nlohmann::json(nullptr) :
                    nlohmann::json(enum_name(def, value));
            });
        }
        return vector_value(static_cast<const ConfigOptionEnumsGeneric&>(option).values,
                            [&](int value, size_t) { return nlohmann::json(enum_name(def, value)); });
    }
    default:
        throw AgentError(ErrorCode::InvalidRequest, "Setting type is not supported by the agent bridge",
                         {{"key", def.opt_key}, {"type", option_type_name(option.type())}});
    }
}

void validate_number(const ConfigOptionDef& def, const nlohmann::json& value)
{
    if (!value.is_number() || !std::isfinite(value.get<double>()) ||
        !def.is_value_valid(value.get<double>()))
        throw AgentError(ErrorCode::InvalidRequest, "Numeric setting value is outside its valid range",
                         {{"key", def.opt_key}, {"value", value}});
}

FloatOrPercent float_or_percent_value(const ConfigOptionDef& def,
                                      const nlohmann::json& value)
{
    if (!value.is_object() || value.size() != 2 || !value.contains("value") ||
        !value.contains("percent") || !value.at("percent").is_boolean())
        throw AgentError(ErrorCode::InvalidRequest,
                         "Float-or-percent settings require {value, percent}",
                         {{"key", def.opt_key}, {"value", value}});
    validate_number(def, value.at("value"));
    const double number = value.at("value").get<double>();
    const bool percent = value.at("percent").get<bool>();
    if (!percent && number > def.max_literal)
        throw AgentError(ErrorCode::InvalidRequest,
                         "Literal setting value exceeds max_literal",
                         {{"key", def.opt_key}, {"value", number},
                          {"max_literal", def.max_literal}});
    return {number, percent};
}

std::string serialized_typed_value(const ConfigOptionDef& def, const nlohmann::json& value)
{
    const auto serialize_number = [](const nlohmann::json& item) {
        return item.dump();
    };
    const auto serialize_vector = [&](const char* delimiter, auto convert) {
        if (!value.is_array())
            throw AgentError(ErrorCode::InvalidRequest, "Setting requires an array", {{"key", def.opt_key}});
        std::string result;
        for (const auto& item : value) {
            if (!result.empty()) result += delimiter;
            result += convert(item);
        }
        return result;
    };
    switch (def.type) {
    case coFloat:
    case coInt:
    case coPercent:
        validate_number(def, value);
        if (def.type == coInt && !value.is_number_integer())
            throw AgentError(ErrorCode::InvalidRequest, "Setting requires an integer", {{"key", def.opt_key}});
        return serialize_number(value);
    case coFloats:
    case coInts:
    case coPercents:
        return serialize_vector(",", [&](const auto& item) {
            if (item.is_null() && def.nullable) return std::string("nil");
            validate_number(def, item);
            if (def.type == coInts && !item.is_number_integer())
                throw AgentError(ErrorCode::InvalidRequest, "Setting requires integers", {{"key", def.opt_key}});
            return serialize_number(item);
        });
    case coString:
        if (!value.is_string())
            throw AgentError(ErrorCode::InvalidRequest, "Setting requires a string", {{"key", def.opt_key}});
        return escape_string_cstyle(value.get<std::string>());
    case coStrings:
        if (!value.is_array() ||
            !std::all_of(value.begin(), value.end(), [](const auto& item) { return item.is_string(); }))
            throw AgentError(ErrorCode::InvalidRequest, "Setting requires an array of strings",
                             {{"key", def.opt_key}});
        {
            std::vector<std::string> strings;
            for (const auto& item : value) strings.push_back(item.get<std::string>());
            return escape_strings_cstyle(strings);
        }
    case coBool:
        if (!value.is_boolean())
            throw AgentError(ErrorCode::InvalidRequest, "Setting requires a boolean", {{"key", def.opt_key}});
        return value.get<bool>() ? "1" : "0";
    case coBools:
        return serialize_vector(",", [&](const auto& item) {
            if (item.is_null() && def.nullable) return std::string("nil");
            if (!item.is_boolean())
                throw AgentError(ErrorCode::InvalidRequest, "Setting requires booleans", {{"key", def.opt_key}});
            return item.template get<bool>() ? std::string("1") : std::string("0");
        });
    case coEnum:
        if (!value.is_string() || def.enum_keys_map == nullptr ||
            def.enum_keys_map->count(value.get<std::string>()) == 0)
            throw AgentError(ErrorCode::InvalidRequest, "Setting requires a declared enum value",
                             {{"key", def.opt_key}, {"value", value}});
        return value.get<std::string>();
    case coEnums:
        return serialize_vector(",", [&](const auto& item) {
            if (item.is_null() && def.nullable) return std::string("nil");
            if (!item.is_string() || def.enum_keys_map == nullptr ||
                def.enum_keys_map->count(item.template get<std::string>()) == 0)
                throw AgentError(ErrorCode::InvalidRequest, "Setting requires declared enum values",
                                 {{"key", def.opt_key}, {"value", item}});
            return item.template get<std::string>();
        });
    case coPoint:
    case coPoints:
    case coPoint3:
    case coPointsGroups:
    case coIntsGroups:
        throw AgentError(ErrorCode::InvalidRequest,
                         "Setting value does not match its structured type",
                         {{"key", def.opt_key}, {"type", option_type_name(def.type)}});
    case coFloatOrPercent:
    case coFloatsOrPercents:
        throw AgentError(ErrorCode::InvalidRequest,
                         "Setting value does not match its float-or-percent type",
                         {{"key", def.opt_key}});
    default:
        throw AgentError(ErrorCode::InvalidRequest, "Unsupported setting type",
                         {{"key", def.opt_key}, {"type", option_type_name(def.type)}});
    }
}

void apply_setting(DynamicPrintConfig& config, const nlohmann::json& change)
{
    const std::string key = change.at("key").get<std::string>();
    const ConfigOptionDef* def = print_config_def.get(key);
    if (def == nullptr || config.option(key) == nullptr)
        throw AgentError(ErrorCode::InvalidRequest, "Setting is not valid in the requested scope",
                         {{"key", key}, {"scope", change.at("scope")}});
    if (def->readonly)
        throw AgentError(ErrorCode::InvalidRequest, "Setting is read-only", {{"key", key}});
    if (change.at("value").is_null()) {
        if (!def->nullable)
            throw AgentError(ErrorCode::InvalidRequest, "Setting is not nullable", {{"key", key}});
        throw AgentError(ErrorCode::InvalidRequest,
                         "Whole-option null is unsupported; use null vector elements", {{"key", key}});
    }
    const nlohmann::json& value = change.at("value");
    const auto validate_structured = [&](StructuredSettingShape shape) {
        validate_structured_setting(
            value, shape, key, [&](double component) { return def->is_value_valid(component); });
    };
    if (def->type == coFloatOrPercent) {
        const FloatOrPercent typed = float_or_percent_value(*def, value);
        config.set_key_value(key, new ConfigOptionFloatOrPercent(typed.value, typed.percent));
        return;
    }
    if (def->type == coFloatsOrPercents) {
        if (!value.is_array())
            throw AgentError(ErrorCode::InvalidRequest,
                             "Setting requires an array of float-or-percent values",
                             {{"key", key}});
        if (def->nullable) {
            std::vector<FloatOrPercent> values;
            values.reserve(value.size());
            for (const auto& item : value)
                values.push_back(item.is_null() ?
                    ConfigOptionFloatsOrPercentsNullable::nil_value() :
                    float_or_percent_value(*def, item));
            config.set_key_value(
                key, new ConfigOptionFloatsOrPercentsNullable(std::move(values)));
        } else {
            std::vector<FloatOrPercent> values;
            values.reserve(value.size());
            for (const auto& item : value) {
                if (item.is_null())
                    throw AgentError(ErrorCode::InvalidRequest,
                                     "Setting is not nullable", {{"key", key}});
                values.push_back(float_or_percent_value(*def, item));
            }
            config.set_key_value(key, new ConfigOptionFloatsOrPercents(std::move(values)));
        }
        return;
    }
    if (def->type == coPoint) {
        validate_structured(StructuredSettingShape::Point2);
        config.set_key_value(key, new ConfigOptionPoint(Vec2d(value[0].get<double>(), value[1].get<double>())));
        return;
    }
    if (def->type == coPoint3) {
        validate_structured(StructuredSettingShape::Point3);
        config.set_key_value(key, new ConfigOptionPoint3(
            Vec3d(value[0].get<double>(), value[1].get<double>(), value[2].get<double>())));
        return;
    }
    if (def->type == coPoints) {
        validate_structured(StructuredSettingShape::Point2Array);
        std::vector<Vec2d> points;
        for (const auto& point : value)
            points.emplace_back(point[0].get<double>(), point[1].get<double>());
        config.set_key_value(key, new ConfigOptionPoints(std::move(points)));
        return;
    }
    if (def->type == coPointsGroups) {
        validate_structured(StructuredSettingShape::Point2Groups);
        std::vector<Vec2ds> groups;
        groups.reserve(value.size());
        for (const auto& group : value) {
            Vec2ds points;
            points.reserve(group.size());
            for (const auto& point : group)
                points.emplace_back(point[0].get<double>(), point[1].get<double>());
            groups.emplace_back(std::move(points));
        }
        config.set_key_value(key, new ConfigOptionPointsGroups(groups));
        return;
    }
    if (def->type == coIntsGroups) {
        validate_structured(StructuredSettingShape::IntegerGroups);
        std::vector<std::vector<int>> groups;
        for (const auto& group : value) {
            groups.push_back(group.get<std::vector<int>>());
        }
        config.set_key_value(key, new ConfigOptionIntsGroups(groups));
        return;
    }
    try {
        config.set_deserialize_strict(key, serialized_typed_value(*def, change.at("value")));
    } catch (const std::exception& error) {
        throw AgentError(ErrorCode::InvalidRequest, "Setting value could not be parsed",
                         {{"key", key}, {"reason", error.what()}});
    }
}

class OrcaAgentSlicerFacade final : public AgentSlicerFacade
{
public:
    explicit OrcaAgentSlicerFacade(Plater& plater) : m_plater(plater) {}
    ~OrcaAgentSlicerFacade() override
    {
        if (m_import_task) {
            std::lock_guard<std::mutex> lock(m_import_task->mutex);
            m_import_task->abandoned = true;
            m_import_task->model.reset();
        }
    }

    void create_project() override
    {
        assert_gui_thread();
        if (m_plater.new_project(true, true) == wxID_CANCEL)
            throw AgentError(ErrorCode::InternalError, "Orca refused to create a new project");
        m_arrange_active = false;
        m_arrange_state.reset();
        m_arrange_owned_fingerprint.clear();
        m_auto_orient_active = false;
        m_auto_orient_state.reset();
        m_auto_orient_owned_fingerprint.clear();
        m_slice_active = false;
        m_slice_plate_index.reset();
    }

    void restore_project(const std::filesystem::path& path) override
    {
        assert_gui_thread();
        preflight_3mf_archive(path.string());
        ScopedGeometryOnlyPlateUpdate plate_update;
        create_project();
        m_plater.restore_project_for_agent(boost::filesystem::path(path.string()));
        for (size_t index = 0; index < m_plater.model().objects.size(); ++index)
            refresh_plate_membership(index);
    }

    void start_scene_export(const std::filesystem::path& path) override
    {
        assert_gui_thread();
        if (m_geometry_future.valid())
            throw AgentError(ErrorCode::MutationInProgress, "Geometry export is already active");
        // Model's copy owns the project graph and retains immutable shared meshes,
        // as the existing native 3MF save snapshot does. No worker accesses Plater.
        auto model = std::make_shared<Model>(m_plater.model());
        validate_import_complexity(*model);
        nlohmann::json manifest = scene();
        const auto matrix_json = [](const Transform3d& matrix) {
            nlohmann::json result = nlohmann::json::array();
            for (int column = 0; column < 4; ++column)
                for (int row = 0; row < 4; ++row) {
                    if (!std::isfinite(matrix(row, column)))
                        throw AgentError(ErrorCode::InvalidRequest, "Non-finite native geometry transform");
                    result.push_back(matrix(row, column));
                }
            return result;
        };
        for (std::size_t index = 0; index < model->objects.size(); ++index) {
            const ModelObject& object = *model->objects[index];
            auto& entry = manifest["objects"][index];
            entry["volumes"] = nlohmann::json::array();
            for (const ModelVolume* volume : object.volumes) {
                const std::string id = "volume_" + std::to_string(volume->id().id);
                entry["volumes"].push_back({
                    {"volume_id", id}, {"name", volume->name},
                    {"role", ModelVolume::type_to_string(volume->type())},
                    // 0: the part follows its object's filament.
                    {"filament", volume->config.has("extruder") ?
                                     volume->config.opt_int("extruder") : 0},
                    {"mesh_id", id}, {"transform", matrix_json(volume->get_matrix())}
                });
            }
            for (std::size_t instance = 0; instance < object.instances.size(); ++instance) {
                const Transform3d transform = object.instances[instance]->get_matrix();
                entry["instances"][instance]["transform"] = matrix_json(transform);
                entry["instances"][instance]["mirrored"] = transform.linear().determinant() < 0;
            }
        }
        m_geometry_cancel = std::make_shared<std::atomic<bool>>(false);
        const auto cancelled = m_geometry_cancel;
        m_geometry_future = std::async(std::launch::async,
            [model, manifest = std::move(manifest), path, cancelled]() mutable -> FacadeJobState {
            try {
                std::vector<SceneMesh> meshes;
                for (const ModelObject* object : model->objects) {
                    for (const ModelVolume* volume : object->volumes) {
                        if (cancelled->load()) return {true, false, 1.0, nullptr, nullptr, true};
                        SceneMesh mesh;
                        mesh.id = "volume_" + std::to_string(volume->id().id);
                        const indexed_triangle_set& its = volume->mesh().its;
                        mesh.positions.reserve(its.vertices.size() * 3);
                        mesh.indices.reserve(its.indices.size() * 3);
                        for (const auto& vertex : its.vertices)
                            for (int axis = 0; axis < 3; ++axis) mesh.positions.push_back(vertex[axis]);
                        for (const auto& triangle : its.indices)
                            for (int axis = 0; axis < 3; ++axis) mesh.indices.push_back(static_cast<std::uint32_t>(triangle[axis]));
                        meshes.push_back(std::move(mesh));
                    }
                }
                const auto bytes = encode_scene_geometry(std::move(manifest), meshes);
                if (cancelled->load()) return {true, false, 1.0, nullptr, nullptr, true};
                write_exclusive_file(path, bytes.data(), bytes.size());
                return {true, false, 1.0, {{"saved", true}}, nullptr};
            } catch (const std::exception& error) {
                return {true, true, 1.0, nullptr, {{"message", error.what()}}};
            }
        });
    }

    FacadeJobState scene_export_state() override
    {
        if (!m_geometry_future.valid()) return {true, true, 1.0, nullptr, {{"message", "Geometry export was not started"}}};
        if (m_geometry_future.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
            return {false, false, 0.5, nullptr, nullptr};
        return m_geometry_future.get();
    }

    void start_model_import(const std::filesystem::path& path,
                            const std::string& display_name) override
    {
        assert_gui_thread();
        if (m_import_active)
            throw AgentError(ErrorCode::MutationInProgress, "A model import is already active");
        auto worker_lease = acquire_import_worker_lease();
        m_import_active = true;
        m_import_state = {};
        m_import_task = std::make_shared<ImportTask>();
        const std::shared_ptr<ImportTask> task = m_import_task;
        const std::string worker_path = path.string();
        try {
            std::thread([task, worker_path, display_name,
                         worker_lease = std::move(worker_lease)] {
                std::unique_ptr<Model> model;
                std::exception_ptr error;
                try {
                    if (boost::algorithm::iends_with(worker_path, ".3mf"))
                        preflight_3mf_archive(worker_path);
                    model = std::make_unique<Model>(Model::read_from_file(
                        worker_path, nullptr, nullptr,
                        LoadStrategy::AddDefaultInstances | LoadStrategy::LoadModel |
                            LoadStrategy::Silence));
                    validate_import_complexity(*model);
                    const std::string snapshot_name =
                        std::filesystem::path(worker_path).filename().string();
                    for (ModelObject* object : model->objects) {
                        object->name = restore_import_name(object->name, snapshot_name, display_name);
                        for (ModelVolume* volume : object->volumes)
                            volume->name = restore_import_name(volume->name, snapshot_name, display_name);
                    }
                } catch (...) {
                    error = std::current_exception();
                }
                std::lock_guard<std::mutex> lock(task->mutex);
                if (!task->abandoned) {
                    task->model = std::move(model);
                    task->error = std::move(error);
                }
                task->ready = true;
                (void) worker_lease;
            }).detach();
        } catch (...) {
            m_import_active = false;
            m_import_task.reset();
            throw;
        }
    }

    FacadeJobState model_import_state(bool allow_commit) override
    {
        assert_gui_thread();
        if (!m_import_active)
            return m_import_state.complete ? m_import_state :
                FacadeJobState {true, true, 1.0, nullptr,
                                {{"message", "Model import job was not started"}}};
        std::unique_ptr<Model> imported;
        std::exception_ptr parse_error;
        {
            std::lock_guard<std::mutex> lock(m_import_task->mutex);
            if (!allow_commit) {
                m_import_task->abandoned = true;
                m_import_task->model.reset();
                m_import_active = false;
                m_import_state = {true, false, 1.0, nullptr, nullptr, true};
                return m_import_state;
            }
            if (!m_import_task->ready)
                return {false, false, 0.5, nullptr, nullptr};
            m_import_active = false;
            imported = std::move(m_import_task->model);
            parse_error = m_import_task->error;
        }
        try {
            if (parse_error)
                std::rethrow_exception(parse_error);
            if (!imported)
                throw AgentError(ErrorCode::InternalError,
                                 "Model import worker produced no result");
            ScopedGeometryOnlyPlateUpdate plate_update;
            const auto indices = m_plater.load_model_for_agent(*imported);
            if (indices.empty())
                throw AgentError(ErrorCode::InvalidRequest,
                                 "The model contains no importable geometry");
            nlohmann::json objects = nlohmann::json::array();
            const Model& model = m_plater.model();
            for (const size_t index : indices)
                if (index < model.objects.size()) {
                    refresh_plate_membership(index);
                    objects.push_back(object_id(*model.objects[index]));
                }
            m_import_state = {true, false, 1.0,
                              {{"object_ids", std::move(objects)}}, nullptr};
        } catch (const std::exception& error) {
            m_import_state = {true, true, 1.0, nullptr,
                              {{"message", error.what()}}};
        } catch (...) {
            m_import_state = {true, true, 1.0, nullptr,
                              {{"message", "Model import parsing failed"}}};
        }
        return m_import_state;
    }

    nlohmann::json scene() const override
    {
        assert_gui_thread();
        nlohmann::json objects = nlohmann::json::array();
        const Model& model = m_plater.model();
        PartPlateList& plates = m_plater.get_partplate_list();
        for (size_t object_index = 0; object_index < model.objects.size(); ++object_index) {
            const ModelObject& object = *model.objects[object_index];
            nlohmann::json instances = nlohmann::json::array();
            for (size_t instance_index = 0; instance_index < object.instances.size(); ++instance_index) {
                const ModelInstance& instance = *object.instances[instance_index];
                const InstanceComponents components = instance_components(instance.get_matrix());
                instances.push_back({
                    {"instance_id", instance_id(instance)},
                    {"instance_index", instance_index},
                    {"offset_mm", vector_json(instance.get_offset())},
                    {"rotation_deg", vector_json(
                        Geometry::extract_euler_angles(components.rotation) * RadiansToDegrees)},
                    {"scale", vector_json(components.scale)},
                    {"mirrored", components.mirrored},
                    {"bounds", bounds_json(object.instance_bounding_box(instance_index))},
                    {"plate_index", plates.find_instance_belongs(
                        static_cast<int>(object_index), static_cast<int>(instance_index))}
                });
            }
            objects.push_back({
                {"object_id", object_id(object)},
                {"object_index", object_index},
                {"name", object.name},
                {"filament", object_filament(object)},
                {"bounds", bounds_json(object.bounding_box_exact())},
                {"instances", std::move(instances)}
            });
        }

        nlohmann::json plate_data = nlohmann::json::array();
        for (int index = 0; index < plates.get_plate_count(); ++index) {
            PartPlate* plate = plates.get_plate(index);
            int width = 0;
            int depth = 0;
            double height = 0.0;
            plates.get_plate_size(width, depth, height);
            plate_data.push_back({
                {"plate_index", index},
                {"name", plate != nullptr ? plate->get_plate_name() : std::string()},
                {"locked", plate != nullptr && plate->is_locked()},
                {"origin_mm", plate != nullptr ?
                    vector_json(plate->get_origin()) : nlohmann::json(nullptr)},
                {"size_mm", nlohmann::json::array({width, depth, height})}
            });
        }
        return {{"objects", std::move(objects)}, {"plates", std::move(plate_data)}};
    }

    void transform_object(const nlohmann::json& transform) override
    {
        assert_gui_thread();
        Model& model = m_plater.model();
        ModelObject* found_object = nullptr;
        ModelInstance* found_instance = nullptr;
        int found_object_index = -1;
        for (size_t index = 0; index < model.objects.size(); ++index) {
            ModelObject* object = model.objects[index];
            if (object_id(*object) != transform["object_id"].get<std::string>())
                continue;
            found_object = object;
            found_object_index = static_cast<int>(index);
            for (ModelInstance* instance : object->instances) {
                if (instance_id(*instance) == transform["instance_id"].get<std::string>()) {
                    found_instance = instance;
                    break;
                }
            }
            break;
        }
        if (found_object == nullptr || found_instance == nullptr)
            throw AgentError(ErrorCode::ObjectNotFound, "Object or instance does not exist");

        const bool relative = transform.value("mode", "absolute") == "relative";
        const auto vec = [](const nlohmann::json& value) {
            return Vec3d(value[0].get<double>(), value[1].get<double>(), value[2].get<double>());
        };
        if (transform.contains("offset_mm")) {
            const Vec3d value = vec(transform["offset_mm"]);
            found_instance->set_offset(relative ? found_instance->get_offset() + value : value);
        }
        if (transform.contains("rotation_deg") || transform.contains("scale")) {
            // Rebuild from the canonical components so mirrored instances keep
            // their mirror exactly; Orca's setters reuse a polar decomposition.
            InstanceComponents components = instance_components(found_instance->get_matrix());
            if (components.skewed)
                throw AgentError(ErrorCode::InvalidRequest,
                                 "The instance transformation contains skew; rotation and scale cannot be set exactly");
            if (transform.contains("rotation_deg")) {
                const Vec3d value = vec(transform["rotation_deg"]) * DegreesToRadians;
                const Vec3d angles = relative ?
                    Geometry::extract_euler_angles(components.rotation) + value : value;
                components.rotation = Geometry::rotation_transform(angles).linear();
            }
            if (transform.contains("scale")) {
                const Vec3d value = vec(transform["scale"]);
                components.scale = relative ? components.scale.cwiseProduct(value) : value;
            }
            found_instance->set_transformation(Geometry::Transformation(
                instance_matrix(found_instance->get_offset(), components)));
        }
        found_object->invalidate_bounding_box();
        if (transform.value("place_on_bed", false)) {
            const BoundingBoxf3 bounds = found_object->instance_bounding_box(*found_instance);
            Vec3d offset = found_instance->get_offset();
            offset.z() -= bounds.min.z();
            found_instance->set_offset(offset);
            found_object->invalidate_bounding_box();
        }
        ScopedGeometryOnlyPlateUpdate plate_update;
        m_plater.changed_object(found_object_index);
        refresh_plate_membership(static_cast<size_t>(found_object_index));
    }

    void delete_instances(const std::vector<InstanceTarget>& targets) override
    {
        assert_gui_thread();
        std::map<std::size_t, std::set<std::size_t>> grouped;
        for (const InstanceTarget& target : targets) {
            const auto [object_index, instance_index] = locate_instance(target);
            grouped[object_index].insert(instance_index);
        }
        const Model& model = m_plater.model();
        std::vector<ItemForDelete> items;
        for (const auto& [object_index, instances] : grouped) {
            const ModelObject& object = *model.objects[object_index];
            // Orca asks before breaking a cut correspondence; agents cannot answer.
            if (object.is_cut())
                throw AgentError(ErrorCode::InvalidRequest,
                                 "Objects that are part of a cut are deleted in Orca's desktop interface",
                                 {{"object_id", object_id(object)}});
            if (instances.size() == object.instances.size())
                items.emplace_back(itObject, int(object_index), 0);
            else
                for (const std::size_t instance_index : instances)
                    items.emplace_back(itInstance, int(object_index), int(instance_index));
        }
        ScopedGeometryOnlyPlateUpdate plate_update;
        // Orca's object list deletes in reverse order and keeps plates in sync.
        wxGetApp().obj_list()->delete_from_model_and_list(items);
        refresh_all_plate_membership();
    }

    void mirror_instances(const std::vector<InstanceTarget>& targets, int axis) override
    {
        assert_gui_thread();
        if (axis < 0 || axis > 2)
            throw AgentError(ErrorCode::InvalidRequest, "axis must be x, y or z");
        std::vector<std::pair<std::size_t, std::size_t>> located;
        for (const InstanceTarget& target : targets)
            located.push_back(locate_instance(target));
        m_plater.take_snapshot("Mirror");
        Model& model = m_plater.model();
        std::set<std::size_t> changed;
        for (const auto& [object_index, instance_index] : located) {
            ModelObject& object = *model.objects[object_index];
            ModelInstance& instance = *object.instances[instance_index];
            const Vec3d center = object.instance_bounding_box(instance).center();
            Matrix3d flip = Matrix3d::Identity();
            flip(axis, axis) = -1.0;
            Transform3d matrix = instance.get_matrix();
            matrix.linear() = flip * matrix.linear();
            matrix.translation() = flip * (matrix.translation() - center) + center;
            instance.set_transformation(Geometry::Transformation(matrix));
            object.invalidate_bounding_box();
            // Keep the mirrored instance on the bed like Orca's mirror.
            Vec3d offset = instance.get_offset();
            offset.z() -= object.instance_bounding_box(instance).min.z();
            instance.set_offset(offset);
            object.invalidate_bounding_box();
            changed.insert(object_index);
        }
        ScopedGeometryOnlyPlateUpdate plate_update;
        for (const std::size_t object_index : changed) {
            m_plater.changed_object(int(object_index));
            refresh_plate_membership(object_index);
        }
    }

    void set_object_filament(const std::string& id, const std::optional<std::string>& volume,
                             int filament) override
    {
        assert_gui_thread();
        const auto* colors =
            wxGetApp().preset_bundle->project_config.option<ConfigOptionStrings>("filament_colour");
        const int slots = colors != nullptr ? int(colors->values.size()) : 1;
        if (filament < 1 || filament > slots)
            throw AgentError(ErrorCode::InvalidRequest, "Filament slot does not exist",
                             {{"filament", filament}, {"slots", slots}});
        Model& model = m_plater.model();
        const auto found = std::find_if(model.objects.begin(), model.objects.end(),
                                        [&](const ModelObject* object) { return object_id(*object) == id; });
        if (found == model.objects.end())
            throw AgentError(ErrorCode::ObjectNotFound, "Object does not exist", {{"object_id", id}});
        ModelObject& object = **found;
        ModelVolume* target = nullptr;
        if (volume) {
            for (ModelVolume* candidate : object.volumes)
                if ("volume_" + std::to_string(candidate->id().id) == *volume)
                    target = candidate;
            if (target == nullptr)
                throw AgentError(ErrorCode::ObjectNotFound, "Part does not exist",
                                 {{"volume_id", *volume}});
            // Orca assigns filaments to model parts and modifiers only.
            if (target->type() != ModelVolumeType::MODEL_PART &&
                target->type() != ModelVolumeType::PARAMETER_MODIFIER)
                throw AgentError(ErrorCode::InvalidRequest,
                                 "Only model parts and modifiers take a filament",
                                 {{"volume_id", *volume}});
        }
        // Same steps as Orca's ObjectList::set_extruder_for_selected_items.
        m_plater.take_snapshot("Change Filaments");
        ModelConfig& config = target != nullptr ? target->config : object.config;
        config.set_key_value("extruder", new ConfigOptionInt(filament));
        if (target == nullptr)
            for (ModelVolume* part : object.volumes)
                if (part->type() == ModelVolumeType::MODEL_PART && part->config.has("extruder"))
                    part->config.erase("extruder");
        m_plater.update();
        wxGetApp().obj_list()->reload_all_plates();
    }

    void rename_object(const std::string& id, const std::string& name) override
    {
        assert_gui_thread();
        Model& model = m_plater.model();
        const auto found = std::find_if(model.objects.begin(), model.objects.end(),
                                        [&](const ModelObject* object) { return object_id(*object) == id; });
        if (found == model.objects.end())
            throw AgentError(ErrorCode::ObjectNotFound, "Object does not exist", {{"object_id", id}});
        m_plater.take_snapshot("Rename Object");
        (*found)->name = name;
        wxGetApp().obj_list()->reload_all_plates();
    }

    int add_plate() override
    {
        assert_gui_thread();
        ScopedGeometryOnlyPlateUpdate plate_update;
        const int plate_index = m_plater.add_plate();
        if (plate_index < 0)
            throw AgentError(ErrorCode::InvalidRequest,
                             "The maximum number of plates is already in use");
        // A grid reflow can move existing plates and their instances.
        refresh_all_plate_membership();
        return plate_index;
    }

    void rename_plate(std::size_t plate_index, const std::string& name) override
    {
        assert_gui_thread();
        PartPlate& plate = require_plate(plate_index);
        m_plater.take_snapshot("rename partplate");
        plate.set_plate_name(name);
    }

    void delete_plate(std::size_t plate_index) override
    {
        assert_gui_thread();
        require_plate(plate_index);
        if (m_plater.get_partplate_list().get_plate_count() <= 1)
            throw AgentError(ErrorCode::InvalidRequest, "The last plate cannot be removed");
        ScopedGeometryOnlyPlateUpdate plate_update;
        if (m_plater.delete_plate(static_cast<int>(plate_index)) != 0)
            throw AgentError(ErrorCode::InvalidRequest, "Orca could not remove the plate",
                             {{"plate_index", plate_index}});
        refresh_all_plate_membership();
    }

    void lock_plate(std::size_t plate_index, bool locked) override
    {
        assert_gui_thread();
        PartPlate& plate = require_plate(plate_index);
        if (plate.is_locked() == locked)
            return;
        m_plater.take_snapshot("lock partplate");
        m_plater.get_partplate_list().lock_plate(static_cast<int>(plate_index), locked);
    }

    void move_plate_to_front(std::size_t plate_index) override
    {
        assert_gui_thread();
        require_plate(plate_index);
        if (plate_index == 0)
            return;
        ScopedGeometryOnlyPlateUpdate plate_update;
        if (m_plater.move_plate_to_front(static_cast<int>(plate_index)) != 0)
            throw AgentError(ErrorCode::InvalidRequest, "Orca could not move the plate",
                             {{"plate_index", plate_index}});
        refresh_all_plate_membership();
    }

    void start_auto_orient(const nlohmann::json& request) override
    {
        assert_gui_thread();
        Model& model = m_plater.model();
        std::vector<std::pair<std::size_t, std::size_t>> targets;
        if (request.contains("targets")) {
            for (const nlohmann::json& requested : request.at("targets")) {
                bool found = false;
                for (std::size_t object_index = 0;
                     object_index < model.objects.size() && !found; ++object_index) {
                    ModelObject* object = model.objects[object_index];
                    if (object_id(*object) != requested.at("object_id").get<std::string>())
                        continue;
                    for (std::size_t instance_index = 0;
                         instance_index < object->instances.size(); ++instance_index) {
                        if (instance_id(*object->instances[instance_index]) ==
                            requested.at("instance_id").get<std::string>()) {
                            targets.emplace_back(object_index, instance_index);
                            found = true;
                            break;
                        }
                    }
                }
                if (!found)
                    throw AgentError(ErrorCode::ObjectNotFound,
                                     "Auto-orient target does not exist");
            }
        }

        m_auto_orient_state = std::make_shared<FacadeJobState>();
        std::weak_ptr<FacadeJobState> weak_state = m_auto_orient_state;
        if (!m_plater.orient_for_agent(
                std::move(targets),
                [this, weak_state](bool failed, std::string error) {
                    if (const auto state = weak_state.lock(); state && !state->complete) {
                        if (failed) {
                            *state = {true, true, 1.0, nullptr,
                                      {{"message", std::move(error)}}};
                        } else {
                            m_auto_orient_owned_fingerprint = state_fingerprint();
                            *state = {true, false, 1.0,
                                      {{"oriented", true}}, nullptr};
                        }
                    }
                }))
            throw AgentError(ErrorCode::MutationInProgress,
                             "Orca could not queue the auto-orient job");
        m_auto_orient_active = true;
    }

    FacadeJobState auto_orient_state() const override
    {
        assert_gui_thread();
        if (!m_auto_orient_active)
            return {true, true, 1.0, nullptr,
                    {{"message", "Auto-orient job was not started"}}};
        if (m_auto_orient_state && !m_auto_orient_state->complete &&
            !m_plater.get_ui_job_worker().is_idle())
            return {false, false, 0.5, nullptr, nullptr};
        if (!m_auto_orient_state || !m_auto_orient_state->complete)
            return {true, true, 1.0, nullptr,
                    {{"message", "Auto-orient ended without a completion result"}}};
        FacadeJobState result = *m_auto_orient_state;
        if (!result.failed && result.result.is_object())
            result.result["scene_fingerprint"] = m_auto_orient_owned_fingerprint;
        return result;
    }

    void start_arrange(std::optional<std::size_t> plate_index) override
    {
        assert_gui_thread();
        if (plate_index)
            require_plate(*plate_index);
        if (!m_plater.can_arrange())
            throw AgentError(ErrorCode::MutationInProgress, "Orca cannot arrange the current scene");
        m_arrange_state = std::make_shared<FacadeJobState>();
        std::weak_ptr<FacadeJobState> weak_state = m_arrange_state;
        if (!m_plater.arrange_for_agent(plate_index, [weak_state](bool failed, std::string error) {
                if (const auto state = weak_state.lock(); state && !state->complete) {
                    if (failed)
                        *state = {true, true, 1.0, nullptr,
                                  {{"message", std::move(error)}}};
                    else
                        *state = {true, false, 1.0, {{"arranged", true}}, nullptr};
                }
            }))
            throw AgentError(ErrorCode::MutationInProgress, "Orca could not queue the arrange job");
        m_arrange_owned_fingerprint = state_fingerprint();
        m_arrange_active = true;
    }

    FacadeJobState arrange_state() const override
    {
        assert_gui_thread();
        if (!m_arrange_active)
            return {true, true, 1.0, nullptr, {{"message", "Arrange job was not started"}}};
        if (m_arrange_state && !m_arrange_state->complete &&
            !m_plater.get_ui_job_worker().is_idle())
            return {false, false, 0.5, nullptr, nullptr};
        if (!m_arrange_state || !m_arrange_state->complete)
            return {true, true, 1.0, nullptr,
                    {{"message", "Arrange ended without a completion result"}}};
        FacadeJobState result = *m_arrange_state;
        if (!result.failed && result.result.is_object())
            result.result["scene_fingerprint"] = m_arrange_owned_fingerprint;
        return result;
    }

    nlohmann::json render_scene(const nlohmann::json& request,
                                const std::filesystem::path& screenshot_root) override
    {
        assert_gui_thread();
        std::error_code error;
        std::filesystem::create_directories(screenshot_root, error);
        if (error)
            throw AgentError(ErrorCode::RenderFailed, "Unable to create screenshot directory");

        const auto width = request["width"].get<unsigned>();
        const auto height = request["height"].get<unsigned>();
        const int plate_id = m_plater.get_partplate_list().get_curr_plate_index();
        const ThumbnailsParams thumbnail_params {
            {Vec2d(width, height)}, false, false, true, true, plate_id
        };
        nlohmann::json images = nlohmann::json::array();
        RenderArtifactRollback rollback;
        try {
            for (const auto& entry : request["views"]) {
                const std::string view = entry.get<std::string>();
                ThumbnailData thumbnail;
                m_plater.get_view3D_canvas3D()->render_thumbnail(
                    thumbnail, width, height, thumbnail_params,
                    Camera::EType::Ortho, view_type(view));
                if (!thumbnail.is_valid())
                    throw AgentError(
                        ErrorCode::RenderFailed,
                        "Orca produced an invalid thumbnail", {{"view", view}});
                auto png = GCodeThumbnails::compress_thumbnail(
                    thumbnail, GCodeThumbnailsFormat::PNG);
                if (!png || png->data == nullptr || png->size == 0)
                    throw AgentError(
                        ErrorCode::RenderFailed,
                        "Unable to encode scene render", {{"view", view}});

                SecureArtifact artifact;
                try {
                    artifact = write_secure_artifact(
                        screenshot_root, "scene-" + view + "-", ".png",
                        png->data, png->size);
                } catch (const std::exception&) {
                    throw AgentError(
                        ErrorCode::RenderFailed,
                        "Unable to write scene render", {{"view", view}});
                }
                rollback.track(artifact);
                const ArtifactFileIdentity current =
                    trusted_artifact_identity(artifact.path);
                if (current.device != artifact.identity.device ||
                    current.inode != artifact.identity.inode)
                    throw AgentError(
                        ErrorCode::RenderFailed,
                        "Scene render artifact changed before publication",
                        {{"view", view}});
                images.push_back({
                    {"view", view},
                    {"path", artifact.path.string()},
                    {"width", width},
                    {"height", height},
                    {"mime_type", "image/png"},
                    {"bytes", png->size}
                });
            }
        } catch (...) {
            const std::exception_ptr render_failure = std::current_exception();
            try {
                rollback.rollback();
            } catch (const std::exception& cleanup_error) {
                throw AgentError(
                    ErrorCode::RenderFailed,
                    "Render failed and its artifacts could not be cleaned safely",
                    {{"cleanup_error", cleanup_error.what()}});
            }
            std::rethrow_exception(render_failure);
        }
        rollback.commit();
        return {{"images", std::move(images)}};
    }

    nlohmann::json render_toolpaths(
        const nlohmann::json& request,
        const std::filesystem::path& screenshot_root,
        std::size_t plate_index) override
    {
        assert_gui_thread();
        PartPlateList& plates = m_plater.get_partplate_list();
        if (plate_index >= static_cast<std::size_t>(plates.get_plate_count()))
            throw AgentError(ErrorCode::InvalidRequest, "Sliced plate no longer exists");
        PartPlate* plate = plates.get_plate(static_cast<int>(plate_index));
        if (plate == nullptr || plate->get_slice_result() == nullptr ||
            !plate->is_slice_result_valid())
            throw AgentError(ErrorCode::InvalidRequest,
                             "Sliced plate has no valid G-code toolpaths");

        std::error_code directory_error;
        std::filesystem::create_directories(screenshot_root, directory_error);
        if (directory_error)
            throw AgentError(ErrorCode::RenderFailed, "Unable to create screenshot directory");

        std::optional<ToolpathLayerRange> requested_layers;
        if (request.contains("layer_range")) {
            requested_layers = ToolpathLayerRange {
                request.at("layer_range").at("start").get<unsigned int>(),
                request.at("layer_range").at("end").get<unsigned int>()
            };
        }
        const unsigned int width = request.at("width").get<unsigned int>();
        const unsigned int height = request.at("height").get<unsigned int>();
        GCodeProcessorResult* gcode = plate->get_slice_result();
        gcode->lock();
        struct ResultUnlock {
            GCodeProcessorResult* result;
            ~ResultUnlock() { result->unlock(); }
        } unlock {gcode};

        nlohmann::json images = nlohmann::json::array();
        std::optional<ToolpathLayerRange> available_layers;
        std::optional<ToolpathLayerRange> rendered_layers;
        RenderArtifactRollback rollback;
        try {
            for (const auto& entry : request.at("views")) {
                const std::string view = entry.get<std::string>();
                ToolpathRenderResult rendered;
                try {
                    rendered = ::Slic3r::GUI::Agent::render_toolpaths(
                        *gcode, {width, height, view, requested_layers});
                } catch (const std::invalid_argument& error) {
                    throw AgentError(ErrorCode::InvalidRequest,
                                     "Invalid sliced toolpath render request",
                                     {{"view", view}, {"error", error.what()}});
                } catch (const std::exception& error) {
                    throw AgentError(ErrorCode::RenderFailed,
                                     "Unable to render sliced toolpaths",
                                     {{"view", view}, {"error", error.what()}});
                }
                auto png = GCodeThumbnails::compress_thumbnail(
                    rendered.image, GCodeThumbnailsFormat::PNG);
                if (!png || png->data == nullptr || png->size == 0)
                    throw AgentError(ErrorCode::RenderFailed,
                                     "Unable to encode toolpath render", {{"view", view}});

                SecureArtifact artifact;
                try {
                    artifact = write_secure_artifact(
                        screenshot_root, "toolpath-" + view + "-", ".png",
                        png->data, png->size);
                } catch (const std::exception&) {
                    throw AgentError(ErrorCode::RenderFailed,
                                     "Unable to write toolpath render", {{"view", view}});
                }
                rollback.track(artifact);
                const ArtifactFileIdentity current = trusted_artifact_identity(artifact.path);
                if (current.device != artifact.identity.device ||
                    current.inode != artifact.identity.inode)
                    throw AgentError(
                        ErrorCode::RenderFailed,
                        "Toolpath render artifact changed before publication",
                        {{"view", view}});
                images.push_back({
                    {"view", view},
                    {"path", artifact.path.string()},
                    {"width", width},
                    {"height", height},
                    {"mime_type", "image/png"},
                    {"bytes", png->size},
                    {"segment_count", rendered.segment_count},
                    {"seam_count", rendered.seam_count}
                });
                available_layers = rendered.available_layers;
                rendered_layers = rendered.rendered_layers;
            }
        } catch (...) {
            const std::exception_ptr render_failure = std::current_exception();
            try {
                rollback.rollback();
            } catch (const std::exception& cleanup_error) {
                throw AgentError(
                    ErrorCode::RenderFailed,
                    "Toolpath render failed and its artifacts could not be cleaned safely",
                    {{"cleanup_error", cleanup_error.what()}});
            }
            std::rethrow_exception(render_failure);
        }
        rollback.commit();

        nlohmann::json legend = nlohmann::json::array();
        for (const ToolpathFeatureStyle& style : toolpath_feature_styles()) {
            legend.push_back({
                {"feature", style.key}, {"label", style.label},
                {"color", style.hex}, {"kind", "extrusion"}
            });
        }
        const ToolpathFeatureStyle& seam = toolpath_seam_style();
        legend.push_back({
            {"feature", seam.key}, {"label", seam.label},
            {"color", seam.hex}, {"kind", "marker"}
        });
        return {
            {"plate_index", plate_index},
            {"available_layer_range", {
                {"start", available_layers->start}, {"end", available_layers->end}}},
            {"rendered_layer_range", {
                {"start", rendered_layers->start}, {"end", rendered_layers->end}}},
            {"legend", std::move(legend)},
            {"excluded_move_types", {
                "travel", "wipe", "retract", "unretract", "tool_change",
                "filament_change", "pause", "custom_gcode"}},
            {"images", std::move(images)}
        };
    }

    nlohmann::json presets_list(const nlohmann::json& request) const override
    {
        assert_gui_thread();
        const PresetBundle& bundle = *wxGetApp().preset_bundle;
        const auto scopes = requested_scopes(request);
        const bool compatible_only = request.value("compatible_only", true);
        const nlohmann::json selected = selected_presets(bundle);
        nlohmann::json presets = nlohmann::json::array();
        if (scopes.count("printer"))
            append_presets(presets, bundle.printers, "printer", compatible_only,
                           {bundle.printers.get_selected_preset_name()});
        if (scopes.count("process"))
            append_presets(presets, process_presets(bundle), "process", compatible_only,
                           {process_presets(bundle).get_selected_preset_name()});
        if (scopes.count("filament")) {
            std::set<std::string> selected_filaments;
            for (const auto& item : selected.at("filaments"))
                selected_filaments.insert(item.get<std::string>());
            append_presets(presets, filament_presets(bundle), "filament", compatible_only,
                           selected_filaments);
        }
        return {{"selected", selected}, {"presets", std::move(presets)}};
    }

    nlohmann::json presets_select(const nlohmann::json& request) override
    {
        assert_gui_thread();
        PresetBundle& live = *wxGetApp().preset_bundle;
        const bool discard_dirty = request.value("discard_dirty", false);
        const bool had_dirty = presets_are_dirty(live);
        if (had_dirty && !discard_dirty)
            require_clean_presets(live);
        PresetBundle candidate(live);
        if (discard_dirty)
            discard_preset_changes(candidate);
        const auto& selection = request.at("selection");
        const nlohmann::json before = selected_presets(live);

        if (selection.contains("printer")) {
            select_exact(candidate.printers, selection.at("printer").get<std::string>(), "printer");
            // Like Orca's printer combo: keep compatible process and filament
            // presets and replace incompatible ones unless they were requested.
            candidate.update_compatible(
                selection.contains("process") ? PresetSelectCompatibleType::Never :
                                                PresetSelectCompatibleType::Always,
                selection.contains("filaments") ? PresetSelectCompatibleType::Never :
                                                  PresetSelectCompatibleType::Always);
            if (!selection.contains("filaments"))
                candidate.update_multi_material_filament_presets();
        } else {
            candidate.update_compatible(PresetSelectCompatibleType::Never);
        }

        PresetCollection& process = process_presets(candidate);
        if (selection.contains("process"))
            select_exact(process, selection.at("process").get<std::string>(), "process");
        if (!process.get_edited_preset().is_compatible)
            throw AgentError(ErrorCode::InvalidRequest, "Process preset is incompatible with the printer",
                             {{"name", process.get_selected_preset_name()}});
        candidate.update_compatible(PresetSelectCompatibleType::Never);

        PresetCollection& filaments = filament_presets(candidate);
        const bool fff = candidate.printers.get_edited_preset().printer_technology() == ptFFF;
        // One preset per filament slot; multi-color projects can have more
        // slots than the printer has extruders.
        const size_t expected_filaments = fff ? std::max<size_t>(1, candidate.filament_presets.size()) : 1;
        std::vector<std::string> requested = fff ? candidate.filament_presets :
            std::vector<std::string>{filaments.get_selected_preset_name()};
        if (selection.contains("filaments"))
            requested = selection.at("filaments").get<std::vector<std::string>>();
        if (requested.size() != expected_filaments)
            throw AgentError(ErrorCode::InvalidRequest, "Filament preset count must match the filament slots",
                             {{"expected", expected_filaments}, {"actual", requested.size()}});
        for (const std::string& name : requested) {
            Preset* preset = filaments.find_preset(name, false, true);
            if (preset == nullptr || preset->name != name || !preset->is_visible || !preset->is_compatible)
                throw AgentError(ErrorCode::InvalidRequest,
                                 "Filament preset does not exist or is incompatible",
                                 {{"name", name}});
        }
        if (fff) {
            candidate.filament_presets = requested;
            select_exact(candidate.filaments, requested.front(), "filament");
        } else {
            select_exact(candidate.sla_materials, requested.front(), "filament");
        }

        live = candidate;
        // A printer with more nozzles grows the preset list only; size the
        // per-slot color arrays to match, as Orca's set_num_filaments does.
        const auto* colors = live.project_config.option<ConfigOptionStrings>("filament_colour");
        if (fff && colors != nullptr && colors->values.size() < live.filament_presets.size())
            live.set_num_filaments(unsigned(live.filament_presets.size()));
        wxGetApp().load_current_presets(false, false);
        const nlohmann::json selected = selected_presets(live);
        return {{"selected", selected}, {"changed", had_dirty || selected != before}};
    }

    nlohmann::json printer_state() const override
    {
        assert_gui_thread();
        PresetBundle& bundle = *wxGetApp().preset_bundle;
        const Preset& selected = bundle.printers.get_selected_preset();
        const auto model_of = [](const Preset& preset) {
            return preset.config.has("printer_model") ? preset.config.opt_string("printer_model") :
                                                        std::string();
        };
        const auto variant_of = [](const Preset& preset) {
            return preset.config.has("printer_variant") ?
                preset.config.opt_string("printer_variant") : std::string();
        };
        const boost::filesystem::path resources(resources_dir());
        const auto resource = [&resources](const std::string& relative) {
            return boost::filesystem::exists(resources / relative) ? nlohmann::json(relative) :
                                                                   nlohmann::json(nullptr);
        };

        // System presets grouped by model like Orca's printer combo; user and
        // project presets are listed by name.
        nlohmann::json models = nlohmann::json::array();
        nlohmann::json user_presets = nlohmann::json::array();
        std::map<std::string, std::size_t> model_index;
        for (const Preset& preset : bundle.printers.get_presets()) {
            if (preset.is_default || (!preset.is_visible && &preset != &selected))
                continue;
            const std::string model = model_of(preset);
            if (!preset.is_system) {
                user_presets.push_back({{"preset", preset.name}, {"model", model},
                                        {"variant", variant_of(preset)}});
                continue;
            }
            if (model.empty())
                continue;
            const auto [entry, inserted] = model_index.emplace(model, models.size());
            if (inserted) {
                const std::string vendor_id = preset.vendor != nullptr ? preset.vendor->id : "";
                models.push_back({
                    {"model", model},
                    {"vendor", preset.vendor != nullptr ? preset.vendor->name : ""},
                    {"cover", vendor_id.empty() ? nlohmann::json(nullptr) :
                                                  resource("profiles/" + vendor_id + "/" + model + "_cover.png")},
                    {"variants", nlohmann::json::array()}
                });
            }
            models[entry->second]["variants"].push_back(
                {{"variant", variant_of(preset)}, {"preset", preset.name}});
        }

        // Orca shows the bed type picker for Bambu printers or when the printer
        // supports several bed types, without the model's unsupported types.
        nlohmann::json bed = nullptr;
        const bool multi_bed = selected.config.has("support_multi_bed_types") &&
                               selected.config.opt_bool("support_multi_bed_types");
        if (bundle.is_bbl_vendor() || multi_bed) {
            const ConfigOptionDef* def = print_config_def.get("curr_bed_type");
            const VendorProfile::PrinterModel* printer_model = PresetUtils::system_printer_model(selected);
            if (printer_model == nullptr)
                if (const Preset* parent = bundle.printers.get_selected_preset_parent())
                    printer_model = PresetUtils::system_printer_model(*parent);
            static const std::array<const char*, 6> thumbnails {
                "bed_cool", "bed_engineering", "bed_high_templ", "bed_pei", "bed_pei_cool",
                "bed_cool_supertack"};
            nlohmann::json types = nlohmann::json::array();
            for (std::size_t index = 0; index < def->enum_values.size(); ++index) {
                const std::string& label = def->enum_labels[index];
                if (printer_model != nullptr &&
                    std::find(printer_model->not_support_bed_types.begin(),
                              printer_model->not_support_bed_types.end(), label) !=
                        printer_model->not_support_bed_types.end())
                    continue;
                types.push_back({
                    {"key", def->enum_values[index]},
                    {"label", label},
                    {"image", index < thumbnails.size() ?
                                  resource(std::string("images/") + thumbnails[index] + ".png") :
                                  nlohmann::json(nullptr)}
                });
            }
            const int current = int(bundle.project_config.opt_enum<BedType>("curr_bed_type"));
            bed = {{"type", current >= 1 && current <= int(def->enum_values.size()) ?
                                nlohmann::json(def->enum_values[current - 1]) : nlohmann::json(nullptr)},
                   {"types", std::move(types)}};
        }

        return {
            {"selected", {{"preset", selected.name}, {"model", model_of(selected)},
                          {"variant", variant_of(selected)}, {"system", selected.is_system}}},
            {"dirty", presets_are_dirty(bundle)},
            {"models", std::move(models)},
            {"user_presets", std::move(user_presets)},
            {"bed", std::move(bed)}
        };
    }

    nlohmann::json filament_state() const override
    {
        assert_gui_thread();
        const PresetBundle& bundle = *wxGetApp().preset_bundle;
        const auto first = [](const Preset& preset, const char* key) {
            const auto* values = preset.config.option<ConfigOptionStrings>(key);
            return values != nullptr && !values->values.empty() ? values->values.front() : std::string();
        };
        const auto* colors = bundle.project_config.option<ConfigOptionStrings>("filament_colour");
        // Orca's combo shows preset labels: the alias, "*" when edited.
        const auto label_of = [&bundle](const std::string& name) {
            const Preset* preset = filament_presets(bundle).find_preset(name, false);
            return preset != nullptr ? preset->label(false) : name;
        };
        nlohmann::json slots = nlohmann::json::array();
        if (bundle.printers.get_edited_preset().printer_technology() == ptFFF)
            for (std::size_t index = 0; index < bundle.filament_presets.size(); ++index)
                slots.push_back({{"index", index},
                                 {"preset", bundle.filament_presets[index]},
                                 {"label", label_of(bundle.filament_presets[index])},
                                 {"color", colors != nullptr && index < colors->values.size() ?
                                               colors->values[index] : std::string()}});
        nlohmann::json presets = nlohmann::json::array();
        for (const Preset& preset : filament_presets(bundle).get_presets()) {
            if (preset.is_default || !preset.is_visible)
                continue;
            std::string vendor = first(preset, "filament_vendor");
            // Orca's filament combo shows Bambu Lab filaments as "Bambu".
            if (vendor == "Bambu Lab")
                vendor = "Bambu";
            presets.push_back({{"name", preset.name}, {"label", preset.label(false)},
                               {"vendor", vendor},
                               {"type", first(preset, "filament_type")},
                               {"system", preset.is_system},
                               {"compatible", preset.is_compatible}});
        }
        return {{"slots", std::move(slots)}, {"presets", std::move(presets)},
                {"dirty", presets_are_dirty(bundle)}};
    }

    void set_filament_color(std::size_t index, const std::string& color) override
    {
        assert_gui_thread();
        DynamicPrintConfig& project = wxGetApp().preset_bundle->project_config;
        const auto* current = project.option<ConfigOptionStrings>("filament_colour");
        if (current == nullptr || index >= current->values.size())
            throw AgentError(ErrorCode::InvalidRequest, "Filament slot does not exist",
                             {{"index", index}});
        // Same steps as Orca's filament color picker (PresetComboBox): solid
        // color, its multi-color entry, apply and announce the change.
        const auto with_value = [&](const char* key, const std::string& value) {
            auto* option = static_cast<ConfigOptionStrings*>(project.option(key, true)->clone());
            if (option->values.size() < current->values.size())
                option->values.resize(current->values.size(), option->values.empty() ?
                                                                  std::string() : option->values.back());
            option->values[index] = value;
            return option;
        };
        DynamicPrintConfig change;
        change.set_key_value("filament_colour", with_value("filament_colour", color));
        change.set_key_value("filament_colour_type", with_value("filament_colour_type", "1"));
        change.set_key_value("filament_multi_colour", with_value("filament_multi_colour", color));
        project.apply(change);
        m_plater.on_config_change(change);
        m_plater.update_project_dirty_from_presets();
        m_plater.sidebar().update_presets(Preset::TYPE_FILAMENT);
        auto* event = new wxCommandEvent(EVT_FILAMENT_COLOR_CHANGED);
        event->SetInt(int(index));
        wxQueueEvent(&m_plater, event);
    }

    void set_bed_type(const std::string& bed_type) override
    {
        assert_gui_thread();
        const nlohmann::json bed = printer_state().at("bed");
        if (bed.is_null())
            throw AgentError(ErrorCode::InvalidRequest, "The selected printer has a single bed type");
        const auto& types = bed.at("types");
        if (std::none_of(types.begin(), types.end(),
                         [&](const nlohmann::json& type) { return type.at("key") == bed_type; }))
            throw AgentError(ErrorCode::InvalidRequest, "The selected printer does not support this bed type",
                             {{"bed_type", bed_type}});
        const ConfigOptionDef* def = print_config_def.get("curr_bed_type");
        const BedType value = BedType(def->enum_keys_map->at(bed_type));
        PresetBundle& bundle = *wxGetApp().preset_bundle;
        if (bundle.project_config.opt_enum<BedType>("curr_bed_type") == value)
            return;
        // Same steps as Orca's bed type combo (Plater::priv::on_select_bed_type).
        bundle.project_config.set_key_value("curr_bed_type", new ConfigOptionEnum<BedType>(value));
        m_plater.update_project_dirty_from_presets();
        m_plater.on_config_change(bundle.full_config());
        AppConfig* app_config = wxGetApp().app_config;
        app_config->set("curr_bed_type", std::to_string(int(value)));
        app_config->set_printer_setting(bundle.printers.get_selected_preset_name(),
                                        "curr_bed_type", std::to_string(int(value)));
        for (PartPlate* plate : m_plater.get_partplate_list().get_plate_list())
            if (plate->get_bed_type() == btDefault)
                plate->update_slice_result_valid_state(false);
        m_plater.on_bed_type_change(value);
    }

    nlohmann::json settings_describe(const nlohmann::json& request) const override
    {
        assert_gui_thread();
        const PresetBundle& bundle = *wxGetApp().preset_bundle;
        const auto scopes = requested_scopes(request);
        std::string query = request.value("query", "");
        boost::algorithm::to_lower(query);
        std::vector<nlohmann::json> matches;
        for (const std::string& scope : scopes) {
            const DynamicPrintConfig& config = config_for_scope(bundle, scope);
            for (const std::string& key : config.keys()) {
                if (!is_agent_setting_allowed(key))
                    continue;
                const ConfigOptionDef* def = print_config_def.get(key);
                if (def == nullptr || std::string(option_type_name(def->type)) == "unsupported")
                    continue;
                std::string searchable = key + " " + def->label + " " + def->tooltip;
                boost::algorithm::to_lower(searchable);
                if (!query.empty() && searchable.find(query) == std::string::npos)
                    continue;
                nlohmann::json enums = nullptr;
                if (!def->enum_values.empty())
                    enums = def->enum_values;
                else if (def->enum_keys_map != nullptr) {
                    enums = nlohmann::json::array();
                    for (const auto& [name, value] : *def->enum_keys_map) {
                        (void) value;
                        enums.push_back(name);
                    }
                }
                matches.push_back({
                    {"key", key}, {"scope", scope}, {"label", def->label},
                    {"description", def->tooltip}, {"type", option_type_name(def->type)},
                    {"nullable", def->nullable}, {"read_only", def->readonly},
                    {"unit", def->sidetext.empty() ? nlohmann::json(nullptr) : nlohmann::json(def->sidetext)},
                    {"min", def->min <= -FLT_MAX ? nlohmann::json(nullptr) : nlohmann::json(def->min)},
                    {"max", def->max >= FLT_MAX ? nlohmann::json(nullptr) : nlohmann::json(def->max)},
                    {"max_literal",
                     def->type == coFloatOrPercent || def->type == coFloatsOrPercents ?
                         nlohmann::json(def->max_literal) : nlohmann::json(nullptr)},
                    {"enum_values", std::move(enums)}
                });
            }
        }
        std::sort(matches.begin(), matches.end(), [](const auto& left, const auto& right) {
            return std::make_pair(left.at("scope").template get<std::string>(),
                                  left.at("key").template get<std::string>()) <
                   std::make_pair(right.at("scope").template get<std::string>(),
                                  right.at("key").template get<std::string>());
        });
        size_t offset = 0;
        if (request.contains("cursor")) {
            try {
                offset = std::stoull(request.at("cursor").get<std::string>());
            } catch (...) {
                throw AgentError(ErrorCode::InvalidRequest, "Invalid settings cursor");
            }
            if (offset > matches.size())
                throw AgentError(ErrorCode::InvalidRequest, "Settings cursor is out of range");
        }
        const size_t limit = request.at("limit").get<size_t>();
        const size_t end = std::min(matches.size(), offset + limit);
        nlohmann::json items = nlohmann::json::array();
        for (size_t index = offset; index < end; ++index)
            items.push_back(std::move(matches[index]));
        return {
            {"items", std::move(items)},
            {"next_cursor", end < matches.size() ? nlohmann::json(std::to_string(end)) :
                                                   nlohmann::json(nullptr)}
        };
    }

    nlohmann::json settings_get(const nlohmann::json& request) const override
    {
        assert_gui_thread();
        const PresetBundle& bundle = *wxGetApp().preset_bundle;
        nlohmann::json values = nlohmann::json::array();
        for (const auto& item : request.at("settings")) {
            const std::string key = item.at("key").get<std::string>();
            if (!is_agent_setting_allowed(key))
                throw AgentError(ErrorCode::InvalidRequest,
                                 "Setting is not available through the agent capability",
                                 {{"key", key}});
            const std::string scope = item.at("scope").get<std::string>();
            const DynamicPrintConfig& config = config_for_setting(bundle, item);
            const ConfigOptionDef* def = print_config_def.get(key);
            const ConfigOption* option = config.option(key);
            if (def == nullptr || option == nullptr)
                throw AgentError(ErrorCode::InvalidRequest,
                                 "Setting is not valid in the requested scope",
                                 {{"key", key}, {"scope", scope}});
            nlohmann::json result {
                {"key", key}, {"scope", scope}, {"value", option_value(*option, *def)},
                {"unit", def->sidetext.empty() ? nlohmann::json(nullptr) : nlohmann::json(def->sidetext)}
            };
            if (scope == "filament")
                result["filament_index"] = filament_index(item);
            values.push_back(std::move(result));
        }
        return {{"values", std::move(values)}};
    }

    nlohmann::json settings_apply(const nlohmann::json& request) override
    {
        assert_gui_thread();
        PresetBundle& live = *wxGetApp().preset_bundle;
        PresetBundle candidate(live);
        nlohmann::json applied = nlohmann::json::array();
        for (const auto& change : request.at("changes")) {
            const std::string key = change.at("key").get<std::string>();
            if (!is_agent_setting_allowed(key))
                throw AgentError(ErrorCode::InvalidRequest,
                                 "Setting is not available through the agent capability",
                                 {{"key", key}});
            const std::string scope = change.at("scope").get<std::string>();
            DynamicPrintConfig& config = scope == "filament" ?
                editable_filament_config(candidate, filament_index(change)) :
                config_for_scope(candidate, scope);
            apply_setting(config, change);
            const ConfigOptionDef* def = print_config_def.get(key);
            const ConfigOption* option = config.option(key);
            if (def == nullptr || option == nullptr)
                throw AgentError(ErrorCode::InternalError,
                                 "Applied setting could not be read back", {{"key", key}});
            nlohmann::json result {
                {"key", change.at("key")}, {"scope", change.at("scope")},
                {"value", option_value(*option, *def)}
            };
            if (scope == "filament")
                result["filament_index"] = filament_index(change);
            applied.push_back(std::move(result));
        }
        candidate.update_compatible(PresetSelectCompatibleType::Never);
        const auto serialize_global =
            [](const PresetBundle& bundle) {
                const DynamicPrintConfig config = bundle.full_config();
                std::vector<std::string> keys = config.keys();
                std::sort(keys.begin(), keys.end());
                nlohmann::json complete = nlohmann::json::object();
                nlohmann::json visible = nlohmann::json::object();
                for (const std::string& key : keys) {
                    const ConfigOption* option = config.option(key);
                    if (option == nullptr)
                        continue;
                    std::string value = option->serialize();
                    if (value.size() > MaxAgentConfigValueBytes)
                        throw AgentError(
                            ErrorCode::InvalidRequest,
                            "Effective configuration contains an oversized value",
                            {{"key", key}, {"identity", "global"},
                             {"max_bytes", MaxAgentConfigValueBytes}});
                    complete[key] = value;
                    if (is_agent_setting_allowed(key))
                        visible[key] = std::move(value);
                }
                return std::pair<nlohmann::json, nlohmann::json>(
                    std::move(complete), std::move(visible));
            };
        const nlohmann::json current_metadata = job_metadata();
        const auto [current_complete, current_visible] = serialize_global(live);
        const auto [candidate_complete, candidate_visible] =
            serialize_global(candidate);
        (void) current_visible;
        const std::size_t current_bytes =
            current_metadata.at("config_snapshot").at("bytes").get<std::size_t>();
        const std::size_t current_global_bytes = current_complete.dump().size();
        const std::size_t candidate_global_bytes = candidate_complete.dump().size();
        if (current_bytes < current_global_bytes ||
            candidate_global_bytes > MaxConfigSnapshotBytes -
                (current_bytes - current_global_bytes))
            throw AgentError(
                ErrorCode::InvalidRequest,
                "Effective configuration exceeds the snapshot size limit",
                {{"max_bytes", MaxConfigSnapshotBytes}});
        const std::size_t candidate_bytes =
            current_bytes - current_global_bytes + candidate_global_bytes;
        nlohmann::json candidate_snapshot =
            current_metadata.at("config_snapshot");
        candidate_snapshot["settings"] = candidate_visible;
        candidate_snapshot["bytes"] = candidate_bytes;
        if (candidate_snapshot.dump().size() > MaxConfigSnapshotBytes)
            throw AgentError(
                ErrorCode::InvalidRequest,
                "Redacted configuration snapshot exceeds the response size limit",
                {{"max_bytes", MaxConfigSnapshotBytes}});
        const bool dry_run = request.value("dry_run", false);
        if (!dry_run) {
            live = candidate;
            wxGetApp().load_current_presets(false, false);
        }
        return {{"dry_run", dry_run}, {"applied", std::move(applied)}};
    }

    nlohmann::json job_metadata() const override
    {
        assert_gui_thread();
        const PresetBundle& bundle = *wxGetApp().preset_bundle;
        DynamicPrintConfig config = bundle.full_config();
        const auto serialize_config = [](const DynamicPrintConfig& source,
                                         std::vector<std::string>& redacted_keys,
                                         const std::string& identity) {
            std::vector<std::string> keys = source.keys();
            std::sort(keys.begin(), keys.end());
            nlohmann::json complete = nlohmann::json::object();
            nlohmann::json visible = nlohmann::json::object();
            for (const std::string& key : keys) {
                const ConfigOption* option = source.option(key);
                if (option == nullptr)
                    continue;
                std::string value = option->serialize();
                if (value.size() > MaxAgentConfigValueBytes)
                    throw AgentError(ErrorCode::InvalidRequest,
                                     "Effective configuration contains an oversized value",
                                     {{"key", key}, {"identity", identity},
                                      {"max_bytes", MaxAgentConfigValueBytes}});
                complete[key] = value;
                if (is_agent_setting_allowed(key))
                    visible[key] = std::move(value);
                else
                    redacted_keys.push_back(identity + "/" + key);
            }
            return std::pair<nlohmann::json, nlohmann::json>(
                std::move(complete), std::move(visible));
        };

        std::vector<std::string> redacted_keys;
        auto [complete, settings] = serialize_config(config, redacted_keys, "global");
        nlohmann::json complete_overrides = nlohmann::json::array();
        nlohmann::json visible_overrides = nlohmann::json::array();
        const auto append_override =
            [&](std::string kind, std::string identity,
                const DynamicPrintConfig& overrides,
                const DynamicPrintConfig& effective) {
                if (complete_overrides.size() >= MaxConfigOverrideEntries)
                    throw AgentError(ErrorCode::InvalidRequest,
                                     "Effective configuration has too many override scopes",
                                     {{"max_entries", MaxConfigOverrideEntries}});
                auto [complete_values, visible_values] =
                    serialize_config(overrides, redacted_keys, identity);
                std::vector<std::string> effective_redactions;
                auto [effective_values, ignored] =
                    serialize_config(effective, effective_redactions, identity + "/effective");
                (void) ignored;
                nlohmann::json complete_entry {
                    {"kind", kind}, {"identity", identity},
                    {"settings", std::move(complete_values)},
                    {"effective_sha256", sha256_hex(effective_values.dump())}
                };
                nlohmann::json visible_entry = complete_entry;
                visible_entry["settings"] = std::move(visible_values);
                complete_overrides.push_back(std::move(complete_entry));
                visible_overrides.push_back(std::move(visible_entry));
            };

        std::vector<const ModelObject*> objects;
        for (const ModelObject* object : m_plater.model().objects)
            objects.push_back(object);
        std::sort(objects.begin(), objects.end(), [](const ModelObject* lhs,
                                                     const ModelObject* rhs) {
            return lhs->id().id < rhs->id().id;
        });
        for (const ModelObject* object : objects) {
            DynamicPrintConfig object_effective = config;
            object_effective.apply(object->config.get());
            const std::string object_identity = object_id(*object);
            append_override("object", object_identity, object->config.get(),
                            object_effective);

            std::vector<const ModelVolume*> volumes(object->volumes.begin(),
                                                    object->volumes.end());
            std::sort(volumes.begin(), volumes.end(), [](const ModelVolume* lhs,
                                                         const ModelVolume* rhs) {
                return lhs->id().id < rhs->id().id;
            });
            for (const ModelVolume* volume : volumes) {
                DynamicPrintConfig volume_effective = object_effective;
                volume_effective.apply(volume->config.get());
                append_override(
                    "volume",
                    object_identity + "/volume_" + std::to_string(volume->id().id),
                    volume->config.get(), volume_effective);
            }
        }

        PartPlateList& plates = m_plater.get_partplate_list();
        for (int plate_index = 0; plate_index < plates.get_plate_count(); ++plate_index) {
            PartPlate* plate = plates.get_plate(plate_index);
            if (plate == nullptr || plate->config() == nullptr)
                continue;
            DynamicPrintConfig plate_effective = config;
            plate_effective.apply(*plate->config());
            append_override("plate", "plate_" + std::to_string(plate_index),
                            *plate->config(), plate_effective);
        }

        const std::string canonical =
            nlohmann::json({{"global", complete},
                            {"overrides", complete_overrides}}).dump();
        if (canonical.size() > MaxConfigSnapshotBytes)
            throw AgentError(ErrorCode::InvalidRequest,
                             "Effective configuration exceeds the snapshot size limit",
                             {{"bytes", canonical.size()},
                              {"max_bytes", MaxConfigSnapshotBytes}});
        std::sort(redacted_keys.begin(), redacted_keys.end());
        redacted_keys.erase(std::unique(redacted_keys.begin(), redacted_keys.end()),
                            redacted_keys.end());
        nlohmann::json snapshot {
            {"schema_version", 2},
            {"settings", std::move(settings)},
            {"overrides", std::move(visible_overrides)},
            {"redacted_keys", std::move(redacted_keys)},
            {"sha256", sha256_hex(canonical)},
            {"bytes", canonical.size()}
        };
        if (snapshot.dump().size() > MaxConfigSnapshotBytes)
            throw AgentError(ErrorCode::InvalidRequest,
                             "Redacted configuration snapshot exceeds the response size limit",
                             {{"max_bytes", MaxConfigSnapshotBytes}});
        return {{"selected_presets", selected_presets(bundle)},
                {"config_snapshot", std::move(snapshot)}};
    }

    std::string state_fingerprint() const override
    {
        assert_gui_thread();
        return std::to_string(m_plater.undo_redo_stack_main().active_snapshot_time());
    }

    std::string configuration_fingerprint() const override
    {
        assert_gui_thread();
        try {
            const PresetBundle& bundle = *wxGetApp().preset_bundle;
            const DynamicPrintConfig config = bundle.full_config();
            std::vector<std::string> keys = config.keys();
            std::sort(keys.begin(), keys.end());
            std::string canonical = selected_presets(bundle).dump();
            for (const std::string& key : keys) {
                const ConfigOption* option = config.option(key);
                if (option == nullptr)
                    continue;
                canonical.append("\n").append(key).append(":")
                    .append(std::to_string(static_cast<unsigned>(option->type())))
                    .append(":")
                    .append(std::to_string(option->hash()));
            }
            return sha256_hex(canonical);
        } catch (...) {
            // Allocation or preset access failure must invalidate
            // conservatively instead of making distinct failures compare equal.
            static std::atomic<std::uint64_t> failure_sequence {0};
            return "configuration-fingerprint-error-" +
                std::to_string(failure_sequence.fetch_add(
                    1, std::memory_order_relaxed) + 1);
        }
    }

    void start_slice(std::optional<std::size_t> plate_index) override
    {
        assert_gui_thread();
        require_no_post_process();
        m_slice_active = true;
        m_slice_plate_index.reset();
        if (!m_plater.slice_for_agent(plate_index)) {
            m_slice_active = false;
            throw AgentError(ErrorCode::InvalidRequest, "Orca could not start slicing");
        }
        const int selected_plate = m_plater.get_partplate_list().get_curr_plate_index();
        if (selected_plate < 0) {
            m_slice_active = false;
            throw AgentError(ErrorCode::InternalError,
                             "Orca did not retain the sliced plate selection");
        }
        m_slice_plate_index = static_cast<std::size_t>(selected_plate);
    }

    FacadeJobState slice_state() const override
    {
        assert_gui_thread();
        if (!m_slice_active)
            return {true, true, 1.0, nullptr, {{"message", "Slice job was not started"}}};
        const AgentProcessStatus status = m_plater.agent_process_status();
        if (!status.active)
            return {true, true, 1.0, nullptr, {{"message", "Agent slice state was lost"}}};
        if (!status.terminal)
            return {false, false, status.progress, nullptr, nullptr, false, warnings(status)};
        m_slice_active = false;
        if (status.cancelled)
            return {true, false, status.progress, nullptr, nullptr, true, warnings(status)};
        if (status.failed)
            return {true, true, 1.0, nullptr,
                    {{"message", status.error.empty() ? "Orca slicing failed" : status.error}},
                    false, warnings(status)};
        if (status.succeeded) {
            try {
                if (!m_slice_plate_index)
                    throw std::runtime_error("Slice plate identity was lost");
                return {true, false, 1.0,
                        {{"sliced", true},
                         {"print_metrics", slice_print_metrics(*m_slice_plate_index)}},
                        nullptr, false, warnings(status)};
            } catch (const std::exception& error) {
                return {true, true, 1.0, nullptr,
                        {{"message", std::string("Unable to collect print metrics: ") +
                                         error.what()}},
                        false, warnings(status)};
            }
        }
        return {true, true, 1.0, nullptr,
                {{"message", "Orca slicing stopped without producing a valid result"}},
                false, warnings(status)};
    }

    void start_gcode_export(const std::filesystem::path& path,
                            std::size_t plate_index) override
    {
        assert_gui_thread();
        require_no_post_process();
        m_export_path = path;
        m_export_active = true;
        if (!m_plater.export_gcode_for_agent(
                boost::filesystem::path(path.string()), plate_index)) {
            m_export_active = false;
            throw AgentError(ErrorCode::InvalidRequest, "Orca could not start G-code export");
        }
    }

    FacadeJobState gcode_export_state() const override
    {
        assert_gui_thread();
        if (!m_export_active)
            return {true, true, 1.0, nullptr, {{"message", "Export job was not started"}}};
        const AgentProcessStatus status = m_plater.agent_process_status();
        if (!status.active)
            return {true, true, 1.0, nullptr, {{"message", "Agent export state was lost"}}};
        if (!status.terminal)
            return {false, false, status.progress, nullptr, nullptr, false, warnings(status)};
        m_export_active = false;
        std::error_code error;
        if (std::filesystem::is_regular_file(m_export_path, error) &&
            std::filesystem::file_size(m_export_path, error) > 0 && !error)
            return {true, false, 1.0, {{"exported", true}}, nullptr, false, warnings(status)};
        if (status.cancelled)
            return {true, false, status.progress, nullptr, nullptr, true, warnings(status)};
        if (status.failed)
            return {true, true, 1.0, nullptr,
                    {{"message", status.error.empty() ?
                        "Orca G-code export failed" : status.error}},
                    false, warnings(status)};
        return {true, true, 1.0, nullptr,
                {{"message", "Orca G-code export stopped without producing output"}},
                false, warnings(status)};
    }

    void start_gcode_3mf_export(const std::filesystem::path& path,
                                std::size_t plate_index) override
    {
        start_3mf_save(path, true, static_cast<int>(plate_index));
    }

    FacadeJobState gcode_3mf_export_state() const override
    {
        return three_mf_save_state("G-code 3MF export job was not started");
    }

    void start_project_save(const std::filesystem::path& path) override
    {
        start_3mf_save(path, false, -1);
    }

    FacadeJobState project_save_state() const override
    {
        return three_mf_save_state("Project save job was not started");
    }

    void start_3mf_save(const std::filesystem::path& path,
                        bool include_gcode,
                        int plate_index)
    {
        assert_gui_thread();
        if (!m_plater.get_ui_job_worker().is_idle())
            throw AgentError(ErrorCode::MutationInProgress,
                             "Orca cannot queue the project save job");
        m_save_active = true;
        m_save_worker_owned = false;
        m_save_state = std::make_shared<FacadeJobState>();
        std::weak_ptr<FacadeJobState> weak_state = m_save_state;
        const std::weak_ptr<void> lifetime = m_lifetime;
        m_plater.CallAfter([this, path, include_gcode, plate_index, lifetime, weak_state] {
            if (lifetime.expired())
                return;
            const auto state = weak_state.lock();
            if (!state || state->complete)
                return;
            if (!m_plater.get_ui_job_worker().is_idle()) {
                *state = {true, true, 1.0, nullptr,
                          {{"message", "Orca project save worker became busy"}}};
                return;
            }
            m_save_worker_owned = m_plater.save_3mf_for_agent(
                boost::filesystem::path(path.string()), include_gcode, plate_index, lifetime,
                [weak_state](bool failed, std::string error) {
                    if (const auto state = weak_state.lock(); state && !state->complete) {
                        if (failed)
                            *state = {true, true, 1.0, nullptr,
                                      {{"message", std::move(error)}}};
                        else
                            *state = {true, false, 1.0, {{"saved", true}}, nullptr};
                    }
                });
        });
    }

    FacadeJobState three_mf_save_state(const char* not_started_message) const
    {
        assert_gui_thread();
        if (!m_save_active)
            return {true, true, 1.0, nullptr, {{"message", not_started_message}}};
        if (!m_save_state || !m_save_state->complete)
            return {false, false, 0.5, nullptr, nullptr};
        m_save_active = false;
        m_save_worker_owned = false;
        return *m_save_state;
    }

    void cancel_job(std::string_view type) override
    {
        assert_gui_thread();
        const auto cancel_ui_job = [this](
            bool active, const std::shared_ptr<FacadeJobState>& state,
            const char* message) {
            if (!active || !state || state->complete)
                throw AgentError(ErrorCode::InvalidJobTransition, message);
            const double progress = state->progress;
            *state = {true, false, progress, nullptr, nullptr, true};
            m_plater.get_ui_job_worker().cancel_all();
        };

        if (type == "scene_export") {
            if (!m_geometry_future.valid())
                throw AgentError(ErrorCode::InvalidJobTransition, "Geometry export is no longer cancellable");
            m_geometry_cancel->store(true);
            m_geometry_future.wait();
            m_geometry_future.get();
            return;
        }
        if (type == "model_import") {
            if (!m_import_active || !model_import_state(false).cancelled)
                throw AgentError(ErrorCode::InvalidJobTransition,
                                 "Model import is no longer cancellable");
            return;
        }
        if (type == "auto_orient") {
            cancel_ui_job(m_auto_orient_active, m_auto_orient_state,
                          "Auto-orient is no longer cancellable");
            return;
        }
        if (type == "arrange") {
            cancel_ui_job(m_arrange_active, m_arrange_state,
                          "Arrange is no longer cancellable");
            return;
        }
        if (type == "slice") {
            if (!m_slice_active || !m_plater.cancel_agent_process())
                throw AgentError(ErrorCode::InvalidJobTransition,
                                 "Slice is no longer cancellable");
            return;
        }
        if (type == "gcode_export") {
            if (!m_export_active || !m_plater.cancel_agent_process())
                throw AgentError(ErrorCode::InvalidJobTransition,
                                 "G-code export is no longer cancellable");
            return;
        }
        if (type == "project_save" || type == "gcode_3mf_export") {
            if (!m_save_active || !m_save_state || m_save_state->complete)
                throw AgentError(ErrorCode::InvalidJobTransition,
                                 "Project save is no longer cancellable");
            const double progress = m_save_state->progress;
            *m_save_state = {true, false, progress, nullptr, nullptr, true};
            if (m_save_worker_owned)
                m_plater.get_ui_job_worker().cancel_all();
            m_save_worker_owned = false;
            return;
        }
        throw AgentError(ErrorCode::InvalidJobTransition,
                         "Job type is not cancellable", {{"type", type}});
    }

private:
    /** Effective object filament; Orca treats 0 as the first slot. */
    static int object_filament(const ModelObject& object)
    {
        const int value = object.config.has("extruder") ? object.config.opt_int("extruder") : 0;
        return value > 0 ? value : 1;
    }

    std::pair<std::size_t, std::size_t> locate_instance(const InstanceTarget& target) const
    {
        const Model& model = m_plater.model();
        for (std::size_t object_index = 0; object_index < model.objects.size(); ++object_index) {
            const ModelObject& object = *model.objects[object_index];
            if (object_id(object) != target.first)
                continue;
            for (std::size_t instance_index = 0; instance_index < object.instances.size(); ++instance_index)
                if (instance_id(*object.instances[instance_index]) == target.second)
                    return {object_index, instance_index};
            break;
        }
        throw AgentError(ErrorCode::ObjectNotFound, "Object or instance does not exist",
                         {{"object_id", target.first}, {"instance_id", target.second}});
    }

    PartPlate& require_plate(std::size_t plate_index)
    {
        PartPlateList& plates = m_plater.get_partplate_list();
        PartPlate* plate = plate_index < static_cast<std::size_t>(plates.get_plate_count()) ?
            plates.get_plate(static_cast<int>(plate_index)) : nullptr;
        if (plate == nullptr)
            throw AgentError(ErrorCode::InvalidRequest, "Plate does not exist",
                             {{"plate_index", plate_index}});
        return *plate;
    }

    void refresh_all_plate_membership()
    {
        for (size_t index = 0; index < m_plater.model().objects.size(); ++index)
            refresh_plate_membership(index);
    }

    void refresh_plate_membership(size_t object_index)
    {
        assert_gui_thread();
        const ModelObject& object = *m_plater.model().objects.at(object_index);
        ScopedGeometryOnlyPlateUpdate plate_update;
        for (size_t index = 0; index < object.instances.size(); ++index)
            m_plater.get_partplate_list().notify_instance_update(
                static_cast<int>(object_index), static_cast<int>(index));
    }

    struct ImportTask
    {
        std::mutex mutex;
        std::unique_ptr<Model> model;
        std::exception_ptr error;
        bool ready {false};
        bool abandoned {false};
    };

    static void assert_gui_thread()
    {
        if (!wxIsMainThread())
            throw AgentError(ErrorCode::InternalError, "Orca facade called outside the GUI thread");
    }

    void require_no_post_process() const
    {
        const DynamicPrintConfig config = wxGetApp().preset_bundle->full_config();
        const auto nonempty = [&config](const char* key) {
            const auto* values = config.opt<ConfigOptionStrings>(key);
            return values != nullptr &&
                std::any_of(values->values.begin(), values->values.end(),
                            [](const std::string& value) { return !value.empty(); });
        };
        if (nonempty("post_process") || nonempty("slicing_pipeline_plugin"))
            throw AgentError(ErrorCode::InvalidRequest,
                             "Agent slicing and export reject post-processing scripts and plugins");
    }

    static nlohmann::json warnings(const AgentProcessStatus& status)
    {
        nlohmann::json result = nlohmann::json::array();
        for (const std::string& message : status.warnings)
            result.push_back({{"code", "slicer_warning"}, {"message", message},
                              {"details", nullptr}});
        return result;
    }

    static double metric_value(double value, const char* name)
    {
        if (!std::isfinite(value) || value < 0.0)
            throw std::runtime_error(std::string("Invalid print metric: ") + name);
        return value;
    }

    static const char* feature_key(ExtrusionRole role)
    {
        switch (role) {
        case erNone:                     return "undefined";
        case erPerimeter:                return "inner_wall";
        case erExternalPerimeter:        return "outer_wall";
        case erOverhangPerimeter:        return "overhang_wall";
        case erInternalInfill:           return "sparse_infill";
        case erSolidInfill:              return "internal_solid_infill";
        case erTopSolidInfill:           return "top_surface";
        case erBottomSurface:            return "bottom_surface";
        case erIroning:                  return "ironing";
        case erBridgeInfill:             return "bridge";
        case erInternalBridgeInfill:     return "internal_bridge";
        case erGapFill:                  return "gap_infill";
        case erSkirt:                    return "skirt";
        case erBrim:                     return "brim";
        case erSupportMaterial:          return "support";
        case erSupportMaterialInterface: return "support_interface";
        case erSupportTransition:        return "support_transition";
        case erWipeTower:                return "prime_tower";
        case erCustom:                   return "custom";
        case erMixed:                    return "multiple";
        default:                         return "unknown";
        }
    }

    nlohmann::json slice_print_metrics(std::size_t plate_index) const
    {
        PartPlateList& plates = m_plater.get_partplate_list();
        if (plate_index >= static_cast<std::size_t>(plates.get_plate_count()))
            throw std::runtime_error("Sliced plate no longer exists");
        PartPlate* plate = plates.get_plate(static_cast<int>(plate_index));
        if (plate == nullptr || plate->fff_print() == nullptr ||
            plate->get_slice_result() == nullptr || !plate->is_slice_result_valid())
            throw std::runtime_error("Sliced plate has no valid statistics");

        GCodeProcessorResult* result = plate->get_slice_result();
        result->lock();
        struct ResultUnlock {
            GCodeProcessorResult* result;
            ~ResultUnlock() { result->unlock(); }
        } unlock {result};

        const PrintStatistics& totals = plate->fff_print()->print_statistics();
        const PrintEstimatedStatistics& estimated = result->print_statistics;
        const auto& normal = estimated.modes[
            static_cast<std::size_t>(PrintEstimatedStatistics::ETimeMode::Normal)];
        const auto& silent = estimated.modes[
            static_cast<std::size_t>(PrintEstimatedStatistics::ETimeMode::Stealth)];

        nlohmann::json silent_seconds = nullptr;
        if (silent.time > 0.0f)
            silent_seconds = metric_value(silent.time, "silent_time_seconds");

        std::set<std::size_t> extruder_ids;
        const auto collect_ids = [&extruder_ids](const auto& values) {
            for (const auto& [id, value] : values) {
                (void) value;
                extruder_ids.insert(id);
            }
        };
        collect_ids(estimated.model_volumes_per_extruder);
        collect_ids(estimated.support_volumes_per_extruder);
        collect_ids(estimated.wipe_tower_volumes_per_extruder);
        collect_ids(estimated.flush_per_filament);
        collect_ids(estimated.total_volumes_per_extruder);

        const auto volume_for = [](const auto& values, std::size_t id) {
            const auto found = values.find(id);
            return found == values.end() ? 0.0 : found->second;
        };
        nlohmann::json per_extruder = nlohmann::json::array();
        for (const std::size_t id : extruder_ids) {
            per_extruder.push_back({
                {"extruder_id", id},
                {"model_volume_mm3", metric_value(
                    volume_for(estimated.model_volumes_per_extruder, id),
                    "model_volume_mm3")},
                {"support_volume_mm3", metric_value(
                    volume_for(estimated.support_volumes_per_extruder, id),
                    "support_volume_mm3")},
                {"wipe_tower_volume_mm3", metric_value(
                    volume_for(estimated.wipe_tower_volumes_per_extruder, id),
                    "wipe_tower_volume_mm3")},
                {"flushed_volume_mm3", metric_value(
                    volume_for(estimated.flush_per_filament, id),
                    "flushed_volume_mm3")},
                {"total_volume_mm3", metric_value(
                    volume_for(estimated.total_volumes_per_extruder, id),
                    "total_volume_mm3")}
            });
        }

        nlohmann::json per_feature = nlohmann::json::array();
        for (const auto& [role, usage] : estimated.used_filaments_per_role) {
            per_feature.push_back({
                {"feature", feature_key(role)},
                {"used_length_mm", metric_value(
                    usage.first * 1000.0, "feature_used_length_mm")},
                {"weight_g", metric_value(usage.second, "feature_weight_g")}
            });
        }

        return {
            {"time", {
                {"normal_seconds", metric_value(normal.time, "normal_time_seconds")},
                {"silent_seconds", std::move(silent_seconds)},
                {"preparation_seconds", metric_value(
                    normal.prepare_time, "preparation_time_seconds")}
            }},
            {"filament", {
                {"used_length_mm", metric_value(
                    totals.total_used_filament, "used_filament_mm")},
                {"extruded_volume_mm3", metric_value(
                    totals.total_extruded_volume, "extruded_volume_mm3")},
                {"weight_g", metric_value(totals.total_weight, "filament_weight_g")},
                {"total_cost", metric_value(totals.total_cost, "total_cost")},
                {"wipe_tower_used_length_mm", metric_value(
                    totals.total_wipe_tower_filament, "wipe_tower_used_length_mm")},
                {"wipe_tower_cost", metric_value(
                    totals.total_wipe_tower_cost, "wipe_tower_cost")},
                {"per_extruder", std::move(per_extruder)},
                {"per_feature", std::move(per_feature)}
            }},
            {"changes", {
                {"tool_changes", totals.total_toolchanges},
                {"filament_changes", estimated.total_filament_changes},
                {"extruder_changes", estimated.total_extruder_changes}
            }},
            {"travel", {
                {"distance_mm", metric_value(
                    estimated.total_travel_distance, "travel_distance_mm")},
                {"move_count", estimated.total_travel_moves}
            }},
            {"initial_tool", totals.initial_tool}
        };
    }

    std::future<FacadeJobState> m_geometry_future;
    std::shared_ptr<std::atomic<bool>> m_geometry_cancel;
    Plater& m_plater;
    mutable bool m_import_active {false};
    mutable std::shared_ptr<ImportTask> m_import_task;
    mutable FacadeJobState m_import_state;
    mutable bool m_auto_orient_active {false};
    mutable std::shared_ptr<FacadeJobState> m_auto_orient_state;
    std::string m_auto_orient_owned_fingerprint;
    mutable bool m_arrange_active {false};
    mutable std::shared_ptr<FacadeJobState> m_arrange_state;
    std::string m_arrange_owned_fingerprint;
    mutable bool m_slice_active {false};
    mutable std::optional<std::size_t> m_slice_plate_index;
    mutable bool m_export_active {false};
    mutable std::filesystem::path m_export_path;
    mutable bool m_save_active {false};
    mutable bool m_save_worker_owned {false};
    std::shared_ptr<void> m_lifetime {std::make_shared<int>(0)};
    mutable std::shared_ptr<FacadeJobState> m_save_state;
};

} // namespace

std::shared_ptr<AgentSlicerFacade> make_orca_agent_slicer_facade(Plater& plater)
{
    return std::make_shared<OrcaAgentSlicerFacade>(plater);
}

} // namespace Slic3r::GUI::Agent
