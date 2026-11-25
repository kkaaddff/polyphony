add_library(polyphonyvoice MODULE polyphonyvoice.cpp)
target_link_libraries(polyphonyvoice PRIVATE Fcitx5::Core nlohmann_json::nlohmann_json)
target_compile_options(polyphonyvoice PRIVATE -Wall -Wextra)

configure_file(polyphonyvoice.conf.in "${CMAKE_CURRENT_BINARY_DIR}/polyphonyvoice.conf" @ONLY)

install(TARGETS polyphonyvoice DESTINATION "${FCITX_INSTALL_ADDONDIR}")
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/polyphonyvoice.conf"
        DESTINATION "${FCITX_INSTALL_PKGDATADIR}/addon")
