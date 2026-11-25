/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_MOUNT_AXES_H
#define OPENFLOAT_MOUNT_AXES_H

#define OF_MOUNT_LEGACY_X90 0
#define OF_MOUNT_LEGACY_X90_INVERTED 1
#define OF_MOUNT_LEFT_USB_STRING 2

#ifndef OPENFLOAT_MOUNT
#define OPENFLOAT_MOUNT OF_MOUNT_LEGACY_X90
#endif

#if OPENFLOAT_MOUNT == OF_MOUNT_LEGACY_X90
#define OPENFLOAT_MOUNT_NAME "legacy-x90"
#elif OPENFLOAT_MOUNT == OF_MOUNT_LEGACY_X90_INVERTED
#define OPENFLOAT_MOUNT_NAME "legacy-x90-inverted"
#elif OPENFLOAT_MOUNT == OF_MOUNT_LEFT_USB_STRING
#define OPENFLOAT_MOUNT_NAME "left-side-usb-string"
#else
#error "Unsupported OPENFLOAT_MOUNT"
#endif

/*
 * Raw IMU -> fusion frame. Apply once, to both accel and gyro, before fusion.
 * Bow-aligned fusion convention: X forward, Y left, Z up.
 * The historical profiles preserve the previous firmware behavior.
 */
static inline void openfloat_mount_rotate(float *x, float *y, float *z)
{
	const float raw_y = *y;
	const float raw_z = *z;

#if OPENFLOAT_MOUNT == OF_MOUNT_LEFT_USB_STRING
	const float raw_x = *x;

	*x = raw_y;
	*y = raw_z;
	*z = raw_x;
#elif OPENFLOAT_MOUNT == OF_MOUNT_LEGACY_X90_INVERTED
	(void)x;
	*y = raw_z;
	*z = -raw_y;
#else
	(void)x;
	*y = -raw_z;
	*z = raw_y;
#endif
}

#endif
