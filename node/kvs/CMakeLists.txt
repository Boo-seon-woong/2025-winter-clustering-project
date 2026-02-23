cmake_minimum_required(VERSION 3.10)
project(rdb_kvsd LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(kvsd
  main.cc
  kvs.cc
)

find_path(ROCKSDB_INCLUDE_DIR rocksdb/db.h)
find_library(ROCKSDB_LIBRARY rocksdb)
if (NOT ROCKSDB_INCLUDE_DIR OR NOT ROCKSDB_LIBRARY)
  message(FATAL_ERROR "RocksDB not found")
endif()

find_library(ZSTD_LIBRARY zstd)
find_library(SNAPPY_LIBRARY snappy)
find_library(ZLIB_LIBRARY z)
find_library(BZIP2_LIBRARY bz2)
find_library(LZ4_LIBRARY lz4)
find_package(Threads REQUIRED)

target_include_directories(kvsd PRIVATE ${ROCKSDB_INCLUDE_DIR})
target_link_libraries(kvsd PRIVATE
  ${ROCKSDB_LIBRARY}
  ${ZSTD_LIBRARY}
  ${SNAPPY_LIBRARY}
  ${ZLIB_LIBRARY}
  ${BZIP2_LIBRARY}
  Threads::Threads
)
if (LZ4_LIBRARY)
  target_link_libraries(kvsd PRIVATE ${LZ4_LIBRARY})
endif()
