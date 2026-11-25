/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_IMU_STREAM_H
#define OPENFLOAT_IMU_STREAM_H
/* LSM6DS3TR-C I2C maximum is 400 kHz. 1666 Hz x 12 bytes leaves
 * headroom for addresses, status reads, recovery and CPU scheduling. */
#define IMU_ODR_HZ 1666
#define LSM6DSL_IMU_ODR_REG 0x08
#define SAMPLES_PER_OUTPUT 2
#define OUTPUT_DT_US ((SAMPLES_PER_OUTPUT * 1000000UL) / IMU_ODR_HZ)
#define OF_OFFLINE_TRACE_STRIDE ((IMU_ODR_HZ / SAMPLES_PER_OUTPUT + 26) / 52)
#endif
