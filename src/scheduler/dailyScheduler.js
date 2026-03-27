require('dotenv').config();
const { spawn } = require('child_process');

const DEFAULT_START_TIME = '09:00';
const DEFAULT_TIMEOUT_MINUTES = parseInt(process.env.TIMEOUT_MINUTES, 10) || 120;
const START_TIME = process.env.SCHEDULER_START_TIME || DEFAULT_START_TIME;
const TIMEOUT_MINUTES = parseInt(process.env.TIMEOUT_MINUTES, 10) || DEFAULT_TIMEOUT_MINUTES;
const STOP_BUFFER_SECONDS = parseInt(process.env.SCHEDULER_STOP_BUFFER_SECONDS, 10) || 30;
const RUN_COMMAND = process.env.SCHEDULER_COMMAND || 'npm';
const RUN_ARGS = (process.env.SCHEDULER_ARGS || 'start').split(' ').filter(Boolean);
const USE_SHELL = process.platform === 'win32';

let currentChild = null;
let startTimer = null;
let stopTimer = null;

function parseTime(timeText) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((timeText || '').trim());
  if (!match) {
    throw new Error(`Invalid SCHEDULER_START_TIME: "${timeText}". Use HH:MM in 24-hour format.`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid SCHEDULER_START_TIME: "${timeText}". Use HH:MM in 24-hour format.`);
  }

  return { hours, minutes };
}

function getWindowTimes(baseDate = new Date()) {
  const { hours, minutes } = parseTime(START_TIME);
  const start = new Date(baseDate);
  start.setHours(hours, minutes, 0, 0);

  const stop = new Date(start.getTime() + ((TIMEOUT_MINUTES * 60) + STOP_BUFFER_SECONDS) * 1000);
  return { start, stop };
}

function formatDate(date) {
  return date.toLocaleString('en-IN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

function log(message) {
  console.log(`[Scheduler] ${message}`);
}

function getSpawnConfig() {
  if (USE_SHELL) {
    return {
      command: `${RUN_COMMAND} ${RUN_ARGS.join(' ')}`.trim(),
      args: [],
      options: {
        stdio: 'inherit',
        shell: true,
        env: process.env,
        cwd: process.cwd()
      }
    };
  }

  return {
    command: RUN_COMMAND,
    args: RUN_ARGS,
    options: {
      stdio: 'inherit',
      shell: false,
      env: process.env,
      cwd: process.cwd()
    }
  };
}

function clearTimers() {
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
}

function scheduleNextRun(fromDate = new Date()) {
  clearTimers();

  const { start, stop } = getWindowTimes(fromDate);
  const now = new Date();

  if (now >= start && now < stop) {
    log(`Current time is inside today's run window (${formatDate(start)} -> ${formatDate(stop)}). Starting immediately.`);
    startChildForWindow(start);
    return;
  }

  const nextStart = now < start ? start : new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const delayMs = Math.max(0, nextStart.getTime() - now.getTime());

  log(`Next run scheduled at ${formatDate(nextStart)}.`);
  startTimer = setTimeout(() => startChildForWindow(nextStart), delayMs);
}

function startChildForWindow(windowStart) {
  if (currentChild) {
    log('A scheduled run is already active. Skipping duplicate start.');
    return;
  }

  const stopAt = new Date(windowStart.getTime() + ((TIMEOUT_MINUTES * 60) + STOP_BUFFER_SECONDS) * 1000);
  const spawnConfig = getSpawnConfig();

  log(`Starting command: ${RUN_COMMAND} ${RUN_ARGS.join(' ')}`);
  log(`This run will be stopped at ${formatDate(stopAt)} based on TIMEOUT_MINUTES=${TIMEOUT_MINUTES}.`);

  currentChild = spawn(spawnConfig.command, spawnConfig.args, spawnConfig.options);

  currentChild.on('exit', (code, signal) => {
    log(`Scheduled run exited with code=${code} signal=${signal || 'none'}.`);
    currentChild = null;
    scheduleNextRun(new Date(windowStart.getTime() + 24 * 60 * 60 * 1000));
  });

  currentChild.on('error', (error) => {
    log(`Failed to start scheduled run: ${error.message}`);
    currentChild = null;
    scheduleNextRun(new Date(windowStart.getTime() + 24 * 60 * 60 * 1000));
  });

  const stopDelayMs = Math.max(0, stopAt.getTime() - Date.now());
  stopTimer = setTimeout(() => stopCurrentRun('Scheduled stop time reached'), stopDelayMs);
}

function stopCurrentRun(reason) {
  if (!currentChild) {
    log(`${reason}. No active child process to stop.`);
    return;
  }

  log(`${reason}. Sending SIGINT to the active run...`);
  currentChild.kill('SIGINT');

  setTimeout(() => {
    if (currentChild) {
      log('Child process did not exit after SIGINT. Forcing termination...');
      currentChild.kill('SIGTERM');
    }
  }, 5000).unref();
}

function shutdownScheduler() {
  log('Scheduler shutting down...');
  clearTimers();
  if (currentChild) {
    stopCurrentRun('Scheduler shutdown requested');
  }
}

process.on('SIGINT', () => {
  shutdownScheduler();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdownScheduler();
  process.exit(0);
});

try {
  const { start, stop } = getWindowTimes();
  log(`Configured daily start time: ${START_TIME}`);
  log(`Configured timeout window: ${TIMEOUT_MINUTES} minute(s) + ${STOP_BUFFER_SECONDS}s buffer`);
  log(`Today's schedule window: ${formatDate(start)} -> ${formatDate(stop)}`);
  scheduleNextRun();
} catch (error) {
  console.error(`[Scheduler] ${error.message}`);
  process.exit(1);
}