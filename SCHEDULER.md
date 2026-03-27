# Daily Scheduler

This project now includes a lightweight daily scheduler that starts the automation at a fixed time every day and stops it automatically based on `TIMEOUT_MINUTES`.

## How it works

- it launches `npm start` once per day at the configured time
- it calculates the stop time from:
  - `SCHEDULER_START_TIME`
  - `TIMEOUT_MINUTES`
  - optional `SCHEDULER_STOP_BUFFER_SECONDS`
- when the stop time is reached, it sends a graceful shutdown signal to the automation

This is useful when you want the booking bot to open automatically every day for a known ticket-drop window.

## Usage

Run the scheduler:

```bash
npm run schedule
```

Keep this process running on the machine where the automation should run.

## Environment variables

Add these to your `.env`:

```env
SCHEDULER_START_TIME=09:00
TIMEOUT_MINUTES=120
SCHEDULER_STOP_BUFFER_SECONDS=30
```

### Meaning

- `SCHEDULER_START_TIME`
  - daily start time in `HH:MM` 24-hour format
  - example: `08:30`, `17:45`

- `TIMEOUT_MINUTES`
  - same timeout already used by the booking automation
  - scheduler uses this to determine when the daily run should end

- `SCHEDULER_STOP_BUFFER_SECONDS`
  - optional extra buffer before force-stopping the run
  - default: `30`

## Example

If you set:

```env
SCHEDULER_START_TIME=18:55
TIMEOUT_MINUTES=90
SCHEDULER_STOP_BUFFER_SECONDS=30
```

Then every day:

- the bot starts at **18:55**
- the scheduler stop window is **20:25:30**

## Notes

- on Windows, the scheduler uses shell execution for `npm start`, which is more reliable than direct `spawn()` with `npm.cmd`
- if the scheduler is launched during the active run window, it starts the bot immediately
- if the bot exits early, the scheduler waits for the next day automatically
- the scheduler sends `SIGINT` first so the existing cleanup logic can run

## Recommended usage on Windows

If you want this to survive reboots or start automatically, run `npm run schedule` using **Windows Task Scheduler** at login or system startup.

Suggested pattern:

1. create a Task Scheduler task
2. trigger it at logon or startup
3. set the program to run:

```text
npm
```

4. set arguments:

```text
run schedule
```

5. set the working directory to your project folder:

```text
C:\Users\yathi\Playwright
```

That way, the scheduler process stays alive and handles the daily timed launch for you.