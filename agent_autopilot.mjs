// ============================================================
// Reference autopilot agent for the Coding-Agent-as-Policy sim.
//
// This is an automated stand-in for the LLM "coding agent". It runs as its own
// process, polls the HTTP API every loop (so the website shows "Agent
// connected"), measures a calibration per camera, and drives the car to the
// goal with a simple feedback controller.
//
// It is NOT the classroom LLM-as-policy demo; it is a dependency-free reference
// policy so the simulator is never "No agent detected", and so the car visibly
// moves for testing. Run the sister `claude` terminal for the real demo.
//
//   node agent_autopilot.mjs
//
// Requires the browser sim tab to be OPEN AND FOREGROUND (the browser is the
// physics engine). If the car never moves, the autopilot will say so.
// ============================================================

const BASE = process.env.SIM_URL || "http://127.0.0.1:8088";
const LOOP_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a)); // wrap to [-pi, pi]
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function get(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  return r.ok ? r.json().catch(() => ({})) : null;
}
const log = (message) => post("/api/log", { message, source: "agent" });
const motor = (vx, vy, omega, duration) => post("/api/motor", { vx, vy, omega, duration });

async function pose() { return (await get("/api/state")).pose; }

// Drive one trial command and return how far the car actually moved / turned.
async function trial(cmd, dur) {
  const p0 = await pose();
  await motor(cmd.vx || 0, cmd.vy || 0, cmd.omega || 0, dur);
  await sleep(dur * 1000 + 500);
  const p1 = await pose();
  return {
    dist: Math.hypot(p1.x - p0.x, p1.y - p0.y),
    dtheta: norm(p1.theta - p0.theta)
  };
}

async function calibrate(camera) {
  await log(`Calibrating ${camera.replace("_", "-")} camera: measuring vx, vy, omega.`);
  const vx = await trial({ vx: 0.5 }, 0.8);
  const vy = await trial({ vy: 0.5 }, 0.8);
  const om = await trial({ omega: 0.6 }, 0.8);

  if (vx.dist < 0.02 && om.dtheta < 0.02) {
    await log("Car did not move during calibration. Is the sim tab open and FOCUSED? The browser runs the physics.");
    return false;
  }
  const record = {
    vx_world_per_unit_s: Number((vx.dist / 0.8 / 0.5).toFixed(3)),
    vy_world_per_unit_s: Number((vy.dist / 0.8 / 0.5).toFixed(3)),
    omega_rad_per_unit_s: Number((om.dtheta / 0.8 / 0.6).toFixed(3)),
    method: "pose-delta trials"
  };
  await post("/api/calibration", { camera, calibration: record });
  await log(`Saved calibration for ${camera}: vx=${record.vx_world_per_unit_s}, vy=${record.vy_world_per_unit_s}, omega=${record.omega_rad_per_unit_s}.`);
  return true;
}

// One closed-loop step toward the goal. The car's world heading is -theta, so
// the target body heading is -atan2(dy, dx). Pure feedback, robust to the
// hidden per-camera scale.
let holding = false;       // for logging only: avoids spamming "reached"
let lastPoseKey = null;    // detect a frozen car (no physics / tab not focused)
let stuckCount = 0;
let stuckWarned = false;

async function driveStep() {
  const s = await get("/api/state");

  // If the car has not moved across recent commands, the browser physics is not
  // running (tab closed or backgrounded). Back off instead of spamming motors.
  const key = `${s.pose.x.toFixed(3)},${s.pose.y.toFixed(3)},${s.pose.theta.toFixed(3)}`;
  if (key === lastPoseKey) {
    if (++stuckCount >= 3) {
      if (!stuckWarned) {
        await log("Car is not responding to commands. Open and FOCUS the sim browser tab (it runs the physics).");
        stuckWarned = true;
      }
      return; // do not pile up commands while nothing is moving
    }
  } else {
    stuckCount = 0;
    stuckWarned = false;
    lastPoseKey = key;
  }

  const dx = s.goal.x - s.pose.x;
  const dy = s.goal.y - s.pose.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.3) {
    if (!holding) { await log(`Reached the goal (within ${dist.toFixed(2)}). Holding.`); holding = true; }
    return;
  }
  if (holding) { await log("Goal or car changed. Driving to the goal."); holding = false; }

  // Potential field: attraction toward the goal plus repulsion from any nearby
  // obstacle, so the car steers around the gray boxes instead of into them.
  let ax = dx / dist, ay = dy / dist;          // unit attraction
  for (const o of (s.obstacles || [])) {
    const ox = s.pose.x - o.x, oy = s.pose.y - o.y;
    const od = Math.hypot(ox, oy);
    const reach = Math.max(o.w, o.h) / 2 + 0.7; // influence radius around the box
    if (od < reach && od > 1e-3) {
      const strength = 1.6 * (reach - od) / reach; // stronger as it gets closer
      ax += (ox / od) * strength;
      ay += (oy / od) * strength;
    }
  }
  const worldDir = Math.atan2(ay, ax);
  const targetTheta = -worldDir;               // car world heading is -theta
  const err = norm(targetTheta - s.pose.theta);
  if (Math.abs(err) > 0.25) {
    await motor(0, 0, clamp(2.0 * err, -1.5, 1.5), 0.3);
  } else {
    await motor(clamp(1.2 * dist, 0.35, 1.0), 0, clamp(1.0 * err, -0.6, 0.6), 0.4);
  }
}

async function main() {
  await log("Autopilot agent online. Polling for instructions.");
  let warnedUncalibrated = false;
  for (;;) {
    try {
      const inst = await get("/api/instruction"); // keeps the heartbeat alive
      if (inst.stage === "calibrate") {
        if (!inst.activeCameraCalibrated) {
          await calibrate(inst.activeCamera);
        }
      } else if (inst.stage === "execute") {
        if (!inst.activeCameraCalibrated) {
          if (!warnedUncalibrated) { await log("Asked to execute but this camera is not calibrated. Switch to Calibrate first."); warnedUncalibrated = true; }
        } else {
          warnedUncalibrated = false;
          await driveStep();
        }
      }
    } catch (e) {
      // server momentarily unavailable; keep looping
    }
    await sleep(LOOP_MS);
  }
}

main();
