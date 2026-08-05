import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Optional


SCRIPT = Path(__file__).parents[1] / "scripts" / "record_artifact.sh"


class RecordArtifactHelperTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / "AGENTS.md").write_text("# Record rules\n", encoding="utf-8")
        (self.root / "transcript.md").write_text(
            "first source line\nsecond source line\nthird source line\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_helper(
        self, *arguments: str, input_text: Optional[str] = None
    ) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(SCRIPT), *arguments],
            cwd=self.root,
            input=input_text,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_chunks_are_complete_and_non_overlapping(self) -> None:
        inspected = self.run_helper(
            "inspect", "--target", "summary"
        )
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        plan = json.loads(inspected.stdout)
        chunks = []
        for item in plan["source"]["chunks"]:
            read = self.run_helper(
                "read",
                "--target",
                "summary",
                "--chunk",
                str(item["chunk"]),
            )
            self.assertEqual(read.returncode, 0, read.stderr)
            _, content = read.stdout.split("\n", 1)
            chunks.append(content)
        self.assertEqual(
            "".join(chunks), (self.root / "transcript.md").read_text(encoding="utf-8")
        )

    def test_content_source_is_supported_when_transcript_is_absent(self) -> None:
        (self.root / "transcript.md").unlink()
        (self.root / "content.md").write_text("authoritative content\n", encoding="utf-8")

        inspected = self.run_helper("inspect", "--target", "title")

        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        self.assertEqual(json.loads(inspected.stdout)["source"]["path"], "content.md")

    def test_summary_apply_preserves_existing_todos(self) -> None:
        (self.root / "summary.md").write_text(
            "old body\n\n## 待办事项\n- [ ] keep this\n", encoding="utf-8"
        )
        applied = self.run_helper(
            "apply", "--target", "summary", input_text="new body\n"
        )
        self.assertEqual(applied.returncode, 0, applied.stdout)
        self.assertEqual(
            (self.root / "summary.md").read_text(encoding="utf-8"),
            "new body\n\n## 待办事项\n- [ ] keep this\n",
        )
        self.assertTrue(json.loads(applied.stdout)["todo_preserved"])

    def test_mindmap_depth_violation_does_not_replace_target(self) -> None:
        (self.root / "mind.md").write_text("# Existing\n", encoding="utf-8")
        applied = self.run_helper(
            "apply",
            "--target",
            "mindmap",
            "--max-depth",
            "3",
            input_text="# Root\n#### Too deep\n",
        )
        self.assertNotEqual(applied.returncode, 0)
        self.assertEqual(
            (self.root / "mind.md").read_text(encoding="utf-8"), "# Existing\n"
        )

    def test_title_requires_one_line(self) -> None:
        applied = self.run_helper(
            "apply", "--target", "title", input_text="first\nsecond\n"
        )
        self.assertNotEqual(applied.returncode, 0)
        self.assertFalse((self.root / "title.md").exists())


if __name__ == "__main__":
    unittest.main()
