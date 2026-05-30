import * as THREE from "three";

// ============================================================
// Hidden physics: per-camera linear/angular scale factors and a
// small directional bias the agent must discover by experiment.
// ============================================================

const HIDDEN_CALIBRATION = {
  top_down: { linScale: 1.0,  angScale: 1.0,  driftDeg: 0,   gainX: 1.0, gainY: 1.0 },
  chase:    { linScale: 0.72, angScale: 0.85, driftDeg: 4,   gainX: 0.95, gainY: 1.08 },
  front:    { linScale: 1.35, angScale: 0.65, driftDeg: -6,  gainX: 1.0,  gainY: 0.88 }
};

const ARENA = { halfX: 4, halfY: 3 };
const CAR_SIZE = { length: 0.5, width: 0.35, height: 0.18 };

// ============================================================
// Scene setup
// ============================================================

const sceneCanvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a);
scene.fog = new THREE.Fog(0x0f172a, 12, 22);

// ----- Lighting -----
const hemi = new THREE.HemisphereLight(0xfdf6e3, 0x1e293b, 0.55);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfffaf2, 1.1);
sun.position.set(6, 10, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -8;
sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8;
sun.shadow.camera.bottom = -8;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 30;
scene.add(sun);

// ----- Arena floor -----
const floorMat = new THREE.MeshStandardMaterial({ color: 0xe6e1d2, roughness: 0.92, metalness: 0 });
const floor = new THREE.Mesh(new THREE.BoxGeometry(ARENA.halfX * 2, 0.05, ARENA.halfY * 2), floorMat);
floor.position.y = -0.025;
floor.receiveShadow = true;
scene.add(floor);

// Floor grid (subtle)
const grid = new THREE.GridHelper(Math.max(ARENA.halfX, ARENA.halfY) * 2, 16, 0xb6ad95, 0xcfc8b5);
grid.position.y = 0.002;
grid.material.opacity = 0.5;
grid.material.transparent = true;
scene.add(grid);

// Arena border walls (low)
const wallMat = new THREE.MeshStandardMaterial({ color: 0xc7bda4, roughness: 0.85 });
function addWall(w, d, x, z) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, d), wallMat);
  wall.position.set(x, 0.075, z);
  wall.castShadow = true;
  wall.receiveShadow = true;
  scene.add(wall);
}
addWall(ARENA.halfX * 2 + 0.1, 0.05, 0,  ARENA.halfY);
addWall(ARENA.halfX * 2 + 0.1, 0.05, 0, -ARENA.halfY);
addWall(0.05, ARENA.halfY * 2 + 0.1,  ARENA.halfX, 0);
addWall(0.05, ARENA.halfY * 2 + 0.1, -ARENA.halfX, 0);

// ----- Obstacles -----
const obstacleMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.85 });
const DEFAULT_OBSTACLE_DESCS = [
  { x: 0,    z: 0,    w: 0.8, h: 0.4 },
  { x: -0.6, z: 1.2,  w: 0.4, h: 0.8 },
  { x: 1.0,  z: -0.8, w: 0.6, h: 0.3 }
];
let obstacleMeshes = [];
let obstacleBoxes = [];   // { x, z, w, h } used for car collision

// Rebuild all obstacle meshes from a list of { x, z, w, h } descriptors.
// Disposes the previous meshes so randomizing does not leak geometry.
function rebuildObstacles(descs) {
  for (const m of obstacleMeshes) {
    scene.remove(m);
    m.geometry.dispose();
  }
  obstacleBoxes = descs.map((o) => ({ x: o.x, z: o.z, w: o.w, h: o.h }));
  obstacleMeshes = descs.map((o) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.35, o.h), obstacleMat);
    m.position.set(o.x, 0.175, o.z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  });
}

// True if a car centered at (x, z) would overlap any obstacle, treating the car
// as a small disc so it stops at the box edge instead of driving through.
const CAR_COLLISION_RADIUS = 0.22;
function hitsObstacle(x, z) {
  return obstacleBoxes.some((o) =>
    Math.abs(x - o.x) < o.w / 2 + CAR_COLLISION_RADIUS &&
    Math.abs(z - o.z) < o.h / 2 + CAR_COLLISION_RADIUS);
}

rebuildObstacles(DEFAULT_OBSTACLE_DESCS);

// ----- Goal marker -----
const goal = { x: 2.5, z: 1.5 };
const goalGroup = new THREE.Group();
const goalDisk = new THREE.Mesh(
  new THREE.CylinderGeometry(0.28, 0.28, 0.02, 32),
  new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x166534, emissiveIntensity: 0.35, roughness: 0.5 })
);
goalDisk.position.y = 0.012;
goalDisk.receiveShadow = true;
goalGroup.add(goalDisk);
const goalRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.34, 0.018, 12, 48),
  new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x14532d, emissiveIntensity: 0.3 })
);
goalRing.rotation.x = -Math.PI / 2;
goalRing.position.y = 0.025;
goalGroup.add(goalRing);
goalGroup.position.set(goal.x, 0, goal.z);
scene.add(goalGroup);

// ----- TurboPi car -----
const car = new THREE.Group();
const body = new THREE.Mesh(
  new THREE.BoxGeometry(CAR_SIZE.length, CAR_SIZE.height, CAR_SIZE.width),
  new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.55, metalness: 0.15 })
);
body.position.y = 0.13;
body.castShadow = true;
car.add(body);

const roof = new THREE.Mesh(
  new THREE.BoxGeometry(CAR_SIZE.length * 0.62, 0.06, CAR_SIZE.width * 0.85),
  new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.5 })
);
roof.position.set(-0.02, 0.235, 0);
roof.castShadow = true;
car.add(roof);

// Heading marker (small triangle on top of roof, pointing +x in local frame)
const headingShape = new THREE.Shape();
headingShape.moveTo(0.08, 0);
headingShape.lineTo(-0.06, 0.06);
headingShape.lineTo(-0.06, -0.06);
headingShape.lineTo(0.08, 0);
const headingMesh = new THREE.Mesh(
  new THREE.ShapeGeometry(headingShape),
  new THREE.MeshBasicMaterial({ color: 0xfffaf2 })
);
headingMesh.rotation.x = -Math.PI / 2;
headingMesh.position.set(0.06, 0.27, 0);
car.add(headingMesh);

// Four mecanum wheels (visual only)
const wheelGeom = new THREE.CylinderGeometry(0.07, 0.07, 0.05, 16);
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.65 });
[ [ 0.18,  0.20], [ 0.18, -0.20], [-0.18, 0.20], [-0.18, -0.20] ].forEach(([wx, wz]) => {
  const w = new THREE.Mesh(wheelGeom, wheelMat);
  w.position.set(wx, 0.07, wz);
  w.rotation.x = Math.PI / 2;
  w.castShadow = true;
  car.add(w);
});

car.position.set(-2.5, 0, -1.5);
car.rotation.y = 0;
scene.add(car);

// ============================================================
// Cameras: one main world camera, plus three "rover" cameras
// (top_down, chase, front) that capture into a render target.
// ============================================================

// Main camera = a comfortable scene-overview camera the teacher always sees.
const mainCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
mainCamera.position.set(-4.5, 6.5, 6.5);
mainCamera.lookAt(0, 0, 0);

// Rover cameras (used to render the agent's view into an offscreen target)
const cameras = {
  top_down: new THREE.OrthographicCamera(-ARENA.halfX, ARENA.halfX, ARENA.halfY, -ARENA.halfY, 0.1, 30),
  chase:    new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 30),
  front:    new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 30)
};

cameras.top_down.position.set(0, 12, 0);
cameras.top_down.up.set(0, 0, -1);
cameras.top_down.lookAt(0, 0, 0);

function syncFollowCameras() {
  // Chase camera: behind and above the car.
  const heading = car.rotation.y;
  const offset = new THREE.Vector3(-Math.cos(heading) * 1.2, 0.9, Math.sin(heading) * 1.2);
  cameras.chase.position.copy(car.position).add(offset);
  cameras.chase.lookAt(car.position.x + Math.cos(heading) * 1.5, 0.1, car.position.z - Math.sin(heading) * 1.5);

  // Front camera: at the front bumper, looking forward.
  const fwd = new THREE.Vector3(Math.cos(heading) * (CAR_SIZE.length / 2 + 0.02), 0.18, -Math.sin(heading) * (CAR_SIZE.length / 2 + 0.02));
  cameras.front.position.copy(car.position).add(fwd);
  cameras.front.lookAt(car.position.x + Math.cos(heading) * 3, 0.12, car.position.z - Math.sin(heading) * 3);
}

// Offscreen render target for the agent's view (matches the small overlay canvas + the PNG returned to Claude Code)
const AGENT_VIEW_SIZE = { w: 640, h: 360 };
const agentRT = new THREE.WebGLRenderTarget(AGENT_VIEW_SIZE.w, AGENT_VIEW_SIZE.h);
const agentCanvas = document.getElementById("agentCamera");
const agentCtx = agentCanvas.getContext("2d");
agentCanvas.width = AGENT_VIEW_SIZE.w;
agentCanvas.height = AGENT_VIEW_SIZE.h;

// ============================================================
// Resize handling
// ============================================================

function resize() {
  const w = sceneCanvas.clientWidth;
  const h = sceneCanvas.clientHeight;
  renderer.setSize(w, h, false);
  mainCamera.aspect = w / h;
  mainCamera.updateProjectionMatrix();
  cameras.chase.aspect = AGENT_VIEW_SIZE.w / AGENT_VIEW_SIZE.h;
  cameras.chase.updateProjectionMatrix();
  cameras.front.aspect = AGENT_VIEW_SIZE.w / AGENT_VIEW_SIZE.h;
  cameras.front.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(sceneCanvas);

// ============================================================
// Motor execution: drains queued commands and applies physics
// over several frames (so the motion is visible).
// ============================================================

const state = {
  activeCamera: "top_down",
  cameraSwitchSeq: 0,
  resetSeq: 0,
  goalSeq: 0,
  carSpawnSeq: 0,
  obstaclesSeq: 0,
  calibrationSeq: -1,  // last seen calibration version (drives the file viewer)
  pending: [],     // queue of { vx, vy, omega, duration, elapsed }
  current: null,
  lastLogTs: 0,
  lastPosePostMs: 0,
  lastFramePostMs: 0,
  stage: "calibrate",        // teacher-selected stage (browser is authoritative)
  lastAgentActivityMs: -1e9, // perf-clock time of the last agent log/motor
  awaitingPickup: false,     // instruction sent, agent has not acted yet
  lastSentMs: 0,
  agentSeenAgoMs: null       // ms since the agent last hit any API (null = never)
};

function stepPhysics(dt) {
  if (!state.current && state.pending.length > 0) {
    state.current = { ...state.pending.shift(), elapsed: 0 };
  }
  if (!state.current) return;

  const cmd = state.current;
  const cal = HIDDEN_CALIBRATION[state.activeCamera];

  // Body-frame velocities -> world-frame, with hidden per-camera scale.
  const heading = car.rotation.y;
  const vxBody = cmd.vx * cal.linScale * cal.gainX;
  const vyBody = cmd.vy * cal.linScale * cal.gainY;
  const omega = cmd.omega * cal.angScale;
  const driftRad = (cal.driftDeg * Math.PI / 180) * Math.abs(cmd.vx);

  // Rotate body-frame velocity into world frame.
  const cos = Math.cos(heading + driftRad);
  const sin = Math.sin(heading + driftRad);
  const dx = (vxBody * cos - vyBody * sin) * dt;
  const dz = -(vxBody * sin + vyBody * cos) * dt;

  // Move one axis at a time and block the step if it would enter an obstacle,
  // so the car stops at the box edge (and can slide along it) instead of
  // driving through.
  const nextX = car.position.x + dx;
  if (!hitsObstacle(nextX, car.position.z)) car.position.x = nextX;
  const nextZ = car.position.z + dz;
  if (!hitsObstacle(car.position.x, nextZ)) car.position.z = nextZ;
  car.rotation.y += omega * dt;

  // Clamp to arena bounds.
  car.position.x = Math.max(-ARENA.halfX + 0.3, Math.min(ARENA.halfX - 0.3, car.position.x));
  car.position.z = Math.max(-ARENA.halfY + 0.3, Math.min(ARENA.halfY - 0.3, car.position.z));

  cmd.elapsed += dt;
  if (cmd.elapsed >= cmd.duration) {
    state.current = null;
  }
}

// ============================================================
// Server bridge: pull queued motor commands, push pose + frames
// ============================================================

async function pollMotorQueue() {
  try {
    const res = await fetch("/api/internal/motor-queue");
    if (!res.ok) return;
    const body = await res.json();
    if (body.resetSeq && body.resetSeq !== state.resetSeq) {
      state.resetSeq = body.resetSeq;
      resetWorld();
    }
    if (body.cameraSwitchSeq !== state.cameraSwitchSeq) {
      state.cameraSwitchSeq = body.cameraSwitchSeq;
      state.activeCamera = body.activeCamera;
      reflectCameraButtons();
      document.getElementById("activeCameraLabel").textContent = body.activeCamera.replace("_", "-");
    }
    if (body.calibratedCameras) updateCalibPills(body.calibratedCameras);
    if (typeof body.calibrationSeq === "number" && body.calibrationSeq !== state.calibrationSeq) {
      state.calibrationSeq = body.calibrationSeq;
      refreshCalibFiles();
    }
    state.agentSeenAgoMs = (typeof body.agentSeenAgoMs === "number") ? body.agentSeenAgoMs : null;
    if (typeof body.obstaclesSeq === "number" && body.obstaclesSeq !== state.obstaclesSeq && Array.isArray(body.obstacles)) {
      state.obstaclesSeq = body.obstaclesSeq;
      // server obstacle.y maps to renderer z
      rebuildObstacles(body.obstacles.map((o) => ({ x: o.x, z: o.y, w: o.w, h: o.h })));
    }
    if (typeof body.carSpawnSeq === "number" && body.carSpawnSeq !== state.carSpawnSeq && body.carSpawn) {
      state.carSpawnSeq = body.carSpawnSeq;
      car.position.x = body.carSpawn.x;
      car.position.z = body.carSpawn.y;   // server y maps to renderer z
      car.rotation.y = body.carSpawn.theta;
      state.pending = [];                 // drop any in-flight motion on teleport
      state.current = null;
    }
    if (typeof body.goalSeq === "number" && body.goalSeq !== state.goalSeq && body.goal) {
      state.goalSeq = body.goalSeq;
      goal.x = body.goal.x;
      goal.z = body.goal.y;            // server y maps to renderer z
      goalGroup.position.set(goal.x, 0, goal.z);
    }
    if (Array.isArray(body.commands) && body.commands.length > 0) {
      state.pending.push(...body.commands);
      // The agent just posted motor commands: it is active and has picked up.
      state.lastAgentActivityMs = performance.now();
      state.awaitingPickup = false;
    }
  } catch (e) { /* server not up yet, ignore */ }
}

async function postPose() {
  try {
    await fetch("/api/internal/pose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: car.position.x, y: car.position.z, theta: car.rotation.y })
    });
  } catch (e) {}
}

async function postFrame(view, dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await fetch(`/api/internal/frame?view=${view}`, { method: "POST", body: blob });
  } catch (e) {}
}

// ============================================================
// Render loop
// ============================================================

const clock = new THREE.Clock();

function renderAgentView() {
  const cam = cameras[state.activeCamera];
  syncFollowCameras();
  renderer.setRenderTarget(agentRT);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);

  // Copy render target to the visible overlay canvas
  const pixels = new Uint8Array(AGENT_VIEW_SIZE.w * AGENT_VIEW_SIZE.h * 4);
  renderer.readRenderTargetPixels(agentRT, 0, 0, AGENT_VIEW_SIZE.w, AGENT_VIEW_SIZE.h, pixels);
  const imageData = new ImageData(AGENT_VIEW_SIZE.w, AGENT_VIEW_SIZE.h);
  // WebGL pixels are bottom-up. Flip while copying.
  for (let y = 0; y < AGENT_VIEW_SIZE.h; y++) {
    const srcRow = (AGENT_VIEW_SIZE.h - 1 - y) * AGENT_VIEW_SIZE.w * 4;
    const dstRow = y * AGENT_VIEW_SIZE.w * 4;
    imageData.data.set(pixels.subarray(srcRow, srcRow + AGENT_VIEW_SIZE.w * 4), dstRow);
  }
  agentCtx.putImageData(imageData, 0, 0);
}

function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  stepPhysics(dt);

  // Main viewer render
  syncFollowCameras();
  renderer.setRenderTarget(null);
  renderer.render(scene, mainCamera);

  // Agent view render (offscreen + visible overlay)
  renderAgentView();

  // Throttled server updates: pose every 100ms, frame every 250ms
  const now = performance.now();
  if (now - state.lastPosePostMs > 100) {
    postPose();
    state.lastPosePostMs = now;
  }
  if (now - state.lastFramePostMs > 250) {
    state.lastFramePostMs = now;
    postFrame(state.activeCamera, agentCanvas.toDataURL("image/png"));
  }

  requestAnimationFrame(tick);
}

// ============================================================
// UI wiring
// ============================================================

function reflectCameraButtons() {
  document.querySelectorAll(".camera-switch button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.camera === state.activeCamera);
  });
}

document.querySelectorAll(".camera-switch button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const camera = btn.dataset.camera;
    await fetch("/api/camera", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ camera }) });
  });
});

// Canonical instruction for each stage. Selecting a stage loads its prompt into
// the box automatically, so there are no separate "fill" buttons to click.
const STAGE_PROMPTS = {
  calibrate: "Calibrate the active camera. Move one axis at a time with small trial motor commands and watch the camera to measure how far one unit of vx (forward), vy (sideways slide), and omega (rotation) moves the car. Also find how close you can get to a gray obstacle before you must stop or steer around it. Save the mapping with POST /api/calibration. Then, if any of the three cameras (top-down, chase, front) still has no skill file, switch to it and calibrate it too.",
  execute: "Drive the car to the green goal and keep it there. Read the camera and the car and goal positions, then issue motor commands to reach the green goal while completely avoiding the gray obstacles. Never hit an obstacle. If I move or randomize the goal, drive to the new one. If the obstacles change, route around them. Keep doing this on your own without waiting for another instruction. Use whichever calibrated camera you prefer."
};

const STAGE_HINTS = {
  calibrate: "The agent runs trial motor commands and watches the camera to learn the <code>vx, vy, omega</code> mapping and how to avoid obstacles, then saves one skill file per camera.",
  execute: "The agent uses its saved calibration to drive to the green goal, and keeps reaching it as you move the goal, car, or obstacles."
};

function loadStagePrompt(stage) {
  const box = document.getElementById("instruction");
  if (box) box.value = STAGE_PROMPTS[stage] || "";
  const hint = document.getElementById("stageHint");
  if (hint) hint.innerHTML = STAGE_HINTS[stage] || "";
}

document.querySelectorAll(".mode-toggle button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const stage = btn.dataset.stage;
    state.stage = stage;
    document.querySelectorAll(".mode-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
    loadStagePrompt(stage);
    await fetch("/api/stage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage }) });
  });
});

// Load the default stage's prompt on first paint.
loadStagePrompt(state.stage);

document.getElementById("sendBtn").addEventListener("click", async () => {
  const instruction = document.getElementById("instruction").value.trim();
  const stage = document.querySelector(".mode-toggle button.active").dataset.stage;
  if (!instruction) return;
  state.stage = stage;
  state.awaitingPickup = true;
  state.lastSentMs = performance.now();
  await fetch("/api/instruction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction, stage })
  });
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
});

document.getElementById("randomGoalBtn").addEventListener("click", async () => {
  // Empty body asks the server to pick a random, obstacle-free position.
  await fetch("/api/goal", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});

document.getElementById("randomCarBtn").addEventListener("click", async () => {
  // Empty body asks the server to pick a random pose (position + heading).
  await fetch("/api/car", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});

document.getElementById("randomObstaclesBtn").addEventListener("click", async () => {
  // Empty body asks the server for a fresh random set of obstacles.
  await fetch("/api/obstacles", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
});

document.getElementById("forgetCalibrationBtn").addEventListener("click", async () => {
  if (!confirm("Forget all saved calibration? The agent will have to calibrate every camera from scratch.")) return;
  await fetch("/api/calibration/clear", { method: "POST" });
});

// Reflect which cameras have a saved calibration file.
function updateCalibPills(calibrated) {
  const set = new Set(Array.isArray(calibrated) ? calibrated : []);
  document.querySelectorAll(".calib-pill").forEach((pill) => {
    pill.classList.toggle("done", set.has(pill.dataset.camera));
  });
}

// ============================================================
// Agent working directory: list + open the calibration skill files
// the agent writes. Refreshed whenever calibrationSeq changes.
// ============================================================

let openCalibFile = null;

async function refreshCalibFiles() {
  try {
    const res = await fetch("/api/calibration/files");
    if (!res.ok) return;
    const body = await res.json();
    renderCalibFiles(body.files || []);
  } catch (e) { /* server not up yet */ }
}

function renderCalibFiles(files) {
  const list = document.getElementById("calibFiles");
  const view = document.getElementById("calibFileView");
  if (!list) return;
  list.innerHTML = "";
  if (!files.length) {
    const li = document.createElement("li");
    li.className = "file-empty";
    li.textContent = "No calibration files yet. Run the Calibrate stage.";
    list.appendChild(li);
    if (view) { view.hidden = true; view.textContent = ""; }
    openCalibFile = null;
    return;
  }
  const names = new Set(files.map((f) => f.name));
  for (const f of files) {
    const li = document.createElement("li");
    li.className = "file-item" + (f.name === openCalibFile ? " open" : "");
    li.innerHTML = `<span class="file-name"></span><span class="file-size"></span>`;
    li.querySelector(".file-name").textContent = f.name;
    li.querySelector(".file-size").textContent = `${f.size} B`;
    li.addEventListener("click", () => openCalibFileView(f.name));
    list.appendChild(li);
  }
  // If the file we had open is still here, refresh its contents (it may have
  // just been rewritten); otherwise close the viewer.
  if (openCalibFile && names.has(openCalibFile)) {
    openCalibFileView(openCalibFile);
  } else if (view) {
    view.hidden = true;
    view.textContent = "";
    openCalibFile = null;
  }
}

async function openCalibFileView(name) {
  try {
    const res = await fetch(`/api/calibration/file?name=${encodeURIComponent(name)}`);
    const view = document.getElementById("calibFileView");
    if (!view) return;
    if (!res.ok) { view.hidden = false; view.textContent = "Could not open this file."; return; }
    const body = await res.json();
    openCalibFile = name;
    view.hidden = false;
    view.textContent = body.content;
    document.querySelectorAll("#calibFiles .file-item").forEach((el) => {
      const fn = el.querySelector(".file-name");
      el.classList.toggle("open", fn && fn.textContent === name);
    });
  } catch (e) { /* ignore */ }
}

function resetWorld() {
  car.position.set(-2.5, 0, -1.5);
  car.rotation.y = 0;
  state.pending = [];
  state.current = null;
}

// Poll the log and render it
async function pollLog() {
  try {
    const res = await fetch(`/api/log?since=${state.lastLogTs}`);
    if (!res.ok) return;
    const body = await res.json();
    const ol = document.getElementById("log");
    for (const entry of body.entries) {
      const li = document.createElement("li");
      const t = new Date(entry.ts).toLocaleTimeString(undefined, { hour12: false });
      li.innerHTML = `<span class="ts">${t}</span><span class="src-${entry.source}">${entry.source}</span> &nbsp; ${escapeHtml(entry.message)}`;
      ol.appendChild(li);
      state.lastLogTs = Math.max(state.lastLogTs, entry.ts);
      if (entry.source === "agent") {
        // The agent wrote to the log: it is alive and working.
        state.lastAgentActivityMs = performance.now();
        state.awaitingPickup = false;
      }
    }
    ol.scrollTop = ol.scrollHeight;
  } catch (e) {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// ============================================================
// Live agent status: tells the teacher, at a glance, what is
// happening right now (waiting / working / car moving / idle).
// ============================================================

const AGENT_ACTIVE_WINDOW_MS = 3500;   // "working" if the agent acted this recently
const statusEl = document.getElementById("agentStatus");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statusSub = document.getElementById("statusSub");
const statusStage = document.getElementById("statusStage");
const motionBadge = document.getElementById("motionBadge");

function fmtCmd(c) {
  return `vx ${c.vx.toFixed(2)}, vy ${c.vy.toFixed(2)}, omega ${c.omega.toFixed(2)}`;
}

function renderStatus() {
  const now = performance.now();
  const moving = !!state.current || state.pending.length > 0;
  const working = (now - state.lastAgentActivityMs) < AGENT_ACTIVE_WINDOW_MS;
  const queued = state.pending.length + (state.current ? 1 : 0);
  // The agent is "connected" if it hit any endpoint recently (it polls ~2s).
  const agentPresent = state.agentSeenAgoMs != null && state.agentSeenAgoMs < 10000;

  let mode;        // drives the colored state
  let text;
  let sub;

  if (moving) {
    mode = "moving";
    text = "Car moving";
    sub = state.current
      ? `Executing motor(${fmtCmd(state.current)}) for ${state.current.duration.toFixed(2)}s` + (queued > 1 ? ` &middot; ${queued - 1} more queued` : "")
      : `${queued} motor command(s) queued`;
  } else if (working) {
    mode = "working";
    text = "Agent working";
    sub = "Reading the camera and thinking. Watch the log below; the car moves when a motor command arrives.";
  } else if (state.awaitingPickup) {
    const secs = Math.max(0, Math.round((now - state.lastSentMs) / 1000));
    if (agentPresent) {
      mode = "working";
      text = "Agent thinking";
      sub = `Instruction picked up ${secs}s ago. The agent is connected and reasoning; no motor command yet.`;
    } else {
      mode = "waiting";
      text = "No agent detected";
      sub = `Instruction sent ${secs}s ago, but nothing has polled the API. Start the sister Claude Code terminal with CLAUDE_AGENT_BRIEF.md.`;
    }
  } else if (agentPresent) {
    mode = "working";
    text = "Agent connected";
    sub = "The agent is polling for an instruction. Edit the instruction and click Send.";
  } else {
    mode = "idle";
    text = "Idle";
    sub = "No agent detected. Start the sister Claude Code terminal, then Send an instruction.";
  }

  statusEl.className = `agent-status is-${mode} is-${state.stage}`;
  statusText.textContent = text;
  statusSub.innerHTML = sub;
  statusStage.textContent = state.stage.toUpperCase();
  motionBadge.classList.toggle("on", moving);
}

setInterval(pollMotorQueue, 80);
setInterval(pollLog, 400);
setInterval(renderStatus, 150);

refreshCalibFiles();
resize();
requestAnimationFrame(tick);
