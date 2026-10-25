#pragma once

#include "libslic3r/Point.hpp"

#include <cmath>

namespace Slic3r::GUI::Agent {

/**
 * Instance linear transforms in the agent's canonical form L = R * S * Mx: R is
 * a proper rotation, S holds positive per-axis factors and Mx negates the
 * instance X axis when the matrix is mirrored. Every unskewed matrix has
 * exactly one such form. Orca's polar decomposition reports a non-diagonal
 * scale for mirrored matrices, so agent reads and writes of rotation and scale
 * go through this form instead. Euler angles are converted by the caller with
 * Orca's own Geometry functions.
 */
struct InstanceComponents
{
    Matrix3d rotation {Matrix3d::Identity()};
    Vec3d scale {Vec3d::Ones()};
    bool mirrored {false};
    /** The matrix cannot be expressed exactly; rotation and scale are approximate. */
    bool skewed {false};
};

inline InstanceComponents instance_components(const Transform3d& transform)
{
    InstanceComponents components;
    Transform3d proper = Transform3d::Identity();
    proper.linear() = transform.linear();
    components.mirrored = proper.linear().determinant() < 0.0;
    if (components.mirrored)
        proper.linear().col(0) = -proper.linear().col(0);
    Matrix3d scale;
    proper.computeRotationScaling(&components.rotation, &scale);
    components.scale = scale.diagonal();
    const double largest = scale.diagonal().cwiseAbs().maxCoeff();
    for (int row = 0; row < 3; ++row)
        for (int column = 0; column < 3; ++column)
            if (row != column && std::abs(scale(row, column)) > 1e-9 * largest)
                components.skewed = true;
    return components;
}

inline Transform3d instance_matrix(const Vec3d& offset, const InstanceComponents& components)
{
    Matrix3d linear = components.rotation * components.scale.asDiagonal();
    if (components.mirrored)
        linear.col(0) = -linear.col(0);
    Transform3d matrix = Transform3d::Identity();
    matrix.linear() = linear;
    matrix.translation() = offset;
    return matrix;
}

} // namespace Slic3r::GUI::Agent
