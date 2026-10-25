#pragma once

namespace Slic3r::GUI::Agent {

namespace detail {
inline thread_local bool geometry_only_plate_update = false;
}

inline bool geometry_only_plate_update()
{
    return detail::geometry_only_plate_update;
}

// Native bridge operations own geometry changes, not interactive vase decisions.
// Keep this scope on the GUI thread around native registration and restore.
class ScopedGeometryOnlyPlateUpdate
{
public:
    ScopedGeometryOnlyPlateUpdate()
        : m_previous(detail::geometry_only_plate_update)
    {
        detail::geometry_only_plate_update = true;
    }
    ~ScopedGeometryOnlyPlateUpdate()
    {
        detail::geometry_only_plate_update = m_previous;
    }
    ScopedGeometryOnlyPlateUpdate(const ScopedGeometryOnlyPlateUpdate&) = delete;
    ScopedGeometryOnlyPlateUpdate& operator=(const ScopedGeometryOnlyPlateUpdate&) = delete;
private:
    bool m_previous;
};

} // namespace Slic3r::GUI::Agent
