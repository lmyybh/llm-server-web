"""Business workloads: the requests you actually serve, rather than shapes.

Synthetic shapes answer "where does this service fall over". A business
workload answers "how does it behave on what we really send" — different
questions, and a service can do well at one and poorly at the other.

Datasets are files on this machine, registered in a config file. Not uploaded:
the hash that makes two Runs comparable has to be of something stable, and a
file at a path is easier to reason about than a blob in a table.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

REGISTRY_ENV = "LLMBENCH_DATASETS"


class DatasetError(RuntimeError):
    """The registry or a dataset file could not be used."""


@dataclass(frozen=True)
class Dataset:
    name: str
    path: Path


@dataclass
class LoadedDataset:
    name: str
    sha256: str
    payloads: list[dict] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.payloads)


def registry(path: Path | None = None) -> dict[str, Dataset]:
    """The registered datasets, keyed by name."""
    config_path = path or Path(os.environ.get(REGISTRY_ENV, "datasets.json"))
    if not config_path.is_file():
        return {}
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DatasetError(f"{config_path} is not readable JSON: {exc}") from exc

    entries = raw.get("datasets") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        raise DatasetError(f"{config_path} must contain a 'datasets' list")

    datasets: dict[str, Dataset] = {}
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("name") or not entry.get("path"):
            raise DatasetError(f"{config_path} has an entry without a name and path")
        name = str(entry["name"])
        if name in datasets:
            raise DatasetError(f"{config_path} registers {name!r} twice")
        datasets[name] = Dataset(name, Path(str(entry["path"])))
    return datasets


def load(name: str, path: Path | None = None) -> LoadedDataset:
    """Read a dataset and hash it.

    The hash is what makes "the same dataset" a question with an answer: two
    Runs that used different files are not comparable, and comparing their
    numbers would be comparing the data as much as the service.
    """
    datasets = registry(path)
    if name not in datasets:
        known = ", ".join(sorted(datasets)) or "none registered"
        raise DatasetError(f"no dataset named {name!r} (registered: {known})")

    file_path = datasets[name].path
    try:
        content = file_path.read_bytes()
    except OSError as exc:
        raise DatasetError(f"dataset {name!r} at {file_path} could not be read: {exc}") from exc

    payloads = []
    for number, line in enumerate(content.decode("utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise DatasetError(f"{file_path} line {number} is not JSON: {exc}") from exc
        payload = record.get("payload", record) if isinstance(record, dict) else record
        if not isinstance(payload, dict) or not ("messages" in payload or "prompt" in payload):
            raise DatasetError(
                f"{file_path} line {number} has neither 'messages' nor 'prompt'"
            )
        payloads.append(payload)

    if not payloads:
        raise DatasetError(f"dataset {name!r} at {file_path} is empty")

    return LoadedDataset(name=name, sha256=hashlib.sha256(content).hexdigest(), payloads=payloads)
