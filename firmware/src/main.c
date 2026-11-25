/*
 * OpenFloat full-rate serial telemetry prototype for Seeed XIAO nRF54L15 Sense.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "mount_axes.h"
#include "gyro_bias.h"
#include "imu_units.h"
#include "imu_stream.h"
#include "trace_timing.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/debug/cpu_load.h>
#include <zephyr/kernel.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/atomic.h>

#include <zephyr/bluetooth/att.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/sys/poweroff.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/regulator.h>

struct vec3 {
	float x;
	float y;
	float z;
};

#include <zephyr/audio/dmic.h>

#define AUDIO_SAMPLE_RATE 16000
/*
 * The DMIC block size must be a whole number of PCM samples and must satisfy
 * the nrfx PDM driver's DMA/runtime constraints. At 16 kHz PCM, exact 1110 Hz
 * would need 14.41 samples/block; 14 samples is the closest integer match
 * (~1143 Hz), aligned with the ~1110 Hz IMU/BLE stream. Earlier 14/16-sample
 * experiments failed before deeper PDM queues; this build retries 14 with
 * expanded driver and mem-slab pools.
 */
#define AUDIO_SAMPLES_PER_BLOCK 14
#define AUDIO_REF_SAMPLES_PER_BLOCK 160
#define AUDIO_ACTUAL_BLOCK_RATE_HZ \
	((AUDIO_SAMPLE_RATE + (AUDIO_SAMPLES_PER_BLOCK / 2)) / AUDIO_SAMPLES_PER_BLOCK)
#define AUDIO_BYTES_PER_SAMPLE 2
#define AUDIO_BLOCK_SIZE (AUDIO_SAMPLES_PER_BLOCK * AUDIO_BYTES_PER_SAMPLE)
#define AUDIO_BLOCK_COUNT 64
#define AUDIO_ENVELOPE_TAU_S 0.005f
#define AUDIO_NOISE_FLOOR_ATTACK_TAU_S 2.0f
#define AUDIO_NOISE_FLOOR_RELEASE_TAU_S 0.15f
#define AUDIO_NOISE_MARGIN_BASE 128.0f
#define AUDIO_BLE_SCALE_DIVISOR 3.0f
#define AUDIO_READ_FAIL_RECOVER_THRESHOLD 32

K_MEM_SLAB_DEFINE_STATIC(audio_mem_slab, AUDIO_BLOCK_SIZE, AUDIO_BLOCK_COUNT, 4);

static volatile float audio_peak_raw;
static uint32_t audio_read_failures;
static uint32_t audio_blocks_processed;

static void start_pdm(void);
static void stop_pdm(void);

static const struct device *const dmic_dev = DEVICE_DT_GET(DT_NODELABEL(dmic_dev));
static volatile bool dmic_running;

static void audio_thread_entry(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	if (!device_is_ready(dmic_dev)) {
		printk("# DMIC device not ready!\n");
		return;
	}

	struct pcm_stream_cfg stream = {
		.pcm_width = 16,
		.mem_slab  = &audio_mem_slab,
	};
	struct dmic_cfg cfg = {
		.io = {
			.min_pdm_clk_freq = 1000000,
			.max_pdm_clk_freq = 3500000,
			.min_pdm_clk_dc   = 40,
			.max_pdm_clk_dc   = 60,
		},
		.streams = &stream,
		.channel = {
			.req_num_streams = 1,
		},
	};

	cfg.channel.req_num_chan = 1;
	cfg.channel.req_chan_map_lo = dmic_build_channel_map(0, 0, PDM_CHAN_LEFT);
	cfg.streams[0].pcm_rate = AUDIO_SAMPLE_RATE;
	cfg.streams[0].block_size = AUDIO_BLOCK_SIZE;

	int err = dmic_configure(dmic_dev, &cfg);
	if (err < 0) {
		printk("# Failed to configure DMIC: %d\n", err);
		return;
	}

	printk("# PDM Audio initialized: %u Hz, %u samples/block, ~%u blocks/s\n",
	       AUDIO_SAMPLE_RATE, AUDIO_SAMPLES_PER_BLOCK, AUDIO_ACTUAL_BLOCK_RATE_HZ);
	start_pdm();

	while (1) {
		while (!dmic_running) {
			k_sleep(K_MSEC(100));
		}

		void *buffer;
		uint32_t size;

		err = dmic_read(dmic_dev, 0, &buffer, &size, 100);
		if (err < 0) {
			audio_read_failures++;
			if ((audio_read_failures % 50U) == 1U) {
				printk("# AUDIO_ERR,read_fail=%d total=%u blocks=%u\n",
				       err, audio_read_failures, audio_blocks_processed);
			}
			if (audio_read_failures == AUDIO_READ_FAIL_RECOVER_THRESHOLD) {
				printk("# AUDIO_RECOVER,restarting PDM after read failures\n");
				stop_pdm();
				k_msleep(10);
				start_pdm();
			}
			continue;
		}

		audio_read_failures = 0;

		int16_t *samples = (int16_t *)buffer;
		uint32_t num_samples = size / sizeof(int16_t);

		int32_t sum = 0;
		for (uint32_t i = 0; i < num_samples; i++) {
			sum += samples[i];
		}

		int32_t mean = num_samples > 0 ? (sum / (int32_t)num_samples) : 0;
		int32_t peak = 0;
		for (uint32_t i = 0; i < num_samples; i++) {
			int32_t val = (int32_t)samples[i] - mean;
			if (val < 0) {
				val = -val;
			}
			if (val > peak) {
				peak = val;
			}
		}
		if (peak > INT16_MAX) {
			peak = INT16_MAX;
		}

		static float audio_envelope;
		static float noise_floor;
		float dt_s = (float)num_samples / (float)AUDIO_SAMPLE_RATE;
		float peak_f = (float)peak;
		/*
		 * Shorter blocks report lower peak deviations than the 160-sample
		 * tuning reference. Normalize so clicker/release sensitivity stays
		 * comparable when doubling the envelope update rate.
		 */
		if (num_samples > 0U && num_samples < AUDIO_REF_SAMPLES_PER_BLOCK) {
			peak_f *= sqrtf((float)AUDIO_REF_SAMPLES_PER_BLOCK /
					(float)num_samples);
		}
		if (noise_floor <= 0.0f) {
			noise_floor = peak_f;
		} else {
			float floor_tau = peak_f > noise_floor ?
				AUDIO_NOISE_FLOOR_ATTACK_TAU_S :
				AUDIO_NOISE_FLOOR_RELEASE_TAU_S;
			float floor_alpha = 1.0f - expf(-dt_s / floor_tau);
			noise_floor += (peak_f - noise_floor) * floor_alpha;
		}

		float noise_margin = AUDIO_NOISE_MARGIN_BASE *
			((float)AUDIO_SAMPLES_PER_BLOCK /
			 (float)AUDIO_REF_SAMPLES_PER_BLOCK);
		float signal_peak = peak_f - noise_floor - noise_margin;
		if (signal_peak < 0.0f) {
			signal_peak = 0.0f;
		}

		float decay = expf(-dt_s / AUDIO_ENVELOPE_TAU_S);

		if (signal_peak > audio_envelope) {
			audio_envelope = signal_peak;
		} else {
			audio_envelope *= decay;
		}

		audio_peak_raw = audio_envelope;
		audio_blocks_processed++;

		k_mem_slab_free(&audio_mem_slab, buffer);
	}
}

#define AUDIO_THREAD_STACK_SIZE 2048
#define AUDIO_THREAD_PRIORITY 4
K_THREAD_STACK_DEFINE(audio_thread_stack, AUDIO_THREAD_STACK_SIZE);
struct k_thread audio_thread_data;

static void start_pdm(void)
{
	if (!dmic_running && device_is_ready(dmic_dev)) {
		int err = dmic_trigger(dmic_dev, DMIC_TRIGGER_START);
		if (err == 0) {
			dmic_running = true;
			audio_read_failures = 0;
			printk("# PDM microphone sampling started\n");
		} else {
			printk("# Failed to start PDM: %d\n", err);
		}
	}
}

static void stop_pdm(void)
{
	if (dmic_running && device_is_ready(dmic_dev)) {
		int err = dmic_trigger(dmic_dev, DMIC_TRIGGER_STOP);
		if (err == 0) {
			dmic_running = false;
			printk("# PDM microphone sampling stopped\n");
		} else {
			printk("# Failed to stop PDM: %d\n", err);
		}
	}
}

#define IMU_ACCEL_FS_G 16
#define IMU_GYRO_FS_DPS 2000
/*
 * Each output frame averages this many raw IMU samples (~0.9 ms window at
 * 1666 Hz, ~833 distinct output frames/s). The drain (driven by the FIFO
 * watermark interrupt) can pull a large batch in one efficient I2C burst, but it
 * is split into fixed groups so every emitted frame is a distinct short average
 * rather than one batch average duplicated to fake the rate. Keeping the window
 * short also preserves the shot-impulse peak for detect_shot().
 */
#define SERIAL_PRINT_DIVIDER 100
#define BLE_NOTIFY_DIVIDER 1
#define OPENFLOAT_BLE_FRAME_SIZE 29
#define OPENFLOAT_BLE_LIVE_FRAME_SIZE 20
#define OPENFLOAT_BLE_FRAMES_PER_NOTIFICATION 6
#define OPENFLOAT_BLE_NOTIFY_PAYLOAD_SIZE \
	(OPENFLOAT_BLE_LIVE_FRAME_SIZE * OPENFLOAT_BLE_FRAMES_PER_NOTIFICATION)
/* Reserve frame[28] for the stride byte (set on chunk 0). Payload therefore
 * spans frame[9..27]; using FRAME_SIZE-9 would let the chunk-0 memcpy overwrite
 * the stride byte the decoder relies on. */
#define TRACE_CHUNK_PAYLOAD_SIZE (OPENFLOAT_BLE_FRAME_SIZE - 10)
#define OPENFLOAT_CONN_INTERVAL_MIN 6  /* 7.5 ms */
#define OPENFLOAT_CONN_INTERVAL_MAX 6  /* 7.5 ms */
#define OPENFLOAT_CONN_LATENCY 0
#define OPENFLOAT_CONN_TIMEOUT 400 /* 4 s */
#define BLE_STALE_NOTIFY_DISCONNECT_MS 1500
#define MADGWICK_BETA 0.08f
#define STORED_SHOT_CAPACITY 100
#define STORED_SHOT_UPLOAD_RETRY_MS 3000

#define RAD_TO_DEG 57.29577951308232f
#define SCALE_CDEG 100.0f
#define SCALE_QUAT 1000000.0f
#define SCALE_MG 101.97162129779283f
#define SCALE_ACCEL_DECI_G 1.0197162129779283f
#define SCALE_GYRO_MDPS (RAD_TO_DEG * 1000.0f)
#define SCALE_GYRO_DPS_Q4 (RAD_TO_DEG * 16.0f)
#define LSM6DSL_REG_WHO_AM_I 0x0f
#define LSM6DSL_WHO_AM_I 0x6a
#define LSM6DSL_REG_FIFO_CTRL1 0x06
#define LSM6DSL_REG_FIFO_CTRL2 0x07
#define LSM6DSL_REG_FIFO_CTRL3 0x08
#define LSM6DSL_REG_FIFO_CTRL4 0x09
#define LSM6DSL_REG_FIFO_CTRL5 0x0a
#define LSM6DSL_REG_CTRL1_XL 0x10
#define LSM6DSL_REG_INT1_CTRL 0x0d
#define LSM6DSL_INT1_CTRL_FTH BIT(3)
#define LSM6DSL_REG_CTRL2_G 0x11
#define LSM6DSL_REG_CTRL3_C 0x12
#define LSM6DSL_REG_CTRL6_C 0x15
#define LSM6DSL_REG_CTRL7_G 0x16
#define LSM6DSL_REG_OUTX_L_G 0x22
#define LSM6DSL_REG_FIFO_STATUS1 0x3a
#define LSM6DSL_REG_FIFO_STATUS2 0x3b
#define LSM6DSL_REG_FIFO_STATUS3 0x3c
#define LSM6DSL_REG_FIFO_STATUS4 0x3d
#define LSM6DSL_REG_FIFO_DATA_OUT_L 0x3e
#define LSM6DSL_ACCEL_FS_16G 0x01
#define LSM6DSL_GYRO_FS_2000DPS 0x03
#define LSM6DSL_FIFO_DEC_NO 0x01
#define LSM6DSL_FIFO_MODE_BYPASS 0x00
#define LSM6DSL_FIFO_MODE_STREAM 0x06
#define LSM6DSL_FIFO_WORDS_PER_SAMPLE 6
#define LSM6DSL_FIFO_BYTES_PER_SAMPLE \
	(LSM6DSL_FIFO_WORDS_PER_SAMPLE * sizeof(uint16_t))
#define LSM6DSL_FIFO_DRAIN_MAX_SAMPLES 16
#define LSM6DSL_FIFO_DRAIN_MAX_WORDS \
	(LSM6DSL_FIFO_DRAIN_MAX_SAMPLES * LSM6DSL_FIFO_WORDS_PER_SAMPLE)
/*
 * FIFO threshold (FTH) that asserts INT1, in whole samples (~4.8 ms of data at
 * 1666 Hz). Large enough that each watermark interrupt drains a batch in one
 * efficient I2C burst and the main loop can sleep between batches (low CPU);
 * the batch is then split into SAMPLES_PER_OUTPUT groups so output stays
 * fine-grained. A multiple of SAMPLES_PER_OUTPUT keeps groups batch-aligned.
 * The drain itself is still capped at LSM6DSL_FIFO_DRAIN_MAX_SAMPLES.
 */
#define LSM6DSL_FIFO_WATERMARK_SAMPLES 8
#define LSM6DSL_FIFO_WATERMARK_WORDS \
	(LSM6DSL_FIFO_WORDS_PER_SAMPLE * LSM6DSL_FIFO_WATERMARK_SAMPLES)
#define LSM6DSL_FIFO_STATUS2_OVER_RUN BIT(6)
#define LSM6DSL_FIFO_STATUS2_FIFO_FULL_SMART BIT(5)
#define LSM6DSL_CTRL3_C_BDU BIT(6)
#define LSM6DSL_CTRL3_C_IF_INC BIT(2)
#define LSM6DSL_CTRL6_C_XL_HM_MODE BIT(4)
#define LSM6DSL_CTRL7_G_HM_MODE BIT(7)
#define LSM6DSL_ACCEL_16G_MPS2_PER_LSB \
	((float)IMU_ACCEL_FS_G * MPS2_PER_G / 32768.0f)
#define LSM6DSL_GYRO_2000DPS_RAD_PER_S_PER_LSB \
	OF_GYRO_2000DPS_RAD_PER_LSB

#define MPS2_PER_G 9.81f
#define DEFAULT_SHOT_ACCEL_THRESHOLD_G 12.0f
#define MIN_SHOT_ACCEL_THRESHOLD_G 2.0f
#define MAX_SHOT_ACCEL_THRESHOLD_G 30.0f
#define SHOT_REFRACTORY_MS 800

#define LED_IDLE_PERIOD_MS 500
#define LED_SHOT_PULSE_MS 120

static const struct i2c_dt_spec imu_i2c = I2C_DT_SPEC_GET(DT_ALIAS(imu0));
static const struct gpio_dt_spec imu_int =
	GPIO_DT_SPEC_GET_OR(DT_ALIAS(imu0), irq_gpios, { 0 });
static struct gpio_callback imu_int_cb;
static K_SEM_DEFINE(imu_fifo_sem, 0, 1);
static const struct gpio_dt_spec user_led =
	GPIO_DT_SPEC_GET_OR(DT_ALIAS(led0), gpios, { 0 });
static const struct gpio_dt_spec user_btn =
	GPIO_DT_SPEC_GET_OR(DT_ALIAS(sw0), gpios, { 0 });
static const struct device *const stream_uart =
	DEVICE_DT_GET(DT_NODELABEL(xiao_serial));

static uint32_t disconnected_sleep_timeout_ms = 300000;
#define CONNECTED_SLEEP_TIMEOUT_MS 600000

static float cant_offset_deg;
static float pitch_offset_deg;
/* Atomic [mount profile, cant milli-degrees, pitch milli-degrees] record. */
static int32_t stored_orientation_zero[3];
static bool stored_orientation_zero_valid;
static struct of_gyro_bias gyro_bias;
static int32_t stored_gyro_bias[4]; /* profile, three milli-degrees/second */
static bool stored_gyro_bias_valid;
static struct k_work gyro_bias_persist_work;
static atomic_t gyro_cal_requests; /* bit 0 calibrate, bit 1 status */
static atomic_t gyro_cal_status; /* header states, 4 save failed, 5 saving */
static atomic_t gyro_cal_notify_pending;
static uint64_t last_activity_time_ms;
static int shot_count;
static uint32_t shot_id;
static uint32_t telemetry_sequence;
static uint32_t raw_sample_sequence;
static uint32_t ble_dropped_samples;
static uint32_t fifo_overrun_count;
static uint32_t fifo_resync_count;
static uint16_t gyro_cal_elapsed_ms;
static int64_t gyro_cal_started_ms;
static uint8_t fifo_fault_reason;
static int32_t fifo_fault_observed, fifo_fault_expected;
static int64_t led_shot_until_ms;
static float shot_accel_threshold_mps2 =
	DEFAULT_SHOT_ACCEL_THRESHOLD_G * MPS2_PER_G;
static float wake_sensitivity_g = 2.0f;
static float sleep_sensitivity_g = 0.15f;
static struct k_work shot_persist_work;
static struct k_work shot_log_persist_work;
/*
 * Delay before persisting the stored-shot log to RRAM after a shot while
 * connected. Long enough for the browser to ack the live frame and drain the
 * queue first, so the ~2.2 KB RRAM write only happens when a live frame was
 * actually lost.
 */
#define SHOT_LOG_RECONCILE_DELAY_MS 3000
static struct k_work_delayable shot_log_reconcile_work;
static struct k_work wake_sens_persist_work;
static struct k_work sleep_time_persist_work;
static struct k_work sleep_sens_persist_work;
static struct k_work offsets_persist_work;
static struct k_work_delayable battery_measure_work;
static volatile bool zero_requested;
static volatile bool trigger_shot_requested;
/* Set when a connected client subscribes, so the loop sends one count-sync
 * frame and the web app shows the persisted lifetime count immediately.
 */
static bool ble_send_count_sync;
static bool ble_send_storage_status;
static bool stored_shot_upload_in_progress;
static bool stored_shot_upload_requested;
static uint32_t stored_shot_upload_id;
static uint8_t fifo_drain_raw[LSM6DSL_FIFO_DRAIN_MAX_WORDS * sizeof(uint16_t)];
/*
 * The nRF54L15 OpenOCD helper has left the last few image bytes stale on this
 * board during bring-up. Keep harmless bytes at the ROM tail so live RAM
 * initializers never occupy that fragile end-of-image position.
 */
static const uint8_t openfloat_flash_tail_pad[32]
	__attribute__((used, section(".last_section"))) = {
		0x4f, 0x46, 0x50, 0x41, 0x44, 0x00, 0x5a, 0xa5,
	};
static struct bt_conn *current_conn;
static bool ble_notify_enabled;
static struct k_work_delayable adv_start_work;
static void tune_ble_link_work_handler(struct k_work *work);
static void stale_ble_disconnect_work_handler(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(tune_ble_link_work, tune_ble_link_work_handler);
static K_WORK_DELAYABLE_DEFINE(stale_ble_disconnect_work,
			       stale_ble_disconnect_work_handler);

static struct bt_uuid_128 openfloat_service_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8f3f3b10, 0x0f5a, 0x4f4c, 0x9a2d,
			   0x000000000001));
static struct bt_uuid_128 openfloat_live_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8f3f3b10, 0x0f5a, 0x4f4c, 0x9a2d,
			   0x000000000002));
static struct bt_uuid_128 openfloat_control_uuid = BT_UUID_INIT_128(
	BT_UUID_128_ENCODE(0x8f3f3b10, 0x0f5a, 0x4f4c, 0x9a2d,
			   0x000000000003));



struct quat {
	float w;
	float x;
	float y;
	float z;
};

struct imu_sample {
	struct vec3 accel;
	struct vec3 gyro;
};

struct stored_shot {
	uint16_t shot_count;
	uint32_t shot_id;
	int16_t ax_mg;
	int16_t ay_mg;
	int16_t az_mg;
	uint16_t threshold_cg;
	int16_t roll_cdeg;
	int16_t pitch_cdeg;
	int16_t yaw_cdeg;
	uint16_t clicker_dt_ms;
	uint16_t impact_dt_ms;
};

struct stored_shot_log {
	uint16_t count;
	struct stored_shot shots[STORED_SHOT_CAPACITY];
};

/* Accel of the most recent detected shot, reported in BLE shot-event frames. */
static struct vec3 last_shot_accel;
static struct stored_shot last_shot_record;
static uint16_t last_shot_sequence;
static struct stored_shot_log stored_shot_log;
/*
 * Guards stored_shot_log: appended by the main IMU loop, drained by shotack
 * on the Bluetooth RX thread, and snapshotted by the persist handlers on the
 * system workqueue. Hold only for short RAM copies, never across RRAM writes.
 */
static K_MUTEX_DEFINE(shot_log_mutex);

#define OFFLINE_TRACE_SLOT_COUNT 80
#define OFFLINE_TRACE_RATE_HZ 52
#define OFFLINE_TRACE_PRE_MS 3500
#define OFFLINE_TRACE_FOLLOW_MS 1500
#define TRACE_CAPACITY \
	(((OFFLINE_TRACE_PRE_MS + OFFLINE_TRACE_FOLLOW_MS) * OFFLINE_TRACE_RATE_HZ) / 1000)
#define TRACE_SCHEMA_VERSION 3
#define TRACE_MAGIC 0x4f465432u /* "OFT2" */

/* __packed so sizeof() is exactly 7 bytes; without it the trailing uint8_t
 * pads the struct to 8 and the raw memcpy upload ships a stride the decoder
 * does not expect, scrambling every trace. */
struct trace_point {
	int16_t roll_cdeg;
	int16_t pitch_cdeg;
	int16_t yaw_cdeg;
	uint8_t mic_amp;
} __packed;
struct stored_trace {
	uint32_t magic;
	uint16_t version;
	uint16_t count;
	uint32_t shot_id;
	struct trace_point points[TRACE_CAPACITY];
	uint8_t timing[OF_TRACE_HEADER_SIZE];
};
BUILD_ASSERT(sizeof(struct stored_trace) == 1884, "80 timed traces must fit RRAM");

static struct trace_point ram_trace_buffer[TRACE_CAPACITY];
static uint64_t ram_trace_ticks[TRACE_CAPACITY];
static uint64_t trace_output_tick, trace_event_tick, trace_due_tick, trace_event_uptime;
static uint32_t trace_boot_counter, trace_boot_id;
static uint32_t trace_decimate_counter;
static uint16_t trace_event_flags, trace_event_follow_ms;
/* Staging slots keep RRAM writes off the IMU loop even if a new shot arrives
 * before the prior follow-through window has elapsed. */
#define TRACE_PERSIST_STAGING_SLOTS 2
static struct stored_trace trace_persist_buffers[TRACE_PERSIST_STAGING_SLOTS];
static struct stored_trace trace_upload_buffer;
static uint16_t ram_trace_count = 0;
static uint16_t ram_trace_write_idx = 0;

static int buffer_rate_hz = 52;
static int buffer_nvs_enabled = 1;
static int ble_stream_divider = 1;
static int auto_sleep_enabled = 1;
static uint32_t trace_schema_version;
static struct k_work auto_sleep_persist_work;
static uint32_t follow_through_ms = 1500;
static struct k_work buffer_rate_persist_work;
static struct k_work buffer_nvs_persist_work;
static struct k_work streamrate_persist_work;
static struct k_work follow_through_persist_work;

static struct k_work trace_persist_work;
static struct k_work_delayable trace_upload_work;
static atomic_t trace_persist_pending_mask;
static uint8_t trace_persist_next_slot;

static bool trace_freeze_pending;
static uint32_t trace_freeze_shot_id;

static bool trace_upload_in_progress;
static int trace_upload_chunk_idx;
static bool trace_status_pending;
static uint32_t trace_status_shot_id;
static uint8_t trace_status_code;

static uint32_t stored_shot_evicted_count;
static int64_t stored_shot_upload_sent_ms;
static uint8_t stored_shot_upload_attempts;

static uint8_t trace_mic_amp_byte(void)
{
	int val_raw = (int)(audio_peak_raw / AUDIO_BLE_SCALE_DIVISOR);

	if (val_raw < 0) {
		val_raw = 0;
	}
	if (val_raw > 255) {
		val_raw = 255;
	}
	return (uint8_t)val_raw;
}

static void trace_slot_key(char *key, size_t key_len, uint32_t shot_id_value)
{
	snprintf(key, key_len, "openfloat/t%02u",
		 (unsigned int)(shot_id_value % OFFLINE_TRACE_SLOT_COUNT));
}

static void ram_trace_push(int16_t roll_cdeg, int16_t pitch_cdeg,
			   int16_t yaw_cdeg)
{
	ram_trace_ticks[ram_trace_write_idx] = trace_output_tick;
	ram_trace_buffer[ram_trace_write_idx].roll_cdeg = roll_cdeg;
	ram_trace_buffer[ram_trace_write_idx].pitch_cdeg = pitch_cdeg;
	ram_trace_buffer[ram_trace_write_idx].yaw_cdeg = yaw_cdeg;
	ram_trace_buffer[ram_trace_write_idx].mic_amp = trace_mic_amp_byte();
	ram_trace_write_idx = (ram_trace_write_idx + 1) % TRACE_CAPACITY;
	if (ram_trace_count < TRACE_CAPACITY) {
		ram_trace_count++;
	}
}

static void ram_trace_freeze(struct stored_trace *dest)
{
	dest->count = ram_trace_count;
	uint16_t read_idx = 0;
	if (ram_trace_count == TRACE_CAPACITY) {
		read_idx = ram_trace_write_idx;
	}
	for (uint16_t i = 0; i < ram_trace_count; i++) {
		dest->points[i] = ram_trace_buffer[read_idx];
		read_idx = (read_idx + 1) % TRACE_CAPACITY;
	}
}

static void trace_freeze_pending_slot(void)
{
	if (!trace_freeze_pending) {
		return;
	}

	int persist_slot = trace_persist_next_slot % TRACE_PERSIST_STAGING_SLOTS;
	if (atomic_get(&trace_persist_pending_mask) & BIT(persist_slot)) {
		printk("# trace staging busy; dropping shot=%u trace\n",
		       trace_freeze_shot_id);
		trace_freeze_pending = false;
		return;
	}
	trace_persist_next_slot++;
	struct stored_trace *trace = &trace_persist_buffers[persist_slot];
	trace->magic = TRACE_MAGIC;
	trace->version = TRACE_SCHEMA_VERSION;
	trace->shot_id = trace_freeze_shot_id;
	ram_trace_freeze(trace);
	uint16_t first = ram_trace_count == TRACE_CAPACITY ? ram_trace_write_idx : 0;
	uint16_t last = (ram_trace_write_idx + TRACE_CAPACITY - 1) % TRACE_CAPACITY;
	struct of_trace_info info = {
		.shot_id = trace->shot_id, .boot_id = trace_boot_id,
		.period_num_us = SAMPLES_PER_OUTPUT * 1000000u * OF_OFFLINE_TRACE_STRIDE,
		.period_den = IMU_ODR_HZ, .event_uptime_us = trace_event_uptime,
		.first_tick = (int32_t)((int64_t)ram_trace_ticks[first] - (int64_t)trace_event_tick),
		.stride = OF_OFFLINE_TRACE_STRIDE, .count = trace->count,
		.flags = trace_event_flags, .follow_ms = trace_event_follow_ms, .mount = OPENFLOAT_MOUNT,
	};
	info.event_index = of_trace_event_index(info.first_tick, info.stride, info.count);
	if (trace->count < TRACE_CAPACITY) info.flags |= OF_TRACE_PRE_SHORT;
	if (!trace->count || ram_trace_ticks[last] < trace_due_tick) info.flags |= OF_TRACE_POST_SHORT;
	if (!trace_boot_id) info.flags |= OF_TRACE_BOOT_UNKNOWN;
	if (info.event_index == UINT16_MAX) info.flags |= OF_TRACE_EVENT_OUTSIDE;
	of_trace_header(trace->timing, &info, (const uint8_t *)trace->points);
	if (buffer_nvs_enabled) {
		atomic_or(&trace_persist_pending_mask, BIT(persist_slot));
		k_work_submit(&trace_persist_work);
	}

	printk("# trace frozen: shot=%u slot=%u count=%u follow_ms=%u\n",
	       trace_freeze_shot_id,
	       trace_freeze_shot_id % OFFLINE_TRACE_SLOT_COUNT,
	       trace->count, follow_through_ms);
	trace_freeze_pending = false;
}

/* Called only by the IMU thread. Event and sample indices share its clock;
 * a workqueue timer must never race the ring buffer or FIFO processing. */
static void schedule_trace_freeze(uint32_t shot_id_value, bool simulated)
{
	if (trace_freeze_pending) trace_freeze_pending_slot();
	trace_freeze_shot_id = shot_id_value;
	trace_event_tick = trace_output_tick;
	trace_event_uptime = k_ticks_to_us_floor64(k_uptime_ticks()); /* Processing timestamp, not sensor wall time. */
	trace_event_follow_ms = (uint16_t)follow_through_ms;
	trace_due_tick = trace_event_tick + of_trace_follow_ticks(follow_through_ms, IMU_ODR_HZ, SAMPLES_PER_OUTPUT);
	trace_event_flags = simulated ? OF_TRACE_SIMULATED : 0;
	trace_freeze_pending = true;
}

static void trace_stream_gap(void)
{
	if (trace_freeze_pending) {
		trace_event_flags |= OF_TRACE_GAP;
		trace_freeze_pending_slot();
	}
	ram_trace_count = ram_trace_write_idx = 0;
	trace_decimate_counter = 0;
}

struct trace_load_context {
	uint32_t shot_id;
	bool loaded;
};

static int trace_load_direct(const char *key, size_t len,
			     settings_read_cb read_cb, void *cb_arg, void *param)
{
	struct trace_load_context *context = param;
	ssize_t rc;

	ARG_UNUSED(key);
	if (len != sizeof(trace_upload_buffer) && len != sizeof(trace_upload_buffer) - OF_TRACE_HEADER_SIZE) {
		return 0;
	}
	memset(&trace_upload_buffer, 0, sizeof(trace_upload_buffer));
	rc = read_cb(cb_arg, &trace_upload_buffer, len);
	if (rc != (ssize_t)len) {
		return rc < 0 ? (int)rc : -EINVAL;
	}
	if (trace_upload_buffer.magic != TRACE_MAGIC ||
	    (trace_upload_buffer.version != 2 && trace_upload_buffer.version != TRACE_SCHEMA_VERSION) ||
	    (trace_upload_buffer.version == 2 && len != sizeof(trace_upload_buffer) - OF_TRACE_HEADER_SIZE) ||
	    (trace_upload_buffer.version == 3 && len != sizeof(trace_upload_buffer)) ||
	    trace_upload_buffer.shot_id != context->shot_id ||
	    trace_upload_buffer.count == 0 ||
	    trace_upload_buffer.count > TRACE_CAPACITY) {
		return 0;
	}
	context->loaded = true;
	/* The requested slot is exact; stop the storage walk after its newest
	 * value has been read. */
	return 1;
}

static bool trace_load_for_upload(uint32_t shot_id_value)
{
	char key[32];
	struct trace_load_context context = {
		.shot_id = shot_id_value,
		.loaded = false,
	};

	trace_slot_key(key, sizeof(key), shot_id_value);
	int rc = settings_load_subtree_direct(key, trace_load_direct, &context);
	if (rc) {
		printk("# trace load failed for shot=%u: %d\n", shot_id_value, rc);
		return false;
	}
	return context.loaded;
}

static void stored_shot_append(const struct stored_shot *shot)
{
	k_mutex_lock(&shot_log_mutex, K_FOREVER);
	if (stored_shot_log.count >= STORED_SHOT_CAPACITY) {
		memmove(&stored_shot_log.shots[0], &stored_shot_log.shots[1],
			(STORED_SHOT_CAPACITY - 1) *
				sizeof(stored_shot_log.shots[0]));
		stored_shot_log.count = STORED_SHOT_CAPACITY - 1;
		stored_shot_evicted_count++;
	}

	stored_shot_log.shots[stored_shot_log.count++] = *shot;
	k_mutex_unlock(&shot_log_mutex);
}

static bool stored_shot_remove(uint32_t shot_id)
{
	bool removed = false;

	k_mutex_lock(&shot_log_mutex, K_FOREVER);
	for (uint16_t i = 0; i < stored_shot_log.count; i++) {
		if (stored_shot_log.shots[i].shot_id != shot_id) {
			continue;
		}

		if (i + 1 < stored_shot_log.count) {
			memmove(&stored_shot_log.shots[i],
				&stored_shot_log.shots[i + 1],
				(stored_shot_log.count - i - 1) *
					sizeof(stored_shot_log.shots[0]));
		}
		stored_shot_log.count--;
		removed = true;
		break;
	}
	k_mutex_unlock(&shot_log_mutex);

	return removed;
}

static bool stored_shot_peek_first(struct stored_shot *out)
{
	bool have;

	k_mutex_lock(&shot_log_mutex, K_FOREVER);
	have = stored_shot_log.count > 0;
	if (have) {
		*out = stored_shot_log.shots[0];
	}
	k_mutex_unlock(&shot_log_mutex);

	return have;
}

static uint16_t stored_shot_count_snapshot(void)
{
	uint16_t count;

	k_mutex_lock(&shot_log_mutex, K_FOREVER);
	count = stored_shot_log.count;
	k_mutex_unlock(&shot_log_mutex);

	return count;
}

static int32_t scale_float(float value, float scale)
{
	float scaled = value * scale;

	return (int32_t)(scaled + (scaled >= 0.0f ? 0.5f : -0.5f));
}

static int16_t clamp_i16(int32_t value);

static uint64_t uptime_us(void)
{
	return k_ticks_to_us_floor64(k_uptime_ticks());
}

static float inv_sqrtf(float value)
{
	return 1.0f / sqrtf(value);
}

static void normalize_quat(struct quat *q)
{
	float norm = inv_sqrtf((q->w * q->w) + (q->x * q->x) +
			       (q->y * q->y) + (q->z * q->z));

	q->w *= norm;
	q->x *= norm;
	q->y *= norm;
	q->z *= norm;
}

static void madgwick_update_imu(struct quat *q, const struct vec3 *gyro,
				const struct vec3 *accel, float dt_s)
{
	float q1 = q->w;
	float q2 = q->x;
	float q3 = q->y;
	float q4 = q->z;
	float gx = gyro->x;
	float gy = gyro->y;
	float gz = gyro->z;
	float ax = accel->x;
	float ay = accel->y;
	float az = accel->z;
	float recip_norm;
	float s1;
	float s2;
	float s3;
	float s4;
	float q_dot1;
	float q_dot2;
	float q_dot3;
	float q_dot4;
	float two_q1 = 2.0f * q1;
	float two_q2 = 2.0f * q2;
	float two_q3 = 2.0f * q3;
	float two_q4 = 2.0f * q4;
	float four_q1 = 4.0f * q1;
	float four_q2 = 4.0f * q2;
	float four_q3 = 4.0f * q3;
	float eight_q2 = 8.0f * q2;
	float eight_q3 = 8.0f * q3;
	float q1q1 = q1 * q1;
	float q2q2 = q2 * q2;
	float q3q3 = q3 * q3;
	float q4q4 = q4 * q4;

	q_dot1 = 0.5f * ((-q2 * gx) - (q3 * gy) - (q4 * gz));
	q_dot2 = 0.5f * ((q1 * gx) + (q3 * gz) - (q4 * gy));
	q_dot3 = 0.5f * ((q1 * gy) - (q2 * gz) + (q4 * gx));
	q_dot4 = 0.5f * ((q1 * gz) + (q2 * gy) - (q3 * gx));

	if ((ax != 0.0f) || (ay != 0.0f) || (az != 0.0f)) {
		recip_norm = inv_sqrtf((ax * ax) + (ay * ay) + (az * az));
		ax *= recip_norm;
		ay *= recip_norm;
		az *= recip_norm;

		s1 = (four_q1 * q3q3) + (two_q3 * ax) +
		     (four_q1 * q2q2) - (two_q2 * ay);
		s2 = (four_q2 * q4q4) - (two_q4 * ax) +
		     (4.0f * q1q1 * q2) - (two_q1 * ay) -
		     four_q2 + (eight_q2 * q2q2) + (eight_q2 * q3q3) +
		     (four_q2 * az);
		s3 = (4.0f * q1q1 * q3) + (two_q1 * ax) +
		     (four_q3 * q4q4) - (two_q4 * ay) -
		     four_q3 + (eight_q3 * q2q2) + (eight_q3 * q3q3) +
		     (four_q3 * az);
		s4 = (4.0f * q2q2 * q4) - (two_q2 * ax) +
		     (4.0f * q3q3 * q4) - (two_q3 * ay);

		/* An exactly aligned stationary IMU has a zero gradient. */
		float gradient_norm2 = (s1 * s1) + (s2 * s2) + (s3 * s3) + (s4 * s4);
		recip_norm = gradient_norm2 > 1e-12f ? inv_sqrtf(gradient_norm2) : 0.0f;
		s1 *= recip_norm;
		s2 *= recip_norm;
		s3 *= recip_norm;
		s4 *= recip_norm;

		q_dot1 -= MADGWICK_BETA * s1;
		q_dot2 -= MADGWICK_BETA * s2;
		q_dot3 -= MADGWICK_BETA * s3;
		q_dot4 -= MADGWICK_BETA * s4;
	}

	q->w += q_dot1 * dt_s;
	q->x += q_dot2 * dt_s;
	q->y += q_dot3 * dt_s;
	q->z += q_dot4 * dt_s;
	normalize_quat(q);
}

static void quat_to_euler(const struct quat *q, float *roll_deg,
			  float *pitch_deg, float *yaw_deg)
{
	float sinr_cosp = 2.0f * ((q->w * q->x) + (q->y * q->z));
	float cosr_cosp = 1.0f - (2.0f * ((q->x * q->x) + (q->y * q->y)));
	float sinp = 2.0f * ((q->w * q->y) - (q->z * q->x));
	float siny_cosp = 2.0f * ((q->w * q->z) + (q->x * q->y));
	float cosy_cosp = 1.0f - (2.0f * ((q->y * q->y) + (q->z * q->z)));

	*roll_deg = atan2f(sinr_cosp, cosr_cosp) * RAD_TO_DEG;

	if (fabsf(sinp) >= 1.0f) {
		*pitch_deg = copysignf(90.0f, sinp);
	} else {
		*pitch_deg = asinf(sinp) * RAD_TO_DEG;
	}

	*yaw_deg = atan2f(siny_cosp, cosy_cosp) * RAD_TO_DEG;
}

static void apply_mount_rotation(struct vec3 *v)
{
	openfloat_mount_rotate(&v->x, &v->y, &v->z);
}

static int16_t le16_to_s16(const uint8_t *buf)
{
	return (int16_t)((uint16_t)buf[0] | ((uint16_t)buf[1] << 8));
}

static void convert_raw_direct_sample(const uint8_t raw[LSM6DSL_FIFO_BYTES_PER_SAMPLE],
				      struct vec3 *accel, struct vec3 *gyro)
{
	int16_t raw_gx = le16_to_s16(&raw[0]);
	int16_t raw_gy = le16_to_s16(&raw[2]);
	int16_t raw_gz = le16_to_s16(&raw[4]);
	int16_t raw_ax = le16_to_s16(&raw[6]);
	int16_t raw_ay = le16_to_s16(&raw[8]);
	int16_t raw_az = le16_to_s16(&raw[10]);

	accel->x = (float)raw_ax * LSM6DSL_ACCEL_16G_MPS2_PER_LSB;
	accel->y = (float)raw_ay * LSM6DSL_ACCEL_16G_MPS2_PER_LSB;
	accel->z = (float)raw_az * LSM6DSL_ACCEL_16G_MPS2_PER_LSB;
	gyro->x = (float)raw_gx * LSM6DSL_GYRO_2000DPS_RAD_PER_S_PER_LSB;
	gyro->y = (float)raw_gy * LSM6DSL_GYRO_2000DPS_RAD_PER_S_PER_LSB;
	gyro->z = (float)raw_gz * LSM6DSL_GYRO_2000DPS_RAD_PER_S_PER_LSB;

	apply_mount_rotation(accel);
	apply_mount_rotation(gyro);
}

static int configure_imu_fifo(void)
{
	int err;

	err = i2c_reg_write_byte_dt(&imu_i2c, LSM6DSL_REG_FIFO_CTRL5,
				    LSM6DSL_FIFO_MODE_BYPASS);
	if (err) {
		printk("# Could not reset IMU FIFO: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(&imu_i2c, LSM6DSL_REG_FIFO_CTRL1,
				    LSM6DSL_FIFO_WATERMARK_WORDS & 0xff);
	if (err) {
		printk("# Could not set IMU FIFO watermark low byte: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(
		&imu_i2c, LSM6DSL_REG_FIFO_CTRL2,
		(LSM6DSL_FIFO_WATERMARK_WORDS >> 8) & 0x07);
	if (err) {
		printk("# Could not set IMU FIFO watermark high byte: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(
		&imu_i2c, LSM6DSL_REG_FIFO_CTRL3,
		(LSM6DSL_FIFO_DEC_NO << 3) | LSM6DSL_FIFO_DEC_NO);
	if (err) {
		printk("# Could not enable accel/gyro FIFO batching: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(&imu_i2c, LSM6DSL_REG_FIFO_CTRL4, 0);
	if (err) {
		printk("# Could not clear IMU FIFO extra dataset config: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(
		&imu_i2c, LSM6DSL_REG_FIFO_CTRL5,
		(LSM6DSL_IMU_ODR_REG << 3) | LSM6DSL_FIFO_MODE_STREAM);
	if (err) {
		printk("# Could not start IMU FIFO stream mode: %d\n", err);
		return err;
	}

	/* Route the FIFO watermark (FTH) condition to the INT1 pin (P0.02). */
	err = i2c_reg_write_byte_dt(&imu_i2c, LSM6DSL_REG_INT1_CTRL,
				    LSM6DSL_INT1_CTRL_FTH);
	if (err) {
		printk("# Could not route FIFO watermark to INT1: %d\n", err);
		return err;
	}

	return 0;
}

static int configure_imu_raw_registers(void)
{
	uint8_t who_am_i;
	int err;

	if (!device_is_ready(imu_i2c.bus)) {
		printk("# IMU I2C bus %s is not ready\n", imu_i2c.bus->name);
		return -ENODEV;
	}

	err = i2c_reg_read_byte_dt(&imu_i2c, LSM6DSL_REG_WHO_AM_I, &who_am_i);
	if (err) {
		printk("# Could not read IMU WHO_AM_I: %d\n", err);
		return err;
	}
	if (who_am_i != LSM6DSL_WHO_AM_I) {
		printk("# Unexpected IMU WHO_AM_I: 0x%02x\n", who_am_i);
		return -ENODEV;
	}

	/* Reset sleep/wake registers (TAP_CFG, WAKE_UP_THS, MD1_CFG) to defaults */
	(void)i2c_reg_write_byte_dt(&imu_i2c, 0x58, 0x00);
	(void)i2c_reg_write_byte_dt(&imu_i2c, 0x5B, 0x00);
	(void)i2c_reg_write_byte_dt(&imu_i2c, 0x5E, 0x00);

	err = i2c_reg_update_byte_dt(&imu_i2c, LSM6DSL_REG_CTRL3_C,
				     LSM6DSL_CTRL3_C_BDU |
					     LSM6DSL_CTRL3_C_IF_INC,
				     LSM6DSL_CTRL3_C_BDU |
					     LSM6DSL_CTRL3_C_IF_INC);
	if (err) {
		printk("# Could not enable IMU BDU/auto-increment: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(
		&imu_i2c, LSM6DSL_REG_CTRL1_XL,
		(LSM6DSL_IMU_ODR_REG << 4) | (LSM6DSL_ACCEL_FS_16G << 2));
	if (err) {
		printk("# Could not set raw accelerometer config: %d\n", err);
		return err;
	}

	err = i2c_reg_write_byte_dt(
		&imu_i2c, LSM6DSL_REG_CTRL2_G,
		(LSM6DSL_IMU_ODR_REG << 4) | (LSM6DSL_GYRO_FS_2000DPS << 2));
	if (err) {
		printk("# Could not set raw gyroscope config: %d\n", err);
		return err;
	}

	err = i2c_reg_update_byte_dt(&imu_i2c, LSM6DSL_REG_CTRL6_C,
				     LSM6DSL_CTRL6_C_XL_HM_MODE, 0);
	if (err) {
		printk("# Could not enable accelerometer high performance: %d\n",
		       err);
		return err;
	}

	err = i2c_reg_update_byte_dt(&imu_i2c, LSM6DSL_REG_CTRL7_G,
				     LSM6DSL_CTRL7_G_HM_MODE, 0);
	if (err) {
		printk("# Could not enable gyroscope high performance: %d\n", err);
		return err;
	}

	err = configure_imu_fifo();
	if (err) {
		return err;
	}

	return 0;
}

static int prepare_imu_for_sleep(void)
{
	int err;
	uint8_t ths_val;

	/* 1. Stop FIFO stream */
	err = i2c_reg_write_byte_dt(&imu_i2c, LSM6DSL_REG_FIFO_CTRL5, LSM6DSL_FIFO_MODE_BYPASS);
	if (err) return err;

	/* 2. Power down gyroscope */
	err = i2c_reg_write_byte_dt(&imu_i2c, LSM6DSL_REG_CTRL2_G, 0x00);
	if (err) return err;

	/* 3. Configure accelerometer ODR to 26 Hz, low power */
	/* CTRL1_XL: 26 Hz ODR (0x20) and FS +/- 16g (0x04) */
	err = i2c_reg_write_byte_dt(&imu_i2c, LSM6DSL_REG_CTRL1_XL, 0x24);
	if (err) return err;

	/* 4. Enable latched interrupts in TAP_CFG (0x58) */
	err = i2c_reg_write_byte_dt(&imu_i2c, 0x58, 0x80);
	if (err) return err;

	/* 5. Set wake-up threshold (1 LSB = 16g / 64 = 0.25g) */
	ths_val = (uint8_t)(wake_sensitivity_g / 0.25f);
	if (ths_val < 1) ths_val = 1;
	if (ths_val > 63) ths_val = 63;
	err = i2c_reg_write_byte_dt(&imu_i2c, 0x5B, ths_val);
	if (err) return err;

	/* 6. Set wake duration to 0 */
	err = i2c_reg_write_byte_dt(&imu_i2c, 0x5C, 0x00);
	if (err) return err;

	/* 7. Route wake-up to INT1 in MD1_CFG (0x5E) */
	err = i2c_reg_write_byte_dt(&imu_i2c, 0x5E, 0x20);
	if (err) return err;

	return 0;
}

static void enter_deep_sleep(void)
{
	int err;
	/* Finish follow-through and RRAM writes before powering off. */
	if (trace_freeze_pending || atomic_get(&trace_persist_pending_mask)) return;
	struct k_work_sync sync;
	(void)k_work_flush(&shot_log_persist_work, &sync);

	/* 1. Turn off user LED if active */
	gpio_pin_set_dt(&user_led, 0);

	/* Stop PDM audio capture */
	stop_pdm();

	/* 2. Disconnect BLE and stop advertising */
	if (current_conn) {
		bt_conn_disconnect(current_conn, BT_HCI_ERR_REMOTE_POWER_OFF);
		/* Wait a moment for disconnect callback to complete and clean up */
		k_sleep(K_MSEC(200));
	}
	bt_le_adv_stop();

	/* 3. Prepare the IMU for Wake-up interrupt mode */
	err = prepare_imu_for_sleep();
	if (err) {
		printk("# Failed to configure IMU for wake: %d. Resetting SoC...\n", err);
		sys_reboot(SYS_REBOOT_COLD);
	}

	/* 4. Configure P0.02 GPIO interrupt as level active trigger.
	 * In Zephyr, for nRF SoCs, level-trigger enables the GPIO SENSE high/low logic,
	 * which is the only wake-up source active in System OFF.
	 */
	if (gpio_is_ready_dt(&imu_int)) {
		/* Disable active handler to avoid firing ISR */
		gpio_pin_interrupt_configure_dt(&imu_int, GPIO_INT_DISABLE);
		/* Configure level active trigger for SENSE wakeup */
		gpio_pin_interrupt_configure_dt(&imu_int, GPIO_INT_LEVEL_ACTIVE);
	}

	printk("# Powering down System OFF now. Wake up on movement/shot.\n");
	/* Wait for print to finish */
	k_sleep(K_MSEC(50));

	/* 5. Enter System OFF */
	sys_poweroff();
}

static int configure_imu(void)
{
	int err;

	err = configure_imu_raw_registers();
	if (err) {
		return err;
	}

	printk("# IMU ready: raw FIFO I2C on %s@0x%02x, accel+gyro ODR %d Hz, accel +/- %dg, gyro +/- %d dps\n",
	       imu_i2c.bus->name, imu_i2c.addr, IMU_ODR_HZ, IMU_ACCEL_FS_G,
	       IMU_GYRO_FS_DPS);

	return 0;
}

static void imu_int_handler(const struct device *dev,
			    struct gpio_callback *cb, uint32_t pins)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(cb);
	ARG_UNUSED(pins);

	/*
	 * The FTH line stays high while the FIFO is above the watermark, so it is
	 * level sensitive. Mask it here and let the main loop re-arm it after it
	 * has drained the FIFO back below the threshold; otherwise it would
	 * re-fire continuously.
	 */
	gpio_pin_interrupt_configure_dt(&imu_int, GPIO_INT_DISABLE);
	k_sem_give(&imu_fifo_sem);
}

/*
 * Wire the LSM6DSL INT1 pin (P0.02 on this board, irq-gpios in devicetree) to a
 * level-triggered GPIO interrupt so the FIFO watermark wakes the main loop
 * instead of busy-polling FIFO_STATUS. Returns 0 on success; on failure the
 * caller falls back to polling.
 */
static int init_imu_interrupt(void)
{
	int err;

	if (imu_int.port == NULL || !gpio_is_ready_dt(&imu_int)) {
		printk("# IMU INT GPIO not available; using FIFO polling\n");
		return -ENODEV;
	}

	err = gpio_pin_configure_dt(&imu_int, GPIO_INPUT);
	if (err) {
		printk("# Could not configure IMU INT GPIO: %d\n", err);
		return err;
	}

	gpio_init_callback(&imu_int_cb, imu_int_handler, BIT(imu_int.pin));
	err = gpio_add_callback(imu_int.port, &imu_int_cb);
	if (err) {
		printk("# Could not add IMU INT callback: %d\n", err);
		return err;
	}

	err = gpio_pin_interrupt_configure_dt(&imu_int, GPIO_INT_LEVEL_ACTIVE);
	if (err) {
		printk("# Could not enable IMU INT: %d\n", err);
		return err;
	}

	printk("# IMU INT1 watermark on %s pin %d, FTH=%d samples\n",
	       imu_int.port->name, imu_int.pin, LSM6DSL_FIFO_WATERMARK_SAMPLES);
	return 0;
}

/* Read a status snapshot or FIFO bytes and preserve the actual driver error. */
static int imu_fifo_read(uint8_t reg, uint8_t *data, size_t length)
{
	int err = i2c_burst_read_dt(&imu_i2c, reg, data, length);
	if (err) {
		fifo_fault_reason = OF_GYRO_I2C_ERROR;
		fifo_fault_observed = err;
		fifo_fault_expected = 0;
	}
	return err;
}

static uint16_t imu_fifo_pattern(const uint8_t status[4])
{
	return ((uint16_t)status[2] | ((uint16_t)(status[3] & 0x03) << 8));
}

static int imu_fifo_overflow(const uint8_t status[4])
{
	fifo_overrun_count++;
	fifo_fault_reason = OF_GYRO_FIFO_OVERFLOW;
	fifo_fault_observed = status[1];
	fifo_fault_expected = 0;
	int err = configure_imu_fifo();
	if (err) {
		fifo_fault_reason = OF_GYRO_I2C_ERROR;
		fifo_fault_observed = err;
	}
	return err;
}

static int read_imu_fifo(struct imu_sample *out, uint32_t max_samples,
			 uint32_t *count)
{
	uint8_t status[4];
	*count = 0;
	fifo_fault_reason = 0;
	fifo_fault_observed = fifo_fault_expected = 0;
	int err = imu_fifo_read(LSM6DSL_REG_FIFO_STATUS1, status, sizeof(status));
	if (err) return err;
	if (status[1] & (LSM6DSL_FIFO_STATUS2_OVER_RUN |
			 LSM6DSL_FIFO_STATUS2_FIFO_FULL_SMART)) return imu_fifo_overflow(status);

	uint16_t fifo_words = (uint16_t)status[0] | ((uint16_t)(status[1] & 0x07) << 8);
	if (fifo_words == 0) return 0;
	uint16_t pattern = imu_fifo_pattern(status);
	if (pattern != 0) {
		/* No partial sample is retained across transfers. Realign once and
		 * wait for the next status snapshot; never emit this recovery batch. */
		fifo_resync_count++;
		fifo_fault_reason = OF_GYRO_FIFO_ALIGNMENT;
		fifo_fault_observed = pattern;
		if (pattern >= LSM6DSL_FIFO_WORDS_PER_SAMPLE) {
			/* Unexpected configuration or corrupt status: do not hide it with %6. */
			err = configure_imu_fifo();
			if (err) {
				fifo_fault_reason = OF_GYRO_I2C_ERROR;
				fifo_fault_observed = err;
			}
			return err;
		}
		uint16_t drop = MIN(LSM6DSL_FIFO_WORDS_PER_SAMPLE - pattern, fifo_words);
		return imu_fifo_read(LSM6DSL_REG_FIFO_DATA_OUT_L, fifo_drain_raw,
				     drop * sizeof(uint16_t));
	}

	/* Only complete Gx,Gy,Gz,Ax,Ay,Az sets. Leave a trailing partial set in
	 * the hardware FIFO until it is complete. Limit bursts to 192 bytes. */
	uint16_t samples = MIN(fifo_words / LSM6DSL_FIFO_WORDS_PER_SAMPLE,
			      MIN(max_samples, LSM6DSL_FIFO_DRAIN_MAX_SAMPLES));
	if (samples == 0) return 0;
	err = imu_fifo_read(LSM6DSL_REG_FIFO_DATA_OUT_L, fifo_drain_raw,
			    samples * LSM6DSL_FIFO_BYTES_PER_SAMPLE);
	if (err) return err;

	/* Validate BEFORE converting/feeding fusion. The previous implementation
	 * only detected a lost word on the next drain, after using the bad batch. */
	err = imu_fifo_read(LSM6DSL_REG_FIFO_STATUS1, status, sizeof(status));
	if (err) return err;
	if (status[1] & (LSM6DSL_FIFO_STATUS2_OVER_RUN |
			 LSM6DSL_FIFO_STATUS2_FIFO_FULL_SMART)) return imu_fifo_overflow(status);
	pattern = imu_fifo_pattern(status);
	if (pattern != 0) {
		fifo_resync_count++;
		fifo_fault_reason = OF_GYRO_FIFO_ALIGNMENT;
		fifo_fault_observed = pattern;
		return 0;
	}
	for (uint16_t i = 0; i < samples; i++) {
		convert_raw_direct_sample(&fifo_drain_raw[i * LSM6DSL_FIFO_BYTES_PER_SAMPLE],
					  &out[i].accel, &out[i].gyro);
	}
	*count = samples;
	return 0;
}

static void init_user_led(void)
{
	if (user_led.port == NULL || !gpio_is_ready_dt(&user_led)) {
		printk("# User LED not ready\n");
		return;
	}

	int err = gpio_pin_configure_dt(&user_led, GPIO_OUTPUT_INACTIVE);

	if (err) {
		printk("# User LED configure failed: %d\n", err);
	}
}

static void init_user_btn(void)
{
	if (user_btn.port == NULL || !gpio_is_ready_dt(&user_btn)) {
		printk("# User button not ready\n");
		return;
	}

	int err = gpio_pin_configure_dt(&user_btn, GPIO_INPUT);

	if (err) {
		printk("# User button configure failed: %d\n", err);
	}
}

static bool user_btn_pressed(void)
{
	static bool was_pressed;
	bool pressed;

	if (user_btn.port == NULL || !gpio_is_ready_dt(&user_btn)) {
		return false;
	}

	pressed = gpio_pin_get_dt(&user_btn) > 0;

	if (pressed && !was_pressed) {
		was_pressed = true;
		return true;
	}

	if (!pressed) {
		was_pressed = false;
	}

	return false;
}

static void update_user_led(void)
{
	static int64_t last_toggle_ms;
	static bool led_on;
	int64_t now_ms = k_uptime_get();

	if (user_led.port == NULL || !gpio_is_ready_dt(&user_led)) {
		return;
	}

	if (led_shot_until_ms > now_ms) {
		(void)gpio_pin_set_dt(&user_led, 1);
		return;
	}

	if ((now_ms - last_toggle_ms) < LED_IDLE_PERIOD_MS) {
		return;
	}

	last_toggle_ms = now_ms;
	led_on = !led_on;
	(void)gpio_pin_set_dt(&user_led, led_on);
}

/* Returns true if a new shot was detected on this call. */
static bool detect_shot(const struct vec3 *accel, const struct vec3 *gyro, uint64_t now_us,
			float roll_deg, float pitch_deg, float yaw_deg)
{
	static int64_t last_shot_ms;
	float mag2 = (accel->x * accel->x) + (accel->y * accel->y) +
		     (accel->z * accel->z);
	float threshold = shot_accel_threshold_mps2;
	float thresh2 = threshold * threshold;
	int64_t now_ms = k_uptime_get();

	float gyro_mag2 = (gyro->x * gyro->x) + (gyro->y * gyro->y) + (gyro->z * gyro->z);
	float min_gyro_rad_s = 1.5f; /* ~85 deg/s minimum rotation during recoil */
	float min_gyro_rad_s2 = min_gyro_rad_s * min_gyro_rad_s;

	if (mag2 > thresh2 && gyro_mag2 > min_gyro_rad_s2 && (now_ms - last_shot_ms) > SHOT_REFRACTORY_MS) {
		last_shot_ms = now_ms;
		return true;
	}

	return false;
}

/* Settings key "openfloat/shots" holds the lifetime shot count in RRAM. */
static int openfloat_settings_set(const char *name, size_t len,
				  settings_read_cb read_cb, void *cb_arg)
{
	if (settings_name_steq(name, "shots", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		shot_count = (int)value;
		shot_id = value;
		return 0;
	}

	if (settings_name_steq(name, "shotlog", NULL)) {
		struct stored_shot_log value;
		ssize_t rc;

		if (len != sizeof(value)) {
			/* Backward compatible migration for older smaller stored_shot_log formats. */
			if (len == 2 + 22 * STORED_SHOT_CAPACITY) {
				static struct {
					uint16_t count;
					struct {
						uint16_t shot_count;
						uint16_t shot_id;
						int16_t ax_mg;
						int16_t ay_mg;
						int16_t az_mg;
						uint16_t threshold_cg;
						int16_t roll_cdeg;
						int16_t pitch_cdeg;
						int16_t yaw_cdeg;
						uint16_t clicker_dt_ms;
						uint16_t impact_dt_ms;
					} shots[STORED_SHOT_CAPACITY];
				} old_log;
				if (len == sizeof(old_log)) {
					rc = read_cb(cb_arg, &old_log, sizeof(old_log));
					if (rc >= 0 && old_log.count <= STORED_SHOT_CAPACITY) {
						stored_shot_log.count = old_log.count;
						for (int i = 0; i < old_log.count; i++) {
							stored_shot_log.shots[i].shot_count = old_log.shots[i].shot_count;
							stored_shot_log.shots[i].shot_id = old_log.shots[i].shot_id;
							stored_shot_log.shots[i].ax_mg = old_log.shots[i].ax_mg;
							stored_shot_log.shots[i].ay_mg = old_log.shots[i].ay_mg;
							stored_shot_log.shots[i].az_mg = old_log.shots[i].az_mg;
							stored_shot_log.shots[i].threshold_cg = old_log.shots[i].threshold_cg;
							stored_shot_log.shots[i].roll_cdeg = old_log.shots[i].roll_cdeg;
							stored_shot_log.shots[i].pitch_cdeg = old_log.shots[i].pitch_cdeg;
							stored_shot_log.shots[i].yaw_cdeg = old_log.shots[i].yaw_cdeg;
							stored_shot_log.shots[i].clicker_dt_ms = old_log.shots[i].clicker_dt_ms;
							stored_shot_log.shots[i].impact_dt_ms = old_log.shots[i].impact_dt_ms;
						}
						return 0;
					}
				}
			}
			if (len == 2 + 18 * STORED_SHOT_CAPACITY) {
				static struct {
					uint16_t count;
					struct {
						uint16_t shot_count;
						uint16_t shot_id;
						int16_t ax_mg;
						int16_t ay_mg;
						int16_t az_mg;
						uint16_t threshold_cg;
						int16_t roll_cdeg;
						int16_t pitch_cdeg;
						int16_t yaw_cdeg;
					} shots[STORED_SHOT_CAPACITY];
				} old_log;
				if (len == sizeof(old_log)) {
					rc = read_cb(cb_arg, &old_log, sizeof(old_log));
					if (rc >= 0 && old_log.count <= STORED_SHOT_CAPACITY) {
						stored_shot_log.count = old_log.count;
						for (int i = 0; i < old_log.count; i++) {
							stored_shot_log.shots[i].shot_count = old_log.shots[i].shot_count;
							stored_shot_log.shots[i].shot_id = old_log.shots[i].shot_id;
							stored_shot_log.shots[i].ax_mg = old_log.shots[i].ax_mg;
							stored_shot_log.shots[i].ay_mg = old_log.shots[i].ay_mg;
							stored_shot_log.shots[i].az_mg = old_log.shots[i].az_mg;
							stored_shot_log.shots[i].threshold_cg = old_log.shots[i].threshold_cg;
							stored_shot_log.shots[i].roll_cdeg = old_log.shots[i].roll_cdeg;
							stored_shot_log.shots[i].pitch_cdeg = old_log.shots[i].pitch_cdeg;
							stored_shot_log.shots[i].yaw_cdeg = old_log.shots[i].yaw_cdeg;
							stored_shot_log.shots[i].clicker_dt_ms = 0;
							stored_shot_log.shots[i].impact_dt_ms = 0;
						}
						return 0;
					}
				}
			}
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		if (value.count > STORED_SHOT_CAPACITY) {
			return -EINVAL;
		}
		stored_shot_log = value;
		return 0;
	}

	if (settings_name_steq(name, "wakesens", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		wake_sensitivity_g = (float)value / 1000.0f;
		return 0;
	}

	if (settings_name_steq(name, "sleeptime", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		disconnected_sleep_timeout_ms = value;
		return 0;
	}

	if (settings_name_steq(name, "sleepsens", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		sleep_sensitivity_g = (float)value / 1000.0f;
		return 0;
	}

	if (settings_name_steq(name, "bootseq", NULL)) {
		if (len != sizeof(trace_boot_counter)) return -EINVAL;
		ssize_t rc = read_cb(cb_arg, &trace_boot_counter, sizeof(trace_boot_counter));
		return rc == sizeof(trace_boot_counter) ? 0 : -EINVAL;
	}

	/* Old gyro_bias used the incorrect 61.035 mdps/LSB scale. */
	if (settings_name_steq(name, "gyro_bias_v2", NULL)) {
		if (len != sizeof(stored_gyro_bias)) return -EINVAL;
		ssize_t rc = read_cb(cb_arg, stored_gyro_bias, sizeof(stored_gyro_bias));
		if (rc != sizeof(stored_gyro_bias)) return rc < 0 ? (int)rc : -EINVAL;
		stored_gyro_bias_valid = true;
		return 0;
	}

	if (settings_name_steq(name, "orientation_zero", NULL)) {
		if (len != sizeof(stored_orientation_zero)) {
			return -EINVAL;
		}
		ssize_t rc = read_cb(cb_arg, stored_orientation_zero,
				     sizeof(stored_orientation_zero));
		if (rc != sizeof(stored_orientation_zero)) {
			return rc < 0 ? (int)rc : -EINVAL;
		}
		stored_orientation_zero_valid = true;
		return 0;
	}

	if (settings_name_steq(name, "cant_offset", NULL)) {
		int32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		cant_offset_deg = (float)value / 1000.0f;
		return 0;
	}

	if (settings_name_steq(name, "pitch_offset", NULL)) {
		int32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		pitch_offset_deg = (float)value / 1000.0f;
		return 0;
	}

	if (settings_name_steq(name, "bufrate", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		buffer_rate_hz = (int)value;
		return 0;
	}

	if (settings_name_steq(name, "bufnvs", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		buffer_nvs_enabled = (int)value;
		return 0;
	}

	if (settings_name_steq(name, "autosleep", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		auto_sleep_enabled = (int)value;
		return 0;
	}

	if (settings_name_steq(name, "streamrate", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		ble_stream_divider = (int)value;
		return 0;
	}

	if (settings_name_steq(name, "followms", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		if (value > 3000) {
			value = 3000;
		}
		follow_through_ms = value;
		return 0;
	}

	if (settings_name_steq(name, "tracever", NULL)) {
		uint32_t value;
		ssize_t rc;

		if (len != sizeof(value)) {
			return -EINVAL;
		}
		rc = read_cb(cb_arg, &value, sizeof(value));
		if (rc < 0) {
			return rc;
		}
		trace_schema_version = value;
		return 0;
	}

	/* Offline traces are loaded on demand for BLE upload. Loading all 80 at
	 * boot would consume most of the 256 KiB RAM budget. */
	if (name[0] == 't') {
		return 0;
	}

	return -ENOENT;

}

SETTINGS_STATIC_HANDLER_DEFINE(openfloat, "openfloat", NULL,
			       openfloat_settings_set, NULL, NULL);

/*
 * Persist the shot count off the IMU loop. settings_save_one() does an RRAM
 * write that can take a few ms; running it on the system workqueue keeps the
 * high-rate FIFO loop from stalling, and re-submitting while pending naturally
 * coalesces bursts of shots into a single write of the latest count.
 */
static void shot_persist_work_handler(struct k_work *work)
{
	uint32_t value = (uint32_t)shot_count;
	int rc = settings_save_one("openfloat/shots", &value, sizeof(value));

	if (rc) {
		printk("# shot count save failed: %d\n", rc);
	}
}

static void wake_sens_persist_work_handler(struct k_work *work)
{
	uint32_t value = (uint32_t)scale_float(wake_sensitivity_g, 1000.0f);
	int rc = settings_save_one("openfloat/wakesens", &value, sizeof(value));

	if (rc) {
		printk("# wake sensitivity save failed: %d\n", rc);
	}
}

/*
 * Snapshot the log under the mutex, then do the slow RRAM write unlocked so
 * the high-rate IMU loop is never blocked behind settings_save_one(). Both
 * persist handlers run on the system workqueue, so the static snapshot is
 * never used concurrently.
 */
static void persist_shot_log_snapshot(void)
{
	static struct stored_shot_log snapshot;
	int rc;

	k_mutex_lock(&shot_log_mutex, K_FOREVER);
	snapshot = stored_shot_log;
	k_mutex_unlock(&shot_log_mutex);

	rc = settings_save_one("openfloat/shotlog", &snapshot,
			       sizeof(snapshot));
	if (rc) {
		printk("# shot log save failed: %d\n", rc);
	}
}

static void shot_log_persist_work_handler(struct k_work *work)
{
	persist_shot_log_snapshot();
}

/*
 * Connected-path reconcile, scheduled a few seconds after each shot. If the
 * browser acked the live frame, stored_shot_remove() already drained the queue
 * and this is a no-op — no RRAM write. If a shot is still pending the live
 * frame was lost: persist the backlog and flag a storage-status frame so the
 * browser pulls it via shotdump and the ack/retry path recovers the shot.
 */
static void shot_log_reconcile_work_handler(struct k_work *work)
{
	if (stored_shot_count_snapshot() == 0) {
		return;
	}

	persist_shot_log_snapshot();
	ble_send_storage_status = true;
}

static void sleep_time_persist_work_handler(struct k_work *work)
{
	uint32_t value = disconnected_sleep_timeout_ms;
	int rc = settings_save_one("openfloat/sleeptime", &value, sizeof(value));

	if (rc) {
		printk("# sleep timeout save failed: %d\n", rc);
	}
}

static void sleep_sens_persist_work_handler(struct k_work *work)
{
	uint32_t value = (uint32_t)scale_float(sleep_sensitivity_g, 1000.0f);
	int rc = settings_save_one("openfloat/sleepsens", &value, sizeof(value));

	if (rc) {
		printk("# sleep sensitivity save failed: %d\n", rc);
	}
}

static void buffer_rate_persist_work_handler(struct k_work *work)
{
	uint32_t value = (uint32_t)buffer_rate_hz;
	int rc = settings_save_one("openfloat/bufrate", &value, sizeof(value));

	if (rc) {
		printk("# buffer rate save failed: %d\n", rc);
	}
}

static void buffer_nvs_persist_work_handler(struct k_work *work)
{
	uint32_t value = (uint32_t)buffer_nvs_enabled;
	int rc = settings_save_one("openfloat/bufnvs", &value, sizeof(value));

	if (rc) {
		printk("# buffer nvs save failed: %d\n", rc);
	}
}

static void auto_sleep_persist_work_handler(struct k_work *work)
{
	uint32_t value = (uint32_t)auto_sleep_enabled;
	int rc = settings_save_one("openfloat/autosleep", &value, sizeof(value));

	if (rc) {
		printk("# auto sleep save failed: %d\n", rc);
	}
}

static void streamrate_persist_work_handler(struct k_work *work)
{
	uint32_t value = (uint32_t)ble_stream_divider;
	int rc = settings_save_one("openfloat/streamrate", &value, sizeof(value));

	if (rc) {
		printk("# streamrate save failed: %d\n", rc);
	}
}

static void follow_through_persist_work_handler(struct k_work *work)
{
	uint32_t value = follow_through_ms;
	int rc = settings_save_one("openfloat/followms", &value, sizeof(value));

	if (rc) {
		printk("# follow-through save failed: %d\n", rc);
	}
}

static void trace_persist_work_handler(struct k_work *work)
{
	for (int i = 0; i < TRACE_PERSIST_STAGING_SLOTS; i++) {
		if (!(atomic_get(&trace_persist_pending_mask) & BIT(i))) {
			continue;
		}
		struct stored_trace *trace = &trace_persist_buffers[i];
		char key[32];
		trace_slot_key(key, sizeof(key), trace->shot_id);
		int rc = settings_save_one(key, trace, sizeof(*trace));
		if (rc) {
			printk("# trace save failed for shot=%u slot=%u: %d\n",
			       trace->shot_id,
			       trace->shot_id % OFFLINE_TRACE_SLOT_COUNT, rc);
		}
		atomic_and(&trace_persist_pending_mask, ~BIT(i));
	}
}


static void reset_legacy_trace_storage(void)
{
	if (trace_schema_version == TRACE_SCHEMA_VERSION) {
		return;
	}

	/* Preserve all existing slots. Schema 2 remains readable in place. */

	trace_schema_version = TRACE_SCHEMA_VERSION;
	int rc = settings_save_one("openfloat/tracever", &trace_schema_version,
				   sizeof(trace_schema_version));
	if (rc) {
		printk("# trace schema save failed: %d\n", rc);
	}
}



static void print_float_signed(const char *label, float val, int decimals)
{
	float multiplier = 1.0f;
	for (int i = 0; i < decimals; i++) {
		multiplier *= 10.0f;
	}
	int32_t scaled = (int32_t)scale_float(val, multiplier);
	int32_t abs_val = scaled < 0 ? -scaled : scaled;
	int32_t whole = scaled / (int32_t)multiplier;
	int32_t frac = abs_val % (int32_t)multiplier;
	const char *sign = (scaled < 0 && whole == 0) ? "-" : "";
	printk("%s %s%d.%0*d\n", label, sign, whole, decimals, frac);
}

static void gyro_bias_persist_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);
	int rc = settings_save_one("openfloat/gyro_bias_v2", stored_gyro_bias, sizeof(stored_gyro_bias));
	atomic_set(&gyro_cal_status, rc ? 4 : 2);
	atomic_set(&gyro_cal_notify_pending, 1);
	printk("# gyro bias calibration %s\n", rc ? "applied; save failed" : "saved");
}

static void offsets_persist_work_handler(struct k_work *work)
{
	int32_t record[3] = {
		OPENFLOAT_MOUNT,
		(int32_t)scale_float(cant_offset_deg, 1000.0f),
		(int32_t)scale_float(pitch_offset_deg, 1000.0f),
	};
	int rc = settings_save_one("openfloat/orientation_zero", record, sizeof(record));
	if (rc) {
		printk("# orientation_zero save failed: %d\n", rc);
	}
}

#define BT_UUID_BAS_VAL 0x180f
#define BT_UUID_BAS BT_UUID_DECLARE_16(BT_UUID_BAS_VAL)
#define BT_UUID_BAS_BATTERY_LEVEL_VAL 0x2a19
#define BT_UUID_BAS_BATTERY_LEVEL BT_UUID_DECLARE_16(BT_UUID_BAS_BATTERY_LEVEL_VAL)

static uint8_t battery_level = 100;

static ssize_t read_battery_level(struct bt_conn *conn,
				  const struct bt_gatt_attr *attr,
				  void *buf, uint16_t len, uint16_t offset)
{
	return bt_gatt_attr_read(conn, attr, buf, len, offset, &battery_level, sizeof(battery_level));
}

static void battery_level_ccc_changed(const struct bt_gatt_attr *attr,
				      uint16_t value)
{
}

BT_GATT_SERVICE_DEFINE(bas_svc,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_BAS),
	BT_GATT_CHARACTERISTIC(BT_UUID_BAS_BATTERY_LEVEL,
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ,
			       read_battery_level, NULL, &battery_level),
	BT_GATT_CCC(battery_level_ccc_changed,
		    BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

static const struct adc_dt_spec battery_adc = ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 0);
static const struct device *const vbat_reg = DEVICE_DT_GET(DT_NODELABEL(vbat_pwr));

static void battery_measure_work_handler(struct k_work *work)
{
	if (!device_is_ready(battery_adc.dev)) {
		printk("# Battery SAADC device not ready\n");
		k_work_reschedule(&battery_measure_work, K_SECONDS(5));
		return;
	}

	int err = adc_channel_setup_dt(&battery_adc);
	if (err) {
		printk("# Battery ADC channel setup failed: %d\n", err);
		k_work_reschedule(&battery_measure_work, K_SECONDS(5));
		return;
	}

	if (device_is_ready(vbat_reg)) {
		(void)regulator_enable(vbat_reg);
	}

	k_sleep(K_MSEC(5));

	int16_t raw_val = 0;
	struct adc_sequence sequence = {
		.buffer = &raw_val,
		.buffer_size = sizeof(raw_val),
	};

	err = adc_sequence_init_dt(&battery_adc, &sequence);
	if (err) {
		printk("# Battery ADC sequence init failed: %d\n", err);
	} else {
		err = adc_read(battery_adc.dev, &sequence);
		if (err) {
			printk("# Battery ADC read failed: %d\n", err);
		} else {
			int32_t val_mv = (int32_t)raw_val;
			(void)adc_raw_to_millivolts_dt(&battery_adc, &val_mv);
			uint16_t battery_mv = (uint16_t)val_mv * 2;

			uint8_t pct = 100;
			if (battery_mv <= 3400) {
				pct = 0;
			} else if (battery_mv >= 4150) {
				pct = 100;
			} else {
				pct = (uint8_t)((battery_mv - 3400) * 100 / (4150 - 3400));
			}

			printk("# Battery measurement: raw=%d, pin_mv=%d, vbat_mv=%d, pct=%d%%\n",
			       (int)raw_val, (int)val_mv, (int)battery_mv, (int)pct);

			if (pct != battery_level) {
				battery_level = pct;
				(void)bt_gatt_notify(NULL, &bas_svc.attrs[2], &battery_level, sizeof(battery_level));
			}
		}
	}

	if (device_is_ready(vbat_reg)) {
		(void)regulator_disable(vbat_reg);
	}

	k_work_reschedule(&battery_measure_work, K_SECONDS(10));
}

static void print_threshold_g(float threshold_g)
{
	int32_t tenths = scale_float(threshold_g, 10.0f);

	printk("# BLE control: shot threshold set to %d.%01d g\n",
	       tenths / 10, tenths % 10);
}

static bool set_shot_threshold_from_command(const char *command)
{
	const char *value = command + strlen("thresh:");
	char *end;
	float threshold_g;

	errno = 0;
	threshold_g = strtof(value, &end);
	if (errno != 0 || end == value || *end != '\0') {
		printk("# BLE control: invalid threshold command '%s'\n", command);
		return false;
	}

	if (threshold_g < MIN_SHOT_ACCEL_THRESHOLD_G) {
		threshold_g = MIN_SHOT_ACCEL_THRESHOLD_G;
	} else if (threshold_g > MAX_SHOT_ACCEL_THRESHOLD_G) {
		threshold_g = MAX_SHOT_ACCEL_THRESHOLD_G;
	}

	shot_accel_threshold_mps2 = threshold_g * MPS2_PER_G;
	print_threshold_g(threshold_g);
	return true;
}

static int16_t clamp_i16(int32_t value)
{
	if (value > INT16_MAX) {
		return INT16_MAX;
	}

	if (value < INT16_MIN) {
		return INT16_MIN;
	}

	return (int16_t)value;
}

static int8_t clamp_i8(int32_t value)
{
	if (value > INT8_MAX) {
		return INT8_MAX;
	}

	if (value < INT8_MIN) {
		return INT8_MIN;
	}

	return (int8_t)value;
}

static uint16_t checksum16(const uint8_t *data, size_t len)
{
	uint16_t sum = 0;

	for (size_t i = 0; i < len; i++) {
		sum = (uint16_t)(sum + data[i]);
	}

	return sum;
}

static void put_u16_le(uint8_t *buf, size_t offset, uint16_t value)
{
	sys_put_le16(value, &buf[offset]);
}

static void put_u32_le(uint8_t *buf, size_t offset, uint32_t value)
{
	sys_put_le32(value, &buf[offset]);
}

static void uart_write_bytes(const uint8_t *data, size_t len)
{
	if (!device_is_ready(stream_uart)) {
		return;
	}

	for (size_t i = 0; i < len; i++) {
		uart_poll_out(stream_uart, data[i]);
	}
}

static void build_openfloat_live_binary(uint8_t frame[OPENFLOAT_BLE_LIVE_FRAME_SIZE],
					uint32_t sequence,
					uint32_t dt_us,
					const struct vec3 *accel,
					const struct quat *q,
					uint16_t flags)
{
	(void)flags;

	memset(frame, 0, OPENFLOAT_BLE_LIVE_FRAME_SIZE);
	frame[0] = 'O';
	frame[1] = 'F';
	frame[2] = 2; /* protocol version */
	frame[3] = 1; /* live raw sample */
	put_u16_le(frame, 4, (uint16_t)sequence);
	put_u16_le(frame, 6, (uint16_t)dt_us);
	frame[8] = (uint8_t)clamp_i8(scale_float(accel->x, SCALE_ACCEL_DECI_G));
	frame[9] = (uint8_t)clamp_i8(scale_float(accel->y, SCALE_ACCEL_DECI_G));
	frame[10] = (uint8_t)clamp_i8(scale_float(accel->z, SCALE_ACCEL_DECI_G));
	put_u16_le(frame, 11, (uint16_t)clamp_i16(scale_float(q->w, 10000.0f)));
	put_u16_le(frame, 13, (uint16_t)clamp_i16(scale_float(q->x, 10000.0f)));
	put_u16_le(frame, 15, (uint16_t)clamp_i16(scale_float(q->y, 10000.0f)));
	put_u16_le(frame, 17, (uint16_t)clamp_i16(scale_float(q->z, 10000.0f)));

	int val_raw = (int)(audio_peak_raw / AUDIO_BLE_SCALE_DIVISOR);
	if (val_raw < 0) {
		val_raw = 0;
	}
	if (val_raw > 255) {
		val_raw = 255;
	}
	frame[19] = (uint8_t)val_raw;
}

/*
 * Build a shot frame in the same envelope as the live frame. type 2 is
 * a real shot event (the browser logs it); type 3 is a count-sync sent on
 * subscribe so the persisted lifetime count displays without logging a shot.
 * Layout matches parseBinaryShotFrame() in app/protocol/frame.js.
 */
static void build_openfloat_shot_binary(uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE],
					uint8_t type)
{
	memset(frame, 0, OPENFLOAT_BLE_FRAME_SIZE);
	uint16_t threshold_cg =
		(uint16_t)scale_float(shot_accel_threshold_mps2 / MPS2_PER_G,
				      100.0f);

	frame[0] = 'O';
	frame[1] = 'F';
	frame[2] = 1; /* protocol version */
	frame[3] = type;
	put_u16_le(frame, 4, (uint16_t)shot_count);
	put_u16_le(frame, 6, (uint16_t)shot_id);
	put_u16_le(frame, 8,
		   (uint16_t)clamp_i16(scale_float(last_shot_accel.x, SCALE_MG)));
	put_u16_le(frame, 10,
		   (uint16_t)clamp_i16(scale_float(last_shot_accel.y, SCALE_MG)));
	put_u16_le(frame, 12,
		   (uint16_t)clamp_i16(scale_float(last_shot_accel.z, SCALE_MG)));
	put_u16_le(frame, 14, threshold_cg);
	put_u16_le(frame, 16,
		   type == 2 ? (uint16_t)last_shot_record.roll_cdeg : 0);
	put_u16_le(frame, 18,
		   type == 2 ? (uint16_t)last_shot_record.pitch_cdeg : 0);
	put_u16_le(frame, 20,
		   type == 2 ? (uint16_t)last_shot_record.yaw_cdeg : 0);
	put_u16_le(frame, 22,
		   type == 2 ? last_shot_record.clicker_dt_ms : 0);
	put_u16_le(frame, 24,
		   type == 2 ? last_shot_record.impact_dt_ms : 0);
	put_u16_le(frame, 26, type == 2 ? last_shot_sequence : 0);
}

static void build_openfloat_stored_shot_binary(
	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE],
	const struct stored_shot *shot)
{
	memset(frame, 0, OPENFLOAT_BLE_FRAME_SIZE);
	frame[0] = 'O';
	frame[1] = 'F';
	frame[2] = 1; /* protocol version */
	frame[3] = 4; /* stored shot upload */
	put_u16_le(frame, 4, shot->shot_count);
	put_u16_le(frame, 6, shot->shot_id);
	put_u16_le(frame, 8, (uint16_t)shot->ax_mg);
	put_u16_le(frame, 10, (uint16_t)shot->ay_mg);
	put_u16_le(frame, 12, (uint16_t)shot->az_mg);
	put_u16_le(frame, 14, shot->threshold_cg);
	put_u16_le(frame, 16, (uint16_t)shot->roll_cdeg);
	put_u16_le(frame, 18, (uint16_t)shot->pitch_cdeg);
	put_u16_le(frame, 20, (uint16_t)shot->yaw_cdeg);
	put_u16_le(frame, 22, shot->clicker_dt_ms);
	put_u16_le(frame, 24, shot->impact_dt_ms);
	put_u16_le(frame, 26, (uint16_t)(shot->shot_id >> 16));
}

static void build_openfloat_storage_status_binary(
	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE])
{
	uint16_t pending = stored_shot_count_snapshot();

	memset(frame, 0, OPENFLOAT_BLE_FRAME_SIZE);
	frame[0] = 'O';
	frame[1] = 'F';
	frame[2] = 1; /* protocol version */
	frame[3] = 5; /* stored-shot queue status */
	put_u16_le(frame, 4, (uint16_t)shot_count);
	put_u16_le(frame, 6, pending);
	put_u16_le(frame, 8,
		   stored_shot_upload_in_progress ?
			   (uint16_t)stored_shot_upload_id : 0);
	put_u16_le(frame, 10, stored_shot_upload_requested ? 1 : 0);
	put_u16_le(frame, 12, (uint16_t)stored_shot_evicted_count);
	put_u16_le(frame, 14,
		   stored_shot_upload_in_progress ?
			   (uint16_t)(stored_shot_upload_id >> 16) : 0);
	put_u16_le(frame, 16, stored_shot_upload_attempts);
	put_u16_le(frame, 18, 0);
}

static void build_openfloat_trace_status_binary(
	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE],
	uint32_t requested_shot_id,
	uint8_t status)
{
	memset(frame, 0, OPENFLOAT_BLE_FRAME_SIZE);
	frame[0] = 'O';
	frame[1] = 'F';
	frame[2] = 1; /* protocol version */
	frame[3] = 7; /* trace request status */
	put_u16_le(frame, 4, (uint16_t)requested_shot_id);
	put_u16_le(frame, 6, (uint16_t)(requested_shot_id >> 16));
	frame[8] = status;
}

static void __maybe_unused write_openfloat_live_binary(uint32_t sequence,
						       uint32_t dt_us,
						       const struct vec3 *accel,
						       const struct quat *q,
						       uint16_t flags)
{
	uint8_t frame[OPENFLOAT_BLE_LIVE_FRAME_SIZE];

	build_openfloat_live_binary(frame, sequence, dt_us, accel, q, flags);
	uart_write_bytes(frame, sizeof(frame));
}

static ssize_t write_openfloat_control(struct bt_conn *conn,
				       const struct bt_gatt_attr *attr,
				       const void *buf, uint16_t len,
				       uint16_t offset, uint8_t flags)
{
	char command[24];

	if (offset != 0) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	}

	if (len >= sizeof(command)) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}

	memcpy(command, buf, len);
	command[len] = '\0';

	if (!strcmp(command, "gyrobias")) {
		atomic_set_bit(&gyro_cal_requests, 0);
	} else if (!strcmp(command, "gyrobias?")) {
		atomic_set_bit(&gyro_cal_requests, 1);
	} else if (!strcmp(command, "zero")) {
		zero_requested = true;
		printk("# BLE control: zero calibration requested\n");
	} else if (!strcmp(command, "shottrigger")) {
		trigger_shot_requested = true;
		printk("# BLE control: shot trigger simulated\n");
	} else if (!strncmp(command, "thresh:", strlen("thresh:"))) {
		(void)set_shot_threshold_from_command(command);
	} else if (!strcmp(command, "start")) {
		ble_notify_enabled = true;
		ble_send_count_sync = true;
		ble_send_storage_status = true;
		stored_shot_upload_in_progress = false;
		stored_shot_upload_sent_ms = 0;
		stored_shot_upload_attempts = 0;
		stored_shot_upload_requested = true;
	} else if (!strcmp(command, "stop")) {
		ble_notify_enabled = false;
		stored_shot_upload_in_progress = false;
		stored_shot_upload_sent_ms = 0;
		stored_shot_upload_attempts = 0;
		stored_shot_upload_requested = false;
	} else if (!strcmp(command, "shotdump")) {
		stored_shot_upload_in_progress = false;
		stored_shot_upload_sent_ms = 0;
		stored_shot_upload_attempts = 0;
		stored_shot_upload_requested = true;
		ble_send_storage_status = true;
		printk("# BLE control: stored shot upload requested, pending=%u\n",
		       stored_shot_count_snapshot());
	} else if (!strcmp(command, "shotreset")) {
		shot_count = 0;
		shot_id = 0;
		last_shot_accel = (struct vec3){ 0 };
		k_mutex_lock(&shot_log_mutex, K_FOREVER);
		stored_shot_log.count = 0;
		k_mutex_unlock(&shot_log_mutex);
		stored_shot_evicted_count = 0;
		stored_shot_upload_in_progress = false;
		stored_shot_upload_sent_ms = 0;
		stored_shot_upload_attempts = 0;
		stored_shot_upload_requested = false;
		ble_send_count_sync = true;
		k_work_submit(&shot_persist_work);
		k_work_submit(&shot_log_persist_work);
		printk("# BLE control: shot count reset to 0\n");
	} else if (!strncmp(command, "shotset:", strlen("shotset:"))) {
		int value = atoi(command + strlen("shotset:"));

		if (value < 0) {
			value = 0;
		}
		shot_count = value;
		shot_id = (uint32_t)value;
		ble_send_count_sync = true;
		k_work_submit(&shot_persist_work);
		printk("# BLE control: shot count set to %d\n", shot_count);
	} else if (!strncmp(command, "shotack:", strlen("shotack:"))) {
		const char *value_str = command + strlen("shotack:");
		char *end;
		errno = 0;
		unsigned long value = strtoul(value_str, &end, 10);

		if (errno == 0 && end != value_str && *end == '\0' &&
		    value <= UINT32_MAX && stored_shot_remove((uint32_t)value)) {
			stored_shot_upload_in_progress = false;
			stored_shot_upload_sent_ms = 0;
			stored_shot_upload_attempts = 0;
			stored_shot_upload_requested =
				stored_shot_count_snapshot() > 0;
			k_work_submit(&shot_log_persist_work);
			ble_send_storage_status = true;
			printk("# BLE control: stored shot acked: id=%lu pending=%u\n",
			       value, stored_shot_count_snapshot());
		} else {
			printk("# BLE control: stored shot ack ignored: id=%lu\n",
			       value);
		}
	} else if (!strncmp(command, "wakesens:", strlen("wakesens:"))) {
		const char *value_str = command + strlen("wakesens:");
		char *end;
		errno = 0;
		float val = strtof(value_str, &end);
		if (errno != 0 || end == value_str || *end != '\0') {
			printk("# BLE control: invalid wake sensitivity command '%s'\n", command);
		} else {
			if (val < 0.5f) {
				val = 0.5f;
			} else if (val > 8.0f) {
				val = 8.0f;
			}
			wake_sensitivity_g = val;
			k_work_submit(&wake_sens_persist_work);
			int32_t tenths = scale_float(wake_sensitivity_g, 10.0f);
			printk("# BLE control: wake sensitivity set to %d.%01d g\n",
			       tenths / 10, tenths % 10);
		}
	} else if (!strncmp(command, "sleeptime:", strlen("sleeptime:"))) {
		const char *value_str = command + strlen("sleeptime:");
		char *end;
		errno = 0;
		long val = strtol(value_str, &end, 10);
		if (errno != 0 || end == value_str || *end != '\0') {
			printk("# BLE control: invalid sleep timeout command '%s'\n", command);
		} else {
			if (val < 5) val = 5;
			if (val > 600) val = 600;
			disconnected_sleep_timeout_ms = (uint32_t)val * 1000;
			k_work_submit(&sleep_time_persist_work);
			printk("# BLE control: sleep timeout set to %u s\n", disconnected_sleep_timeout_ms / 1000);
		}
	} else if (!strncmp(command, "sleepsens:", strlen("sleepsens:"))) {
		const char *value_str = command + strlen("sleepsens:");
		char *end;
		errno = 0;
		float val = strtof(value_str, &end);
		if (errno != 0 || end == value_str || *end != '\0') {
			printk("# BLE control: invalid sleep sensitivity command '%s'\n", command);
		} else {
			if (val < 0.05f) val = 0.05f;
			if (val > 0.50f) val = 0.50f;
			sleep_sensitivity_g = val;
			k_work_submit(&sleep_sens_persist_work);
			int32_t hundredths = scale_float(sleep_sensitivity_g, 100.0f);
			printk("# BLE control: sleep sensitivity set to %d.%02d g\n",
			       hundredths / 100, hundredths % 100);
		}
	} else if (!strncmp(command, "bufrate:", strlen("bufrate:"))) {
		int value = atoi(command + strlen("bufrate:"));
		if (value == 0 || value == 52 || value == 104 || value == 208) {
			buffer_rate_hz = value;
			k_work_submit(&buffer_rate_persist_work);
			printk("# BLE control: buffer rate set to %d Hz\n", buffer_rate_hz);
		} else {
			printk("# BLE control: invalid buffer rate command '%s'\n", command);
		}
	} else if (!strncmp(command, "bufnvs:", strlen("bufnvs:"))) {
		int value = atoi(command + strlen("bufnvs:"));
		if (value == 0 || value == 1) {
			buffer_nvs_enabled = value;
			k_work_submit(&buffer_nvs_persist_work);
			printk("# BLE control: buffer NVS set to %s\n", buffer_nvs_enabled ? "ON" : "OFF");
		} else {
			printk("# BLE control: invalid buffer NVS command '%s'\n", command);
		}
	} else if (!strncmp(command, "autosleep:", strlen("autosleep:"))) {
		int value = atoi(command + strlen("autosleep:"));
		if (value == 0 || value == 1) {
			auto_sleep_enabled = value;
			k_work_submit(&auto_sleep_persist_work);
			printk("# BLE control: auto sleep set to %s\n", auto_sleep_enabled ? "ON" : "OFF");
		} else {
			printk("# BLE control: invalid auto sleep command '%s'\n", command);
		}
	} else if (!strncmp(command, "streamrate:", strlen("streamrate:"))) {
		int value = atoi(command + strlen("streamrate:"));
		if (value == 1 || value == 2 || value == 5 || value == 10 || value == 20) {
			ble_stream_divider = value;
			k_work_submit(&streamrate_persist_work);
			printk("# BLE control: stream rate divider set to %d\n", ble_stream_divider);
		} else {
			printk("# BLE control: invalid stream rate divider command '%s'\n", command);
		}
	} else if (!strncmp(command, "followms:", strlen("followms:"))) {
		int value = atoi(command + strlen("followms:"));
		if (value < 0) {
			value = 0;
		}
		if (value > 3000) {
			value = 3000;
		}
		follow_through_ms = (uint32_t)value;
		k_work_submit(&follow_through_persist_work);
		printk("# BLE control: follow-through trace window set to %u ms\n",
		       follow_through_ms);
	} else if (!strncmp(command, "tracereq:", strlen("tracereq:"))) {
		const char *value_str = command + strlen("tracereq:");
		char *end;
		errno = 0;
		unsigned long req_id = strtoul(value_str, &end, 10);
		if (errno == 0 && end != value_str && *end == '\0' &&
		    req_id <= UINT32_MAX) {
			if (trace_load_for_upload((uint32_t)req_id)) {
				trace_upload_chunk_idx = 0;
				trace_upload_in_progress = true;
				k_work_reschedule(&trace_upload_work, K_NO_WAIT);
				printk("# BLE control: trace upload started for shot=%lu slot=%lu len=%u\n",
				       req_id,
				       req_id % OFFLINE_TRACE_SLOT_COUNT,
				       trace_upload_buffer.count);
			} else {
				trace_status_shot_id = (uint32_t)req_id;
				trace_status_code = 0;
				trace_status_pending = true;
				printk("# BLE control: trace not found for shot=%lu slot=%lu\n",
				       req_id, req_id % OFFLINE_TRACE_SLOT_COUNT);
			}
		}
	} else {
		printk("# BLE control: unknown command '%s'\n", command);
	}

	return len;
}

static void openfloat_live_ccc_changed(const struct bt_gatt_attr *attr,
				       uint16_t value)
{
	ble_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
	if (ble_notify_enabled) {
		(void)k_work_cancel_delayable(&stale_ble_disconnect_work);
		ble_send_count_sync = true;
		ble_send_storage_status = true;
		stored_shot_upload_in_progress = false;
		stored_shot_upload_sent_ms = 0;
		stored_shot_upload_attempts = 0;
		stored_shot_upload_requested = true;
	} else {
		stored_shot_upload_in_progress = false;
		stored_shot_upload_sent_ms = 0;
		stored_shot_upload_attempts = 0;
		stored_shot_upload_requested = false;
		if (current_conn) {
			k_work_reschedule(&stale_ble_disconnect_work,
					  K_MSEC(BLE_STALE_NOTIFY_DISCONNECT_MS));
		}
	}
	printk("# BLE live notifications %s\n",
	       ble_notify_enabled ? "enabled" : "disabled");
}

BT_GATT_SERVICE_DEFINE(openfloat_svc,
	BT_GATT_PRIMARY_SERVICE(&openfloat_service_uuid),
	BT_GATT_CHARACTERISTIC(&openfloat_live_uuid.uuid,
			       BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(openfloat_live_ccc_changed,
		    BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
	BT_GATT_CHARACTERISTIC(&openfloat_control_uuid.uuid,
			       BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
			       BT_GATT_PERM_WRITE,
			       NULL, write_openfloat_control, NULL),
);

static void trace_upload_work_handler(struct k_work *work)
{
	if (!ble_notify_enabled || !trace_upload_in_progress) {
		trace_upload_in_progress = false;
		return;
	}

	struct stored_trace *trace = &trace_upload_buffer;
	uint16_t header_bytes = trace->version == 3 ? OF_TRACE_HEADER_SIZE : 0;
	uint16_t total_bytes = header_bytes + trace->count * sizeof(struct trace_point);
	int total_chunks = (total_bytes + (TRACE_CHUNK_PAYLOAD_SIZE - 1)) / TRACE_CHUNK_PAYLOAD_SIZE;

	if (trace_upload_chunk_idx >= total_chunks) {
		trace_upload_in_progress = false;
		printk("# BLE trace: finished upload for shot=%d\n", trace->shot_id);
		return;
	}

	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE];
	memset(frame, 0, sizeof(frame));
	frame[0] = 'O';
	frame[1] = 'F';
	frame[2] = 1;
	frame[3] = 6; // Type 6: Trace chunk

	put_u16_le(frame, 4, trace->shot_id);
	frame[6] = (uint8_t)trace_upload_chunk_idx;
	frame[7] = (uint8_t)total_chunks;

	uint16_t offset = trace_upload_chunk_idx * TRACE_CHUNK_PAYLOAD_SIZE;
	uint16_t rem = total_bytes - offset;
	uint8_t chunk_len = rem > TRACE_CHUNK_PAYLOAD_SIZE ? TRACE_CHUNK_PAYLOAD_SIZE : (uint8_t)rem;
	frame[8] = chunk_len;
	if (trace_upload_chunk_idx == 0) {
		frame[28] = header_bytes ? OF_TRACE_FORMAT : (uint8_t)sizeof(struct trace_point);
	}

	uint8_t *raw_bytes = (uint8_t *)trace->points;
	for (uint16_t i = 0; i < chunk_len; i++) {
		uint16_t pos = offset + i;
		frame[9 + i] = pos < header_bytes ? trace->timing[pos] : raw_bytes[pos - header_bytes];
	}
	if (chunk_len < TRACE_CHUNK_PAYLOAD_SIZE) {
		memset(&frame[9] + chunk_len, 0, TRACE_CHUNK_PAYLOAD_SIZE - chunk_len);
	}

	int err = bt_gatt_notify(NULL, &openfloat_svc.attrs[2], frame, sizeof(frame));
	if (err) {
		printk("# trace chunk upload notify failed: %d, retrying chunk %d...\n", err, trace_upload_chunk_idx);
		k_work_reschedule(&trace_upload_work, K_MSEC(50));
	} else {
		trace_upload_chunk_idx++;
		k_work_reschedule(&trace_upload_work, K_MSEC(10));
	}
}

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL,
		      BT_UUID_128_ENCODE(0x8f3f3b10, 0x0f5a, 0x4f4c, 0x9a2d,
					 0x000000000001)),
};

static const struct bt_data sd[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME,
		sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

static int start_ble_advertising(void)
{
	int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad),
				  sd, ARRAY_SIZE(sd));

	if (err == -EALREADY) {
		return 0;
	}
	if (err) {
		printk("# BLE advertising failed: %d\n", err);
		return err;
	}

	printk("# BLE advertising: %s\n", CONFIG_BT_DEVICE_NAME);
	return 0;
}

static void adv_start_work_handler(struct k_work *work)
{
	int err;

	err = start_ble_advertising();
	if (err) {
		k_work_reschedule(&adv_start_work, K_MSEC(1000));
	}
}

static void tune_ble_link_work_handler(struct k_work *work)
{
	struct bt_le_conn_param conn_param = BT_LE_CONN_PARAM_INIT(
		OPENFLOAT_CONN_INTERVAL_MIN,
		OPENFLOAT_CONN_INTERVAL_MAX,
		OPENFLOAT_CONN_LATENCY,
		OPENFLOAT_CONN_TIMEOUT);
	const struct bt_conn_le_data_len_param *data_len_param =
		BT_LE_DATA_LEN_PARAM_MAX;
	const struct bt_conn_le_phy_param *phy_param = BT_CONN_LE_PHY_PARAM_2M;
	int err;

	ARG_UNUSED(work);

	if (!current_conn) {
		return;
	}

	err = bt_conn_le_param_update(current_conn, &conn_param);
	if (err) {
		printk("# BLE conn param update request failed: %d\n", err);
	} else {
		printk("# BLE conn param update requested: interval %u-%u units\n",
		       conn_param.interval_min, conn_param.interval_max);
	}

	err = bt_conn_le_data_len_update(current_conn, data_len_param);
	if (err) {
		printk("# BLE data length update request failed: %d\n", err);
	} else {
		printk("# BLE data length update requested: tx %u bytes %u us\n",
		       data_len_param->tx_max_len, data_len_param->tx_max_time);
	}

	err = bt_conn_le_phy_update(current_conn, phy_param);
	if (err) {
		printk("# BLE PHY update request failed: %d\n", err);
	} else {
		printk("# BLE PHY update requested: 2M\n");
	}
}

static void stale_ble_disconnect_work_handler(struct k_work *work)
{
	int err;

	ARG_UNUSED(work);

	if (!current_conn || ble_notify_enabled) {
		return;
	}

	printk("# BLE live notifications stale; disconnecting idle central\n");
	err = bt_conn_disconnect(current_conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
	if (err) {
		printk("# BLE stale disconnect failed: %d\n", err);
	}
}

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		printk("# BLE connection failed: %u\n", err);
		k_work_reschedule(&adv_start_work, K_MSEC(500));
		return;
	}

	current_conn = bt_conn_ref(conn);
	(void)k_work_cancel_delayable(&adv_start_work);
	(void)k_work_cancel_delayable(&stale_ble_disconnect_work);
	printk("# BLE connected\n");
	last_activity_time_ms = k_uptime_get();
	(void)k_work_reschedule(&tune_ble_link_work, K_MSEC(500));
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	printk("# BLE disconnected: reason %u\n", reason);
	ble_notify_enabled = false;
	stored_shot_upload_in_progress = false;
	stored_shot_upload_sent_ms = 0;
	stored_shot_upload_attempts = 0;
	stored_shot_upload_requested = false;
	(void)k_work_cancel_delayable(&tune_ble_link_work);
	(void)k_work_cancel_delayable(&stale_ble_disconnect_work);

	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}

	last_activity_time_ms = k_uptime_get();
	k_work_reschedule(&adv_start_work, K_MSEC(250));
}

static void le_param_updated(struct bt_conn *conn, uint16_t interval,
			     uint16_t latency, uint16_t timeout)
{
	printk("# BLE conn params: interval=%u units latency=%u timeout=%u\n",
	       interval, latency, timeout);
}

static void le_phy_updated(struct bt_conn *conn,
			   struct bt_conn_le_phy_info *param)
{
	printk("# BLE PHY updated: tx=%u rx=%u\n", param->tx_phy, param->rx_phy);
}

static void le_data_len_updated(struct bt_conn *conn,
				struct bt_conn_le_data_len_info *info)
{
	printk("# BLE data length updated: tx=%u/%u us rx=%u/%u us\n",
	       info->tx_max_len, info->tx_max_time,
	       info->rx_max_len, info->rx_max_time);
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
	.le_param_updated = le_param_updated,
	.le_phy_updated = le_phy_updated,
	.le_data_len_updated = le_data_len_updated,
};

static int init_ble(void)
{
	int err;

	err = bt_enable(NULL);
	if (err) {
		printk("# Bluetooth init failed: %d\n", err);
		return err;
	}

	return start_ble_advertising();
}

static void notify_openfloat_live_binary(const uint8_t *payload, size_t len,
					 uint8_t frame_count)
{
	int err;

	if (!ble_notify_enabled) {
		return;
	}

	err = bt_gatt_notify(NULL, &openfloat_svc.attrs[2],
			     payload, len);
	if (err) {
		ble_dropped_samples += frame_count;
	}
}

/*
 * Notify a single shot frame on the live characteristic. type 2 is a
 * real shot event; type 3 is a count-sync. The browser demultiplexes on the
 * type byte, so this rides the same characteristic the client already
 * subscribes to for live samples.
 */
static bool notify_openfloat_shot_event(uint8_t type)
{
	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE];
	int err;

	if (!ble_notify_enabled) {
		return false;
	}

	build_openfloat_shot_binary(frame, type);
	err = bt_gatt_notify(NULL, &openfloat_svc.attrs[2], frame,
			     sizeof(frame));
	return err == 0;
}

static void notify_next_stored_shot(void)
{
	struct stored_shot shot;
	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE];
	int err;

	if (!ble_notify_enabled ||
	    stored_shot_upload_in_progress || !stored_shot_upload_requested) {
		return;
	}

	if (!stored_shot_peek_first(&shot)) {
		stored_shot_upload_requested = false;
		return;
	}

	build_openfloat_stored_shot_binary(frame, &shot);
	err = bt_gatt_notify(NULL, &openfloat_svc.attrs[2], frame,
			     sizeof(frame));
	if (err) {
		printk("# stored shot upload notify failed: %d pending=%u\n",
		       err, stored_shot_count_snapshot());
		return;
	}

	stored_shot_upload_id = shot.shot_id;
	stored_shot_upload_in_progress = true;
	stored_shot_upload_sent_ms = k_uptime_get();
	if (stored_shot_upload_attempts < UINT8_MAX) {
		stored_shot_upload_attempts++;
	}
	ble_send_storage_status = true;
	printk("# stored shot upload sent: id=%u pending=%u\n",
	       stored_shot_upload_id, stored_shot_count_snapshot());
}

static void retry_stalled_stored_shot_upload(void)
{
	if (!ble_notify_enabled || !stored_shot_upload_in_progress ||
	    !stored_shot_upload_requested || stored_shot_upload_sent_ms == 0) {
		return;
	}

	if (k_uptime_get() - stored_shot_upload_sent_ms <
	    STORED_SHOT_UPLOAD_RETRY_MS) {
		return;
	}

	printk("# stored shot upload retry: id=%u attempts=%u pending=%u\n",
	       stored_shot_upload_id, stored_shot_upload_attempts,
	       stored_shot_count_snapshot());
	stored_shot_upload_in_progress = false;
	stored_shot_upload_sent_ms = 0;
	ble_send_storage_status = true;
}

static void notify_storage_status(void)
{
	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE];

	if (!ble_notify_enabled) {
		return;
	}

	build_openfloat_storage_status_binary(frame);
	(void)bt_gatt_notify(NULL, &openfloat_svc.attrs[2], frame,
			     sizeof(frame));
}

static void notify_trace_status(void)
{
	uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE];

	if (!ble_notify_enabled) {
		return;
	}

	build_openfloat_trace_status_binary(frame, trace_status_shot_id,
					    trace_status_code);
	(void)bt_gatt_notify(NULL, &openfloat_svc.attrs[2], frame,
			     sizeof(frame));
}

static void service_gyro_calibration_requests(void)
{
	if (atomic_test_and_clear_bit(&gyro_cal_requests, 0)) {
		last_activity_time_ms = k_uptime_get();
		if (atomic_get(&gyro_cal_status) != 5) {
			of_gyro_bias_start(&gyro_bias);
			gyro_cal_started_ms = k_uptime_get();
			gyro_cal_elapsed_ms = 0;
			atomic_set(&gyro_cal_status, 1);
		}
		atomic_set(&gyro_cal_notify_pending, 1);
	}
	if (atomic_test_and_clear_bit(&gyro_cal_requests, 1)) {
		atomic_set(&gyro_cal_notify_pending, 1);
	}
}

static void process_gyro_calibration(const struct vec3 *accel, const struct vec3 *raw,
				     struct vec3 *corrected)
{
	const float a[3] = { accel->x, accel->y, accel->z };
	const float g[3] = { raw->x, raw->y, raw->z };
	float output[3];
	if (gyro_bias.status == 1) {
		gyro_cal_elapsed_ms = (uint16_t)MIN(65535, k_uptime_get() - gyro_cal_started_ms);
		uint8_t status = of_gyro_bias_update(&gyro_bias, a, g,
			(float)OUTPUT_DT_US / 1000000.0f);
		if (status == 2) {
			stored_gyro_bias[0] = OPENFLOAT_MOUNT;
			for (int i = 0; i < 3; i++) {
				stored_gyro_bias[i + 1] = scale_float(gyro_bias.bias[i], SCALE_GYRO_MDPS);
			}
			atomic_set(&gyro_cal_status, 5);
			k_work_submit(&gyro_bias_persist_work);
			atomic_set(&gyro_cal_notify_pending, 1);
		} else if (status == 3) {
			atomic_set(&gyro_cal_status, 3);
			atomic_set(&gyro_cal_notify_pending, 1);
		}
	}
	of_gyro_bias_apply(&gyro_bias, g, output);
	*corrected = (struct vec3){ output[0], output[1], output[2] };

}

static void notify_gyro_calibration(void)
{
	static int64_t last_report_ms;
	int64_t now = k_uptime_get();
	if (ble_notify_enabled && now - last_report_ms >= 250 &&
	    (atomic_get(&gyro_cal_notify_pending) || gyro_bias.status == 1)) {
		/* Completion after this point sets the flag again for the next report. */
		atomic_set(&gyro_cal_notify_pending, 0);
		uint8_t frame[OPENFLOAT_BLE_FRAME_SIZE] = { 'O', 'F', 1, 8 };
		frame[4] = (uint8_t)atomic_get(&gyro_cal_status);
		frame[5] = gyro_bias.valid;
		frame[6] = (uint8_t)fminf(100.0f, gyro_bias.elapsed * 100.0f / OF_GYRO_CAL_SECONDS);
		frame[7] = gyro_bias.reason;
		for (int i = 0; i < 3; i++) {
			put_u16_le(frame, 8 + i * 2, (uint16_t)clamp_i16(scale_float(gyro_bias.bias[i], SCALE_GYRO_MDPS)));
		}
		uint32_t observed_bits, limit_bits;
		memcpy(&observed_bits, &gyro_bias.observed, sizeof(observed_bits));
		memcpy(&limit_bits, &gyro_bias.limit, sizeof(limit_bits));
		put_u32_le(frame, 14, observed_bits);
		put_u32_le(frame, 18, limit_bits);
		put_u16_le(frame, 22, gyro_cal_elapsed_ms);
		frame[24] = gyro_bias.axis;
		frame[25] = gyro_bias.status == 1 ?
			(gyro_bias.settling < OF_GYRO_SETTLE_SECONDS ? 1 : 2) : 0;
		frame[26] = 2; /* v2 adds maximum raw standard deviation, milli-dps. */
		float raw_noise_max = fmaxf(gyro_bias.raw_noise_dps[0],
			fmaxf(gyro_bias.raw_noise_dps[1], gyro_bias.raw_noise_dps[2]));
		put_u16_le(frame, 27, (uint16_t)fminf(65535, raw_noise_max * 1000));
		last_report_ms = now;
		if (bt_gatt_notify(NULL, &openfloat_svc.attrs[2], frame, sizeof(frame))) {
			atomic_set(&gyro_cal_notify_pending, 1);
		}
	}
}

static void print_openfloat_live_text(uint32_t sequence, uint32_t dt_us,
				      const struct vec3 *accel,
				      const struct vec3 *gyro,
				      const struct quat *q,
				      float roll_deg, float pitch_deg,
				      float yaw_deg)
{
	printk("OFRAW,1,%u,%llu,%u,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n",
	       sequence,
	       (unsigned long long)uptime_us(),
	       dt_us,
	       scale_float(accel->x, SCALE_MG),
	       scale_float(accel->y, SCALE_MG),
	       scale_float(accel->z, SCALE_MG),
	       scale_float(gyro->x, SCALE_GYRO_MDPS),
	       scale_float(gyro->y, SCALE_GYRO_MDPS),
	       scale_float(gyro->z, SCALE_GYRO_MDPS),
	       scale_float(roll_deg - cant_offset_deg, SCALE_CDEG),
	       scale_float(pitch_deg - pitch_offset_deg, SCALE_CDEG),
	       scale_float(yaw_deg, SCALE_CDEG),
	       scale_float(q->w, SCALE_QUAT),
	       scale_float(q->x, SCALE_QUAT),
	       scale_float(q->y, SCALE_QUAT),
	       scale_float(q->z, SCALE_QUAT),
	       shot_count);
}

static void print_cpu_load_if_due(uint64_t now_us)
{
	static uint64_t last_cpu_load_us;
	int load_permille;

	if ((now_us - last_cpu_load_us) < 1000000U) {
		return;
	}

	last_cpu_load_us = now_us;
	load_permille = cpu_load_get(true);
	if (load_permille < 0) {
		printk("# CPU_LOAD,error,%d\n", load_permille);
		return;
	}

	printk("# CPU_LOAD,active_permille=%d,active_pct=%d.%01d,idle_pct=%d.%01d,"
	       "fifo_overruns=%u,fifo_resyncs=%u,audio_blocks=%u,audio_failures=%u,"
	       "audio_peak_raw=%u\n",
	       load_permille, load_permille / 10, load_permille % 10,
	       (1000 - load_permille) / 10, (1000 - load_permille) % 10,
	       fifo_overrun_count, fifo_resync_count, audio_blocks_processed,
	       audio_read_failures, (uint32_t)audio_peak_raw);
}

int main(void)
{
	struct quat q = {
		.w = 1.0f,
		.x = 0.0f,
		.y = 0.0f,
		.z = 0.0f,
	};
	int err;

	printk("# OPENFLOAT_PROTO,1\n");
	printk("# target: Seeed XIAO nRF54L15 Sense\n");
	printk("# mount: %s\n", OPENFLOAT_MOUNT_NAME);
	printk("# imu_odr_hz: %d\n", IMU_ODR_HZ);
	printk("# ble_output_hz: %d averaged samples/s (%d raw samples averaged per frame)\n",
	       IMU_ODR_HZ / SAMPLES_PER_OUTPUT, SAMPLES_PER_OUTPUT);
	printk("# ui: user LED status, user button calibration\n");
	printk("# ble: %s, batch %d averaged frames per notification\n",
	       CONFIG_BT_DEVICE_NAME, OPENFLOAT_BLE_FRAMES_PER_NOTIFICATION);
	printk("# BLE live frame: %d bytes each, batched payload %d bytes, magic[2]='OF', proto u8, type u8, seq u16, dt_us u16, accel_deci_g int8[3], quat_q10k int16[4], mic u8\n",
	       OPENFLOAT_BLE_LIVE_FRAME_SIZE,
	       OPENFLOAT_BLE_NOTIFY_PAYLOAD_SIZE);
	printk("# format: OFSHOT,proto,shot_id,uptime_us,ax_mg,ay_mg,az_mg,shot_count\n");

	k_work_init(&shot_persist_work, shot_persist_work_handler);
	k_work_init(&shot_log_persist_work, shot_log_persist_work_handler);
	k_work_init_delayable(&shot_log_reconcile_work,
			      shot_log_reconcile_work_handler);
	k_work_init(&wake_sens_persist_work, wake_sens_persist_work_handler);
	k_work_init(&sleep_time_persist_work, sleep_time_persist_work_handler);
	k_work_init(&sleep_sens_persist_work, sleep_sens_persist_work_handler);
	k_work_init(&offsets_persist_work, offsets_persist_work_handler);
	k_work_init(&gyro_bias_persist_work, gyro_bias_persist_work_handler);
	k_work_init_delayable(&battery_measure_work, battery_measure_work_handler);
	k_work_init(&buffer_rate_persist_work, buffer_rate_persist_work_handler);
	k_work_init(&buffer_nvs_persist_work, buffer_nvs_persist_work_handler);
	k_work_init(&auto_sleep_persist_work, auto_sleep_persist_work_handler);
	k_work_init(&streamrate_persist_work, streamrate_persist_work_handler);
	k_work_init(&follow_through_persist_work, follow_through_persist_work_handler);
	k_work_init(&trace_persist_work, trace_persist_work_handler);
	k_work_init_delayable(&trace_upload_work, trace_upload_work_handler);
	k_work_init_delayable(&adv_start_work, adv_start_work_handler);
	err = settings_subsys_init();
	if (err) {
		printk("# settings init failed: %d (shot count will not persist)\n",
		       err);
	} else {
		int loaded = settings_load();
		reset_legacy_trace_storage();
		if (loaded == 0 && trace_boot_counter != UINT32_MAX) {
			uint32_t next_boot = trace_boot_counter + 1;
			if (settings_save_one("openfloat/bootseq", &next_boot, sizeof(next_boot)) == 0)
				trace_boot_id = next_boot;
		}
	}
	if (stored_gyro_bias_valid && stored_gyro_bias[0] == OPENFLOAT_MOUNT) {
		of_gyro_bias_restore(&gyro_bias, stored_gyro_bias, OPENFLOAT_MOUNT);
	}
	gyro_bias.status = gyro_bias.valid ? 2 : 0;
	atomic_set(&gyro_cal_status, gyro_bias.status);
	printk("# gyro bias: %s\n", gyro_bias.valid ? "restored" : "not calibrated");
	printk("# shot_count restored: %d\n", shot_count);
	printk("# stored_shots restored: %u/%u\n", stored_shot_log.count,
	       STORED_SHOT_CAPACITY);
	int32_t wake_tenths = scale_float(wake_sensitivity_g, 10.0f);
	printk("# wake_sensitivity restored: %d.%01d g\n",
	       wake_tenths / 10, wake_tenths % 10);
	printk("# sleep_timeout restored: %u s\n", disconnected_sleep_timeout_ms / 1000);
	int32_t sleep_sens_hundredths = scale_float(sleep_sensitivity_g, 100.0f);
	printk("# sleep_sensitivity restored: %d.%02d g\n",
	       sleep_sens_hundredths / 100, sleep_sens_hundredths % 100);
	if (stored_orientation_zero_valid &&
	    stored_orientation_zero[0] == OPENFLOAT_MOUNT) {
		cant_offset_deg = (float)stored_orientation_zero[1] / 1000.0f;
		pitch_offset_deg = (float)stored_orientation_zero[2] / 1000.0f;
	} else if (stored_orientation_zero_valid ||
		   OPENFLOAT_MOUNT != OF_MOUNT_LEGACY_X90) {
		cant_offset_deg = 0.0f;
		pitch_offset_deg = 0.0f;
		printk("# mounting profile changed: repeat level zero calibration\n");
	}
	print_float_signed("# cant_offset restored:", cant_offset_deg, 2);
	print_float_signed("# pitch_offset restored:", pitch_offset_deg, 2);
	printk("# buffer_rate restored: %d Hz\n", buffer_rate_hz);
	printk("# buffer_nvs restored: %s\n", buffer_nvs_enabled ? "ON" : "OFF");
	printk("# auto_sleep restored: %s\n", auto_sleep_enabled ? "ON" : "OFF");
	printk("# streamrate restored: %u/%d Hz\n", IMU_ODR_HZ / SAMPLES_PER_OUTPUT, ble_stream_divider);
	printk("# follow_through restored: %u ms\n", follow_through_ms);

	init_user_led();
	init_user_btn();

	(void)init_ble();
	(void)k_work_reschedule(&battery_measure_work, K_NO_WAIT);

	err = configure_imu();
	if (err) {
		return 0;
	}

	bool imu_int_ready = (init_imu_interrupt() == 0);

	k_thread_create(&audio_thread_data, audio_thread_stack,
			K_THREAD_STACK_SIZEOF(audio_thread_stack),
			audio_thread_entry, NULL, NULL, NULL,
			AUDIO_THREAD_PRIORITY, 0, K_NO_WAIT);

	last_activity_time_ms = k_uptime_get();

	(void)cpu_load_get(true);

	while (1) {
		static uint8_t ble_payload[OPENFLOAT_BLE_NOTIFY_PAYLOAD_SIZE];
		static uint8_t ble_payload_frames;
		static struct imu_sample drained[LSM6DSL_FIFO_DRAIN_MAX_SAMPLES + 1];
		static struct vec3 accel_sum; /* current output group accumulator */
		static struct vec3 gyro_sum;
		static uint32_t group_count; /* samples accumulated in this group */
		uint32_t fifo_samples;
		service_gyro_calibration_requests();

		/*
		 * Block until the FIFO watermark interrupt fires, then drain. If
		 * the interrupt is unavailable, fall back to cooperative polling.
		 */
		if (imu_int_ready) {
			k_sem_take(&imu_fifo_sem, K_MSEC(20));
		}

		print_cpu_load_if_due(uptime_us());

		uint32_t overruns_before = fifo_overrun_count;
		uint32_t resyncs_before = fifo_resync_count;
		err = read_imu_fifo(drained, ARRAY_SIZE(drained), &fifo_samples);
		if (err || fifo_overrun_count != overruns_before || fifo_resync_count != resyncs_before) {
			/* Never average across a gap, or certify a discontinuous calibration. */
			trace_stream_gap();
			group_count = 0;
			accel_sum = (struct vec3){ 0 };
			gyro_sum = (struct vec3){ 0 };
			if (gyro_bias.status == 1) {
				gyro_cal_elapsed_ms = (uint16_t)MIN(65535, k_uptime_get() - gyro_cal_started_ms);
				of_gyro_bias_reject(&gyro_bias, fifo_fault_reason ? fifo_fault_reason : OF_GYRO_STREAM_GAP,
					0, fifo_fault_observed, fifo_fault_expected);
				atomic_set(&gyro_cal_status, 3);
				atomic_set(&gyro_cal_notify_pending, 1);
			}
		}

		/*
		 * Re-arm the level-triggered watermark interrupt now that the FIFO
		 * has been drained back below FTH. Done before the fusion/BLE work
		 * so samples accumulating during that work are not missed.
		 */
		if (imu_int_ready) {
			gpio_pin_interrupt_configure_dt(&imu_int,
							GPIO_INT_LEVEL_ACTIVE);
		}

		notify_gyro_calibration();

		if (err) {
			printk("# IMU FIFO read failed: %d\n", err);
			if (!imu_int_ready) {
				k_yield();
			}
			continue;
		}

		if (fifo_samples == 0) {
			if (!imu_int_ready) {
				k_yield();
			}
			continue;
		}

		raw_sample_sequence += fifo_samples;

		/*
		 * Split the drained batch into fixed SAMPLES_PER_OUTPUT groups. Each
		 * completed group becomes one distinct averaged output frame, so a
		 * large efficient drain still yields fine-grained, non-duplicated
		 * telemetry. group_count/accel_sum carry across drains, so a group
		 * straddling two batches is still averaged correctly.
		 */
		for (uint32_t s = 0; s < fifo_samples; s++) {
			struct vec3 avg_accel;
			struct vec3 avg_gyro;
			float roll_deg;
			float pitch_deg;
			float yaw_deg;
			uint16_t flags = 0;
			size_t offset;
			bool shot_detected = false;

			accel_sum.x += drained[s].accel.x;
			accel_sum.y += drained[s].accel.y;
			accel_sum.z += drained[s].accel.z;
			gyro_sum.x += drained[s].gyro.x;
			gyro_sum.y += drained[s].gyro.y;
			gyro_sum.z += drained[s].gyro.z;
			group_count++;

			if (group_count < SAMPLES_PER_OUTPUT) {
				continue;
			}

			avg_accel.x = accel_sum.x / group_count;
			avg_accel.y = accel_sum.y / group_count;
			avg_accel.z = accel_sum.z / group_count;
			avg_gyro.x = gyro_sum.x / group_count;
			avg_gyro.y = gyro_sum.y / group_count;
			avg_gyro.z = gyro_sum.z / group_count;

			accel_sum = (struct vec3){ 0 };
			gyro_sum = (struct vec3){ 0 };
			group_count = 0;

			struct vec3 fusion_gyro;
			process_gyro_calibration(&avg_accel, &avg_gyro, &fusion_gyro);
			madgwick_update_imu(&q, &fusion_gyro, &avg_accel,
					    (float)OUTPUT_DT_US / 1000000.0f);
			quat_to_euler(&q, &roll_deg, &pitch_deg, &yaw_deg);

			trace_output_tick++;
			if (buffer_rate_hz > 0) {
				/* Offline sessions use a fixed 52 Hz representation so all
				 * eighty 3.5 s + 1.5 s traces fit in the RRAM budget. */
				uint32_t stride = OF_OFFLINE_TRACE_STRIDE;
				trace_decimate_counter++;
				if (trace_decimate_counter >= stride) {
					trace_decimate_counter = 0;
					int16_t r_cdeg = clamp_i16(scale_float(roll_deg, SCALE_CDEG));
					int16_t p_cdeg = clamp_i16(scale_float(pitch_deg, SCALE_CDEG));
					int16_t y_cdeg = clamp_i16(scale_float(yaw_deg, SCALE_CDEG));
					ram_trace_push(r_cdeg, p_cdeg, y_cdeg);
				}
			}

			/* Check for active movement to reset inactivity timer */
			float g_mag2 = avg_gyro.x * avg_gyro.x + avg_gyro.y * avg_gyro.y + avg_gyro.z * avg_gyro.z;
			float a_mag = sqrtf(avg_accel.x * avg_accel.x + avg_accel.y * avg_accel.y + avg_accel.z * avg_accel.z);
			float a_dev = fabs(a_mag - MPS2_PER_G);

			/* Wake/activity trigger: gyro > ~57 deg/s (1.0 rad/s) OR accel deviation > sleep_sensitivity_g */
			float sleep_sensitivity_mps2 = sleep_sensitivity_g * MPS2_PER_G;
			if (g_mag2 > 1.0f || a_dev > sleep_sensitivity_mps2) {
				last_activity_time_ms = k_uptime_get();
			}

			bool simulate_shot = false;
			if (trigger_shot_requested) {
				trigger_shot_requested = false;
				simulate_shot = true;
			}

			if (simulate_shot || detect_shot(&avg_accel, &avg_gyro, uptime_us(), roll_deg,
					pitch_deg, yaw_deg)) {
				shot_detected = true;
				last_activity_time_ms = k_uptime_get();

				shot_count++;
				shot_id++;

				last_shot_accel = avg_accel;
				last_shot_sequence = (uint16_t)telemetry_sequence;
				last_shot_record = (struct stored_shot){
					.shot_count = (uint16_t)shot_count,
					.shot_id = shot_id,
					.ax_mg = clamp_i16(scale_float(avg_accel.x, SCALE_MG)),
					.ay_mg = clamp_i16(scale_float(avg_accel.y, SCALE_MG)),
					.az_mg = clamp_i16(scale_float(avg_accel.z, SCALE_MG)),
					.threshold_cg = (uint16_t)scale_float(
						shot_accel_threshold_mps2 / MPS2_PER_G, 100.0f),
					.roll_cdeg = clamp_i16(scale_float(roll_deg - cant_offset_deg, SCALE_CDEG)),
					.pitch_cdeg = clamp_i16(scale_float(pitch_deg - pitch_offset_deg, SCALE_CDEG)),
					.yaw_cdeg = clamp_i16(scale_float(yaw_deg, SCALE_CDEG)),
					.clicker_dt_ms = 0,
					.impact_dt_ms = 0,
				};

				/*
				 * Always queue the shot in the RAM log and freeze
				 * its trace, even while connected, so a dropped live
				 * frame can still be recovered via the stored-shot
				 * ack/retry path. The trace freeze is RAM-only unless
				 * bufnvs is enabled, so this adds no RRAM writes by
				 * default; the shot-log RRAM write is deferred below.
				 */
				stored_shot_append(&last_shot_record);
				if (buffer_rate_hz > 0) {
					schedule_trace_freeze(shot_id, simulate_shot);
				}

				led_shot_until_ms = k_uptime_get() + LED_SHOT_PULSE_MS;

				printk("OFSHOT,1,%u,%llu,%d,%d,%d,%d,0,0\n",
				       shot_id,
				       (unsigned long long)uptime_us(),
				       scale_float(avg_accel.x, SCALE_MG),
				       scale_float(avg_accel.y, SCALE_MG),
				       scale_float(avg_accel.z, SCALE_MG),
				       shot_count);

				(void)notify_openfloat_shot_event(2);
				k_work_submit(&shot_persist_work);
				if (ble_notify_enabled) {
					/*
					 * Connected: defer the ~2.2 KB shot-log RRAM
					 * write. If the browser acks the live frame
					 * first the queue drains and the reconcile
					 * handler is a no-op, so RRAM is written only
					 * when delivery actually failed.
					 */
					k_work_schedule(
						&shot_log_reconcile_work,
						K_MSEC(SHOT_LOG_RECONCILE_DELAY_MS));
				} else {
					/* Disconnected: nobody will ack; persist now. */
					k_work_submit(&shot_log_persist_work);
				}
			}
			if (trace_freeze_pending && trace_output_tick >= trace_due_tick && trace_decimate_counter == 0)
				trace_freeze_pending_slot();
			if (buffer_rate_hz == 0 && ram_trace_count) trace_stream_gap();
			if (ble_send_count_sync) {
				ble_send_count_sync = false;
				(void)notify_openfloat_shot_event(3);
			}
			if (ble_send_storage_status) {
				ble_send_storage_status = false;
				notify_storage_status();
			}
			if (trace_status_pending) {
				trace_status_pending = false;
				notify_trace_status();
			}
			retry_stalled_stored_shot_upload();
			if (!shot_detected) {
				notify_next_stored_shot();
			}

			if (user_btn_pressed() || zero_requested) {
				zero_requested = false;
				cant_offset_deg = roll_deg;
				pitch_offset_deg = pitch_deg;
				k_work_submit(&offsets_persist_work);
				flags |= BIT(0);
				printk("# Calibrated: cant=0 pitch=0\n");
			}

			update_user_led();
			if (shot_count > 0) {
				flags |= BIT(1);
			}

			if ((telemetry_sequence % SERIAL_PRINT_DIVIDER) == 0) {
				print_openfloat_live_text(telemetry_sequence,
							  OUTPUT_DT_US, &avg_accel,
							  &avg_gyro, &q, roll_deg,
							  pitch_deg, yaw_deg);
			}

			if ((telemetry_sequence % ble_stream_divider) == 0) {
				offset = ble_payload_frames *
					 OPENFLOAT_BLE_LIVE_FRAME_SIZE;
				build_openfloat_live_binary(
					&ble_payload[offset],
					telemetry_sequence, OUTPUT_DT_US * ble_stream_divider,
					&avg_accel, &q, flags);
				ble_payload_frames++;
				if (ble_payload_frames >=
				    OPENFLOAT_BLE_FRAMES_PER_NOTIFICATION) {
					notify_openfloat_live_binary(
						ble_payload, sizeof(ble_payload),
						ble_payload_frames);
					ble_payload_frames = 0;
				}
			}

			telemetry_sequence++;
		}

		/*
		 * Check for inactivity and enter deep sleep if due.
		 */
		uint64_t now_ms = k_uptime_get();
		uint64_t inactive_dur = now_ms - last_activity_time_ms;
		bool should_sleep = false;


		if (auto_sleep_enabled) {
			if (current_conn == NULL) {
				if (inactive_dur > disconnected_sleep_timeout_ms) {
					should_sleep = true;
				}
			} else {
				if (inactive_dur > CONNECTED_SLEEP_TIMEOUT_MS) {
					should_sleep = true;
				}
			}
		}

		if (should_sleep) {
			printk("# Inactivity timeout (%llu s): entering deep sleep\n",
			       (unsigned long long)(inactive_dur / 1000));
			enter_deep_sleep();
		}
	}

	return 0;
}
