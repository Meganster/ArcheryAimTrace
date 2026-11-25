/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_IMU_UNITS_H
#define OPENFLOAT_IMU_UNITS_H
/* LSM6DS3TR-C datasheet, table 3: +/-2000 dps sensitivity is 70 mdps/LSB.
 * It is NOT full_scale / 32768. https://www.st.com/resource/en/datasheet/lsm6ds3tr-c.pdf */
#define OF_GYRO_2000DPS_RAD_PER_LSB (0.070f / 57.29577951308232f)
#endif
