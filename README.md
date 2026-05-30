# Coding Agent as Policy — TurboPi sim

A small browser arena where a **coding agent (Claude Code) is the driving policy**.
You type a task in the UI; a Claude Code agent running in a sister terminal reads
the active camera frame through an HTTP API and writes motor commands back. The
agent never sees the simulator source — only the API — so it has to *learn* the
car by experiment, exactly like a real robot.

This repository is self-contained: clone it, run the server, point a Claude Code
terminal at `CLAUDE_AGENT_BRIEF.md`, and you can reproduce the whole demo.

## Run

```bash
npm install
npm run dev
# open http://localhost:8088
```

Keep the browser tab open while you demo: the browser tab is the renderer, and
the server can only hand camera frames to the agent while it is producing them.

In a second terminal, start the agent:

```bash
cd <this repo>
claude            # start Claude Code in this directory
# hand it CLAUDE_AGENT_BRIEF.md, then leave it polling
```

## The flow (the UI walks you through it)

1. **Forget calibration.** Clears every skill file so the agent starts from
   nothing. Watch the *Agent working directory* panel empty out.
2. **Calibrate.** Pick the **Calibrate** stage and click **Send**. The prompt is
   loaded for you. The agent runs trial motor commands, learns the
   `vx, vy, omega` mapping and how to avoid obstacles for each camera, and writes
   one skill file per camera (`top_down.json`, `chase.json`, `front.json`).
3. **Read a skill file.** The files appear in the working directory panel. Click
   one to see exactly what the agent learned.
4. **Execute.** Switch to the **Execute** stage and click **Send**. The agent
   drives to the green goal while avoiding the gray obstacles.
5. **Move things.** Randomize the goal, car, or obstacles. The agent keeps
   driving to the goal on its own, no new instruction needed.

**Reset** only repositions the car. **Forget calibration** deletes the learned
skill files. Calibration is durable: it survives resets, goal/obstacle changes,
camera switches, and server restarts, until you forget it.

## What the agent can access (HTTP API only)

The agent only ever sees these endpoints. It cannot read or change the simulator
source, so it cannot move the car directly through JavaScript.

| Method | Path | What it does |
|---|---|---|
| GET  | `/api/instruction`        | Current instruction, stage, active camera, which cameras are calibrated |
| GET  | `/api/camera`             | PNG of the **active** camera |
| GET  | `/api/camera?view=front`  | PNG of a specific camera (`top_down` / `chase` / `front`) |
| POST | `/api/camera`             | `{camera}` — switch the active camera (needed to calibrate a different view) |
| GET  | `/api/state`              | Car pose, goal, obstacles (ground truth, for sanity checks) |
| POST | `/api/motor`              | `{vx, vy, omega, duration}` — queue a motor command |
| POST | `/api/log`                | `{message}` — append a line to the on-screen log |
| GET  | `/api/calibration?camera=top_down` | The saved mapping for a camera, or null |
| POST | `/api/calibration`        | `{camera, calibration}` — write a skill file |

`POST /api/motor` action space (no physical units — that is what calibration
discovers): `vx` forward `-1.5..1.5`, `vy` sideways slide `-1.5..1.5`, `omega`
yaw rate `-2..2`, `duration` seconds `0.05..3`. Each camera hides a different
scale factor and a small drift; the agent closes that gap with a few trials.

## Headless self-test

A puppeteer smoke test checks the UI wiring (stage prompts load, the working
directory lists and opens skill files, the status box keeps a fixed height) while
the server is running on `:8088`:

```bash
npm run dev &                 # server on :8088
npm i -D puppeteer            # one-time
node test/smoke.cjs
```

## Files

- `server.js` — HTTP API + in-memory world state + calibration skill files on disk
- `public/index.html` — UI shell and the in-page guide
- `public/styles.css` — styling
- `public/app.js` — Three.js scene, mecanum physics, camera switching, server bridge, working-directory viewer
- `CLAUDE_AGENT_BRIEF.md` — drop this into Claude Code's working directory so it knows what to do
- `test/smoke.cjs` — headless UI smoke test
