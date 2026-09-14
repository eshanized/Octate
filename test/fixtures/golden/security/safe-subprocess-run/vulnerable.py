import subprocess
import os

def run_git_status() -> None:
    # Safe static list execution without shell=True
    subprocess.run(["git", "status"], check=True)
