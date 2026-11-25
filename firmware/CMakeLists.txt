# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20.0)

set(DTC_OVERLAY_FILE ${CMAKE_CURRENT_SOURCE_DIR}/app.overlay CACHE STRING "" FORCE)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(archeryaimtrace-serial)

target_sources(app PRIVATE src/main.c)
target_link_libraries(app PRIVATE m)

zephyr_get(OPENFLOAT_MOUNT)
if(NOT DEFINED OPENFLOAT_MOUNT)
  set(OPENFLOAT_MOUNT "legacy-x90")
endif()
set(OPENFLOAT_MOUNT "${OPENFLOAT_MOUNT}" CACHE STRING "Raw IMU mounting profile" FORCE)
set_property(CACHE OPENFLOAT_MOUNT PROPERTY STRINGS
  legacy-x90 legacy-x90-inverted left-side-usb-string)
if(OPENFLOAT_MOUNT STREQUAL "legacy-x90")
  set(OPENFLOAT_MOUNT_DEFINE OF_MOUNT_LEGACY_X90)
elseif(OPENFLOAT_MOUNT STREQUAL "legacy-x90-inverted")
  set(OPENFLOAT_MOUNT_DEFINE OF_MOUNT_LEGACY_X90_INVERTED)
elseif(OPENFLOAT_MOUNT STREQUAL "left-side-usb-string")
  set(OPENFLOAT_MOUNT_DEFINE OF_MOUNT_LEFT_USB_STRING)
else()
  message(FATAL_ERROR "Unknown OPENFLOAT_MOUNT: ${OPENFLOAT_MOUNT}")
endif()
target_compile_definitions(app PRIVATE OPENFLOAT_MOUNT=${OPENFLOAT_MOUNT_DEFINE})
message(STATUS "ArcheryAimTrace mounting profile: ${OPENFLOAT_MOUNT}")
