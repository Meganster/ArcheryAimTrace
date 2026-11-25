/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_TRACE_TIMING_H
#define OPENFLOAT_TRACE_TIMING_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define OF_TRACE_HEADER_SIZE 52u
#define OF_TRACE_FORMAT 0x83u
#define OF_TRACE_PRE_SHORT 1u
#define OF_TRACE_POST_SHORT 2u
#define OF_TRACE_GAP 4u
#define OF_TRACE_BOOT_UNKNOWN 8u
#define OF_TRACE_EVENT_OUTSIDE 16u
#define OF_TRACE_SIMULATED 32u

struct of_trace_info {
    uint32_t shot_id, boot_id, period_num_us, period_den;
    uint64_t event_uptime_us;
    int32_t first_tick; /* First sample's output-tick offset from detector event. */
    uint16_t stride, count, event_index, flags, follow_ms, mount;
};

static inline uint64_t of_trace_follow_ticks(uint32_t ms, uint32_t odr, uint32_t average)
{
    uint64_t denominator = (uint64_t)average * 1000;
    return ((uint64_t)ms * odr + denominator - 1) / denominator;
}

static inline uint16_t of_trace_event_index(int32_t first_tick, uint16_t stride, uint16_t count)
{
    if (!stride || !count || first_tick > 0) return UINT16_MAX;
    uint64_t offset = (uint64_t)(-(int64_t)first_tick);
    uint64_t index = (offset + stride - 1) / stride;
    return index < count ? (uint16_t)index : UINT16_MAX;
}

static inline void of_trace_put(uint8_t *out, uint64_t value, unsigned bytes)
{
    for (unsigned i = 0; i < bytes; i++) out[i] = (uint8_t)(value >> (8 * i));
}

static inline uint32_t of_trace_crc_update(uint32_t crc, const uint8_t *bytes, size_t size)
{
    for (size_t i = 0; i < size; i++) {
        crc ^= bytes[i];
        for (unsigned bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return crc;
}

static inline void of_trace_header(uint8_t out[OF_TRACE_HEADER_SIZE],
                                   const struct of_trace_info *info, const uint8_t *points)
{
    memset(out, 0, OF_TRACE_HEADER_SIZE);
    memcpy(out, "OFT3", 4);
    of_trace_put(out + 4, 3, 2);
    of_trace_put(out + 6, OF_TRACE_HEADER_SIZE, 2);
    of_trace_put(out + 8, info->shot_id, 4);
    of_trace_put(out + 12, info->boot_id, 4);
    of_trace_put(out + 16, info->period_num_us, 4);
    of_trace_put(out + 20, info->period_den, 4);
    of_trace_put(out + 24, info->event_uptime_us, 8);
    of_trace_put(out + 32, (uint32_t)info->first_tick, 4);
    of_trace_put(out + 36, info->stride, 2);
    of_trace_put(out + 38, info->count, 2);
    of_trace_put(out + 40, info->event_index, 2);
    of_trace_put(out + 42, info->flags, 2);
    of_trace_put(out + 44, info->follow_ms, 2);
    of_trace_put(out + 46, info->mount, 2);
    uint32_t crc = of_trace_crc_update(UINT32_MAX, out, 48);
    crc = of_trace_crc_update(crc, points, (size_t)info->count * 7);
    of_trace_put(out + 48, ~crc, 4);
}
#endif
