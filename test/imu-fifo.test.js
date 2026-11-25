import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(new URL("../firmware/src/main.c", import.meta.url), "utf8");

test("FIFO reader validates entire transfers, rejects corruption before fusion and retains exact bus errors", () => {
  // Compile the production reader with a scripted I2C transport, not a copy of
  // its algorithm. Each expected transaction has an exact register and length.
  const reader = source.slice(source.indexOf("static int imu_fifo_read("), source.indexOf("\nstatic void init_user_led"));
  const defines = [...source.matchAll(/^#define (LSM6DSL_REG_FIFO_STATUS1|LSM6DSL_REG_FIFO_DATA_OUT_L|LSM6DSL_FIFO_WORDS_PER_SAMPLE|LSM6DSL_FIFO_DRAIN_MAX_SAMPLES|LSM6DSL_FIFO_STATUS2_OVER_RUN|LSM6DSL_FIFO_STATUS2_FIFO_FULL_SMART) .+$/gm)].map(m=>m[0]).join("\n");
  const dir=mkdtempSync(join(tmpdir(),"openfloat-fifo-"));
  try {
    const path=join(dir,"probe.c");
    writeFileSync(path, `
#include <assert.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "gyro_bias.h"
#include "imu_stream.h"
#define MIN(a,b) ((a)<(b)?(a):(b))
#define BIT(n) (1u<<(n))
${defines}
#define LSM6DSL_FIFO_BYTES_PER_SAMPLE (LSM6DSL_FIFO_WORDS_PER_SAMPLE * sizeof(uint16_t))
struct vec3 { float x,y,z; };
struct imu_sample { struct vec3 accel,gyro; };
static int imu_i2c;
static uint8_t fifo_drain_raw[LSM6DSL_FIFO_DRAIN_MAX_SAMPLES*12];
static uint32_t fifo_overrun_count, fifo_resync_count;
static uint8_t fifo_fault_reason;
static int32_t fifo_fault_observed, fifo_fault_expected;
static int resets, reset_error, conversions;
struct step { uint8_t reg; size_t len; int error; uint16_t words,pattern; uint8_t flags; };
static struct step steps[8];
static int used,position;
static void add(uint8_t reg,size_t len,int error,uint16_t words,uint16_t pattern,uint8_t flags) {
  steps[used++]=(struct step){reg,len,error,words,pattern,flags};
}
static void status(int error,uint16_t words,uint16_t pattern,uint8_t flags) { add(0x3a,4,error,words,pattern,flags); }
static void data(size_t length,int error) { add(0x3e,length,error,0,0,0); }
static void begin(void) {
  assert(position==used); used=position=0; resets=reset_error=conversions=0;
  fifo_overrun_count=fifo_resync_count=0;
}
static int i2c_burst_read_dt(const int *device,uint8_t reg,uint8_t *bytes,size_t len) {
  assert(device==&imu_i2c && position<used);
  struct step s=steps[position++]; assert(reg==s.reg && len==s.len);
  if (s.error) return s.error;
  if (reg==0x3a) {
    bytes[0]=s.words&255; bytes[1]=(s.words>>8)|s.flags;
    bytes[2]=s.pattern&255; bytes[3]=s.pattern>>8;
  } else for (size_t i=0;i<len;i++) bytes[i]=(uint8_t)i;
  return 0;
}
static int configure_imu_fifo(void) { resets++; return reset_error; }
static void convert_raw_direct_sample(const uint8_t *bytes,struct vec3 *a,struct vec3 *g) {
  conversions++; a->x=bytes[6]; g->x=bytes[0];
}
${reader}
int main(void) {
  struct imu_sample out[32]; uint32_t count;
  assert(IMU_ODR_HZ==1666 && LSM6DSL_IMU_ODR_REG==8);
  assert(SAMPLES_PER_OUTPUT==2 && OUTPUT_DT_US==1200 && OF_OFFLINE_TRACE_STRIDE==16);
  assert(IMU_ODR_HZ*12*9 < 400000*0.6); // payload occupancy leaves status/CPU headroom
  begin(); status(0,96,0,0); data(192,0); status(0,12,0,0);
  assert(read_imu_fifo(out,32,&count)==0 && count==16 && conversions==16);
  assert(out[15].gyro.x==180 && out[15].accel.x==186 && !fifo_fault_reason);
  begin(); status(0,13,0,0); data(24,0); status(0,1,0,0);
  assert(read_imu_fifo(out,32,&count)==0 && count==2); // incomplete tail stays in device
  begin(); status(0,5,0,0);
  assert(read_imu_fifo(out,32,&count)==0 && !count && !conversions);
  begin(); status(0,96,0,0); data(24,0); status(0,84,0,0);
  assert(read_imu_fifo(out,2,&count)==0 && count==2); // caller capacity is honored
  begin(); status(0,20,2,0); data(8,0);
  assert(read_imu_fifo(out,32,&count)==0 && !count && !conversions);
  assert(fifo_fault_reason==OF_GYRO_FIFO_ALIGNMENT && fifo_fault_observed==2 && fifo_resync_count==1);
  begin(); status(0,96,0,0); data(192,0); status(0,12,2,0);
  assert(read_imu_fifo(out,32,&count)==0 && !count && !conversions);
  assert(fifo_fault_reason==OF_GYRO_FIFO_ALIGNMENT);
  begin(); status(0,96,6,0);
  assert(read_imu_fifo(out,32,&count)==0 && !count && resets==1);
  assert(fifo_fault_reason==OF_GYRO_FIFO_ALIGNMENT && fifo_fault_observed==6);
  begin(); status(0,96,0,64);
  assert(read_imu_fifo(out,32,&count)==0 && !count && resets==1);
  assert(fifo_fault_reason==OF_GYRO_FIFO_OVERFLOW && fifo_overrun_count==1);
  begin(); status(0,96,0,0); data(192,0); status(0,96,0,32);
  assert(read_imu_fifo(out,32,&count)==0 && !count && !conversions && resets==1);
  assert(fifo_fault_reason==OF_GYRO_FIFO_OVERFLOW);
  begin(); status(0,96,0,64); reset_error=-11;
  assert(read_imu_fifo(out,32,&count)==-11 && !count);
  assert(fifo_fault_reason==OF_GYRO_I2C_ERROR && fifo_fault_observed==-11);
  for (int at=0;at<3;at++) {
    begin(); status(at==0?-5:0,96,0,0);
    if (at>0) data(192,at==1?-5:0);
    if (at>1) status(-5,0,0,0);
    assert(read_imu_fifo(out,32,&count)==-5 && !count && !conversions);
    assert(fifo_fault_reason==OF_GYRO_I2C_ERROR && fifo_fault_observed==-5);
  }
  begin();
}
`);
    const binary=join(dir,"probe");
    const built=spawnSync("cc",["-std=c99","-Wall","-Wextra","-Werror","-I",fileURLToPath(new URL("../firmware/src/",import.meta.url)),path,"-lm","-o",binary],{encoding:"utf8"});
    assert.equal(built.status,0,built.stderr);
    const run=spawnSync(binary,[],{encoding:"utf8"});
    assert.equal(run.status,0,run.stderr);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("IMU uses its documented 400 kHz bus limit and reports errors without waiting for samples", () => {
  const overlay=readFileSync(new URL("../firmware/app.overlay",import.meta.url),"utf8");
  assert.match(overlay,/&i2c30\s*\{[^}]*clock-frequency\s*=\s*<400000>/s);
  assert.match(source,/k_sem_take\(&imu_fifo_sem, K_MSEC\(20\)\)/);
  const notify=source.indexOf("\n\t\tnotify_gyro_calibration();");
  const failedRead=source.indexOf('printk("# IMU FIFO read failed:',notify);
  assert.ok(notify>0 && failedRead>notify);
});
