# Mupot Pi CLI Native Connector (`connectors/pi`)

This connector enables the minimalist, open-source **Pi CLI agent** (`@earendil-works/pi-coding-agent`) to run as a native, low-overhead execution worker inside Mupot agent squads.

## Features
* **Native `--mode rpc` Driver**: Executes Pi headlessly and streams task progress to Mupot telemetry.
* **Tree Session Branching (`--fork`)**: Allows Mupot to branch failed or alternative task paths cleanly.
* **Token Authentication**: Binds to Mupot via `MUPOT_MEMBER_TOKEN` (`mupot_...`).

## Usage

```bash
python3 connectors/pi/mupot-pi-driver.py <TASK_ID> "<INSTRUCTIONS>"
```
