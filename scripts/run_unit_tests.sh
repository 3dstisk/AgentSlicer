#!/bin/bash

# This file is made to support the unit tests workflow.
# It should only require the directories build/tests, scripts/, and tests/ to function,
# and cmake (with ctest) installed.
# (otherwise, update the workflow too, but try to avoid to keep things self-contained)
#
# Usage: run_unit_tests.sh [TEST_DIR] [BUILD_CONFIG] [TEST_REGEX] [RESULTS_FILE]
#   TEST_DIR      directory containing the built tests (default: build/tests)
#   BUILD_CONFIG  configuration to run; required for multi-config generators
#                 (Windows/macOS), harmless/omitted for single-config (Linux).
#   TEST_REGEX     optional CTest regular expression used to select tests.
#   RESULTS_FILE   optional JUnit output path (default: ctest_results.xml in the
#                  repository, or in the platform build directory in Docker).

ROOT_DIR="$(dirname "$0")/.."

cd "${ROOT_DIR}" || exit 1

TEST_DIR="${1:-build/tests}"
BUILD_CONFIG="${2:-}"
TEST_REGEX="${3:-}"
RESULTS_FILE="${4:-}"
if [ -z "${RESULTS_FILE}" ]; then
    if [ -n "${ORCA_DOCKER_BUILD_DIR:-}" ]; then
        RESULTS_FILE="$(pwd)/${ORCA_DOCKER_BUILD_DIR}/ctest_results.xml"
    else
        RESULTS_FILE="$(pwd)/ctest_results.xml"
    fi
fi

# Run the whole suite, excluding tests tagged [NotWorking].
# --no-tests=error fails the job if the filter matches nothing (instead of passing green).
args=(--test-dir "${TEST_DIR}" -LE "NotWorking" --no-tests=error --output-junit "${RESULTS_FILE}" --output-on-failure -j)
[ -n "${BUILD_CONFIG}" ] && args+=(--build-config "${BUILD_CONFIG}")
[ -n "${TEST_REGEX}" ] && args+=(--tests-regex "${TEST_REGEX}")
ctest "${args[@]}"
