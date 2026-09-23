"""Business workloads: the registry, the reader, and the hash.

The hash is the reason this module exists in the shape it does. "Did these two
Runs use the same data" has to have an answer, or the comparison quietly turns
into a comparison of datasets.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from llmbench.datasets import DatasetError, load, registry

LINES = [
    {"messages": [{"role": "user", "content": "hello"}], "max_tokens": 16},
    {"messages": [{"role": "user", "content": "world"}], "max_tokens": 32},
]


def write_dataset(tmp_path, lines=LINES, name="claw"):
    path = tmp_path / "claw.jsonl"
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
    config = tmp_path / "datasets.json"
    config.write_text(json.dumps({"datasets": [{"name": name, "path": str(path)}]}))
    return config, path


def test_a_registry_lists_what_is_registered(tmp_path):
    config, path = write_dataset(tmp_path)
    datasets = registry(config)
    assert set(datasets) == {"claw"}
    assert datasets["claw"].path == path


def test_no_registry_file_is_not_an_error(tmp_path):
    """A project with no business workloads is a normal project."""
    assert registry(tmp_path / "absent.json") == {}


def test_a_malformed_registry_says_so(tmp_path):
    config = tmp_path / "datasets.json"
    config.write_text("{not json")
    with pytest.raises(DatasetError, match="not readable JSON"):
        registry(config)


def test_a_registry_without_a_list_says_so(tmp_path):
    config = tmp_path / "datasets.json"
    config.write_text(json.dumps({"datasets": "nope"}))
    with pytest.raises(DatasetError, match="datasets"):
        registry(config)


def test_an_entry_without_a_name_or_path_says_so(tmp_path):
    config = tmp_path / "datasets.json"
    config.write_text(json.dumps({"datasets": [{"name": "claw"}]}))
    with pytest.raises(DatasetError, match="name and path"):
        registry(config)


def test_two_entries_with_one_name_is_refused(tmp_path):
    config = tmp_path / "datasets.json"
    config.write_text(
        json.dumps({"datasets": [{"name": "a", "path": "x"}, {"name": "a", "path": "y"}]})
    )
    with pytest.raises(DatasetError, match="twice"):
        registry(config)


# --- loading ----------------------------------------------------------------


def test_a_dataset_loads_its_payloads(tmp_path):
    config, _ = write_dataset(tmp_path)
    loaded = load("claw", config)
    assert len(loaded) == 2
    assert loaded.payloads[0]["messages"][0]["content"] == "hello"


def test_the_hash_is_of_the_file_bytes(tmp_path):
    """So that editing a dataset is visible, and not editing it is provable."""
    config, path = write_dataset(tmp_path)
    expected = hashlib.sha256(path.read_bytes()).hexdigest()
    assert load("claw", config).sha256 == expected


def test_two_identical_files_hash_the_same(tmp_path):
    config, path = write_dataset(tmp_path)
    other = tmp_path / "copy.jsonl"
    other.write_text(path.read_text())
    first = load("claw", config).sha256
    (tmp_path / "datasets.json").write_text(
        json.dumps({"datasets": [{"name": "claw", "path": str(other)}]})
    )
    assert load("claw", tmp_path / "datasets.json").sha256 == first


def test_a_changed_file_hashes_differently(tmp_path):
    config, path = write_dataset(tmp_path)
    before = load("claw", config).sha256
    path.write_text(path.read_text() + json.dumps({"messages": [], "prompt": "x"}) + "\n")
    assert load("claw", config).sha256 != before


def test_a_line_may_wrap_the_payload_or_be_the_payload(tmp_path):
    config, _ = write_dataset(
        tmp_path,
        lines=[
            {"messages": [{"role": "user", "content": "bare"}]},
            {"payload": {"messages": [{"role": "user", "content": "wrapped"}]}},
        ],
    )
    loaded = load("claw", config)
    assert loaded.payloads[0]["messages"][0]["content"] == "bare"
    assert loaded.payloads[1]["messages"][0]["content"] == "wrapped"


def test_a_prompt_style_payload_is_accepted(tmp_path):
    config, _ = write_dataset(tmp_path, lines=[{"prompt": "once upon a time"}])
    assert load("claw", config).payloads[0]["prompt"] == "once upon a time"


def test_blank_lines_are_skipped(tmp_path):
    config, path = write_dataset(tmp_path)
    path.write_text("\n" + path.read_text() + "\n\n")
    assert len(load("claw", config)) == 2


# --- failing clearly --------------------------------------------------------


def test_an_unregistered_name_lists_what_is_registered(tmp_path):
    config, _ = write_dataset(tmp_path)
    with pytest.raises(DatasetError, match="no dataset named 'other'.*claw"):
        load("other", config)


def test_a_missing_file_says_which_path(tmp_path):
    config = tmp_path / "datasets.json"
    config.write_text(json.dumps({"datasets": [{"name": "gone", "path": str(tmp_path / "nope")}]}))
    with pytest.raises(DatasetError, match="nope"):
        load("gone", config)


def test_a_line_that_is_not_json_names_the_line(tmp_path):
    config, path = write_dataset(tmp_path)
    path.write_text(path.read_text() + "{oops\n")
    with pytest.raises(DatasetError, match="line 3"):
        load("claw", config)


def test_a_payload_with_neither_messages_nor_prompt_names_the_line(tmp_path):
    config, path = write_dataset(tmp_path, lines=[{"something": "else"}])
    with pytest.raises(DatasetError, match="line 1"):
        load("claw", config)


def test_an_empty_dataset_is_refused(tmp_path):
    """Measuring nothing and calling it a result is worse than failing."""
    config, path = write_dataset(tmp_path)
    path.write_text("\n\n")
    with pytest.raises(DatasetError, match="empty"):
        load("claw", config)
