# Polyphony 远程语音输入 · Fcitx5 插件(docs/voice-input.md §5)
# 依赖(Ubuntu):cmake g++ libfcitx5core-dev nlohmann-json3-dev
cmake_minimum_required(VERSION 3.16)
project(polyphony-fcitx5-voice VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20) # Ubuntu 26.04 起 Fcitx5 头文件用到 std::span / starts_with / source_location
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

include(GNUInstallDirs)
find_package(Fcitx5Core 5.0.14 REQUIRED)
find_package(nlohmann_json REQUIRED)

add_subdirectory(src)

option(ENABLE_TEST "Build the integration test" ON)
if(ENABLE_TEST)
  enable_testing()
  add_subdirectory(test)
endif()
