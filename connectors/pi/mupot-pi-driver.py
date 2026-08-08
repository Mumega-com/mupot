#!/usr/bin/env python3
"""Mupot Native Driver for Pi CLI RPC Mode."""
import json
import os
import subprocess
import sys

MUPOT_ENDPOINT = os.getenv("MUPOT_MCP", "https://mupot.mumega.com/mcp")
MEMBER_TOKEN = os.getenv("MUPOT_MEMBER_TOKEN", "")

def run_pi_task(task_id: str, prompt: str):
    pi_bin = os.getenv("PI_BIN", "/home/mumega/.local/bin/pi")
    if not os.path.exists(pi_bin):
        pi_bin = "pi"
        
    cmd = [
        pi_bin,
        "--mode", "rpc",
        "--session-id", task_id,
        "--append-system-prompt", f"You are a Mupot bound agent operating under task {task_id}.",
        prompt
    ]
    
    print(f"[Mupot-Pi] Invoking native Pi driver for task {task_id}...")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    
    if proc.stdout:
        for line in proc.stdout:
            print(f"[Telemetry Stream] {line.strip()}")
            
    proc.wait()
    print(f"[Mupot-Pi] Task {task_id} completed with exit code {proc.returncode}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: mupot-pi-driver.py <task_id> <prompt>")
        sys.exit(1)
    run_pi_task(sys.argv[1], sys.argv[2])
