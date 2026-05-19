"""Lightweight document metadata index backed by workspace files."""

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from ripple.sandbox.config import SandboxConfig
from ripple.utils.file_state import atomic_write_json, read_json_or_default

STATE_VERSION = 1


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def index_path(config: SandboxConfig, user_id: str) -> Path:
    return config.sandbox_dir(user_id) / "documents" / "index.json"


def load_index(config: SandboxConfig, user_id: str) -> dict:
    path = index_path(config, user_id)
    if not path.exists():
        return {"version": STATE_VERSION, "documents": []}
    data = read_json_or_default(path, {})
    if not isinstance(data, dict) or not isinstance(data.get("documents"), list):
        return {"version": STATE_VERSION, "documents": []}
    data.setdefault("version", STATE_VERSION)
    return data


def save_index(config: SandboxConfig, user_id: str, data: dict) -> None:
    path = index_path(config, user_id)
    data.setdefault("version", STATE_VERSION)
    atomic_write_json(path, data)


def infer_kind(path: str) -> str:
    suffix = Path(path).suffix.lower()
    if suffix in {".md", ".markdown"}:
        return "markdown"
    if suffix == ".txt":
        return "text"
    if suffix in {".json", ".yaml", ".yml"}:
        return "data"
    return "file"


def list_documents(config: SandboxConfig, user_id: str, query: str | None = None) -> list[dict]:
    documents = list(load_index(config, user_id)["documents"])
    if query:
        needle = query.casefold()
        documents = [
            doc
            for doc in documents
            if needle
            in "\n".join(
                [
                    str(doc.get("title") or ""),
                    str(doc.get("path") or ""),
                    str(doc.get("summary") or ""),
                ]
            ).casefold()
        ]
    return sorted(documents, key=lambda doc: str(doc.get("updated_at") or ""), reverse=True)


def create_document(
    config: SandboxConfig,
    user_id: str,
    *,
    title: str,
    path: str,
    linked_session_id: str | None = None,
    summary: str = "",
) -> dict:
    data = load_index(config, user_id)
    now = utc_now_iso()
    doc = {
        "document_id": f"doc-{uuid4().hex[:12]}",
        "title": title,
        "path": path,
        "kind": infer_kind(path),
        "source": "workspace",
        "linked_session_id": linked_session_id,
        "summary": summary,
        "created_at": now,
        "updated_at": now,
        "last_modified_at": now,
    }
    data["documents"].append(doc)
    save_index(config, user_id, data)
    return doc


def get_document(config: SandboxConfig, user_id: str, document_id: str) -> dict | None:
    for doc in load_index(config, user_id)["documents"]:
        if doc.get("document_id") == document_id:
            return doc
    return None


def update_document(config: SandboxConfig, user_id: str, document_id: str, updates: dict) -> dict | None:
    data = load_index(config, user_id)
    for doc in data["documents"]:
        if doc.get("document_id") != document_id:
            continue
        for key in ("title", "summary", "linked_session_id"):
            if key in updates and updates[key] is not None:
                doc[key] = updates[key]
        doc["updated_at"] = utc_now_iso()
        save_index(config, user_id, data)
        return doc
    return None


def delete_document(config: SandboxConfig, user_id: str, document_id: str) -> bool:
    data = load_index(config, user_id)
    before = len(data["documents"])
    data["documents"] = [doc for doc in data["documents"] if doc.get("document_id") != document_id]
    if len(data["documents"]) == before:
        return False
    save_index(config, user_id, data)
    return True
