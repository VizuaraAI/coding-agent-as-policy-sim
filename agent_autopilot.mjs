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
const LOOP_MS = 350;

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
let escapeDir = 0;         // remembered strafe direction while escaping a jam
let aroundSign = 0;        // locked go-around side, so it commits instead of oscillating

// Geometry: the car's collision radius (matches the sim) and how much clear
// space we insist on keeping around every box.
const CAR_R = 0.22;
const STANDOFF = 0.60;     // keep the car's CENTER at least this far from a box edge
const INFLUENCE = 1.50;    // start steering away once a box edge is within this
const HARD = 0.45;         // below this clearance, strafe out instead of pushing in

// Clearance from a point to the nearest edge of an axis-aligned box, plus the
// outward unit direction (from the box, pointing toward the car). Using the box
// EDGE (not the center) is what makes corners and long boxes safe.
function boxClearance(px, py, o) {
  const ex = Math.max(Math.abs(px - o.x) - o.w / 2, 0);
  const ey = Math.max(Math.abs(py - o.y) - o.h / 2, 0);
  const dist = Math.hypot(ex, ey);             // 0 if the point is over the box
  let nx = px - o.x, ny = py - o.y;            // outward direction (from center)
  const nl = Math.hypot(nx, ny) || 1;
  return { dist, nx: nx / nl, ny: ny / nl };
}

async function driveStep() {
  const s = await get("/api/state");

  // If the car has not moved across recent commands it is either jammed against
  // a box or the browser physics is paused (tab backgrounded). Warn once, then
  // strafe sideways to slide off the obstacle rather than keep pushing into it.
  const key = `${s.pose.x.toFixed(3)},${s.pose.y.toFixed(3)},${s.pose.theta.toFixed(3)}`;
  if (key === lastPoseKey) {
    if (++stuckCount >= 3) {
      if (!stuckWarned) {
        await log("Car not moving: nudging sideways to clear a box (and check the sim tab is focused, it runs the physics).");
        stuckWarned = true;
      }
      if (escapeDir === 0) escapeDir = Math.random() < 0.5 ? 1 : -1;
      await motor(0, escapeDir * 0.8, escapeDir * 0.6, 0.4); // strafe + turn out
      return;
    }
  } else {
    stuckCount = 0;
    stuckWarned = false;
    escapeDir = 0;
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

  // Potential field: unit attraction to the goal + strong, short-range repulsion
  // from the nearest EDGE of every box, so the car routes around the boxes.
  const gx = dx / dist, gy = dy / dist;        // unit goal direction

  // Find the nearest box, and LOCK a single go-around side for as long as any
  // box is in range. Committing to one side is what stops the car oscillating
  // left-right in front of an obstacle that sits between it and the goal.
  let nearest = Infinity, nb = null;
  for (const o of (s.obstacles || [])) {
    const c = boxClearance(s.pose.x, s.pose.y, o);
    if (c.dist < nearest) { nearest = c.dist; nb = c; }
  }
  if (nearest > INFLUENCE) {
    aroundSign = 0;                            // clear of all boxes: release the lock
  } else if (aroundSign === 0 && nb) {
    const tx = -nb.ny, ty = nb.nx;             // pick the side that heads toward the goal
    aroundSign = (tx * gx + ty * gy) >= 0 ? 1 : -1;
  }

  let ax = gx, ay = gy;                         // attraction toward the goal
  for (const o of (s.obstacles || [])) {
    const c = boxClearance(s.pose.x, s.pose.y, o);
    if (c.dist < INFLUENCE) {
      const ramp = (INFLUENCE - c.dist) / INFLUENCE;     // 0 far .. 1 at the edge
      // Radial: push away from the nearest edge to hold the standoff.
      const radial = 1.0 * ramp + (c.dist < STANDOFF ? 1.8 : 0);
      ax += c.nx * radial; ay += c.ny * radial;
      // Tangential: circulate AROUND the box using the LOCKED side, so the car
      // sweeps consistently around it instead of flip-flopping at the centerline.
      const tx = -c.ny, ty = c.nx;             // perpendicular to the outward normal
      const tang = 2.4 * ramp;
      ax += aroundSign * tx * tang; ay += aroundSign * ty * tang;
    }
  }
  const worldDir = Math.atan2(ay, ax);
  const targetTheta = -worldDir;               // car world heading is -theta
  const err = norm(targetTheta - s.pose.theta);

  // One combined command per step so the car arcs continuously instead of
  // stopping to turn: drive forward scaled by how much it already faces the safe
  // direction, crawl when a box is near, and strafe out if it is right on an
  // edge. This keeps it moving while holding the standoff.
  const clearScale = clamp((nearest - CAR_R) / STANDOFF, 0.15, 1);
  let forward = clamp(1.2 * dist, 0, 1.1) * clearScale * Math.max(0, Math.cos(err));
  const omega = clamp(1.6 * err, -1.6, 1.6);
  const vy = nearest < HARD ? (err >= 0 ? 1 : -1) * 0.6 * (HARD - nearest) / HARD : 0;

  // Hard safety: never step TOWARD a box past the standoff. If the car's forward
  // direction is closing on the nearest box, cap forward so this step cannot take
  // the clearance below ~0.32. Turning and strafing are still allowed, so the car
  // keeps making progress around the box but physically cannot drive into it.
  if (nb && nearest < 0.9) {
    const closing = -Math.cos(s.pose.theta) * nb.nx + Math.sin(s.pose.theta) * nb.ny;
    if (closing > 0.05) {
      const cap = Math.max(0, (nearest - 0.45) / (0.35 * closing)); // ~1 unit/s scale, 0.35s step
      forward = Math.min(forward, cap);
    }
  }
  await motor(forward, vy, omega, 0.3);
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
