#include <catch2/catch_all.hpp>

#include "libslic3r/Model.hpp"
#include "slic3r/GUI/3DBed.hpp"
#include "slic3r/GUI/GLCanvas3D.hpp"
#include "slic3r/GUI/Gizmos/GLGizmosManager.hpp"
#include "slic3r/GUI/PartPlate.hpp"
#include "slic3r/GUI/Selection.hpp"
#include "slic3r/Utils/UndoRedo.hpp"

#include <algorithm>

using namespace Slic3r;
using namespace Slic3r::GUI;

TEST_CASE("Agent import rollback owns its snapshot after branching from undo history",
          "[UndoRedo][AgentBridge]")
{
    Model model;
    Selection selection;
    Bed3D bed;
    GLCanvas3D canvas(nullptr, bed);
    GLGizmosManager gizmos(canvas);
    Slic3r::GUI::PartPlateList plates(nullptr, &model);
    UndoRedo::Stack stack;
    UndoRedo::SnapshotData snapshot_data;
    snapshot_data.snapshot_type = UndoRedo::SnapshotType::Action;
    snapshot_data.printer_technology = ptFFF;

    stack.take_snapshot(
        "Initial project", model, selection, gizmos, plates, snapshot_data);
    model.add_object();
    plates.create_plate(false);
    const size_t undone_state = stack.take_snapshot(
        "Second edit", model, selection, gizmos, plates, snapshot_data);
    model.add_object();
    plates.create_plate(false);

    REQUIRE(stack.undo(
        model, selection, gizmos, plates, snapshot_data, undone_state));
    REQUIRE(model.objects.size() == 1);
    REQUIRE(plates.get_plate_count() == 2);
    REQUIRE(stack.has_redo_snapshot());
    const size_t stale_active = stack.active_snapshot_time();

    const size_t owned_import = stack.take_snapshot(
        "Import model", model, selection, gizmos, plates, snapshot_data);
    REQUIRE(owned_import != stale_active);
    REQUIRE(stack.has_undo_snapshot(owned_import));

    model.add_object();
    plates.create_plate(false);
    REQUIRE(stack.rollback_to_snapshot(
        model, gizmos, plates, owned_import));

    REQUIRE(model.objects.size() == 1);
    REQUIRE(plates.get_plate_count() == 2);
    REQUIRE(stack.active_snapshot_time() == owned_import);
    REQUIRE(stack.active_snapshot().is_topmost());
    REQUIRE_FALSE(stack.has_redo_snapshot());
    REQUIRE(std::none_of(
        stack.snapshots().begin(), stack.snapshots().end(),
        [](const UndoRedo::Snapshot& snapshot) {
            return snapshot.name == "Import model";
        }));
}
