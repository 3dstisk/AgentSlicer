get_filename_component(_TEST_NAME ${CMAKE_CURRENT_LIST_DIR} NAME)

add_executable(${_TEST_NAME}_tests
    test_agent_bridge.cpp
    ../../src/slic3r/GUI/Agent/AgentBridge.cpp
    ../../src/slic3r/GUI/Agent/AgentController.cpp
    ../../src/slic3r/GUI/Agent/AgentProtocol.cpp
    ../../src/slic3r/GUI/Agent/SecureFile.cpp
)

target_include_directories(${_TEST_NAME}_tests PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_SOURCE_DIR}/deps_src
)
target_link_libraries(${_TEST_NAME}_tests
    test_common
    boost_libs
    nlohmann_json
    Threads::Threads
    Catch2::Catch2WithMain
)
set_property(TARGET ${_TEST_NAME}_tests PROPERTY FOLDER "tests")

orcaslicer_discover_tests(${_TEST_NAME}_tests)
