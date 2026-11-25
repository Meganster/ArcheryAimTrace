/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_GYRO_BIAS_H
#define OPENFLOAT_GYRO_BIAS_H
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define OF_GYRO_CAL_SECONDS 8.0f
#define OF_GYRO_SETTLE_SECONDS 1.0f
#define OF_GYRO_WINDOW_SECONDS 0.25f
#define OF_GYRO_BIAS_LIMIT_RAD (5.0f * 0.01745329252f)
/* Engineering acceptance limits, not datasheet sensor-noise specifications.
 * Raw RMS alone does not measure the precision of the estimated DC bias.
 * Use non-overlapping block means so correlated samples are not counted as
 * independent. Keep a gross-noise guard, plus block stability, uncertainty,
 * and first/second-half agreement. No filtering of live aiming motion. */
#define OF_GYRO_NOISE_LIMIT_RAD (5.0f * 0.01745329252f)
#define OF_GYRO_BLOCK_LIMIT_DPS 0.15f
#define OF_GYRO_ERROR_LIMIT_DPS 0.025f
#define OF_GYRO_TREND_LIMIT_DPS 0.10f
#define OF_GYRO_CAL_BLOCKS 32

enum of_gyro_rejection {
	OF_GYRO_OK, OF_GYRO_TIMING, OF_GYRO_NONFINITE, OF_GYRO_RATE,
	OF_GYRO_GRAVITY, OF_GYRO_ACCEL_SHIFT, OF_GYRO_NOISE,
	OF_GYRO_SAMPLES, OF_GYRO_ACCEL_NOISE, OF_GYRO_BLOCK_NOISE,
	OF_GYRO_MEAN_ERROR, OF_GYRO_TREND, OF_GYRO_STREAM_GAP,
	OF_GYRO_FIFO_OVERFLOW, OF_GYRO_FIFO_ALIGNMENT, OF_GYRO_I2C_ERROR
};

struct of_gyro_bias {
	float bias[3];
	bool valid;
	uint8_t status; /* 0 uncalibrated, 1 collecting, 2 ready, 3 rejected */
	uint32_t count;
	float elapsed;
	float mean[3];
	float m2[3];
	float first_accel[3];
	float settling;
	float window_elapsed;
	uint32_t window_count;
	uint32_t windows;
	float accel_mean[3], accel_m2[3], gyro_mean[3];
	float block_mean[3], block_m2[3], first_half_mean[3];
	float raw_noise_dps[3], block_noise_dps[3], error_dps[3];
	uint8_t reason, axis; /* axis: 0 unspecified, 1 X, 2 Y, 3 Z */
	float observed, limit; /* diagnostics: ms, degrees/s, g, or sample count */
};

static inline void of_gyro_bias_restore(struct of_gyro_bias *cal,
		const int32_t record[4], int profile)
{
	cal->valid = false;
	cal->status = 0;
	memset(cal->bias, 0, sizeof(cal->bias));
	if (record[0] != profile) return;
	for (int i = 1; i < 4; i++) {
		if (record[i] < -5000 || record[i] > 5000) return;
	}
	for (int i = 0; i < 3; i++) cal->bias[i] = (float)record[i + 1] / 57295.779513f;
	cal->valid = true;
	cal->status = 2;
}

/* Explicit user request only: constant slow yaw cannot be distinguished from
 * bias by an IMU without a heading reference. Never learn while aiming. */
static inline void of_gyro_bias_start(struct of_gyro_bias *cal)
{
	cal->status = 1;
	cal->count = 0;
	cal->elapsed = 0;
	cal->settling = 0;
	cal->window_elapsed = 0;
	cal->window_count = 0;
	cal->windows = 0;
	cal->reason = OF_GYRO_OK;
	cal->axis = 0;
	cal->observed = cal->limit = 0;
	memset(cal->mean, 0, sizeof(cal->mean));
	memset(cal->m2, 0, sizeof(cal->m2));
	memset(cal->accel_mean, 0, sizeof(cal->accel_mean));
	memset(cal->accel_m2, 0, sizeof(cal->accel_m2));
	memset(cal->gyro_mean, 0, sizeof(cal->gyro_mean));
	memset(cal->block_mean, 0, sizeof(cal->block_mean));
	memset(cal->block_m2, 0, sizeof(cal->block_m2));
	memset(cal->first_half_mean, 0, sizeof(cal->first_half_mean));
	memset(cal->raw_noise_dps, 0, sizeof(cal->raw_noise_dps));
	memset(cal->block_noise_dps, 0, sizeof(cal->block_noise_dps));
	memset(cal->error_dps, 0, sizeof(cal->error_dps));
}

static inline uint8_t of_gyro_bias_reject(struct of_gyro_bias *cal,
		uint8_t reason, uint8_t axis, float observed, float limit)
{
	/* A failed attempt must not overwrite the last usable calibration. */
	cal->reason = reason;
	cal->axis = axis;
	cal->observed = observed;
	cal->limit = limit;
	return cal->status = 3;
}

/* Input is mounted acceleration in m/s^2 and uncorrected gyro in rad/s. */
static inline uint8_t of_gyro_bias_update(struct of_gyro_bias *cal,
		const float accel[3], const float gyro[3], float dt)
{
	if (cal->status != 1) return cal->status;
	if (!isfinite(dt) || dt <= 0 || dt > 0.02f)
		return of_gyro_bias_reject(cal, OF_GYRO_TIMING, 0, dt * 1000, 20);
	for (int i = 0; i < 3; i++) {
		if (!isfinite(accel[i]) || !isfinite(gyro[i]))
			return of_gyro_bias_reject(cal, OF_GYRO_NONFINITE, i + 1, 0, 0);
	}
	/* Startup transients must not become the reference or learned bias. */
	if (cal->settling < OF_GYRO_SETTLE_SECONDS) {
		cal->settling += dt;
		return cal->status;
	}
	cal->count++;
	cal->elapsed += dt;
	cal->window_count++;
	cal->window_elapsed += dt;
	for (int i = 0; i < 3; i++) {
		float delta = gyro[i] - cal->mean[i];
		cal->mean[i] += delta / (float)cal->count;
		cal->m2[i] += delta * (gyro[i] - cal->mean[i]);
		delta = accel[i] - cal->accel_mean[i];
		cal->accel_mean[i] += delta / (float)cal->window_count;
		cal->accel_m2[i] += delta * (accel[i] - cal->accel_mean[i]);
		cal->gyro_mean[i] += (gyro[i] - cal->gyro_mean[i]) / (float)cal->window_count;
	}
	if (cal->window_elapsed < OF_GYRO_WINDOW_SECONDS) return cal->status;
	float norm2 = 0, movement2 = 0, accel_variance = 0;
	for (int i = 0; i < 3; i++) {
		if (fabsf(cal->gyro_mean[i]) > OF_GYRO_BIAS_LIMIT_RAD)
			return of_gyro_bias_reject(cal, OF_GYRO_RATE, i + 1,
				fabsf(cal->gyro_mean[i]) * 57.295779513f, 5);
		if (cal->windows == 0) cal->first_accel[i] = cal->accel_mean[i];
		float movement = cal->accel_mean[i] - cal->first_accel[i];
		movement2 += movement * movement;
		norm2 += cal->accel_mean[i] * cal->accel_mean[i];
		accel_variance += cal->accel_m2[i] / (float)(cal->window_count - 1);
	}
	float gravity_error = fabsf(sqrtf(norm2) / 9.81f - 1.0f);
	if (gravity_error > 0.05f)
		return of_gyro_bias_reject(cal, OF_GYRO_GRAVITY, 0, gravity_error, 0.05f);
	float shift = sqrtf(movement2) / 9.81f;
	if (shift > 0.03f)
		return of_gyro_bias_reject(cal, OF_GYRO_ACCEL_SHIFT, 0, shift, 0.03f);
	float accel_noise = sqrtf(fmaxf(0, accel_variance)) / 9.81f;
	if (accel_noise > 0.05f)
		return of_gyro_bias_reject(cal, OF_GYRO_ACCEL_NOISE, 0, accel_noise, 0.05f);
	cal->windows++;
	for (int i = 0; i < 3; i++) {
		float delta = cal->gyro_mean[i] - cal->block_mean[i];
		cal->block_mean[i] += delta / (float)cal->windows;
		cal->block_m2[i] += delta * (cal->gyro_mean[i] - cal->block_mean[i]);
		if (cal->windows == OF_GYRO_CAL_BLOCKS / 2)
			cal->first_half_mean[i] = cal->block_mean[i];
	}
	cal->window_count = 0;
	cal->window_elapsed = 0;
	memset(cal->accel_mean, 0, sizeof(cal->accel_mean));
	memset(cal->accel_m2, 0, sizeof(cal->accel_m2));
	memset(cal->gyro_mean, 0, sizeof(cal->gyro_mean));
	if (cal->windows < OF_GYRO_CAL_BLOCKS) return cal->status;
	if (cal->count < 100)
		return of_gyro_bias_reject(cal, OF_GYRO_SAMPLES, 0, cal->count, 100);
	for (int i = 0; i < 3; i++) {
		float noise = sqrtf(fmaxf(0, cal->m2[i] / (float)(cal->count - 1)));
		cal->raw_noise_dps[i] = noise * 57.295779513f;
		cal->block_noise_dps[i] = sqrtf(fmaxf(0,
			cal->block_m2[i] / (float)(cal->windows - 1))) * 57.295779513f;
		cal->error_dps[i] = cal->block_noise_dps[i] / sqrtf((float)cal->windows);
	}
	for (int i = 0; i < 3; i++) {
		float noise = cal->raw_noise_dps[i] / 57.295779513f;
		if (noise > OF_GYRO_NOISE_LIMIT_RAD)
			return of_gyro_bias_reject(cal, OF_GYRO_NOISE, i + 1,
				cal->raw_noise_dps[i], 5.0f);
		if (cal->block_noise_dps[i] > OF_GYRO_BLOCK_LIMIT_DPS)
			return of_gyro_bias_reject(cal, OF_GYRO_BLOCK_NOISE, i + 1,
				cal->block_noise_dps[i], OF_GYRO_BLOCK_LIMIT_DPS);
		if (cal->error_dps[i] > OF_GYRO_ERROR_LIMIT_DPS)
			return of_gyro_bias_reject(cal, OF_GYRO_MEAN_ERROR, i + 1,
				cal->error_dps[i], OF_GYRO_ERROR_LIMIT_DPS);
		float trend = 2 * fabsf(cal->block_mean[i] - cal->first_half_mean[i]) * 57.295779513f;
		if (trend > OF_GYRO_TREND_LIMIT_DPS)
			return of_gyro_bias_reject(cal, OF_GYRO_TREND, i + 1,
				trend, OF_GYRO_TREND_LIMIT_DPS);
	}
	memcpy(cal->bias, cal->mean, sizeof(cal->bias));
	cal->observed = fmaxf(cal->error_dps[0], fmaxf(cal->error_dps[1], cal->error_dps[2]));
	cal->limit = OF_GYRO_ERROR_LIMIT_DPS;
	cal->valid = true;
	cal->status = 2;
	return cal->status;
}

static inline void of_gyro_bias_apply(const struct of_gyro_bias *cal,
		const float raw[3], float corrected[3])
{
	for (int i = 0; i < 3; i++) {
		corrected[i] = raw[i] - (cal->valid ? cal->bias[i] : 0.0f);
	}
}
#endif
