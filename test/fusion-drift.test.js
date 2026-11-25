import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const firmware=readFileSync(new URL("../firmware/src/main.c",import.meta.url),"utf8");
const fusion=firmware.slice(firmware.indexOf("static float inv_sqrtf("),firmware.indexOf("static void apply_mount_rotation("));

test("production fusion preserves stationary heading, subtracts mounted bias and integrates real slow yaw",()=>{
  const dir=mkdtempSync(join(tmpdir(),"openfloat-fusion-"));
  try {
    const path=join(dir,"probe.c");
    writeFileSync(path,`
#include <assert.h>
#include <math.h>
#include "gyro_bias.h"
#include "mount_axes.h"
#include "imu_stream.h"
#define RAD_TO_DEG 57.29577951308232f
#define MADGWICK_BETA 0.08f
struct quat { float w,x,y,z; };
struct vec3 { float x,y,z; };
${fusion}
static struct quat pose(float roll,float pitch,float yaw) {
 float r=roll/RAD_TO_DEG/2,p=pitch/RAD_TO_DEG/2,y=yaw/RAD_TO_DEG/2;
 return (struct quat){cosf(r)*cosf(p)*cosf(y)+sinf(r)*sinf(p)*sinf(y),
 sinf(r)*cosf(p)*cosf(y)-cosf(r)*sinf(p)*sinf(y),
 cosf(r)*sinf(p)*cosf(y)+sinf(r)*cosf(p)*sinf(y),
 cosf(r)*cosf(p)*sinf(y)-sinf(r)*sinf(p)*cosf(y)};
}
int main(void) {
 for(int side=0;side<2;side++) {
  struct of_gyro_bias cal={0};
  float a[3]={0,side?9.81f:0,side?0:9.81f};
  float raw[3]={0.003f,-0.002f,0.004f};
  openfloat_mount_rotate(&raw[0],&raw[1],&raw[2]);
  of_gyro_bias_start(&cal);
  for(int i=0;i<10000 && cal.status==1;i++) of_gyro_bias_update(&cal,a,raw,OUTPUT_DT_US/1e6f);
  assert(cal.status==2);
  // Exercise the exact NVS milli-dps rounding and restore path too.
  int32_t record[4]={OPENFLOAT_MOUNT,0,0,0};
  for(int i=0;i<3;i++) record[i+1]=(int32_t)roundf(cal.bias[i]*RAD_TO_DEG*1000);
  of_gyro_bias_restore(&cal,record,OPENFLOAT_MOUNT);
  for(int mode=0;mode<3;mode++) {
   struct quat q=pose(side?90:0,0,58.8f);
   float r,p,y;
   for(int i=0;i<25000;i++) {
    float input[3]={raw[0],raw[1],raw[2]},corrected[3];
    // 0: corrected rest. 1: residual matching the user's -1.4 deg / 30s.
    // 2: genuine 1 degree/s yaw. Body Y is vertical when bow lies on side.
    float rate=mode==1 ? -1.4f/30.0f : mode==2 ? 1.0f : 0;
    input[side?1:2]+=rate/RAD_TO_DEG;
    of_gyro_bias_apply(&cal,input,corrected);
    struct vec3 acc={a[0],a[1],a[2]},g={corrected[0],corrected[1],corrected[2]};
    acc.x+=0.0001f*(1.2f+sinf(i*0.63f));
    madgwick_update_imu(&q,&g,&acc,OUTPUT_DT_US/1e6f);
   }
   quat_to_euler(&q,&r,&p,&y);
   assert(isfinite(y));
   if(mode==0) assert(fabsf(y-58.8f)<0.03f); // includes <=0.0005 dps NVS rounding
   if(mode==1) assert(fabsf(y-58.8f+1.4f)<0.04f);
   if(mode==2) assert(fabsf(y-58.8f-30.0f)<0.04f);
  }
 }
 // Exact aligned rest must not divide by a zero correction gradient.
 struct quat q={1,0,0,0}; struct vec3 a={0,0,9.81f},g={0,0,0};
 for(int i=0;i<25000;i++) madgwick_update_imu(&q,&g,&a,OUTPUT_DT_US/1e6f);
 assert(isfinite(q.w) && q.w==1 && q.x==0 && q.y==0 && q.z==0);
}
`);
    const bin=join(dir,"probe");
    const built=spawnSync("cc",["-std=c99","-Wall","-Wextra","-Werror","-DOPENFLOAT_MOUNT=2","-I",fileURLToPath(new URL("../firmware/src/",import.meta.url)),path,"-lm","-o",bin],{encoding:"utf8"});
    assert.equal(built.status,0,built.stderr);
    const run=spawnSync(bin,[],{encoding:"utf8"});
    assert.equal(run.status,0,run.stderr);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
