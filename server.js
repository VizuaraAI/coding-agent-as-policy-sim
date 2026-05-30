import http from "node:http";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const threeDir = path.join(__dirname, "node_modules", "three");

// Calibration "skill" files: one JSON per camera view. These are the durable
// result of the calibrate stage. They survive world resets, goal changes, and
// camera switches; only an explicit "forget calibration" clears them.
const calibrationDir = path.join(__dirname, "calibration");

const port = Number(process.env.PORT || 8088);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const VALID_CAMERAS = ["top_down", "chase", "front"];
const VALID_STAGES = ["calibrate", "execute"];
const MAX_LOG_ENTRIES = 200;

function freshState() {
  return {
    instruction: "",
    stage: "calibrate",
    activeCamera: "top_down",
    cameraSwitchSeq: 0,
    motorQueue: [],
    motorSeq: 0,
    pose: { x: -2.5, y: -1.5, theta: 0 },
    goal: { x: 2.5, y: 1.5 },
    obstacles: [
      { x: 0, y: 0, w: 0.8, h: 0.4 },
      { x: -0.6, y: 1.2, w: 0.4, h: 0.8 },
      { x: 1.0, y: -0.8, w: 0.6, h: 0.3 }
    ],
    cameraFrames: { top_down: null, chase: null, front: null },
    log: [],
    resetSeq: 0,
    goalSeq: 0,
    carSpawn: null,   // { x, y, theta } the renderer should teleport the car to
    carSpawnSeq: 0,
    obstaclesSeq: 0
  };
}

// Arena half-extents must match the renderer (public/app.js ARENA).
const ARENA = { halfX: 4, halfY: 3 };

// Pick a random goal position inside the arena that does not overlap an
// obstacle and is not right on top of the car. Coordinates use the same frame
// the renderer reports pose in: server `y` maps to the renderer's `z`.
function randomGoal() {
  const margin = 0.5;
  const minX = -ARENA.halfX + margin;
  const maxX = ARENA.halfX - margin;
  const minY = -ARENA.halfY + margin;
  const maxY = ARENA.halfY - margin;
  const clearOfObstacles = (x, y) =>
    state.obstacles.every((o) => Math.abs(x - o.x) > o.w / 2 + 0.4 || Math.abs(y - o.y) > o.h / 2 + 0.4);
  const clearOfCar = (x, y) => Math.hypot(x - state.pose.x, y - state.pose.y) > 1.2;

  for (let attempt = 0; attempt < 200; attempt++) {
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    if (clearOfObstacles(x, y) && clearOfCar(x, y)) {
      return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
    }
  }
  // Fallback: a fixed corner if the rejection sampler somehow fails.
  return { x: 2.5, y: 1.5 };
}

// Pick a random car pose (position + heading) inside the arena that clears the
// obstacles and is not sitting on the goal. theta is a random heading in
// radians. Uses the same clamp the renderer applies to the car.
function randomCarPose() {
  const minX = -ARENA.halfX + 0.3;
  const maxX = ARENA.halfX - 0.3;
  const minY = -ARENA.halfY + 0.3;
  const maxY = ARENA.halfY - 0.3;
  const clearOfObstacles = (x, y) =>
    state.obstacles.every((o) => Math.abs(x - o.x) > o.w / 2 + 0.45 || Math.abs(y - o.y) > o.h / 2 + 0.45);
  const clearOfGoal = (x, y) => Math.hypot(x - state.goal.x, y - state.goal.y) > 1.2;

  for (let attempt = 0; attempt < 200; attempt++) {
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    if (clearOfObstacles(x, y) && clearOfGoal(x, y)) {
      return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), theta: Number((Math.random() * 2 * Math.PI - Math.PI).toFixed(3)) };
    }
  }
  return { x: -2.5, y: -1.5, theta: 0 };
}

// Generate a fresh set of box obstacles with random positions and sizes that
// clear the car's current pose, the goal, and each other. Obstacle frame matches
// freshState: { x, y, w, h } where y maps to the renderer z, w is the x-extent,
// h is the z-extent.
function randomObstacles() {
  const minX = -ARENA.halfX + 0.8;
  const maxX = ARENA.halfX - 0.8;
  const minY = -ARENA.halfY + 0.8;
  const maxY = ARENA.halfY - 0.8;
  const count = 2 + Math.floor(Math.random() * 3); // 2 to 4 obstacles
  const placed = [];
  const clearOfCar = (x, y) => Math.hypot(x - state.pose.x, y - state.pose.y) > 1.0;
  const clearOfGoal = (x, y) => Math.hypot(x - state.goal.x, y - state.goal.y) > 1.0;
  const clearOfOthers = (x, y) => placed.every((o) => Math.hypot(x - o.x, y - o.y) > 1.0);

  let guard = 0;
  while (placed.length < count && guard++ < 400) {
    const x = minX + Math.random() * (maxX - minX);
    const y = minY + Math.random() * (maxY - minY);
    if (clearOfCar(x, y) && clearOfGoal(x, y) && clearOfOthers(x, y)) {
      placed.push({
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        w: Number((0.4 + Math.random() * 0.5).toFixed(2)),
        h: Number((0.3 + Math.random() * 0.6).toFixed(2))
      });
    }
  }
  return placed;
}

let state = freshState();

// ============================================================
// Calibration store: durable per-camera skill files on disk.
// Kept OUTSIDE `state` so world reset / goal change / camera switch
// never wipe it. Only POST /api/calibration/clear removes it.
// ============================================================

let calibration = { top_down: null, chase: null, front: null };
let calibrationSeq = 0;

// Agent presence heartbeat. Every agent-only HTTP call updates this, so the UI
// can distinguish "agent connected and thinking" from "no agent running" even
// during the agent's silent reasoning gaps. The browser viewer never hits these
// endpoints, so they attribute cleanly to the coding agent.
let agentLastSeenTs = 0;
let agentLastWorkTs = 0;
let lastCameraLogTs = 0;
// Heartbeat: any agent HTTP call, including idle instruction polls.
function markAgent() { agentLastSeenTs = Date.now(); }
// Real work: the agent read a frame, sent a motor command, logged, or saved a
// calibration. Lets the UI tell "actively working" from "connected but idle".
function markWork() { agentLastWorkTs = Date.now(); agentLastSeenTs = agentLastWorkTs; }

function loadCalibrationFromDisk() {
  const loaded = { top_down: null, chase: null, front: null };
  try {
    if (!existsSync(calibrationDir)) return loaded;
    for (const file of readdirSync(calibrationDir)) {
      if (!file.endsWith(".json")) continue;
      const camera = file.replace(/\.json$/, "");
      if (!VALID_CAMERAS.includes(camera)) continue;
      try {
        loaded[camera] = JSON.parse(readFileSync(path.join(calibrationDir, file), "utf8"));
      } catch { /* skip a corrupt file */ }
    }
  } catch { /* no dir yet */ }
  return loaded;
}

function calibratedCameras() {
  return VALID_CAMERAS.filter((c) => calibration[c] != null);
}

calibration = loadCalibrationFromDisk();

function appendLog(source, message) {
  state.log.push({
    ts: Date.now(),
    source,
    message: String(message).slice(0, 500)
  });
  if (state.log.length > MAX_LOG_ENTRIES) {
    state.log = state.log.slice(-MAX_LOG_ENTRIES);
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const root = requested.startsWith("/vendor/three/") ? threeDir : publicDir;
  const relativePath = requested.startsWith("/vendor/three/")
    ? requested.replace("/vendor/three/", "/")
    : requested;
  const resolved = path.normalize(path.join(root, relativePath));

  if (!resolved.startsWith(root) || !existsSync(resolved)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(resolved);
  const file = await readFile(resolved);
  res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
  res.end(file);
}

function handleCors(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    res.end();
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    if (handleCors(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ===== Public API: teacher + Claude Code =====

    if (req.method === "GET" && url.pathname === "/api/instruction") {
      markAgent();
      json(res, 200, {
        instruction: state.instruction,
        stage: state.stage,
        activeCamera: state.activeCamera,
        cameraSwitchSeq: state.cameraSwitchSeq,
        resetSeq: state.resetSeq,
        // Which cameras already have saved calibration, and whether the active
        // one is covered. The agent uses this to skip recalibration.
        calibratedCameras: calibratedCameras(),
        activeCameraCalibrated: calibration[state.activeCamera] != null,
        calibrationSeq
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/instruction") {
      const body = await readBody(req);
      if (typeof body.instruction === "string") state.instruction = body.instruction.slice(0, 500);
      if (VALID_STAGES.includes(body.stage)) state.stage = body.stage;
      appendLog("teacher", `Sent: [${state.stage}] ${state.instruction}`);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stage") {
      const body = await readBody(req);
      if (!VALID_STAGES.includes(body.stage)) {
        json(res, 400, { error: "stage must be 'calibrate' or 'execute'" });
        return;
      }
      state.stage = body.stage;
      appendLog("teacher", `Stage set to ${state.stage}`);
      json(res, 200, { stage: state.stage });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/camera") {
      const body = await readBody(req);
      if (!VALID_CAMERAS.includes(body.camera)) {
        json(res, 400, { error: "camera must be 'top_down', 'chase', or 'front'" });
        return;
      }
      if (state.activeCamera !== body.camera) {
        state.activeCamera = body.camera;
        state.cameraSwitchSeq += 1;
        const known = calibration[state.activeCamera] != null;
        appendLog("teacher", known
          ? `Switched camera to ${state.activeCamera}. Saved calibration for this view is available; reuse it.`
          : `Switched camera to ${state.activeCamera}. No calibration saved for this view yet; calibrate before executing.`);
      }
      json(res, 200, { activeCamera: state.activeCamera, cameraSwitchSeq: state.cameraSwitchSeq });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/camera") {
      const which = url.searchParams.get("view") || state.activeCamera;
      if (!VALID_CAMERAS.includes(which)) {
        json(res, 400, { error: "unknown camera view" });
        return;
      }
      // Only the coding agent reads the camera, so narrate it (throttled so a
      // tight read loop does not flood the log).
      markWork();
      const nowTs = Date.now();
      if (nowTs - lastCameraLogTs > 1200) {
        lastCameraLogTs = nowTs;
        appendLog("agent", `Looking at the ${which.replace("_", "-")} camera frame.`);
      }
      const frame = state.cameraFrames[which];
      if (!frame) {
        res.writeHead(503, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end("No frame yet. Open the browser viewer to start streaming.");
        return;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      });
      res.end(frame);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/motor") {
      markWork();
      const body = await readBody(req);
      const cmd = {
        seq: ++state.motorSeq,
        vx: Number(body.vx ?? 0),
        vy: Number(body.vy ?? 0),
        omega: Number(body.omega ?? 0),
        duration: Math.max(0.05, Math.min(3, Number(body.duration ?? 0.5)))
      };
      if (!Number.isFinite(cmd.vx) || !Number.isFinite(cmd.vy) || !Number.isFinite(cmd.omega)) {
        json(res, 400, { error: "vx, vy, omega must be numbers" });
        return;
      }
      state.motorQueue.push(cmd);
      appendLog("agent", `motor(vx=${cmd.vx.toFixed(2)}, vy=${cmd.vy.toFixed(2)}, omega=${cmd.omega.toFixed(2)}, dur=${cmd.duration.toFixed(2)})`);
      json(res, 200, { ok: true, seq: cmd.seq });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, {
        instruction: state.instruction,
        stage: state.stage,
        activeCamera: state.activeCamera,
        cameraSwitchSeq: state.cameraSwitchSeq,
        pose: state.pose,
        goal: state.goal,
        goalSeq: state.goalSeq,
        obstacles: state.obstacles,
        resetSeq: state.resetSeq
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      // Reset only repositions the car to the start pose. Goal, obstacles, and
      // saved calibration are deliberately left untouched (calibration lives
      // outside `state`, so it already survives this).
      state.carSpawn = { x: -2.5, y: -1.5, theta: 0 };
      state.carSpawnSeq += 1;
      state.motorQueue = [];
      appendLog("teacher", "Car reset to the start position. Goal, obstacles, and calibration are unchanged.");
      json(res, 200, { ok: true, carSpawn: state.carSpawn, carSpawnSeq: state.carSpawnSeq });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/goal") {
      const body = await readBody(req);
      // Explicit {x, y} places the goal there; otherwise pick a random spot.
      if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
        const x = Math.max(-ARENA.halfX + 0.3, Math.min(ARENA.halfX - 0.3, body.x));
        const y = Math.max(-ARENA.halfY + 0.3, Math.min(ARENA.halfY - 0.3, body.y));
        state.goal = { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
      } else {
        state.goal = randomGoal();
      }
      state.goalSeq += 1;
      appendLog("teacher", `Goal moved to (${state.goal.x}, ${state.goal.y}). Drive there from the current position.`);
      json(res, 200, { goal: state.goal, goalSeq: state.goalSeq });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/car") {
      const body = await readBody(req);
      // Explicit {x, y, theta} places the car there; otherwise pick a random pose.
      if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
        const x = Math.max(-ARENA.halfX + 0.3, Math.min(ARENA.halfX - 0.3, body.x));
        const y = Math.max(-ARENA.halfY + 0.3, Math.min(ARENA.halfY - 0.3, body.y));
        const theta = Number.isFinite(body.theta) ? body.theta : 0;
        state.carSpawn = { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), theta: Number(theta.toFixed(3)) };
      } else {
        state.carSpawn = randomCarPose();
      }
      state.carSpawnSeq += 1;
      const deg = Math.round(state.carSpawn.theta * 180 / Math.PI);
      appendLog("teacher", `Car respawned at (${state.carSpawn.x}, ${state.carSpawn.y}), heading ${deg} deg. Calibration still applies; drive to the goal from here.`);
      json(res, 200, { carSpawn: state.carSpawn, carSpawnSeq: state.carSpawnSeq });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/obstacles") {
      const body = await readBody(req);
      // An explicit array places those obstacles; otherwise pick a random set.
      if (Array.isArray(body.obstacles)) {
        state.obstacles = body.obstacles
          .filter((o) => Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.w) && Number.isFinite(o.h))
          .map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
      } else {
        state.obstacles = randomObstacles();
      }
      state.obstaclesSeq += 1;
      appendLog("teacher", `Obstacles rearranged: ${state.obstacles.length} now in the arena.`);
      json(res, 200, { obstacles: state.obstacles, obstaclesSeq: state.obstaclesSeq });
      return;
    }

    // ===== Calibration "skill" files =====

    if (req.method === "GET" && url.pathname === "/api/calibration") {
      markWork();
      const camera = url.searchParams.get("camera");
      if (camera && VALID_CAMERAS.includes(camera) && calibration[camera] != null) {
        appendLog("agent", `Loaded saved calibration for the ${camera.replace("_", "-")} camera.`);
      }
      if (camera) {
        if (!VALID_CAMERAS.includes(camera)) { json(res, 400, { error: "unknown camera" }); return; }
        json(res, 200, { camera, calibration: calibration[camera], calibrated: calibration[camera] != null });
        return;
      }
      json(res, 200, { calibration, calibrated: calibratedCameras(), calibrationSeq });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/calibration") {
      markWork();
      const body = await readBody(req);
      const camera = body.camera;
      if (!VALID_CAMERAS.includes(camera)) { json(res, 400, { error: "camera must be 'top_down', 'chase', or 'front'" }); return; }
      // The agent's learned mapping for this camera. Free-form, but we stamp it.
      const record = { ...(body.calibration ?? body.data ?? {}), camera, savedAt: Date.now() };
      calibration[camera] = record;
      calibrationSeq += 1;
      try {
        await mkdir(calibrationDir, { recursive: true });
        await writeFile(path.join(calibrationDir, `${camera}.json`), JSON.stringify(record, null, 2));
      } catch (e) {
        json(res, 500, { error: `could not write calibration file: ${e.message}` });
        return;
      }
      appendLog("agent", `Calibration saved for ${camera} camera. It will be reused until you forget calibration.`);
      json(res, 200, { ok: true, camera, calibrated: calibratedCameras() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/calibration/clear") {
      calibration = { top_down: null, chase: null, front: null };
      calibrationSeq += 1;
      try {
        if (existsSync(calibrationDir)) await rm(calibrationDir, { recursive: true, force: true });
      } catch { /* best effort */ }
      appendLog("teacher", "Calibration cleared. The agent must calibrate from scratch.");
      json(res, 200, { ok: true, calibrated: [] });
      return;
    }

    // List the calibration skill files the agent has written. This is the
    // agent's visible "working directory" that the browser file viewer shows,
    // so the teacher can watch the skill files appear as calibration happens.
    if (req.method === "GET" && url.pathname === "/api/calibration/files") {
      const files = [];
      try {
        if (existsSync(calibrationDir)) {
          for (const name of readdirSync(calibrationDir)) {
            if (!name.endsWith(".json")) continue;
            const camera = name.replace(/\.json$/, "");
            if (!VALID_CAMERAS.includes(camera)) continue;
            try {
              const raw = readFileSync(path.join(calibrationDir, name), "utf8");
              files.push({ name, camera, size: Buffer.byteLength(raw) });
            } catch { /* skip an unreadable file */ }
          }
        }
      } catch { /* no dir yet */ }
      files.sort((a, b) => a.name.localeCompare(b.name));
      json(res, 200, { dir: "calibration/", files, calibrationSeq });
      return;
    }

    // Return the raw contents of one calibration skill file so the teacher can
    // open it in the browser. Only the known per-camera file names are allowed;
    // never join an arbitrary path (no traversal).
    if (req.method === "GET" && url.pathname === "/api/calibration/file") {
      const name = url.searchParams.get("name") || "";
      const camera = name.replace(/\.json$/, "");
      if (!VALID_CAMERAS.includes(camera) || name !== `${camera}.json`) {
        json(res, 400, { error: "unknown calibration file" });
        return;
      }
      const full = path.join(calibrationDir, name);
      if (!existsSync(full)) { json(res, 404, { error: "no such file" }); return; }
      try {
        json(res, 200, { name, content: readFileSync(full, "utf8") });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/log") {
      const body = await readBody(req);
      const src = body.source === "teacher" ? "teacher" : "agent";
      if (src === "agent") markWork();
      appendLog(src, body.message || "");
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/log") {
      const sinceTs = Number(url.searchParams.get("since") || 0);
      const entries = state.log.filter((entry) => entry.ts > sinceTs);
      json(res, 200, { entries });
      return;
    }

    // ===== Internal API: browser viewer pushes frames + pose, pulls motors =====

    if (req.method === "POST" && url.pathname === "/api/internal/frame") {
      const view = url.searchParams.get("view");
      if (!VALID_CAMERAS.includes(view)) {
        json(res, 400, { error: "view must be 'top_down', 'chase', or 'front'" });
        return;
      }
      state.cameraFrames[view] = await readRawBody(req);
      res.writeHead(204, { "access-control-allow-origin": "*" });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/internal/pose") {
      const body = await readBody(req);
      if (Number.isFinite(body.x) && Number.isFinite(body.y) && Number.isFinite(body.theta)) {
        state.pose = { x: body.x, y: body.y, theta: body.theta };
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/internal/motor-queue") {
      const drained = state.motorQueue;
      state.motorQueue = [];
      json(res, 200, { commands: drained, activeCamera: state.activeCamera, cameraSwitchSeq: state.cameraSwitchSeq, resetSeq: state.resetSeq, goal: state.goal, goalSeq: state.goalSeq, carSpawn: state.carSpawn, carSpawnSeq: state.carSpawnSeq, obstacles: state.obstacles, obstaclesSeq: state.obstaclesSeq, calibratedCameras: calibratedCameras(), calibrationSeq, agentSeenAgoMs: agentLastSeenTs ? (Date.now() - agentLastSeenTs) : null, agentWorkAgoMs: agentLastWorkTs ? (Date.now() - agentLastWorkTs) : null });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  process.stdout.write(`Coding-agent-as-policy sim listening on http://127.0.0.1:${port}\n`);
});
