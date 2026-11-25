find_package(Threads REQUIRED)

# 测试环境的 addon 目录:<build>/test/addon/polyphonyvoice.conf + <build>/src/libpolyphonyvoice.so
configure_file("${PROJECT_SOURCE_DIR}/src/polyphonyvoice.conf.in"
               "${CMAKE_CURRENT_BINARY_DIR}/addon/polyphonyvoice.conf" @ONLY)

add_executable(test_voice test_voice.cpp)
target_link_libraries(test_voice PRIVATE Fcitx5::Core nlohmann_json::nlohmann_json Threads::Threads)
target_compile_definitions(test_voice PRIVATE TEST_BINARY_DIR="${PROJECT_BINARY_DIR}")
add_dependencies(test_voice polyphonyvoice)

add_test(NAME voice COMMAND test_voice)
set_tests_properties(voice PROPERTIES TIMEOUT 60)
