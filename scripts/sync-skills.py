"""Sync the Wox skills and apply this template's local integration."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ("wox-plugin-creator", "wox-plugin-submit2store")

with tempfile.TemporaryDirectory() as tmp:
    staging = Path(tmp)
    upstream = staging / "upstream"
    subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
                    "https://github.com/Wox-launcher/Wox.git", str(upstream)], check=True)
    subprocess.run(["git", "-C", str(upstream), "sparse-checkout", "set",
                    *[f".agents/skills/{skill}" for skill in SKILLS]], check=True)
    staged_skills = staging / ".agents/skills"
    for skill in SKILLS:
        shutil.copytree(upstream / ".agents/skills" / skill, staged_skills / skill)
    subprocess.run([sys.executable, str(ROOT / "scripts/adapt-synced-skill.py")],
                   cwd=staging, check=True)
    for skill in SKILLS:
        target = ROOT / ".agents/skills" / skill
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(staged_skills / skill, target)

subprocess.run([sys.executable, str(ROOT / "scripts/test-scaffold.py")], cwd=ROOT, check=True)
