#include <catch2/catch_all.hpp>

#include "libslic3r/Model.hpp"
#include "test_utils.hpp"

#include <BRepPrimAPI_MakeBox.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <STEPControl_Writer.hxx>

using namespace Slic3r;

TEST_CASE("Generic model loader reads STEP files", "[Step]")
{
    for (const std::string extension : {".step", ".stp"}) {
        DYNAMIC_SECTION("Extension " << extension) {
            ScopedTemporaryFile file(extension);
            STEPControl_Writer writer;
            REQUIRE(writer.Transfer(BRepPrimAPI_MakeBox(20.0, 20.0, 20.0).Shape(),
                                    STEPControl_AsIs) == IFSelect_RetDone);
            REQUIRE(writer.Write(file.string().c_str()) == IFSelect_RetDone);

            Model model = Model::read_from_file(file.string());

            REQUIRE(model.objects.size() == 1);
            REQUIRE(model.objects.front()->instances.size() == 1);
            REQUIRE(model.objects.front()->volumes.size() == 1);
            REQUIRE(is_approx(model.objects.front()->volumes.front()->mesh().size(),
                              Vec3d(20.0, 20.0, 20.0)));
        }
    }
}
